// Painel central › Apresentação (TV): todas as OS do período (com as em andamento, mesmo que
// tenham começado antes) e as alocações de cada uma (equipamentos, colaboradores e materiais), no
// nível de alocação: um equipamento ou colaborador em várias OS aparece em cada alocação. A
// organização (filtros, grupos e ordem) é feita na tela com a regra única de lib/os-order.
// Tudo respeita o acesso e o escopo de organizações de quem consulta.
import {db,type Row} from './db';
import {AppError} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {filterSectors} from './board';

type Actor=Member&{org_scope:string[]};
const scopeOf=(a:Actor)=>isManager(a)||!a.org_scope.length?null:a.org_scope;

const DAY=86400_000,H=3600_000;
export const TV_DAYS=[1,3,7,14];
const dayISO=(t:number)=>new Date(t-3*H).toISOString().slice(0,10);
const ORDER_LIMIT=400;

export async function tvData(member:Member,url:URL){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']) as Actor;
 const days=Number(url.searchParams.get('dias')||7);
 if(!TV_DAYS.includes(days))throw new AppError('Período inválido.');
 const today=Date.parse(dayISO(Date.now())+'T00:00:00-03:00');
 // Janela: de ontem até o fim do período; OS em andamento entram mesmo que tenham começado antes
 // (no máximo 30 dias atrás) ou que o término planejado já tenha passado.
 const from=today-DAY,to=today+days*DAY,oldest=today-30*DAY;
 const scope=scopeOf(a);
 const values:unknown[]=[new Date(to).toISOString(),new Date(from).toISOString(),new Date(oldest).toISOString()];
 let where=`((w.planned_start::timestamptz < ?::timestamptz AND greatest(w.planned_end::timestamptz,coalesce(w.actual_end,w.planned_end)::timestamptz) > ?::timestamptz)
   OR (w.status IN ('em_andamento','encerramento_pendente') AND coalesce(w.actual_start,w.planned_start)::timestamptz > ?::timestamptz))`;
 if(scope){where+=' AND w.org_id = ANY(?::text[])';values.push(scope);}
 const orders=await db().all(`SELECT w.id,w.number,w.status,w.origin,w.planned_start,w.planned_end,w.actual_start,w.actual_end,w.current_plan_id,w.org_id,
  nullif(w.code,'') sector_code,s.name sector_name,coalesce(nullif(w.title,''),t.name) activity_name,o.acronym org_acronym,o.name org_name,o.color org_color,
  l.name location_name,rp.name requester_name
  FROM work_orders w JOIN plans p ON p.id=w.current_plan_id JOIN activity_types t ON t.id=w.activity_type_id JOIN requester_orgs o ON o.id=w.org_id
  LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN requester_people rp ON rp.id=p.requester_person_id LEFT JOIN sectors s ON s.code=w.code
  WHERE ${where} ORDER BY w.planned_start::timestamptz,w.number LIMIT ${ORDER_LIMIT+1}`,...values);
 const truncated=orders.length>ORDER_LIMIT;if(truncated)orders.length=ORDER_LIMIT;
 const plans=orders.map(o=>o.current_plan_id);
 const [equipment,people,materials,orgs,sectors]=await Promise.all([
  plans.length?db().all(`SELECT r.plan_id,e.id,e.tag,e.description,et.name type_name,r.start_at,r.end_at,st.name step_name
   FROM reservations r JOIN equipment e ON e.id=r.equipment_id LEFT JOIN equipment_types et ON et.id=e.type_id LEFT JOIN plan_steps st ON st.id=r.plan_step_id
   WHERE r.plan_id = ANY(?::text[]) AND r.status<>'liberada' ORDER BY e.tag,r.start_at::timestamptz`,plans):[],
  plans.length?db().all(`SELECT x.plan_id,op.id,op.name,st.name step_name,st.planned_start,st.planned_end,
   coalesce((SELECT string_agg(f.name,', ' ORDER BY f.name) FROM operator_functions of2 JOIN job_functions f ON f.id=of2.function_id WHERE of2.operator_id=op.id),'') functions
   FROM plan_step_people x JOIN operators op ON op.id=x.operator_id JOIN plan_steps st ON st.id=x.plan_step_id AND st.included=1
   WHERE x.plan_id = ANY(?::text[]) ORDER BY op.name,st.planned_start`,plans):[],
  plans.length?db().all(`SELECT n.plan_id,m.id,m.name,n.unit,sum(n.amount)::float8 amount FROM plan_step_needs n JOIN materials m ON m.id=n.material_id JOIN plan_steps st ON st.id=n.plan_step_id AND st.included=1
   WHERE n.plan_id = ANY(?::text[]) GROUP BY n.plan_id,m.id,m.name,n.unit ORDER BY m.name`,plans):[],
  db().all('SELECT id,acronym,name,color FROM requester_orgs WHERE active=1 OR id = ANY(?::text[]) ORDER BY acronym',[...new Set(orders.map(o=>o.org_id))]),
  filterSectors(),
 ]);
 const list:Row[]=orders.map(o=>({...o,
  equipment:equipment.filter(e=>e.plan_id===o.current_plan_id).map(e=>({id:e.id,tag:e.tag,description:e.description,type:e.type_name,start:e.start_at,end:e.end_at,step:e.step_name})),
  people:people.filter(p=>p.plan_id===o.current_plan_id).map(p=>({id:p.id,name:p.name,functions:p.functions,step:p.step_name,start:p.planned_start,end:p.planned_end})),
  materials:materials.filter(m=>m.plan_id===o.current_plan_id).map(m=>({id:m.id,name:m.name,unit:m.unit,amount:Number(m.amount)})),
 }));
 return {
  window:{from:new Date(from).toISOString(),to:new Date(to).toISOString(),days,today:new Date(today).toISOString()},
  orders:list,truncated,orgs:orgs.filter(o=>!scope||scope.includes(o.id)),sectors,
  serverNow:new Date().toISOString(),
 };
}
