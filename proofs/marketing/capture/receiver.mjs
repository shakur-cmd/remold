import {createServer} from 'node:http';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function createReceiver(config){
 if(!['a','b'].includes(config.tenant)||!/^[a-f0-9]{64}$/.test(config.key))throw Error('Invalid fixture binding');
 const database=new DatabaseSync(config.database);
 database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS receipts (sha256 TEXT PRIMARY KEY, tenant TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL)');
 const insert=database.prepare('INSERT OR IGNORE INTO receipts VALUES (?, ?, ?, ?)');
 const server=createServer(async(req,res)=>{
  const reply=status=>{res.writeHead(status,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end(status===200?'Stored':'Refused');};
  if(req.method!=='POST'||req.url!=='/callback'){reply(404);return;}
  if(req.headers['content-type']!=='application/json'){reply(415);return;}
  const signatures=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='webhook-signature');
  const signature=req.headers['webhook-signature'];
  if(signatures.length!==1||typeof signature!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(signature)){reply(401);return;}
  try{
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>1048576){reply(413);return;}chunks.push(chunk);}
   const body=Buffer.concat(chunks),expected=createHmac('sha256',config.key).update(body).digest();
   const supplied=Buffer.from(signature,'base64');if(supplied.length!==32||!timingSafeEqual(supplied,expected)){reply(401);return;}
   let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(body);const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();}catch{reply(400);return;}
   // Receipt only: callbacks never author CRM fields or consent, even when replayed later.
   insert.run(createHash('sha256').update(body).digest('hex'),config.tenant,text,new Date().toISOString());reply(200);
  }catch{if(!res.headersSent)reply(503);}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;
 return {server,database};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const config=JSON.parse(readFileSync('/callback-config.json','utf8'));
 createReceiver(config).server.listen(8080,'0.0.0.0');
}
