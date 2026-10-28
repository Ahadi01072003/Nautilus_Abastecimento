// Operação › Painel de OS › Exportar agenda: OS do período (datas de Brasília), opcionalmente de
// um código de setor, com o resumo para o gestor (quantidades, solicitantes, horas, recursos e
// alertas) e cada OS com equipamentos, pessoas e materiais. A página /agenda imprime em PDF.
import {db,type Row} from './db';
import {AppError,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {preventiveRows} from './maintenance';
import {ordersResources} from './planning';
import {NO_SECTOR} from './os-order';
import {resourceFromParams,type Alloc} from './resource-agenda';

type Actor=Member&{org_scope:string[]};
const DAY=86400_000,H=3600_000;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
export const AGENDA_MAX_DAYS=92;
const scopeOf=(a:Actor)=>isManager(a)||!a.org_scope.length?null:a.org_scope;
/** Data civil válida (AAAA-MM-DD) em Brasília → início do dia em ms. */
function day(value:unknown,label:string){
 const v=text(value,10);
 const t=DATE.test(v)?Date.parse(v+'T00:00:00-03:00'):NaN;
 if(!Number.isFinite(t)||new Date(t+3*H).toISOString().slice(0,10)!==v)throw new AppError(`${label}: informe uma data válida.`);
 return t;
}

export async function agendaData(member:Member,params:{from:unknown,to:unknown,sector?:unknown}){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']) as Actor;
 const t0=day(params.from,'Data de início'),t1=day(params.to,'Data de fim')+DAY;
 if(t1<=t0)throw new AppError('A data de fim deve ser igual ou posterior à de início.');
 if((t1-t0)/DAY>AGENDA_MAX_DAYS)throw new AppError(`Escolha um período de até ${AGENDA_MAX_DAYS} dias.`);
 const code=text(params.sector,40).toUpperCase();
 const sector=code?await db().first('SELECT code,name FROM sectors WHERE code=?',code):null;
 if(code&&!sector)throw new AppError('Código de setor não cadastrado.',404);
 const scope=scopeOf(a);
 const where=["w.status<>'cancelada'",'w.planned_start::timestamptz < ?::timestamptz','w.planned_end::timestamptz > ?::timestamptz'],values:unknown[]=[new Date(t1).toISOString(),new Date(t0).toISOString()];
 if(code){where.push('w.code=?');values.push(code);}
 if(scope){where.push('w.org_id = ANY(?::text[])');values.push(scope);}
 const orders=await db().all(`SELECT w.id,w.number,w.status,w.origin,w.planned_start,w.planned_end,w.actual_start,w.actual_end,w.current_plan_id,w.org_id,
  coalesce(nullif(w.code,''),CASE WHEN t.system=1 THEN '' ELSE t.code END) activity_code,w.code sector_code,s.name sector_name,coalesce(nullif(w.title,''),t.name) activity_name,
  p.description,o.acronym org_acronym,o.name org_name,o.color org_color,l.name location_name,rp.name requester_name
  FROM work_orders w JOIN plans p ON p.id=w.current_plan_id JOIN activity_types t ON t.id=w.activity_type_id JOIN requester_orgs o ON o.id=w.org_id
  LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN requester_people rp ON rp.id=p.requester_person_id LEFT JOIN sectors s ON s.code=w.code
  WHERE ${where.join(' AND ')} ORDER BY w.planned_start::timestamptz,w.number LIMIT 600`,...values);
 const plans=orders.map(o=>o.current_plan_id);
 const [equipment,people,materials,functions,impediments]=plans.length?await Promise.all([
  // Cada reserva com o horário, a etapa e o local da etapa: diz onde e quando o equipamento é usado.
  db().all(`SELECT r.plan_id,e.id,e.tag,e.description,et.name type_name,r.start_at,r.end_at,s.name step_name,l.name step_location
   FROM reservations r JOIN equipment e ON e.id=r.equipment_id LEFT JOIN equipment_types et ON et.id=e.type_id
   LEFT JOIN plan_steps s ON s.id=r.plan_step_id LEFT JOIN locations l ON l.id=s.location_id
   WHERE r.plan_id = ANY(?::text[]) AND r.status<>'liberada' ORDER BY e.tag,r.start_at::timestamptz`,plans),
  db().all('SELECT DISTINCT x.plan_id,op.id,op.name FROM plan_step_people x JOIN operators op ON op.id=x.operator_id JOIN plan_steps s ON s.id=x.plan_step_id AND s.included=1 WHERE x.plan_id = ANY(?::text[]) ORDER BY op.name',plans),
  db().all(`SELECT n.plan_id,m.name,n.unit,sum(n.amount)::float8 amount FROM plan_step_needs n JOIN materials m ON m.id=n.material_id JOIN plan_steps s ON s.id=n.plan_step_id AND s.included=1
   WHERE n.plan_id = ANY(?::text[]) GROUP BY n.plan_id,m.name,n.unit ORDER BY m.name`,plans),
  db().all(`SELECT n.plan_id,f.name,sum(n.quantity)::int quantity FROM plan_step_needs n JOIN job_functions f ON f.id=n.function_id JOIN plan_steps s ON s.id=n.plan_step_id AND s.included=1
   WHERE n.plan_id = ANY(?::text[]) GROUP BY n.plan_id,f.name`,plans),
  db().all('SELECT i.equipment_id,i.kind,i.reason,e.tag FROM equipment_impediments i JOIN equipment e ON e.id=i.equipment_id WHERE i.released_at IS NULL'),
 ]):[[],[],[],[],[]];
 // Horas de reserva recortadas ao período, sem contar em dobro reservas sobrepostas do mesmo equipamento.
 const union=(spans:number[][])=>{let total=0,cur:number[]|null=null;for(const x of spans.filter(x=>x[1]>x[0]).sort((a,b)=>a[0]-b[0])){if(!cur||x[0]>cur[1]){if(cur)total+=cur[1]-cur[0];cur=[...x];}else cur[1]=Math.max(cur[1],x[1]);}return cur?total+cur[1]-cur[0]:total;};
 const inPeriod=(a:number,b:number)=>[Math.max(a,t0),Math.min(b,t1)];
 const usesOf=(o:Row)=>{const mine=equipment.filter(e=>e.plan_id===o.current_plan_id);const by=new Map<string,Row>();
  for(const e of mine){const g=by.get(e.id)||{id:e.id,tag:e.tag,type:e.type_name,description:e.description,spans:[] as number[][],steps:new Set<string>(),places:new Set<string>()};
   g.spans.push([Date.parse(e.start_at),Date.parse(e.end_at)]);if(e.step_name)g.steps.add(e.step_name);g.places.add(e.step_location||o.location_name||'');by.set(e.id,g);}
  return [...by.values()].map(g=>({id:g.id,tag:g.tag,type:g.type,description:g.description,start:new Date(Math.min(...g.spans.map((x:number[])=>x[0]))).toISOString(),end:new Date(Math.max(...g.spans.map((x:number[])=>x[1]))).toISOString(),
   hours:union(g.spans.map((x:number[])=>inPeriod(x[0],x[1])))/H,steps:[...g.steps],location:[...g.places].filter(Boolean).join(' · ')||null}));};
 const list:Row[]=orders.map((o):Row=>({...o,
  equipment:usesOf(o),
  people:people.filter(x=>x.plan_id===o.current_plan_id).map(x=>x.name as string),
  materials:materials.filter(x=>x.plan_id===o.current_plan_id).map(x=>({name:x.name,unit:x.unit,amount:x.amount})),
  functions:functions.filter(x=>x.plan_id===o.current_plan_id).map(x=>({name:x.name,quantity:x.quantity})),
 }));

 // Resumo: horas planejadas recortadas ao período; cada recurso uma vez, com as OS em que aparece.
 const clip=(o:Row)=>Math.max(0,Math.min(Date.parse(o.planned_end),t1)-Math.max(Date.parse(o.planned_start),t0));
 const byStatus:Record<string,number>={};for(const o of list)byStatus[o.status]=(byStatus[o.status]||0)+1;
 const orgs=new Map<string,Row>();for(const o of list){const g=orgs.get(o.org_id)||{acronym:o.org_acronym,name:o.org_name,color:o.org_color,count:0,hours:0};g.count++;g.hours+=clip(o)/H;orgs.set(o.org_id,g);}
 // Por equipamento: cada OS em que está reservado, com local, horário da reserva e horas.
 const eq=new Map<string,Row>();for(const o of list)for(const e of o.equipment){const g=eq.get(e.id)||{tag:e.tag,type:e.type,description:e.description,count:0,hours:0,uses:[]};g.count++;g.hours+=e.hours;
  g.uses.push({number:o.number,activity:o.activity_name,location:e.location,start:e.start,end:e.end,hours:e.hours});eq.set(e.id,g);}
 for(const g of eq.values())g.uses.sort((x:Row,y:Row)=>Date.parse(x.start)-Date.parse(y.start));
 // Por material: total e a quantidade de cada OS.
 const mats=new Map<string,Row>();for(const o of list)for(const m of o.materials){const k=m.name+'|'+m.unit;const g=mats.get(k)||{name:m.name,unit:m.unit,amount:0,uses:[]};g.amount+=Number(m.amount)||0;g.uses.push({number:o.number,amount:Number(m.amount)||0});mats.set(k,g);}
 const crew=new Set(list.flatMap(o=>o.people));
 const days=new Map<string,number>();
 for(const o of list){for(let d=Math.max(t0,Math.floor((Date.parse(o.planned_start)-t0)/DAY)*DAY+t0);d<Math.min(t1,Date.parse(o.planned_end));d+=DAY){const k=new Date(d+3*H).toISOString().slice(0,10);days.set(k,(days.get(k)||0)+1);}}
 const busiest=[...days.entries()].sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0]))[0]||null;
 // Alertas de recurso: equipamento da agenda com impedimento aberto ou preventiva pendente/atrasada.
 const used=new Set(eq.keys());
 const alerts:Row[]=impediments.filter(i=>used.has(i.equipment_id)).map(i=>({tag:i.tag,text:`bloqueado (${i.kind==='nc_critica'?'NC crítica':i.kind==='manutencao'?'em manutenção':'impedimento técnico'}): ${i.reason}`}));
 if(used.size){for(const r of await preventiveRows())if(used.has(r.equipmentId)&&(r.status==='atrasada'||r.status==='pendente'))alerts.push({tag:r.tag,text:`preventiva ${r.status==='atrasada'?'atrasada':'pendente'} · ${r.name}`});}
 return {
  period:{from:new Date(t0).toISOString(),to:new Date(t1).toISOString(),days:Math.round((t1-t0)/DAY)},
  sector:sector||null,orders:list,truncated:orders.length>=600,
  summary:{total:list.length,byStatus,hours:list.reduce((n,o)=>n+clip(o),0)/H,realized:list.filter(o=>o.origin==='realizada').length,
   orgs:[...orgs.values()].sort((x,y)=>y.count-x.count||String(x.acronym).localeCompare(String(y.acronym))),
   equipment:[...eq.values()].sort((x,y)=>y.count-x.count||y.hours-x.hours||String(x.tag).localeCompare(String(y.tag))),
   materials:[...mats.values()].sort((x,y)=>String(x.name).localeCompare(String(y.name))),
   people:crew.size,days:days.size,busiest:busiest?{day:busiest[0],count:busiest[1]}:null,alerts},
  generatedAt:new Date().toISOString(),
 };
}

/** Agenda de recursos em PDF (/agenda/recursos): alocações das OS do período com os mesmos filtros
 * da Lista de OS (tipo, local, situação, número, código, solicitante e setor) e a seleção de tipos e
 * recursos. Só entram as alocações que tocam o período. */
export async function resourceAgendaData(member:Member,params:URLSearchParams){
 const t0=day(params.get('inicio'),'Data de início'),t1=day(params.get('fim'),'Data de fim')+DAY;
 if(t1<=t0)throw new AppError('A data de fim deve ser igual ou posterior à de início.');
 if((t1-t0)/DAY>AGENDA_MAX_DAYS)throw new AppError(`Escolha um período de até ${AGENDA_MAX_DAYS} dias.`);
 const url=new URL('http://agenda/');
 url.searchParams.set('from',new Date(t0).toISOString());url.searchParams.set('to',new Date(t1).toISOString());
 for(const k of ['type','location','status','number','code']){const v=text(params.get(k),80);if(v)url.searchParams.set(k,v);}
 const list=(k:string)=>(params.get(k)||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,200);
 const orgs=list('sol'),sectors=list('setor').map(s=>s===NO_SECTOR?s:s.toUpperCase());
 const {kinds,picked}=resourceFromParams(params);
 const r=await ordersResources(member,url);
 const allocations=(r.allocations as Alloc[]).filter(a=>(!orgs.length||orgs.includes(a.orgId))&&(!sectors.length||sectors.includes(a.sector||NO_SECTOR))
  &&Date.parse(a.end)>t0&&Date.parse(a.start)<t1);
 const sectorRows=sectors.filter(s=>s!==NO_SECTOR).length?await db().all('SELECT code,name FROM sectors WHERE code = ANY(?::text[]) ORDER BY code',sectors):[];
 const orgRows=orgs.length?await db().all('SELECT id,acronym,name FROM requester_orgs WHERE id = ANY(?::text[]) ORDER BY acronym',orgs):[];
 return {period:{from:new Date(t0).toISOString(),to:new Date(t1).toISOString(),days:Math.round((t1-t0)/DAY)},allocations,kinds,picked,
  filters:{orgs:orgRows,sectors:[...sectorRows,...(sectors.includes(NO_SECTOR)?[{code:NO_SECTOR,name:'Sem setor'}]:[])]},more:r.more,generatedAt:new Date().toISOString()};
}
