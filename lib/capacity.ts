// Planejamento: barras OCP e Equinor e o HH disponível de cada dia = funcionários × horas trabalhadas. A Gestão
// define o padrão da barra (funcionários em dia útil e no fim de semana, jornada em horas); o planejador corrige
// um dia específico (falta, férias, reforço, jornada menor) no D+1.
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
export const roundHh=(n:number)=>Math.round(n*100)/100;
export const hText=(n:number)=>String(roundHh(n)).replace('.',',');

export const barRow=(b:Row)=>({id:b.id as BarId,name:b.name as string,color:b.color as string,staffWeekday:Number(b.staff_weekday),staffWeekend:Number(b.staff_weekend),
 hours:Number(b.hours),updatedAt:b.updated_at||null,updatedByName:b.updated_by_name||null});
export const loadBars=async()=>db().all('SELECT id,name,color,staff_weekday,staff_weekend,hours,updated_at,updated_by_name FROM plan_bars ORDER BY id');

export function barOf(value:unknown):BarId{const b=String(value||'');if(!(BARS as readonly string[]).includes(b))throw new AppError('Escolha a barra: OCP ou Equinor.');return b as BarId;}
const blank=(v:unknown)=>v==null||String(v).trim()==='';
/** Funcionários: número inteiro de 0 a 500. */
export function staffNumber(v:unknown,label='Funcionários'){
 const n=typeof v==='number'?v:Number(String(v??'').trim().replace(',','.'));
 if(blank(v)||!Number.isInteger(n)||n<0||n>MAX_STAFF)throw new AppError(`${label}: informe um número inteiro de funcionários, de 0 a ${MAX_STAFF}.`);
 return n;
}
/** Horas trabalhadas no dia: de 0,25 a 24, de quarto em quarto de hora. */
export function hoursNumber(v:unknown,label='Horas trabalhadas'){
 const n=typeof v==='number'?v:Number(String(v??'').trim().replace(',','.'));
 if(blank(v)||!Number.isFinite(n)||n<0.25||n>24||Math.round(n*4)!==n*4)throw new AppError(`${label}: informe as horas do dia, de 0,25 a 24.`);
 return n;
}

/** Efetivo de cada dia (funcionários, horas e HH): o corrigido no dia ou, sem correção, o padrão da barra. */
export async function staffFor(bar:BarId,days:string[]){
 const b=barRow((await loadBars()).find(x=>x.id===bar)!);
 const rows=days.length?await db().all(`SELECT to_char(day,'YYYY-MM-DD') AS day,people,hours,note,updated_by_name,updated_at FROM plan_day_staff WHERE bar=? AND day=ANY(?::date[])`,bar,days):[];
 return days.map(day=>{
  const standard={people:isWeekend(day)?b.staffWeekend:b.staffWeekday,hours:b.hours},r=rows.find(x=>x.day===day);
  const people=r?Number(r.people):standard.people,hours=r?Number(r.hours):standard.hours;
  return {day,people,hours,hh:roundHh(people*hours),standard,source:(r?'dia':'padrao') as 'dia'|'padrao',
   note:(r?.note as string)||null,byName:(r?.updated_by_name as string)||null,at:(r?.updated_at as string)||null};
 });
}

export async function capacityGet(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/bars'){
  await requireAny(member,['planejamento','operacao','acompanhamento','cadastros']);
  return {bars:(await loadBars()).map(barRow)};
 }
 return null;
}

/** Padrão da barra (só a Gestão): funcionários em dia útil e no fim de semana e a jornada em horas. */
async function saveBar(a:Member,b:Row){
 if(!isManager(a))throw new AppError('Somente a Gestão define o padrão das barras.',403);
 const bid=barOf(b.id);
 const weekdayStaff=staffNumber(b.staffWeekday,'Funcionários em dia útil'),weekendStaff=staffNumber(b.staffWeekend,'Funcionários no fim de semana'),hours=hoursNumber(b.hours,'Jornada (horas por dia)');
 await db().tx(async tx=>{
  const before=await tx.first('SELECT staff_weekday,staff_weekend,hours FROM plan_bars WHERE id=? FOR UPDATE',bid);
  await tx.run('UPDATE plan_bars SET staff_weekday=?,staff_weekend=?,hours=?,updated_at=?,updated_by_name=? WHERE id=?',weekdayStaff,weekendStaff,hours,now(),a.name,bid);
  await audit(tx,a,'Planejamento: padrão da barra',bid,{before,after:{staffWeekday:weekdayStaff,staffWeekend:weekendStaff,hours}});
 });
 return {ok:true,message:`Barra ${barName(bid)}: ${weekdayStaff} funcionários em dia útil e ${weekendStaff} no fim de semana, ${hText(hours)} h por dia.`};
}

export async function capacityMutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/bars/save'){await requireAny(member,['planejamento']);return saveBar(member,b);}
 return null;
}
