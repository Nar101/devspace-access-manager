import {Assistant} from './assistant.mjs';
const service=new Assistant();
const action=process.argv[2]||'status';
try{if(action==='login')console.log(await service.start(true));else if(action==='status')console.log(JSON.stringify(await service.snapshot(),null,2));else if(['start','stop','context-sync','repair','check-connection'].includes(action))console.log(await service.action(action));else throw new Error('Unknown action');}catch(e){console.error(e.message);process.exitCode=1;}
