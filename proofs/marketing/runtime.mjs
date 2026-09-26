import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const directory=fileURLToPath(new URL('.',import.meta.url));
export const context='colima-remold-proof', prefix='remold-marketing-proof';
export const images={mautic:'mautic/mautic@sha256:0b7b0351980d061887fdffd2499f2566c5ecfd28d262f1abdf3ee1bbde24db05',mysql:'mysql@sha256:64a9d35fe6fed01159499be26c3279ac5ee16006c2ebb1f480d634bd5c61a053',convex:'ghcr.io/get-convex/convex-backend@sha256:b1f3b36e87142a043b9a9f2dcb5b3df4512b67e066a822933002388c44bf580a'};
export function docker(args){return execFileSync('docker',['--context',context,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
