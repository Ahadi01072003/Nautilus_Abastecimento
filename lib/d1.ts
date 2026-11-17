// Programação do dia · o dia de cada barra (OCP ou Equinor): as OS do dia em ordem, o HH de cada uma (duração estimada ×
// pessoas) contra o HH disponível (janelas do cadastro e da escala), a barra de duração (informativa), os recursos do dia
// e a consolidação da reunião das 16h (retrato imutável das duas barras, com participantes e observações). OS que entra
// no dia depois da 1ª consolidação é Emergencial. Passar do limite só avisa.
import {createHash} from 'node:crypto';
import {db,type Executor,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {loadBars,barRow,barOf,barName,plusDays,weekday,staffFor,hText,roundHh,BARS,type BarId} from './capacity';
import {dayStart,dayOf,dayText,lastDay,DAY_MS} from './days';
import {osNumber,loadPlan} from './planning';
import {startRevision,launchRevision} from './revision';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const YMD=/^\d{4}-\d{2}-\d{2}$/;
const REVISABLE=['programada','em_andamento'];
const DONE=['concluida','dispensada'];
type Actor=Member&{planning_bars?:string[]};
const round=(n:number)=>Math.round(n*1000)/1000;

const viewer=(m:Member)=>requireAny(m,['planejamento','operacao','acompanhamento']);
/** Quem planeja só uma barra mexe só nela (a Gestão e o planejador sem restrição mexem nas duas). */
async function planner(m:Member,bar:string){
 const a=await requireAny(m,['planejamento']) as Actor;
 const mine=a.planning_bars||[];
 if(!isManager(a)&&mine.length&&!mine.includes(bar))throw new AppError(`Você planeja a barra ${mine.map(barName).join(' e ')}: esta é a barra ${barName(bar)}.`,403);
 return a;
}
function dayParam(v:unknown,label='Dia'){
 const d=String(v||'');if(!YMD.test(d)||dayOf(dayStart(d))!==d)throw new AppError(`${label}: informe o dia (AAAA-MM-DD).`);return d;
}
const tomorrow=()=>plusDays(dayOf(Date.now()),1);

// ───────────── As OS do dia ─────────────
type StepRow={id:string,name:string,start:string,end:string,done:boolean,needs:{functionId:string,name:string,quantity:number}[],materials:{name:string,unit:string,amount:number}[],equipment:{id:string,tag:string,start:string,end:string}[]};
type PlanRow={id:string,status:string,workOrderId:string|null,number:number|null,title:string,priority:number|null,team:{functionId:string,name:string,quantity:number}[],hours:number|null,start:string,end:string,createdAt:string,
 org:{id:string|null,acronym:string|null,name:string|null,color:string|null},location:string|null,bar:string,started:boolean,steps:StepRow[]};

/** OS (lançadas, programadas ou em andamento) e rascunhos da barra que tocam o período [from, to]. */
async function loadPlans(bar:string,from:string,to:string,extraPlanId?:string,closed=false):Promise<PlanRow[]>{
 const lo=dayStart(from),hi=dayStart(plusDays(to,1));
 const plans=await db().all(`SELECT p.id,p.status,p.work_order_id,p.title,p.description,p.priority,p.team,p.estimated_hours,p.planned_start,p.planned_end,p.created_at,
   o.id org_id,o.acronym,o.name org_name,o.color,coalesce(o.bar,'equinor') bar,w.number,at.name type_name,l.name location_name
  FROM plans p LEFT JOIN requester_orgs o ON o.id=p.org_id LEFT JOIN work_orders w ON w.id=p.work_order_id LEFT JOIN activity_types at ON at.id=p.activity_type_id LEFT JOIN locations l ON l.id=p.location_id
  WHERE coalesce(o.bar,'equinor')=? AND p.planned_start IS NOT NULL AND p.planned_end IS NOT NULL
   AND (${closed?"(p.status='launched' AND w.status<>'cancelada')":"(p.status='launched' AND w.status = ANY(?::text[])) OR (p.status='draft' AND p.base_plan_id IS NULL AND p.mode IS DISTINCT FROM 'realizada')"})
   AND ((p.planned_start<? AND p.planned_end>?) OR p.id=?)`,...[bar,...(closed?[]:[REVISABLE]),hi,lo,extraPlanId||'']);
 if(!plans.length)return [];
 const ids=plans.map(p=>p.id);
 const fnNames=new Map((await db().all('SELECT id,name FROM job_functions')).map(f=>[f.id as string,f.name as string]));
 const [steps,needs,res,os,mats]=await Promise.all([
  db().all('SELECT id,plan_id,name,position,planned_start,planned_end FROM plan_steps WHERE plan_id=ANY(?::text[]) AND included=1 ORDER BY position',ids),
  db().all(`SELECT n.plan_step_id,n.function_id,f.name,n.quantity FROM plan_step_needs n JOIN job_functions f ON f.id=n.function_id WHERE n.plan_id=ANY(?::text[]) AND n.function_id IS NOT NULL`,ids),
  db().all(`SELECT r.plan_step_id,r.start_at,r.end_at,e.id equipment_id,e.tag FROM reservations r JOIN equipment e ON e.id=r.equipment_id WHERE r.plan_id=ANY(?::text[]) AND r.status<>'liberada'`,ids),
  db().all('SELECT plan_step_id,status FROM os_steps WHERE plan_step_id IN (SELECT id FROM plan_steps WHERE plan_id=ANY(?::text[]))',ids),
  db().all('SELECT n.plan_step_id,m.name,n.unit,n.amount FROM plan_step_needs n JOIN materials m ON m.id=n.material_id WHERE n.plan_id=ANY(?::text[]) AND n.material_id IS NOT NULL',ids),
 ]);
 const osOf=new Map(os.map(o=>[o.plan_step_id as string,o.status as string]));
 return plans.map(p=>{
  const st=steps.filter(s=>s.plan_id===p.id).map(s=>({id:s.id,name:s.name,start:s.planned_start||p.planned_start,end:s.planned_end||p.planned_end,done:DONE.includes(osOf.get(s.id)||''),
   needs:needs.filter(n=>n.plan_step_id===s.id).map(n=>({functionId:n.function_id,name:n.name,quantity:Number(n.quantity)})),
   materials:mats.filter(m=>m.plan_step_id===s.id).map(m=>({name:m.name,unit:m.unit,amount:Number(m.amount)})),
   equipment:res.filter(r=>r.plan_step_id===s.id).map(r=>({id:r.equipment_id,tag:r.tag,start:r.start_at,end:r.end_at}))}));
  return {id:p.id,status:p.status,workOrderId:p.work_order_id||null,number:p.number==null?null:Number(p.number),title:(p.title||'').trim()||p.type_name||p.description||'Sem título',
   priority:p.priority==null?null:Number(p.priority),team:((p.team||[]) as Row[]).map(t=>({functionId:t.functionId,name:fnNames.get(t.functionId)||'Função',quantity:Number(t.quantity)})),hours:p.estimated_hours==null?null:Number(p.estimated_hours),
   start:p.planned_start,end:p.planned_end,createdAt:p.created_at,
   org:{id:p.org_id||null,acronym:p.acronym||null,name:p.org_name||null,color:p.color||null},location:p.location_name||null,bar:p.bar,
   started:st.some(s=>{const x=osOf.get(s.id);return !!x&&x!=='nao_iniciada';}),steps:st};
 });
}
/** Desloca as datas de uma OS (todas as etapas e reservas), para a prévia do adiamento. */
function shifted(p:PlanRow,days:number):PlanRow{
 const mv=(iso:string)=>new Date(Date.parse(iso)+days*DAY_MS).toISOString();
 return {...p,start:mv(p.start),end:mv(p.end),steps:p.steps.map(s=>({...s,start:mv(s.start),end:mv(s.end),equipment:s.equipment.map(e=>({...e,start:mv(e.start),end:mv(e.end)}))}))};
}
/** O que a OS ocupa no dia: etapas do dia (não encerradas), equipe (a da OS; nas antigas, as funções das etapas do dia),
 *  HH (duração × pessoas), equipamento e materiais. Dia sem expediente na barra (open=false): a OS não consome. */
function onDay(p:PlanRow,day:string,open:boolean,keepDone=false){
 if(!open)return null;
 const t=Date.parse(dayStart(day));
 const steps=p.steps.filter(s=>(keepDone||!s.done)&&Date.parse(s.start)<=t&&t<Date.parse(s.end));
 if(!steps.length)return null;
 const by=new Map<string,{functionId:string,name:string,people:number}>();
 if(p.team.length)for(const n of p.team){const f=by.get(n.functionId)||{functionId:n.functionId,name:n.name,people:0};f.people+=n.quantity;by.set(n.functionId,f);}
 else for(const s of steps)for(const n of s.needs){const f=by.get(n.functionId)||{functionId:n.functionId,name:n.name,people:0};f.people+=n.quantity;by.set(n.functionId,f);}
 const eq=new Map<string,{id:string,tag:string}>();
 for(const s of steps)for(const e of s.equipment)if(Date.parse(e.start)<=t&&t<Date.parse(e.end))eq.set(e.id,{id:e.id,tag:e.tag});
 const mats=new Map<string,{name:string,unit:string,amount:number}>();
 for(const s of steps)for(const m of s.materials){const k=m.name+'|'+m.unit,x=mats.get(k)||{name:m.name,unit:m.unit,amount:0};x.amount=round(x.amount+m.amount);mats.set(k,x);}
 const byFunction=[...by.values()].sort((x,y)=>y.people-x.people||x.name.localeCompare(y.name,'pt-BR'));
 const people=byFunction.reduce((n,f)=>n+f.people,0),hours=p.hours??0;
 return {steps:steps.map(s=>s.name),byFunction,people,hours,hh:roundHh(hours*people),equipment:[...eq.values()],materials:[...mats.values()]};
}
const order=(a:PlanRow,b:PlanRow)=>(a.priority??Infinity)-(b.priority??Infinity)||Date.parse(a.start)-Date.parse(b.start)||(a.number??Infinity)-(b.number??Infinity)||a.createdAt.localeCompare(b.createdAt);
const demandOn=(plans:PlanRow[],day:string,open:boolean)=>roundHh(plans.reduce((n,p)=>n+(onDay(p,day,open)?.hh||0),0));
const keyOf=(c:{workOrderId:string|null,planId:string})=>c.workOrderId||c.planId;

// ───────────── Consolidações ─────────────
async function consolidationOf(bar:string,day:string,version?:number){
 return await db().first(`SELECT * FROM plan_day_consolidations WHERE bar=? AND day=?::date${version?' AND version=?':''} ORDER BY version DESC LIMIT 1`,bar,day,...(version?[version]:[]));
}
/** OS consolidadas na 1ª versão do dia da barra: quem não está nela entrou depois = Emergencial. */
async function firstKeys(bar:string,day:string):Promise<Set<string>|null>{
 const v1=await consolidationOf(bar,day,1);if(!v1)return null;
 return new Set(((v1.snapshot as Row).cards as Row[]).map(c=>c.workOrderId||c.planId));
}

/** Monta o dia da barra: HH disponível, lista em ordem com o HH acumulado, barra de duração e recursos. */
async function compose(bar:BarId,day:string,plans:PlanRow[],first:Set<string>|null){
 const [[staff],bars]=await Promise.all([staffFor(bar,[day]),loadBars()]);
 let total=0;
 const cards=plans.map(p=>({p,d:onDay(p,day,staff.open)})).filter(x=>x.d).sort((x,y)=>order(x.p,y.p)).map(({p,d})=>{
  total=roundHh(total+d!.hh);
  const c={planId:p.id,workOrderId:p.workOrderId,number:p.number,label:p.number!=null?osNumber(p.number):'Rascunho',title:p.title,status:p.status==='launched'?'lancada':'rascunho',
   org:p.org,location:p.location,priority:p.priority,firstDay:dayOf(p.start),lastDay:lastDay(p.end),started:p.started,
   steps:d!.steps,byFunction:d!.byFunction,people:d!.people,hours:d!.hours,hh:d!.hh,noDuration:p.hours==null,equipment:d!.equipment,materials:d!.materials,
   cumulative:total,exceeds:total>staff.hh,emergency:false};
  c.emergency=c.status==='lancada'&&!!first&&!first.has(keyOf(c));
  return c;
 });
 const limit=staff.maxShiftHours;
 const long=cards.filter(c=>c.hours>0).sort((x,y)=>y.hours-x.hours)[0];
 return {bar:barRow(bars.find(x=>x.id===bar)!),day,weekday:weekday(day),staff,demandHh:total,over:total>staff.hh,extraHh:roundHh(Math.max(0,total-staff.hh)),
  durationTotal:roundHh(cards.reduce((t,c)=>t+c.hours,0)),longest:long&&limit>0&&long.hours>limit?{title:long.title,hours:long.hours,limit}:null,
  drafts:cards.filter(c=>c.status==='rascunho').length,cards,resources:await resourcesOf(cards,limit)};
}

/** Recursos do dia: funções (em quantas OS e o maior número de pessoas), equipamento (OS, horas somadas, acima da jornada,
 *  impedimento técnico aberto) e materiais somados. */
type ResCard={hours:number,byFunction:{functionId:string,name:string,people:number}[],equipment:{id:string,tag:string}[],materials:{name:string,unit:string,amount:number}[]};
async function resourcesOf(cards:ResCard[],limit:number){
 const fns=new Map<string,{name:string,activities:number,maxPeople:number,people:number}>();
 const eq=new Map<string,{id:string,tag:string,activities:number,hours:number}>();
 const mats=new Map<string,{name:string,unit:string,amount:number}>();
 for(const c of cards){
  for(const f of c.byFunction){const x=fns.get(f.functionId)||{name:f.name,activities:0,maxPeople:0,people:0};x.activities++;x.maxPeople=Math.max(x.maxPeople,f.people);x.people+=f.people;fns.set(f.functionId,x);}
  for(const e of c.equipment){const x=eq.get(e.id)||{id:e.id,tag:e.tag,activities:0,hours:0};x.activities++;x.hours=roundHh(x.hours+c.hours);eq.set(e.id,x);}
  for(const m of c.materials){const k=m.name+'|'+m.unit,x=mats.get(k)||{name:m.name,unit:m.unit,amount:0};x.amount=round(x.amount+m.amount);mats.set(k,x);}
 }
 const ids=[...eq.keys()];
 const blocked=ids.length?await db().all('SELECT DISTINCT equipment_id FROM equipment_impediments WHERE released_at IS NULL AND equipment_id=ANY(?::text[])',ids):[];
 return {functions:[...fns.values()].sort((x,y)=>y.activities-x.activities||x.name.localeCompare(y.name,'pt-BR')),
  equipment:[...eq.values()].map(e=>({tag:e.tag,activities:e.activities,hours:e.hours,over:limit>0&&e.hours>limit,impeded:blocked.some(b=>b.equipment_id===e.id)})).sort((x,y)=>x.tag.localeCompare(y.tag)),
  materials:[...mats.values()].sort((x,y)=>x.name.localeCompare(y.name,'pt-BR'))};
}

type Board=Awaited<ReturnType<typeof compose>>;
/** Só OS lançadas vão para a consolidação (rascunho não é OS). */
async function retrato(b:Board){
 const cards=b.cards.filter(c=>c.status==='lancada');
 return {bar:{id:b.bar.id,name:b.bar.name,color:b.bar.color},staff:{hh:b.staff.hh,computedHh:b.staff.computedHh,source:b.staff.source,windows:b.staff.windows,note:b.staff.note},
  demandHh:roundHh(cards.reduce((t,c)=>t+c.hh,0)),durationTotal:roundHh(cards.reduce((t,c)=>t+c.hours,0)),extraHh:roundHh(Math.max(0,cards.reduce((t,c)=>t+c.hh,0)-b.staff.hh)),
  cards:cards.map((c,i)=>({position:i+1,planId:c.planId,workOrderId:c.workOrderId,label:c.label,title:c.title,org:c.org,location:c.location,firstDay:c.firstDay,lastDay:c.lastDay,
   steps:c.steps,byFunction:c.byFunction,people:c.people,hours:c.hours,hh:c.hh,noDuration:c.noDuration,emergency:c.emergency,equipment:c.equipment.map(e=>({tag:e.tag})),materials:c.materials})),
  resources:await resourcesOf(cards,b.staff.maxShiftHours)};
}
type Retrato=Awaited<ReturnType<typeof retrato>>;
const fingerprintOf=(r:Retrato)=>createHash('sha256').update(JSON.stringify(r.cards.map(c=>[keyOf(c),c.position,c.hours,c.people,c.byFunction.map(f=>[f.functionId,f.people]),c.equipment.map(e=>e.tag),c.materials.map(m=>[m.name,m.unit,m.amount])]))).digest('hex');
async function barDay(bar:BarId,day:string){
 const board=await compose(bar,day,await loadPlans(bar,day,day),await firstKeys(bar,day));
 return {board,retrato:await retrato(board)};
}

/** Para os indicadores: as OS lançadas do dia (inclusive as já concluídas), com o HH e a marca de emergencial. */
export async function dayLoad(bar:BarId,day:string){
 const [first,[staff]]=await Promise.all([firstKeys(bar,day),staffFor(bar,[day])]);
 return (await loadPlans(bar,day,day,undefined,true)).map(p=>({p,d:onDay(p,day,staff.open,true)})).filter(x=>x.d).map(({p,d})=>{
  const c={planId:p.id,workOrderId:p.workOrderId,label:p.number!=null?osNumber(p.number):'Rascunho',title:p.title,hours:d!.hours,people:d!.people,hh:d!.hh,
   noDuration:p.hours==null,firstDay:dayOf(p.start),lastDay:lastDay(p.end),emergency:false};
  c.emergency=!!first&&!first.has(keyOf(c));return c;
 });
}
export {consolidationOf};

export async function d1Board(member:Member,url:URL){
 await viewer(member);
 const bar=barOf(url.searchParams.get('bar')||'equinor'),day=url.searchParams.get('day')?dayParam(url.searchParams.get('day')):tomorrow();
 const last=await consolidationOf(bar,day);
 const {board,retrato:r}=await barDay(bar,day);
 const consolidation=last?{version:Number(last.version),at:last.consolidated_at,by:last.consolidated_by_name,participants:last.participants,changed:last.fingerprint!==fingerprintOf(r)}:null;
 const mine=((member as Actor).planning_bars||[]) as string[];
 return {...board,consolidation,myBars:isManager(member)?[]:mine,generatedAt:now()};
}

/** Dia consolidado da barra (a versão pedida ou a última): TV, celular, relatório e lista de separação. */
export async function d1Consolidated(member:Member,url:URL){
 await viewer(member);
 const bar=barOf(url.searchParams.get('bar')||'equinor');
 const day=url.searchParams.get('day')?dayParam(url.searchParams.get('day')):tomorrow();
 const v=url.searchParams.get('version')?Number(url.searchParams.get('version')):undefined;
 if(v!==undefined&&(!Number.isInteger(v)||v<1))throw new AppError('Versão inválida.');
 const [c,versions]=await Promise.all([consolidationOf(bar,day,v),db().all('SELECT version,consolidated_at,consolidated_by_name FROM plan_day_consolidations WHERE bar=? AND day=?::date ORDER BY version DESC',bar,day)]);
 return {bar,barName:barName(bar),day,version:c?Number(c.version):null,consolidatedAt:c?.consolidated_at||null,consolidatedBy:c?.consolidated_by_name||null,participants:c?.participants||[],notes:c?.notes||null,
  snapshot:c?.snapshot||null,versions:versions.map(x=>({version:Number(x.version),at:x.consolidated_at,by:x.consolidated_by_name}))};
}

/** Alerta das 16h (Brasília): dia seguinte com OS e ainda não consolidado, por barra. */
export async function d1Late(nowMs=Date.now()){
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'}).format(new Date(nowMs)));
 if(hour<16)return [];
 const day=plusDays(dayOf(nowMs),1),out:{bar:string,barName:string,day:string,cards:number}[]=[];
 for(const bar of BARS){
  if(await consolidationOf(bar,day))continue;
  const [staff]=await staffFor(bar,[day]);
  const n=(await loadPlans(bar,day,day)).filter(p=>onDay(p,day,staff.open)).length;
  if(n)out.push({bar,barName:barName(bar),day,cards:n});
 }
 return out;
}

/** Prévia do adiamento: em cada dia que a OS passa a ocupar, o HH antes e depois contra o disponível. */
export async function d1Preview(member:Member,url:URL){
 await viewer(member);
 const planId=text(url.searchParams.get('plan'),64),days=stepDays(url.searchParams.get('days'));
 const plan=await planInfo(planId);
 const target=shifted(plan,days),newDays=daysOfPlan(target);
 const all=await loadPlans(plan.bar,newDays[0],newDays[newDays.length-1],plan.id);
 const others=all.filter(p=>p.id!==plan.id);
 const staff=await staffFor(plan.bar as BarId,newDays);
 const out=newDays.map((day,i)=>{const o=staff[i].open,before=demandOn(all,day,o),after=demandOn([...others,target],day,o);return {day,staff:staff[i].hh,before,after,over:after>staff[i].hh};});
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

/** Ajuste do HH de um dia (planejador da barra): troca o calculado; vazio volta ao calculado. */
async function setStaff(member:Member,b:Row){
 const bar=barOf(b.bar),a=await planner(member,bar),day=dayParam(b.day);
 const reset=b.hh==null||String(b.hh).trim()==='';
 const hh=reset?null:Number(String(b.hh).replace(',','.'));
 if(hh!=null&&(!Number.isFinite(hh)||hh<0||hh>5000))throw new AppError('HH do dia: informe um número de 0 a 5000.');
 const note=text(b.note,300)||null;
 await db().tx(async tx=>{
  if(hh==null)await tx.run('DELETE FROM plan_day_staff WHERE bar=? AND day=?::date',bar,day);
  else await tx.run(`INSERT INTO plan_day_staff(bar,day,hh,note,updated_at,updated_by,updated_by_name) VALUES(?,?::date,?,?,?,?,?)
   ON CONFLICT(bar,day) DO UPDATE SET hh=excluded.hh,note=excluded.note,updated_at=excluded.updated_at,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name`,bar,day,roundHh(hh),note,now(),a.id,a.name);
  await audit(tx,a,'Planejamento: HH do dia ajustado',`${bar}:${day}`,{bar,day,hh,note});
 });
 const [s]=await staffFor(bar,[day]);
 return {ok:true,message:hh==null?`HH de ${dayText(day)} na barra ${barName(bar)} voltou ao calculado: ${hText(s.hh)} HH.`:`HH de ${dayText(day)} na barra ${barName(bar)}: ${hText(s.hh)} HH.`};
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

/** Consolidar o dia da barra (reunião das 16h), com participantes e observações. Nova versão a cada consolidação. */
async function consolidate(member:Member,b:Row){
 const bar=barOf(b.bar),a=await planner(member,bar),day=dayParam(b.day);
 if(!Array.isArray(b.participants))throw new AppError('Informe os participantes da reunião.');
 const participants=[...new Set(b.participants.map((x:unknown)=>text(x,120).replace(/\s+/g,' ')).filter((x:string)=>x.length>=2))] as string[];
 if(!participants.length||participants.length>30)throw new AppError('Informe os participantes da reunião (de 1 a 30 nomes).');
 const notes=text(b.notes,2000)||null;
 const {retrato:r}=await barDay(bar,day);
 const last=await consolidationOf(bar,day),version=last?Number(last.version)+1:1;
 const snapshot={day,weekday:weekday(day),...r};
 try{
  await db().tx(async tx=>{
   await tx.run('INSERT INTO plan_day_consolidations(id,bar,day,version,fingerprint,snapshot,participants,notes,consolidated_at,consolidated_by,consolidated_by_name) VALUES(?,?,?::date,?,?,?::text::jsonb,?::text[],?,?,?,?)',
    id(),bar,day,version,fingerprintOf(r),JSON.stringify(snapshot),participants,notes,now(),a.id,a.name);
   await audit(tx,a,'Planejamento: dia consolidado',`${bar}:${day}`,{bar,day,version,participants,notes,cards:r.cards.length,hh:r.demandHh});
  });
 }catch(e){if((e as {code?:string}).code==='23505')throw new AppError('Outra pessoa acabou de consolidar este dia. Atualize a tela.',409);throw e;}
 return {ok:true,version,message:`Barra ${barName(bar)} de ${dayText(day)} consolidada${version>1?` (versão ${version})`:''}.`};
}

export async function d1Get(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/d1')return d1Board(member,url);
 if(path==='planning/d1/preview')return d1Preview(member,url);
 if(path==='planning/d1/consolidated')return d1Consolidated(member,url);
 return null;
}
export async function d1Mutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/d1/order')return reorder(member,b);
 if(path==='planning/d1/staff')return setStaff(member,b);
 if(path==='planning/d1/postpone')return postpone(member,b);
 if(path==='planning/d1/consolidate')return consolidate(member,b);
 return null;
}
