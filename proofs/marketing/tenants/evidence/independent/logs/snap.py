import json,subprocess,hashlib,sys
D=['docker','--context','colima-remold-proof']
P='remold-marketing-proof-'
def insp(n):
    return json.loads(subprocess.check_output(D+['inspect',n]))[0]
out={}
for n in ['web-a','db-a','web-b','db-b','web-b-before-media']:
    v=insp(P+n)
    env=v['Config']['Env']
    out[n]={'id':v['Id'],'name':v['Name'],'image':v['Config']['Image'],'running':v['State']['Running'],'status':v['State']['Status'],
      'startedAt':v['State']['StartedAt'],'restartCount':v['RestartCount'],
      'networks':{k:{'aliases':sorted(x for x in (w.get('Aliases') or []) if x not in (v['Id'],v['Id'][:12]))} for k,w in v['NetworkSettings']['Networks'].items()},
      'envHashSortedJSON':hashlib.sha256(json.dumps(sorted(env),separators=(',',':')).encode()).hexdigest(),
      'envCount':len(env),
      'mounts':sorted([{'type':m['Type'],'name':m.get('Name'),'destination':m['Destination'],'rw':m['RW']} for m in v['Mounts']],key=lambda m:m['destination']),
      'portBindings':v['HostConfig'].get('PortBindings') or {},'memory':v['HostConfig']['Memory'],'restartPolicy':v['HostConfig']['RestartPolicy']['Name'],
      'labels':v['Config']['Labels'],'entrypoint':v['Config']['Entrypoint'],'cmd':v['Config']['Cmd']}
for vol in ['files-b','images-b','media-b']:
    v=json.loads(subprocess.check_output(D+['volume','inspect',P+vol]))[0]
    out['volume:'+vol]={'name':v['Name'],'driver':v['Driver'],'labels':v['Labels'],'createdAt':v['CreatedAt']}
print(json.dumps(out,indent=1))
