// Planejamento: barras OCP e Equinor e o HH disponível de cada dia = ADM (funcionários × horas do dia: segunda a
// sexta, sábado; domingo não) + Turno do dia (funcionários × horas, todos os dias). A Gestão define o padrão da
// barra; o planejador corrige ADM e turno de um dia específico (falta, férias, reforço) no D+1.
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

export const barRow=(b:Row)=>({id:b.id as BarId,name:b.name as string,color:b.color as string,
 admPeople:Number(b.adm_people),admHours:Number(b.adm_hours),admSaturdayHours:Number(b.adm_saturday_hours),shiftPeople:Number(b.shift_people),shiftHours:Number(b.shift_hours),
 updatedAt:b.updated_at||null,updatedByName:b.updated_by_name||null});
export const loadBars=async()=>db().all('SELECT id,name,color,adm_people,adm_hours,adm_saturday_hours,shift_people,shift_hours,updated_at,updated_by_name FROM plan_bars ORDER BY id');

export function barOf(value:unknown):BarId{const b=String(value||'');if(!(BARS as readonly string[]).includes(b))throw new AppError('Escolha a barra: OCP ou Equinor.');return b as BarId;}
const blank=(v:unknown)=>v==null||String(v).trim()==='';
/** Funcionários: número inteiro de 0 a 500. */
export function staffNumber(v:unknown,label='Funcionários'){
 const n=typeof v==='number'?v:Number(String(v??'').trim().replace(',','.'));
 if(blank(v)||!Number.isInteger(n)||n<0||n>MAX_STAFF)throw new AppError(`${label}: informe um número inteiro de funcionários, de 0 a ${MAX_STAFF}.`);
 return n;
}
/** Horas trabalhadas no dia: de 0 (ou 0,25) a 24, de quarto em quarto de hora. */
export function hoursNumber(v:unknown,label='Horas trabalhadas',min=0.25){
 const n=typeof v==='number'?v:Number(String(v??'').trim().replace(',','.'));
 if(blank(v)||!Number.isFinite(n)||n<min||n>24||Math.round(n*4)!==n*4)throw new AppError(`${label}: informe as horas do dia, de ${String(min).replace('.',',')} a 24.`);
 return n;
}
type Group={people:number,hours:number};
const groupHh=(g:Group)=>roundHh(g.people*g.hours);
/** Horas do ADM no dia da semana: segunda a sexta, sábado; domingo não trabalha. */
const admHoursOn=(b:ReturnType<typeof barRow>,day:string)=>{const w=weekday(day);return w===0?0:w===6?b.admSaturdayHours:b.admHours;};

/** Efetivo de cada dia (ADM e turno, funcionários e HH): o corrigido no dia ou, sem correção, o padrão da barra.
 *  osHours = horas que valem para a função da OS sem horas informadas (as do turno; sem turno, as do ADM). */
export async function staffFor(bar:BarId,days:string[]){
 const b=barRow((await loadBars()).find(x=>x.id===bar)!);
 const rows=days.length?await db().all(`SELECT to_char(day,'YYYY-MM-DD') AS day,adm_people,adm_hours,shift_people,shift_hours,note,updated_by_name,updated_at FROM plan_day_staff WHERE bar=? AND day=ANY(?::date[])`,bar,days):[];
 return days.map(day=>{
  const standard={adm:{people:b.admPeople,hours:admHoursOn(b,day)},shift:{people:b.shiftPeople,hours:b.shiftHours}},r=rows.find(x=>x.day===day);
  const adm:Group=r?{people:Number(r.adm_people),hours:Number(r.adm_hours)}:standard.adm,shift:Group=r?{people:Number(r.shift_people),hours:Number(r.shift_hours)}:standard.shift;
  const people=(adm.hours>0?adm.people:0)+(shift.hours>0?shift.people:0);
  const osHours=shift.people>0&&shift.hours>0?shift.hours:adm.hours>0?adm.hours:b.shiftHours;
  return {day,adm,shift,people,hh:roundHh(groupHh(adm)+groupHh(shift)),osHours,standard,source:(r?'dia':'padrao') as 'dia'|'padrao',
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

/** Padrão da barra (só a Gestão): ADM (funcionários, horas de segunda a sexta e de sábado) e turno do dia
 *  (funcionários e horas). */
async function saveBar(a:Member,b:Row){
 if(!isManager(a))throw new AppError('Somente a Gestão define o padrão das barras.',403);
 const bid=barOf(b.id);
 const v={admPeople:staffNumber(b.admPeople,'Funcionários do ADM'),admHours:hoursNumber(b.admHours,'Horas do ADM (segunda a sexta)',0),
  admSaturdayHours:hoursNumber(b.admSaturdayHours,'Horas do ADM no sábado',0),shiftPeople:staffNumber(b.shiftPeople,'Funcionários do turno por dia'),
  shiftHours:hoursNumber(b.shiftHours,'Horas do turno')};
 await db().tx(async tx=>{
  const before=await tx.first('SELECT adm_people,adm_hours,adm_saturday_hours,shift_people,shift_hours FROM plan_bars WHERE id=? FOR UPDATE',bid);
  await tx.run('UPDATE plan_bars SET adm_people=?,adm_hours=?,adm_saturday_hours=?,shift_people=?,shift_hours=?,updated_at=?,updated_by_name=? WHERE id=?',
   v.admPeople,v.admHours,v.admSaturdayHours,v.shiftPeople,v.shiftHours,now(),a.name,bid);
  await audit(tx,a,'Planejamento: padrão da barra',bid,{before,after:v});
 });
 const weekdayHh=roundHh(v.admPeople*v.admHours+v.shiftPeople*v.shiftHours);
 return {ok:true,message:`Barra ${barName(bid)}: ADM ${v.admPeople} × ${hText(v.admHours)} h + turno ${v.shiftPeople} × ${hText(v.shiftHours)} h = ${hText(weekdayHh)} HH em dia útil.`};
}

export async function capacityMutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/bars/save'){await requireAny(member,['planejamento']);return saveBar(member,b);}
 return null;
}
