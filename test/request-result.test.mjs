import test from 'node:test';
import assert from 'node:assert/strict';
import {requestOutcome} from '../context/watcher.mjs';
test('sync completion requires a successful exit and a completed matching report',()=>{
 assert.equal(requestOutcome(0,{request_id:'a',phase:'idle'},'a'),'done');
 assert.equal(requestOutcome(0,{request_id:'a',phase:'initializing'},'a'),null);
 assert.equal(requestOutcome(0,{request_id:'old',phase:'idle'},'a'),null);
 assert.equal(requestOutcome(null,{request_id:'a',phase:'idle'},'a'),'error');
 assert.equal(requestOutcome(null,{request_id:'a',phase:'initializing'},'a',true),'cancelled');
});
