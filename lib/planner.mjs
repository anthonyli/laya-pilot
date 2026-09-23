import {describe,quoted,norm,Halt} from './language.mjs';

// Compile human phrasing into bounded tools, not executable model output.
// Scopes and alternatives come from live controls; values must come from the case.
export function scopeNames(text,controls){
 return [...new Set(controls.filter(c=>c.role==='tab'&&text.includes(c.name)).map(c=>c.name))];
}
export function expandStep(text,{controls=[],area=null}={}){
 const scopes=scopeNames(text,controls);
 if(/^切换.*Tab$/i.test(text)&&scopes.length>1){
  return (area&&scopes.includes(area)?[area]:scopes).map(target=>({verb:'click',target}));
 }
 let source=text;
 // A location prefix is context, not part of the button's accessible name.
 const scoped=text.match(/^在.+?(?:列表|页面|区)(?:中)?(点击|查看|观察|选择|输入|填写)(.+)$/);
 if(scoped)source=scoped[1]+scoped[2];
 if(/(?:找到|查找).*(?:数据|记录)$/.test(text))return [{verb:'bindRow',target:text}];
 if(/^(?:弹出|打开了).*(?:Drawer|Modal|抽屉|弹窗|对话框)$/i.test(source))return [{verb:'assertStep',target:source}];
 if(/^不填写任何必填字段$/.test(source))return [{verb:'emptyRequired',target:source}];
 if(/^鼠标悬[浮停]/.test(source))source=source.replace(/^鼠标悬[浮停](?:在)?/,'悬停在').replace(/置灰的/,'').replace(/(?:按钮)?上$/,'');
 if(/^在确认框中/.test(source)&&quoted(source).length===1)source='点击「'+quoted(source)[0]+'」';
 // Slash means alternative labels here, unlike tab coverage (handled above).
 if(/^点击/.test(source)&&source.includes('/')){
  const parts=source.replace(/^点击/,'').replace(/筛选按钮$|按钮$/,'').split('/');
  const matches=controls.filter(c=>parts.some(p=>norm(p)===norm(c.name)));
  if(matches.length===1)return [{verb:'click',target:matches[0].name}];
 }
 const spec=describe(source);
 if(spec.verb==='path'&&spec.path.length===1){
  const leaf=spec.path[0];
  const areaName=controls.find(c=>c.role==='tab'&&leaf.endsWith(c.name+'列表'))?.name;
  if(areaName){const module=leaf.slice(0,-(areaName+'列表').length);return [...(module?[{verb:'path',path:[module]}]:[]),{verb:'click',target:areaName}];}
 }
 return spec.verb==='unsupported'?[]:[spec];
}

// Unknown wording still reaches Laya. Only concrete, live, non-password targets
// and source-provided values are candidates; no invented selector or test value.
export async function semanticStep(text,snapshot,laya,{meta={},minProbability=.68,minMargin=.18}={}){
 const q=quoted(text),values=q.slice(1),normText=norm(text);
 const candidates=[];
 for(const c of snapshot.controls){
  if(c.role==='password'||c.disabled||!c.name||c.name.startsWith('图标:'))continue;
  const matched=normText.includes(norm(c.name))||q.some(t=>norm(c.name).includes(norm(t)));
  if(!matched)continue;
  if(['textbox','spinbutton'].includes(c.role)&&values.length===1&&/(输入|填写|填入|type|fill)/i.test(text))candidates.push({verb:'fill',target:c.name,value:values[0]});
  else if(['button','link','tab','menuitem'].includes(c.role)&&/(点击|单击|进入|打开|click|open)/i.test(text))candidates.push({verb:'click',target:c.name});
 }
 const unique=[...new Map(candidates.map(s=>[JSON.stringify(s),s])).values()].slice(0,6);
 const criteria=Object.fromEntries(unique.map((s,i)=>['动作'+(i+1),(s.verb==='fill'?'填写':'点击')+s.target+(s.value!==undefined?'，值='+s.value:'')]));
 criteria['缺少参数']='步骤要求操作，但没有足够明确的目标、测试值或可执行工具';
 criteria['停止']='指令与当前候选操作不匹配，不执行';
 const decision=await laya.choose(text,criteria,{...meta,phase:'step-planning',live_candidates:unique});
 const index=Object.keys(criteria).indexOf(decision.choice),spec=unique[index];
 if(!spec||(decision.probabilities?.[decision.choice]||0)<minProbability||decision.margin<minMargin)throw new Halt('执行能力不足','已让Laya结合当前控件判断，但仍不能形成参数完整的动作：'+text+'；需要补充通用工具或测试数据，不能认定用例错误');
 return [spec];
}

export function approvalOperation(c){
 // An approval state on a filter or disabled button is not an approval action.
 return /(?:进入|打开|提交|执行|进行|完成|发起|通过|驳回|拒绝|撤回|开启|关闭|配置|切换).{0,12}(?:审批|审核)|(?:审批|审核).{0,8}(?:通过|驳回|拒绝|开关|关闭|开启)|(?:审批人|审核人).{0,8}(?:登录|操作)|审批中心/.test(c.steps+'\n'+c.title);
}
