import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonicalFolder,propose,compilePolicy,stageGeneration} from '../src/policy.mjs';
import {atomicJSON,loadActive,acquireLock} from '../src/store.mjs';
import {Transactions} from '../src/transactions.mjs';
import {NODE} from '../src/paths.mjs';
const run=promisify(execFile);
async function fixture(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devspace-policy-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const home=path.join(dir,'home'), base=path.join(home,'.local/share/devspace-air');
  await fs.mkdir(base,{recursive:true});return {dir,home,base};
}
test('normalizes real paths and refuses broad or management locations',async t=>{
  const f=await fixture(t),folder=path.join(f.home,'工作 文件夹 "one"');
  await fs.mkdir(folder);await fs.symlink(folder,path.join(f.home,'alias'));
  assert.equal(await canonicalFolder(path.join(f.home,'alias'),f),await fs.realpath(folder));
  await assert.rejects(canonicalFolder(f.home,f),/包含系统/);
  await assert.rejects(canonicalFolder(f.base,f),/包含系统/);
  await assert.rejects(canonicalFolder('/Users',f),/包含系统/);
});
test('duplicate, inherited and parent merge have deterministic permissions',()=>{
  const grants=[{id:'a',path:'/work/a',mode:'rw'},{id:'b',path:'/work/b',mode:'ro'}];
  assert.throws(()=>propose(grants,'add','/work/a/child','ro'),/父目录/);
  const result=propose(grants,'add','/work','rw');
  assert.equal(result.grants.length,1);assert.equal(result.removed.length,2);
  assert.equal(result.grants[0].mode,'rw');
  assert.equal(propose(grants,'mode','a','ro').grants[0].mode,'ro');
  assert.equal(grants[0].mode,'rw');
  assert.equal(propose(grants,'remove','a').grants.length,1);
});
test('atomic generations preserve zero grants and detect external edits',async t=>{
  const f=await fixture(t),root=path.join(f.dir,'access'),active=path.join(root,'active.json');
  const g=await stageGeneration([],{...f,root,template:'(version 1)\n(deny default)\n; ACCESS_GRANTS',baseConfig:{port:7676,allowedRoots:['old']}});
  await atomicJSON(active,{revision:g.revision});
  assert.deepEqual((await loadActive(root,active)).grants,[]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(g.dir,'config.json'))).allowedRoots,[]);
  await fs.appendFile(path.join(g.dir,'server.sb'),'\n(allow default)');
  await assert.rejects(loadActive(root,active),/外部修改/);
});
test('cross-process operation lock excludes a second writer',async t=>{
  const f=await fixture(t);const release=await acquireLock(f.dir);
  await assert.rejects(acquireLock(f.dir),/正在进行/);
  await release();await (await acquireLock(f.dir))();
});
test('startup failure rolls back pointer and original running state',async t=>{
  const f=await fixture(t),root=path.join(f.dir,'access'),active=path.join(root,'active.json'),journal=path.join(root,'transaction.json');
  const template='(version 1)\n(deny default)\n; ACCESS_GRANTS',baseConfig={port:7676};
  await fs.mkdir(root);await fs.writeFile(path.join(root,'base-policy.sb'),template);await atomicJSON(path.join(root,'base-config.json'),baseConfig);
  const initial=await stageGeneration([],{...f,root,template,baseConfig});await atomicJSON(active,{revision:initial.revision});
  let starts=0,stops=0;
  const supervisor={state:async()=>({service:{loaded:true},tunnel:{loaded:true}}),validate:async()=>{},stop:async()=>{stops++;},start:async(before,rev)=>{starts++;if(starts===1)throw new Error('startup-failed');assert.equal(rev,initial.revision);}};
  const tx=new Transactions(supervisor,{...f,root,active,journal});
  await assert.rejects(tx.apply({baseRevision:initial.revision,grants:[]}),/startup-failed/);
  assert.equal((await loadActive(root,active)).revision,initial.revision);assert.equal(starts,2);assert.equal(stops,2);
});
test('interrupted switch is recovered to the prior generation',async t=>{
  const f=await fixture(t),root=path.join(f.dir,'access'),active=path.join(root,'active.json'),journal=path.join(root,'transaction.json');
  const template='(version 1)\n(deny default)\n; ACCESS_GRANTS',baseConfig={port:7676};
  const old=await stageGeneration([],{...f,root,template,baseConfig});
  const newer=await stageGeneration([],{...f,root,template,baseConfig});await atomicJSON(active,{revision:newer.revision});
  await atomicJSON(journal,{previous:old.revision,next:newer.revision,before:{service:{loaded:false},tunnel:{loaded:false}},phase:'switched'});
  let restarted;const supervisor={stop:async()=>{},start:async(before,rev)=>{restarted={before,rev};}};
  await new Transactions(supervisor,{...f,root,active,journal}).recover();
  assert.equal((await loadActive(root,active)).revision,old.revision);assert.equal(restarted.before.service.loaded,false);
});
test('real Seatbelt permits rw, rejects ro writes and symlink escape',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),rw=path.join(f.home,'业务 "读写"'),ro=path.join(f.home,'只读'),secret=path.join(f.home,'.ssh');
  for(const p of [rw,ro,secret])await fs.mkdir(p);
  await fs.writeFile(path.join(ro,'data.txt'),'read-only');await fs.writeFile(path.join(secret,'key.txt'),'canary');
  await fs.symlink(secret,path.join(rw,'escape'));
  const template='(version 1)\n(deny default)\n(allow file-read-metadata)\n(allow process-exec file-map-executable sysctl-read)\n(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/System/Cryptexes") (subpath "/private/preboot/Cryptexes/OS") (subpath "/usr/lib") (subpath "/bin") (subpath '+JSON.stringify(path.dirname(path.dirname(NODE)))+'))\n; ACCESS_GRANTS';
  const policy=compilePolicy(template,[{id:'a',path:rw,mode:'rw'},{id:'b',path:ro,mode:'ro'}],f);
  const file=path.join(f.dir,'policy.sb');await fs.writeFile(file,policy);
  const code="const fs=require('fs');fs.writeFileSync(process.argv[1]+'/ok.txt','ok');console.log(fs.readFileSync(process.argv[2]+'/data.txt','utf8'));for(const p of [process.argv[2]+'/bad.txt',process.argv[1]+'/escape/key.txt']){try{const fd=fs.openSync(p,p.endsWith('bad.txt')?'w':'r');fs.closeSync(fd);process.exit(8)}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;}}try{fs.linkSync(process.argv[2]+'/data.txt',process.argv[1]+'/hardlink');fs.writeFileSync(process.argv[1]+'/hardlink','bad');process.exit(9)}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;}";
  const r=await run('/usr/bin/sandbox-exec',['-f',file,NODE,'-e',code,rw,ro]);
  assert.match(r.stdout,/read-only/);assert.equal(await fs.readFile(path.join(rw,'ok.txt'),'utf8'),'ok');
});
test('failed rollback stops a partially started service and preserves recovery journal',async t=>{
  const f=await fixture(t),root=path.join(f.dir,'access'),active=path.join(root,'active.json'),journal=path.join(root,'transaction.json');
  const template='(version 1)\n(deny default)\n; ACCESS_GRANTS',baseConfig={port:7676};
  await fs.mkdir(root);await fs.writeFile(path.join(root,'base-policy.sb'),template);await atomicJSON(path.join(root,'base-config.json'),baseConfig);
  const initial=await stageGeneration([],{...f,root,template,baseConfig});await atomicJSON(active,{revision:initial.revision});
  let running=true,stops=0;
  const supervisor={state:async()=>({service:{loaded:true},tunnel:{loaded:true}}),validate:async()=>{},stop:async()=>{running=false;stops++;},start:async()=>{running=true;throw new Error('not-ready');}};
  await assert.rejects(new Transactions(supervisor,{...f,root,active,journal}).apply({baseRevision:initial.revision,grants:[]}),/服务已停止/);
  assert.equal(running,false);assert.equal(stops,3);await fs.access(journal);
});
