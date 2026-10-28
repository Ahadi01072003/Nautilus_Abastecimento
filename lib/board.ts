// Operação › Painel de OS e lista de Apontamentos: OS com etapas, intervalos (ativo/parado)
// e apontamentos, para desenhar a régua e o cronômetro de cada OS no navegador.
import {db,type Row} from './db';
import {AppError,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';

/** Setores dos filtros (Painel de OS, Lista de OS, Gantt, Apresentação e exportação da agenda): os
 * ativos e os inativos que ainda têm OS com o seu código. Inativo sem nenhuma OS não aparece. */
export const filterSectors=()=>db().all(`SELECT s.code,s.name,s.active FROM sectors s
 WHERE s.active=1 OR EXISTS (SELECT 1 FROM work_orders w WHERE w.code=s.code) ORDER BY s.code`);

type Actor=Member&{org_scope:string[]};
const scopeOf=(a:Actor)=>isManager(a)||!a.org_scope.length?null:a.org_scope;
const DAY=86400_000;
/** Início do dia civil de Brasília (UTC−3, sem horário de verão). */
const dayStart=(t=Date.now())=>{const d=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date(t));return new Date(d+'T00:00:00-03:00');};

const GROUPS={
 andamento:"w.status IN ('em_andamento','encerramento_pendente')",
 programadas:"w.status='programada'",
 concluidas:"w.status='concluida'",
 canceladas:"w.status='cancelada'",
 todas:'TRUE',
} as const;
type Group=keyof typeof GROUPS;

const DATE=/^\d{4}-\d{2}-\d{2}$/;
/** Filtros comuns do Painel de OS: período (datas de Brasília), código do setor e solicitante. */
function filters(a:Actor,url:URL){
 const where:string[]=[],values:unknown[]=[];
 const scope=scopeOf(a);if(scope){where.push('w.org_id = ANY(?::text[])');values.push(scope);}
 const from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'';
 const real=(v:string)=>DATE.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00-03:00'))&&new Date(Date.parse(v+'T12:00:00Z')).toISOString().slice(0,10)===v;
 if(from&&!real(from)||to&&!real(to))throw new AppError('Período inválido.');
 if(from&&to&&to<from)throw new AppError('A data final deve ser igual ou posterior à inicial.');
 // A OS entra no período quando o planejado ou o real cruza as datas escolhidas.
 const t0=from?new Date(from+'T00:00:00-03:00').toISOString():null,t1=to?new Date(new Date(to+'T00:00:00-03:00').valueOf()+DAY).toISOString():null;
 if(t0){where.push('greatest(w.planned_end::timestamptz,coalesce(w.actual_end::timestamptz,now())) > ?::timestamptz');values.push(t0);}
 if(t1){where.push('least(w.planned_start::timestamptz,coalesce(w.actual_start::timestamptz,w.planned_start::timestamptz)) < ?::timestamptz');values.push(t1);}
 const sector=text(url.searchParams.get('sector'),40);if(sector){where.push('w.code=?');values.push(sector);}
 const org=text(url.searchParams.get('org'),100);if(org){where.push('w.org_id=?');values.push(org);}
 return {where,values};
}

/** Etapas, intervalos e apontamentos das OS informadas (já filtradas pelo escopo). */
async function details(ids:string[]){
 if(!ids.length)return {steps:[] as Row[],intervals:[] as Row[],occurrences:[] as Row[]};
 const [steps,intervals,occurrences]=await Promise.all([
  db().all(`SELECT o.id,o.work_order_id,o.step_key,o.status,o.actual_start,o.actual_end,p.name,p.position,p.planned_start,p.planned_end
   FROM os_steps o JOIN plan_steps p ON p.id=o.plan_step_id WHERE o.work_order_id = ANY(?::text[]) ORDER BY p.position`,ids),
  db().all(`SELECT i.os_step_id,s.work_order_id,i.kind,i.start_at,i.end_at,e.kind start_kind
   FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id LEFT JOIN execution_events e ON e.id=i.start_event_id
   WHERE s.work_order_id = ANY(?::text[]) ORDER BY i.start_at`,ids),
  db().all(`SELECT o.id,o.work_order_id,o.os_step_id,o.kind,o.blocking,o.status,o.occurred_at,o.impact_start,o.impact_end,o.severity,o.description,c.name category_name
   FROM occurrences o LEFT JOIN occurrence_categories c ON c.id=o.category_id WHERE o.work_order_id = ANY(?::text[]) ORDER BY o.occurred_at`,ids),
 ]);
 return {steps,intervals,occurrences};
}

/** Lista de OS por grupo (Em andamento, Programadas, Concluídas, Todas), com contagens e execução. */
export async function opsBoard(member:Member,url:URL){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']);
 const g=url.searchParams.get('group')||'andamento';
 if(!Object.hasOwn(GROUPS,g))throw new AppError('Filtro inválido.');
 const group=g as Group;
 const q=text(url.searchParams.get('q'),60).toLowerCase();
 const {where,values}=filters(a,url);
 if(q){
  const digits=q.replace(/\D/g,''),n=digits.length<=9?Number(digits):0;
  const like=`%${q.replace(/[\\%_]/g,m=>'\\'+m)}%`;
  where.push(`(lower(coalesce(nullif(w.title,''),t.name)) LIKE ? OR lower(coalesce(w.code,t.code)) LIKE ? OR lower(o.name) LIKE ? OR lower(o.acronym) LIKE ?${n?' OR w.number=?':''})`);
  values.push(like,like,like,like,...(n?[n]:[]));
 }
 const base=`FROM work_orders w JOIN activity_types t ON t.id=w.activity_type_id JOIN requester_orgs o ON o.id=w.org_id LEFT JOIN locations l ON l.id=w.location_id`;
 const filter=where.length?' AND '+where.join(' AND '):'';
 const [rows,counts]=await Promise.all([
  db().all(`SELECT w.id,w.number,w.status,w.org_id,w.planned_start,w.planned_end,w.actual_start,w.actual_end,w.closed_at,w.origin,coalesce(nullif(w.code,''),CASE WHEN t.system=1 THEN '' ELSE t.code END) activity_code,coalesce(nullif(w.title,''),t.name) activity_name,
   o.acronym org_acronym,o.name org_name,o.color org_color,l.name location_name ${base}
   WHERE ${GROUPS[group]}${filter}
   ORDER BY CASE w.status WHEN 'em_andamento' THEN 0 WHEN 'encerramento_pendente' THEN 1 WHEN 'programada' THEN 2 WHEN 'concluida' THEN 3 ELSE 4 END,
    CASE WHEN w.status IN ('concluida','cancelada') THEN -extract(epoch FROM coalesce(w.closed_at,w.planned_end)::timestamptz) ELSE extract(epoch FROM w.planned_start::timestamptz) END,w.number
   LIMIT 101`,...values),
  db().all(`SELECT w.status,count(*)::int n ${base} WHERE TRUE${filter} GROUP BY w.status`,...values),
 ]);
 const list=rows.slice(0,100);
 const d=await details(list.map(r=>r.id));
 const c=Object.fromEntries(counts.map(r=>[r.status,r.n])) as Record<string,number>;
 const sum=(...s:string[])=>s.reduce((t,k)=>t+(c[k]||0),0);
 return {
  orders:list.map((o):Row=>({...o,steps:d.steps.filter(s=>s.work_order_id===o.id),intervals:d.intervals.filter(i=>i.work_order_id===o.id),occurrences:d.occurrences.filter(x=>x.work_order_id===o.id)})),
  more:rows.length>100,
  counts:{andamento:sum('em_andamento','encerramento_pendente'),programadas:sum('programada'),concluidas:sum('concluida'),canceladas:sum('cancelada'),todas:sum('em_andamento','encerramento_pendente','programada','concluida','cancelada')},
  canExecute:isManager(a)||(a.capabilities||[]).includes('operacao'),
  serverNow:new Date().toISOString(),
 };
}

/** Indicadores do turno e gráficos do Painel de OS. */
export async function opsDashboard(member:Member,url?:URL){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']);
 // Indicadores do turno: escopo, setor e solicitante filtrados; o período dos indicadores é o do turno.
 const f=filters(a,new URL('http://x/?'+new URLSearchParams({sector:url?.searchParams.get('sector')||'',org:url?.searchParams.get('org')||''}).toString()));
 const sw=f.where.length?' AND '+f.where.join(' AND '):'',sv=f.values;
 const t0=dayStart(),t1=new Date(t0.valueOf()+DAY),now=new Date(),w7=new Date(t0.valueOf()-6*DAY),d30=new Date(t0.valueOf()-29*DAY);
 // Tempo efetivo recortado a uma janela: soma dos intervalos ativos (etapas em paralelo somam).
 const clipped=`coalesce(sum(extract(epoch FROM (least(coalesce(i.end_at::timestamptz,now()),?::timestamptz)-greatest(i.start_at::timestamptz,?::timestamptz)))),0)::float8`;
 const [orders,steps,blocks,hours,byOrg,byActivity]=await Promise.all([
  db().first(`SELECT count(*) FILTER (WHERE w.status IN ('em_andamento','encerramento_pendente'))::int running,
   count(*) FILTER (WHERE w.status='programada' AND w.planned_start::timestamptz>=? AND w.planned_start::timestamptz<?)::int today,
   count(*) FILTER (WHERE w.status='programada' AND w.planned_start::timestamptz<?)::int late,
   count(*) FILTER (WHERE w.status='encerramento_pendente')::int pending,
   count(*) FILTER (WHERE w.status='concluida' AND w.closed_at::timestamptz>=? AND w.closed_at::timestamptz<?)::int closed_today
   FROM work_orders w WHERE TRUE${sw}`,t0,t1,now,t0,t1,...sv),
  db().first(`SELECT count(*) FILTER (WHERE s.status='em_execucao')::int active,count(*) FILTER (WHERE s.status IN ('pausada','bloqueada'))::int stopped
   FROM os_steps s JOIN work_orders w ON w.id=s.work_order_id WHERE w.status IN ('em_andamento','encerramento_pendente')${sw}`,...sv),
  db().first(`SELECT count(*)::int n FROM occurrences x JOIN work_orders w ON w.id=x.work_order_id WHERE x.blocking=1 AND x.status='aberto'${sw}`,...sv),
  db().first(`SELECT ${clipped} s FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id JOIN work_orders w ON w.id=s.work_order_id
   WHERE i.kind='ativo' AND i.start_at::timestamptz<? AND coalesce(i.end_at::timestamptz,now())>?${sw}`,t1,t0,t1,t0,...sv),
  db().all(`SELECT o.acronym,o.name,o.color,count(*) FILTER (WHERE w.status IN ('em_andamento','encerramento_pendente'))::int andamento,
   count(*) FILTER (WHERE w.status='programada')::int programadas,count(*) FILTER (WHERE w.status='concluida')::int concluidas,count(*) FILTER (WHERE w.status='cancelada')::int canceladas,count(*)::int total
   FROM work_orders w JOIN requester_orgs o ON o.id=w.org_id WHERE w.planned_start::timestamptz>=? AND w.planned_start::timestamptz<?${sw} GROUP BY o.acronym,o.name,o.color ORDER BY total DESC,o.acronym LIMIT 8`,d30,t1,...sv),
  db().all(`SELECT t.name label,${clipped} s FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id JOIN work_orders w ON w.id=s.work_order_id JOIN activity_types t ON t.id=w.activity_type_id
   WHERE i.kind='ativo' AND i.start_at::timestamptz<? AND coalesce(i.end_at::timestamptz,now())>?${sw} GROUP BY t.name ORDER BY s DESC LIMIT 8`,t1,w7,t1,w7,...sv),
 ]);
 // Opções dos filtros (setores cadastrados e solicitantes do alcance de quem consulta).
 const scope=scopeOf(a);
 const [sectors,orgs]=await Promise.all([filterSectors(),db().all(`SELECT id,name,acronym,color FROM requester_orgs${scope?' WHERE id = ANY(?::text[])':''} ORDER BY name`,...(scope?[scope]:[]))]);
 return {kpis:{...orders,...steps,blocks:blocks?.n||0,hoursToday:hours?.s||0} as Row,byOrg,byActivity,sectors,orgs,serverNow:now.toISOString()};
}
