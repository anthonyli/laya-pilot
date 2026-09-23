import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import {Halt} from './language.mjs';
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
 constructor({base,model,key,timeout=30000,fetchImpl=fetch}){
  const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('API地址必须为不含凭据或查询参数的HTTPS地址');
  if(!key?.trim())throw Error('缺少LAYA_API_KEY');
  this.base=url.href.replace(/\/$/,'');this.model=model;this.key=key;this.timeout=timeout;this.fetch=fetchImpl;
 }
 async decide(state,criteria){
  const started=performance.now();let response;
  try{response=await this.fetch(this.base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(this.timeout),body:JSON.stringify({model:this.model,stream:false,messages:[{role:'user',content:JSON.stringify({state,questions:{scenario:{type:'choice',instructions:'用户请求对应哪个操作？',criteria}}})}]})});}
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
