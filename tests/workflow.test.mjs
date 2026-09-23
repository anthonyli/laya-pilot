import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkflow} from '../lib/workflow.mjs';
import {generatedInputValue,invalidExampleValue} from '../lib/form.mjs';

const file=()=>({schemaVersion:1,moduleUrl:'http://127.0.0.1:8765/customers',cases:[{
 id:'delete',operation:'delete',steps:[
  {kind:'click',purpose:'delete',target:{name:'删除',role:'button',scope:'owned-row'}},
  {kind:'assert-absent',value:'${updatedName}'},
 ],
}]});

test('saved workflows accept only row-scoped deletion of the run-owned record',()=>{
 assert.equal(validateWorkflow(file()).cases.length,1);
 const changed=file();changed.cases[0].steps[0].target.scope='page';
 assert.throws(()=>validateWorkflow(changed),/本轮独立记录/);
});

test('saved workflows reject executable content outside the supported step grammar',()=>{
 const changed=file();changed.cases[0].steps.push({kind:'script',value:'alert(1)'});
 assert.throws(()=>validateWorkflow(changed),/不支持的步骤/);
});

test('generated form steps preserve discovered choices and reject incomplete validation recipes',()=>{
 const generated={schemaVersion:1,moduleUrl:'http://127.0.0.1:8765/customers',cases:[{
  id:'required',operation:'form-validation',steps:[
   {kind:'click',purpose:'create',target:{name:'新增',role:'button',scope:'page'}},
   {kind:'click',purpose:'save',target:{name:'保存',role:'button',scope:'form'}},
   {kind:'assert-form-errors',value:['客户名称']},
  ],
 }]};
 assert.equal(validateWorkflow(generated).cases.length,1);
 generated.cases[0].steps[2].value=[];
 assert.throws(()=>validateWorkflow(generated),/校验步骤/);
});

test('generated input values use visible interval examples and fresh-record variables',()=>{
 assert.equal(generatedInputValue('区间','数值区间, 例如[0, 100)','','${recordName}'),'[0, 100)');
 assert.equal(generatedInputValue('默认值','', '', '${recordName}'),'默认_${recordName}');
 assert.equal(invalidExampleValue('数值区间, 例如[0, 100)'),'【0, 100)');
 assert.equal(invalidExampleValue('普通文本'),null);
});
