// Financeiro · recobráveis por equipamento: tarifas com vigência e uso real do equipamento nas OS
// (início e fim). As diárias saem do motor puro (lib/recoverables) a partir dos usos; nada de diária
// é gravado. A Operação registra o uso com a OS aberta; o Financeiro (e a Gestão) registra, corrige
// e confere em qualquer situação. Usos fora do período reservado ou com fim automático ficam
// "a conferir" até alguém do Financeiro revisar.
import {db,type Executor,type Row} from './db';
import {AppError,required,text,isoDay} from './domain';
import {type Member,isManager,has,requireAny,loadAccess} from './permissions';
import {audit} from './registry';
import {instant,osNumber} from './planning';
import {dailies,rateAt,minutesOutside,type Rate,type Interval,type Daily} from './recoverables';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const H=3600_000,DAY=24*H;
const OPEN=['programada','em_andamento','encerramento_pendente'];
/** Tolerância antes de marcar "a conferir" um uso fora do período reservado. */
const TOLERANCE_MIN=30;
type Actor=Member&{capabilities:string[],org_scope:string[]};
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);
const isFinance=(a:Actor)=>isManager(a)||a.capabilities.includes('financeiro');
const brl=(cents:number)=>(cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const ms=(v:string)=>Date.parse(v);

export const toRate=(r:Row):Rate=>({equipmentId:r.equipment_id,orgId:r.org_id,hourlyCents:Number(r.hourly_cents),hoursPerDay:Number(r.hours_per_day),validFrom:r.valid_from,active:!!r.active});
export const toInterval=(u:Row):Interval=>({id:u.id,orderId:u.work_order_id,orderNumber:Number(u.number),equipmentId:u.equipment_id,orgId:u.org_id,
 start:ms(u.started_at),end:u.ended_at?ms(u.ended_at):null,pending:u.review==='a_conferir'});

/** Data e hora informada (ou agora): não no futuro (1 min de tolerância) e não antes de 2020. */
function moment(value:unknown,label:string){
 const v=value==null||value===''?now():instant(value,label)!;
 if(ms(v)>Date.now()+60000)throw new AppError(`${label}: não pode estar no futuro.`);
 if(ms(v)<Date.UTC(2020,0,1))throw new AppError(`${label}: data anterior a 2020. Confira o ano.`);
 return v;
}
/** Traduz a trava de sobreposição do banco (o detalhe traz o número da OS que já usa o equipamento). */
function dbError(e:unknown):never{
 const x=e as {message?:string,detail?:string};
 if(/Equipamento já em uso no período/.test(x.message||''))throw new AppError(`O equipamento já está em uso nesse período na ${osNumber(Number(x.detail))}.`,409);
 if(/Fim do uso deve ser depois do início/.test(x.message||''))throw new AppError('O fim do uso deve ser depois do início.');
 throw e;
}

const ratesOf=(ex:Executor,equipmentId?:string,orgId?:string)=>ex.all(`SELECT * FROM recovery_rates${equipmentId?' WHERE equipment_id=? AND org_id=?':''} ORDER BY valid_from`,...(equipmentId?[equipmentId,orgId]:[]));
/** Usos do equipamento para o cliente perto do período (a janela máxima é de 168 h). */
const usesNear=(ex:Executor,equipmentId:string,orgId:string,from:number,to:number)=>ex.all(`SELECT u.*,w.number FROM equipment_uses u JOIN work_orders w ON w.id=u.work_order_id
 WHERE u.equipment_id=? AND u.org_id=? AND u.started_at::timestamptz < ?::timestamptz AND coalesce(u.ended_at::timestamptz,'infinity') > ?::timestamptz ORDER BY u.started_at::timestamptz`,
 equipmentId,orgId,new Date(to).toISOString(),new Date(from-8*DAY).toISOString());
/** Períodos reservados do equipamento na versão vigente da OS. */
const reservedWindows=async(ex:Executor,wo:Row,equipmentId:string)=>(await ex.all('SELECT start_at,end_at FROM reservations WHERE plan_id=? AND equipment_id=?',wo.current_plan_id,equipmentId))
 .map(r=>[ms(r.start_at),ms(r.end_at)] as [number,number]);

// ---- Consultas ----

export async function financeRates(member:Member){
 const a=await requireAny(member,['financeiro']) as Actor;
 const [rates,equipment,orgs]=await Promise.all([
  db().all('SELECT r.*,e.tag,o.name org_name FROM recovery_rates r JOIN equipment e ON e.id=r.equipment_id JOIN requester_orgs o ON o.id=r.org_id ORDER BY e.tag,o.name,r.valid_from DESC'),
  db().all('SELECT id,tag,description,active FROM equipment ORDER BY tag'),
  db().all('SELECT id,name,acronym,active FROM requester_orgs ORDER BY name'),
 ]);
 return {rates:rates.filter(r=>inScope(a,r.org_id)),equipment,orgs:orgs.filter(o=>inScope(a,o.id))};
}

/** Uso de equipamentos recobráveis de uma OS: equipamentos com tarifa, usos e diárias. */
export async function orderUses(member:Member,workOrderId:string){
 const a=await requireAny(member,['operacao','acompanhamento','planejamento','financeiro']) as Actor;
 const wo=await db().first('SELECT * FROM work_orders WHERE id=?',required(workOrderId,'OS',100));
 if(!wo||!inScope(a,wo.org_id))throw new AppError('OS não encontrada ou fora do seu acesso.',404);
 const [rates,reserved,uses]=await Promise.all([
  ratesOf(db()),
  db().all('SELECT DISTINCT e.id,e.tag FROM reservations r JOIN equipment e ON e.id=r.equipment_id WHERE r.plan_id=? ORDER BY e.tag',wo.current_plan_id),
  db().all('SELECT u.*,e.tag,w.number FROM equipment_uses u JOIN equipment e ON e.id=u.equipment_id JOIN work_orders w ON w.id=u.work_order_id WHERE u.work_order_id=? ORDER BY u.started_at::timestamptz',wo.id),
 ]);
 const all=rates.map(toRate),t=Date.now();
 const equipment=(reserved as {id:string,tag:string}[]).filter(e=>rateAt(all,e.id,wo.org_id,t));
 const out:Daily[]=[];
 for(const eq of [...new Set(uses.map(u=>u.equipment_id as string))]){
  const mine=uses.filter(u=>u.equipment_id===eq);
  const near=await usesNear(db(),eq,wo.org_id,Math.min(...mine.map(u=>ms(u.started_at))),Math.max(...mine.map(u=>u.ended_at?ms(u.ended_at):t)));
  out.push(...dailies(near.map(toInterval),all.filter(r=>r.equipmentId===eq),t).filter(d=>d.orderIds.includes(wo.id)));
 }
 const open=OPEN.includes(wo.status);
 return {eligible:equipment.length>0||uses.length>0,equipment,uses,dailies:out.sort((x,y)=>x.start-y.start),
  can:{register:isFinance(a)||(a.capabilities.includes('operacao')&&open),correct:isFinance(a)}};
}

const localDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'});
const dayStart=(d:string)=>Date.parse(d+'T00:00:00-03:00');
export type PanelRow={equipmentId:string,tag:string,orgId:string,orgName:string,requests:number,scheduled:number,plannedHours:number,plannedDailies:number,
 plannedCents:number,avgPerOrderCents:number,dailies:number,confirmedCents:number,pendingCents:number};

const iso=(t:number)=>new Date(t).toISOString();
const hoursIn=(x:Row,t0:number,t1:number)=>Math.max(0,Math.min(ms(x.end_at),t1)-Math.max(ms(x.start_at),t0))/H;
const round1=(h:number)=>Math.round(h*10)/10;
/** Agrupa reservas por OS: menor início, maior fim e horas dentro do período. */
function byOrder(list:Row[],t0:number,t1:number,base:(x:Row)=>Row):Row[]{
 const out=new Map<string,Row>();
 for(const x of list){
  const o=out.get(x.order_id)||{...base(x),start:x.start_at,end:x.end_at,hours:0};
  if(ms(x.start_at)<ms(o.start))o.start=x.start_at;
  if(ms(x.end_at)>ms(o.end))o.end=x.end_at;
  o.hours+=hoursIn(x,t0,t1);out.set(x.order_id,o);
 }
 return [...out.values()].map((o):Row=>({...o,hours:round1(o.hours)})).sort((x,y)=>ms(x.start)-ms(y.start));
}

/** Previsto de um equipamento e cliente no período, pelas reservas confirmadas e pelo mesmo motor das
 * diárias: totais, de onde vem (cada OS solicitada, com as horas, as diárias que abriu e o valor; a
 * diária é da OS que a abriu) e as OS de outros clientes com o mesmo equipamento no período, que não
 * entram, com o motivo. `see` limita as outras OS ao escopo de organizações de quem consulta. */
async function forecast(p:{equipmentId:string,orgId:string},rates:Rate[],t0:number,t1:number,see:(orgId:string)=>boolean){
 const mine=rates.filter(r=>r.equipmentId===p.equipmentId&&r.orgId===p.orgId);
 const [res,others]=await Promise.all([
  db().all(`SELECT r.start_at,r.end_at,r.status,w.id order_id,w.number,w.status order_status,
    EXISTS (SELECT 1 FROM equipment_uses u WHERE u.work_order_id=w.id AND u.equipment_id=r.equipment_id) used
   FROM reservations r JOIN work_orders w ON w.current_plan_id=r.plan_id
   WHERE r.equipment_id=? AND w.org_id=? AND r.start_at::timestamptz < ?::timestamptz AND r.end_at::timestamptz > ?::timestamptz`,p.equipmentId,p.orgId,iso(t1+8*DAY),iso(t0-8*DAY)),
  db().all(`SELECT r.start_at,r.end_at,w.id order_id,w.number,w.status order_status,w.org_id,o.name org_name
   FROM reservations r JOIN work_orders w ON w.current_plan_id=r.plan_id JOIN requester_orgs o ON o.id=w.org_id
   WHERE r.equipment_id=? AND w.org_id<>? AND r.status<>'liberada' AND w.status<>'cancelada'
    AND r.start_at::timestamptz < ?::timestamptz AND r.end_at::timestamptz > ?::timestamptz`,p.equipmentId,p.orgId,iso(t1),iso(t0)),
 ]);
 const inPeriod=(x:Row)=>ms(x.start_at)<t1&&ms(x.end_at)>t0;
 const requested=res.filter(x=>inPeriod(x)&&(x.order_status!=='cancelada'||x.used));
 const counts=(x:Row)=>x.status==='confirmada'&&x.order_status!=='cancelada';
 const planned=res.filter(counts);
 const plan=dailies(planned.map((x,i)=>({id:'r'+i,orderId:x.order_id,orderNumber:Number(x.number),equipmentId:p.equipmentId,orgId:p.orgId,start:ms(x.start_at),end:ms(x.end_at),pending:false})),mine,Date.now())
  .filter(d=>d.start>=t0&&d.start<t1);
 const origin=byOrder(requested.filter(counts),t0,t1,x=>({orderId:x.order_id,number:Number(x.number),status:x.order_status,counted:true}));
 const outside=byOrder(requested.filter(x=>!counts(x)&&!origin.some(o=>o.orderId===x.order_id)),t0,t1,
  x=>({orderId:x.order_id,number:Number(x.number),status:x.order_status,counted:false,reason:x.order_status==='cancelada'?'OS cancelada (com uso registrado)':'reserva não confirmada'}));
 const orders=[...origin,...outside].map((o):Row=>{const opened=plan.filter(d=>d.openerOrderId===o.orderId);
  return {...o,dailies:opened.length,valueCents:opened.reduce((s,d)=>s+d.valueCents,0),
   attendedIn:[...new Set(plan.filter(d=>d.openerOrderId!==o.orderId&&d.orderIds.includes(o.orderId)).map(d=>d.openerNumber))]};});
 const other=byOrder(others.filter(x=>see(x.org_id)),t0,t1,x=>({orderId:x.order_id,number:Number(x.number),status:x.order_status,orgId:x.org_id,orgName:x.org_name}))
  .map((o):Row=>({...o,reason:rateAt(rates,p.equipmentId,o.orgId,ms(o.start))?`conta na linha de ${o.orgName}`:'cliente sem tarifa'}));
 return {requested,plan,plannedHours:planned.filter(inPeriod).reduce((h,x)=>h+hoursIn(x,t0,t1),0),orders,others:other};
}

/** Painel de recobráveis no período (dias de Brasília; padrão: o mês atual), por equipamento e
 * cliente com tarifa: previsto pelas reservas confirmadas e realizado pelos usos, ambos pelo mesmo
 * motor de diárias. A diária entra no período em que começa. */
export async function financePanel(member:Member,url:URL){
 const a=await requireAny(member,['financeiro']) as Actor;
 const today=localDay.format(Date.now());
 const from=url.searchParams.get('from')?isoDay(url.searchParams.get('from')):today.slice(0,8)+'01';
 const lastDay=(()=>{const [y,m]=from.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);})();
 const to=url.searchParams.get('to')?isoDay(url.searchParams.get('to')):lastDay;
 if(to<from)throw new AppError('O fim do período deve ser igual ou depois do início.');
 const t0=dayStart(from),t1=dayStart(to)+DAY;
 if(t1-t0>370*DAY)throw new AppError('Escolha um período de até um ano.');
 const org=url.searchParams.get('org')||null;
 const [rateRows,equipment,orgs]=await Promise.all([ratesOf(db()),db().all('SELECT id,tag FROM equipment'),db().all('SELECT id,name FROM requester_orgs')]);
 const rates=rateRows.map(toRate);
 const pairs=[...new Map(rates.filter(r=>(!org||r.orgId===org)&&inScope(a,r.orgId)).map(r=>[r.equipmentId+'|'+r.orgId,r] as const)).values()];
 const rows:PanelRow[]=[],detail:Record<string,{dailies:(Daily&{orderNumbers:number[]})[],pending:Row[],forecast:Row[],others:Row[]}>={};
 for(const p of pairs){
  const mine=rates.filter(r=>r.equipmentId===p.equipmentId&&r.orgId===p.orgId);
  const [{requested,plan,plannedHours,orders:origin,others},uses]=await Promise.all([forecast(p,rates,t0,t1,id=>inScope(a,id)),usesNear(db(),p.equipmentId,p.orgId,t0,t1)]);
  const orders=new Map(requested.map(x=>[x.order_id as string,x.order_status as string]));
  const real=dailies(uses.map(toInterval),mine,Date.now()).filter(d=>d.start>=t0&&d.start<t1);
  const plannedCents=plan.reduce((s,d)=>s+d.valueCents,0);
  rows.push({equipmentId:p.equipmentId,tag:equipment.find(e=>e.id===p.equipmentId)?.tag||'',orgId:p.orgId,orgName:orgs.find(o=>o.id===p.orgId)?.name||'',
   requests:orders.size,scheduled:[...orders.values()].filter(s=>s==='programada').length,plannedHours:Math.round(plannedHours*10)/10,
   plannedDailies:plan.length,plannedCents,avgPerOrderCents:orders.size?Math.round(plannedCents/orders.size):0,
   dailies:real.length,confirmedCents:real.filter(d=>!d.pending).reduce((s,d)=>s+d.valueCents,0),pendingCents:real.filter(d=>d.pending).reduce((s,d)=>s+d.valueCents,0)});
  // A conferir: os usos que começam no período e os que entram nas diárias a conferir dele (um uso
  // esquecido em aberto desde o mês anterior aparece onde gera valor).
  const inPending=new Set(real.filter(d=>d.pending).flatMap(d=>d.intervalIds)),numbers=new Map(uses.map(u=>[u.work_order_id as string,Number(u.number)]));
  detail[p.equipmentId+'|'+p.orgId]={dailies:real.map(d=>({...d,orderNumbers:d.orderIds.map(o=>numbers.get(o)!).filter(Boolean)})),
   pending:uses.filter(u=>(u.review==='a_conferir'||!u.ended_at)&&((ms(u.started_at)>=t0&&ms(u.started_at)<t1)||inPending.has(u.id))),forecast:origin,others};
 }
 return {period:{from,to},rows:rows.sort((x,y)=>x.tag.localeCompare(y.tag)||x.orgName.localeCompare(y.orgName)),detail,orgs:orgs.filter(o=>inScope(a,o.id)&&rates.some(r=>r.orgId===o.id))};
}

/** Diárias realizadas para a exportação: por equipamento e cliente com tarifa, as que começam no
 * período (dias de Brasília; sem datas, todas), no escopo de organizações de quem exporta. */
export async function dailyRows(f:{start:string|null,end:string|null,org:string|null},scope:string[]|null){
 const rates=(await ratesOf(db())).map(toRate);
 const t0=f.start?dayStart(f.start):0,t1=f.end?dayStart(f.end)+DAY:Date.now()+DAY;
 const pairs=[...new Map(rates.filter(r=>(!f.org||r.orgId===f.org)&&(!scope||scope.includes(r.orgId))).map(r=>[r.equipmentId+'|'+r.orgId,r] as const)).values()];
 const [equipment,orgs]=await Promise.all([db().all('SELECT id,tag FROM equipment'),db().all('SELECT id,name FROM requester_orgs')]);
 const out:Row[]=[];
 for(const p of pairs){
  const uses=await usesNear(db(),p.equipmentId,p.orgId,t0,t1);
  const numbers=new Map(uses.map(u=>[u.work_order_id as string,Number(u.number)]));
  for(const d of dailies(uses.map(toInterval),rates.filter(r=>r.equipmentId===p.equipmentId&&r.orgId===p.orgId),Date.now()).filter(d=>d.start>=t0&&d.start<t1))
   out.push({tag:equipment.find(e=>e.id===p.equipmentId)?.tag,org_name:orgs.find(o=>o.id===p.orgId)?.name,start:new Date(d.start).toISOString(),end:new Date(d.end).toISOString(),
    opener:d.openerNumber,orders:d.orderIds.map(o=>numbers.get(o)).filter(Boolean),hours_per_day:d.hoursPerDay,hourly_cents:d.hourlyCents,value_cents:d.valueCents,pending:d.pending});
 }
 return out.sort((x,y)=>String(x.start).localeCompare(String(y.start))||String(x.tag).localeCompare(String(y.tag)));
}

/** Previsto para a exportação: por equipamento e cliente com tarifa, uma linha por OS solicitada no
 * período (dias de Brasília; sem datas, todas) e as OS de outros clientes com o mesmo equipamento, que
 * não entram, com o motivo. No escopo de organizações de quem exporta. */
export async function forecastRows(f:{start:string|null,end:string|null,org:string|null},scope:string[]|null){
 const rates=(await ratesOf(db())).map(toRate);
 const t0=f.start?dayStart(f.start):Date.UTC(2020,0,1),t1=f.end?dayStart(f.end)+DAY:Date.UTC(2100,0,1);
 const see=(orgId:string)=>!scope||scope.includes(orgId);
 const pairs=[...new Map(rates.filter(r=>(!f.org||r.orgId===f.org)&&see(r.orgId)).map(r=>[r.equipmentId+'|'+r.orgId,r] as const)).values()];
 const [equipment,orgs]=await Promise.all([db().all('SELECT id,tag FROM equipment'),db().all('SELECT id,name FROM requester_orgs')]);
 const out:Row[]=[];
 for(const p of pairs){
  const {orders,others}=await forecast(p,rates,t0,t1,see);
  const tag=equipment.find(e=>e.id===p.equipmentId)?.tag,rateOrg=orgs.find(o=>o.id===p.orgId)?.name;
  for(const o of orders)out.push({tag,rate_org:rateOrg,number:o.number,order_org:rateOrg,status:o.status,start:o.start,end:o.end,hours:o.hours,dailies:o.dailies,value_cents:o.valueCents,counted:o.counted,
   note:o.counted?(o.attendedIn.length?`Atendida na diária da ${o.attendedIn.map(osNumber).join(', ')}`:null):o.reason});
  for(const o of others)out.push({tag,rate_org:rateOrg,number:o.number,order_org:o.orgName,status:o.status,start:o.start,end:o.end,hours:o.hours,dailies:0,value_cents:0,counted:false,note:o.reason});
 }
 return out.sort((x,y)=>ms(x.start)-ms(y.start)||String(x.tag).localeCompare(String(y.tag)));
}

// ---- Comandos ----

/** Diárias novas que este uso gera com o período informado (sem fim: conta até agora), para pedir
 * confirmação acima de 1. Diária já aberta por outro uso do cliente não conta. */
async function preview(ex:Executor,u:Row,start:string,end:string|null){
 const rates=(await ratesOf(ex,u.equipment_id,u.org_id)).map(toRate),t=Date.now();
 const near=(await usesNear(ex,u.equipment_id,u.org_id,ms(start),end?ms(end):t)).filter(x=>x.id!==u.id).map(toInterval);
 const self:Interval={...toInterval({...u,started_at:start,ended_at:end}),orderNumber:Number(u.number)};
 const sum=(list:Daily[])=>list.reduce((s,d)=>s+d.valueCents,0),before=dailies(near,rates,t),after=dailies([...near,self],rates,t);
 return {n:after.length-before.length,cents:sum(after)-sum(before)};
}
function confirmation(start:string,end:string|null,p:{n:number,cents:number}){
 const h=Math.round(((end?ms(end):Date.now())-ms(start))/H*10)/10;
 return {confirm:true,dailies:p.n,valueCents:p.cents,message:`Este uso${end?'':', em aberto,'} ${end?'soma':'já soma'} ${h.toLocaleString('pt-BR')} h e gera ${p.n} diárias novas (${brl(p.cents)}). Confirmar?`};
}
async function reviewOf(ex:Executor,u:Row,start:string,end:string){
 return minutesOutside([ms(start),ms(end)],await reservedWindows(ex,u,u.equipment_id))>TOLERANCE_MIN?'a_conferir':'normal';
}
/** Quem registra: Operação com a OS aberta; Financeiro e Gestão em qualquer situação. */
function canRegister(a:Actor,wo:Row){
 if(!inScope(a,wo.org_id))throw new AppError('OS não encontrada ou fora do seu acesso.',404);
 if(isFinance(a))return;
 if(!a.capabilities.includes('operacao'))throw new AppError('Seu acesso não permite registrar uso de equipamento.',403);
 if(!OPEN.includes(wo.status))throw new AppError('Esta OS já foi encerrada: o registro de uso passa pelo Financeiro.',409);
}
/** Ação de auditoria conforme o acesso usado: Operação com a OS aberta; senão, Financeiro. */
const actionFor=(a:Actor,wo:Row,op:string,fin:string)=>OPEN.includes(wo.status)&&(isManager(a)||a.capabilities.includes('operacao'))?op:fin;

export async function financeMutate(path:string,b:Row,member:Member){
 if(path==='finance/rates'){
  const a=await requireAny(member,['financeiro']) as Actor;
  const equipment=await db().first('SELECT id,tag FROM equipment WHERE id=?',required(b.equipmentId,'Equipamento',100));
  const org=await db().first('SELECT id,name FROM requester_orgs WHERE id=?',required(b.orgId,'Cliente',100));
  if(!equipment||!org)throw new AppError('Escolha equipamento e cliente cadastrados.');
  if(!inScope(a,org.id))throw new AppError('Cliente fora do seu acesso.',403);
  const hourly=Number(b.hourly),hours=Number(b.hoursPerDay);
  if(!Number.isFinite(hourly)||hourly<0||hourly>1000000)throw new AppError('Informe o valor por hora em reais.');
  if(!Number.isInteger(hours)||hours<1||hours>168)throw new AppError('Horas por diária: de 1 a 168.');
  const validFrom=isoDay(b.validFrom),active=b.active===false?0:1,rid=id();
  if(await db().first('SELECT 1 FROM recovery_rates WHERE equipment_id=? AND org_id=? AND valid_from=?',equipment.id,org.id,validFrom))
   throw new AppError('Já existe uma vigência nessa data para este equipamento e cliente.',409);
  // Diárias já contadas mantêm a tarifa da época: a vigência começa depois do último uso registrado.
  const last=Number((await db().first('SELECT extract(epoch FROM max(coalesce(ended_at::timestamptz,now())))*1000 t FROM equipment_uses WHERE equipment_id=? AND org_id=?',equipment.id,org.id))?.t)||0;
  if(last&&dayStart(validFrom)<last)throw new AppError(`Já há uso registrado deste equipamento para este cliente em ${localDay.format(last).split('-').reverse().join('/')}. A nova vigência deve começar depois desse dia: as diárias já contadas mantêm a tarifa da época.`,409);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO recovery_rates(id,equipment_id,org_id,hourly_cents,hours_per_day,valid_from,active,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?)',
    rid,equipment.id,org.id,Math.round(hourly*100),hours,validFrom,active,now(),a.id,a.name);
   await audit(tx,a,'Financeiro: tarifa cadastrada',rid,{tag:equipment.tag,org:org.name,hourlyCents:Math.round(hourly*100),hoursPerDay:hours,validFrom,active:!!active});
  });
  return {id:rid};
 }

 if(path==='finance/uses/start'){
  const a=await loadAccess(member) as Actor;
  const key=required(b.operationKey,'Identificador da operação',100);
  const repeated=await db().first('SELECT id FROM equipment_uses WHERE operation_key=?',key);if(repeated)return {id:repeated.id,repeated:true};
  const wo=await db().first('SELECT * FROM work_orders WHERE id=?',required(b.workOrderId,'OS',100));
  if(!wo)throw new AppError('OS não encontrada.',404);
  canRegister(a,wo);
  const equipmentId=required(b.equipmentId,'Equipamento',100);
  if(!await db().first('SELECT 1 FROM reservations WHERE plan_id=? AND equipment_id=?',wo.current_plan_id,equipmentId))throw new AppError('Escolha um equipamento reservado nesta OS.');
  const start=moment(b.startedAt,'Início do uso');
  // Registro retroativo completo: início e fim juntos (um início em aberto no passado colidiria com
  // os usos registrados depois dele).
  const end=b.endedAt==null||b.endedAt===''?null:moment(b.endedAt,'Fim do uso');
  if(end&&ms(end)<=ms(start))throw new AppError('O fim do uso deve ser depois do início.');
  if(!rateAt((await ratesOf(db(),equipmentId,wo.org_id)).map(toRate),equipmentId,wo.org_id,ms(start)))throw new AppError('Equipamento sem tarifa de recobrável para o cliente desta OS nessa data.');
  if(!end){const later=await db().first('SELECT w.number FROM equipment_uses u JOIN work_orders w ON w.id=u.work_order_id WHERE u.equipment_id=? AND u.started_at::timestamptz > ?::timestamptz ORDER BY u.started_at::timestamptz LIMIT 1',equipmentId,start);
   if(later)throw new AppError(`Já existe uso deste equipamento depois desse horário (${osNumber(later.number)}). Para registrar um uso passado, informe também o fim.`,409);}
  const uid=id();
  try{
   return await db().tx(async tx=>{
    const draft:Row={id:uid,work_order_id:wo.id,equipment_id:equipmentId,org_id:wo.org_id,number:wo.number,current_plan_id:wo.current_plan_id};
    const p=await preview(tx,draft,start,end);if(p.n>1&&b.confirm!==true)return confirmation(start,end,p);
    await tx.run('INSERT INTO equipment_uses(id,work_order_id,equipment_id,org_id,started_at,ended_at,end_source,ended_by,ended_by_name,review,started_by,started_by_name,operation_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
     uid,wo.id,equipmentId,wo.org_id,start,end,end?'registrado':null,end?a.id:null,end?a.name:null,end?await reviewOf(tx,draft,start,end):'normal',a.id,a.name,key,now());
    await audit(tx,a,actionFor(a,wo,end?'Operação: uso de equipamento registrado':'Operação: início de uso de equipamento','Financeiro: uso registrado'),uid,{number:wo.number,equipmentId,startedAt:start,endedAt:end});
    return {id:uid,message:end?'Uso registrado.':'Início de uso registrado.'};
   });
  }catch(e){dbError(e);}
 }

 if(path==='finance/uses/end'||path==='finance/uses/correct'||path==='finance/uses/confirm'){
  const a=await loadAccess(member) as Actor;
  const correcting=path!=='finance/uses/end';
  if(correcting&&!isFinance(a))throw new AppError('Corrigir e conferir uso é do Financeiro.',403);
  try{
   return await db().tx(async tx=>{
    const u=await tx.first('SELECT u.*,w.status,w.number,w.current_plan_id FROM equipment_uses u JOIN work_orders w ON w.id=u.work_order_id WHERE u.id=? FOR UPDATE OF u',required(b.id,'Uso',100));
    if(!u)throw new AppError('Uso não encontrado.',404);
    canRegister(a,u);
    const t=now();
    if(path==='finance/uses/confirm'){
     if(!u.ended_at)throw new AppError('Registre o fim do uso antes de conferir.',409);
     await tx.run("UPDATE equipment_uses SET review='conferido',reviewed_by=?,reviewed_by_name=?,reviewed_at=? WHERE id=?",a.id,a.name,t,u.id);
     await audit(tx,a,'Financeiro: uso conferido',u.id,{number:u.number});
     return {ok:true,message:'Uso conferido.'};
    }
    if(path==='finance/uses/end'){
     if(u.ended_at)throw new AppError('Este uso já foi encerrado. Para mudar o horário, use Corrigir (Financeiro).',409);
     const end=moment(b.endedAt,'Fim do uso');
     if(ms(end)<=ms(u.started_at))throw new AppError('O fim do uso deve ser depois do início.');
     const p=await preview(tx,u,u.started_at,end);
     if(p.n>1&&b.confirm!==true)return confirmation(u.started_at,end,p);
     await tx.run("UPDATE equipment_uses SET ended_at=?,end_source='registrado',ended_by=?,ended_by_name=?,review=? WHERE id=?",end,a.id,a.name,await reviewOf(tx,u,u.started_at,end),u.id);
     await audit(tx,a,actionFor(a,u,'Operação: fim de uso de equipamento','Financeiro: uso registrado'),u.id,{number:u.number,endedAt:end});
     return {ok:true,message:'Fim de uso registrado.'};
    }
    // Correção: Financeiro ajusta início e/ou fim com motivo; o uso passa a conferido.
    const reason=required(b.reason,'Motivo da correção',1200);
    const start=b.startedAt?moment(b.startedAt,'Início do uso'):u.started_at;
    const end=b.endedAt?moment(b.endedAt,'Fim do uso'):u.ended_at;
    if(end&&ms(end)<=ms(start))throw new AppError('O fim do uso deve ser depois do início.');
    const p=await preview(tx,u,start,end);if(p.n>1&&b.confirm!==true)return confirmation(start,end,p);
    await tx.run(`UPDATE equipment_uses SET started_at=?,ended_at=?,end_source=CASE WHEN ?::text IS NULL THEN NULL ELSE coalesce(end_source,'registrado') END,
     ended_by=coalesce(ended_by,?),ended_by_name=coalesce(ended_by_name,?),review='conferido',reviewed_by=?,reviewed_by_name=?,reviewed_at=? WHERE id=?`,
     start,end,end,end?a.id:null,end?a.name:null,a.id,a.name,t,u.id);
    await audit(tx,a,'Financeiro: uso corrigido',u.id,{number:u.number,reason:text(reason,1200),before:{startedAt:u.started_at,endedAt:u.ended_at},after:{startedAt:start,endedAt:end}});
    return {ok:true,message:'Uso corrigido e conferido.'};
   });
  }catch(e){dbError(e);}
 }
 throw new AppError('Ação não encontrada.',404);
}

/** Fim automático: encerra os usos em aberto da OS (todos ou dos equipamentos informados) no
 * momento da finalização ou dispensa da etapa, da conclusão ou do cancelamento, marcados "a
 * conferir". A auditoria segue o acesso de quem age (dispensa e cancelamento são do Planejamento). */
export async function closeOpenUses(tx:Executor,a:Member,workOrderId:string,at:string,source:'etapa'|'cancelamento',equipmentIds?:string[]){
 if(equipmentIds&&!equipmentIds.length)return 0;
 const rows=await tx.all(`UPDATE equipment_uses SET ended_at=?,end_source=?,review='a_conferir',ended_by=?,ended_by_name=?
  WHERE work_order_id=? AND ended_at IS NULL AND started_at::timestamptz < ?::timestamptz${equipmentIds?' AND equipment_id = ANY(?::text[])':''} RETURNING id`,
  at,source,a.id,a.name,workOrderId,at,...(equipmentIds?[equipmentIds]:[]));
 const by=source==='etapa'&&has(a,'operacao')?'Operação':'Planejamento';
 for(const r of rows)await audit(tx,a,`${by}: fim automático de uso de equipamento`,r.id,{endedAt:at,source});
 return rows.length;
}
