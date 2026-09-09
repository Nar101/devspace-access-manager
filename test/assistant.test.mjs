import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Assistant} from '../src/assistant.mjs';
test('assistant rejects command injection and malformed preferences without launching processes',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-actions-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));let calls=0;
 const a=new Assistant({base,context:path.join(base,'context'),run:async()=>{calls++;}});
 await assert.rejects(a.action('shell',{cmd:'anything'}),/不支持/);
 await assert.rejects(a.action('exclude',{id:'../../escape'}),/会话 ID/);
 await assert.rejects(a.action('autostart',{value:'false'}),/无效/);assert.equal(calls,0);
 await a.action('autostart',{value:false});assert.equal((await a.preferences()).autoStart,false);assert.equal(calls,0);
});
test('stop refuses running or unknown tasks before changing services',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-busy-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));let stopped=false;
 const a=new Assistant({base,context:path.join(base,'context'),supervisor:{state:async()=>({busy:true}),stop:async()=>{stopped=true;}}});
 await assert.rejects(a.stop(),/仍有任务/);assert.equal(stopped,false);assert.equal((await a.preferences()).enabled,true);
});
test('stopping an already exited parent group succeeds without signalling it',async()=>{
 let probes=0,bootout=0;
 const a=new Assistant({run:async()=>{bootout++;},supervisor:{job:async()=>({loaded:true,pid:999999999}),processes:async()=>++probes===1?[{pid:999999999,ppid:1,pgid:999999999,uid:process.getuid(),stat:'S'}]:[]}});
 await a.stopJob('com.nar.codex-context-exporter');assert.equal(bootout,1);assert.ok(probes>=2);
});
test('cold startup can finish after the old 15-second deadline and starts every enabled component',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-cold-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));let probes=0,waits=0;const started=[];
 const a=new Assistant({base,wait:async()=>{waits++;},supervisor:{state:async()=>({service:{running:true},telemetry:++probes>=40?{}:null})}});a.startJob=async label=>started.push(label);
 await a.start(true);assert.equal(waits,39);assert.deepEqual(started,['com.nar.devspace-air','com.nar.devspace-air-tunnel','com.nar.devspace-air-health','com.nar.codex-context-exporter']);
});
test('manual repair restores missing components without restarting the core or resuming explicitly paused context',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-repair-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const loaded=new Set(['com.nar.devspace-air']),bootstrapped=[];
 const a=new Assistant({base,supervisor:{job:async label=>({loaded:loaded.has(label)}),state:async()=>({service:{running:true},telemetry:{}})},run:async(file,args)=>{assert.equal(file,'/bin/launchctl');assert.equal(args[0],'bootstrap');const label=path.basename(args[2],'.plist');loaded.add(label);bootstrapped.push(label);},checkConnection:async mode=>{assert.equal(mode,'repair');assert.ok(loaded.has('com.nar.devspace-air-tunnel'));return {message:'healthy'};}});
 await a.preferencesSet({enabled:false,contextEnabled:false});assert.equal(await a.action('repair'),'healthy');assert.deepEqual(bootstrapped,['com.nar.devspace-air-tunnel','com.nar.devspace-air-health']);assert.equal((await a.preferences()).contextEnabled,false);assert.equal((await a.preferences()).enabled,true);
});
test('login retry respects an explicit stop',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-stopped-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const a=new Assistant({base});await a.preferencesSet({enabled:false});a.startJob=async()=>{throw Error('must remain stopped')};assert.match(await a.start(true),/关闭/);
});
