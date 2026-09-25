import {randomBytes} from 'node:crypto';

const REF='data-laya-form-ref';
// 弹窗根选择器：与 dom.mjs / workflow.mjs 的模态判定同族，含手写全屏遮罩容器
const ROOT_SEL='dialog[open],[role="dialog"],[role="alertdialog"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],div.fixed.inset-0.z-50,.ant-drawer-open .ant-drawer-content,.el-dialog';
const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};

export async function inspectForm(page){
 const nonce=randomBytes(4).toString('hex');
 return page.evaluate(({nonce,attr,rootSel})=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const roots=[...document.querySelectorAll(rootSel)].filter(visible);
  const root=roots.at(-1);
  if(!root)return [];
  return [...root.querySelectorAll('.ant-form-item,.el-form-item')].filter(visible).map((item,index)=>{
   const label=text(item.querySelector('label')).replace(/^\*\s*/,'');
   if(!label)return null;
   const ref=nonce+'-'+index;item.setAttribute(attr,ref);
   const inputs=[...item.querySelectorAll('input:not([type="hidden"]),textarea')].filter(visible).map(e=>({
    type:e.getAttribute('type')||e.tagName.toLowerCase(),role:e.getAttribute('role')||'',placeholder:e.getAttribute('placeholder')||'',value:e.value||'',readonly:e.readOnly||e.disabled,
   }));
   const combo=!!item.querySelector('[role="combobox"],select,.ant-select,.el-select');
   const chosen=text(item.querySelector('.ant-select-selection-selected-value,.ant-select-selection-item,.tntd-rc-select-selection-item,.tntd-select-selection-item'));
   return {ref,label,required:!!item.querySelector('label.ant-form-item-required,[aria-required="true"]'),combo,chosen,inputs,sectionText:text(item).slice(0,250)};
  }).filter(Boolean);
 },{nonce,attr:REF,rootSel:ROOT_SEL});
}

export async function findFormItem(page,label){
 const matches=(await inspectForm(page)).filter(x=>x.label===label);
 if(matches.length!==1)throw Error(`表单字段「${label}」数量为${matches.length}，无法安全定位`);
 const item=page.locator(`[${REF}="${matches[0].ref}"]`);
 if(await item.count()!==1||!await item.isVisible())throw Error('表单字段已变化：'+label);
 return {info:matches[0],item};
}

export async function inspectLooseRequired(page){
 const nonce=randomBytes(4).toString('hex');
 return page.evaluate(({rootSel,attr,nonce})=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const labelOf=e=>{let n=e.previousElementSibling;while(n){if(/^label$/i.test(n.tagName))return text(n);n=n.previousElementSibling;}return '';};
  const roots=[...document.querySelectorAll(rootSel)].filter(visible);
  const root=roots.at(-1);if(!root)return [];
  const counts={};
  // aria-required 与原生 required 都算必填（手写表单常用原生属性）
  return [...root.querySelectorAll('input[aria-required="true"],input[required],textarea[aria-required="true"],textarea[required]')].filter(e=>visible(e)&&!e.disabled&&!e.readOnly&&e.getAttribute('role')!=='combobox'&&!e.closest('.ant-form-item,.el-form-item')?.querySelector('label')).map(e=>{
   const placeholder=e.getAttribute('placeholder')||'';
   const index=counts[placeholder]||0;counts[placeholder]=index+1;
   const ref=nonce+'-'+index;e.setAttribute(attr,ref);
   return {ref,label:labelOf(e),placeholder,index,role:e.getAttribute('role')||'',type:e.getAttribute('type')||e.tagName.toLowerCase(),value:e.value||''};
  });
 },{rootSel:ROOT_SEL,attr:REF,nonce});
}

// 按 label（稳定）或 占位符+序号（旧路径）定位弹窗内必填输入框，打上 REF 标记返回；
// 返回 null 表示定位失败。React 表单填写后可能摘掉 required 属性，故每步重新定位。
export async function looseInputRef(page,{label,placeholder,index}){
 const nonce=randomBytes(4).toString('hex');
 return page.evaluate(({rootSel,attr,nonce,label,placeholder,index})=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const labelOf=e=>{let n=e.previousElementSibling;while(n){if(/^label$/i.test(n.tagName))return text(n);n=n.previousElementSibling;}return '';};
  const roots=[...document.querySelectorAll(rootSel)].filter(visible);
  const root=roots.at(-1);if(!root)return null;
  const items=[...root.querySelectorAll('input[aria-required="true"],input[required],textarea[aria-required="true"],textarea[required]')].filter(e=>visible(e)&&!e.disabled&&!e.readOnly);
  let target=null;
  if(label){const m=items.filter(e=>labelOf(e)===label);if(m.length!==1)return null;target=m[0];}
  else{let hit=null;const counts={};
   for(const e of items){const p=e.getAttribute('placeholder')||'';const i=counts[p]||0;counts[p]=i+1;if(p===placeholder&&i===index){hit=e;break;}}
   if(!hit)return null;target=hit;}
  const ref=nonce+'-hit';target.setAttribute(attr,ref);return ref;
 },{rootSel:ROOT_SEL,attr:REF,nonce,label:label||'',placeholder:placeholder||'',index:index||0});
}

export async function formErrors(page){
 return page.evaluate(({rootSel})=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const roots=[...document.querySelectorAll(rootSel)].filter(visible);
  const root=roots.at(-1);if(!root)return {open:false,labels:[],messages:[]};
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const bad=[...root.querySelectorAll('.ant-form-item-has-error,.has-error,.el-form-item.is-error')].filter(visible);
  const labels=[...new Set(bad.map(e=>text(e.querySelector('label'))).filter(Boolean))];
  const messages=[...new Set([...root.querySelectorAll('[role="alert"],.ant-form-item-explain-error,.ant-form-explain,.el-form-item__error')].filter(visible).map(text).filter(Boolean))];
  if(!bad.length){
   // 原生表单校验兜底：空表单提交被浏览器拦截时，required 输入框带 :invalid 伪类，
   // 错误只存在于 validationMessage，不产生 DOM 错误元素
   const invalid=[...root.querySelectorAll('input:invalid,textarea:invalid,select:invalid')].filter(visible);
   if(invalid.length){
    const ilabels=[...new Set(invalid.map(e=>{const lbl=e.closest('div')?.querySelector('label');return lbl?text(lbl):'';}).filter(Boolean))];
    const imessages=[...new Set(invalid.map(e=>e.validationMessage).filter(Boolean))];
    if(ilabels.length||imessages.length)return {open:true,labels:ilabels,messages:imessages};
   }
  }
  return {open:true,labels,messages};
 },{rootSel:ROOT_SEL});
}

export async function visibleOptions(page){
 const nonce=randomBytes(4).toString('hex');
 return page.evaluate(nonce=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const hittable=e=>{const r=e.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));const top=document.elementFromPoint(x,y);return top&&(e.contains(top)||top.contains(e));};
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const overlays=[...document.querySelectorAll('[role="listbox"],[role="tree"],[role="menu"],.ant-select-dropdown,.tntd-select-dropdown,.tntd-rc-select-dropdown,.virtual-tree-options,.el-select-dropdown')].filter(e=>visible(e)&&hittable(e));
  const roots=overlays.filter(e=>!overlays.some(other=>other!==e&&other.contains(e)));
  const selectors='[role="option"],[role="treeitem"],[role="menuitemcheckbox"],[role="menuitem"],.ant-select-dropdown-menu-item,.el-select-dropdown__item,.tntd-virtual-tree-item,.virtual-tree-options span,.virtual-tree-options li';
  const entries=[];
  for(const root of roots)for(const e of root.querySelectorAll(selectors)){
   if(!visible(e)||!hittable(e)||e.matches('[aria-disabled="true"],.disabled,.ant-select-dropdown-menu-item-disabled'))continue;
   if(e.closest('.tntd-virtual-tree-item')&& !e.matches('.tntd-virtual-tree-item'))continue;
   const name=e.matches('.tntd-virtual-tree-item')?text(e.querySelector('.tntd-ellipsis')||e.querySelector('.tntd-virtual-tree-title')):text(e);
   if(!name||name.length>90)continue;
   if(entries.some(x=>x.name===name))continue;
   const target=e.matches('.tntd-virtual-tree-item')?e.querySelector('.tntd-virtual-tree-title')||e:e;
   const ref=nonce+'-'+entries.length;target.setAttribute('data-laya-option-ref',ref);
   entries.push({ref,name,role:e.getAttribute('role')||'',treeItem:e.matches('.tntd-virtual-tree-item'),expandable:e.getAttribute('aria-expanded')==='false'||!!e.querySelector('[aria-expanded="false"]'),numeric:!!e.querySelector('[data-icon="float"],[data-icon="integer"],[data-icon="number"]')||!!e.closest('[data-icon="float"],[data-icon="integer"],[data-icon="number"]')});
  }
  return entries.slice(0,100);
 },nonce);
}

export function generatedInputValue(label,placeholder,role,token,index=0){
 const hint=label+' '+placeholder;
 const interval=hint.match(/[[(]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*[)\]]/);
 if(interval)return interval[0];
 if(role==='spinbutton'||/数字|数量|金额|年龄|数值|number|amount|count/i.test(hint))return '1';
 if(/密码|password/i.test(hint))return 'Laya#Test_2026!Aa';
 if(/邮箱|email/i.test(hint))return `laya_${token}@example.com`;
 if(/网址|URL/i.test(hint))return 'https://example.com';
 if(/默认|default/i.test(hint))return '默认_'+token;
 if(/返回|结果|return|result/i.test(hint))return '结果_'+token;
 return '测试_'+token+(index?('_'+index):'');
}

export function invalidExampleValue(placeholder){
 const interval=placeholder.match(/[[(]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*[)\]]/);
 return interval?'【'+interval[0].slice(1):null;
}
