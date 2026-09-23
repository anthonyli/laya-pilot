import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../lib/engine.mjs';
import {waitForReady} from '../lib/readiness.mjs';
import {describe,expectation} from '../lib/language.mjs';

test('Repeated same-page navigation waits again but does not reload',async()=>{
 let current='about:blank',navigations=0,waits=0;
 const page={on(){},url:()=>current,async goto(url){current=url;navigations++;}};
 const engine=new Engine(page,null,{url:'http://example.test/list',origins:['http://example.test']});engine.ready=async()=>{waits++;};
 await engine.navigate('http://example.test/list');await engine.navigate('http://example.test/list');await engine.navigate('http://example.test/list');
 assert.equal(navigations,1);assert.equal(waits,3);
 await engine.navigate('http://example.test/list',{force:true});assert.equal(navigations,2);
});

test('Per-case reset preserves same-module query state instead of reloading',async()=>{
 let navigations=0;
 const page={on(){},url:()=> 'http://example.test/list?currentTab=2',frames:()=>[],async goto(){navigations++;}};
 const engine=new Engine(page,null,{url:'http://example.test/list',origins:['http://example.test']});
 engine.ready=async()=>{};
 await engine.resetCase('http://example.test/list');
 assert.equal(navigations,0);
 assert.deepEqual(engine.baselines.get('http://example.test/list'),[]);
});

test('Blank and loading application states are not treated as ready',async()=>{
 const queue=[{controls:0,busy:false,signature:''},{controls:4,busy:true,signature:'shell'},{controls:8,busy:false,signature:'app'}];let reads=0;
 const page={frames:()=>[{evaluate:async()=>{reads++;return queue.shift()||{controls:8,busy:false,signature:'app'};}}],waitForTimeout:async()=>new Promise(r=>setTimeout(r,1))};
 await waitForReady(page,{timeout:100,minimum:0});assert.equal(reads,3);
 const blank={frames:()=>[{evaluate:async()=>({controls:0,busy:false,signature:''})}],waitForTimeout:page.waitForTimeout};
 await assert.rejects(waitForReady(blank,{timeout:15,minimum:0}),/仍为空白或加载中/);
});

test('Critical resource errors stop waiting instead of triggering refresh loops',async()=>{
 const page={frames:()=>[{evaluate:async()=>({controls:4,busy:true,signature:'shell'})}]};
 await assert.rejects(waitForReady(page,{failures:()=>[{path:'/app/index.html',status:502,resourceType:'document'}]}),/HTTP 502/);
});

test('Unrelated resource failure does not block a rendered idle page',async()=>{
 const page={frames:()=>[{evaluate:async()=>({controls:8,busy:false,signature:'app'})}],waitForTimeout:async()=>{}};
 const ready=await waitForReady(page,{minimum:0,failures:()=>[{path:'/other/index.html',status:502,resourceType:'fetch'}]});
 assert.equal(ready.controls,8);
});

test('Enter-menu instructions and state-list expectations are interpreted generically',()=>{
 assert.deepEqual(describe('进入客户列表页'),{verb:'path',path:['客户']});
 assert.deepEqual(describe('进入业务中心 > 商品页面'),{verb:'path',path:['业务中心','商品']});
 assert.deepEqual(expectation('运行区不展示状态筛选条件'),{kind:'fieldAbsent',scope:'运行区',target:'状态'});
 assert.equal(expectation('列表仅展示已保存状态的类集数据').kind,'columnValues');
});
