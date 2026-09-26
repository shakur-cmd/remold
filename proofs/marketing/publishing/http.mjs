import {execFileSync} from 'node:child_process';
import {context,prefix} from '../runtime.mjs';
// Raw path reaches the local proof listener without URL normalization by a browser.
export function request(tenant,{host,path,method='GET',body='',headers={},rawHeaders,port=80,container='web'}){
 if(!['a','b'].includes(tenant)||!['web','public'].includes(container)||typeof path!=='string'||/[\r\n]/.test(path))throw Error('Unknown fixture endpoint');
 const script=`let input='';for await(const c of process.stdin)input+=c;const a=JSON.parse(input);const http=await import('node:http');const result=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:a.port,path:a.path,method:a.method,headers:a.rawHeaders??{...a.headers,Host:a.host,...(a.body?{'Content-Length':Buffer.byteLength(a.body)}:{})}},res=>{let size=0;const chunks=[];res.on('data',c=>{size+=c.length;if(size>1048576)res.destroy(Error('Response too large'));else chunks.push(c);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('base64')}));});req.setTimeout(10000,()=>req.destroy(Error('Timeout')));req.on('error',reject);req.end(a.body);});console.log(JSON.stringify(result));`;
 const result=JSON.parse(execFileSync('docker',['--context',context,'exec','-i',prefix+'-'+container+'-'+tenant,'node','--input-type=module','-e',script],{input:JSON.stringify({host,path,method,body,headers,rawHeaders,port}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 return {...result,body:Buffer.from(result.body,'base64')};
}
