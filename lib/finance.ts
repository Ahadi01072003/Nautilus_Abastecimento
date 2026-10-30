// Financeiro · recobráveis por equipamento: tarifas com vigência e uso real do equipamento nas OS
// (início e fim). As diárias saem do motor puro (lib/recoverables) a partir dos usos; nada de diária
// é gravado. A Operação registra o uso com a OS aberta; o Financeiro (e a Gestão) registra, corrige
// e confere em qualquer situação. Usos fora do período reservado ou com fim automático ficam
// "a conferir" até alguém do Financeiro revisar.
import {db,type Executor,type Row} from './db';
import {AppError,required,text,isoDay} from './domain';
import {type Member,isManager,requireAny,loadAccess} from './permissions';
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
 await requireAny(member,['financeiro']);
 const [rates,equipment,orgs]=await Promise.all([
  db().all('SELECT r.*,e.tag,o.name org_name FROM recovery_rates r JOIN equipment e ON e.id=r.equipment_id JOIN requester_orgs o ON o.id=r.org_id ORDER BY e.tag,o.name,r.valid_from DESC'),
  db().all('SELECT id,tag,description,active FROM equipment ORDER BY tag'),
  db().all('SELECT id,name,acronym,active FROM requester_orgs ORDER BY name'),
 ]);
 return {rates,equipment,orgs};
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
 const rows:PanelRow[]=[],detail:Record<string,{dailies:Daily[],pending:Row[]}>={};
 const iso=(t:number)=>new Date(t).toISOString();
 for(const p of pairs){
  const mine=rates.filter(r=>r.equipmentId===p.equipmentId&&r.orgId===p.orgId);
  const [res,uses]=await Promise.all([
   db().all(`SELECT r.start_at,r.end_at,r.status,w.id order_id,w.number,w.status order_status,
     EXISTS (SELECT 1 FROM equipment_uses u WHERE u.work_order_id=w.id AND u.equipment_id=r.equipment_id) used
    FROM reservations r JOIN work_orders w ON w.current_plan_id=r.plan_id
    WHERE r.equipment_id=? AND w.org_id=? AND r.start_at::timestamptz < ?::timestamptz AND r.end_at::timestamptz > ?::timestamptz`,p.equipmentId,p.orgId,iso(t1+8*DAY),iso(t0-8*DAY)),
   usesNear(db(),p.equipmentId,p.orgId,t0,t1),
  ]);
  const inPeriod=(x:Row)=>ms(x.start_at)<t1&&ms(x.end_at)>t0;
  const requested=res.filter(x=>inPeriod(x)&&(x.order_status!=='cancelada'||x.used));
  const orders=new Map(requested.map(x=>[x.order_id as string,x.order_status as string]));
  const planned=res.filter(x=>x.status==='confirmada'&&x.order_status!=='cancelada');
  const plannedHours=planned.filter(inPeriod).reduce((h,x)=>h+(Math.min(ms(x.end_at),t1)-Math.max(ms(x.start_at),t0))/H,0);
  const plan=dailies(planned.map((x,i)=>({id:'r'+i,orderId:x.order_id,orderNumber:Number(x.number),equipmentId:p.equipmentId,orgId:p.orgId,start:ms(x.start_at),end:ms(x.end_at),pending:false})),mine,Date.now())
   .filter(d=>d.start>=t0&&d.start<t1);
  const real=dailies(uses.map(toInterval),mine,Date.now()).filter(d=>d.start>=t0&&d.start<t1);
  const plannedCents=plan.reduce((s,d)=>s+d.valueCents,0);
  rows.push({equipmentId:p.equipmentId,tag:equipment.find(e=>e.id===p.equipmentId)?.tag||'',orgId:p.orgId,orgName:orgs.find(o=>o.id===p.orgId)?.name||'',
   requests:orders.size,scheduled:[...orders.values()].filter(s=>s==='programada').length,plannedHours:Math.round(plannedHours*10)/10,
   plannedDailies:plan.length,plannedCents,avgPerOrderCents:orders.size?Math.round(plannedCents/orders.size):0,
   dailies:real.length,confirmedCents:real.filter(d=>!d.pending).reduce((s,d)=>s+d.valueCents,0),pendingCents:real.filter(d=>d.pending).reduce((s,d)=>s+d.valueCents,0)});
  detail[p.equipmentId+'|'+p.orgId]={dailies:real,pending:uses.filter(u=>(u.review==='a_conferir'||!u.ended_at)&&ms(u.started_at)>=t0&&ms(u.started_at)<t1)};
 }
 return {period:{from,to},rows:rows.sort((x,y)=>x.tag.localeCompare(y.tag)||x.orgName.localeCompare(y.orgName)),detail,orgs:orgs.filter(o=>rates.some(r=>r.orgId===o.id))};
}

// ---- Comandos ----

/** Diárias que este uso tocaria com o período informado (para pedir confirmação acima de 1). */
async function preview(ex:Executor,u:Row,start:string,end:string){
 const rates=(await ratesOf(ex,u.equipment_id,u.org_id)).map(toRate);
 const near=(await usesNear(ex,u.equipment_id,u.org_id,ms(start),ms(end))).filter(x=>x.id!==u.id).map(toInterval);
 const self:Interval={...toInterval({...u,started_at:start,ended_at:end}),orderNumber:Number(u.number)};
 const touched=dailies([...near,self],rates,Date.now()).filter(d=>d.intervalIds.includes(u.id));
 return {n:touched.length,cents:touched.reduce((s,d)=>s+d.valueCents,0)};
}
function confirmation(start:string,end:string,p:{n:number,cents:number}){
 const h=Math.round((ms(end)-ms(start))/H*10)/10;
 return {confirm:true,dailies:p.n,valueCents:p.cents,message:`Este uso soma ${h.toLocaleString('pt-BR')} h e gera ${p.n} diárias (${brl(p.cents)}). Confirmar?`};
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
  const a=await requireAny(member,['financeiro']);
  const equipment=await db().first('SELECT id,tag FROM equipment WHERE id=?',required(b.equipmentId,'Equipamento',100));
  const org=await db().first('SELECT id,name FROM requester_orgs WHERE id=?',required(b.orgId,'Cliente',100));
  if(!equipment||!org)throw new AppError('Escolha equipamento e cliente cadastrados.');
  const hourly=Number(b.hourly),hours=Number(b.hoursPerDay);
  if(!Number.isFinite(hourly)||hourly<0||hourly>1000000)throw new AppError('Informe o valor por hora em reais.');
  if(!Number.isInteger(hours)||hours<1||hours>168)throw new AppError('Horas por diária: de 1 a 168.');
  const validFrom=isoDay(b.validFrom),active=b.active===false?0:1,rid=id();
  if(await db().first('SELECT 1 FROM recovery_rates WHERE equipment_id=? AND org_id=? AND valid_from=?',equipment.id,org.id,validFrom))
   throw new AppError('Já existe uma vigência nessa data para este equipamento e cliente.',409);
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
    if(end){const p=await preview(tx,draft,start,end);if(p.n>1&&b.confirm!==true)return confirmation(start,end,p);}
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
    if(end){const p=await preview(tx,u,start,end);if(p.n>1&&b.confirm!==true)return confirmation(start,end,p);}
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
 * momento da finalização da etapa ou do cancelamento, marcados "a conferir". */
export async function closeOpenUses(tx:Executor,a:Member,workOrderId:string,at:string,source:'etapa'|'cancelamento',equipmentIds?:string[]){
 if(equipmentIds&&!equipmentIds.length)return 0;
 const rows=await tx.all(`UPDATE equipment_uses SET ended_at=?,end_source=?,review='a_conferir',ended_by=?,ended_by_name=?
  WHERE work_order_id=? AND ended_at IS NULL AND started_at::timestamptz < ?::timestamptz${equipmentIds?' AND equipment_id = ANY(?::text[])':''} RETURNING id`,
  at,source,a.id,a.name,workOrderId,at,...(equipmentIds?[equipmentIds]:[]));
 for(const r of rows)await audit(tx,a,source==='etapa'?'Operação: fim automático de uso de equipamento':'Planejamento: fim automático de uso de equipamento',r.id,{endedAt:at,source});
 return rows.length;
}
