// Upload only the already-filtered history export, encrypted to Mini's public key.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),home=os.homedir();
const configFile=path.join(home,'.local/share/devspace-air/config/air-history-upload.json');
const c=JSON.parse(await fs.readFile(configFile,'utf8'));
const stateRoot=path.join(home,'.local/share/devspace-air/state/air-history-upload');await fs.mkdir(stateRoot,{recursive:true,mode:0o700});
const lock=path.join(stateRoot,'lock');let handle;
try{handle=await fs.open(lock,'wx',0o600);}catch(e){
 if(e.code!=='EEXIST')throw e;
 let live=true;try{const stat=await fs.stat(lock);const pid=Number(await fs.readFile(lock,'utf8'));if(stat.mtimeMs<Date.now()-os.uptime()*1000){live=false;}else if(Number.isSafeInteger(pid)&&pid>1){try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')live=false;}}else live=Date.now()-(await fs.stat(lock)).mtimeMs<60000;}catch{}
 if(live){console.log('Previous sync still holds the lock; no duplicate upload.');process.exit(0);}
 await fs.unlink(lock);handle=await fs.open(lock,'wx',0o600);
}
await handle.writeFile(String(process.pid));
const temp=await fs.mkdtemp(path.join(stateRoot,'snapshot-'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const run=async(args)=>{const r=await exec(c.gh||'/opt/homebrew/bin/gh',args,{timeout:240000,maxBuffer:1000000});return r.stdout.trim();};
try{
 const root=await fs.realpath(c.source);if(root!==path.join(home,'Workspace/Codex会话记录'))throw Error('Unexpected history export root');
 const files={};
 async function copy(dir,rel=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){
  if(e.name.startsWith('.'))continue;const item=path.join(dir,e.name),name=rel?rel+'/'+e.name:e.name;
  if(e.isSymbolicLink())throw Error('History export contains a symlink');
  if(e.isDirectory()){await copy(item,name);continue;}
  if(!e.isFile()||!e.name.endsWith('.md'))continue;
  const data=await fs.readFile(item);files[name]={bytes:data.length,sha256:sha(data)};const target=path.join(temp,'history',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data,{mode:0o600});
 }}await copy(root);
 const fingerprint=sha(JSON.stringify(Object.keys(files).sort().filter(k=>k!=='同步状态.md').map(k=>[k,files[k].sha256])));
 let previous;try{previous=JSON.parse(await fs.readFile(path.join(stateRoot,'status.json'),'utf8'));}catch{}
 if(previous?.fingerprint===fingerprint&&previous?.status==='uploaded'&&previous?.transportVersion===2){console.log('No history content change; no upload.');}
 else{
  if(await run(['repo','view',c.repository,'--json','isPrivate','--jq','.isPrivate'])!=='true')throw Error('Transfer repository must remain private');
  await fs.writeFile(path.join(temp,'manifest.json'),JSON.stringify({format:1,machine:'Air',createdAt:new Date().toISOString(),fingerprint,files}));
  const archive=path.join(temp,'history.tar.gz');await exec('/usr/bin/tar',['--disable-copyfile','--no-xattrs','-czf',archive,'-C',temp,'manifest.json','history'],{timeout:120000,env:{...process.env,COPYFILE_DISABLE:'1'}});
  const payload=await fs.readFile(archive),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(payload),cipher.final()]);const publicKey=await fs.readFile(c.publicKey,'utf8');
  const header={format:1,algorithm:'RSA-OAEP-SHA256+AES-256-GCM',wrappedKey:crypto.publicEncrypt({key:publicKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
  const sealed=path.join(temp,'air-history.enc');await fs.writeFile(sealed,Buffer.concat([Buffer.from(JSON.stringify(header)+'\n'),ciphertext]),{mode:0o600});key.fill(0);payload.fill(0);
  // The dedicated private release is provisioned once during installation.
  await run(['release','upload',c.release,sealed,'--repo',c.repository,'--clobber']);
  await fs.writeFile(path.join(stateRoot,'status.json'),JSON.stringify({status:'uploaded',transportVersion:2,fingerprint,at:new Date().toISOString(),files:Object.keys(files).length,encryptedBytes:(await fs.stat(sealed)).size}));
  console.log('Encrypted Air history snapshot uploaded.');
 }
}finally{await fs.rm(temp,{recursive:true,force:true});await handle.close();await fs.unlink(lock);}
