import fs from 'node:fs/promises';
import path from 'node:path';
import {HOME,DIR,BASE,hash,fileHash,json,save,fail} from './common.mjs';
import {execute} from './process.mjs';
export const REGISTRY=path.join(BASE,'config/cli-registry.json');
const searchPaths=[path.join(HOME,'.local/bin'),path.join(HOME,'.npm-global/bin'),'/usr/local/bin','/opt/homebrew/bin','/usr/bin','/bin'];
export const skillRoots=[path.join(HOME,'Workspace/Workbench/.agents/skills'),path.join(HOME,'.agents/skills'),path.join(HOME,'.codex/skills')];
const known={
 node:{file:path.join(BASE,'node-v24.20.0-darwin-arm64/bin/node'),provider:'local',network:'none',provenance:'verified_DevSpace_runtime'},
 dws:{file:path.join(HOME,'.local/bin/dws'),provider:'dws',network:'https',credentials:[path.join(HOME,'.dws'),path.join(HOME,'Library/Application Support/dws-cli')]},
 heptabase:{file:path.join(BASE,'node-v24.20.0-darwin-arm64/bin/node'),prefix:['/Applications/Heptabase.app/Contents/Resources/cli/cli.cjs'],provider:'commander',network:'loopback',credentials:[path.join(HOME,'.heptabase')],runtime:['/Applications/Heptabase.app/Contents/Resources/cli',path.join(BASE,'node-v24.20.0-darwin-arm64')]},
 'lark-cli':{file:path.join(HOME,'.npm-global/lib/node_modules/@larksuite/cli/bin/lark-cli'),provider:'lark',network:'https',credentials:[path.join(HOME,'.lark-cli'),path.join(HOME,'Library/Application Support/lark-cli')]},
 arkcli:{file:path.join(HOME,'.npm-global/lib/node_modules/@volcengine/ark-cli/bin/arkcli-darwin-arm64'),provider:'inspect',network:'none',reason:'命令缺少统一可验证的副作用与账号约束；帮助可查询，执行待适配。'},
};
for(const name of ['rg','jq','git','ffmpeg','ffprobe'])known[name]={provider:'local',network:'none'};
export async function discover(){
 const found=new Map();
 for(const dir of searchPaths){let names;try{names=await fs.readdir(dir);}catch{continue;}
  for(const name of names){if(!/^[a-zA-Z0-9_.+-]+$/.test(name)||found.has(name))continue;const p=path.join(dir,name);try{await fs.access(p,fs.constants.X_OK);if((await fs.stat(p)).isFile())found.set(name,p);}catch{}}
 }
 return found;
}
export async function enroll(){
 const found=await discover(),entries=[];
 for(const [name,profile] of Object.entries(known)){
  if(!found.has(name))continue;
  const file=await fs.realpath(profile.file||found.get(name));
  if(profile.provider==='local'&&profile.provenance!=='verified_DevSpace_runtime'&&!file.startsWith('/usr/bin/')&&!file.startsWith('/bin/')&&!file.startsWith('/opt/homebrew/Cellar/'))continue;
  const entry={id:name,...profile,file};
  entry.integrity={[file]:await fileHash(file)};
  for(const f of profile.prefix||[])entry.integrity[f]=await fileHash(f);
  if(profile.provider==='commander'){
   const version=await execute(entry,['--version']);if(version.status!=='completed'||!String(version.data).trim().startsWith('0.6.'))fail('version_unsupported','Heptabase 需要兼容 0.6.x CLI');
   entry.version=String(version.data).trim();
  }
  entries.push(entry);
 }
 // Locally managed native programs need no credential adapter: they run with
 // the existing file grants and no networking. Scripts/download directories
 // are not treated as trusted executable sources merely because they are on PATH.
 const seen=new Set(entries.map(e=>e.id)),digests=new Map();
 for(const [name,p]of found){
  if(seen.has(name))continue;
  try{
  const file=await fs.realpath(p);
  const system=file.startsWith('/usr/bin/')||file.startsWith('/bin/');
  const brew=file.startsWith('/opt/homebrew/Cellar/');
  if(!system&&!brew)continue;
  const h=await fs.open(file,'r');let magic;try{const b=Buffer.alloc(4);await h.read(b,0,4,0);magic=b.toString('hex');}finally{await h.close();}
  if(!['cffaedfe','cefaedfe','cafebabe','bebafeca','feedfacf','cafebabf'].includes(magic))continue;
  if(brew){const parts=file.split('/');try{await fs.access(parts.slice(0,6).join('/')+'/INSTALL_RECEIPT.json');}catch{continue;}}
  let digest=digests.get(file);if(!digest){digest=await fileHash(file);digests.set(file,digest);}
  entries.push({id:name,file,provider:'local',network:'none',integrity:{[file]:digest},provenance:system?'macOS_system':'homebrew_receipt'});
  }catch(e){if(!['EACCES','EPERM','ENOENT'].includes(e.code))throw e;}
 }
 await save(REGISTRY,{version:1,createdAt:new Date().toISOString(),entries});
 return entries;
}
export async function verified(name){
 const registry=await json(REGISTRY,{entries:[]}),entry=registry.entries.find(x=>x.id===name);
 if(!entry)fail('not_integrated','尚未确认此 CLI 的执行来源与权限边界；不能由远程请求自行接入。');
 for(const [p,digest]of Object.entries(entry.integrity))if(await fileHash(p)!==digest)fail('executable_changed','CLI 已更新，需本机重新核对执行来源；当前请求未执行。');
 return entry;
}
export async function inventory(){
 const found=await discover(),registry=await json(REGISTRY,{entries:[]});
 const entries=[];
 for(const e of registry.entries){let status='ready',reason=e.reason||null;try{await verified(e.id);}catch(err){status='blocked';reason=err.message;}
  entries.push({id:e.id,path:e.file,provider:e.provider,status:e.provider==='inspect'&&status==='ready'?'help_only':status,reason,scope:e.provider==='local'?'文件夹沙箱 · 禁止联网':e.provider==='inspect'?'仅帮助':e.id==='heptabase'?'绑定桌面会话；写入须指定本任务已读取的对象':'业务 CLI · 固定身份'});found.delete(e.id);
 }
 return {entries,discovered:[...found].map(([id,p])=>({id,path:p,status:'not_integrated',reason:'未授予联网或凭据权限；需核对来源、命令语义及账号约束。'}))};
}
// Skills are instructions/data, never executable authorization.
export async function skills(){
 const result=[];
 for(let rootIndex=0;rootIndex<skillRoots.length;rootIndex++){
  let names;try{names=await fs.readdir(skillRoots[rootIndex]);}catch{continue;}
  for(const name of names){const p=path.join(skillRoots[rootIndex],name,'SKILL.md');try{const text=await fs.readFile(p,'utf8');result.push({id:rootIndex+':'+name,name,path:p,description:text.match(/^description:\s*(.+)$/m)?.[1]||''});}catch{}}
 }
 return result;
}
export async function readSkill(id,relative='SKILL.md'){
 const skill=(await skills()).find(s=>s.id===id);if(!skill)fail('skill_missing','找不到该技能');
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..')||!relative.endsWith('.md'))fail('invalid_path','只允许读取该技能目录中的 Markdown');
 const root=await fs.realpath(path.dirname(skill.path)),target=await fs.realpath(path.join(root,relative));
 if(target!==root&&!target.startsWith(root+path.sep))fail('invalid_path','技能链接指向目录外');
 const stat=await fs.stat(target);if(stat.size>128000)fail('output_limit','技能文件过大，请读取更具体的引用');
 return {id,relative,text:await fs.readFile(target,'utf8'),authority:'reference_only'};
}
