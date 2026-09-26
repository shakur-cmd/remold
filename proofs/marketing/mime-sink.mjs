import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {inspectMime} from './mime.mjs';
export function createSink(config,path){
 if(typeof config.key!=='string'||config.key.length<32)throw Error('Private sink key required');
 const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS deliveries(intent TEXT PRIMARY KEY, hash TEXT NOT NULL, raw_sha TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, raw BLOB NOT NULL); CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, intent TEXT, outcome TEXT NOT NULL);');
 const find=id=>db.prepare('SELECT intent,hash,raw_sha AS rawSha256,sender,recipient,length(raw) AS bytes FROM deliveries WHERE intent=?').get(id);
 const log=(id,outcome)=>db.prepare('INSERT INTO attempts(intent,outcome) VALUES(?,?)').run(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)?id:null,outcome);
 const server=createServer(async(req,res)=>{
  const key=Buffer.from(String(req.headers['x-remold-sink-key']??'')),expected=Buffer.from(config.key);
  if(key.length!==expected.length||!timingSafeEqual(key,expected)){res.writeHead(403);res.end('{}');return;}
  const match=/^\/receipts\/([a-f0-9]{64})$/.exec(req.url);
  if(req.method==='GET'&&match){const receipt=find(match[1]);res.writeHead(receipt?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(receipt??{}));return;}
  if(req.method!=='POST'||req.url!=='/deliver'){res.writeHead(405);res.end('{}');return;}
  let body='',a;
  try{
   for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536){res.writeHead(413);res.end('{}');return;}}
   a=JSON.parse(body);const {expected:approved,...payload}=a,mime=inspectMime(payload);
   if(mime.hash!==approved||mime.sender!==config.sender||mime.recipient!==config.recipient)throw Error('Receipt binding mismatch');
   if(find(mime.intent)){log(mime.intent,'duplicate-refused');res.writeHead(409);res.end('{"duplicate":true}');return;}
   db.exec('BEGIN IMMEDIATE');
   try{db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?)').run(mime.intent,mime.hash,mime.rawSha256,mime.sender,mime.recipient,mime.bytes);log(mime.intent,'accepted');db.exec('COMMIT');}
   catch(error){db.exec('ROLLBACK');throw error;}
   if(config.lostResponseOnce){res.destroy();return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(find(mime.intent)));
  }catch{log(a?.intent,'refused');res.writeHead(409,{'Content-Type':'application/json'});res.end('{"refused":true}');}
 });
 return {server,db};
}
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))){
 const config=JSON.parse(readFileSync('/config.json')),sink=createSink(config,'/data/received.sqlite');
 sink.server.listen(3543,'0.0.0.0',()=>console.log('Private MIME fixture receiver ready; no SMTP or external delivery.'));
}
