# Temp-dir mutants of server.mjs against the unchanged server.test.mjs. Never touches installed or repo source.
import subprocess,tempfile,shutil,pathlib,hashlib,json,sys
src=pathlib.Path(sys.argv[1]);base=(src/'server.mjs').read_text()
M=[('host-check-removed','if(hosts.length!==1||req.headers.host!==config.host)','if(false)'),
 ('response-cap-removed','if(size>responseCap)','if(false)'),
 ('content-type-prefix',"mediaType(result.type)!=='application/json'","!mediaType(result.type).startsWith('application/json')"),
 ('duplicate-key-check-removed','keys.length!==new Set(keys).size||',''),
 ('utf8-fatal-removed',"{fatal:true}","{fatal:false}"),
 ('token-compare-removed',"||!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(token,'hex'))",''),
 ('success-flag-check-removed',"accepted.success!==1||",''),
 ('request-cap-in-stream-removed',"if(size>cap){reply(res,413,'Form too large');return;}",''),
 ('routing-header-check-removed',"if(Object.keys(req.headers).some(h=>h==='forwarded'","if(false&&Object.keys(req.headers).some(h=>h==='forwarded'"),
 ('origin-check-removed',"if(req.headers.origin&&","if(false&&")]
rows=[]
for name,old,new in M:
  assert base.count(old)==1,name
  d=pathlib.Path(tempfile.mkdtemp(prefix='remold-iv-mut-'+name+'-'))
  (d/'server.mjs').write_text(base.replace(old,new));shutil.copy(src/'server.test.mjs',d/'server.test.mjs')
  p=subprocess.run(['node','--test',str(d/'server.test.mjs')],capture_output=True,text=True)
  failed=[l.strip() for l in p.stdout.splitlines() if l.strip().startswith('✖') and 'failing tests' not in l]
  rows.append({'mutation':name,'exit':p.returncode,'killed':p.returncode!=0,'failingTests':sorted(set(failed)),'mutantSha256':hashlib.sha256((d/'server.mjs').read_bytes()).hexdigest()})
  shutil.rmtree(d)
print(json.dumps({'baseSha256':hashlib.sha256(base.encode()).hexdigest(),'rows':rows},indent=1,ensure_ascii=False))
