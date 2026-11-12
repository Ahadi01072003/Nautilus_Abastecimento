// Planejamento P1: barras de HH (OCP e Equinor), equipes ADM e turnos 2x2, ausências e capacidade em HH
// por dia e por função. A capacidade é só leitura: vem do cadastro dos colaboradores (barra, equipe,
// função atuante, entra no HH), da configuração da barra (jornada ADM por dia da semana, turno, âncora
// da escala) e das ausências. Feriados ficam fora (decisão do usuário).
import {db,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {dayRange,dayOf,dayText} from './days';

export const BARS=['equinor','ocp'] as const;
export type BarId=typeof BARS[number];
export const TEAMS:Record<string,string>={adm:'ADM',turno_a:'Turno A',turno_b:'Turno B'};
export const ABSENCES:Record<string,string>={ferias:'Férias',afastamento:'Afastamento',folga:'Folga',falta:'Falta'};
const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const YMD=/^\d{4}-\d{2}-\d{2}$/;
const DAY=86_400_000;
const ymdMs=(d:string)=>Date.parse(d+'T12:00:00Z');
const plusDays=(d:string,n:number)=>new Date(ymdMs(d)+n*DAY).toISOString().slice(0,10);
/** Dia da semana (0 = domingo) de um dia AAAA-MM-DD. */
export const weekday=(d:string)=>new Date(ymdMs(d)).getUTCDay();

/** Escala 2x2: a partir da âncora (primeiro dia do Turno A), A trabalha nos dias 0 e 1 do ciclo de 4 e B nos dias 2 e 3. */
export function shiftWorking(bar:{shift_anchor:string},team:string,day:string){
 const k=((Math.round((ymdMs(day)-ymdMs(String(bar.shift_anchor).slice(0,10)))/DAY)%4)+4)%4;
 return team==='turno_a'?k<2:team==='turno_b'?k>=2:false;
}
/** Horas de um colaborador no dia (0 quando a equipe não trabalha). */
export function teamHours(bar:Row,team:string|null,day:string){
 if(team==='adm')return Number((bar.adm_hours as (string|number)[])[weekday(day)]);
 if(team==='turno_a'||team==='turno_b')return shiftWorking(bar as {shift_anchor:string},team,day)?Number(bar.shift_hours):0;
 return 0;
}
const barRow=(b:Row)=>({id:b.id,name:b.name,color:b.color,admHours:(b.adm_hours as unknown[]).map(Number),shiftHours:Number(b.shift_hours),shiftAnchor:String(b.shift_anchor).slice(0,10),
 zones:[Number(b.zone_target),Number(b.zone_full),Number(b.zone_ceiling)],updatedAt:b.updated_at||null,updatedByName:b.updated_by_name||null});
const loadBars=async()=>db().all("SELECT id,name,color,adm_hours,shift_hours,to_char(shift_anchor,'YYYY-MM-DD') shift_anchor,zone_target,zone_full,zone_ceiling,updated_at,updated_by_name FROM plan_bars ORDER BY id");

function barOf(value:unknown):BarId{const b=String(value||'');if(!(BARS as readonly string[]).includes(b))throw new AppError('Escolha a barra: OCP ou Equinor.');return b as BarId;}
function period(url:URL,max=62){
 const from=url.searchParams.get('from')||dayOf(Date.now()),to=url.searchParams.get('to')||from;
 if(!YMD.test(from)||!YMD.test(to))throw new AppError('Informe o período em dias.');
 dayRange(from,to,['Primeiro dia','Último dia']);
 const n=Math.round((ymdMs(to)-ymdMs(from))/DAY)+1;if(n>max)throw new AppError(`Período de até ${max} dias.`);
 return Array.from({length:n},(_,i)=>plusDays(from,i));
}

/** Capacidade da barra por dia: pessoas presentes no HH, horas por função atuante e ausências. */
export async function capacity(barId:BarId,days:string[]){
 const bar=(await loadBars()).find(b=>b.id===barId)!;
 const [people,absences]=await Promise.all([
  db().all(`SELECT o.id,o.name,o.team,o.counts_hh,o.acting_function_id,coalesce(f.name,'Sem função') function_name
   FROM operators o LEFT JOIN job_functions f ON f.id=coalesce(o.acting_function_id,(SELECT x.function_id FROM operator_functions x WHERE x.operator_id=o.id ORDER BY x.function_id LIMIT 1))
   WHERE o.active=1 AND o.bar=? AND o.team IS NOT NULL ORDER BY o.name`,barId),
  db().all(`SELECT a.id,a.operator_id,a.kind,to_char(a.start_day,'YYYY-MM-DD') start_day,to_char(a.end_day,'YYYY-MM-DD') end_day,a.note,o.name FROM operator_absences a JOIN operators o ON o.id=a.operator_id
   WHERE a.cancelled_at IS NULL AND o.bar=? AND a.end_day>=?::date AND a.start_day<=?::date`,barId,days[0],days[days.length-1]),
 ]);
 return {bar:barRow(bar),days:days.map(day=>{
  const away=absences.filter(a=>a.start_day<=day&&a.end_day>=day);
  const present:Row[]=[],absent:Row[]=[];
  for(const p of people){
   const h=teamHours(bar,p.team,day);if(!h)continue;
   const off=away.find(a=>a.operator_id===p.id);
   if(off){absent.push({id:p.id,name:p.name,team:p.team,kind:off.kind,absenceId:off.id,countsHh:Number(p.counts_hh)===1});continue;}
   if(Number(p.counts_hh)!==1)continue;
   present.push({id:p.id,name:p.name,team:p.team,hours:h,functionId:p.acting_function_id||null,functionName:p.function_name});
  }
  const fns=new Map<string,Row>();
  for(const p of present){const k=p.functionName as string;const f=fns.get(k)||{functionId:p.functionId,name:k,hours:0,people:0};f.hours+=p.hours;f.people++;fns.set(k,f);}
  const total=present.reduce((s,p)=>s+Number(p.hours),0);
  const shift=shiftWorking(bar as {shift_anchor:string},'turno_a',day)?'turno_a':'turno_b';
  return {day,weekday:weekday(day),total,shift,people:present,absent,byFunction:[...fns.values()].sort((x,y)=>y.hours-x.hours||x.name.localeCompare(y.name,'pt-BR'))};
 })};
}

export async function capacityGet(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='planning/capacity'){
  await requireAny(member,['planejamento','operacao','acompanhamento']);
  return capacity(barOf(url.searchParams.get('bar')||'equinor'),period(url));
 }
 if(path==='planning/bars'){
  await requireAny(member,['planejamento','operacao','acompanhamento','cadastros']);
  const [bars,people]=await Promise.all([loadBars(),db().all(`SELECT o.id,o.name,o.bar,o.team,o.counts_hh,o.active,f.name function_name FROM operators o LEFT JOIN job_functions f ON f.id=o.acting_function_id ORDER BY o.name`)]);
  return {bars:bars.map(barRow),people:people.map(p=>({id:p.id,name:p.name,bar:p.bar||null,team:p.team||null,countsHh:Number(p.counts_hh)===1,active:Number(p.active)===1,functionName:p.function_name||null}))};
 }
 if(path==='planning/absences'){
  await requireAny(member,['planejamento','cadastros']);
  const operator=url.searchParams.get('operator');
  const rows=await db().all(`SELECT a.*,to_char(a.start_day,'YYYY-MM-DD') start_ymd,to_char(a.end_day,'YYYY-MM-DD') end_ymd,o.name FROM operator_absences a JOIN operators o ON o.id=a.operator_id
   WHERE a.cancelled_at IS NULL${operator?' AND a.operator_id=?':''} AND a.end_day >= current_date - 60 ORDER BY a.start_day DESC LIMIT 200`,...(operator?[operator]:[]));
  return {rows:rows.map(a=>({id:a.id,operatorId:a.operator_id,name:a.name,kind:a.kind,startDay:a.start_ymd,endDay:a.end_ymd,note:a.note||null,createdByName:a.created_by_name,createdAt:a.created_at}))};
 }
 return null;
}

/** Configuração da barra (só a Gestão): jornada ADM por dia da semana, turno, âncora da escala e zonas. */
async function saveBar(a:Member,b:Row){
 if(!isManager(a))throw new AppError('Somente a Gestão configura as barras.',403);
 const bid=barOf(b.id);
 const adm=Array.isArray(b.admHours)?b.admHours.map(Number):[];
 if(adm.length!==7||adm.some(h=>!Number.isFinite(h)||h<0||h>24))throw new AppError('Horas do ADM: informe de 0 a 24 para cada dia da semana.');
 const shift=Number(b.shiftHours);if(!Number.isFinite(shift)||shift<=0||shift>24)throw new AppError('Horas do turno: de mais de 0 até 24.');
 const anchor=String(b.shiftAnchor||'');if(!YMD.test(anchor))throw new AppError('Informe o primeiro dia do Turno A (âncora da escala 2x2).');
 dayRange(anchor,anchor,['Âncora','Âncora']);
 const [zt,zf,zc]=[b.zoneTarget,b.zoneFull,b.zoneCeiling].map(Number);
 if(![zt,zf,zc].every(Number.isInteger)||!(zt>0&&zt<=zf&&zf<=zc&&zc<=200))throw new AppError('Zonas: meta ≤ 100% ≤ teto (até 200%), em números inteiros.');
 await db().tx(async tx=>{
  const before=await tx.first('SELECT * FROM plan_bars WHERE id=? FOR UPDATE',bid);
  await tx.run('UPDATE plan_bars SET adm_hours=?::numeric[],shift_hours=?,shift_anchor=?::date,zone_target=?,zone_full=?,zone_ceiling=?,updated_at=?,updated_by_name=? WHERE id=?',adm,shift,anchor,zt,zf,zc,now(),a.name,bid);
  await audit(tx,a,'Planejamento: barra configurada',bid,{before,after:{admHours:adm,shiftHours:shift,shiftAnchor:anchor,zones:[zt,zf,zc]}});
 });
 return {ok:true,message:`Barra ${bid==='ocp'?'OCP':'Equinor'} atualizada.`};
}

/** Ausência (Gestão): férias, afastamento, folga ou falta, com período. Reduz a capacidade dos dias. */
export async function saveAbsence(a:Member,b:Row){
 if(!isManager(a))throw new AppError('Somente a Gestão lança férias e afastamentos.',403);
 const o=await db().first('SELECT id,name FROM operators WHERE id=?',required(b.operatorId,'Colaborador',100));
 if(!o)throw new AppError('Colaborador não encontrado.',404);
 if(!ABSENCES[b.kind])throw new AppError('Escolha o tipo: férias, afastamento, folga ou falta.');
 const s=String(b.startDay||''),e=String(b.endDay||b.startDay||'');
 if(!YMD.test(s)||!YMD.test(e))throw new AppError('Informe o primeiro e o último dia.');
 dayRange(s,e,['Primeiro dia','Último dia']);
 if(Math.round((ymdMs(e)-ymdMs(s))/DAY)>366)throw new AppError('Ausência de até um ano.');
 const note=text(b.note,300)||null,aid=id();
 await db().tx(async tx=>{
  await tx.run('INSERT INTO operator_absences(id,operator_id,kind,start_day,end_day,note,created_at,created_by,created_by_name) VALUES(?,?,?,?::date,?::date,?,?,?,?)',aid,o.id,b.kind,s,e,note,now(),a.id,a.name);
  await audit(tx,a,'Cadastros gerais: ausência registrada',o.id,{absence:aid,kind:b.kind,startDay:s,endDay:e,note});
 });
 return {id:aid,message:`${ABSENCES[b.kind]} de ${o.name} registrada${s===e?` em ${dayText(s)}`:` de ${dayText(s)} a ${dayText(e)}`}.`};
}
export async function cancelAbsence(a:Member,b:Row){
 if(!isManager(a))throw new AppError('Somente a Gestão cancela ausências.',403);
 const r=await db().first('SELECT * FROM operator_absences WHERE id=?',required(b.id,'Ausência',100));
 if(!r)throw new AppError('Ausência não encontrada.',404);
 if(r.cancelled_at)return {ok:true,message:'Ausência já cancelada.'};
 await db().tx(async tx=>{
  await tx.run('UPDATE operator_absences SET cancelled_at=?,cancelled_by_name=? WHERE id=? AND cancelled_at IS NULL',now(),a.name,r.id);
  await audit(tx,a,'Cadastros gerais: ausência cancelada',r.operator_id,{absence:r.id});
 });
 return {ok:true,message:'Ausência cancelada.'};
}

export async function capacityMutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(path==='planning/bars/save'){await requireAny(member,['planejamento']);return saveBar(member,b);}
 return null;
}
