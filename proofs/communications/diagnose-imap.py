"""Only searches the known accepted P1 Message-ID; retrieves headers, never bodies."""
import email, imaplib, json, re, ssl
from pathlib import Path
here=Path(__file__).resolve().parent
known=json.loads((here/'evidence/receipt-diagnostic-gmail.json').read_text())['providerP1']
message_id=known['messageId']
assert known['from']=='shakur@envoylogic.com' and known['to']=='reply@repliedfor.com'
assert re.fullmatch(r'<[A-Za-z0-9_=+./-]+@mail\.gmail\.com>',message_id)
values={}
for line in Path('/Users/urkel/Documents/CodeMyVibe/Projects/review-replies/.env').read_text().splitlines():
 name,sep,value=line.partition('=')
 if sep and name in {'IMAP_USER','IMAP_PASS','IMAP_HOST','IMAP_PORT'}: values[name]=value.strip().strip('"\'')
assert values['IMAP_USER']=='reply@repliedfor.com' and values['IMAP_HOST']=='imap.purelymail.com' and values['IMAP_PORT']=='993'
result={'readOnly':True,'bodyMessagesFetched':0,'foldersSearched':0,'matches':[]}
with imaplib.IMAP4_SSL(values['IMAP_HOST'],993,ssl_context=ssl.create_default_context(),timeout=20) as client:
 client.login(values['IMAP_USER'],values['IMAP_PASS'])
 code,folders=client.list();assert code=='OK'
 for row in folders:
  # LIST mailbox suffix is a quoted string or atom; do not interpolate it in shell.
  match=re.fullmatch(rb'\([^)]*\) (?:"[^"]*"|NIL) (.+)',row)
  assert match
  folder=match.group(1).decode()
  if client.select(folder,readonly=True)[0]!='OK':continue
  result['foldersSearched']+=1
  code,found=client.uid('SEARCH',None,'HEADER','Message-ID','"'+message_id+'"');assert code=='OK'
  for uid in found[0].split():
   code,data=client.uid('FETCH',uid,'(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM TO)])');assert code=='OK'
   raw=next(p[1] for p in data if isinstance(p,tuple));m=email.message_from_bytes(raw)
   assert str(m['Message-ID']).strip()==message_id
   result['matches'].append({'folder':folder,'uid':int(uid),'messageId':message_id,'from':str(m['From']),'to':str(m['To'])})
(here/'evidence/receipt-diagnostic-imap.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
