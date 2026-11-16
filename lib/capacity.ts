// Planejamento: barras OCP e Equinor e o efetivo de cada dia, em pessoas. A Gestão define o padrão da barra
// (dia útil e fim de semana); o planejador corrige um dia específico (falta, férias, reforço) no D+1.
import {db,type Row} from './db';
import {AppError} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';

export const BARS=['equinor','ocp'] as const;
export type BarId=typeof BARS[number];
export const MAX_STAFF=500;
const now=()=>new Date().toISOString();
const DAY=86_400_000;
const ymdMs=(d:string)=>Date.parse(d+'T12:00:00Z');
export const plusDays=(d:string,n:number)=>new Date(ymdMs(d)+n*DAY).toISOString().slice(0,10);
/** Dia da semana (0 = domingo) de um dia AAAA-MM-DD. */
export const weekday=(d:string)=>new Date(ymdMs(d)).getUTCDay();
export const isWeekend=(d:string)=>{const w=weekday(d);return w===0||w===6;};
export const barName=(b:string)=>b==='ocp'?'OCP':'Equinor';

export const barRow=(b:Row)=>({id:b.id as BarId,name:b.name as string,color:b.color as string,staffWeekday:Number(b.staff_weekday),staffWeekend:Number(b.staff_weekend),
 updatedAt:b.updated_at||null,updatedByName:b.updated_by_name||null});
export const loadBars=async()=>db().all('SELECT id,name,color,staff_weekday,staff_weekend,updated_at,updated_by_name FROM plan_bars ORDER BY id');

export function barOf(value:unknown):BarId{const b=String(value||'');if(!(BARS as readonly string[]).includes(b))throw new AppError('Escolha a barra: OCP ou Equinor.');return b as BarId;}
/** Efetivo em pessoas: número inteiro de 0 a 500. */
export function staffNumber(v:unknown,label='Efetivo'){
 const n=typeof v==='number'?v:Number(String(v??'').trim().replace(',','.'));
 if(v==null||String(v).trim()===''||!Number.isInteger(n)||n<0||n>MAX_STAFF)throw new AppError(`${label}: informe um número inteiro de pessoas, de 0 a ${MAX_STAFF}.`);
 return n;
}

/** Efetivo de cada dia: o corrigido no dia ou, sem correção, o padrão da barra (dia útil ou fim de semana). */
export async function staffFor(bar:BarId,days:string[]){
 const b=barRow((await loadBars()).find(x=>x.id===bar)!);
 const rows=days.length?await db().all(`SELECT to_char(day,'YYYY-MM-DD') AS day,people,note,updated_by_name,updated_at FROM plan_day_staff WHERE bar=? AND day=ANY(?::date[])`,bar,days):[];
 return days.map(day=>{
  const standard=isWeekend(day)?b.staffWeekend:b.staffWeekday,r=rows.find(x=>x.day===day);
  return {day,people:r?Number(r.people):standard,standard,source:(r?'dia':'padrao') as 'dia'|'padrao',note:(r?.note as string)||null,byName:(r?.updated_by_name as string)||null,at:(r?.updated_at as string)||null};
 });
}

export async function capacityGet(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/bars'){
  await requireAny(member,['planejamento','operacao','acompanhamento','cadastros']);
  return {bars:(await loadBars()).map(barRow)};
 }
 return null;
}

/** Efetivo padrão da barra (só a Gestão): pessoas em dia útil e no fim de semana. */
async function saveBar(a:Member,b:Row){
 if(!isManager(a))throw new AppError('Somente a Gestão define o efetivo padrão das barras.',403);
 const bid=barOf(b.id);
 const weekdayStaff=staffNumber(b.staffWeekday,'Efetivo de dia útil'),weekendStaff=staffNumber(b.staffWeekend,'Efetivo de fim de semana');
 await db().tx(async tx=>{
  const before=await tx.first('SELECT staff_weekday,staff_weekend FROM plan_bars WHERE id=? FOR UPDATE',bid);
  await tx.run('UPDATE plan_bars SET staff_weekday=?,staff_weekend=?,updated_at=?,updated_by_name=? WHERE id=?',weekdayStaff,weekendStaff,now(),a.name,bid);
  await audit(tx,a,'Planejamento: efetivo padrão da barra',bid,{before,after:{staffWeekday:weekdayStaff,staffWeekend:weekendStaff}});
 });
 return {ok:true,message:`Efetivo padrão da barra ${barName(bid)}: ${weekdayStaff} em dia útil e ${weekendStaff} no fim de semana.`};
}

export async function capacityMutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/bars/save'){await requireAny(member,['planejamento']);return saveBar(member,b);}
 return null;
}
