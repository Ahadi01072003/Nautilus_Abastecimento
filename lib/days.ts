// Planejamento por dia: o período é sempre o dia inteiro de Brasília (UTC-3, sem horário de verão).
// Início = 00h do primeiro dia; fim = 00h do dia seguinte ao último (exclusivo). Assim os períodos
// continuam sendo data e hora para quem só compara intervalos, e as telas mostram só os dias.
import {AppError} from './domain';

export const DAY_MS=86_400_000;
/** Limite de horas de um equipamento por dia, somando todas as OS. */
export const EQUIPMENT_DAY_HOURS=12;
const YMD=/^\d{4}-\d{2}-\d{2}$/;
const fmtDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'});

/** Dia (AAAA-MM-DD) de Brasília em que cai o instante. */
export const dayOf=(iso:string|number|Date)=>fmtDay.format(new Date(iso));
/** 00h de Brasília do dia, em ISO. */
export const dayStart=(day:string)=>new Date(`${day}T03:00:00.000Z`).toISOString();
/** 00h de Brasília do dia seguinte (fim exclusivo do dia). */
export const dayAfter=(day:string)=>new Date(Date.parse(`${day}T03:00:00.000Z`)+DAY_MS).toISOString();
/** O instante é 00h de Brasília (fronteira de dia)? */
export const isDayBoundary=(iso:string|null|undefined)=>!!iso&&Number.isFinite(Date.parse(iso))&&dayStart(dayOf(iso))===new Date(iso).toISOString();
/** Último dia ocupado por um fim exclusivo. */
export const lastDay=(endIso:string)=>dayOf(Date.parse(endIso)-1);
/** Período em dias inteiros (as duas pontas em fronteira de dia)? */
export const isWholeDays=(start:string|null|undefined,end:string|null|undefined)=>isDayBoundary(start)&&isDayBoundary(end);
/** "12/11/2026". */
export const dayText=(day:string)=>day.split('-').reverse().join('/');
/** Dias (AAAA-MM-DD) de um período em dias inteiros. */
export function daysOf(start:string,end:string){
 const out:string[]=[];
 for(let t=Date.parse(dayStart(dayOf(start)));t<Date.parse(end)&&out.length<400;t+=DAY_MS)out.push(dayOf(t));
 return out;
}

function parseDay(value:unknown,label:string,edge:'start'|'end'):string|null{
 if(value==null||value==='')return null;
 if(typeof value!=='string'||value.length>40)throw new AppError(`${label}: data inválida.`);
 let day:string;
 if(YMD.test(value))day=value;
 else{
  // Data e hora (telas antigas): vale o dia de Brasília. Um fim exatamente às 00h é o dia anterior.
  const t=Date.parse(value);if(!Number.isFinite(t)||!/^\d{4}-\d{2}-\d{2}T/.test(value))throw new AppError(`${label}: data inválida.`);
  const y0=new Date(t).getUTCFullYear();if(y0<2000||y0>2100)throw new AppError(`${label}: ano ${y0} fora da faixa aceita (2000 a 2100).`);
  day=edge==='end'&&isDayBoundary(value)?lastDay(value):dayOf(t);
 }
 const d=new Date(`${day}T12:00:00Z`);
 if(!Number.isFinite(d.valueOf())||d.toISOString().slice(0,10)!==day)throw new AppError(`${label}: data inválida.`);
 const y=d.getUTCFullYear();if(y<2000||y>2100)throw new AppError(`${label}: ano ${y} fora da faixa aceita (2000 a 2100).`);
 return day;
}

/** Período por dia a partir do que veio da tela: [00h do primeiro dia, 00h do dia seguinte ao último]. */
export function dayRange(startValue:unknown,endValue:unknown,labels:[string,string]):[string|null,string|null]{
 const a=parseDay(startValue,labels[0],'start'),b=parseDay(endValue,labels[1],'end');
 if(a&&b&&b<a)throw new AppError(`${labels[1]}: o último dia não pode ser antes do primeiro.`);
 return [a?dayStart(a):null,b?dayAfter(b):null];
}

/** "10/01/2031" ou "10/01/2031 a 12/01/2031". */
export function dayPeriod(start:string,end:string){
 const a=dayOf(start),b=lastDay(end);
 return a===b?dayText(a):`${dayText(a)} a ${dayText(b)}`;
}

/** Horas de uso de equipamento por dia: maior que zero, até 12, no máximo duas casas. */
export function dayHours(value:unknown,label:string){
 if(value==null||value==='')return EQUIPMENT_DAY_HOURS;
 const h=Number(value);
 if(!Number.isFinite(h)||h<=0||h>EQUIPMENT_DAY_HOURS||Math.round(h*100)!==h*100)throw new AppError(`${label}: informe as horas de uso por dia (mais de 0 até ${EQUIPMENT_DAY_HOURS}).`);
 return h;
}

const H_MS=3_600_000;
/** A operação começa às 08h e para às 20h (não há turno noturno). */
export const OPERATION_START_H=8,OPERATION_END_H=20;
/** Horas previstas de uma reserva como trechos de tempo: por dia, das 08h até 08h + horas/dia. Reserva com
 *  hora (atividade realizada ou registro antigo) vale como está. Para o previsto do Financeiro (diárias). */
export function reservationWindows(start:string,end:string,hoursPerDay:number):[number,number][]{
 if(!isWholeDays(start,end))return [[Date.parse(start),Date.parse(end)]];
 return daysOf(start,end).map(d=>{const s=Date.parse(dayStart(d))+OPERATION_START_H*H_MS;return [s,s+Math.min(hoursPerDay,24)*H_MS] as [number,number];});
}
/** Janela de operação dos dias reservados (08h às 20h de cada dia), para conferir uso fora do reservado. */
export function operationWindows(start:string,end:string):[number,number][]{
 if(!isWholeDays(start,end))return [[Date.parse(start),Date.parse(end)]];
 return daysOf(start,end).map(d=>{const z=Date.parse(dayStart(d));return [z+OPERATION_START_H*H_MS,z+OPERATION_END_H*H_MS] as [number,number];});
}
/** Horas planejadas de uma reserva: horas/dia × dias (ou a duração, quando tem hora). */
export const reservedHours=(start:string,end:string,hoursPerDay:number)=>reservationWindows(start,end,hoursPerDay).reduce((s,[a,b])=>s+(b-a)/H_MS,0);
