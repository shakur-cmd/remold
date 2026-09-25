# Independent r2 mutants (temp dirs only) against the unchanged server.test.mjs. Survivors are reported as unit gaps, not bypasses.
import subprocess,tempfile,shutil,pathlib,hashlib,json,sys
src=pathlib.Path(sys.argv[1]);base=(src/'server.mjs').read_text()
M=[('privacy-headers-removed',"{DNT:'1','Sec-GPC':'1'}","{}"),
 ('dnt-only',"{DNT:'1','Sec-GPC':'1'}","{DNT:'1'}"),
 ('sec-gpc-only',"{DNT:'1','Sec-GPC':'1'}","{'Sec-GPC':'1'}"),
 ('dnt-zero',"{DNT:'1','Sec-GPC':'1'}","{DNT:'0','Sec-GPC':'1'}"),
 ('post-status-check-removed',"result.status!==200||mediaType(result.type)!=='application/json'","mediaType(result.type)!=='application/json'"),
 ('error-message-check-removed',"||accepted.errorMessage||","||"),
 ('validation-errors-check-removed',"||accepted.validationErrors)",")"),
 ('email-format-check-removed',"||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)",""),
 ('firstname-control-check-removed',"||/[\\x00-\\x1f\\x7f]/.test(firstname)",""),
 ('read-status-check-removed',"if(result.status!==200||mediaType(result.type)!==route.contentType)","if(mediaType(result.type)!==route.contentType)"),
 ('read-type-check-removed',"if(result.status!==200||mediaType(result.type)!==route.contentType)","if(result.status!==200)"),
 ('read-method-check-removed',"if(!route||!['GET','HEAD'].includes(req.method))","if(!route)"),
 ('head-returns-body',"req.method==='HEAD'?'':result.body","result.body"),
 ('content-type-exact-removed',"if(req.headers['content-type']!=='application/x-www-form-urlencoded')","if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))"),
 ('content-length-precheck-removed',"if(Number(req.headers['content-length']??0)>cap)return reply(res,413,'Form too large');",""),
 ('csp-removed',"'Content-Security-Policy':\"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\"","'X-Removed':'1'"),
 ('percent-decode-check-removed',"try{decodeURIComponent(decoded.replace(/\\+/g,' '));}catch{return reply(res,400,'Invalid form encoding');}",""),
]
rows=[]
for name,old,new in M:
  n=base.count(old)
  if n!=1: rows.append({'mutation':name,'error':'anchor count '+str(n)});continue
  d=pathlib.Path(tempfile.mkdtemp(prefix='remold-iv2-mut-'+name+'-'))
  (d/'server.mjs').write_text(base.replace(old,new));shutil.copy(src/'server.test.mjs',d/'server.test.mjs')
  p=subprocess.run(['node','--test',str(d/'server.test.mjs')],capture_output=True,text=True)
  failed=[l.strip() for l in p.stdout.splitlines() if l.strip().startswith('✖') and 'failing tests' not in l]
  rows.append({'mutation':name,'exit':p.returncode,'killed':p.returncode!=0,'failingTests':sorted(set(failed)),'mutantSha256':hashlib.sha256((d/'server.mjs').read_bytes()).hexdigest()})
  shutil.rmtree(d)
print(json.dumps({'baseSha256':hashlib.sha256(base.encode()).hexdigest(),'rows':rows},indent=1,ensure_ascii=False))
