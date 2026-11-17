// Programação do dia · indicadores por barra, do dia e do mês até hoje:
// - Cumprimento do plano = HH concluído ÷ HH consolidado (OS da última consolidação do dia, sem as emergenciais). Uma OS
//   conta no dia se, nele, teve execução apontada; no último dia dela, só se estiver concluída até esse dia.
// - Ocupação da equipe = HH programado (OS lançadas do dia) ÷ HH disponível.
// - Precisão da estimativa = 1 − |real − estimado| ÷ estimado (mínimo 0), para as OS concluídas no dia, com o tempo
//   efetivo da Operação contra a duração estimada × dias trabalhados.
// - Emergenciais à parte (quantidade e HH). Exporta Excel com as abas Dias e OS.
import {db,type Row} from './db';
import {AppError} from './domain';
import {type Member,requireAny} from './permissions';
import {barOf,barName,plusDays,staffFor,roundHh,type BarId} from './capacity';
import {dayLoad,consolidationOf} from './d1';
import {dayOf,dayStart,dayText} from './days';
import {effective} from './exports';
import {xlsx,type Sheet} from './files';

const pct=(a:number,b:number)=>b>0?Math.round(a/b*1000)/10:null;
const brtDay=(iso:string|null)=>iso?dayOf(Date.parse(iso)):null;

function monthDays(month:string){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new AppError('Mês inválido: use AAAA-MM.');
 const today=dayOf(Date.now()),out:string[]=[];
 for(let d=`${month}-01`;d.startsWith(month)&&d<=today;d=plusDays(d,1))out.push(d);
 return out;
}

type OsRow={day:string,label:string,title:string,hours:number,people:number,hh:number,emergency:boolean,consolidated:boolean,done:boolean,realHours:number|null,precision:number|null};

async function dayFigures(bar:BarId,day:string){
 const [load,last,[staff]]=await Promise.all([dayLoad(bar,day),consolidationOf(bar,day),staffFor(bar,[day])]);
 const snap=last?(last.snapshot as Row):null;
 const base=snap?(snap.cards as Row[]).filter(c=>!c.emergency):[];
 const baseKeys=new Set(base.map(c=>c.workOrderId||c.planId));
 const woIds=[...new Set(load.map(c=>c.workOrderId).filter(Boolean))] as string[];
 const [wos,worked]=await Promise.all([
  woIds.length?db().all('SELECT id,status,closed_at FROM work_orders WHERE id=ANY(?::text[])',woIds):Promise.resolve([] as Row[]),
  woIds.length?db().all(`SELECT DISTINCT s.work_order_id FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id
   WHERE i.kind='ativo' AND s.work_order_id=ANY(?::text[]) AND i.start_at<? AND coalesce(i.end_at,i.start_at)>=?`,woIds,dayStart(plusDays(day,1)),dayStart(day)):Promise.resolve([] as Row[]),
 ]);
 const closedOn=(id:string|null)=>{const w=wos.find(x=>x.id===id);return w&&w.status==='concluida'?brtDay(w.closed_at):null;};
 const doneOn=(c:{workOrderId:string|null,lastDay:string})=>{
  const closed=closedOn(c.workOrderId);
  if(closed&&closed<=day)return true;
  return c.lastDay>day&&worked.some(w=>w.work_order_id===c.workOrderId);
 };
 const concludedToday=load.filter(c=>c.workOrderId&&closedOn(c.workOrderId)===day&&c.hours>0);
 const real=await effective(concludedToday.map(c=>c.workOrderId!));
 const precisionOf=new Map<string,number>();
 for(const c of concludedToday){
  const days=Math.max(1,Math.round((Date.parse(c.lastDay)-Date.parse(c.firstDay))/86_400_000)+1);
  const est=c.hours*days,act=(real.get(c.workOrderId!)||0)/3600;
  precisionOf.set(c.workOrderId!,Math.max(0,1-Math.abs(act-est)/est));
 }
 const plannedHh=roundHh(base.reduce((t,c)=>t+Number(c.hh),0));
 const doneHh=roundHh(load.filter(c=>baseKeys.has(c.workOrderId||c.planId)&&doneOn(c)).reduce((t,c)=>t+c.hh,0));
 const programmedHh=roundHh(load.reduce((t,c)=>t+c.hh,0));
 const availableHh=snap?Number(snap.staff.hh):staff.hh;
 const em=load.filter(c=>c.emergency);
 const precisions=[...precisionOf.values()];
 const rows:OsRow[]=load.map(c=>({day,label:c.label,title:c.title,hours:c.hours,people:c.people,hh:c.hh,emergency:c.emergency,consolidated:baseKeys.has(c.workOrderId||c.planId),
  done:doneOn(c),realHours:c.workOrderId&&real.has(c.workOrderId)?roundHh((real.get(c.workOrderId)||0)/3600):null,
  precision:c.workOrderId&&precisionOf.has(c.workOrderId)?Math.round(precisionOf.get(c.workOrderId)!*1000)/10:null}));
 return {day,consolidated:!!snap,availableHh,programmedHh,plannedHh,doneHh,emergencyCount:em.length,emergencyHh:roundHh(em.reduce((t,c)=>t+c.hh,0)),
  compliance:snap?pct(doneHh,plannedHh):null,occupancy:pct(programmedHh,availableHh),
  precision:precisions.length?Math.round(precisions.reduce((t,x)=>t+x,0)/precisions.length*1000)/10:null,precisionSum:precisions.reduce((t,x)=>t+x,0),precisionN:precisions.length,rows};
}

export async function indicators(member:Member,url:URL){
 await requireAny(member,['planejamento','operacao','acompanhamento']);
 const bar=barOf(url.searchParams.get('bar')||'equinor');
 const month=url.searchParams.get('month')||dayOf(Date.now()).slice(0,7);
 const days:Awaited<ReturnType<typeof dayFigures>>[]=[];for(const d of monthDays(month))days.push(await dayFigures(bar,d));
 const sum=(k:'plannedHh'|'doneHh'|'programmedHh'|'availableHh'|'emergencyHh'|'emergencyCount'|'precisionSum'|'precisionN',only=false)=>days.filter(d=>!only||d.consolidated).reduce((t,d)=>t+Number(d[k]),0);
 const pn=sum('precisionN');
 return {bar,barName:barName(bar),period:month,
  days:days.map(d=>({day:d.day,consolidated:d.consolidated,availableHh:d.availableHh,programmedHh:d.programmedHh,plannedHh:d.plannedHh,doneHh:d.doneHh,
   emergencyCount:d.emergencyCount,emergencyHh:d.emergencyHh,compliance:d.compliance,occupancy:d.occupancy,precision:d.precision})),
  rows:days.flatMap(d=>d.rows),
  month:{compliance:pct(sum('doneHh',true),sum('plannedHh',true)),occupancy:pct(sum('programmedHh'),sum('availableHh')),
   precision:pn?Math.round(sum('precisionSum')/pn*1000)/10:null,emergencyCount:sum('emergencyCount'),emergencyHh:roundHh(sum('emergencyHh'))}};
}

async function exportIndicators(member:Member,url:URL){
 const r=await indicators(member,url);
 const yes=(b:boolean)=>b?'Sim':'Não';
 const sheets:Sheet[]=[
  {name:'Dias',columns:['Dia','Consolidado','HH disponível','HH programado','HH consolidado','HH concluído','Cumprimento (%)','Ocupação (%)','Precisão (%)','Emergenciais','HH emergencial'],
   rows:r.days.map(d=>[dayText(d.day),yes(d.consolidated),d.availableHh,d.programmedHh,d.plannedHh,d.doneHh,d.compliance,d.occupancy,d.precision,d.emergencyCount,d.emergencyHh])},
  {name:'OS',columns:['Dia','OS','Atividade','Duração estimada (h)','Pessoas','HH','Consolidada','Emergencial','Cumprida no dia','Horas reais','Precisão (%)'],
   rows:r.rows.map(o=>[dayText(o.day),o.label,o.title,o.hours,o.people,o.hh,yes(o.consolidated),yes(o.emergency),yes(o.done),o.realHours,o.precision])},
 ];
 const name=`indicadores-${r.bar}-${r.period}.xlsx`;
 return new Response(new Uint8Array(xlsx(sheets)),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':`attachment; filename="${name}"`}});
}

export async function indicatorsGet(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/indicators')return indicators(member,url);
 if(path==='planning/indicators/export')return exportIndicators(member,url);
 return null;
}
