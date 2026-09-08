import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {BASE,ROOT,ACCESS,ACTIVE,KEY,NODE} from './paths.mjs';
import {readJSON,atomicJSON,loadActive} from './store.mjs';
import {stageGeneration} from './policy.mjs';
if(!process.argv.includes('--migrate-existing')){
  console.error('Source preview: this migrates a pre-existing, reviewed DevSpace deployment. Read docs/integration.md before using --migrate-existing.');
  process.exit(2);
}
const run=promisify(execFile);
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hashes=await readJSON(path.join(source,'runtime/upstream-hashes.json'));
const dist=path.join(BASE,'app/node_modules/@waishnav/devspace/dist');
const original={};
for(const f of Object.keys(hashes)){
  original[f]=await fs.readFile(path.join(dist,f),'utf8');
  if(crypto.createHash('sha256').update(original[f]).digest('hex')!==hashes[f])throw new Error('Upstream changed; refusing to patch '+f);
}
const backup=path.join(BASE,'backups','access-manager-'+new Date().toISOString().replaceAll(':','-'));
await fs.mkdir(backup,{recursive:true,mode:0o700});
for(const f of ['bin/serve','bin/server.mjs','server.sb','config/config.json','config/installation.json']){
  const to=path.join(backup,f);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(path.join(BASE,f),to);
}
for(const f of Object.keys(original))await fs.writeFile(path.join(backup,f),original[f],{mode:0o600});
console.log('Backup created: '+backup);
const config=await readJSON(path.join(BASE,'config/config.json'));
let template=await fs.readFile(path.join(BASE,'server.sb'),'utf8');
// Remove only the existing business-root grants from the shared read/write block.
for(const root of config.allowedRoots) {
  const line='  (subpath '+JSON.stringify(root)+')\n';
  if(!template.includes(line))throw new Error('Cannot migrate existing folder grant '+root);
  template=template.replace(line,'');
}
template=template.replace('; Keep credential files','; ACCESS_GRANTS\n\n; Keep credential files');
await fs.mkdir(ACCESS,{recursive:true,mode:0o700});
await fs.writeFile(path.join(ACCESS,'base-policy.sb'),template,{mode:0o600});
await atomicJSON(path.join(ACCESS,'base-config.json'),config);
const grants=config.allowedRoots.map(p=>({id:crypto.createHash('sha256').update(p).digest('hex').slice(0,16),path:p,mode:'rw'}));
const initial=await stageGeneration(grants,{template,baseConfig:config});
await run('/usr/bin/sandbox-exec',['-f',path.join(initial.dir,'server.sb'),NODE,'-e','process.exit(0)'],{timeout:10000});
await fs.mkdir(path.join(source,'build'),{recursive:true});
await run('/usr/bin/xcrun',['swiftc',path.join(source,'native/FolderPicker.swift'),'-o',path.join(source,'build/folder-picker')],{timeout:120000});
await fs.mkdir(ROOT,{recursive:true,mode:0o700});
for(const folder of ['src','public','runtime'])await fs.cp(path.join(source,folder),path.join(ROOT,folder),{recursive:true});
await fs.mkdir(path.join(ROOT,'bin'),{recursive:true});
await fs.copyFile(path.join(source,'build/folder-picker'),path.join(ROOT,'bin/folder-picker'));
await fs.chmod(path.join(ROOT,'bin/folder-picker'),0o755);
try{await fs.access(KEY);}catch{await fs.writeFile(KEY,crypto.randomBytes(32).toString('hex')+'\n',{mode:0o600});}

// Do not migrate while existing DevSpace command children are running.
let oldPid=0,wasRunning=false;
try {
  const {stdout}=await run('/bin/launchctl',['print','gui/'+process.getuid()+'/com.nar.devspace-air']);
  oldPid=Number(stdout.match(/^\s*pid = (\d+)/m)?.[1]||0);wasRunning=!!oldPid;
}catch{}
if(oldPid){
  const {stdout}=await run('/bin/ps',['-axo','pid=,ppid=']);
  if(stdout.split('\n').some(l=>Number(l.trim().split(/\s+/)[1])===oldPid))throw new Error('DevSpace has command children; finish the current command before installation');
}
await run(path.join(BASE,'bin/control'),['stop'],{timeout:40000});
try{
  let server=original['server.js'];
  const registration='    registerAppResource(server, "DevSpace Diff Card", WORKSPACE_APP_URI, {';
  server=server.replace(registration,'    globalThis.__devspaceAccessHook?.register(server);\n'+registration);
  const request='        logEvent(config.logging, "debug", "mcp_request", {';
  server=server.replace(request,'        if (globalThis.__devspaceAccessHook && !globalThis.__devspaceAccessHook.beforeRequest(req, res)) return;\n'+request);
  let processes=original['process-sessions.js'];
  processes=processes.replace('        session.process = {\n            write: (data) => child.stdin.write(data),','        globalThis.__devspaceAccessHook?.spawned(child.pid);\n        session.process = {\n            write: (data) => child.stdin.write(data),');
  processes=processes.replace('        session.process = {\n            write: (data) => pty.write(data),','        globalThis.__devspaceAccessHook?.spawned(pty.pid);\n        session.process = {\n            write: (data) => pty.write(data),');
  if(!server.includes('__devspaceAccessHook?.register')||!server.includes('__devspaceAccessHook.beforeRequest')||!processes.includes('spawned(child.pid)'))throw new Error('Patch insertion failed');
  await fs.writeFile(path.join(dist,'server.js'),server);
  await fs.writeFile(path.join(dist,'process-sessions.js'),processes);
  await fs.copyFile(path.join(source,'runtime/server.mjs'),path.join(BASE,'bin/server.mjs'));
  let launcher=await fs.readFile(path.join(backup,'bin/serve'),'utf8');
  launcher=launcher.replace('from pathlib import Path','from pathlib import Path\nimport json, hashlib, re');
  const start='os.umask(0o077)';
  launcher=launcher.replace(start,[
    start,
    'active = json.loads((base / "config/access/active.json").read_text())',
    'if not re.fullmatch(r"[a-zA-Z0-9-]+", active["revision"]): raise RuntimeError("Invalid access generation")',
    'generation = base / "config/access/generations" / active["revision"]',
    'manifest = json.loads((generation / "manifest.json").read_text())',
    'for filename in ["config.json", "server.sb"]:',
    '    if hashlib.sha256((generation / filename).read_bytes()).hexdigest() != manifest["hashes"][filename]: raise RuntimeError("Access configuration integrity mismatch")',
  ].join('\n'));
  launcher=launcher.replace('credential = (base / "secrets/owner.json").read_bytes()',[
    'payload = json.loads((base / "secrets/owner.json").read_text())',
    'payload["telemetryKey"] = (base / "secrets/access-telemetry.key").read_text().strip()',
    'credential = json.dumps(payload).encode()'
  ].join('\n'));
  launcher=launcher.replace('"DEVSPACE_CONFIG_DIR": str(base / "config")','"DEVSPACE_CONFIG_DIR": str(generation)');
  launcher=launcher.replace('str(base / "server.sb")','str(generation / "server.sb")');
  await fs.writeFile(path.join(BASE,'bin/serve'),launcher,{mode:0o755});await fs.chmod(path.join(BASE,'bin/serve'),0o755);
  await atomicJSON(ACTIVE,{revision:initial.revision});
  const receipt=await readJSON(path.join(BASE,'config/installation.json'));
  receipt.accessManager={version:1,source,backup,installedAt:new Date().toISOString(),
    patchedHashes:Object.fromEntries(await Promise.all(['server.js','process-sessions.js'].map(async f=>[f,crypto.createHash('sha256').update(await fs.readFile(path.join(dist,f))).digest('hex')])) )};
  await atomicJSON(path.join(BASE,'config/installation.json'),receipt);
  if(wasRunning)await run(path.join(BASE,'bin/control'),['start'],{timeout:45000});
}catch(e){
  await run(path.join(BASE,'bin/control'),['stop'],{timeout:40000}).catch(()=>{});
  for(const f of ['bin/serve','bin/server.mjs','server.sb','config/config.json','config/installation.json'])await fs.copyFile(path.join(backup,f),path.join(BASE,f));
  for(const f of Object.keys(original))await fs.writeFile(path.join(dist,f),original[f]);
  if(wasRunning)await run(path.join(BASE,'bin/control'),['start'],{timeout:45000}).catch(()=>{});
  throw e;
}
const shortcut=path.join(os.homedir(),'Applications/DevSpace 文件夹权限.command');
const shQuote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
await fs.writeFile(shortcut,'#!/bin/sh\nexec '+shQuote(NODE)+' '+shQuote(path.join(ROOT,'src/launch.mjs'))+'\n',{mode:0o755});await fs.chmod(shortcut,0o755);
console.log('Installed. Existing folders and OAuth credentials preserved.');
console.log('Launcher: '+shortcut);
