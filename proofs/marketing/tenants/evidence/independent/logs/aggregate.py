import hashlib,json,sys,datetime
m=json.load(open('tenants/evidence/source-manifest.json'))['files']
cur={k:hashlib.sha256(open(k,'rb').read()).hexdigest() for k in sorted(m)}
agg=hashlib.sha256(json.dumps(cur,sort_keys=True,separators=(',',':')).encode()).hexdigest()
print(json.dumps({'at':datetime.datetime.utcnow().isoformat()+'Z','files':cur,'allMatchManifest':cur==m,'aggregate':agg,'expected':'3a63d24a88f4ee841dc496b5065262adef612029b52a26f35ac41415a049e727','match':agg=='3a63d24a88f4ee841dc496b5065262adef612029b52a26f35ac41415a049e727'},indent=1))
sys.exit(0 if agg=='3a63d24a88f4ee841dc496b5065262adef612029b52a26f35ac41415a049e727' and cur==m else 1)
