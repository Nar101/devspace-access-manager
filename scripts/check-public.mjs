import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd(),issues=[];
const excluded=new Set(['.git','node_modules','build']);
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(excluded.has(e.name))continue;
  const p=path.join(dir,e.name),rel=path.relative(root,p);
  if(e.isSymbolicLink()){issues.push(rel+': symlink not permitted');continue;}
  if(e.isDirectory()){walk(p);continue;}
  if(/\.(pem|key|p12|pfx|sqlite|db|log)$/.test(e.name)||e.name.startsWith('.env'))issues.push(rel+': private file type');
  if(!/\.(png|jpg|jpeg|gif|ico)$/.test(e.name)){
    const s=fs.readFileSync(p,'utf8');
    if(/\/(?:Users|home)\/[a-zA-Z][^\s"']*\//.test(s))issues.push(rel+': absolute personal path');
    if(/https:\/\/devspace-air\./.test(s))issues.push(rel+': live instance endpoint');
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s))issues.push(rel+': private key');
    if(/\b(?:ghp_|github_pat_|sk-proj-)[a-zA-Z0-9_]{20,}/.test(s))issues.push(rel+': credential-like value');
  }
}}
walk(root);
for(const f of ['LICENSE','NOTICE','README.md','docs/DEVSPACE-LICENSE.txt','package-lock.json'])if(!fs.existsSync(path.join(root,f)))issues.push(f+': missing');
if(issues.length){console.error(issues.join('\n'));process.exit(1);}
console.log('Public-file checks passed. This is a bounded check, not a complete security audit.');
