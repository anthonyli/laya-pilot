const MAX_EVENTS=60;

function errorBodySummary(body){
 if(typeof body!=='string'||body.length>20000)return '';
 try{
  const data=JSON.parse(body);
  if(!data||typeof data!=='object')return '';
  const code=data.code??data.errorCode??data.error_code;
  const message=data.message??data.msg??data.error_description??data.error?.message??data.error;
  const parts=[code,message].filter(v=>typeof v==='string'||typeof v==='number');
  return safeText(parts.join('：'),320);
 }catch{return '';}
}

export function safeUrl(raw){
 try{
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol))return '[non-http URL]';
  return url.origin+url.pathname;
 }catch{return '[invalid URL]';}
}

export function safeText(value,limit=500){
 return String(value??'')
  .replace(/https?:\/\/[^\s"'<>]+/gi,match=>safeUrl(match))
  .replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]')
  .replace(/\bsk-[A-Za-z0-9_-]+\b/g,'[REDACTED]')
  .replace(/\b(password|passwd|token|api[_-]?key|secret)\b\s*[:=]\s*[^\s,;]+/gi,'$1=[REDACTED]')
  .replace(/[\r\n\t]+/g,' ').slice(0,limit);
}

export class BrowserDiagnostics {
 constructor(context){
  this.active=null;
  this.requests=new WeakMap();
  context.on('request',request=>{
   if(this.active)this.requests.set(request,{owner:this.active,step:this.active.step});
  });
  context.on('response',response=>{
   const request=response.request(),kind=request.resourceType(),status=response.status();
   if(!['xhr','fetch'].includes(kind)||status<400)return;
   const attribution=this.requests.get(request);
   if(!attribution||attribution.owner!==this.active)return;
   const owner=this.active;
   const event=this.add({kind:'http',status,method:request.method(),url:safeUrl(response.url()),detail:safeText(response.statusText(),160),step:attribution.step});
   if(owner&&event&&/json/i.test(response.headers()['content-type']||'')){
    const pending=Promise.race([response.text(),new Promise(resolve=>setTimeout(()=>resolve(''),700))])
     .then(body=>{const summary=errorBodySummary(body);if(summary)event.detail=summary;}).catch(()=>{});
    owner.pending.push(pending);
   }
  });
  context.on('requestfailed',request=>{
   if(!['xhr','fetch','document'].includes(request.resourceType()))return;
   const attribution=this.requests.get(request);
   if(!attribution||attribution.owner!==this.active)return;
   const detail=safeText(request.failure()?.errorText||'请求未完成',200);
   this.add({kind:/ERR_ABORTED|NS_BINDING_ABORTED/i.test(detail)?'requestcancelled':'requestfailed',method:request.method(),url:safeUrl(request.url()),detail,step:attribution.step});
  });
  for(const page of context.pages())this.attachPage(page);
  context.on('page',page=>this.attachPage(page));
 }
 attachPage(page){
  page.on('pageerror',error=>this.add({kind:'pageerror',detail:safeText(error.message)}));
  page.on('console',entry=>{if(entry.type()==='error')this.add({kind:'console',detail:safeText(entry.text())});});
  page.on('crash',()=>this.add({kind:'crash',detail:'页面进程崩溃'}));
 }
 add(event){
  if(!this.active||this.active.events.length>=MAX_EVENTS)return;
  const saved={time:new Date().toISOString(),...event,step:event.step??this.active.step??null};this.active.events.push(saved);return saved;
 }
 begin(id){if(this.active)throw Error('上一条用例的错误收集尚未结束');this.active={id,events:[],pending:[],step:null};}
 setStep(step){if(this.active)this.active.step=step?{...step}:null;}
 async end(){const owner=this.active;this.active=null;if(!owner)return [];await Promise.allSettled(owner.pending);return owner.events;}
}

export function eventLabel(event){
 if(event.kind==='http')return `HTTP ${event.status} ${event.method} ${event.url}${event.detail?'：'+event.detail:''}`;
 if(event.kind==='requestfailed')return `请求失败 ${event.method} ${event.url}：${event.detail}`;
 if(event.kind==='requestcancelled')return `请求取消 ${event.method} ${event.url}：${event.detail}`;
 if(event.kind==='pageerror')return `前端异常：${event.detail}`;
 if(event.kind==='crash')return '浏览器页面崩溃';
 return `控制台错误：${event.detail}`;
}

export function severeEvent(events){
 return events.find(e=>e.kind==='crash')
  ||events.find(e=>e.kind==='requestfailed')
  ||events.find(e=>e.kind==='http'&&e.status>=500)
  ||events.find(e=>e.kind==='http'&&[401,403].includes(e.status))
  ||events.find(e=>e.kind==='http')
  ||events.find(e=>e.kind==='pageerror');
}

export function diagnoseFailure(error,events=[]){
 const crash=events.find(e=>e.kind==='crash');
 const network=events.find(e=>e.kind==='requestfailed');
 const server=events.find(e=>e.kind==='http'&&e.status>=500);
 const auth=events.find(e=>e.kind==='http'&&[401,403].includes(e.status));
 const client=events.find(e=>e.kind==='http'&&e.status>=400);
 const script=events.find(e=>e.kind==='pageerror');
 const text=safeText(error,700);
 let category,assessment,primary;
 if(crash||/Target page.*closed|browser.*disconnected/i.test(text)){
  category='浏览器异常';assessment='页面进程或浏览器中断，当前用例未完成';primary=crash;
 }else if(network){
  category='网络请求失败';assessment='接口请求未完成；需排查网络、服务可用性和请求取消原因';primary=network;
 }else if(server){
  category='接口 HTTP 5xx';assessment='用例期间接口返回服务端错误；优先排查接口与后端日志';primary=server;
 }else if(auth){
  category='接口权限或登录错误';assessment='接口返回 401/403；需核对登录会话和账号权限';primary=auth;
 }else if(client){
  category='接口 HTTP 4xx';assessment='接口拒绝请求；需结合请求参数和业务规则区分用例数据与产品问题';primary=client;
 }else if(script){
  category='前端脚本异常';assessment='页面出现未捕获的 JavaScript 错误；优先排查前端';primary=script;
 }else if(/执行需要 --data|表单还有必填字段|未知数据变量/.test(text)){
  category='测试数据不足';assessment='用例所需数据未提供，不能判定产品功能失败';
 }else if(/Laya未能确定|Laya选择.*把握不足/.test(text)){
  category='模型无法可靠定位';assessment='Laya 未能在可见候选中作出可靠选择，尚不能判定产品功能';
 }else if(/页面上没有可操作|找不到本轮独立记录|决策后页面控件已变化|复现「/.test(text)){
  category='控件或页面状态不匹配';assessment='实际页面与记录步骤不一致；需核对用例、权限和页面变化';
 }else if(/列表没有|列表仍有|Timeout|等待|waitFor/.test(text)){
  category='页面结果与预期不符';assessment='页面断言未满足；需结合截图与轨迹区分产品问题和用例预期问题';
 }else{
  category='执行步骤失败';assessment='现有证据不足以区分用例问题与产品问题，需查看浏览器轨迹';
 }
 return {category,assessment,primary:primary?eventLabel(primary):null,observed:events.map(eventLabel)};
}
