// Planejamento P2 · tela do D+1. Por barra (OCP ou Equinor) e dia: a demanda de cada OS em HH por função
// (pessoas × horas por dia; sem horas, a jornada padrão da barra), a capacidade do dia (P1), a pilha por
// prioridade e a linha de corte (a primeira OS que não cabe até o teto; dali para baixo, nada entra).
// Zonas: até a meta, até 100%, esticado (até o teto, com registro de quem validou) e acima do teto.
// Ações: arrastar (prioridade da OS), adiar com prévia (rascunho muda direto; OS lançada vira revisão
// automática com motivo) e registrar a validação da zona esticada.
import {createHash} from 'node:crypto';
import {db,type Executor,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {capacity,loadBars,barRow,barOf,plusDays,weekday,type BarId} from './capacity';
import {dayStart,dayOf,dayText,lastDay,DAY_MS,EQUIPMENT_DAY_HOURS} from './days';
import {osNumber,loadPlan} from './planning';
import {startRevision,launchRevision} from './revision';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const YMD=/^\d{4}-\d{2}-\d{2}$/;
const REVISABLE=['programada','em_andamento'];
const DONE=['concluida','dispensada'];
export type Zone='meta'|'cheio'|'esticado'|'acima';
type Actor=Member&{planning_bars?:string[]};
const barName=(b:string)=>b==='ocp'?'OCP':'Equinor';
const round=(n:number)=>Math.round(n*100)/100;

const viewer=(m:Member)=>requireAny(m,['planejamento','operacao','acompanhamento']);
/** Quem planeja só uma barra mexe só nela (a Gestão e o planejador sem restrição mexem nas duas). */
async function planner(m:Member,bar:string){
 const a=await requireAny(m,['planejamento']) as Actor;
 const mine=a.planning_bars||[];
 if(!isManager(a)&&mine.length&&!mine.includes(bar))throw new AppError(`Você planeja a barra ${mine.map(barName).join(' e ')}: esta OS é da barra ${barName(bar)}.`,403);
 return a;
}
function dayParam(v:unknown,label='Dia'){
 const d=String(v||'');if(!YMD.test(d)||dayOf(dayStart(d))!==d)throw new AppError(`${label}: informe o dia (AAAA-MM-DD).`);return d;
}
const tomorrow=()=>plusDays(dayOf(Date.now()),1);

// ───────────── Demanda ─────────────
type Need={functionId:string,name:string,quantity:number,hours:number};
type StepRow={id:string,key:string,dependsOn:string[],name:string,start:string,end:string,done:boolean,needs:Need[],materials:{name:string,unit:string,amount:number}[],equipment:{id:string,tag:string,hours:number,start:string,end:string}[]};
type PlanRow={id:string,status:string,workOrderId:string|null,number:number|null,title:string,priority:number|null,skipSunday:boolean,start:string,end:string,createdAt:string,
 org:{id:string|null,acronym:string|null,name:string|null,color:string|null},location:string|null,bar:string,started:boolean,steps:StepRow[]};

/** OS (lançadas, programadas ou em andamento) e rascunhos da barra que tocam o período [from, to]. */
async function loadPlans(bar:string,from:string,to:string,extraPlanId?:string):Promise<PlanRow[]>{
 const lo=dayStart(from),hi=dayStart(plusDays(to,1)),defH=Number((await loadBars()).find(b=>b.id===bar)!.default_need_hours);
 const plans=await db().all(`SELECT p.id,p.status,p.work_order_id,p.title,p.description,p.priority,p.skip_sunday,p.planned_start,p.planned_end,p.created_at,
   o.id org_id,o.acronym,o.name org_name,o.color,coalesce(o.bar,'equinor') bar,w.number,at.name type_name,l.name location_name
  FROM plans p LEFT JOIN requester_orgs o ON o.id=p.org_id LEFT JOIN work_orders w ON w.id=p.work_order_id LEFT JOIN activity_types at ON at.id=p.activity_type_id LEFT JOIN locations l ON l.id=p.location_id
  WHERE coalesce(o.bar,'equinor')=? AND p.planned_start IS NOT NULL AND p.planned_end IS NOT NULL
   AND ((p.status='launched' AND w.status = ANY(?::text[])) OR (p.status='draft' AND p.base_plan_id IS NULL AND p.mode IS DISTINCT FROM 'realizada'))
   AND ((p.planned_start<? AND p.planned_end>?) OR p.id=?)`,bar,REVISABLE,hi,lo,extraPlanId||'');
 if(!plans.length)return [];
 const ids=plans.map(p=>p.id);
 const [steps,needs,res,os,mats]=await Promise.all([
  db().all('SELECT id,plan_id,step_key,depends_on,name,position,planned_start,planned_end FROM plan_steps WHERE plan_id=ANY(?::text[]) AND included=1 ORDER BY position',ids),
  db().all(`SELECT n.plan_step_id,n.function_id,f.name,n.quantity,n.hours_per_day FROM plan_step_needs n JOIN job_functions f ON f.id=n.function_id WHERE n.plan_id=ANY(?::text[]) AND n.function_id IS NOT NULL`,ids),
  db().all(`SELECT r.plan_step_id,r.start_at,r.end_at,r.hours_per_day,e.id equipment_id,e.tag FROM reservations r JOIN equipment e ON e.id=r.equipment_id WHERE r.plan_id=ANY(?::text[]) AND r.status<>'liberada'`,ids),
  db().all('SELECT plan_step_id,status FROM os_steps WHERE plan_step_id IN (SELECT id FROM plan_steps WHERE plan_id=ANY(?::text[]))',ids),
  db().all('SELECT n.plan_step_id,m.name,n.unit,n.amount FROM plan_step_needs n JOIN materials m ON m.id=n.material_id WHERE n.plan_id=ANY(?::text[]) AND n.material_id IS NOT NULL',ids),
 ]);
 const osOf=new Map(os.map(o=>[o.plan_step_id as string,o.status as string]));
 return plans.map(p=>{
  const st=steps.filter(s=>s.plan_id===p.id).map(s=>({id:s.id,key:s.step_key,dependsOn:(s.depends_on||[]) as string[],name:s.name,start:s.planned_start||p.planned_start,end:s.planned_end||p.planned_end,done:DONE.includes(osOf.get(s.id)||''),
   needs:needs.filter(n=>n.plan_step_id===s.id).map(n=>({functionId:n.function_id,name:n.name,quantity:Number(n.quantity),hours:n.hours_per_day==null?defH:Number(n.hours_per_day)})),
   materials:mats.filter(m=>m.plan_step_id===s.id).map(m=>({name:m.name,unit:m.unit,amount:Number(m.amount)})),
   equipment:res.filter(r=>r.plan_step_id===s.id).map(r=>({id:r.equipment_id,tag:r.tag,hours:Number(r.hours_per_day??EQUIPMENT_DAY_HOURS),start:r.start_at,end:r.end_at}))}));
  return {id:p.id,status:p.status,workOrderId:p.work_order_id||null,number:p.number==null?null:Number(p.number),title:(p.title||'').trim()||p.type_name||p.description||'Sem título',
   priority:p.priority==null?null:Number(p.priority),skipSunday:Number(p.skip_sunday)===1,start:p.planned_start,end:p.planned_end,createdAt:p.created_at,
   org:{id:p.org_id||null,acronym:p.acronym||null,name:p.org_name||null,color:p.color||null},location:p.location_name||null,bar:p.bar,
   started:st.some(s=>{const x=osOf.get(s.id);return !!x&&x!=='nao_iniciada';}),steps:st};
 });
}
/** Desloca as datas de uma OS (todas as etapas e reservas), para a prévia do adiamento. */
function shifted(p:PlanRow,days:number):PlanRow{
 const mv=(iso:string)=>new Date(Date.parse(iso)+days*DAY_MS).toISOString();
 return {...p,start:mv(p.start),end:mv(p.end),steps:p.steps.map(s=>({...s,start:mv(s.start),end:mv(s.end),equipment:s.equipment.map(e=>({...e,start:mv(e.start),end:mv(e.end)}))}))};
}
/** O que a OS ocupa no dia: etapas do dia (não encerradas), HH por função e horas de equipamento. */
function onDay(p:PlanRow,day:string){
 if(p.skipSunday&&weekday(day)===0)return null;
 const t=dayStart(day);
 const steps=p.steps.filter(s=>!s.done&&Date.parse(s.start)<=Date.parse(t)&&Date.parse(t)<Date.parse(s.end));
 if(!steps.length)return null;
 const by=new Map<string,{functionId:string,name:string,people:number,hh:number}>();
 for(const s of steps)for(const n of s.needs){const f=by.get(n.functionId)||{functionId:n.functionId,name:n.name,people:0,hh:0};f.people+=n.quantity;f.hh+=n.quantity*n.hours;by.set(n.functionId,f);}
 const equipment=steps.flatMap(s=>s.equipment.filter(e=>Date.parse(e.start)<=Date.parse(t)&&Date.parse(t)<Date.parse(e.end)).map(e=>({id:e.id,tag:e.tag,hours:e.hours})));
 const mats=new Map<string,{name:string,unit:string,amount:number}>();
 for(const s of steps)for(const m of s.materials){const k=m.name+'|'+m.unit,x=mats.get(k)||{name:m.name,unit:m.unit,amount:0};x.amount=round(x.amount+m.amount);mats.set(k,x);}
 // Dependência fora de ordem: etapa do dia que começa antes da etapa de que depende.
 const order=steps.flatMap(s=>s.dependsOn.map(k=>p.steps.find(x=>x.key===k)).filter(d=>d&&!d.done&&Date.parse(d.start)>Date.parse(s.start)).map(d=>`${s.name} começa antes de ${d!.name}`));
 const byFunction=[...by.values()].map(f=>({...f,hh:round(f.hh)})).sort((x,y)=>y.hh-x.hh);
 return {steps:steps.map(s=>s.name),byFunction,hh:round(byFunction.reduce((t,f)=>t+f.hh,0)),equipment,materials:[...mats.values()],order};
}
const order=(a:PlanRow,b:PlanRow)=>(a.priority??Infinity)-(b.priority??Infinity)||Date.parse(a.start)-Date.parse(b.start)||(a.number??Infinity)-(b.number??Infinity)||a.createdAt.localeCompare(b.createdAt);

function zoneOf(pct:number,z:number[]):Zone{return pct<=z[0]?'meta':pct<=z[1]?'cheio':pct<=z[2]?'esticado':'acima';}
const RANK:Record<Zone,number>={meta:0,cheio:1,esticado:2,acima:3};

/** Monta o dia: capacidade por função, pilha com a linha de corte e o total de cada função. */
async function compose(bar:BarId,day:string,plans:PlanRow[]){
 const [cap,barRowData]=await Promise.all([capacity(bar,[day]),loadBars().then(b=>barRow(b.find(x=>x.id===bar)!))]);
 const c=cap.days[0],z=barRowData.zones;
 const capOf=new Map<string,number>();for(const f of c.byFunction as Row[])if(f.functionId)capOf.set(f.functionId,Number(f.hours));
 const accepted=new Map<string,number>(),demand=new Map<string,number>(),names=new Map<string,string>();
 for(const f of c.byFunction as Row[])if(f.functionId)names.set(f.functionId,f.name);
 let cut:number|null=null;
 const cards=plans.map(p=>({p,d:onDay(p,day)})).filter(x=>x.d).sort((x,y)=>order(x.p,y.p)).map(({p,d},i)=>{
  let worst:Zone='meta',fits=cut==null;
  for(const f of d!.byFunction){
   names.set(f.functionId,f.name);demand.set(f.functionId,(demand.get(f.functionId)||0)+f.hh);
   const capH=capOf.get(f.functionId)||0,after=(accepted.get(f.functionId)||0)+f.hh;
   const zone:Zone=capH>0?zoneOf(after*100/capH,z):'acima';
   if(RANK[zone]>RANK[worst])worst=zone;
  }
  if(fits&&worst==='acima'){fits=false;cut=i;}
  if(fits)for(const f of d!.byFunction)accepted.set(f.functionId,(accepted.get(f.functionId)||0)+f.hh);
  return {planId:p.id,workOrderId:p.workOrderId,number:p.number,label:p.number!=null?osNumber(p.number):'Rascunho',title:p.title,status:p.status==='launched'?'lancada':'rascunho',
   org:p.org,location:p.location,priority:p.priority,firstDay:dayOf(p.start),lastDay:lastDay(p.end),started:p.started,skipSunday:p.skipSunday,
   steps:d!.steps,byFunction:d!.byFunction,hh:d!.hh,equipment:d!.equipment,materials:d!.materials,dependencyIssues:d!.order,fits,zone:worst};
 });
 const stretches=await db().all(`SELECT DISTINCT ON (function_id) function_id,validated_by,note,created_at,created_by_name,load_pct FROM plan_stretches WHERE bar=? AND day=?::date ORDER BY function_id,created_at DESC`,bar,day);
 const keys=new Set([...capOf.keys(),...demand.keys()]);
 const functions=[...keys].map(k=>{
  const capH=capOf.get(k)||0,acc=round(accepted.get(k)||0),dem=round(demand.get(k)||0),pct=capH>0?round(acc*100/capH):(acc>0?null:0);
  const s=stretches.find(x=>x.function_id===k);
  const zone:Zone=pct==null?'acima':zoneOf(pct,z);
  return {functionId:k,name:names.get(k)||'Função',capacity:capH,demand:dem,accepted:acc,pct,zone,
   stretch:zone==='esticado'&&s?{validatedBy:s.validated_by,note:s.note||null,at:s.created_at,byName:s.created_by_name}:null};
 }).sort((x,y)=>y.capacity-x.capacity||y.demand-x.demand||x.name.localeCompare(y.name,'pt-BR'));
 for(const f of c.byFunction as Row[])if(!f.functionId)functions.push({functionId:'',name:f.name,capacity:Number(f.hours),demand:0,accepted:0,pct:0,zone:'meta',stretch:null});
 return {bar:barRowData,day,weekday:weekday(day),shift:c.shift,people:(c.people as Row[]).length,absent:(c.absent as Row[]).length,
  capacityTotal:Number(c.total),demandTotal:round(cards.reduce((t,x)=>t+x.hh,0)),acceptedTotal:round(cards.filter(x=>x.fits).reduce((t,x)=>t+x.hh,0)),
  functions,cards,cutAt:cut,pendingStretch:functions.filter(f=>f.zone==='esticado'&&!f.stretch).map(f=>f.name)};
}

type Board=Awaited<ReturnType<typeof compose>>;
/** Retrato comparável do dia (ordem, HH, funções, equipamento, materiais): muda quando o dia muda. */
const fingerprint=(b:Board)=>createHash('sha256').update(JSON.stringify(b.cards.map(c=>[c.planId,c.hh,c.byFunction.map(f=>[f.functionId,f.hh]),c.equipment.map(e=>[e.tag,e.hours]),c.materials.map(m=>[m.name,m.unit,m.amount]),c.steps]))).digest('hex');
async function marksOf(bar:string,day:string){
 const rows=await db().all('SELECT plan_id,mark,note,updated_by_name,updated_at FROM plan_d1_marks WHERE bar=? AND day=?::date',bar,day);
 return new Map(rows.map(r=>[r.plan_id as string,{mark:r.mark as string,note:r.note||null,byName:r.updated_by_name as string,at:r.updated_at as string}]));
}
async function lastPublication(bar:string,day:string,version?:number){
 return await db().first(`SELECT * FROM plan_d1_publications WHERE bar=? AND day=?::date${version?' AND version=?':''} ORDER BY version DESC LIMIT 1`,bar,day,...(version?[version]:[]));
}
/** Conferência para publicar: o que ainda impede (lista vazia = pode publicar). */
async function pendingOf(board:Board,marks:Awaited<ReturnType<typeof marksOf>>){
 const out:string[]=[];
 const ids=[...new Set(board.cards.filter(c=>c.fits).flatMap(c=>c.equipment.map(e=>e.id)))];
 const blocked=ids.length?await db().all('SELECT i.equipment_id,e.tag FROM equipment_impediments i JOIN equipment e ON e.id=i.equipment_id WHERE i.released_at IS NULL AND i.equipment_id=ANY(?::text[])',ids):[];
 const hours=new Map<string,number>();
 for(const c of board.cards){
  const name=`${c.label} “${c.title}”`;
  if(c.status==='rascunho'){out.push(`Rascunho “${c.title}”: lance a OS ou adie.`);continue;}
  if(!c.fits){out.push(`${name} está abaixo da linha de corte: adie ou mude a ordem.`);continue;}
  const m=marks.get(c.planId);
  if(!m)out.push(`${name} não confirmada na reunião.`);
  else if(m.mark==='ajustar')out.push(`${name} marcada para Ajustar${m.note?`: ${m.note}`:''}.`);
  for(const d of c.dependencyIssues)out.push(`${name}: ${d}.`);
  for(const e of c.equipment){hours.set(e.tag,(hours.get(e.tag)||0)+e.hours);const b=blocked.find(x=>x.equipment_id===e.id);if(b)out.push(`${name}: ${b.tag} com impedimento técnico.`);}
 }
 for(const [tag,h] of hours)if(h>EQUIPMENT_DAY_HOURS)out.push(`${tag}: ${round(h)} h no dia (máximo ${EQUIPMENT_DAY_HOURS} h).`);
 for(const f of board.functions)if(f.zone==='esticado'&&!f.stretch)out.push(`Zona esticada sem validação: ${f.name} em ${f.pct}%.`);
 return out;
}

export async function d1Board(member:Member,url:URL){
 await viewer(member);
 const bar=barOf(url.searchParams.get('bar')||'equinor'),day=url.searchParams.get('day')?dayParam(url.searchParams.get('day')):tomorrow();
 const [board,marks,pub]=await Promise.all([loadPlans(bar,day,day).then(p=>compose(bar,day,p)),marksOf(bar,day),lastPublication(bar,day)]);
 const pending=await pendingOf(board,marks);
 return {...board,cards:board.cards.map(c=>({...c,mark:marks.get(c.planId)||null})),checks:{pending},
  publication:pub?{version:Number(pub.version),publishedAt:pub.published_at,by:pub.published_by_name,leaders:pub.leaders,justification:pub.justification||null,changed:pub.fingerprint!==fingerprint(board)}:null,
  generatedAt:now()};
}

/** Programação publicada (a versão pedida ou a última): para a TV, o celular do líder e a lista de separação. */
export async function d1Published(member:Member,url:URL){
 await viewer(member);
 const bar=barOf(url.searchParams.get('bar')||'equinor'),day=url.searchParams.get('day')?dayParam(url.searchParams.get('day')):tomorrow();
 const v=url.searchParams.get('version')?Number(url.searchParams.get('version')):undefined;
 if(v!==undefined&&(!Number.isInteger(v)||v<1))throw new AppError('Versão inválida.');
 const [pub,versions]=await Promise.all([lastPublication(bar,day,v),db().all('SELECT version,published_at,published_by_name,justification FROM plan_d1_publications WHERE bar=? AND day=?::date ORDER BY version DESC',bar,day)]);
 return {bar,day,version:pub?Number(pub.version):null,publishedAt:pub?.published_at||null,publishedBy:pub?.published_by_name||null,leaders:pub?.leaders||[],justification:pub?.justification||null,
  snapshot:pub?.snapshot||null,versions:versions.map(x=>({version:Number(x.version),publishedAt:x.published_at,by:x.published_by_name,justification:x.justification||null}))};
}

/** Alerta das 16:00 (Brasília): barras com OS no dia seguinte e sem publicação. */
export async function d1Late(nowMs=Date.now()){
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'}).format(new Date(nowMs)));
 if(hour<16)return [];
 const day=plusDays(dayOf(nowMs),1),out:{bar:string,barName:string,day:string,cards:number}[]=[];
 for(const bar of ['equinor','ocp'] as BarId[]){
  if(await lastPublication(bar,day))continue;
  const plans=await loadPlans(bar,day,day),n=plans.filter(p=>onDay(p,day)).length;
  if(n)out.push({bar,barName:barName(bar),day,cards:n});
 }
 return out;
}

/** Prévia do adiamento: nos dias que a OS passa a ocupar, a carga de cada função antes e depois, e o equipamento. */
export async function d1Preview(member:Member,url:URL){
 await viewer(member);
 const planId=text(url.searchParams.get('plan'),64),days=stepDays(url.searchParams.get('days'));
 const plan=await planInfo(planId);
 const target=shifted(plan,days),newDays=daysOfPlan(target);
 const all=await loadPlans(plan.bar,newDays[0],newDays[newDays.length-1],plan.id);
 const others=all.filter(p=>p.id!==plan.id);
 const out=[];
 for(const day of newDays){
  const [before,after]=await Promise.all([compose(plan.bar as BarId,day,all),compose(plan.bar as BarId,day,[...others,target])]);
  const mine=onDay(target,day);
  out.push({day,functions:(mine?.byFunction||[]).map(f=>{
   const b=before.functions.find(x=>x.functionId===f.functionId),a=after.functions.find(x=>x.functionId===f.functionId);
   return {functionId:f.functionId,name:f.name,capacity:a?.capacity||0,before:b?.demand||0,after:a?.demand||0,pctAfter:a?.capacity?round((a.demand*100)/a.capacity):null,
    zoneAfter:a?.capacity?zoneOf((a.demand*100)/a.capacity,after.bar.zones):'acima'};
  }),fits:after.cards.find(c=>c.planId===plan.id)?.fits??true,equipment:await equipmentLoad(target,day)});
 }
 return {plan:{id:plan.id,label:plan.number!=null?osNumber(plan.number):'Rascunho',title:plan.title,status:plan.status,started:plan.started},
  from:{first:dayOf(plan.start),last:lastDay(plan.end)},to:{first:dayOf(target.start),last:lastDay(target.end)},days:out,
  needsReason:plan.status==='launched',blocked:plan.started?'OS já iniciada: ajuste as datas pela revisão da OS.':null};
}
function stepDays(v:unknown){const n=v==null||v===''?1:Number(v);if(!Number.isInteger(n)||n<1||n>14)throw new AppError('Adiar de 1 a 14 dias.');return n;}
function daysOfPlan(p:PlanRow){const out:string[]=[];for(let d=dayOf(p.start);d<=lastDay(p.end);d=plusDays(d,1))out.push(d);return out;}
async function planInfo(planId:string){
 const base=await db().first(`SELECT p.planned_start,p.planned_end,coalesce(o.bar,'equinor') bar FROM plans p LEFT JOIN requester_orgs o ON o.id=p.org_id WHERE p.id=? AND p.status IN ('draft','launched')`,planId);
 if(!base||!base.planned_start)throw new AppError('OS ou rascunho não encontrado no planejamento.',404);
 const plan=(await loadPlans(base.bar,dayOf(base.planned_start),lastDay(base.planned_end),planId)).find(p=>p.id===planId);
 if(!plan)throw new AppError('Esta OS não está mais programada.',409);
 return plan;
}
/** Equipamento no dia: horas desta OS e das outras OS lançadas (até 12 h por equipamento). */
async function equipmentLoad(p:PlanRow,day:string){
 const mine=onDay(p,day)?.equipment||[];if(!mine.length)return [];
 const t=dayStart(day);
 const rows=await db().all(`SELECT e.tag,sum(coalesce(r.hours_per_day,?))::float8 hours FROM reservations r JOIN equipment e ON e.id=r.equipment_id JOIN plans p ON p.id=r.plan_id
  WHERE r.status='confirmada' AND p.id<>? AND (p.work_order_id IS NULL OR p.work_order_id IS DISTINCT FROM (SELECT work_order_id FROM plans WHERE id=?)) AND e.tag = ANY(?::text[]) AND r.start_at<=? AND r.end_at>? GROUP BY e.tag`,
  EQUIPMENT_DAY_HOURS,p.id,p.id,mine.map(m=>m.tag),t,t);
 return mine.map(m=>{const other=Number(rows.find(r=>r.tag===m.tag)?.hours||0);return {tag:m.tag,hours:m.hours,others:other,total:round(m.hours+other),over:m.hours+other>EQUIPMENT_DAY_HOURS};});
}

// ───────────── Ações ─────────────
/** Desloca em N dias as datas do planejamento, das etapas e das reservas ativas (dia inteiro de Brasília). */
async function shiftDates(tx:Executor,planId:string,days:number){
 const mv=(col:string)=>`to_char((${col}::timestamptz + make_interval(days => ?)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
 await tx.run(`UPDATE plans SET planned_start=${mv('planned_start')},planned_end=${mv('planned_end')} WHERE id=?`,days,days,planId);
 await tx.run(`UPDATE plan_steps SET planned_start=CASE WHEN planned_start IS NULL THEN NULL ELSE ${mv('planned_start')} END,planned_end=CASE WHEN planned_end IS NULL THEN NULL ELSE ${mv('planned_end')} END WHERE plan_id=?`,days,days,planId);
 await tx.run(`UPDATE reservations SET start_at=${mv('start_at')},end_at=${mv('end_at')} WHERE plan_id=? AND status<>'liberada'`,days,days,planId);
}
async function reorder(member:Member,b:Row){
 const bar=barOf(b.bar),a=await planner(member,bar),day=dayParam(b.day);
 if(!Array.isArray(b.order)||b.order.length>500)throw new AppError('Ordem inválida. Atualize a tela.');
 const ids=[...new Set(b.order.map((x:unknown)=>text(x,64)).filter(Boolean))] as string[];
 const rows=ids.length?await db().all(`SELECT p.id,coalesce(o.bar,'equinor') bar FROM plans p LEFT JOIN requester_orgs o ON o.id=p.org_id WHERE p.id=ANY(?::text[]) AND p.status IN ('draft','launched')`,ids):[];
 if(rows.length!==ids.length||rows.some(r=>r.bar!==bar))throw new AppError('A pilha mudou. Atualize a tela.',409);
 await db().tx(async tx=>{
  for(const [i,pid] of ids.entries())await tx.run('UPDATE plans SET priority=? WHERE id=?',(i+1)*10,pid);
  await audit(tx,a,'Planejamento: ordem do D+1',`${bar}:${day}`,{bar,day,order:ids});
 });
 return {ok:true,message:'Ordem salva.'};
}

async function postpone(member:Member,b:Row){
 const planId=text(b.plan,64),days=stepDays(b.days),plan=await planInfo(planId);
 const a=await planner(member,plan.bar);
 if(plan.started)throw new AppError('OS já iniciada: ajuste as datas pela revisão da OS.',409);
 const target=shifted(plan,days),to=`${dayText(dayOf(target.start))}${dayOf(target.start)!==lastDay(target.end)?' a '+dayText(lastDay(target.end)):''}`;
 if(plan.status==='draft'){
  await db().tx(async tx=>{
   const p=await tx.first("SELECT id,version FROM plans WHERE id=? AND status='draft' FOR UPDATE",plan.id);
   if(!p)throw new AppError('O rascunho mudou. Atualize a tela.',409);
   await shiftDates(tx,plan.id,days);
   await tx.run('UPDATE plans SET updated_at=?,version=version+1 WHERE id=?',now(),plan.id);
   await audit(tx,a,'Planejamento: rascunho adiado no D+1',plan.id,{days,to,reason:text(b.reason,1200)||null});
  });
  return {ok:true,message:`Rascunho adiado para ${to}.`};
 }
 const reason=required(b.reason,'Motivo do adiamento',1200);
 // OS lançada: revisão automática (mesmo processo da revisão manual), com as datas deslocadas.
 const draft=await db().tx(async tx=>{
  const open=await tx.first("SELECT id FROM plans WHERE work_order_id=? AND status='draft'",plan.workOrderId);
  if(open)throw new AppError('Esta OS já tem uma revisão em rascunho. Lance ou descarte a revisão antes de adiar pelo D+1.',409);
  const r=await startRevision(tx,a as Member&{org_scope:string[]},plan.workOrderId!);
  await shiftDates(tx,r.id,days);
  return r.id as string;
 });
 const fresh=await loadPlan(draft);
 try{
  const r=await launchRevision(a as Member&{org_scope:string[]},{id:draft,version:fresh!.version,launchKey:id(),reason:`Adiada ${days} dia${days>1?'s':''} no D+1 (para ${to}): ${reason}`}) as Row;
  return {ok:true,message:`${r.message} Nova data: ${to}.`};
 }catch(e){
  // Não deu para lançar (equipamento, impedimento…): descarta o rascunho da revisão e devolve o motivo.
  await db().tx(async tx=>{
   await tx.run("UPDATE reservations SET status='liberada',released_at=?,release_reason=? WHERE plan_id=? AND status<>'liberada'",now(),'Adiamento pelo D+1 não concluído',draft);
   await tx.run("UPDATE plans SET status='discarded',updated_at=?,version=version+1 WHERE id=? AND status='draft'",now(),draft);
  });
  throw e;
 }
}

async function stretch(member:Member,b:Row){
 const bar=barOf(b.bar),a=await planner(member,bar),day=dayParam(b.day);
 const fid=required(b.functionId,'Função',64);
 const by=required(b.validatedBy,'Quem validou',120);
 if(by.length<2)throw new AppError('Quem validou: informe o nome.');
 const board=await compose(bar,day,await loadPlans(bar,day,day));
 const f=board.functions.find(x=>x.functionId===fid);
 if(!f||f.zone!=='esticado')throw new AppError(f?.zone==='acima'?'Esta função passou do teto: adie atividades antes de validar.':'Esta função está dentro de 100%: não há o que validar.',409);
 const note=text(b.note,300)||null,t=now();
 await db().tx(async tx=>{
  await tx.run('INSERT INTO plan_stretches(id,bar,day,function_id,function_name,load_pct,validated_by,note,created_at,created_by,created_by_name) VALUES(?,?,?::date,?,?,?,?,?,?,?,?)',id(),bar,day,fid,f.name,f.pct??0,by,note,t,a.id,a.name);
  await audit(tx,a,'Planejamento: zona esticada validada',`${bar}:${day}`,{bar,day,function:f.name,pct:f.pct,validatedBy:by,note});
 });
 return {ok:true,message:`${f.name} em ${f.pct}% validado por ${by}.`};
}

async function markCard(member:Member,b:Row){
 const bar=barOf(b.bar),a=await planner(member,bar),day=dayParam(b.day),planId=required(b.plan,'OS',64);
 const mark=b.mark==null||b.mark===''?null:String(b.mark);
 if(mark!==null&&!['confirmado','ajustar'].includes(mark))throw new AppError('Marcação inválida: Confirmado ou Ajustar.');
 const board=await compose(bar,day,await loadPlans(bar,day,day));
 const card=board.cards.find(c=>c.planId===planId);
 if(!card)throw new AppError('Esta OS não está mais neste dia. Atualize a tela.',409);
 const note=text(b.note,300)||null;
 await db().tx(async tx=>{
  if(mark===null)await tx.run('DELETE FROM plan_d1_marks WHERE bar=? AND day=?::date AND plan_id=?',bar,day,planId);
  else await tx.run(`INSERT INTO plan_d1_marks(bar,day,plan_id,mark,note,updated_at,updated_by,updated_by_name) VALUES(?,?::date,?,?,?,?,?,?)
   ON CONFLICT(bar,day,plan_id) DO UPDATE SET mark=excluded.mark,note=excluded.note,updated_at=excluded.updated_at,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name`,bar,day,planId,mark,note,now(),a.id,a.name);
  await audit(tx,a,'Planejamento: OS marcada na reunião do D+1',planId,{bar,day,label:card.label,mark,note});
 });
 return {ok:true,message:mark==='confirmado'?`${card.label} confirmada.`:mark==='ajustar'?`${card.label} marcada para Ajustar.`:'Marcação removida.'};
}

async function publish(member:Member,b:Row){
 const bar=barOf(b.bar),a=await planner(member,bar),day=dayParam(b.day);
 if(!Array.isArray(b.leaders))throw new AppError('Informe as lideranças presentes na reunião.');
 const leaders=[...new Set(b.leaders.map((x:unknown)=>text(x,120).replace(/\s+/g,' ')).filter((x:string)=>x.length>=2))] as string[];
 if(!leaders.length||leaders.length>30)throw new AppError('Informe as lideranças presentes na reunião (de 1 a 30 nomes).');
 const [board,marks,last]=await Promise.all([loadPlans(bar,day,day).then(p=>compose(bar,day,p)),marksOf(bar,day),lastPublication(bar,day)]);
 const pending=await pendingOf(board,marks);
 if(pending.length)throw new AppError(`Há ${pending.length} pendência${pending.length>1?'s':''} para publicar: ${pending.slice(0,3).join(' ')}${pending.length>3?' …':''}`,409,'PENDING',undefined,{pending});
 const version=last?Number(last.version)+1:1,fp=fingerprint(board);
 const justification=text(b.justification,1200)||null;
 if(version>1){
  if(!justification||justification.length<3)throw new AppError(`Justificativa: o D+1 já foi publicado (versão ${version-1}). Diga o que mudou e por quê.`);
  if(last!.fingerprint===fp)throw new AppError(`Nada mudou desde a versão ${version-1}.`,409);
 }
 const mats=new Map<string,{name:string,unit:string,amount:number}>();
 for(const c of board.cards)for(const m of c.materials){const k=m.name+'|'+m.unit,x=mats.get(k)||{name:m.name,unit:m.unit,amount:0};x.amount=round(x.amount+m.amount);mats.set(k,x);}
 const snapshot={bar:{id:bar,name:board.bar.name,color:board.bar.color,zones:board.bar.zones},day,weekday:board.weekday,capacityTotal:board.capacityTotal,acceptedTotal:board.acceptedTotal,
  cards:board.cards.map((c,i)=>({position:i+1,planId:c.planId,workOrderId:c.workOrderId,label:c.label,title:c.title,org:c.org,location:c.location,firstDay:c.firstDay,lastDay:c.lastDay,
   steps:c.steps,byFunction:c.byFunction,equipment:c.equipment.map(e=>({tag:e.tag,hours:e.hours})),materials:c.materials,hh:c.hh,zone:c.zone,note:marks.get(c.planId)?.note||null})),
  functions:board.functions.map(f=>({name:f.name,capacity:f.capacity,accepted:f.accepted,pct:f.pct,zone:f.zone,stretch:f.stretch})),
  materials:[...mats.values()].sort((x,y)=>x.name.localeCompare(y.name,'pt-BR'))};
 const t=now();
 try{
  await db().tx(async tx=>{
   await tx.run('INSERT INTO plan_d1_publications(id,bar,day,version,fingerprint,snapshot,leaders,justification,published_at,published_by,published_by_name) VALUES(?,?,?::date,?,?,?::text::jsonb,?::text[],?,?,?,?)',
    id(),bar,day,version,fp,JSON.stringify(snapshot),leaders,justification,t,a.id,a.name);
   await audit(tx,a,'Planejamento: D+1 publicado',`${bar}:${day}`,{bar,day,version,leaders,justification,cards:board.cards.length});
  });
 }catch(e){if((e as {code?:string}).code==='23505')throw new AppError('Outra pessoa acabou de publicar este dia. Atualize a tela.',409);throw e;}
 return {ok:true,version,message:`D+1 da barra ${barName(bar)} de ${dayText(day)} publicado (versão ${version}).`};
}

export async function d1Get(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/d1')return d1Board(member,url);
 if(path==='planning/d1/preview')return d1Preview(member,url);
 if(path==='planning/d1/published')return d1Published(member,url);
 return null;
}
export async function d1Mutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/d1/order')return reorder(member,b);
 if(path==='planning/d1/postpone')return postpone(member,b);
 if(path==='planning/d1/stretch')return stretch(member,b);
 if(path==='planning/d1/mark')return markCard(member,b);
 if(path==='planning/d1/publish')return publish(member,b);
 return null;
}
