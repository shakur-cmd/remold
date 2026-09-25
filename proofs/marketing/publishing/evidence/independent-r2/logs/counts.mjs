// Read-only native DB counters for both tenants via the root nativeCounts helper (db container's own user env; nothing printed).
import {writeFileSync} from 'node:fs';
import {docker,prefix} from '../../../../runtime.mjs';
import {nativeCounts} from '../../../read-effects-replay.mjs';
const extra=t=>docker(['exec',prefix+'-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',"SELECT (SELECT COUNT(*) FROM form_actions),(SELECT COALESCE(MAX(id),0) FROM leads),(SELECT COUNT(*) FROM lead_devices),(SELECT COUNT(*) FROM audit_log)"]).trim().split('\t').map(Number);
const out={label:process.argv[2],at:new Date().toISOString(),tenants:{}};
for(const t of ['a','b']){const [formActions,maxLeadId,leadDevices,auditLog]=extra(t);out.tenants[t]={...nativeCounts(t),formActions,maxLeadId,leadDevices,auditLog};}
writeFileSync(process.argv[3],JSON.stringify(out,null,1)+'\n');console.log(JSON.stringify(out));
