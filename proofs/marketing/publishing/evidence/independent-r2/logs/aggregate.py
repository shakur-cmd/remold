# Recompute source aggregates (10/57/7) and hash all preserved evidence outside independent-r2. Read-only.
import json,hashlib,pathlib,sys,datetime
root=pathlib.Path(__file__).resolve().parents[4]  # proofs/marketing
def agg(manifest,expected):
    m=json.load(open(root/manifest))['files']
    cur={k:hashlib.sha256((root/k).read_bytes()).hexdigest() for k in m}
    a=hashlib.sha256(json.dumps(cur,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'manifest':manifest,'fileCount':len(cur),'allFilesMatchManifest':cur==m,'mismatched':[k for k in m if cur[k]!=m[k]],'aggregate':a,'expected':expected,'match':a==expected}
ev=root/'publishing/evidence'
preserved={str(p.relative_to(ev)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ev.rglob('*')) if p.is_file() and not str(p.relative_to(ev)).startswith('independent-r2')}
out={'at':datetime.datetime.now(datetime.UTC).isoformat(),'checks':[
 agg('publishing/evidence/source-manifest.json','6d1275123b7875212d49b7ac31b24faa794a4431eff9a38ab729951ec2aa2755'),
 agg('evidence/mime/r2/final-source-manifest.json','a0b59a92a768d86e10c2af8b922f0e713335cc938349c6fd8181bd7831702d26'),
 agg('tenants/evidence/source-manifest.json','3a63d24a88f4ee841dc496b5065262adef612029b52a26f35ac41415a049e727')],
 'preservedEvidenceFiles':len(preserved),'preservedEvidenceAggregate':hashlib.sha256(json.dumps(preserved,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'preserved':preserved}
print(json.dumps(out,indent=1))
