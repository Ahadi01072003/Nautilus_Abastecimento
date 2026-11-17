// Programação do dia: barras OCP e Equinor e o HH disponível de cada dia. HH = soma das janelas do dia, cada uma com
// quem está presente: colaboradores com barra e escala (ADM, Turno A, Turno B) e as jornadas da barra (início, fim e
// almoço por escala e tipo de dia; turno 2x2 a partir da âncora). O almoço (12–13) é descontado na janela que o
// contém. O planejador pode trocar o HH de um dia; a Gestão altera as jornadas.
import {db,type Row} from './db';
import {AppError} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';

export const BARS=['equinor','ocp'] as const;
export type BarId=typeof BARS[number];
export const SCHEDULES=['adm','turno_a','turno_b'] as const;
export const SCHEDULE_NAMES:Record<string,string>={adm:'ADM',turno_a:'Turno A',turno_b:'Turno B'};
const now=()=>new Date().toISOString();
const DAY=86_400_000;
const ymdMs=(d:string)=>Date.parse(d+'T12:00:00Z');
export const plusDays=(d:string,n:number)=>new Date(ymdMs(d)+n*DAY).toISOString().slice(0,10);
/** Dia da semana (0 = domingo) de um dia AAAA-MM-DD. */
export const weekday=(d:string)=>new Date(ymdMs(d)).getUTCDay();
export const barName=(b:string)=>b==='ocp'?'OCP':'Equinor';
export const roundHh=(n:number)=>Math.round(n*100)/100;
export const hText=(n:number)=>String(roundHh(n)).replace('.',',');
export function barOf(value:unknown):BarId{const b=String(value||'');if(!(BARS as readonly string[]).includes(b))throw new AppError('Escolha a barra: OCP ou Equinor.');return b as BarId;}

// ───────────── Jornadas ─────────────
type Span={start:string,end:string,lunch:boolean};
type DayKind='weekday'|'saturday'|'sunday';
type GroupSchedule={weekday:Span|null,saturday:Span|null,sunday:Span|null};
export type BarSchedule={anchor:string,adm:GroupSchedule|null,turno:GroupSchedule|null};
const LUNCH:[number,number]=[12*60,13*60];
const HHMM=/^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const mins=(t:string)=>{const [h,m]=t.split(':').map(Number);return h*60+m;};
const clock=(m:number)=>{const h=Math.floor(m/60),r=m%60;return `${String(h).padStart(2,'0')}${r?':'+String(r).padStart(2,'0'):''}`;};
const kindOf=(day:string):DayKind=>{const w=weekday(day);return w===0?'sunday':w===6?'saturday':'weekday';};

/** Valida e normaliza as jornadas da barra (Gestão). */
export function scheduleOf(v:unknown):BarSchedule{
 const bad=(msg:string)=>new AppError(`Jornadas: ${msg}`);
 if(!v||typeof v!=='object')throw bad('informe as jornadas da barra.');
 const o=v as Row;
 const anchor=String(o.anchor||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(anchor))throw bad('informe o primeiro dia do Turno A.');
 const span=(x:unknown,label:string):Span|null=>{
  if(x==null)return null;const s=x as Row;
  if(!HHMM.test(String(s.start))||!HHMM.test(String(s.end))||mins(s.start)>=mins(s.end))throw bad(`horário inválido em ${label} (início antes do fim, HH:MM).`);
  return {start:String(s.start),end:String(s.end),lunch:!!s.lunch};
 };
 const group=(x:unknown,label:string):GroupSchedule|null=>{if(x==null)return null;const g=x as Row;
  return {weekday:span(g.weekday,`${label} (segunda a sexta)`),saturday:span(g.saturday,`${label} (sábado)`),sunday:span(g.sunday,`${label} (domingo)`)};};
 return {anchor,adm:group(o.adm,'ADM'),turno:group(o.turno,'Turno')};
}

export const barRow=(b:Row)=>({id:b.id as BarId,name:b.name as string,color:b.color as string,schedule:b.schedule as BarSchedule,
 updatedAt:b.updated_at||null,updatedByName:b.updated_by_name||null});
export const loadBars=async()=>db().all('SELECT id,name,color,schedule,updated_at,updated_by_name FROM plan_bars ORDER BY id');

/** Turno 2x2 do dia: o Turno A trabalha a âncora e o dia seguinte; o B, os dois seguintes. */
export function turnoOfDay(anchor:string,day:string):'turno_a'|'turno_b'{
 const k=((Math.round((ymdMs(day)-ymdMs(anchor))/DAY)%4)+4)%4;return k<2?'turno_a':'turno_b';
}

type Group={key:'adm'|'turno',people:number,span:Span};
/** Janelas do dia: cada trecho entre horários de início e fim, com quem está presente e o HH (almoço descontado). */
export function dayWindows(groups:Group[]){
 const live=groups.filter(g=>g.people>0);
 const cuts=[...new Set(live.flatMap(g=>[mins(g.span.start),mins(g.span.end)]))].sort((x,y)=>x-y);
 const out:{label:string,hh:number,groups:string[]}[]=[];
 for(let i=0;i+1<cuts.length;i++){
  const [a,b]=[cuts[i],cuts[i+1]];
  const here=live.filter(g=>mins(g.span.start)<=a&&mins(g.span.end)>=b);
  if(!here.length)continue;
  const lunch=Math.max(0,Math.min(b,LUNCH[1])-Math.max(a,LUNCH[0]));
  const hh=here.reduce((t,g)=>t+g.people*((b-a)-(g.span.lunch?lunch:0))/60,0);
  out.push({label:`${clock(a)}–${clock(b)}`,hh:roundHh(hh),groups:here.map(g=>g.key==='adm'?'ADM':'Turno')});
 }
 return out;
}

/** HH disponível de cada dia da barra: janelas calculadas e o ajuste do dia, se houver. */
export async function staffFor(bar:BarId,days:string[]){
 const b=barRow((await loadBars()).find(x=>x.id===bar)!);
 const [people,rows]=await Promise.all([
  db().all("SELECT schedule,count(*)::int n FROM operators WHERE active=1 AND bar=? AND schedule IS NOT NULL GROUP BY schedule",bar),
  days.length?db().all(`SELECT to_char(day,'YYYY-MM-DD') AS day,hh,note,updated_by_name,updated_at FROM plan_day_staff WHERE bar=? AND day=ANY(?::date[])`,bar,days):Promise.resolve([] as Row[]),
 ]);
 const count=(s:string)=>Number(people.find(p=>p.schedule===s)?.n||0);
 return days.map(day=>{
  const kind=kindOf(day),turno=b.schedule.turno?turnoOfDay(b.schedule.anchor,day):null;
  const groups:Group[]=[];
  const adm=b.schedule.adm?.[kind],shift=b.schedule.turno?.[kind];
  if(adm)groups.push({key:'adm',people:count('adm'),span:adm});
  if(shift&&turno)groups.push({key:'turno',people:count(turno),span:shift});
  const windows=dayWindows(groups),computedHh=roundHh(windows.reduce((t,w)=>t+w.hh,0));
  const maxShiftHours=groups.reduce((m,g)=>Math.max(m,(mins(g.span.end)-mins(g.span.start)-(g.span.lunch&&mins(g.span.start)<=LUNCH[0]&&mins(g.span.end)>=LUNCH[1]?60:0))/60),0);
  const r=rows.find(x=>x.day===day);
  return {day,windows,computedHh,hh:r?Number(r.hh):computedHh,source:(r?'dia':'padrao') as 'dia'|'padrao',note:(r?.note as string)||null,
   byName:(r?.updated_by_name as string)||null,at:(r?.updated_at as string)||null,
   people:{adm:adm?count('adm'):0,turno:shift&&turno?count(turno):0},turnoOfDay:turno,maxShiftHours,open:groups.length>0};
 });
}

export async function capacityGet(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/bars'){
  await requireAny(member,['planejamento','operacao','acompanhamento','cadastros']);
  return {bars:(await loadBars()).map(barRow)};
 }
 return null;
}

/** Jornadas da barra (só a Gestão). */
async function saveBar(a:Member,b:Row){
 if(!isManager(a))throw new AppError('Somente a Gestão altera as jornadas das barras.',403);
 const bid=barOf(b.id),schedule=scheduleOf(b.schedule);
 await db().tx(async tx=>{
  const before=await tx.first('SELECT schedule FROM plan_bars WHERE id=? FOR UPDATE',bid);
  await tx.run('UPDATE plan_bars SET schedule=?::text::jsonb,updated_at=?,updated_by_name=? WHERE id=?',JSON.stringify(schedule),now(),a.name,bid);
  await audit(tx,a,'Planejamento: jornadas da barra',bid,{before:before?.schedule,after:schedule});
 });
 return {ok:true,message:`Jornadas da barra ${barName(bid)} salvas.`};
}

export async function capacityMutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/bars/save'){await requireAny(member,['planejamento']);return saveBar(member,b);}
 return null;
}
