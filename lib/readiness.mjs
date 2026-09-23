import {Halt} from './language.mjs';

// Wait for the application, not merely the outer document's DOMContentLoaded.
export async function waitForReady(page,{timeout=18000,minimum=600,failures=()=>[]}={}){
 const start=Date.now();let stableSince=Date.now(),previous='',last;
 while(Date.now()-start<timeout){
  const errors=failures().filter(x=>x.status>=500&&(/\.html?$|\.js$|\.css$/i.test(x.path)||x.resourceType==='document'));
  const states=[];
  for(const frame of page.frames())try{states.push(await frame.evaluate(()=>{
   const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[aria-hidden="true"],[inert]');};
   const body=document.body;if(!body)return {controls:0,busy:true,text:''};
   const text=body.innerText.trim(),controls=[...document.querySelectorAll('button,input:not([type=hidden]),select,textarea,a[href],[role=tab],[role=combobox],[role=menuitem]')].filter(visible);
   const loading=[...document.querySelectorAll('[aria-busy=true],.ant-spin-spinning,.el-loading-mask,[role=progressbar]')].some(visible)||text.split('\n').some(x=>/^(?:loading\.{0,3}|加载中[.。…]*|正在加载[.。…]*)$/i.test(x.trim()));
   return {controls:controls.length,busy:loading,text:text.slice(0,240),signature:controls.slice(0,60).map(x=>[x.getAttribute('role'),x.tagName,x.getAttribute('placeholder'),x.getAttribute('aria-label'),x.textContent?.trim().slice(0,25)].join(':')).join('|')};
  }));}catch{}
  const count=states.reduce((n,s)=>n+s.controls,0),busy=states.some(s=>s.busy),fingerprint=states.map(s=>s.signature||'').join('|');last={count,busy};
  // A shell may preload unrelated microfrontends. Their errors must not block
  // an already usable page; only correlate critical errors with an unready UI.
  if(errors.length&&(busy||count===0))throw new Halt('页面资源加载失败',errors.map(x=>x.path+' HTTP '+x.status).join('；'));
  if(fingerprint!==previous||busy||count===0){previous=fingerprint;stableSince=Date.now();}
  if(count>0&&!busy&&Date.now()-stableSince>=minimum)return {duration_ms:Date.now()-start,controls:count};
  await page.waitForTimeout(150);
 }
 throw new Halt('页面尚未就绪',`等待${timeout}ms后页面仍为空白或加载中（控件${last?.count||0}，loading=${last?.busy}），停止本次会话，不继续刷新后续用例`);
}

export async function switchLanguage(page,language){
 if(!language||language==='none')return '未要求切换';
 const chinese=language==='zh-CN';
 if(chinese&&await page.getByRole('button',{name:'登录',exact:true}).isVisible().catch(()=>false))return '已是中文';
 const wanted=chinese?['简体中文','中文','Chinese']:['English','英文'];
 const current=chinese?['English','Language','语言']:['简体中文','中文','语言'];
 for(const name of current){
  const trigger=page.getByText(name,{exact:true}).filter({visible:true});
  if(await trigger.count()!==1)continue;
  for(let attempt=0;attempt<2;attempt++){
   await trigger.hover();await page.waitForTimeout(300);
   for(const label of wanted){const option=page.getByText(label,{exact:true}).filter({visible:true});try{await option.first().waitFor({timeout:1200});}catch{continue;}if(await option.count()===1){try{await option.hover({timeout:1500});await option.click({timeout:2000});return '已切换为'+language;}catch{}}}
  }
 }
 return '未找到语言入口，保留当前语言';
}

export async function readTables(page){
 const tables=[];
 for(const frame of page.frames())try{tables.push(...await frame.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[aria-hidden="true"]');};
  const panels=[...document.querySelectorAll('[role=tabpanel]')].filter(visible),root=panels.length===1?panels[0]:document;
  return [...root.querySelectorAll('table')].filter(visible).map(t=>({headers:[...t.querySelectorAll('thead th')].map(x=>x.innerText.trim()),rows:[...t.querySelectorAll('tbody tr')].filter(visible).map(r=>[...r.querySelectorAll('td')].map(c=>c.innerText.trim())).filter(r=>r.length>1)}));
 }));}catch{}
 // Ant-style fixed-column clones are narrower copies of the main table.
 const width=Math.max(0,...tables.map(t=>t.headers.length));const full=tables.filter(t=>t.headers.length===width);
 if(!full.length)return {headers:[],rows:[]};
 const distinct=new Map(full.map(t=>[JSON.stringify(t),t]));if(distinct.size!==1)throw new Halt('表格不唯一','存在多个不同的数据表，无法判断目标表格');
 return [...distinct.values()][0];
}
