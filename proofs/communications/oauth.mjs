import { randomBytes, createHash } from 'node:crypto';
export const CALLBACK = 'http://127.0.0.1:3522/oauth/google/callback';
const READ_SCOPES = ['openid','email','https://www.googleapis.com/auth/gmail.readonly'];
export const CALENDAR_SCOPE='https://www.googleapis.com/auth/calendar.events.owned';
export const SCOPES = Object.freeze([...READ_SCOPES,'https://www.googleapis.com/auth/gmail.send']);
export const MAILBOXES = Object.freeze({ A: 'shakur@envoylogic.com', B: 'reply@repliedfor.com' });
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
export class OAuthConnections {
  constructor({ clientId, exchange, verify, profile, persist, persistCandidate = async()=>{}, calendarProof=false, existing = {}, now = Date.now }) {
    Object.assign(this,{clientId,exchange,verify,profile,persist,persistCandidate,calendarProof,now});
    this.pending=new Map();this.candidates=new Map();this.connections=new Map(Object.entries(existing));
  }
  begin(slot, session) {
    if(!MAILBOXES[slot] || !session)throw new Error('UNKNOWN_MAILBOX');
    for(const [key,value] of this.pending)if(value.expires<=this.now())this.pending.delete(key);
    if(this.pending.size>=20)throw new Error('TOO_MANY_PENDING');
    const state=random(), nonce=random(), verifier=random();
    this.pending.set(state,{slot,session,nonce,verifier,expires:this.now()+600000});
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for(const [key,value] of Object.entries({client_id:this.clientId,redirect_uri:CALLBACK,response_type:'code',scope:[...(slot==='A'?SCOPES:READ_SCOPES),...(this.calendarProof?[CALENDAR_SCOPE]:[])].join(' '),include_granted_scopes:'true',access_type:'offline',prompt:'consent select_account',state,nonce,login_hint:MAILBOXES[slot],code_challenge:hash(verifier),code_challenge_method:'S256'}))url.searchParams.set(key,value);
    return url.toString();
  }
  async complete({state,code,session,error}) {
    const pending=this.pending.get(state);
    if(!pending || pending.session!==session || pending.expires<=this.now())throw new Error('INVALID_STATE');
    // Consume before any await, including denied/error responses.
    this.pending.delete(state);
    if(error || !code)throw new Error('OAUTH_DENIED');
    const tokens=await this.exchange(code,pending.verifier);
    if(!tokens.id_token || !tokens.access_token)throw new Error('MISSING_TOKEN');
    const claims=await this.verify(tokens.id_token);
    if(claims.nonce!==pending.nonce || claims.email_verified!==true || claims.email?.toLowerCase()!==MAILBOXES[pending.slot] || typeof claims.sub!=='string' || !claims.sub)throw new Error('ACCOUNT_MISMATCH');
    const scopes=new Set((tokens.scope??'').split(' '));
    if(!(pending.slot==='A'?SCOPES.slice(2):READ_SCOPES.slice(2)).every(scope=>scopes.has(scope)))throw new Error('MAIL_SCOPE_MISSING');
    if(this.calendarProof&&!scopes.has(CALENDAR_SCOPE))throw new Error('CALENDAR_SCOPE_MISSING');
    const old=this.connections.get(pending.slot);
    if(old && old.subject!==claims.sub)throw new Error('ACCOUNT_SWITCH_REFUSED');
    const candidate={calendarAuthorized:this.calendarProof,slot:pending.slot,org:`synthetic-${pending.slot}`,member:`synthetic-owner-${pending.slot}`,email:MAILBOXES[pending.slot],subject:claims.sub,tokens:{...tokens,refresh_token:tokens.refresh_token??old?.tokens.refresh_token},cursor:old?.cursor};
    if(!candidate.tokens.refresh_token)throw new Error('OFFLINE_ACCESS_MISSING');
    await this.persistCandidate(candidate);
    this.candidates.set(pending.slot,candidate);
    return this.retryProfile(pending.slot);
  }
  async retryProfile(slot) {
    const candidate=this.candidates.get(slot);
    if(!candidate)throw new Error('NO_VERIFIED_CANDIDATE');
    const profile=await this.profile(candidate.tokens);
    if(profile.emailAddress?.toLowerCase()!==MAILBOXES[slot] || !/^\d+$/.test(profile.historyId??''))throw new Error('MAILBOX_MISMATCH');
    const connection={...candidate,cursor:candidate.cursor??profile.historyId,connectedAt:this.now()};
    await this.persist(connection);
    this.connections.set(slot,connection);this.candidates.delete(slot);
    return {slot,email:connection.email,connected:true,historyBaselineCaptured:true,historicalMessagesFetched:0,sendAllowance:0,approvedDailyCap:5,runReleased:false,calendarAuthorized:connection.calendarAuthorized===true};
  }
}
