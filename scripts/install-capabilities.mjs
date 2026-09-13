import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {BASE,ROOT,NODE,ACCESS} from '../src/paths.mjs';import {Supervisor} from '../src/supervisor.mjs';import {atomicJSON,acquireLock,loadActive} from '../src/store.mjs';import {digest} from '../capabilities/policy.mjs';
if(!process.argv.includes('--apply')){console.log('Install reviewed capability runtime into this existing deployment: --apply. Other hosts are not changed.');process.exit(0);}
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),supervisor=new Supervisor();
const unlock=await acquireLock(),drain=path.join(ACCESS,'drain.json'),backup=path.join(BASE,'backups','capabilities-'+Date.now());let before,stopped=false,mutated=false;
const targets=['package.json','src/assistant.mjs','public/index.html','cli/broker.mjs','runtime/access-hook.mjs','runtime/agent.md','runtime/cli-compat.mjs','runtime/cli-client.mjs','capabilities'].map(f=>({source:path.join(source,f),target:path.join(ROOT,f),name:f,exists:false}));targets.push({target:path.join(BASE,'config/capabilities.json'),name:'capabilities.json',exists:false});
try{
 await atomicJSON(drain,{reason:'capability runtime update',at:Date.now()});before=await supervisor.state();if(before.busy)throw Error('DevSpace有其他任务，未替换组件');
 await fs.mkdir(backup,{recursive:true});for(const t of targets){try{await fs.access(t.target);t.exists=true;await fs.mkdir(path.dirname(path.join(backup,t.name)),{recursive:true});await fs.cp(t.target,path.join(backup,t.name),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}}
 const config=targets.at(-1);let prior={};if(config.exists)prior=JSON.parse(await fs.readFile(config.target,'utf8'));
 before=await supervisor.stop();stopped=true;mutated=true;for(const t of targets.filter(t=>t.source))await fs.cp(t.source,t.target,{recursive:true});
 const binary=await fs.realpath(path.join(os.homedir(),'.local/bin/codex')),helper=path.join(path.dirname(binary),'codex-code-mode-host'),hashes={};for(const f of [binary,helper,NODE,path.join(path.dirname(path.dirname(NODE)),'lib/node_modules/npm/bin/npm-cli.js')])hashes[f]=digest(await fs.readFile(f));
 let grokRuntime={};if(process.argv.includes('--enable-grok')){const grokBinary=await fs.realpath(process.env.GROK_BINARY||path.join(os.homedir(),'.grok/bin/grok'));grokRuntime={grokBinary,grokHash:digest(await fs.readFile(grokBinary))};prior.grok=true;}
 if(process.argv.includes('--enable-project-delivery'))prior.projectDelivery=true;
 if(process.argv.includes('--enable-grok-search'))prior.grokSearch=true;
 await atomicJSON(config.target,{enabled:true,codex:true,projects:'authorized',model:'gpt-6-astra',timeoutMs:600000,browser:false,desktop:false,grok:false,...prior,runtime:{binary,node:NODE,hashes,...(prior.runtime?.grokBinary?{grokBinary:prior.runtime.grokBinary,grokHash:prior.runtime.grokHash}:{}),...grokRuntime}});
 const active=await loadActive();await supervisor.start(before,active.revision);stopped=false;
 console.log(JSON.stringify({installed:true,backup,policy:'isolated development; reviewed source application when enabled; no deployment'}));
}catch(e){
 if(mutated){for(const t of targets){await fs.rm(t.target,{recursive:true,force:true});if(t.exists)await fs.cp(path.join(backup,t.name),t.target,{recursive:true});}}
 if(stopped&&before){const active=await loadActive();await supervisor.start(before,active.revision);}
 throw e;
}finally{await fs.rm(drain,{force:true});await unlock();}
