import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../lib/engine.mjs';
const fakePage={on(){}};
test('Writes and confirmation cannot be smuggled through a read-only step',()=>{
 const read=new Engine(fakePage,null,{allowWrite:false});
 assert.throws(()=>read.guard({name:'保存'},'点击保存'),/只读/);
 assert.throws(()=>read.guard({name:'确认'},'点击确认'),/只读/);
 assert.doesNotThrow(()=>read.guard({name:'编辑区',role:'tab'},'切换到编辑区Tab'));
 assert.throws(()=>read.guard({name:'编辑',role:'button'},'点击编辑'),/只读/);
 const write=new Engine(fakePage,null,{allowWrite:true});
 assert.throws(()=>write.guard({name:'删除'},'查看记录'),/没有对应写入意图/);
 assert.doesNotThrow(()=>write.guard({name:'保存'},'点击保存'));
});
test('Enter is blocked before key dispatch when write operations are disabled',async()=>{
 let pressed=false,observed;
 const page={on(){},frames:()=>[],url:()=> 'http://example.test',keyboard:{async press(){pressed=true;}}};
 const model={async choose(state){observed=state;return {choice:'按键',probabilities:{按键:1},margin:1};}};
 const engine=new Engine(page,model,{allowWrite:false,maxSteps:25,minProbability:.68,minMargin:.18});
 await assert.rejects(engine.step('按下Enter'),/Enter可能提交/);
 assert.equal(pressed,false);assert.equal(observed,undefined);
});
