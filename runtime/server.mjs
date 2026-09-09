import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {loadConfig} from '../app/node_modules/@waishnav/devspace/dist/config.js';
import {createServer} from '../app/node_modules/@waishnav/devspace/dist/server.js';
import {shutdownHttpServer} from '../app/node_modules/@waishnav/devspace/dist/server-shutdown.js';
import {createHook} from '../manager/runtime/access-hook.mjs';
import {createCLIClient,registerCLI} from '../manager/runtime/cli-client.mjs';
import {z} from '../app/node_modules/zod/index.js';
const base=path.resolve(new URL('..',import.meta.url).pathname);
// Keep the consumed, EOF-only stdin descriptor open. Closing fd 0 before
// attaching the private socket lets libuv reuse a standard descriptor internally.
const input=readFileSync(0);
const credentials=JSON.parse(input.toString('utf8'));input.fill(0);
const receipt=JSON.parse(readFileSync(path.join(base,'config/installation.json'),'utf8'));
const digest=createHash('sha256').update(readFileSync(path.join(base,'app/package-lock.json'))).digest('hex');
if(digest!==receipt.packageLockSha256||process.version!==receipt.nodeVersion)throw new Error('Runtime or dependency lock changed');
for(const [file,hash] of Object.entries(receipt.accessManager?.patchedHashes||{})){
  if(createHash('sha256').update(readFileSync(path.join(base,'app/node_modules/@waishnav/devspace/dist',file))).digest('hex')!==hash)
    throw new Error('DevSpace integration changed; restore the verified access-manager patch');
}
const dir=process.env.DEVSPACE_CONFIG_DIR;
const manifest=JSON.parse(readFileSync(path.join(dir,'manifest.json'),'utf8'));
for(const file of ['config.json','server.sb'])if(createHash('sha256').update(readFileSync(path.join(dir,file))).digest('hex')!==manifest.hashes[file])throw new Error('Access generation integrity mismatch');
if(typeof credentials.ownerToken!=='string'||credentials.ownerToken.length<40||typeof credentials.telemetryKey!=='string')throw new Error('Missing private startup credentials');
const config=loadConfig({...process.env,DEVSPACE_OAUTH_OWNER_TOKEN:credentials.ownerToken});
// Explicitly preserve an empty allowlist; upstream defaults must not grant cwd.
config.allowedRoots=manifest.grants.map(g=>g.path);
if(config.host!=='127.0.0.1'||config.port!==7676||config.toolMode!=='codex'||config.subagents.enabled||config.allowedHosts.includes('*'))throw new Error('Invalid deployment settings');
const cli=credentials.cliEnabled?createCLIClient(3,pid=>globalThis.__devspaceAccessHook.spawned(pid)):null;
globalThis.__devspaceAccessHook=createHook({manifest,key:credentials.telemetryKey,base,cli,registerCLI,z});
const {app,close}=createServer(config);
// Forwarded addresses are accepted only from the local reverse proxy, never trust-all.
app.set('trust proxy','loopback');
const server=app.listen(config.port,config.host,()=>console.log(JSON.stringify({event:'devspace_air_ready',generation:manifest.revision,roots:config.allowedRoots})));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;globalThis.__devspaceAccessHook.shutdown();await shutdownHttpServer(server,close);process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop().catch(e=>{console.error('Shutdown failed: '+e.message);process.exit(1);}));
