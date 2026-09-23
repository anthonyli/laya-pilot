import test from 'node:test';
import assert from 'node:assert/strict';
import {expandStep,semanticStep,approvalOperation} from '../lib/planner.mjs';
import {Engine} from '../lib/engine.mjs';
import {Halt} from '../lib/language.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const controls=[{role:'tab',name:'编辑区'},{role:'tab',name:'运行区'},{role:'button',name:'重置'}];
test('Expand scope alternatives and row instructions without module-specific rules',()=>{
 assert.deepEqual(expandStep('切换到编辑区/运行区Tab',{controls,area:'运行区'}),[{verb:'click',target:'运行区'}]);
 assert.deepEqual(expandStep('切换到编辑区/运行区Tab',{controls}).map(s=>s.target),['编辑区','运行区']);
 assert.deepEqual(expandStep('在编辑区/运行区列表点击「测试」按钮',{controls}),[{verb:'click',target:'测试'}]);
 assert.equal(expandStep('在编辑区列表找到已上线状态的商品数据')[0].verb,'bindRow');
 assert.deepEqual(expandStep('点击清空/重置筛选按钮',{controls}),[{verb:'click',target:'重置'}]);
 assert.deepEqual(expandStep('鼠标悬浮在置灰的上线按钮上'),[{verb:'hover',target:'上线'}]);
});
test('Model fallback runs before declaring missing capability and cannot invent values',async()=>{
 let calls=0;
 const laya={choose:async(_,criteria)=>{calls++;assert.ok(criteria['缺少参数']);return {choice:'缺少参数',probabilities:{缺少参数:1},margin:1};}};
 await assert.rejects(semanticStep('输入正常名称',{controls:[]},laya),/需要补充通用工具或测试数据/);
 assert.equal(calls,1);
});
test('Approval-state inspection is not approval workflow execution',()=>{
 for(const title of ['上线待审核状态筛选','上线待审核状态-上线按钮置灰验证','下线待审核状态-删除按钮置灰验证'])assert.equal(approvalOperation({title,steps:'点击「状态」筛选\n查看按钮'}),false);
 assert.equal(approvalOperation({title:'审批开关',steps:'关闭审批开关'}),true);
 assert.equal(approvalOperation({title:'审批通过',steps:'进入审批中心'}),true);
});
test('Later unknown steps preserve earlier evidence and actually reach model fallback',async()=>{
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'laya-plan-'));
 try{
  await fs.mkdir(path.join(out,'evidence'));
  const page={on(){},frames:()=>[],url:()=> 'http://example.test',screenshot:async()=>{}};
  let calls=0;
  const model={choose:async()=>{calls++;return {choice:'缺少参数',probabilities:{缺少参数:1},margin:1};}};
  const engine=new Engine(page,model,{out,url:page.url(),data:{},maxSteps:25});
  engine.resetCase=async()=>{};engine.executeStep=async(text)=>{engine.events.push({phase:'step',action:'observe',text});};
  const result=await engine.runCase({id:'x',row:1,key:'x',title:'观察和填写',preconditions:'',steps:'查看页面\n输入正常名称',expected:'页面显示「完成」'});
  assert.equal(calls,1);assert.equal(result.actions.length,1);assert.equal(result.category,'执行能力不足');assert.equal(result.status,'部分执行（未完成）');
 }finally{await fs.rm(out,{recursive:true,force:true});}
});
test('Unproved prerequisites remain visible and never yield a passing case',async()=>{
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'laya-precondition-'));
 try{
  await fs.mkdir(path.join(out,'evidence'));
  const page={on(){},frames:()=>[],url:()=> 'http://example.test',screenshot:async()=>{}};
  const engine=new Engine(page,null,{out,url:page.url(),data:{},maxSteps:25});
  engine.resetCase=async()=>{};engine.executeStep=async text=>{engine.events.push({phase:'step',action:'observe',text});};
  engine.checkPrecondition=async()=>{throw new Halt('前置条件未验证','尚不能证明多版本前提');};
  engine.verify=async text=>({text,status:'通过'});
  const result=await engine.runCase({id:'x',row:1,key:'x',title:'观察',preconditions:'存在多版本',steps:'查看页面',expected:'页面显示「记录」'});
  assert.equal(result.status,'部分验证');assert.equal(result.precondition_checks[0].status,'待补证');assert.ok(result.assertions.some(a=>a.status==='未验证'));
 }finally{await fs.rm(out,{recursive:true,force:true});}
});
