// Exportação: conjuntos de Abastecimento (gestor) e de Operação (quem consulta OS, no seu escopo de
// organizações), em Excel (.xlsx, uma aba por conjunto) ou CSV (.zip quando há mais de um conjunto).
// Os nomes de tabela e colunas vêm só das definições abaixo; filtros entram como parâmetros.
import {db,type Row} from './db';
import {AppError,isoDay} from './domain';
import {type Member,isManager,canSeeOrders,loadAccess} from './permissions';
import {osNumber} from './planning';
import {audit} from './registry';
import {xlsx,csv,zip,type Sheet,type Cell} from './files';

const LIMIT=10000,TOTAL=30000;
const d=(v:unknown):Cell=>v?new Date(String(v)):null;
const min=(v:unknown)=>v===null||v===undefined?null:Math.round(Number(v)/60);
const local=(v:unknown)=>v?new Date(String(v)).toLocaleString('sv-SE',{timeZone:'America/Sao_Paulo'}):'';
const ORDER:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const STEP:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada'};
const KIND:Record<string,string>={ocorrencia:'Ocorrência',impacto:'Impacto',bloqueio:'Bloqueio'};
const EVENT:Record<string,string>={pausa:'Pausa',bloqueio:'Bloqueio',nc_critica:'NC crítica',interrupcao_tecnica:'Interrupção técnica'};
const MOMENT:Record<string,string>={pre_atividade:'Pré-atividade',pre_uso:'Pré-uso',durante:'Durante',pos_atividade:'Pós-atividade'};
const SUPPLY:Record<string,string>={confirmed:'Confirmado',cancelled:'Cancelado'};

type Filters={start:string|null;end:string|null;fuel:string|null;org:string|null};
type Scope={orgs:string[]|null};
type Def={label:string;group:'abastecimento'|'operacao';
 /** FROM/JOIN + WHERE fixo; os filtros são acrescentados por where(). */
 from:string;order:string;select:string;where:(f:Filters,s:Scope)=>[string[],unknown[]];columns:string[];map:(r:Row)=>Cell[]};

const range=(col:string,f:Filters):[string[],unknown[]]=>{const w:string[]=[],v:unknown[]=[];
 if(f.start){w.push(`${col}::timestamptz>=?`);v.push(new Date(f.start+'T00:00:00-03:00').toISOString());}
 if(f.end){w.push(`${col}::timestamptz<=?`);v.push(new Date(f.end+'T23:59:59.999-03:00').toISOString());}
 return [w,v];};
const fuelWhere=(col:string,dateCol:string)=>(f:Filters):[string[],unknown[]]=>{const [w,v]=range(dateCol,f);if(f.fuel){w.push(col+'=?');v.push(f.fuel);}return [w,v];};
/** OS que tocam o período (planejado ou real) e estão no escopo de organizações. */
const osWhere=(f:Filters,s:Scope):[string[],unknown[]]=>{const w:string[]=[],v:unknown[]=[];
 if(f.start){w.push("greatest(w.planned_end::timestamptz,coalesce(w.actual_end,w.planned_end)::timestamptz)>=?");v.push(new Date(f.start+'T00:00:00-03:00').toISOString());}
 if(f.end){w.push("least(w.planned_start::timestamptz,coalesce(w.actual_start,w.planned_start)::timestamptz)<=?");v.push(new Date(f.end+'T23:59:59.999-03:00').toISOString());}
 if(s.orgs){w.push('w.org_id = ANY(?::text[])');v.push(s.orgs);}
 if(f.org){w.push('w.org_id=?');v.push(f.org);}
 return [w,v];};
const OS_JOIN='JOIN work_orders w ON w.id=';

export const DATASETS:Record<string,Def>={
 supplies:{label:'Abastecimentos',group:'abastecimento',from:'FROM supplies s',order:'s.occurred_at,s.id',select:'s.*',where:fuelWhere('s.fuel_id','s.occurred_at'),
  columns:['ID','Data_UTC','Data_Local','Equipamento_ID','TAG','Equipamento','Operador_ID','Operador','Combustivel_ID','Combustivel','Quantidade','Unidade','Horimetro_Inicial','Horimetro_Final','Responsavel_ID','Responsavel_Lancamento','Lancado_Em_UTC','Situacao','Observacao','Justificativa_Cancelamento','Solicitacao_Abastecimento_ID'],
  map:r=>[r.id,r.occurred_at,local(r.occurred_at),r.equipment_id,r.equipment_tag,r.equipment_name,r.operator_id,r.operator_name,r.fuel_id,r.fuel_name,r.quantity_milli/1000,r.unit,r.hourmeter_milli===null?null:r.hourmeter_milli/1000,r.hourmeter_end_milli===null?null:r.hourmeter_end_milli/1000,r.author_id,r.author_name,r.created_at,SUPPLY[r.status]||r.status,r.notes,r.cancel_reason,r.appointment_id]},
 movements:{label:'Movimentações de estoque',group:'abastecimento',from:'FROM movements m JOIN fuels f ON f.id=m.fuel_id',order:'m.occurred_at,m.id',select:'m.*,f.name fuel_name,f.unit',where:fuelWhere('m.fuel_id','m.occurred_at'),
  columns:['ID','Data_UTC','Data_Local','Combustivel_ID','Combustivel','Tipo','Quantidade_Com_Sinal','Saldo_Apos','Unidade','Abastecimento_ID','Solicitacao_ID','Responsavel_ID','Responsavel','Justificativa'],
  map:r=>[r.id,r.occurred_at,local(r.occurred_at),r.fuel_id,r.fuel_name,r.kind,r.delta_milli/1000,r.balance_after_milli===null?null:r.balance_after_milli/1000,r.unit,r.supply_id,r.request_id,r.author_id,r.author_name,r.reason]},
 requests:{label:'Solicitações de reposição',group:'abastecimento',from:'FROM requests r JOIN fuels f ON f.id=r.fuel_id',order:'r.opened_at,r.id',select:'r.*,f.name fuel_name,f.unit',where:fuelWhere('r.fuel_id','r.opened_at'),
  columns:['ID','Combustivel_ID','Combustivel','Abertura_UTC','Abertura_Local','Prazo_UTC','Quantidade_Solicitada','Quantidade_Recebida','Unidade','Situacao'],
  map:r=>[r.id,r.fuel_id,r.fuel_name,r.opened_at,local(r.opened_at),r.deadline,r.requested_milli/1000,r.received_milli/1000,r.unit,r.status]},
 os:{label:'OS',group:'operacao',
  from:`FROM work_orders w JOIN activity_types t ON t.id=w.activity_type_id JOIN requester_orgs o ON o.id=w.org_id LEFT JOIN locations l ON l.id=w.location_id
   LEFT JOIN plans p ON p.id=w.current_plan_id LEFT JOIN requester_people rp ON rp.id=p.requester_person_id`,order:'w.planned_start,w.number',
  select:`w.*,coalesce(nullif(w.code,''),CASE WHEN t.system=1 THEN '' ELSE t.code END) activity_code,coalesce(nullif(w.title,''),t.name) activity_name,o.acronym org_acronym,o.name org_name,l.name location_name,rp.name requester_name,p.description,
   (SELECT count(*) FROM os_steps s WHERE s.work_order_id=w.id)::int steps_total,(SELECT count(*) FROM os_steps s WHERE s.work_order_id=w.id AND s.status IN ('concluida','dispensada'))::int steps_done,
   (SELECT count(*) FROM occurrences x WHERE x.work_order_id=w.id)::int occurrences,(SELECT count(*) FROM occurrences x WHERE x.work_order_id=w.id AND x.blocking=1 AND x.status='aberto')::int open_blocks,
   (SELECT coalesce(sum(extract(epoch FROM (coalesce(i.end_at::timestamptz,now())-i.start_at::timestamptz))),0) FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id WHERE s.work_order_id=w.id AND i.kind='interrompido')::float8 stopped_s`,
  where:osWhere,
  columns:['OS','Atividade (código)','Atividade','Situação','Solicitante (sigla)','Solicitante','Pessoa solicitante','Local','Descrição','Início planejado','Fim planejado','Início real','Fim real','Encerramento','Tempo efetivo (min)','Tempo parado (min)','Etapas concluídas','Etapas','Apontamentos','Bloqueios abertos','Lançada por','Lançada em','Motivo do cancelamento','ID','Origem'],
  map:r=>[osNumber(r.number),r.activity_code,r.activity_name,ORDER[r.status],r.org_acronym,r.org_name,r.requester_name,r.location_name,r.description,d(r.planned_start),d(r.planned_end),d(r.actual_start),d(r.actual_end),d(r.closed_at),min(r.effective_s),min(r.stopped_s),r.steps_done,r.steps_total,r.occurrences,r.open_blocks,r.launched_by_name,d(r.launched_at),r.cancel_reason,r.id,r.origin==='realizada'?'Realizada sem planejamento':'Planejada']},
 etapas:{label:'Etapas',group:'operacao',from:`FROM os_steps s JOIN plan_steps p ON p.id=s.plan_step_id ${OS_JOIN}s.work_order_id JOIN activity_types t ON t.id=w.activity_type_id`,order:'w.number,p.position',
  select:`s.*,p.name,p.position,p.planned_start,p.planned_end,w.number,coalesce(nullif(w.title,''),t.name) activity_name,
   (SELECT coalesce(sum(extract(epoch FROM (coalesce(i.end_at::timestamptz,now())-i.start_at::timestamptz))),0) FROM step_intervals i WHERE i.os_step_id=s.id AND i.kind='ativo')::float8 active_s,
   (SELECT coalesce(sum(extract(epoch FROM (coalesce(i.end_at::timestamptz,now())-i.start_at::timestamptz))),0) FROM step_intervals i WHERE i.os_step_id=s.id AND i.kind='interrompido')::float8 stopped_s,
   extract(epoch FROM (s.actual_start::timestamptz-p.planned_start::timestamptz))::float8 start_dev_s,extract(epoch FROM (s.actual_end::timestamptz-p.planned_end::timestamptz))::float8 end_dev_s`,
  where:osWhere,
  columns:['OS','Atividade','#','Etapa','Situação','Início planejado','Fim planejado','Início real','Fim real','Efetivo (min)','Parado (min)','Desvio de início (min)','Desvio de fim (min)','ID da OS'],
  map:r=>[osNumber(r.number),r.activity_name,r.position,r.name,STEP[r.status],d(r.planned_start),d(r.planned_end),d(r.actual_start),d(r.actual_end),min(r.active_s),min(r.stopped_s),min(r.start_dev_s),min(r.end_dev_s),r.work_order_id]},
 periodos:{label:'Períodos',group:'operacao',from:`FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id JOIN plan_steps p ON p.id=s.plan_step_id ${OS_JOIN}s.work_order_id LEFT JOIN execution_events e ON e.id=i.start_event_id`,order:'w.number,i.start_at',
  select:`i.kind,i.start_at,i.end_at,e.kind start_kind,e.author_name,p.name,w.number,s.work_order_id,extract(epoch FROM (coalesce(i.end_at::timestamptz,now())-i.start_at::timestamptz))::float8 dur_s`,
  where:osWhere,columns:['OS','Etapa','Tipo','Motivo','Início','Fim','Duração (min)','Lançado por','ID da OS'],
  map:r=>[osNumber(r.number),r.name,r.kind==='ativo'?'Trabalho':'Parado',r.kind==='ativo'?null:EVENT[r.start_kind]||r.start_kind,d(r.start_at),r.end_at?d(r.end_at):'em aberto',min(r.dur_s),r.author_name,r.work_order_id]},
 apontamentos:{label:'Apontamentos',group:'operacao',from:`FROM occurrences x JOIN os_steps s ON s.id=x.os_step_id JOIN plan_steps p ON p.id=s.plan_step_id ${OS_JOIN}x.work_order_id LEFT JOIN occurrence_categories c ON c.id=x.category_id`,order:'w.number,x.occurred_at',
  select:'x.*,c.name category_name,p.name step_name,w.number',where:osWhere,
  columns:['OS','Etapa','Tipo','Bloqueia','Categoria','Descrição','Severidade','Ocorrido em','Registrado em','Lançamento tardio','Autor','Impacto: início','Impacto: fim','Situação','Resolução','Resolvido por','Resolvido em','ID da OS'],
  map:r=>[osNumber(r.number),r.step_name,KIND[r.kind],r.blocking?'Sim':'Não',r.category_name,r.description,r.severity,d(r.occurred_at),d(r.registered_at),r.late?'Sim':'Não',r.author_name,d(r.impact_start),d(r.impact_end),r.status==='resolvido'?'Resolvido':'Aberto',r.resolution,r.resolved_by_name,d(r.resolved_at),r.work_order_id]},
 checklists:{label:'Checklists',group:'operacao',from:`FROM checklist_instances i JOIN checklist_versions v ON v.id=i.version_id JOIN checklist_templates ct ON ct.id=v.template_id ${OS_JOIN}i.work_order_id LEFT JOIN equipment eq ON eq.id=i.equipment_id`,order:'w.number,i.created_at',
  select:`i.*,v.title,v.version,v.moment,ct.code,eq.tag equipment_tag,w.number,(SELECT count(*) FROM checklist_answers a WHERE a.instance_id=i.id)::int answers,(SELECT count(*) FROM checklist_answers a WHERE a.instance_id=i.id AND a.answer='NC')::int nc`,
  where:osWhere,columns:['OS','Checklist','Versão','Momento','Equipamento','Situação','Respostas','NC','Iniciado por','Iniciado em','Concluído por','Concluído em','ID da OS'],
  map:r=>[osNumber(r.number),`${r.code} · ${r.title}`,r.version,MOMENT[r.moment],r.equipment_tag,r.status==='concluido'?'Concluído':'Em preenchimento',r.answers,r.nc,r.created_by_name,d(r.created_at),r.completed_by_name,d(r.completed_at),r.work_order_id]},
};

/** Conjuntos que o usuário pode exportar (o servidor confere de novo a cada pedido). */
export function allowedSets(a:Member){return Object.entries(DATASETS).filter(([,def])=>def.group==='abastecimento'?isManager(a):isManager(a)||canSeeOrders(a)).map(([k])=>k);}

async function prepare(member:Member,url:URL){
 const a=await loadAccess(member);
 const allowed=allowedSets(a);
 const raw=(url.searchParams.get('sets')||url.searchParams.get('kind')||'').split(',').map(s=>s.trim()).filter(Boolean);
 const sets=[...new Set(raw)];
 if(!sets.length)throw new AppError('Escolha ao menos um conjunto de dados.');
 if(sets.some(s=>!(s in DATASETS)))throw new AppError('Conjunto de dados inválido.');
 if(sets.some(s=>!allowed.includes(s)))throw new AppError('Seu acesso não inclui um dos conjuntos escolhidos.',403);
 const start=url.searchParams.get('start'),end=url.searchParams.get('end');
 const f:Filters={start:start?isoDay(start):null,end:end?isoDay(end):null,fuel:url.searchParams.get('fuel')?.slice(0,64)||null,org:url.searchParams.get('org')?.slice(0,64)||null};
 if(f.fuel==='all')f.fuel=null;if(f.org==='all')f.org=null;
 if(f.start&&f.end&&f.start>f.end)throw new AppError('A data inicial precisa ser anterior à final.');
 const scope:Scope={orgs:isManager(a)||!a.org_scope.length?null:a.org_scope};
 if(f.org&&scope.orgs&&!scope.orgs.includes(f.org))throw new AppError('Organização fora do seu acesso.',403);
 return {a,sets,f,scope};
}
const clause=(def:Def,f:Filters,s:Scope)=>{const [w,v]=def.where(f,s);return {sql:w.length?' WHERE '+w.join(' AND '):'',values:v};};

/** Prévia: só contagens, para conferir antes de gerar o arquivo. */
export async function exportPreview(member:Member,url:URL){
 const {sets,f,scope}=await prepare(member,url);
 const counts:Record<string,number>={};
 for(const k of sets){const def=DATASETS[k],c=clause(def,f,scope);counts[k]=Number((await db().first(`SELECT count(*)::int n ${def.from}${c.sql}`,...c.values))?.n||0);}
 return {counts,limit:LIMIT,total:TOTAL};
}

/** Tempo efetivo das OS: união dos intervalos ativos de todas as etapas (paralelas não contam em dobro). */
async function effective(ids:string[]){
 const out=new Map<string,number>();if(!ids.length)return out;
 const rows=await db().all(`SELECT s.work_order_id,i.start_at,i.end_at FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id WHERE i.kind='ativo' AND s.work_order_id = ANY(?::text[]) ORDER BY s.work_order_id,i.start_at::timestamptz`,ids);
 const now=Date.now();let id='',total=0,cur:number[]|null=null;
 const flush=()=>{if(id)out.set(id,(total+(cur?cur[1]-cur[0]:0))/1000);};
 for(const r of rows){if(r.work_order_id!==id){flush();id=r.work_order_id;total=0;cur=null;}
  const s=[Date.parse(r.start_at),r.end_at?Date.parse(r.end_at):now];
  if(!cur||s[0]>cur[1]){if(cur)total+=cur[1]-cur[0];cur=s;}else cur[1]=Math.max(cur[1],s[1]);}
 flush();return out;
}

export async function exportData(member:Member,url:URL){
 const {a,sets,f,scope}=await prepare(member,url);
 const legacy=!url.searchParams.get('sets')&&!!url.searchParams.get('kind');
 const format=legacy?'csv':url.searchParams.get('format')==='csv'?'csv':'xlsx';
 const sheets:Sheet[]=[];let sum=0;
 for(const k of sets){
  const def=DATASETS[k],c=clause(def,f,scope);
  const total=Number((await db().first(`SELECT count(*)::int n ${def.from}${c.sql}`,...c.values))?.n||0);
  if(total>LIMIT)throw new AppError(`${def.label}: ${total.toLocaleString('pt-BR')} registros. Escolha um período menor (limite de ${LIMIT.toLocaleString('pt-BR')} por conjunto).`,413);
  sum+=total;if(sum>TOTAL)throw new AppError(`Arquivo grande demais: mais de ${TOTAL.toLocaleString('pt-BR')} linhas somando os conjuntos. Escolha um período menor ou menos conjuntos.`,413);
  const rows=await db().all(`SELECT ${def.select} ${def.from}${c.sql} ORDER BY ${def.order} LIMIT ${LIMIT}`,...c.values);
  if(k==='os'){const eff=await effective(rows.map(r=>r.id));for(const r of rows)r.effective_s=eff.get(r.id)||0;}
  sheets.push({name:def.label,columns:def.columns,rows:rows.map(def.map),total});
 }
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
 await db().tx(tx=>audit(tx,a,`Exportação: ${format==='xlsx'?'planilha':'CSV'} de dados`,a.id,{sets,format,start:f.start,end:f.end,fuel:f.fuel,org:f.org,rows:sheets.reduce((t,s)=>t+s.rows.length,0)}));
 const base=sets.length===1?`nautilus_${sets[0]}_${day}`:`nautilus_${day}`;
 const headers=(type:string,name:string)=>({'Content-Type':type,'Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 if(format==='xlsx')return new Response(new Uint8Array(xlsx(sheets)),{headers:headers('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',base+'.xlsx')});
 if(sheets.length===1)return new Response(csv(sheets[0]),{headers:headers('text/csv; charset=utf-8',base+'.csv')});
 return new Response(new Uint8Array(zip(sets.map((k,i)=>({name:`${k}.csv`,data:csv(sheets[i])})))),{headers:headers('application/zip',base+'.zip')});
}
