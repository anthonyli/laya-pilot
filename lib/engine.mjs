import fs from 'node:fs/promises';
import path from 'node:path';
import {Halt,expectation,lines,variables,parseData,norm,quoted} from './language.mjs';
import {observe,target,settle,assertionTarget,discoverRowLabels} from './dom.mjs';
import {waitForReady,readTables} from './readiness.mjs';
import {expandStep,semanticStep,scopeNames,approvalOperation} from './planner.mjs';
const writeName=/(?:删除|移除|保存|提交|新增|创建|修改|编辑|上线|下线|授权|发布|导入|发送|支付|购买|确定|确认|应用|delete|remove|save|submit|create|edit|publish|send|pay|buy|import|confirm|apply)/i;
export class Engine {
 constructor(page,laya,config){this.page=page;this.laya=laya;this.config=config;this.events=[];this.actions=0;this.current=null;this.failures=[];this.navigationCount=0;this.baselines=new Map();this.phase='setup';this.navFailureStart=0;this.dirtyAreas=new Map();
  page.on('response',r=>{if(r.status()>=400){const u=new URL(r.url());this.failures.push({case:this.current?.key,path:u.pathname,status:r.status(),resourceType:r.request().resourceType()});}});
 }
 async chooseTarget(name,kind='click',extras={}){const actual=this.config.labels?.[name]||name;if(actual!==name)console.log('  站点名称映射：'+name+' → '+actual);return target(this.page,this.laya,actual,{kind,meta:{case:this.current?.key,step:this.actions,original_target:name},minProbability:this.config.minProbability,minMargin:this.config.minMargin,...extras});}
 guard(control,step){
  if(control.role==='tab')return;
  if(!writeName.test(control.name))return;
  if(!this.config.allowWrite)throw new Halt('写入未启用',`当前为只读执行，步骤涉及“${control.name}”；在专用测试环境使用--allow-write才能执行。`);
  if(!writeName.test(step))throw new Halt('动作与用例不符','模型选择写入操作，但原始步骤没有对应写入意图。');
 }
 async directClick(name,step){
  await this.revealRowMenu(name);
  const rowKey=await this.targetRow(name);
  const found=await this.chooseTarget(name,'click',{rowKey});this.guard(found.control,step);
  if(this.pendingPreconditions?.length&&writeName.test(found.control.name)&&found.control.role!=='tab')throw new Halt('前置条件未验证','业务写入前仍有未证明的前提：'+this.pendingPreconditions.join('；'));
  if(found.control.href){const u=new URL(found.control.href,this.page.url());if(!this.config.origins.includes(u.origin))throw new Halt('目标地址超出测试范围','链接不属于本次配置的测试站点。');}
  console.log('  Laya → '+found.control.name+' ['+found.control.role+']');
  this.navFailureStart=this.failures.length;
  await found.locator.click();await settle(this.page,this.config.delay);await this.ready();return found.control;
 }
 async revealRowMenu(name){
  if(!this.rowKey)return;
  const snap=await observe(this.page);
  if(snap.controls.some(c=>norm(c.name)===norm(name)&&(c.rowKey||!['menuitem','option'].includes(c.role))))return;
  const more=snap.controls.filter(c=>c.rowKey===this.rowKey&&/^(?:图标:\s*more|更多|more)$/i.test(c.name));
  if(more.length!==1)return;
  // This menu is click-triggered. Merely hovering revealed transient content
  // that disappeared during model inference, causing repeated 9-second waits.
  const menuItem=snap.controls.find(c=>!c.rowKey&&norm(c.name)===norm(name)&&c.role==='menuitem');
  if(menuItem){
   const item=await assertionTarget(this.page,name,'visible');await item.locator.hover();return;
  }
  const found=await this.chooseTarget(more[0].name,'click',{rowKey:this.rowKey});
  await found.locator.click();await this.page.waitForTimeout(180);
  this.events.push({phase:this.phase,action:'open-menu',text:'展开当前记录的更多操作',rowKey:this.rowKey});
 }
 async targetRow(name){
  if(!this.rowKey)return undefined;
  const snap=await observe(this.page);
  // Dialog controls supersede the list-row binding. Exact global navigation
  // remains global; other operation buttons stay in the chosen record.
  if(!snap.controls.some(c=>c.rowKey===this.rowKey))return undefined;
  if(snap.controls.some(c=>!c.rowKey&&norm(c.name)===norm(name)))return undefined;
  return this.rowKey;
 }
 async bindRow(text){
  const snap=await observe(this.page),all=[...new Map(snap.controls.filter(c=>c.rowKey&&c.context).map(c=>[c.rowKey,c])).values()];
  const state=text.match(/(?:找到|存在)(.+?)状态/)?.[1];
  const quotedName=text.match(/名称(?:为|含)[「“"]([^」”"]+)[」”"]/)?.[1];
  const permission=text.includes('只读')?'只读':text.includes('读写')?'读写':null;
  const eligible=all.filter(c=>(!state||c.context.includes(state))&&(!quotedName||c.context.includes(quotedName))&&(!permission||c.context.includes(permission)));
  if(!eligible.length)throw new Halt('缺少测试数据','当前列表没有符合步骤条件的可定位记录：'+text);
  // Arbitrary-record UI checks may use the first eligible row; mutations may
  // only select a specifically named record or explicitly supplied fixture.
  const writes=/(?:点击|执行|确认|提交).{0,12}(?:删除|保存|上线|下线|发布)/.test(this.current?.steps||'');
  const fixture=this.config.data?.recordName;
  const chosen=fixture?eligible.find(c=>c.context.includes(fixture)):eligible[0];
  if(!chosen)throw new Halt('缺少测试数据','未找到配置的独立测试记录：'+fixture);
  if(writes&&!fixture&&!quotedName)throw new Halt('缺少独立测试数据','该用例会修改记录；需先准备独立测试数据并通过--data的recordName指定，不能对现有任意记录操作');
  this.rowKey=chosen.rowKey;
  this.events.push({phase:this.phase,action:'bind-row',text,rowKey:chosen.rowKey,record:chosen.context,selection:fixture?'configured-fixture':'first-eligible-live-row'});
  console.log('  绑定记录：'+chosen.context.slice(0,100));
  await discoverRowLabels(this.page,this.rowKey);
 }
 async ready(){return waitForReady(this.page,{timeout:this.config.pageTimeout||18000,failures:()=>this.failures.slice(this.navFailureStart)});}
 async navigate(url,{force=false}={}){const u=new URL(url,this.config.url);if(!['http:','https:'].includes(u.protocol)||!this.config.origins.includes(u.origin))throw new Halt('目标地址超出测试范围','步骤网址必须属于本次测试站点');
  const changed=force||this.page.url()!==u.href;
  if(changed){this.navFailureStart=this.failures.length;this.navigationCount++;await this.page.goto(u.href,{waitUntil:'domcontentloaded'});}
  await this.ready();return changed;
 }
 async showArea(name){
  const snap=await observe(this.page),tabs=snap.controls.filter(c=>c.role==='tab'&&norm(c.name)===norm(name));
  if(tabs.length!==1)throw new Halt('页签无法确认','找不到唯一页签：'+name);
  if(!tabs[0].selected){const c=await this.directClick(name,'切换到'+name+'Tab');this.events.push({phase:this.phase,action:'click',text:'切换到'+name+'Tab',control:{name:c.name,role:c.role},url:this.page.url()});}
 }
 async closeOverlay(){
  const modal=this.page.locator('dialog[open],[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content').last();
  if(!await modal.isVisible().catch(()=>false))return;
  // A header Close and a footer 关闭 can coexist. Prefer the explicit header
  // close label, then exact alternatives; never select a generic confirmation.
  for(const name of ['Close','关闭','Cancel','取消']){
   const close=modal.getByRole('button',{name,exact:true}).filter({visible:true});
   if(await close.count()!==1)continue;
   await close.click();await modal.waitFor({state:'hidden',timeout:this.config.assertTimeout||4000});await this.ready();return;
  }
  throw new Halt('页面复位未完成','存在未关闭弹窗，无法唯一确定取消/关闭按钮');
 }
 async resetCase(url){
  this.phase='setup';
  const desired=new URL(url,this.config.url),current=new URL(this.page.url());
  const sameModule=desired.origin===current.origin&&desired.pathname===current.pathname&&!desired.search&&!desired.hash;
  const changed=sameModule&&!this.config.reloadEachCase?(await this.ready(),false):await this.navigate(url,{force:!!this.config.reloadEachCase});
  const key=new URL(url,this.config.url).href;
  if(!this.baselines.has(key)){const snap=await observe(this.page);this.baselines.set(key,snap.controls.filter(c=>c.role==='tab'&&c.selected).map(c=>c.name));return;}
  if(!changed){
   await this.closeOverlay();
   for(const area of this.dirtyAreas.values()){
    for(const name of area)await this.showArea(name);
    const snap=await observe(this.page),resets=snap.controls.filter(c=>c.role==='button'&&/^(重置|Reset)$/i.test(c.name));
    if(resets.length===1){const c=await this.directClick(resets[0].name,'重置查询条件');this.events.push({phase:'setup',action:'reset',scope:area,control:{name:c.name,role:c.role}});}
    else{await this.navigate(url,{force:true});console.log('  上条改变了表单且页面没有重置入口，刷新一次恢复初始状态');break;}
   }
   for(const name of this.baselines.get(key))await this.showArea(name);
  }
  this.dirtyAreas.clear();
 }
 async checkPrecondition(p,c){
  if(/^(?:无|无特殊要求|none|n\/a)$/i.test(p))return;
  if(/^(?:用户)?已登录(?:系统)?[，,]?\s*$/i.test(p)){if(!this.config.authenticated||await this.page.locator('input[type="password"]:visible').count())throw new Halt('登录前提不足','本轮没有完成登录流程，或页面仍显示密码框');return;}
  const loginWith=p.match(/^(?:用户)?已登录(?:系统)?[，,](.+)$/);
  if(loginWith){await this.checkPrecondition('已登录系统',c);return this.checkPrecondition(loginWith[1],c);}
  const role=p.match(/^(?:仅)?拥有(.+?)(只读|读写)权限$/);
  if(role){
   const t=await readTables(this.page),i=t.headers.findIndex(h=>h.includes('权限'));
   if(i>=0&&t.rows.some(r=>norm(r[i])===norm(role[2])))return;
   throw new Halt('缺少权限场景','当前列表没有证明所需的'+role[2]+'权限记录；需要对应授权或测试身份');
  }
  if(/^进入/.test(p)){await this.step(p);return;}
  const permission=p.match(/^已拥有(.+)菜单权限$/);
  if(permission){const leaf=permission[1].split(/[_>＞→]/).at(-1),snap=await observe(this.page);if(snap.controls.some(x=>norm(x.name)===norm(leaf)))return;throw new Halt('前置条件未验证','未找到菜单“'+leaf+'”；先确认页面已加载且页面语言与Excel一致，不能据此判定账号无权限');}
  const exists=p.match(/^系统存在(.+)数据$/);
  if(exists){
   const moduleName=c.title.split(/\s+-\s+/)[0];let constraint=exists[1].replaceAll(moduleName,'').replace(/的/g,'');
   const snap=await observe(this.page),tabs=snap.controls.filter(x=>x.role==='tab'),areas=tabs.filter(x=>constraint.includes(x.name)).map(x=>x.name);
   for(const area of areas)constraint=constraint.replaceAll(area,'');constraint=constraint.replace(/和|、/g,'');
   const state=constraint.match(/^(.+)状态$/),permissionValue=constraint.match(/^(.+)权限$/),named=constraint.match(/^名称含[「“"](.+)[」”"]$/);
   if(state&&/^(?:各种|所有|多种|不同)$/.test(state[1]))throw new Halt('前置条件未验证','尚不能证明状态覆盖完整：'+p+'；需逐状态准备样本，不能把“各种”当成状态名称');
   if(constraint&&!state&&!permissionValue&&!named)throw new Halt('前置条件未验证','尚不能证明这个业务前提：'+p+'；请提供明确的数据条件，未将它当作通过');
   const column=state?'状态':permissionValue?'权限':named?'名称':null,value=state?.[1]||permissionValue?.[1]||named?.[1];
   const check=async()=>{const t=await readTables(this.page);if(!t.rows.length)return false;if(!column)return true;const index=t.headers.findIndex(h=>h.includes(column));return index>=0&&t.rows.some(r=>named?r[index]?.includes(value):norm(r[index])===norm(value));};
   if(areas.length){for(const area of areas){await this.showArea(area);if(!await check())throw new Halt('前置条件未验证',area+'当前可见记录未证明：'+p);}return;}
   if(await check())return;
   // Data may live behind another visible tab. Probe at most three tabs, never all pages.
   for(const area of tabs.filter(t=>!t.selected).slice(0,3)){await this.showArea(area.name);if(await check())return;}
   throw new Halt('前置条件未验证','当前可见记录未证明：'+p+'；没有查询全量后台数据，不能断言系统不存在该数据');
  }
  const check=await this.verify(p);if(check.status!=='通过')throw new Halt('前置条件未验证','未能验证前提：'+p+'；'+check.reason);
 }
 async step(text){
  const snap=await observe(this.page);
  let specs=expandStep(text,{controls:snap.controls,area:this.area});
  if(!specs.length)specs=await semanticStep(text,snap,this.laya,{meta:{case:this.current?.key},minProbability:this.config.minProbability,minMargin:this.config.minMargin});
  for(const spec of specs)await this.executeStep(text,spec);
 }
 async executeStep(text,spec){
  if(++this.actions>this.config.maxSteps)throw new Halt('达到步骤上限','本用例达到最大操作次数，停止继续尝试');
  console.log('  步骤：'+text);
  if(spec.verb==='bindRow'){await this.bindRow(text);return;}
  if(spec.verb==='assertStep'){
   const actual=await this.verify(spec.target);
   this.events.push({phase:this.phase,action:'step-assertion',text,...actual});
   if(actual.status!=='通过')throw new Halt(actual.status==='失败'?'步骤预期不符':'执行能力不足',actual.reason);return;
  }
  if(spec.verb==='emptyRequired'){
   const snap=await observe(this.page),fields=snap.controls.filter(c=>['textbox','spinbutton','combobox'].includes(c.role)&&!c.disabled&&!c.readonly);
   if(!fields.length||fields.some(c=>c.value))throw new Halt('前置条件未验证','当前必填字段为空尚未证明，不提交可能带有默认值的表单');
   this.events.push({phase:this.phase,action:'observe-empty-fields',text,fields:fields.map(c=>c.name)});return;
  }
  if(spec.verb==='path'){
   const snap=await observe(this.page),leaf=spec.path.at(-1),current=new URL(this.page.url());
   const here=snap.controls.find(c=>{if(norm(c.name)!==norm(leaf)||!c.href)return false;const u=new URL(c.href,current);return u.href===current.href||(!u.search&&!u.hash&&u.origin===current.origin&&u.pathname===current.pathname);});
   if(here){const event={phase:this.phase,text,action:'already-on-page',control:{name:here.name,role:here.role},url:this.page.url()};this.events.push(event);console.log('  已在目标页面，复用当前DOM');return event;}
  }
  // Explicit verbs need no second model vote ("点击查看" was being confused
  // with the observation verb). Laya still selects the real DOM target below.
  const verb=spec.verb;
  let control;
  if(verb==='navigate'){if(!spec.target)throw new Halt('缺少测试数据','没有明确网址');await this.navigate(spec.target);}
  else if(verb==='path'){
   // If a path's final destination is already visible, choose it directly.
   const snap=await observe(this.page),leaf=spec.path.at(-1);
   const candidates=snap.controls.filter(c=>norm(c.name)===norm(leaf));
   if(candidates.length===1)control=await this.directClick(leaf,text);
   else for(const part of spec.path)control=await this.directClick(part,text);
  }else if(verb==='observe'){
   const names=quoted(text);
   if(names.length===1&&/按钮/.test(text)){
    await this.revealRowMenu(names[0]);
    const found=await assertionTarget(this.page,names[0],'visible',{rowKey:await this.targetRow(names[0])});control=found.control;this.observedName=names[0];
   }
   await settle(this.page,this.config.delay);
  }
  else if(verb==='press'){if(spec.value.toLowerCase()==='enter'&&!this.config.allowWrite)throw new Halt('写入未启用','Enter可能提交当前表单；未启用写入时不猜测其行为');await this.page.keyboard.press(spec.value);await settle(this.page,this.config.delay);}
  else if(verb==='click'){
   if(!this.rowKey&&/列表(?:中)?点击/.test(text))await this.bindRow(text);
   control=await this.directClick(spec.target,text);
  }
  else {
   if(['fill','clear','select','check','uncheck'].includes(verb)){const snap=await observe(this.page),area=snap.controls.filter(c=>c.role==='tab'&&c.selected).map(c=>c.name);this.dirtyAreas.set(JSON.stringify(area),area);}
   const found=await this.chooseTarget(spec.target,verb,{value:spec.value,rowKey:await this.targetRow(spec.target),allowDisabled:verb==='hover'});control=found.control;
   if(verb==='fill'||verb==='clear'){
    await found.locator.fill(verb==='clear'?'':spec.value);
    if(await found.locator.inputValue()!==(verb==='clear'?'':spec.value))throw new Halt('操作未生效','填写后的实际输入值不一致');
   }else if(verb==='select'){
    if(control.tag==='select')await found.locator.selectOption({label:spec.value});
    else {await found.locator.click();await settle(this.page,this.config.delay);const option=await this.chooseTarget(spec.value,'option');await option.locator.click();}
   }else if(verb==='check'||verb==='uncheck'){
    if(['input'].includes(control.tag))await found.locator.setChecked(verb==='check');
    else if(control.checked!==(verb==='check'))await found.locator.click();
   }else if(verb==='hover')await found.locator.hover();
   await settle(this.page,this.config.delay);
  }
  const event={phase:this.phase,text,action:verb,...(control?{control:{name:control.name,role:control.role,context:control.context}}:{}),url:this.page.url()};this.events.push(event);return event;
 }
 async verify(text){
  const spec=expectation(text),page=this.page;
  if(spec.kind==='unsupported')return {text,status:'未验证',reason:'当前断言语法无法完整解释；未用Laya评分代替结果证明'};
  if(spec.scope)await this.showArea(spec.scope);
  let actual,passed=false;
  if(spec.kind==='tooltip'){
   if(!this.observedName)return {text,status:'未验证',reason:'没有明确的悬停目标，不能把任意提示作为本条证据'};
   await this.revealRowMenu(this.observedName);
   const found=await assertionTarget(page,this.observedName,'visible',{rowKey:await this.targetRow(this.observedName)});
   await found.locator.hover();await page.waitForTimeout(400);
   actual=[...new Set((await page.locator('[role="tooltip"]:visible,.ant-tooltip:visible,.el-tooltip__popper:visible').allTextContents()).map(s=>s.trim()))];passed=actual.some(s=>s.includes(spec.target));
  }else if(spec.kind==='controlVisible'){
   const snap=await observe(page);actual=snap.controls.filter(c=>norm(c.name)===norm(spec.target)).map(c=>({name:c.name,role:c.role}));passed=actual.length===1;
  }else if(spec.kind==='dialog'){
   const dialogs=page.locator('dialog[open]:visible,[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content:visible');
   actual=await dialogs.allTextContents();passed=actual.some(s=>s.includes(spec.target));
  }else if(spec.kind==='fixedColumns'){
   actual=await page.getByRole('columnheader').filter({visible:true}).evaluateAll((els,names)=>Object.fromEntries(names.map(name=>[name,els.filter(e=>e.innerText.trim()===name).map(e=>({position:getComputedStyle(e).position,left:getComputedStyle(e).left,right:getComputedStyle(e).right,fixedLeft:!!e.closest('.ant-table-fixed-left'),fixedRight:!!e.closest('.ant-table-fixed-right')}))])),[spec.left,spec.right]);
   passed=actual[spec.left]?.some(c=>c.fixedLeft||c.position==='sticky'&&c.left!=='auto')&&actual[spec.right]?.some(c=>c.fixedRight||c.position==='sticky'&&c.right!=='auto');
  }else if(spec.kind==='columnValues'){
   const t=await readTables(page),i=t.headers.findIndex(h=>h.includes(spec.column));actual=i<0?[]:t.rows.map(r=>r[i]);passed=actual.length>0&&actual.every(v=>spec.values.some(w=>norm(w)===norm(v)));
  }else if(spec.kind==='fieldAbsent'||spec.kind==='fields'){
   const snap=await observe(page),fields=snap.controls.filter(c=>['textbox','combobox'].includes(c.role)&&c.inPanel);actual=fields.map(c=>({name:c.name,role:c.role}));
   passed=spec.kind==='fieldAbsent'?!fields.some(c=>c.name.includes(spec.target)):spec.targets.every(t=>fields.some(c=>c.role===t.role&&c.name.includes(t.name)));
  }else if(spec.kind==='visible'||spec.kind==='absent'){
   // Check visible rendered text, not hidden DOM or a model's opinion.
   const locator=page.getByText(spec.target,{exact:false}).filter({visible:true});
   if(spec.kind==='visible')await locator.first().waitFor({timeout:this.config.assertTimeout}).catch(()=>{});
   else await locator.first().waitFor({state:'hidden',timeout:this.config.assertTimeout}).catch(()=>{});
   actual=await locator.count();passed=spec.kind==='visible'?actual>0:actual===0;
  }else if(spec.kind==='tabs'){
   const snap=await observe(page),tabs=snap.controls.filter(c=>c.role==='tab');actual=tabs.map(c=>c.name);passed=actual.length===spec.count&&spec.targets.every(t=>actual.includes(t));
  }else if(spec.kind==='columns'){
   actual=await page.getByRole('columnheader').filter({visible:true}).allTextContents();passed=spec.targets.every(t=>actual.some(a=>a.trim()===t));
  }else if(spec.kind==='rowcount'){
   const tables=page.getByRole('table').filter({visible:true});if(await tables.count()!==1)return {text,status:'未验证',reason:'存在多个表格，需要写明目标表格，不能猜测行数'};
   await page.waitForFunction(expected=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};const all=[...document.querySelectorAll('table,[role="table"]')].filter(visible);return all.length===1&&[...all[0].querySelectorAll('tbody tr')].filter(visible).length===expected;},spec.value,{timeout:this.config.assertTimeout}).catch(()=>{});
   actual=await tables.locator('tbody tr').filter({visible:true}).count();passed=actual===spec.value;
  }else if(spec.kind==='url'){actual=page.url();passed=actual.includes(spec.target);}
  else {
   const found=await assertionTarget(page,spec.target,spec.kind,{rowKey:await this.targetRow(spec.target)});
   if(['value','empty'].includes(spec.kind)){actual=await found.locator.inputValue();passed=actual===(spec.kind==='empty'?'':spec.value);}
   else if(['disabled','enabled'].includes(spec.kind)){actual=found.control.disabled;passed=spec.kind==='disabled'?actual:!actual;}
   else if(spec.kind==='checked'){actual=found.control.checked;passed=actual===true;}
   else if(spec.kind==='selected'){actual=found.control.selected;passed=actual===true;}
  }
  return {text,status:passed?'通过':'失败',kind:spec.kind,actual,reason:passed?'明确断言满足':'实际页面状态与该预期不符，需核对需求或定位证据'};
 }
 async runCase(c){
  this.current=c;this.actions=0;this.events=[];this.rowKey=null;this.area=null;this.observedName=null;this.pendingPreconditions=[];const started=Date.now();const failuresAt=this.failures.length,navAt=this.navigationCount;let touchedPage=false;
  const result={...c,status:'未执行',reason:'',category:'',actions:[],assertions:[],started_at:new Date().toISOString()};
  try{
   if(c.import_error)throw new Halt('Excel内容不明确',c.import_error);
   if(!this.config.includeApproval&&approvalOperation(c))throw new Halt('按要求跳过审批','用例包含审批流程操作或审批开关，不执行；仅展示审批状态的用例不按关键词排除');
   const data={...parseData(c.data),...this.config.data,runId:this.config.runId};
   const steps=lines(variables(c.steps,data)),expected=lines(variables(c.expected,data)),preconditions=lines(variables(c.preconditions,data));
   if(!steps.length||!expected.length)throw new Halt('用例内容缺失','需要明确的操作步骤和预期结果');
   touchedPage=true;await this.resetCase(c.url||this.config.url);this.phase='precondition';
   const scopeSnapshot=await observe(this.page);
   const titleAreas=scopeNames(c.title+'\n'+steps.filter(s=>/^切换/.test(s)&&s.includes('/')).join('\n'),scopeSnapshot.controls);
   if(titleAreas.length===1)await this.showArea(titleAreas[0]);
   result.precondition_checks=[];
   for(const p of preconditions){
    try{await this.checkPrecondition(p,c);result.precondition_checks.push({text:p,status:'通过'});}
    catch(e){
     if(e.category!=='前置条件未验证'||!/(?:尚不能证明|语法无法完整解释)/.test(e.message))throw e;
     this.pendingPreconditions.push(p);result.precondition_checks.push({text:p,status:'待补证',reason:e.message});
     console.log('  前提待补证，继续可观察步骤：'+p);
    }
   }
   // Repeat read-only scenarios explicitly titled for multiple live tabs.
   // Never multiply potentially persistent writes across scopes automatically.
   if(titleAreas.length>1&&this.config.allowWrite)throw new Halt('多页签写入范围不明确','用例标题涉及多个页签且允许写入，请拆成独立用例后执行');
   for(const area of titleAreas.length?titleAreas:[null]){
    this.phase='step';this.area=area;this.rowKey=null;if(area){await this.closeOverlay();await this.showArea(area);console.log('  用例范围：'+area);}
    for(const text of steps)await this.step(text);
    this.phase='assertion';
    for(const text of expected){try{result.assertions.push({...await this.verify(text),scope:area});}catch(e){if(e.category==='模型API错误')throw e;result.assertions.push({text,scope:area,status:'未验证',reason:e.message});}}
   }
   for(const p of this.pendingPreconditions)result.assertions.push({text:'前提：'+p,status:'未验证',reason:'已继续执行可观察步骤，但该前提仍缺少证据，不能计为通过'});
   result.status=result.assertions.some(a=>a.status==='失败')?'失败':result.assertions.some(a=>a.status==='未验证')?'部分验证':'通过';
   result.category=result.status==='失败'?'断言不符合预期，需复核':result.status==='部分验证'?'部分预期尚不能自动验证':'无';
   result.reason=result.assertions.filter(a=>a.status!=='通过').map(a=>a.text+'：'+a.reason).join('；')||'所有步骤已执行，所有预期断言通过';
  }catch(e){result.status=this.events.some(x=>x.phase==='step'&&x.action!=='already-on-page')?'部分执行（未完成）':'跳过（未完成）';result.category=e.category||'执行器异常';result.reason=e.message;}
  result.actions=this.events;result.duration_ms=Date.now()-started;result.network_errors=this.failures.slice(failuresAt);result.page_navigations=this.navigationCount-navAt;
  this.lastCaseUiChanged=this.events.some(x=>x.phase==='step'&&['fill','select','check','uncheck','clear'].includes(x.action));
  result.evidence_scope=result.actions.length?'操作后的页面快照':'本条没有完成动作；截图仅表示停止时浏览器页面';
  if(result.status!=='通过'&&result.network_errors.some(x=>x.status===401)){result.category='登录会话失效';result.reason+='；捕获HTTP401，需重新登录';}
  if(['页面资源加载失败','页面尚未就绪'].includes(result.category)&&result.network_errors.some(x=>x.status>=500)){result.category='环境接口故障';result.reason+='；页面未就绪且捕获HTTP5xx，不能据此判定产品功能错误';}
  const stem=`${String(c.id).replace(/[^\w\u4e00-\u9fff-]/g,'_')}-${c.row}`;
  if(touchedPage){result.screenshot='evidence/'+stem+'.png';await this.page.screenshot({path:path.join(this.config.out,result.screenshot)}).catch(()=>{});
   const snap=await observe(this.page);await fs.writeFile(path.join(this.config.out,'evidence',stem+'-controls.json'),JSON.stringify({url:snap.url,controls:snap.controls},null,2));}
  return result;
 }
}
