import {createHash} from 'node:crypto';
import {docker,prefix,images} from '../runtime.mjs';
export const mediaRoot='/var/www/html/docroot/media';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const inspect=name=>JSON.parse(docker(['inspect',name]))[0];
// Numeric ownership, modes, link targets and file bytes, including the volume root.
// ACLs, xattrs and timestamps are outside this bounded comparison.
export const manifestCode=`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function manifest(root){const entries=[];function visit(relative){const p=path.join(root,relative),s=fs.lstatSync(p);let row={path:relative,mode:s.mode&4095,uid:s.uid,gid:s.gid};if(s.isDirectory()){row.type='directory';entries.push(row);for(const name of fs.readdirSync(p).sort())visit(relative==='.'?name:relative+'/'+name);}else if(s.isFile()){row.type='file';row.sha256=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');entries.push(row);}else if(s.isSymbolicLink()){row.type='link';row.target=fs.readlinkSync(p);entries.push(row);}else throw Error('Unsupported file type');}visit('.');return entries;}
`;
export function volumeManifest(name,fixture){return JSON.parse(docker(['run','--rm','--label','remold.proof=marketing','--label','remold.fixture='+fixture,'--network','none','--read-only','--memory','128m','--mount','type=volume,src='+name+',dst=/source,readonly,volume-nocopy','--entrypoint','node',images.mautic,'-e',manifestCode+`console.log(JSON.stringify(manifest('/source')));`]));}
export function databaseSnapshot(){const raw=docker(['exec',prefix+'-db-b','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',"SELECT id,queue_name,SHA2(body,256),created_at,available_at,COALESCE(delivered_at,'NULL') FROM messenger_messages ORDER BY id; SELECT id,username,email,password FROM users ORDER BY id;"]);return digest(raw);}
