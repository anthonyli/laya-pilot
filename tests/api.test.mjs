import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiDecision,decodeDecision,Laya} from '../lib/model.mjs';
const criteria={搜索:'点击搜索',停止:'不执行'};
const envelope=(answer={choice:'搜索',probabilities:{搜索:.9,停止:.1},confidence:.8})=>({choices:[{message:{content:JSON.stringify({latency_ms:50,result:{answers:{scenario:answer}}})}}]});
test('Compatible chat endpoint receives state/questions; parses real probabilities',async()=>{
 let seen;
 const api=new ApiDecision({base:'https://gateway.test/v1/',model:'decision-model',key:'test-secret',fetchImpl:async(url,options)=>{seen={url,options};return {ok:true,json:async()=>envelope()};}});
 const result=await api.decide('点击搜索',criteria);
 assert.equal(seen.url,'https://gateway.test/v1/chat/completions');
 const body=JSON.parse(seen.options.body),content=JSON.parse(body.messages[0].content);
 assert.deepEqual(content.questions.scenario.criteria,criteria);assert.equal(content.state,'点击搜索');
 assert.equal(body.model,'decision-model');assert.equal(seen.options.redirect,'error');
 assert.equal(result.choice,'搜索');assert.deepEqual(result.probabilities,{搜索:.9,停止:.1});
 assert.ok(!JSON.stringify(body).includes('test-secret'));
});
test('API rejects hallucinated targets, invented or malformed scores',()=>{
 for(const answer of [{choice:'删除',probabilities:{搜索:.9,停止:.1}},{choice:'搜索'}, {choice:'搜索',probabilities:{搜索:2,停止:0}},{choice:'搜索',probabilities:{搜索:.1,停止:.9}}])assert.throws(()=>decodeDecision(envelope(answer),criteria),/API/);
 assert.throws(()=>decodeDecision({choices:[{message:{content:'not json'}}]},criteria),/JSON/);
});
test('API fails closed on HTTP, timeout and redirects without echoing response',async()=>{
 const api=new ApiDecision({base:'https://gateway.test/v1',model:'decision-model',key:'test-secret',fetchImpl:async()=>({ok:false,status:401,text:async()=> 'test-secret'})});
 await assert.rejects(api.decide('点击搜索',criteria),e=>e.category==='模型API错误'&&e.message.includes('401')&&!e.message.includes('test-secret'));
 api.fetch=async()=>{throw Error('test-secret');};
 await assert.rejects(api.decide('点击搜索',criteria),e=>e.message.includes('未回退到本地')&&!e.message.includes('test-secret'));
 assert.throws(()=>new ApiDecision({base:'http://gateway.test/v1',key:'x'}),/HTTPS/);
});
test('API mode never sends load or decide to the Python model worker',async()=>{
 const client=Object.create(Laya.prototype);let calls=0;
 client.api={decide:async()=>{calls++;return {inference_ms:5};}};
 client.proc={stdin:{write(){throw Error('local model must not load');}}};
 await client.request({action:'load'});await client.request({action:'decide',state:'test',criteria});assert.equal(calls,2);
});
