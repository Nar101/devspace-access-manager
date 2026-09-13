import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const inside=(p,r)=>p===r||p.startsWith(r+path.sep);
export const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
export async function snapshot(source,target,{maxBytes=50000000,maxFiles=3000}={}){
 const root=await fs.realpath(source);
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {fileURLToPath}=await import('node:url');
 const {stdout}=await promisify(execFile)('/usr/bin/python3',['-I',fileURLToPath(new URL('./snapshot.py',import.meta.url)),root,target,String(maxBytes),String(maxFiles)],{timeout:60000,maxBuffer:2000000,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
 const result=JSON.parse(stdout);return {...result,revision:digest(JSON.stringify(Object.entries(result.files).sort()))};
}
export function agentPolicy({workspace,home,binary,proxyPort,tmp,helpers=[],readRoots=[]}){
 if(!Number.isInteger(proxyPort)||proxyPort<1||proxyPort>65535)throw Error('Invalid private proxy port');
 const q=JSON.stringify;
 return `(version 1)\n(deny default)
(allow file-read-metadata sysctl-read file-map-executable)
(deny sysctl-read (sysctl-name "kern.procargs") (sysctl-name "kern.procargs2"))
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple") (subpath "/Library/Developer/CommandLineTools") ${readRoots.map(p=>'(subpath '+q(p)+')').join(' ')} (subpath "/private/preboot/Cryptexes/OS") (subpath "/private/var/db/timezone") (literal "/private/etc/localtime") (literal "/dev/urandom") (literal "/dev/random") (literal ${q(binary)}) ${helpers.map(p=>'(literal '+q(p)+')').join(' ')})
(allow file-read* file-write* (subpath ${q(workspace)}) (subpath ${q(home)}) (subpath ${q(tmp)}) (literal "/dev/null"))
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-exec (literal ${q(binary)}) ${helpers.map(p=>'(literal '+q(p)+')').join(' ')} (subpath "/usr/bin") (subpath "/bin") (subpath "/Library/Developer/CommandLineTools/usr/bin"))
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow network-outbound (remote tcp ${q('localhost:'+proxyPort)}))
`;
}
