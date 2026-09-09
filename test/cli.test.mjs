import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validate,parseHelp,commandParts} from '../cli/schema.mjs';
import {Engine} from '../cli/engine.mjs';
import {execute} from '../cli/process.mjs';
import {save,json,redact} from '../cli/common.mjs';
const entry={id:'unit',provider:'dws'};
const s={executable:true,effect:'read',parameters:{query:{type:'string',required:true},limit:{type:'integer'},debug:{type:'boolean'},profile:{type:'string'},'content-file':{type:'string'}}};
test('CLI arguments are schema bounded, cannot become flags, auth overrides or file expansion',()=>{
 assert.deepEqual(validate(entry,s,['chat','search'],{query:'hello; $(touch /tmp/nope) --debug',limit:3}).args,['chat','search','--query=hello; $(touch /tmp/nope) --debug','--limit=3']);
 for(const params of [{query:'x',debug:true},{query:'x',profile:'admin'},{query:'x','content-file':'/private/key'},{query:'@/private/key'},{query:'x',limit:'3'},{limit:3},{query:'x',unknown:'x'}])assert.throws(()=>validate(entry,s,['chat','search'],params));
 assert.throws(()=>commandParts(['--help']));assert.throws(()=>commandParts(['../auth']));
 assert.throws(()=>validate(entry,s,['auth','export'],{query:'x'},[],true));
 assert.throws(()=>validate(entry,{...s,effect:'unknown',executable:false},['chat','search'],{query:'x'},[],true));
 assert.throws(()=>validate(entry,{...s,effect:'write'},['chat','send'],{query:'x'}));
});
test('CLI help is structural: leaf params, positionals and child names remain distinct',()=>{
 const h=parseHelp('Usage: heptabase note read [options] <cardId>\n\nOptions:\n  -c, --content <markdown>   Body\n      --limit int          Number\n  -h, --help               Help\n');
 assert.deepEqual(h.positional,[{name:'cardId',required:true}]);assert.equal(h.parameters.limit.type,'integer');assert.equal(h.parameters.content.type,'string');assert.equal(h.parameters.help.type,'boolean');
 assert.deepEqual(parseHelp('Available Commands:\n  list   List things\n  create Create things\n\nFlags:\n').commands,['list','create']);
});
test('write request receipts prevent concurrent duplicates and uncertain retries, survive restart',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cli-jobs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let calls=0,finish;const engine=new Engine({root,verify:async()=>({id:'test',provider:'local'}),run:async()=>{calls++;return new Promise(r=>{finish=r;});}});
 engine.enabled=async()=>{};await engine.init();
 const a={cli:'test',parameters:{argv:['something']},taskId:'task-unit-0001',requestId:'request-unit-0001',authorizedWrite:true};
 await engine.submit(a);while(!finish)await new Promise(r=>setTimeout(r,5));
 assert.equal((await engine.submit(a)).replayed,true);assert.equal(calls,1);
 await assert.rejects(engine.submit({...a,parameters:{argv:['other']}}),/内容发生变化/);
 finish({status:'timeout',data:{partial:true}});while(engine.controllers.size)await new Promise(r=>setTimeout(r,5));
 assert.equal((await engine.result(a.requestId)).status,'needs_reconciliation');assert.equal((await engine.submit(a)).replayed,true);assert.equal(calls,1);
 await save(path.join(root,'jobs','interrupted-unit.json'),{requestId:'interrupted-unit',status:'running',effect:'write'});await engine.init();assert.equal((await engine.result('interrupted-unit')).status,'needs_reconciliation');
});
test('known secret fields and bearer strings are filtered without discarding business pagination',()=>{
 assert.deepEqual(redact({access_token:'secret',hasMore:true,items:[{title:'business',password:'hidden'}]}),{access_token:'[redacted]',hasMore:true,items:[{title:'business',password:'[redacted]'}]});
 assert.equal(redact('Authorization: Bearer abcdefghijklmn'),'Authorization: Bearer [redacted]');
});
test('CLI worker kernel sandbox denies unrelated files, nested executable and outbound sockets',{skip:process.platform!=='darwin'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cli-boundary-'));await fs.writeFile(path.join(root,'private.txt'),'fixture-secret');t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=await fs.realpath(process.execPath),e={id:'boundary',file,runtime:[path.dirname(path.dirname(file))],network:'none'};
 const code=`const fs=require('fs'),cp=require('child_process'),net=require('net');let r={};try{fs.readFileSync(process.argv[1]);r.private=true}catch{r.private=false}try{cp.execFileSync('/bin/echo',['escaped']);r.nested=true}catch{r.nested=false}const s=net.connect(443,'1.1.1.1');s.on('connect',()=>{r.network=true;s.destroy();console.log(JSON.stringify(r))});s.on('error',()=>{r.network=false;console.log(JSON.stringify(r))});`;
 const r=await execute(e,['-e',code,path.join(root,'private.txt')],{timeout:3000});assert.equal(r.status,'completed');assert.deepEqual(r.data,{private:false,nested:false,network:false});
});
test('output caps preserve truncation state and timeout kills the process group',{skip:process.platform!=='darwin'},async()=>{
 const file=await fs.realpath(process.execPath),e={id:'boundary',file,runtime:[path.dirname(path.dirname(file))]};
 const r=await execute(e,['-e','process.stdout.write("x".repeat(100000))'],{maxBytes:1024});assert.equal(r.status,'output_limit');assert.equal(r.truncated,true);
 const q=await execute(e,['-e','setInterval(()=>{},1000)'],{timeout:100});assert.equal(q.status,'timeout');
});
test('business identity cannot silently change inside an existing task',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cli-identity-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let current='org-a';
 const e=new Engine({root,run:async()=>({status:'completed',data:{profiles:[{profile:current,status:'active',isOrgCurrent:true}]}})});
 await e.identity({id:'dws'},'identity-task-1');current='org-b';await assert.rejects(e.identity({id:'dws'},'identity-task-1'),x=>x.code==='identity_changed');
});
test('Heptabase cannot write an unbound default space; already-read explicit parents are accepted',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cli-scope-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let calls=0;
 const e=new Engine({root,verify:async()=>({id:'heptabase',provider:'commander'}),describe:async()=>({executable:true,effect:'write',parameters:{'parent-whiteboard-id':{type:'string'}}}),run:async()=>{calls++;return {status:'completed',data:{id:'created'}};}});
 e.enabled=async()=>{};e.identity=async()=>({binding:{scope:'test'}});await e.init();
 const a={cli:'heptabase',taskId:'scope-task-0001',requestId:'scope-request-0001',command:['whiteboard','create'],authorizedWrite:true};
 await assert.rejects(e.submit(a),x=>x.code==='unbound_write_target');assert.equal(calls,0);
 const parent='4150c50f-22ca-4ab7-b5bb-7ebcddc0a608';await save(path.join(root,'anchors',a.taskId+'.json'),[parent]);
 await e.submit({...a,parameters:{'parent-whiteboard-id':parent}});while(e.controllers.size)await new Promise(r=>setTimeout(r,5));assert.equal(calls,1);
});
test('legacy tool compatibility never executes its packet as shell and retains workspace/CLI gates',async()=>{
 const {parseCompatibility,wrapCompatibility}=await import('../runtime/cli-compat.mjs');const seen=new Set();let calls=0,shell=0;
 const client={call:async(method,args)=>{calls++;return {method,args};}};
 const exec=wrapCompatibility('exec_command',async()=>{shell++;return {};},client,seen);
 await assert.rejects(exec({workspaceId:'w1',cmd:'devspace-cli {"method":"discover","args":{}}'}),/open_workspace/);
 const open=wrapCompatibility('open_workspace',async()=>({content:[],structuredContent:{workspaceId:'w1',instruction:'original'}}),client,seen);
 assert.match((await open()).structuredContent.instruction,/server-side structured RPC/);
 const r=await exec({workspaceId:'w1',cmd:'devspace-cli {"method":"discover","args":{"query":"heptabase"}}'});assert.equal(JSON.parse(r.structuredContent.result).method,'discover');assert.equal(calls,1);assert.equal(shell,0);
 for(const cmd of ['devspace-cli {}','devspace-cli {"method":"run","args":{}}; echo bad','devspace-cli {"method":"authorize","args":{}}'])assert.throws(()=>parseCompatibility(cmd));
 await exec({workspaceId:'w1',cmd:'pwd'});assert.equal(shell,1);
});
