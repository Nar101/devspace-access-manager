import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {BASE, ROOT, ACCESS, inside} from './paths.mjs';
import {atomicJSON} from './store.mjs';

export function guardPaths(home = os.homedir(), base = BASE) {
  // Example protected workspace layout. Adapt this only with a reviewed deployment baseline.
  const workbench = path.join(home,'Workspace/Workbench');
  return {
    unreadable: [
      path.join(home,'.ssh'), path.join(home,'.aws'), path.join(home,'.azure'),
      path.join(home,'.config'), path.join(home,'Library/Keychains'),
      path.join(home,'Library/Application Support/Dia'), path.join(home,'Library/Application Support/Google/Chrome'),
      path.join(home,'Library/Application Support/Microsoft Edge'), path.join(home,'Library/Safari'),
      path.join(base,'secrets'), path.join(base,'backups'),
      path.join(base,'access-manager-session.json'),
      path.join(workbench,'.obsidian'), path.join(workbench,'.codex'),
      path.join(workbench,'codex-model-router'),
      path.join(workbench,'PrivateInfrastructure')
    ],
    immutable: [
      path.join(base,'config'), path.join(base,'bin'), path.join(base,'app'),
      path.join(base,'manager'), path.join(base,'server.sb'), path.join(base,'tunnel.sb'),
      path.join(home,'Library/LaunchAgents'), path.join(home,'Applications'),
      path.join(home,'Developer/devspace-access-manager'),
      path.join(workbench,'tools'), path.join(workbench,'Archive')
    ]
  };
}
export async function canonicalFolder(input, {home=os.homedir(), base=BASE}={}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input))
    throw new Error('请选择有效的绝对文件夹路径');
  const real = await fs.realpath(input);
  home = await fs.realpath(home);
  try {base = await fs.realpath(base);} catch {base = path.resolve(base);}
  if (!(await fs.stat(real)).isDirectory()) throw new Error('选择的路径不是文件夹');
  const forbiddenRoots = ['/', '/Users', home, '/Volumes', '/Applications'];
  const protectedSystem = ['/System','/Library','/usr','/bin','/sbin','/opt','/dev','/private/etc','/private/var/db'];
  const g=guardPaths(home,base);
  const hiddenHome = inside(real,home) && path.relative(home,real).split(path.sep)[0].startsWith('.');
  if (forbiddenRoots.includes(real) || hiddenHome || inside(real,path.join(home,'Library')) || protectedSystem.some(p=>inside(real,p)) ||
      [...g.unreadable,...g.immutable].some(p=>inside(real,p))) {
    throw new Error('这个位置包含系统、凭据或运行配置，请选择具体的业务文件夹');
  }
  return real;
}
export function propose(grants, action, selected, mode='rw') {
  if (!['ro','rw'].includes(mode)) throw new Error('权限类型无效');
  const current=grants.map(x=>({...x}));
  if (action==='remove' || action==='mode') {
    const item=current.find(g=>g.id===selected);
    if (!item) throw new Error('授权已变化，请刷新列表');
    if (action==='remove') return {grants:current.filter(g=>g.id!==selected),removed:[item],target:item};
    item.mode=mode;
    return {grants:current,removed:[],target:item};
  }
  if (action!=='add') throw new Error('操作无效');
  const parent=current.find(g=>inside(selected,g.path));
  if (parent) {
    const e=new Error('该目录已包含在「'+path.basename(parent.path)+'」的授权中，请修改父目录权限');
    e.code='INHERITED'; e.inherited=parent; throw e;
  }
  const merged=current.filter(g=>inside(g.path,selected));
  const item={id:crypto.createHash('sha256').update(selected).digest('hex').slice(0,16),path:selected,mode};
  return {grants:[...current.filter(g=>!merged.includes(g)),item],removed:merged,target:item};
}
export function compilePolicy(template, grants, {home=os.homedir(),base=BASE}={}) {
  const quote=s=>JSON.stringify(s);
  const rows=grants.map(g=>'(allow file-read*'+(g.mode==='rw'?' file-write*':'')+' (subpath '+quote(g.path)+'))').join('\n');
  if (!template.includes('; ACCESS_GRANTS')) throw new Error('缺少权限模板标记');
  let out=template.replace('; ACCESS_GRANTS',rows);
  const guards=guardPaths(home,base);
  const protectedAll=[...guards.unreadable,...guards.immutable];
  out+='\n; Fixed access-manager protection (not editable through folder grants).\n';
  out+='(deny file-read* file-write* (regex #"(^|/)[.](ssh|aws|azure|gnupg|kube|obsidian|codex)(/|$)"))\n';
  out+='(allow file-read* (subpath '+quote(path.join(home,'.codex/skills'))+') (subpath '+quote(path.join(home,'.codex/plugins/cache'))+'))\n';
  out+='(deny file-read* file-write* (regex #"(^|/)[.]env([./].*)?$") (regex #"(^|/)(auth|credentials|secrets)[.]json$") (regex #"[.](pem|key|p12|pfx)$"))\n';
  for (const p of guards.unreadable) out+='(deny file-read* file-write* (subpath '+quote(p)+'))\n';
  for (const p of guards.immutable) out+='(deny file-write* (subpath '+quote(p)+'))\n';
  out+='(allow file-read* (subpath '+quote(path.join(base,'manager/runtime'))+'))\n';
  for (const g of grants) {
    // A read-only grant must stay read-only even when it covers a runtime read path.
    if(g.mode==='ro') out+='(deny file-write* (subpath '+quote(g.path)+'))\n';
    const ancestors=new Set();
    for(const p of protectedAll) {
      if(!inside(p,g.path)) continue;
      let a=path.dirname(p);
      while(inside(a,g.path)) {ancestors.add(a);if(a===g.path)break;a=path.dirname(a);}
    }
    for(const a of ancestors)out+='(deny file-write-unlink (literal '+quote(a)+'))\n';
    // Also keep the granted root from being moved while a service generation uses it.
    out+='(deny file-write-unlink (literal '+quote(g.path)+'))\n';
  }
  return out;
}
export async function stageGeneration(grants, {root=ACCESS,template,baseConfig,home=os.homedir(),base=BASE}={}) {
  const revision=crypto.randomUUID();
  const dir=path.join(root,'generations',revision);
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const config={...baseConfig,allowedRoots:grants.map(g=>g.path)};
  await atomicJSON(path.join(dir,'config.json'),config);
  await fs.writeFile(path.join(dir,'server.sb'),compilePolicy(template,grants,{home,base}),{mode:0o600});
  const hashes={};
  for(const f of ['config.json','server.sb'])hashes[f]=crypto.createHash('sha256').update(await fs.readFile(path.join(dir,f))).digest('hex');
  const manifest={version:1,revision,grants,hashes,createdAt:new Date().toISOString()};
  await atomicJSON(path.join(dir,'manifest.json'),manifest);
  return {dir,revision,grants,manifest};
}
