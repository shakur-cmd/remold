import subprocess,pathlib,shutil,json,sys
S=pathlib.Path(sys.argv[1]);C=pathlib.Path(sys.argv[2]);src=(C/'receiver.mjs').read_text()
M={
 'baseline':None,
 'no-hmac-compare':("if(supplied.length!==32||!timingSafeEqual(supplied,expected)){reply(401);return;}",""),
 'insert-not-idempotent':("INSERT OR IGNORE INTO","INSERT INTO"),
 'ack-despite-storage-failure':("}catch{if(!res.headersSent)reply(503);}","}catch{if(!res.headersSent)reply(200);}"),
 'no-size-cap':("if(size>1048576){reply(413);return;}",""),
 'no-content-type-check':("if(req.headers['content-type']!=='application/json'){reply(415);return;}",""),
 'no-json-object-check':("if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();",""),
 'no-duplicate-signature-header-check':("signatures.length!==1||",""),
 'no-fatal-utf8':("new TextDecoder('utf-8',{fatal:true})","new TextDecoder('utf-8')"),
 'tenant-from-origin-header':("insert.run(createHash('sha256').update(body).digest('hex'),config.tenant,","insert.run(createHash('sha256').update(body).digest('hex'),req.headers['x-origin-base-url']??config.tenant,"),
}
out={}
for name,rep in M.items():
  d=S/'rmut'/name;shutil.rmtree(d,ignore_errors=True);d.mkdir()
  s=src
  if rep:
    assert s.count(rep[0])==1,name; s=s.replace(rep[0],rep[1])
  (d/'receiver.mjs').write_text(s);shutil.copy(C/'receiver.test.mjs',d/'receiver.test.mjs')
  p=subprocess.run(['node','--test','receiver.test.mjs'],cwd=d,capture_output=True,text=True)
  fails=[l[2:].split(' (')[0] for l in p.stdout.splitlines() if l.startswith('✖ ') and 'failing tests' not in l]
  out[name]={'exit':p.returncode,'failed':sorted(set(fails))}
print(json.dumps(out,indent=1))
