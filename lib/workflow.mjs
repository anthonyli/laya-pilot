import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Laya} from './model.mjs';
import {openBrowser} from './browser-provider.mjs';
import {observe,discoverRowLabels,settle} from './dom.mjs';
import {waitForReady,switchLanguage} from './readiness.mjs';
import {BrowserDiagnostics,diagnoseFailure,eventLabel,severeEvent,safeText} from './diagnostics.mjs';
import {inspectForm,findFormItem,inspectLooseRequired,formErrors,visibleOptions,generatedInputValue,invalidExampleValue} from './form.mjs';

const LIVE_REF='data-laya-live-ref';
const actions={
 create:/新增|新建|创建|添加|\badd\b|\bnew\b|\bcreate\b/i,
 search:/搜索|查询|查找|\bsearch\b|\bquery\b|\bfind\b/i,
 view:/查看|详情|\bview\b|\bdetail\b|图标[:：]\s*profile/i,
 edit:/编辑|修改|\bedit\b|\bupdate\b|图标[:：]\s*form/i,
 delete:/删除|移除|\bdelete\b|\bremove\b/i,
 save:/保存|提交|\bsave\b|\bsubmit\b/i,
 confirm:/^(确定|确认|是|确认删除|删除|delete|confirm|yes)$/i,
 close:/^(取消|关闭|close|cancel)$/i,
 more:/更多|\bmore\b|图标[:：]\s*more/i,
 area:/编辑区|编辑区域|草稿区|\bdraft\b|\bedit area\b/i,
 tab:/./,
};
const nameField=/名称|姓名|标题|name|title/i;
const isAction=c=>['button','link','menuitem'].includes(c.role)&&!c.disabled&&c.name.length>0&&c.name.length<=50;
const safeKey=s=>s.replace(/[^a-z0-9_-]/gi,'-').replace(/-+/g,'-').slice(0,85);
const ownName=()=>`LayaAuto_${Date.now()}_${randomBytes(3).toString('hex')}`;
const controlInfo=c=>({name:c.name,role:c.role,scope:c.scope||'page'});
const message=e=>safeText(e?.message||String(e),1200);

export function validateWorkflow(file){
 if(file?.schemaVersion!==1||!Array.isArray(file.cases)||!file.cases.length)throw Error('用例文件没有可执行的已验证用例');
 if(!file.moduleUrl||!/^https?:\/\//.test(file.moduleUrl))throw Error('用例文件缺少有效页面地址');
 const allowed=new Set(['click','fill','form-fill','form-fill-required','form-select','assert-form-errors','assert-input-invalid','assert-row','assert-absent','assert-text','assert-control','assert-selected','assert-headers','reload']);
 for(const c of file.cases){
  if(!['tabs','tab-switch','table','filters','form-validation','form-invalid','create','search','view','edit','delete'].includes(c.operation)||!Array.isArray(c.steps)||!c.steps.length)throw Error('用例包含不支持的操作：'+c.id);
  for(const step of c.steps){
   if(!allowed.has(step.kind))throw Error('用例包含不支持的步骤：'+step.kind);
   if(['click','fill'].includes(step.kind)&&(!step.target?.name||!step.target?.role))throw Error('用例步骤缺少控件名称和角色');
   if(step.kind==='form-fill'&&(!step.target?.label||!Number.isInteger(step.target.index)||step.target.index<0||typeof step.value!=='string'))throw Error('表单填写步骤缺少字段、序号或值');
   if(step.kind==='form-fill-required'&&(!Number.isInteger(step.target?.index)||step.target.index<0||typeof step.target.placeholder!=='string'||typeof step.value!=='string'))throw Error('必填输入步骤缺少提示、序号或值');
   if(step.kind==='form-select'&&(!step.target?.label||!Array.isArray(step.path)||!step.path.length||step.path.some(x=>typeof x!=='string'||!x)))throw Error('表单选择步骤缺少字段或选项路径');
   if(step.kind==='assert-form-errors'&&(!Array.isArray(step.value)||!step.value.length||step.value.some(x=>typeof x!=='string')))throw Error('表单校验步骤缺少已验证错误字段');
   if(step.kind==='assert-input-invalid'&&(!Number.isInteger(step.target?.index)||step.target.index<0||typeof step.target.placeholder!=='string'))throw Error('格式校验步骤缺少目标输入框');
   if(step.target?.scope==='owned-row'&&!['view','edit','delete'].includes(c.operation))throw Error('独立记录操作不属于查看、修改或删除用例');
   if(step.kind==='click'){
    const purpose=step.purpose;
    if(!actions[purpose]?.test(step.target.name))throw Error('点击步骤与其操作意图不一致：'+step.target.name);
   if(purpose==='tab'&&step.target.role!=='tab')throw Error('Tab切换只能使用页面Tab控件');
   if(purpose==='confirm'&&step.target.role!=='button')throw Error('确认操作只能点击确认按钮');
    if(['view','edit','delete','more'].includes(purpose)&&step.target.scope!=='owned-row')throw Error('查看、修改和删除只能定位本轮独立记录');
    if(purpose==='delete'&&c.operation!=='delete'||purpose==='edit'&&c.operation!=='edit'||purpose==='create'&&!['create','form-validation','form-invalid'].includes(c.operation)||purpose==='confirm'&&c.operation!=='delete')throw Error('用例操作顺序不受支持');
   }
   if(c.operation==='form-validation'&&['form-fill','form-fill-required','form-select'].includes(step.kind))throw Error('空表单校验用例不能填入数据');
  }
 }
 return file;
}

class Workflow {
 constructor(page,laya,config,mode,diagnostics){this.page=page;this.laya=laya;this.config=config;this.mode=mode;this.diagnostics=diagnostics;this.variables={recordName:ownName()};this.variables.updatedName=this.variables.recordName+'_edited';this.log=[];this.created=false;this.currentName=this.variables.recordName;}
 resolve(value){
  if(typeof value==='object'&&value?.fixture){if(!Object.hasOwn(this.config.data,value.fixture))throw Error('执行需要 --data 中的字段：'+value.fixture);return String(this.config.data[value.fixture]);}
  if(typeof value!=='string')throw Error('用例值格式不受支持');
  return value.replace(/\$\{([^}]+)\}/g,(_,key)=>{if(!Object.hasOwn(this.variables,key))throw Error('未知数据变量：'+key);return this.variables[key];});
 }
 async snapshot(){return observe(this.page);}
 async chooseFromSnapshot(snap,candidates,purpose){
  if(!candidates.length)throw Error('页面上没有可操作的'+purpose+'控件');
  // A single role/name match has no ambiguity for the model to resolve. Laya
  // decides between competing live candidates; assertions remain deterministic.
  if(candidates.length===1){
   const control=candidates[0],locator=snap.frames[control.frame].locator(`[${LIVE_REF}="${control.ref}"]`);
   if(await locator.count()!==1||!await locator.isVisible())throw Error('决策后页面控件已变化：'+purpose);
   return {control,locator};
  }
  const shortlist=candidates.slice(0,7),criteria={},byChoice=new Map();
  shortlist.forEach((c,i)=>{const key=shortlist.filter(x=>x.name===c.name).length===1?c.name:`${c.name} [${c.context.slice(0,25)||c.role}] ${i+1}`;criteria[key]=`${purpose}时操作页面上的「${c.name}」${c.context?'，属于 '+c.context.slice(0,65):''}`;byChoice.set(key,c);});
  criteria['无法判断']='页面控件与本次操作不匹配，不执行';
  const result=await this.laya.choose(`要${purpose}，应选择哪个页面控件？`,criteria,{mode:this.mode,purpose,url:snap.url,candidates:shortlist.map(({ref,...c})=>c)});
  const control=byChoice.get(result.choice);
  if(!control)throw Error('Laya未能确定'+purpose+'控件');
  if((result.probabilities?.[result.choice]||0)<this.config.minProbability||result.margin<this.config.minMargin)throw Error('Laya选择'+purpose+'控件的把握不足');
  const locator=snap.frames[control.frame].locator(`[${LIVE_REF}="${control.ref}"]`);
  if(await locator.count()!==1||!await locator.isVisible())throw Error('决策后页面控件已变化：'+purpose);
  return {control,locator};
 }
 async action(op,{rowName,optional=false}={}){
  let snap=await this.snapshot();
  if(rowName){
   const key=snap.controls.find(c=>c.rowKey&&c.context.includes(rowName))?.rowKey;
   if(key)snap=await discoverRowLabels(this.page,key);
  }
  const matching=()=>snap.controls.filter(c=>(op==='area'?c.role==='tab'&&!c.disabled:isAction(c))&&actions[op].test(c.name)&&(op!=='confirm'||c.role==='button')&&(!rowName||c.context.includes(rowName)));
  let candidates=matching();
  if(!candidates.length&&rowName&&['edit','delete','view'].includes(op)){
   const more=snap.controls.filter(c=>isAction(c)&&actions.more.test(c.name)&&c.context.includes(rowName));
   if(more.length){const opened=await this.chooseFromSnapshot(snap,more,'展开本轮独立记录的更多操作');await opened.locator.click();await settle(this.page,100);this.record({kind:'click',target:{...controlInfo(opened.control),scope:'owned-row'},purpose:'more'});snap=await this.snapshot();candidates=snap.controls.filter(c=>isAction(c)&&actions[op].test(c.name));}
  }
  if(!candidates.length&&optional)return null;
  const selected=await this.chooseFromSnapshot(snap,candidates,({area:'进入可编辑区域',create:'创建独立记录',search:'搜索记录',view:'查看独立记录',edit:'修改独立记录',delete:'删除独立记录',save:'保存表单',confirm:'确认删除',close:'关闭详情'})[op]);
  const scope=rowName?'owned-row':op==='save'||op==='confirm'||op==='close'?'form':'page';
  return {...selected,step:{kind:'click',target:{...controlInfo(selected.control),scope},purpose:op}};
 }
 async click(op,options){const found=await this.action(op,options);if(!found)return null;await found.locator.click();this.record(found.step);await settle(this.page,120);return found.step;}
 async field(purpose,{name}={}){
  const snap=await this.snapshot();const fields=snap.controls.filter(c=>['textbox','spinbutton'].includes(c.role)&&!c.disabled&&!c.readonly);
  const matches=fields.filter(c=>name?c.name===name:nameField.test(c.name));
  return this.chooseFromSnapshot(snap,matches,purpose);
 }
 record(step){if(this.case)this.case.steps.push(step);this.log.push({at:new Date().toISOString(),step,url:this.page.url()});}
 async fill(field,value,scope='form'){
  const actual=this.resolve(value);await field.locator.fill(actual);
  if(await field.locator.inputValue()!==actual)throw Error('输入值没有进入'+field.control.name);
  this.record({kind:'fill',target:{...controlInfo(field.control),scope},value});await settle(this.page,80);
 }
 async formFill(label,index,value){
  const {item}=await findFormItem(this.page,label);
  const inputs=item.locator('input:not([type="hidden"]):not([type="search"]):visible,textarea:visible');
  if(await inputs.count()<=index)throw Error(`表单「${label}」第${index+1}个输入框已变化`);
  const input=inputs.nth(index),actual=this.resolve(value);
  if(!await input.isEditable())throw Error(`表单「${label}」第${index+1}个输入框不可编辑`);
  await input.fill(actual);
  if(await input.inputValue()!==actual)throw Error(`表单「${label}」的输入值未生效`);
  this.record({kind:'form-fill',target:{label,index},value});await settle(this.page,90);
 }
 async looseInput(placeholder,index){
  const root=this.page.locator('dialog[open]:visible,[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content:visible,.el-dialog:visible').last();
  const inputs=root.locator('input[aria-required="true"]:visible,textarea[aria-required="true"]:visible');
  const matches=[];for(let i=0;i<await inputs.count();i++)if((await inputs.nth(i).getAttribute('placeholder')||'')===placeholder)matches.push(inputs.nth(i));
  if(matches.length<=index)throw Error(`必填输入框「${placeholder}」第${index+1}项已变化`);
  return matches[index];
 }
 async formFillRequired(placeholder,index,value){
  const input=await this.looseInput(placeholder,index),actual=this.resolve(value);
  if(!await input.isEditable())throw Error(`必填输入框「${placeholder}」不可编辑`);
  await input.fill(actual);if(await input.inputValue()!==actual)throw Error(`必填输入框「${placeholder}」输入值未生效`);
  this.record({kind:'form-fill-required',target:{placeholder,index},value});await settle(this.page,90);
 }
 async assertInputInvalid(placeholder,index){
  const input=await this.looseInput(placeholder,index);
  const invalid=await input.evaluate(e=>e.getAttribute('aria-invalid')==='true'||!!e.closest('.ant-form-item-has-error,.has-error,.is-error'));
  if(!invalid)throw Error(`「${placeholder}」非法格式未显示字段校验错误`);
  this.record({kind:'assert-input-invalid',target:{placeholder,index}});
 }
 async formSelect(label,savedPath){
  const {item}=await findFormItem(this.page,label);
  const control=item.locator('[role="combobox"]:visible,select:visible').first();
  if(await control.count()!==1)throw Error('「'+label+'」没有可识别的下拉或树选择控件');
  await control.click();await settle(this.page,120);
  const path=[],seen=new Set(),max=savedPath?.length||5;
  for(let depth=0;depth<max;depth++){
   const options=(await visibleOptions(this.page)).filter(x=>!seen.has(x.name)&&!/^(全部|所有|请选择|无)$/.test(x.name));
   const choice=savedPath?.[depth]||options.find(x=>x.numeric)?.name||options.find(x=>x.treeItem)?.name||options.find(x=>x.role==='option'||x.role==='treeitem')?.name||options[0]?.name;
   if(!choice||!options.some(x=>x.name===choice))throw Error(`「${label}」没有可用的${savedPath?'指定':'可选'}选项：${choice||'空'}`);
   const selected=options.find(x=>x.name===choice),match=this.page.locator(`[data-laya-option-ref="${selected.ref}"]`);
   if(await match.count()!==1||!await match.isVisible())throw Error(`「${label}」选项在点击前已变化：${choice}`);
   await match.click();path.push(choice);seen.add(choice);await settle(this.page,130);
   if(savedPath)continue;
   const current=(await findFormItem(this.page,label)).info;
   const shown=current.sectionText.replace(current.label,'').trim();
   if(current.chosen||shown===choice)break;
  }
  if(!path.length)throw Error('「'+label+'」未选中任何选项');
  const header=this.page.locator('.ant-drawer-title:visible,.el-dialog__title:visible,[role="dialog"] h2:visible');
  if(await header.count())await header.last().click().catch(()=>{});
  this.record({kind:'form-select',target:{label},path});
  return path;
 }
 async populateForm(nameLabel){
  const fields=(await inspectForm(this.page)).filter(x=>x.required&&x.label!==nameLabel);
  for(const original of fields){
   const {info}=await findFormItem(this.page,original.label);
   if(info.combo){if(!info.chosen)await this.formSelect(info.label);continue;}
   const editable=info.inputs.filter(x=>!x.readonly&&x.type!=='search');
   if(!editable.length)continue;
   for(let index=0;index<editable.length;index++){
    if(editable[index].value)continue;
    const value=Object.hasOwn(this.config.data,info.label)?String(this.config.data[info.label]):generatedInputValue(info.label,editable[index].placeholder,editable[index].role,'${recordName}',index);
    await this.formFill(info.label,index,value);
   }
  }
  for(const input of await inspectLooseRequired(this.page)){
   if(input.value)continue;
   const value=generatedInputValue(input.placeholder,input.placeholder,input.role,'${recordName}',input.index);
   await this.formFillRequired(input.placeholder,input.index,value);
  }
 }
 async assertFormErrors(labels){
  const actual=await formErrors(this.page);
  if(!actual.open||!actual.labels.length)throw Error('空表单保存后未出现可识别的字段校验错误');
  if(labels?.length){const missing=labels.filter(x=>!actual.labels.includes(x));if(missing.length)throw Error('缺少原先观察到的必填错误字段：'+missing.join('、'));}
  this.record({kind:'assert-form-errors',value:actual.labels});
  return actual;
 }
 async row(value,present=true){
  const name=this.resolve(value),rows=this.page.locator('table tbody tr:visible,[role="rowgroup"] [role="row"]:visible').filter({hasText:name});
  if(present)await rows.first().waitFor({timeout:this.config.assertTimeout});
  else await rows.first().waitFor({state:'hidden',timeout:this.config.assertTimeout});
  const count=await rows.count();
  if(present&&count<1||!present&&count>0)throw Error(`列表${present?'没有':'仍有'}独立记录：${name}`);
  this.record({kind:present?'assert-row':'assert-absent',value});
 }
 async query(value,{assert=true}={}){
  const search=await this.field('按名称查询独立记录');await this.fill(search,value,'page');
  const button=await this.action('search',{optional:true});if(button){await button.locator.click();this.record(button.step);await settle(this.page,180);}
  if(assert)await this.row(value,true);
 }
 async reload(){await this.page.reload({waitUntil:'domcontentloaded'});await waitForReady(this.page,{timeout:this.config.pageTimeout});this.record({kind:'reload'});}
 async assertControl(role,name,selected=false){
  const snap=await this.snapshot(),matches=snap.controls.filter(c=>c.role===role&&c.name===name&&!c.disabled);
  if(matches.length!==1)throw Error(`页面中的「${name}」${role}控件数量为${matches.length}，不能明确断言`);
  if(selected&&!matches[0].selected)throw Error(`「${name}」Tab没有选中`);
  this.record({kind:selected?'assert-selected':'assert-control',target:{role,name}});
 }
 async assertHeaders(headers){
  const visible=[...new Set((await this.page.locator('table:visible thead th:visible').allTextContents()).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean))];
  const missing=headers.filter(x=>!visible.includes(x));
  if(missing.length)throw Error('列表缺少列头：'+missing.join('、'));
  this.record({kind:'assert-headers',value:headers});
 }
 async clickTab(name){
  const snap=await this.snapshot(),matches=snap.controls.filter(c=>c.role==='tab'&&c.name===name&&!c.disabled);
  const found=await this.chooseFromSnapshot(snap,matches,'切换到「'+name+'」Tab');
  await found.locator.click();this.record({kind:'click',target:{...controlInfo(found.control),scope:'page'},purpose:'tab'});await settle(this.page,180);
 }
 async runCase(id,title,operation,fn){
  const c={id,title,operation,steps:[],status:'生成中',reason:'',evidence:''};this.case=c;
  this.diagnostics.begin(id);
  try{await fn();c.status='已验证';c.reason='生成时已实际执行并通过页面断言';}
  catch(e){c.status='未生成';c.reason=message(e);}
  c.evidence=`evidence/${id}.png`;
  await this.page.screenshot({path:path.join(this.config.out,c.evidence),timeout:5000}).catch(()=>{c.evidence='';});
  await this.page.waitForTimeout(150).catch(()=>{});
  c.browserEvents=await this.diagnostics.end();
  const severe=severeEvent(c.browserEvents);
  if(c.status==='已验证'&&severe){c.status='未生成';c.reason='页面断言通过，但本用例期间发现 '+eventLabel(severe);}
  c.diagnosis=c.status==='未生成'?diagnoseFailure(c.reason,c.browserEvents):null;
  this.case=null;return c;
 }
 async generate(){
  const results=[],add=async(...args)=>{const r=await this.runCase(...args);results.push(r);console.log(`${r.status} ${r.id}: ${r.reason}`);return r.status==='已验证';};
  const initial=await this.snapshot(),tabs=initial.controls.filter(c=>c.role==='tab'&&c.name&&c.name.length<=30),selectedTab=tabs.find(c=>c.selected)?.name;
  if(tabs.length>=2){
   await add('tabs','页签入口可见','tabs',async()=>{for(const tab of tabs.slice(0,4))await this.assertControl('tab',tab.name);});
   if(selectedTab)await add('tab-switch','页签切换后可见并可切回','tab-switch',async()=>{
    const other=tabs.find(c=>c.name!==selectedTab);await this.clickTab(other.name);await this.assertControl('tab',other.name,true);
    await this.clickTab(selectedTab);await this.assertControl('tab',selectedTab,true);
   });
  }
  const headers=[...new Set((await this.page.locator('table:visible thead th:visible').allTextContents()).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean))].slice(0,20);
  if(headers.length>=2)await add('table','列表列头可见','table',async()=>{await this.assertHeaders(headers);});
  const filterSnap=await this.snapshot(),nameFilter=filterSnap.controls.find(c=>c.role==='textbox'&&nameField.test(c.name)),search=filterSnap.controls.find(c=>isAction(c)&&actions.search.test(c.name)),reset=filterSnap.controls.find(c=>isAction(c)&&/^(重置|reset)$/i.test(c.name));
  if(nameFilter&&search&&reset)await add('filters','名称筛选控件可见','filters',async()=>{
   await this.assertControl(nameFilter.role,nameFilter.name);await this.assertControl(search.role,search.name);await this.assertControl(reset.role,reset.name);
  });
  await add('form-validation','新增表单必填项为空时阻止保存','form-validation',async()=>{
   const snap=await this.snapshot();if(!snap.controls.some(c=>isAction(c)&&actions.create.test(c.name)))await this.click('area');
   await this.click('create');await this.click('save');await this.assertFormErrors();await this.click('close');
  });
  await add('form-invalid','数值区间示例的非法括号触发校验','form-invalid',async()=>{
   await this.click('create');
   try{
    const name=await this.field('填写校验记录名称');await this.fill(name,'${recordName}_invalid');
    await this.populateForm('名称');
    const target=(await inspectLooseRequired(this.page)).find(x=>invalidExampleValue(x.placeholder));
    if(!target)throw Error('页面没有带区间示例的必填输入框，无法生成格式校验');
    await this.formFillRequired(target.placeholder,target.index,invalidExampleValue(target.placeholder));
    await this.click('save');await this.assertInputInvalid(target.placeholder,target.index);
   }finally{if((await formErrors(this.page)).open)await this.click('close').catch(()=>{});}
  });
  const created=await add('create','新增独立测试记录','create',async()=>{
   let snap=await this.snapshot();
   if(!snap.controls.some(c=>isAction(c)&&actions.create.test(c.name))){await this.click('area');snap=await this.snapshot();}
   await this.click('create');const name=await this.field('填写新记录名称');await this.fill(name,'${recordName}');
   await this.populateForm('名称');await this.click('save');await this.reload();await this.query('${recordName}');this.created=true;
  });
  if(created){
   await add('search','按名称查询刚创建的记录','search',async()=>{await this.query('${recordName}');});
   await add('view','查看独立测试记录','view',async()=>{
    if(!await this.click('view',{rowName:this.currentName,optional:true}))throw Error('列表没有可识别的查看详情入口');
    await this.page.locator('dialog[open]:visible,[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content:visible').last().getByText(this.currentName,{exact:false}).first().waitFor({timeout:this.config.assertTimeout});
    this.record({kind:'assert-text',value:'${recordName}',scope:'form'});
    await this.click('close');
   });
   const edited=await add('edit','修改独立测试记录名称','edit',async()=>{
    await this.query('${recordName}');await this.click('edit',{rowName:this.currentName});
    const field=await this.field('修改记录名称');await this.fill(field,'${updatedName}');await this.click('save');
    await this.reload();await this.query('${updatedName}');this.currentName=this.variables.updatedName;
   });
   if(edited)await add('delete','删除独立测试记录','delete',async()=>{
    await this.query('${updatedName}');await this.click('delete',{rowName:this.currentName});
    const dialog=this.page.locator('dialog[open]:visible,[role="dialog"]:visible,.ant-popover:visible');
    if(await dialog.count())await this.click('confirm');
    await this.reload();await this.query('${updatedName}',{assert:false});await this.row('${updatedName}',false);
   });
  }
  return results;
 }
 async replayStep(step){
  if(step.kind==='assert-control'||step.kind==='assert-selected')return this.assertControl(step.target.role,step.target.name,step.kind==='assert-selected');
  if(step.kind==='assert-headers')return this.assertHeaders(step.value);
  if(step.kind==='assert-form-errors')return this.assertFormErrors(step.value);
  if(step.kind==='assert-input-invalid')return this.assertInputInvalid(step.target.placeholder,step.target.index);
  if(step.kind==='form-fill')return this.formFill(step.target.label,step.target.index,step.value);
  if(step.kind==='form-fill-required')return this.formFillRequired(step.target.placeholder,step.target.index,step.value);
  if(step.kind==='form-select')return this.formSelect(step.target.label,step.path);
  if(step.kind==='reload')return this.reload();
  if(step.kind==='assert-row'||step.kind==='assert-absent')return this.row(step.value,step.kind==='assert-row');
  if(step.kind==='assert-text'){
   const text=this.resolve(step.value),root=step.scope==='form'?this.page.locator('dialog[open]:visible,[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content:visible').last():this.page.locator('body');
   await root.getByText(text,{exact:false}).first().waitFor({timeout:this.config.assertTimeout});this.record(step);return;
  }
  const target=step.target;
  const rowMenu=target.scope==='owned-row'&&target.role==='menuitem'&&this.case?.steps.at(-1)?.purpose==='more'&&this.case.steps.at(-1).target?.scope==='owned-row';
  if(target.scope==='owned-row'){
   if(!this.created)throw Error('尚未创建本轮独立记录，不能修改或删除');
   const rows=this.page.locator('table tbody tr:visible').filter({hasText:this.currentName});
   if(!await rows.count())throw Error('找不到本轮独立记录：'+this.currentName);
  }
  let snap=await this.snapshot();
  if(target.scope==='owned-row'&&!rowMenu){
   const key=snap.controls.find(c=>c.rowKey&&c.context.includes(this.currentName))?.rowKey;
   if(key)snap=await discoverRowLabels(this.page,key);
  }
  const matches=snap.controls.filter(c=>c.name===target.name&&c.role===target.role&&!c.disabled&&!c.readonly&&(target.scope!=='owned-row'||rowMenu||c.context.includes(this.currentName)));
  const found=await this.chooseFromSnapshot(snap,matches,'复现「'+target.name+'」');
  if(step.kind==='fill')await found.locator.fill(this.resolve(step.value));
  else await found.locator.click();
  this.record(step);await settle(this.page,120);
 }
 async replay(file){
  const results=[];
  for(const saved of file.cases){
   const c={id:saved.id,title:saved.title,operation:saved.operation,status:'执行中',reason:'',steps:[],evidence:'',failedStep:null};this.case=c;
   this.diagnostics.begin(c.id);
   if(['search','view','edit','delete'].includes(saved.operation)&&!this.created){
    c.status='未执行（依赖阻断）';c.reason='新增用例未通过，本条所需的独立记录不存在';
   }else try{
    for(const [index,step] of saved.steps.entries()){
     c.failedStep={number:index+1,action:step.kind,target:step.target?.name||''};
     this.diagnostics.setStep(c.failedStep);
     await this.replayStep(step);
     c.failedStep=null;
     this.diagnostics.setStep(null);
    }
    c.status='通过';c.reason='全部记录步骤和断言已重新执行';
   }catch(e){c.status='失败';c.reason=message(e);}
   c.evidence=`evidence/${c.id}.png`;await this.page.screenshot({path:path.join(this.config.out,c.evidence),timeout:5000}).catch(()=>{c.evidence='';});
   await this.page.waitForTimeout(150).catch(()=>{});
   c.browserEvents=await this.diagnostics.end();
   const severe=severeEvent(c.browserEvents);
   if(c.status==='通过'&&severe){c.status='失败';c.reason='页面断言通过，但本用例期间发现 '+eventLabel(severe);}
   if(c.status==='失败'&&!c.failedStep&&severe?.step)c.failedStep=severe.step;
   c.diagnosis=c.status==='失败'?diagnoseFailure(c.reason,c.browserEvents):c.status==='未执行（依赖阻断）'?{category:'依赖阻断',assessment:'前置新增用例失败，本条没有执行浏览器步骤',primary:null,observed:[]}:null;
   if(c.status==='通过'&&saved.operation==='create')this.created=true;
   if(c.status==='通过'&&saved.operation==='edit')this.currentName=this.variables.updatedName;
   this.case=null;results.push(c);console.log(`${c.status} ${c.id}: ${c.reason}`);
  }
  return results;
 }
}

export async function runWorkflow(config,mode,readSecret,root){
 if(!['generate','execute'].includes(mode))throw Error('--mode 只支持 generate 或 execute');
 if(config.readOnly)throw Error('生成和回放模式需要创建本轮独立数据，不能与 --read-only 同用');
 if(config.manualLogin&&config.headless)throw Error('手动登录需要可见浏览器');
 let input=null;
 if(mode==='execute'){
  if(!config.caseFile)throw Error('执行模式请指定 --case-file 生成的 Excel 文件');
  input=validateWorkflow(await workbookCommand(config,'read',{path:path.resolve(config.caseFile)}));
 }
 const requested=config.url||(input?.moduleUrl||'');if(!requested)throw Error('请指定 --url 页面地址');
 const url=new URL(requested);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('页面地址必须是不含账号密码的 HTTP(S) URL');
 if(input&&new URL(input.moduleUrl).pathname!==url.pathname)throw Error('执行地址的路径与生成用例的模块不一致');
 await fs.mkdir(path.join(config.out,'evidence'),{recursive:true});
 const caseFile=path.resolve(config.caseFile||path.join(root,'generated-cases',safeKey(url.host+url.pathname)+'.xlsx'));
 if(path.extname(caseFile).toLowerCase()!=='.xlsx')throw Error('--case-file 必须是 .xlsx 文件');
 let apiKey=config.provider==='api'?await readSecret('API密钥','LAYA_API_KEY'):undefined;
 const laya=new Laya(config.python,path.join(root,'worker.py'),config.model,path.join(config.out,'decisions.ndjson'),{provider:config.provider,base:config.apiBase,model:config.apiModel,key:apiKey,timeout:config.apiTimeout});apiKey=null;
 let browser,context,page,diagnostics;
 try{
  console.log('模式：'+mode+'；Laya：'+config.provider+'；浏览器：'+(config.headless?'无头':'可见'));
  const loaded=await laya.request({action:'load'});console.log('Laya就绪 '+loaded.load_ms+'ms');
  ({browser,context,page}=await openBrowser(config));
  diagnostics=new BrowserDiagnostics(context);diagnostics.begin('startup');
  await page.goto(url.href,{waitUntil:'domcontentloaded'});await waitForReady(page,{timeout:config.pageTimeout});
  if(config.manualLogin){const rl=readline.createInterface({input:process.stdin,output:process.stdout});await rl.question('请在浏览器登录并打开目标模块，回车继续：');rl.close();if(mode==='execute'&&new URL(page.url()).pathname!==url.pathname)await page.goto(url.href,{waitUntil:'domcontentloaded'});}
  else if(config.user){
   const password=await readSecret();await page.locator('input[type="password"]:visible').first().waitFor({timeout:30000});
   await switchLanguage(page,config.language==='auto'?'zh-CN':config.language);
   const account=await (await import('./dom.mjs')).target(page,laya,'账号 Account Username',{kind:'fill',minProbability:config.minProbability,minMargin:config.minMargin});await account.locator.fill(config.user);
   const passwords=page.locator('input[type="password"]:visible');if(await passwords.count()!==1)throw Error('登录页密码框不唯一，请使用 --manual-login');await passwords.fill(password);
   const login=await (await import('./dom.mjs')).target(page,laya,'登录 Login Sign in',{minProbability:config.minProbability,minMargin:config.minMargin});await login.locator.click();await passwords.waitFor({state:'hidden',timeout:30000});
   if(new URL(page.url()).pathname!==url.pathname)await page.goto(url.href,{waitUntil:'domcontentloaded'});
  }
  if(await page.locator('input[type="password"]:visible').count())throw Error('仍在登录页，尚未进入目标模块');
  await waitForReady(page,{timeout:config.pageTimeout});
  const startupEvents=await diagnostics.end();
  await fs.writeFile(path.join(config.out,'启动浏览器事件.json'),JSON.stringify(startupEvents,null,2));
  const workflow=new Workflow(page,laya,config,mode,diagnostics);
  const currentUrl=new URL(page.url());currentUrl.search='';currentUrl.hash='';const moduleUrl=currentUrl.href;
  await context.tracing.start({screenshots:true,snapshots:true,sources:false});
  const results=mode==='generate'?await workflow.generate():await workflow.replay(input);
  await context.tracing.stop({path:path.join(config.out,'trace.zip')}).catch(async error=>{
   await fs.writeFile(path.join(config.out,'轨迹保存失败.json'),JSON.stringify({message:message(error)},null,2));
  });
  let savedCaseFile=null;
  if(mode==='generate'){
   const file={schemaVersion:1,generatedAt:new Date().toISOString(),moduleUrl,cases:results.filter(r=>r.status==='已验证').map(({status,reason,evidence,...c})=>c),coverage:results.map(({id,operation,status,reason})=>({id,operation,status,reason}))};
   if(file.cases.length){await fs.mkdir(path.dirname(caseFile),{recursive:true});await workbookCommand(config,'write',{path:caseFile,template:config.templateExcel,file});savedCaseFile=caseFile;}
  }else{
   await workbookCommand(config,'results',{path:path.resolve(config.caseFile),output:path.join(config.out,'执行结果.xlsx'),results});
   savedCaseFile=caseFile;
  }
  const summary={mode,provider:config.provider,moduleUrl,caseFile:savedCaseFile,runDataPrefix:workflow.variables.recordName,results,counts:Object.fromEntries([...new Set(results.map(r=>r.status))].map(s=>[s,results.filter(r=>r.status===s).length]))};
  await fs.writeFile(path.join(config.out,'results.json'),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(config.out,'browser-events.ndjson'),results.flatMap(r=>(r.browserEvents||[]).map(e=>JSON.stringify({caseId:r.id,...e}))).join('\n')+'\n');
  const clean=s=>String(s??'').replace(/[|\n\r]/g,' ').slice(0,420);
  const md=['# '+(mode==='generate'?'用例生成':'用例执行')+'结果','',`页面：${moduleUrl}`,`用例文件：${savedCaseFile||'未生成（无通过页面断言的流程）'}`,`模型：${config.provider}`,`本轮测试记录候选名称：${workflow.variables.recordName}`,'','|操作|结果|原因分类|失败步骤|执行错误|同期证据|','|---|---|---|---|---|---|',...results.map(r=>`|${clean(r.title)}|${r.status}|${clean(r.diagnosis?.category)}|${r.failedStep?.number||''}|${clean(r.reason)}|${clean(r.diagnosis?.primary||r.browserEvents?.map(eventLabel).join('；'))}|`)];
  await fs.writeFile(path.join(config.out,'报告.md'),md.join('\n')+'\n');
  console.log('RESULT '+JSON.stringify({mode,caseFile:savedCaseFile,directory:config.out,counts:summary.counts}));
  if(config.keepOpen&&!config.headless){console.log('浏览器保持打开；关闭窗口即可结束。');await new Promise(resolve=>browser.on('disconnected',resolve));}
  return summary;
 }catch(error){
  if(diagnostics?.active){
   const events=await diagnostics.end();
   await fs.writeFile(path.join(config.out,'启动浏览器事件.json'),JSON.stringify(events,null,2)).catch(()=>{});
  }
  throw error;
 }finally{laya.close();await browser?.close().catch(()=>{});}
}

function workbookCommand(config,command,payload){
 return new Promise((resolve,reject)=>{
  const child=spawn(config.python,[new URL('./workflow_excel.py',import.meta.url).pathname,command],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.on('error',reject);child.on('close',code=>{
   if(code!==0){reject(Error('Excel '+command+' 失败：'+stderr.trim().slice(-1500)));return;}
   try{resolve(stdout.trim()?JSON.parse(stdout):null);}catch{reject(Error('Excel '+command+' 返回格式无效'));}
  });
  child.stdin.end(JSON.stringify(payload));
 });
}
