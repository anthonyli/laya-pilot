import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BrowserDiagnostics,diagnoseFailure,safeText,safeUrl,severeEvent} from '../lib/diagnostics.mjs';

test('browser and interface errors are attributed only to the active case',async()=>{
 const page=new EventEmitter(),context=new EventEmitter();context.pages=()=>[page];
 const log=new BrowserDiagnostics(context);
 const request={resourceType:()=> 'fetch',method:()=> 'POST',url:()=> 'https://example.test/api/save?token=secret'};
 log.begin('create');
 log.setStep({number:3,action:'click',target:'保存'});
 context.emit('request',request);
 log.setStep(null);
 context.emit('response',{status:()=>500,statusText:()=> 'Internal Server Error',request:()=>request,url:request.url,headers:()=>({'content-type':'application/json'}),text:async()=>'{"code":"SERVER_DOWN","message":"database unavailable"}'});
 page.emit('pageerror',new Error('Cannot read properties of undefined'));
 const first=await log.end();
 assert.deepEqual(first.map(x=>x.kind),['http','pageerror']);
 assert.equal(first[0].url,'https://example.test/api/save');
 assert.equal(first[0].step.number,3);
 assert.match(first[0].detail,/SERVER_DOWN.*database unavailable/);
 log.begin('search');
 assert.deepEqual(await log.end(),[]);
 assert.equal(diagnoseFailure('列表没有记录',first).category,'接口 HTTP 5xx');
});

test('network and browser failures take priority; secrets are not logged',()=>{
 const events=[{kind:'console',detail:'warning'},{kind:'requestfailed',method:'GET',url:'https://example.test/api/list',detail:'net::ERR_CONNECTION_REFUSED'}];
 assert.equal(severeEvent(events).kind,'requestfailed');
 assert.equal(diagnoseFailure('等待超时',events).category,'网络请求失败');
 assert.equal(diagnoseFailure('Target page has been closed',[{kind:'crash'}]).category,'浏览器异常');
 assert.equal(safeUrl('https://user:pass@example.test/list?api_key=secret#part'),'https://example.test/list');
 assert.ok(!safeText('Bearer abc123 password=guess sk-exampletoken').includes('abc123'));
 assert.ok(!safeText('Bearer abc123 password=guess sk-exampletoken').includes('guess'));
 assert.ok(!safeText('Bearer abc123 password=guess sk-exampletoken').includes('sk-exampletoken'));
});

test('navigation-cancelled requests are recorded without turning a passing case into failure',async()=>{
 const context=new EventEmitter();context.pages=()=>[];
 const log=new BrowserDiagnostics(context);log.begin('reload');
 const request={resourceType:()=> 'fetch',method:()=> 'GET',url:()=> 'https://example.test/api/poll?token=secret',failure:()=>({errorText:'net::ERR_ABORTED'})};
 context.emit('request',request);context.emit('requestfailed',request);
 const events=await log.end();
 assert.equal(events[0].kind,'requestcancelled');
 assert.equal(severeEvent(events),undefined);
});
