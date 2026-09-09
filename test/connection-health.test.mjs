import test from 'node:test';
import assert from 'node:assert/strict';
import {decision} from '../src/connection-health.mjs';
const down={loaded:true,localOK:true,connections:0,publicOK:false,maintenance:false};
test('reconnect only after sustained disconnection, with cooldown and hourly limit',()=>{
 let state={};for(let i=0;i<2;i++){state=decision(down,state,1000000+i*60000);assert.equal(state.action,'wait');}
 state=decision(down,state,1120000);assert.equal(state.action,'restart-tunnel');
 assert.equal(decision(down,state,1180000).action,'wait');
 assert.equal(decision(down,{failures:5,attempts:[800000,900000,1000000]},1500000).action,'wait');
 assert.equal(decision(down,{},1000000,true).action,'restart-tunnel');
});
test('never restart stopped, maintenance, busy-origin or healthy tunnel due to public probe alone',()=>{
 for(const change of [{loaded:false},{maintenance:true},{localOK:false},{connections:4},{connections:null}])assert.equal(decision({...down,...change},{failures:9},1000000,true).action,'skip');
 assert.equal(decision({...down,connections:0,publicOK:true},{failures:9},1000000).action,'healthy');
});
