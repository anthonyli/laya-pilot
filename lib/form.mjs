import {randomBytes} from 'node:crypto';

const REF='data-laya-form-ref';
const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};

export async function inspectForm(page){
 const nonce=randomBytes(4).toString('hex');
 return page.evaluate(({nonce,attr})=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const roots=[...document.querySelectorAll('dialog[open],[role="dialog"],.ant-drawer-open .ant-drawer-content,.el-dialog')].filter(visible);
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
 },{nonce,attr:REF});
}

export async function findFormItem(page,label){
 const matches=(await inspectForm(page)).filter(x=>x.label===label);
 if(matches.length!==1)throw Error(`表单字段「${label}」数量为${matches.length}，无法安全定位`);
 const item=page.locator(`[${REF}="${matches[0].ref}"]`);
 if(await item.count()!==1||!await item.isVisible())throw Error('表单字段已变化：'+label);
 return {info:matches[0],item};
}

export async function inspectLooseRequired(page){
 return page.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const roots=[...document.querySelectorAll('dialog[open],[role="dialog"],.ant-drawer-open .ant-drawer-content,.el-dialog')].filter(visible);
  const root=roots.at(-1);if(!root)return [];
  const counts={};
  return [...root.querySelectorAll('input[aria-required="true"],textarea[aria-required="true"]')].filter(e=>visible(e)&&!e.disabled&&!e.readOnly&&e.getAttribute('role')!=='combobox'&&!e.closest('.ant-form-item,.el-form-item')?.querySelector('label')).map(e=>{
   const placeholder=e.getAttribute('placeholder')||'';
   const index=counts[placeholder]||0;counts[placeholder]=index+1;
   return {placeholder,index,role:e.getAttribute('role')||'',type:e.getAttribute('type')||e.tagName.toLowerCase(),value:e.value||''};
  });
 });
}

export async function formErrors(page){
 return page.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const roots=[...document.querySelectorAll('dialog[open],[role="dialog"],.ant-drawer-open .ant-drawer-content,.el-dialog')].filter(visible);
  const root=roots.at(-1);if(!root)return {open:false,labels:[],messages:[]};
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const bad=[...root.querySelectorAll('.ant-form-item-has-error,.has-error,.el-form-item.is-error')].filter(visible);
  const labels=[...new Set(bad.map(e=>text(e.querySelector('label'))).filter(Boolean))];
  const messages=[...new Set([...root.querySelectorAll('[role="alert"],.ant-form-item-explain-error,.ant-form-explain,.el-form-item__error')].filter(visible).map(text).filter(Boolean))];
  return {open:true,labels,messages};
 });
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
