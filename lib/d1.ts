// Planejamento · tela do D+1, na forma simples. Por barra (OCP ou Equinor) e dia: o HH das OS do dia
// (funcionários × horas por dia de cada função das etapas do dia; sem horas, as do turno do dia) contra o HH
// disponível (ADM + turno do dia: funcionários × horas). Passou: só avisa, em vermelho, e marca a partir de
// qual OS da pilha. Ações: ordem da pilha (prioridade da OS), efetivo do dia, adiar com
// prévia (rascunho muda direto; OS lançada vira revisão automática com motivo) e publicar (retrato imutável
// do que a TV, o celular e a lista de separação mostram; publicar de novo cria a versão seguinte).
import {createHash} from 'node:crypto';
import {db,type Executor,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {loadBars,barRow,barOf,barName,plusDays,weekday,staffFor,hText,roundHh,type BarId} from './capacity';
import {dayStart,dayOf,dayText,lastDay,DAY_MS,EQUIPMENT_DAY_HOURS} from './days';
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

// ───────────── Demanda ─────────────
type Need={functionId:string,name:string,quantity:number,hours:number|null};
type StepRow={id:string,name:string,start:string,end:string,done:boolean,needs:Need[],materials:{name:string,unit:string,amount:number}[],equipment:{tag:string,hours:number,start:string,end:string}[]};
type PlanRow={id:string,status:string,workOrderId:string|null,number:number|null,title:string,priority:number|null,skipSunday:boolean,start:string,end:string,createdAt:string,
 org:{id:string|null,acronym:string|null,name:string|null,color:string|null},location:string|null,bar:string,started:boolean,steps:StepRow[]};

/** OS (lançadas, programadas ou em andamento) e rascunhos da barra que tocam o período [from, to]. */
async function loadPlans(bar:string,from:string,to:string,extraPlanId?:string):Promise<PlanRow[]>{
 const lo=dayStart(from),hi=dayStart(plusDays(to,1));
 const plans=await db().all(`SELECT p.id,p.status,p.work_order_id,p.title,p.description,p.priority,p.skip_sunday,p.planned_start,p.planned_end,p.created_at,
   o.id org_id,o.acronym,o.name org_name,o.color,coalesce(o.bar,'equinor') bar,w.number,at.name type_name,l.name location_name
  FROM plans p LEFT JOIN requester_orgs o ON o.id=p.org_id LEFT JOIN work_orders w ON w.id=p.work_order_id LEFT JOIN activity_types at ON at.id=p.activity_type_id LEFT JOIN locations l ON l.id=p.location_id
  WHERE coalesce(o.bar,'equinor')=? AND p.planned_start IS NOT NULL AND p.planned_end IS NOT NULL
   AND ((p.status='launched' AND w.status = ANY(?::text[])) OR (p.status='draft' AND p.base_plan_id IS NULL AND p.mode IS DISTINCT FROM 'realizada'))
   AND ((p.planned_start<? AND p.planned_end>?) OR p.id=?)`,bar,REVISABLE,hi,lo,extraPlanId||'');
 if(!plans.length)return [];
 const ids=plans.map(p=>p.id);
 const [steps,needs,res,os,mats]=await Promise.all([
  db().all('SELECT id,plan_id,name,position,planned_start,planned_end FROM plan_steps WHERE plan_id=ANY(?::text[]) AND included=1 ORDER BY position',ids),
  db().all(`SELECT n.plan_step_id,n.function_id,f.name,n.quantity,n.hours_per_day FROM plan_step_needs n JOIN job_functions f ON f.id=n.function_id WHERE n.plan_id=ANY(?::text[]) AND n.function_id IS NOT NULL`,ids),
  db().all(`SELECT r.plan_step_id,r.start_at,r.end_at,r.hours_per_day,e.tag FROM reservations r JOIN equipment e ON e.id=r.equipment_id WHERE r.plan_id=ANY(?::text[]) AND r.status<>'liberada'`,ids),
  db().all('SELECT plan_step_id,status FROM os_steps WHERE plan_step_id IN (SELECT id FROM plan_steps WHERE plan_id=ANY(?::text[]))',ids),
  db().all('SELECT n.plan_step_id,m.name,n.unit,n.amount FROM plan_step_needs n JOIN materials m ON m.id=n.material_id WHERE n.plan_id=ANY(?::text[]) AND n.material_id IS NOT NULL',ids),
 ]);
 const osOf=new Map(os.map(o=>[o.plan_step_id as string,o.status as string]));
 return plans.map(p=>{
  const st=steps.filter(s=>s.plan_id===p.id).map(s=>({id:s.id,name:s.name,start:s.planned_start||p.planned_start,end:s.planned_end||p.planned_end,done:DONE.includes(osOf.get(s.id)||''),
   needs:needs.filter(n=>n.plan_step_id===s.id).map(n=>({functionId:n.function_id,name:n.name,quantity:Number(n.quantity),hours:n.hours_per_day==null?null:Number(n.hours_per_day)})),
   materials:mats.filter(m=>m.plan_step_id===s.id).map(m=>({name:m.name,unit:m.unit,amount:Number(m.amount)})),
   equipment:res.filter(r=>r.plan_step_id===s.id).map(r=>({tag:r.tag,hours:Number(r.hours_per_day??EQUIPMENT_DAY_HOURS),start:r.start_at,end:r.end_at}))}));
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
/** O que a OS ocupa no dia: etapas do dia (não encerradas), funcionários e HH por função (sem horas, a
 *  jornada do dia), equipamento e materiais. */
function onDay(p:PlanRow,day:string,dayHours:number){
 if(p.skipSunday&&weekday(day)===0)return null;
 const t=Date.parse(dayStart(day));
 const steps=p.steps.filter(s=>!s.done&&Date.parse(s.start)<=t&&t<Date.parse(s.end));
 if(!steps.length)return null;
 const by=new Map<string,{functionId:string,name:string,people:number,hh:number}>();
 for(const s of steps)for(const n of s.needs){const f=by.get(n.functionId)||{functionId:n.functionId,name:n.name,people:0,hh:0};f.people+=n.quantity;f.hh=roundHh(f.hh+n.quantity*(n.hours??dayHours));by.set(n.functionId,f);}
 const equipment=steps.flatMap(s=>s.equipment.filter(e=>Date.parse(e.start)<=t&&t<Date.parse(e.end)).map(e=>({tag:e.tag,hours:e.hours})));
 const mats=new Map<string,{name:string,unit:string,amount:number}>();
 for(const s of steps)for(const m of s.materials){const k=m.name+'|'+m.unit,x=mats.get(k)||{name:m.name,unit:m.unit,amount:0};x.amount=round(x.amount+m.amount);mats.set(k,x);}
 const byFunction=[...by.values()].sort((x,y)=>y.hh-x.hh||x.name.localeCompare(y.name,'pt-BR'));
 return {steps:steps.map(s=>s.name),byFunction,people:byFunction.reduce((n,f)=>n+f.people,0),hh:roundHh(byFunction.reduce((n,f)=>n+f.hh,0)),equipment,materials:[...mats.values()]};
}
const order=(a:PlanRow,b:PlanRow)=>(a.priority??Infinity)-(b.priority??Infinity)||Date.parse(a.start)-Date.parse(b.start)||(a.number??Infinity)-(b.number??Infinity)||a.createdAt.localeCompare(b.createdAt);
const demandOn=(plans:PlanRow[],day:string,hours:number)=>roundHh(plans.reduce((n,p)=>n+(onDay(p,day,hours)?.hh||0),0));

/** Monta o dia: HH disponível, pilha em ordem com o HH acumulado e o aviso de quem passa do disponível. */
async function compose(bar:BarId,day:string,plans:PlanRow[]){
 const [[staff],bars]=await Promise.all([staffFor(bar,[day]),loadBars()]);
 let total=0;
 const cards=plans.map(p=>({p,d:onDay(p,day,staff.osHours)})).filter(x=>x.d).sort((x,y)=>order(x.p,y.p)).map(({p,d})=>{
  total=roundHh(total+d!.hh);
  return {planId:p.id,workOrderId:p.workOrderId,number:p.number,label:p.number!=null?osNumber(p.number):'Rascunho',title:p.title,status:p.status==='launched'?'lancada':'rascunho',
   org:p.org,location:p.location,priority:p.priority,firstDay:dayOf(p.start),lastDay:lastDay(p.end),started:p.started,skipSunday:p.skipSunday,
   steps:d!.steps,byFunction:d!.byFunction,people:d!.people,hh:d!.hh,equipment:d!.equipment,materials:d!.materials,cumulative:total,exceeds:total>staff.hh};
 });
 return {bar:barRow(bars.find(x=>x.id===bar)!),day,weekday:weekday(day),staff,demand:total,over:total>staff.hh,missing:roundHh(Math.max(0,total-staff.hh)),
  drafts:cards.filter(c=>c.status==='rascunho').length,cards};
}

type Board=Awaited<ReturnType<typeof compose>>;
/** Só OS lançadas vão para a publicação (rascunho não é OS). */
const publishable=(b:Board)=>b.cards.filter(c=>c.status==='lancada');
/** Retrato comparável do que seria publicado: muda quando o dia muda. */
const fingerprint=(b:Board)=>createHash('sha256').update(JSON.stringify(publishable(b).map(c=>[c.planId,c.people,c.hh,c.byFunction.map(f=>[f.functionId,f.people,f.hh]),c.equipment.map(e=>[e.tag,e.hours]),c.materials.map(m=>[m.name,m.unit,m.amount]),c.steps]))).digest('hex');
async function lastPublication(bar:string,day:string,version?:number){
 return await db().first(`SELECT * FROM plan_d1_publications WHERE bar=? AND day=?::date${version?' AND version=?':''} ORDER BY version DESC LIMIT 1`,bar,day,...(version?[version]:[]));
}

export async function d1Board(member:Member,url:URL){
 await viewer(member);
 const bar=barOf(url.searchParams.get('bar')||'equinor'),day=url.searchParams.get('day')?dayParam(url.searchParams.get('day')):tomorrow();
 const [board,pub]=await Promise.all([loadPlans(bar,day,day).then(p=>compose(bar,day,p)),lastPublication(bar,day)]);
 return {...board,publication:pub?{version:Number(pub.version),publishedAt:pub.published_at,by:pub.published_by_name,changed:pub.fingerprint!==fingerprint(board)}:null,generatedAt:now()};
}

/** Programação publicada (a versão pedida ou a última): para a TV, o celular do líder e a lista de separação. */
export async function d1Published(member:Member,url:URL){
 await viewer(member);
 const bar=barOf(url.searchParams.get('bar')||'equinor'),day=url.searchParams.get('day')?dayParam(url.searchParams.get('day')):tomorrow();
 const v=url.searchParams.get('version')?Number(url.searchParams.get('version')):undefined;
 if(v!==undefined&&(!Number.isInteger(v)||v<1))throw new AppError('Versão inválida.');
 const [pub,versions]=await Promise.all([lastPublication(bar,day,v),db().all('SELECT version,published_at,published_by_name FROM plan_d1_publications WHERE bar=? AND day=?::date ORDER BY version DESC',bar,day)]);
 return {bar,day,version:pub?Number(pub.version):null,publishedAt:pub?.published_at||null,publishedBy:pub?.published_by_name||null,
  snapshot:pub?.snapshot||null,versions:versions.map(x=>({version:Number(x.version),publishedAt:x.published_at,by:x.published_by_name}))};
}

/** Alerta das 16:00 (Brasília): barras com OS no dia seguinte e sem publicação. */
export async function d1Late(nowMs=Date.now()){
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'}).format(new Date(nowMs)));
 if(hour<16)return [];
 const day=plusDays(dayOf(nowMs),1),out:{bar:string,barName:string,day:string,cards:number}[]=[];
 for(const bar of ['equinor','ocp'] as BarId[]){
  if(await lastPublication(bar,day))continue;
  const plans=await loadPlans(bar,day,day),n=plans.filter(p=>onDay(p,day,1)).length;
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
 const out=newDays.map((day,i)=>{const h=staff[i].osHours,before=demandOn(all,day,h),after=demandOn([...others,target],day,h);return {day,staff:staff[i].hh,before,after,over:after>staff[i].hh};});
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

async function publish(member:Member,b:Row){
 const bar=barOf(b.bar),a=await planner(member,bar),day=dayParam(b.day);
 const [board,last]=await Promise.all([loadPlans(bar,day,day).then(p=>compose(bar,day,p)),lastPublication(bar,day)]);
 const cards=publishable(board),version=last?Number(last.version)+1:1;
 const mats=new Map<string,{name:string,unit:string,amount:number}>();
 for(const c of cards)for(const m of c.materials){const k=m.name+'|'+m.unit,x=mats.get(k)||{name:m.name,unit:m.unit,amount:0};x.amount=round(x.amount+m.amount);mats.set(k,x);}
 const snapshot={bar:{id:bar,name:board.bar.name,color:board.bar.color},day,weekday:board.weekday,staff:{people:board.staff.people,adm:board.staff.adm,shift:board.staff.shift,hh:board.staff.hh},
  people:cards.reduce((n,c)=>n+c.people,0),hh:roundHh(cards.reduce((n,c)=>n+c.hh,0)),
  cards:cards.map((c,i)=>({position:i+1,planId:c.planId,workOrderId:c.workOrderId,label:c.label,title:c.title,org:c.org,location:c.location,firstDay:c.firstDay,lastDay:c.lastDay,
   steps:c.steps,byFunction:c.byFunction,people:c.people,hh:c.hh,equipment:c.equipment,materials:c.materials})),
  materials:[...mats.values()].sort((x,y)=>x.name.localeCompare(y.name,'pt-BR'))};
 try{
  await db().tx(async tx=>{
   await tx.run('INSERT INTO plan_d1_publications(id,bar,day,version,fingerprint,snapshot,published_at,published_by,published_by_name) VALUES(?,?,?::date,?,?,?::text::jsonb,?,?,?)',
    id(),bar,day,version,fingerprint(board),JSON.stringify(snapshot),now(),a.id,a.name);
   await audit(tx,a,'Planejamento: D+1 publicado',`${bar}:${day}`,{bar,day,version,cards:cards.length,hh:snapshot.hh,staffHh:snapshot.staff.hh});
  });
 }catch(e){if((e as {code?:string}).code==='23505')throw new AppError('Outra pessoa acabou de publicar este dia. Atualize a tela.',409);throw e;}
 return {ok:true,version,message:`D+1 da barra ${barName(bar)} de ${dayText(day)} publicado${version>1?` (versão ${version})`:''}.`};
}

export async function d1Get(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/d1')return d1Board(member,url);
 if(path==='planning/d1/preview')return d1Preview(member,url);
 if(path==='planning/d1/published')return d1Published(member,url);
 return null;
}
export async function d1Mutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/d1/order')return reorder(member,b);
 if(path==='planning/d1/staff')return setStaff(member,b);
 if(path==='planning/d1/postpone')return postpone(member,b);
 if(path==='planning/d1/publish')return publish(member,b);
 return null;
}
