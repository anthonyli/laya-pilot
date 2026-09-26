import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import {Halt} from './language.mjs';
const SYSTEM_PROMPT = `你是浏览器自动化测试的决策器。用户会给你一个 JSON：state（当前页面状态）与 questions.scenario（type=choice 的选择题，criteria 是候选操作）。
你必须只返回一个 JSON 对象（不要任何解释文字、markdown 代码块标记），结构如下：
{"result":{"answers":{"scenario":{"choice":"<criteria 中某个 key 原文>","probabilities":{"<每个 criteria 的 key>":<0到1的小数>},"confidence":<0到1的小数>}}}}
硬性要求：
1. choice 必须从 criteria 的 key 里选一个最能达成目标的；
2. probabilities 必须给 criteria 的每一个 key 打分，所有分数之和必须约等于 1（误差不超过 0.02）；
3. 所选 choice 的概率必须是所有候选中最大的；
4. 候选描述是操作意图（如「填写账号 Account Username」），控件名是页面实际文案（如「管理员邮箱」）——措辞不同但语义对应时必须选择该控件，禁止因措辞差异而选择停止；只有所有候选在语义上都不可行时才选停止；
5. 若页面状态不足以判断，仍必须按最可能的候选输出完整 JSON，禁止反问或输出其他内容。`;
export function decodeDecision(body,criteria){
 let payload;try{payload=JSON.parse(body?.choices?.[0]?.message?.content);}catch{throw new Halt('模型API错误','API未返回可解析的Laya决策JSON');}
 const result=payload?.result?.answers?.scenario;
 if(!result||!Object.hasOwn(criteria,result.choice))throw new Halt('模型API错误','API决策不属于本次候选集合');
 const probabilities=result.probabilities,keys=Object.keys(criteria);
 if(!probabilities||Object.keys(probabilities).length!==keys.length||keys.some(k=>typeof probabilities[k]!=='number'||!Number.isFinite(probabilities[k])||probabilities[k]<0||probabilities[k]>1))throw new Halt('模型API错误','API候选概率缺失或无效，不使用猜测分数');
 const sum=keys.reduce((n,k)=>n+probabilities[k],0);
 if(Math.abs(sum-1)>.02||keys.some(k=>probabilities[k]>probabilities[result.choice]))throw new Halt('模型API错误','API概率分布与选择不一致');
 return {choice:result.choice,probabilities,confidence:typeof result.confidence==='number'?result.confidence:null,server_ms:payload.latency_ms??null};
}
export class ApiDecision {
 constructor({base,model,key,timeout=60000,fetchImpl=fetch}){
  const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('API地址必须为不含凭据或查询参数的HTTPS地址');
  if(!key?.trim())throw Error('缺少LAYA_API_KEY');
  this.base=url.href.replace(/\/$/,'');this.model=model;this.key=key;this.timeout=timeout;this.fetch=fetchImpl;
 }
 async decide(state,criteria){
  const started=performance.now();let response;
  try{response=await this.fetch(this.base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(this.timeout),body:JSON.stringify({model:this.model,stream:false,max_tokens:4096,messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:JSON.stringify({state,questions:{scenario:{type:'choice',instructions:'用户请求对应哪个操作？',criteria}}})}]})});}
  catch{throw new Halt('模型API错误','API连接失败或超时，未回退到本地');}
  // Never include gateway bodies/headers in error logs: they may echo credentials.
  if(!response.ok)throw new Halt('模型API错误','API返回HTTP '+response.status+'，未回退到本地');
  let body;try{body=await response.json();}catch{throw new Halt('模型API错误','API响应不是JSON');}
  return {...decodeDecision(body,criteria),inference_ms:Math.round((performance.now()-started)*100)/100};
 }
}
export class Laya {
 constructor(python,worker,model,log,options={}){
  this.provider=options.provider||'local';if(!['local','api'].includes(this.provider))throw Error('provider仅支持local或api');
  if(this.provider==='api')this.api=new ApiDecision(options);
  this.model=model;this.log=log;this.seq=0;this.pending=new Map();this.cache=new Map();this.records=[];this.errors=[];
  const workerEnv={...process.env};delete workerEnv.TEST_PASSWORD;delete workerEnv.LAYA_API_KEY;
  this.proc=spawn(python,['-u',worker],{stdio:['pipe','pipe','pipe'],env:workerEnv});this.diagnostics='';
  this.proc.stderr.on('data',d=>{this.diagnostics=(this.diagnostics+d).slice(-4000);});
  readline.createInterface({input:this.proc.stdout}).on('line',s=>{try{const r=JSON.parse(s),p=this.pending.get(r.id);if(p){this.pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(r.error)):p.resolve(r);}}catch{}});
  this.proc.on('error',e=>this.fail(e));this.proc.on('exit',c=>this.fail(Error('Laya进程退出 '+c+' '+this.diagnostics)));
 }
 fail(e){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();}
 request(data){
  if(this.api&&data.action==='decide')return this.api.decide(data.state,data.criteria);
  if(this.api&&data.action==='load')return this.api.decide('继续',{继续:'继续',停止:'停止'}).then(r=>({load_ms:r.inference_ms,provider:'api'}));
  return new Promise((resolve,reject)=>{const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Laya请求超时'));this.proc.kill();},120000);this.pending.set(id,{resolve,reject,timer});this.proc.stdin.write(JSON.stringify({id,model:this.model,...data})+'\n');});}
 async choose(state,criteria,meta={}){
  const key=JSON.stringify({state,criteria}),cached=this.cache.get(key);
  let result;
  try{result=cached||await this.request({action:'decide',state,criteria});}
  catch(e){if(this.api){const failure={...meta,provider:'api',model:this.api.model,state,criteria,error:e.message};this.errors.push(failure);await fs.appendFile(this.log,JSON.stringify(failure)+'\n');}throw e;}
  if(!Object.hasOwn(criteria,result.choice))throw Error('Laya返回候选集合以外的结果');
  const values=Object.values(result.probabilities||{}).sort((a,b)=>b-a);
  const record={...meta,provider:this.provider,model:this.api?.model||this.model,state,criteria,choice:result.choice,confidence:result.confidence,probabilities:result.probabilities,margin:(values[0]||0)-(values[1]||0),inference_ms:cached?0:result.inference_ms,...(this.api?{server_ms:result.server_ms}:{}),cache_hit:!!cached};
  this.records.push(record);await fs.appendFile(this.log,JSON.stringify(record)+'\n');if(!cached)this.cache.set(key,result);return record;
 }
 close(){this.proc.stdin.end();}
}
