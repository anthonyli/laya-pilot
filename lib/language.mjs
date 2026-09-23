// General instruction grammar only. No case IDs, module names, routes or CSS selectors.
export class Halt extends Error {constructor(category,message){super(message);this.category=category;}}
export const norm=s=>String(s||'').toLowerCase().replace(/[\s“”「」『』"'：:，,。.!！?？_\-]/g,'');
export const quoted=s=>[...s.matchAll(/[“「『"]([^”」』"]*)[”」』"]/g)].map(m=>m[1]);
export function lines(s){return String(s||'').split(/\r?\n|[；;](?=(?:[^“”]*“[^“”]*”)*[^“”]*$)/).map(x=>x.replace(/^\s*(?:\d+[、.．)）:]|[-•])\s*/,'').trim()).filter(Boolean);}
export function variables(text,data){return String(text||'').replace(/\$\{([^}]+)\}/g,(_,key)=>{if(!Object.hasOwn(data,key))throw new Halt('缺少测试数据','未提供变量 '+key);return String(data[key]);});}
export function parseData(s){if(!s?.trim())return {};try{const d=JSON.parse(s);if(d&&typeof d==='object'&&!Array.isArray(d))return d;}catch{}const pairs=lines(s).map(x=>x.match(/^([^=：:]+)[=：:](.*)$/));if(pairs.some(x=>!x))throw new Halt('测试数据格式不明确','测试数据请使用 JSON 对象，或每行 名称=值');return Object.fromEntries(pairs.map(m=>[m[1].trim(),m[2].trim()]));}
export function describe(step){
 const q=quoted(step);let m;
 if(/^(?:打开网址|访问网址|navigate to|open url)\s*/i.test(step)){const target=step.match(/https?:\/\/\S+/)?.[0];return {verb:'navigate',target:target?.replace(/[”」"]$/,'')};}
 if((m=step.match(/^(?:在|向)?[“「"]?(.+?)[”」"]?(?:输入框|文本框|框)?(?:中|内)?(?:输入|填写|填入)\s*[“「"](.*)[”」"]$/)))return {verb:'fill',target:m[1].replace(/^(?:在|向)/,''),value:m[2]};
 if((m=step.match(/^(?:fill|type into)\s+"([^"]+)"\s+(?:with\s+)?"([^"]*)"$/i)))return {verb:'fill',target:m[1],value:m[2]};
 if((m=step.match(/^(?:在)?[“「"]?(.+?)[”」"]?(?:下拉框|下拉列表)(?:中)?选择\s*[“「"](.*)[”」"]$/)))return {verb:'select',target:m[1],value:m[2]};
 if((m=step.match(/^select\s+"([^"]+)"\s+from\s+"([^"]+)"$/i)))return {verb:'select',target:m[2],value:m[1]};
 if(/^(取消勾选|uncheck\b)/i.test(step))return {verb:'uncheck',target:q[0]||step.replace(/^(取消勾选|uncheck)\s*/i,'')};
 if(/^(勾选|check\b)/i.test(step))return {verb:'check',target:q[0]||step.replace(/^(勾选|check)\s*/i,'')};
 if(/^(清空|clear\b)/i.test(step))return {verb:'clear',target:q[0]||step.replace(/^(清空|clear)\s*/i,'').replace(/输入框$/,'')};
 if(/^(悬停|hover\b)/i.test(step))return {verb:'hover',target:q[0]||step.replace(/^(悬停(?:在)?|hover(?: over)?)\s*/i,'')};
 if((m=step.match(/^(?:按下|press)\s*(Enter|Escape|Tab|ArrowDown|ArrowUp)$/i)))return {verb:'press',value:m[1]};
 if(/^(点击|单击|再点击|切换|选择|进入|打开|click\b|open\b|go to\b)/i.test(step)){
  let target=q[0]||step.replace(/^(?:再点击|点击|单击|切换到?|选择|进入|打开|click(?: on)?|open|go to)\s*/i,'').replace(/(?:按钮|页面|列表页|Tab(?:切回)?|标签页)$/i,'').trim();
  if(/[>＞→]/.test(target)||/^进入/.test(step))return {verb:'path',path:target.split(/\s*[>＞→]\s*/).map(x=>x.replace(/(?:页面|列表页)$/,'').trim())};
  return {verb:'click',target};
 }
 if(/^(查看|观察|检查|验证|确认|inspect\b|observe\b|verify\b)/i.test(step))return {verb:'observe',target:step};
 if(/^在.+(?:查看|观察)/.test(step))return {verb:'observe',target:step};
 return {verb:'unsupported',target:step};
}
export const actionLabels={click:'点击按钮、链接、菜单或切换标签页',fill:'在输入框填写文字',select:'从下拉框中选择一个值',check:'勾选复选框',uncheck:'取消勾选复选框',clear:'清空输入框内容',hover:'将鼠标悬停在控件上',press:'按下键盘按键',observe:'查看页面内容，不改变页面',navigate:'访问明确的网址',path:'按菜单路径进入页面'};
export const actionKeys={click:'点击',fill:'填写',select:'选择',check:'勾选',uncheck:'取消勾选',clear:'清空',hover:'悬停',press:'按键',observe:'查看',navigate:'访问网址',path:'进入菜单'};
export function actionCode(choice){return Object.entries(actionKeys).find(([,v])=>v===choice)?.[0];}
export function actionCriteria(spec){
 const related=spec.verb==='fill'?['fill','click','select']:spec.verb==='select'?['select','fill','click']:['check','uncheck'].includes(spec.verb)?['check','uncheck']:spec.verb==='observe'?['observe','click']:spec.verb==='clear'?['clear','click','fill']:spec.verb==='path'?['path','observe']:spec.verb==='navigate'?['navigate','click']:[spec.verb,'observe','fill'];
 const t=spec.target||spec.path?.at(-1)||'',en=/[a-z]/i.test(t)&&!/[\u4e00-\u9fff]/.test(t);
 const dynamic=en?{click:'Click '+t,fill:'Enter text in '+t,select:'Select an option in '+t,check:'Check '+t,uncheck:'Uncheck '+t,clear:'Clear '+t,hover:'Hover over '+t,observe:'View the page',press:'Press a keyboard key',navigate:'Open a URL',path:'Navigate through menu items'}:{click:'点击'+t,fill:'在'+t+'输入框输入文字',select:'在'+t+'下拉框选择选项',check:'勾选'+t,uncheck:'取消勾选'+t,clear:'清空'+t,hover:'悬停在'+t,observe:'查看页面或列表',press:'按下键盘按键',navigate:'打开网址',path:'进入菜单页面'};
 const general={fill:'在输入框填写文字',click:'点击按钮',select:'从下拉框选择一个值',observe:'查看页面或列表'};
 return Object.fromEntries([...new Set(related)].filter(k=>actionLabels[k]).map(k=>[actionKeys[k],!en&&general[k]&&!(spec.verb==='click'&&k==='click')?general[k]:dynamic[k]]).concat([['停止',en?'Stop without performing any action':'不执行']]));
}
export function expectation(text){
 let m;const q=quoted(text);
 if((m=text.match(/^[「“"](.+)[」”"]按钮(?:置灰不可点击|置灰|不可点击|不可用)$/)))return {kind:'disabled',target:m[1]};
 if((m=text.match(/^悬浮提示[「“"](.+)[」”"]$/)))return {kind:'tooltip',target:m[1]};
 if((m=text.match(/^(?:页面|弹窗)?(?:展示|显示)[「“"](.+)[」”"]按钮$/)))return {kind:'controlVisible',target:m[1]};
 if((m=text.match(/^(?:右侧)?弹出(.+?)(?:弹窗|Modal|Drawer|抽屉)$/i)))return {kind:'dialog',target:m[1]};
 if((m=text.match(/^名称列固定在左侧，操作列固定在右侧$/)))return {kind:'fixedColumns',left:'名称',right:'操作'};
 if((m=text.match(/^(.+?)不展示(.+?)筛选条件$/)))return {kind:'fieldAbsent',scope:m[1],target:m[2]};
 if((m=text.match(/^(.+?)筛选区域展示[：:](.+)$/)))return {kind:'fields',scope:m[1],targets:m[2].split(/[、，,]/).map(x=>({name:x.replace(/输入框|下拉框/g,''),role:x.includes('输入框')?'textbox':'combobox'}))};
 if((m=text.match(/^(?:(.+?)列表|列表)(?:仅)?展示(.+?)状态的.+数据$/)))return {kind:'columnValues',scope:m[1]||'',column:'状态',values:m[2].split(/和|、/)};
 if((m=text.match(/^(.+?)列表展示(.+?)的数据$/)))return {kind:'columnValues',scope:m[1],column:'状态',values:m[2].split(/和|、/)};
 if((m=text.match(/^列表仅展示权限为(.+?)的.+数据$/)))return {kind:'columnValues',column:'权限',values:[m[1]]};
 if((m=text.match(/^(?:页面|列表|弹窗)?(?:不显示|不展示|不存在|不包含)\s*[“「"](.+)[”」"](?:文本|文案)?$/)))return {kind:'absent',target:m[1]};
 if((m=text.match(/^(?:页面|列表|弹窗)?(?:显示|展示|包含|出现)\s*[“「"](.+)[”」"](?:文本|文案)?$/)))return {kind:'visible',target:m[1]};
 if((m=text.match(/^(?:page\s+)?(?:shows|contains)\s+"(.+)"$/i)))return {kind:'visible',target:m[1]};
 if((m=text.match(/^"(.+)"\s+is\s+(empty|disabled|enabled|checked|selected)$/i)))return {kind:m[2].toLowerCase(),target:m[1]};
 if((m=text.match(/^[“「"](.+)[”」"](?:输入框|字段)?(?:的值)?(?:为|等于)[“「"](.*)[”」"]$/)))return {kind:'value',target:m[1],value:m[2]};
 if((m=text.match(/^[“「"](.+)[”」"](?:输入框|字段|按钮|标签页|Tab|复选框)?(?:为|是|已|应|处于)?(空|清空|禁用|不可用|置灰|可用|勾选|选中)$/)))return {kind:({'空':'empty','清空':'empty','禁用':'disabled','不可用':'disabled','置灰':'disabled','可用':'enabled','勾选':'checked','选中':'selected'})[m[2]],target:m[1]};
 if((m=text.match(/^默认选中[「“"](.+)[」”"](?:Tab|标签页)?$/)))return {kind:'selected',target:m[1]};
 if((m=text.match(/^(?:列表页)?(?:展示|显示)(?:两个|2个)Tab[：:]\s*(.+)$/)))return {kind:'tabs',targets:m[1].split(/[、，,]/).map(x=>x.trim()),count:2};
 if((m=text.match(/^(?:列表|表格)(?:展示以下列|表头包含)[：:]\s*(.+)$/)))return {kind:'columns',targets:m[1].split(/[、，,]/).map(x=>x.trim())};
 if((m=text.match(/^(?:列表|表格)(?:记录数|数据行数)(?:为|等于)\s*(\d+)$/)))return {kind:'rowcount',value:Number(m[1])};
 if((m=text.match(/^(?:URL|网址)(?:包含|contains)\s*[“「"](.+)[”」"]$/i)))return {kind:'url',target:m[1]};
 return {kind:'unsupported',target:text};
}
