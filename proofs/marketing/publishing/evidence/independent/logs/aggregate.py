import json,hashlib,pathlib,sys,datetime
root=pathlib.Path(__file__).resolve().parents[4]  # proofs/marketing
def agg(manifest,expected):
    m=json.load(open(root/manifest))['files']
    cur={k:hashlib.sha256((root/k).read_bytes()).hexdigest() for k in m}
    a=hashlib.sha256(json.dumps(cur,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'manifest':manifest,'fileCount':len(cur),'allFilesMatchManifest':cur==m,'mismatched':[k for k in m if cur[k]!=m[k]],'aggregate':a,'expected':expected,'match':a==expected}
out={'at':datetime.datetime.now(datetime.UTC).isoformat(),'checks':[
 agg('publishing/evidence/source-manifest.json','e4396bc3e41c28c8d587d0f4d5d58aa83501900a3d089f63ff3c7613871a8216'),
 agg('evidence/mime/r2/final-source-manifest.json','a0b59a92a768d86e10c2af8b922f0e713335cc938349c6fd8181bd7831702d26'),
 agg('tenants/evidence/source-manifest.json','3a63d24a88f4ee841dc496b5065262adef612029b52a26f35ac41415a049e727')]}
print(json.dumps(out,indent=1))
