// Planejamento › Planejamento de atividade, Rascunhos e Lista de OS; Operação › Ordens de serviço.
// Rascunho persistido com reservas provisórias exclusivas, revisão pelo próprio planejador,
// lançamento idempotente e cancelamento. O banco garante o intertravamento (reservation_guard).
import {db,type Executor,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny,canSeeOrders} from './permissions';
import {audit,idList} from './registry';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const all=(q:string,...v:unknown[])=>db().all(q,...v);
const first=(q:string,...v:unknown[])=>db().first(q,...v);
const idOf=(value:unknown,label:string)=>required(value,label,100);
type Actor=Member&{org_scope:string[]};

/** Data e hora completas com fuso; vazio vira null. */
export function instant(value:unknown,label:string):string|null{
 if(value==null||value==='')return null;
 if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)||!/(Z|[+-]\d{2}:\d{2})$/.test(value))throw new AppError(`${label}: informe data e hora completas.`);
 const d=new Date(value);if(!Number.isFinite(d.valueOf()))throw new AppError(`${label}: data inválida.`);
 return d.toISOString();
}
const ms=(v:string|null|undefined)=>v?Date.parse(v):NaN;
const BR=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric'});
const HM=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const hm=(v:string)=>HM.format(new Date(v)).replace(':','h');
/** “14/10/2026 das 08h00 às 10h00” (ou com as duas datas quando atravessa dias). */
export function period(start:string,end:string){const a=BR.format(new Date(start)),b=BR.format(new Date(end));return a===b?`${a} das ${hm(start)} às ${hm(end)}`:`${a} ${hm(start)} a ${b} ${hm(end)}`;}
export const osNumber=(n:number)=>'OS '+String(n).padStart(6,'0');

/** Escopo de organizações: null = todas. O gestor sempre vê todas. */
const scopeOf=(a:Actor)=>isManager(a)||!a.org_scope.length?null:a.org_scope;
const inScope=(a:Actor,orgId:string|null)=>{const s=scopeOf(a);return !s||(!!orgId&&s.includes(orgId));};

async function refs(){
 const [activityTypes,orgs,people,locations,equipment,equipmentTypes,operators,functions,impediments]=await Promise.all([
  all('SELECT t.id,t.code,t.name,t.active,t.current_version,v.id flow_version_id FROM activity_types t JOIN flow_versions v ON v.activity_type_id=t.id AND v.version=t.current_version ORDER BY t.name'),
  all('SELECT id,name,acronym,category,color,active FROM requester_orgs ORDER BY name'),
  all('SELECT id,org_id,name,role,active FROM requester_people ORDER BY name'),
  all('SELECT id,parent_id,kind,name,code,active FROM locations ORDER BY name'),
  all('SELECT id,tag,description,type_id,location_id,capacity,active FROM equipment ORDER BY tag'),
  all('SELECT id,name,active FROM equipment_types ORDER BY name'),
  all("SELECT o.id,o.name,o.badge,o.active,coalesce(array_agg(f.function_id) FILTER (WHERE f.function_id IS NOT NULL),'{}') function_ids FROM operators o LEFT JOIN operator_functions f ON f.operator_id=o.id GROUP BY o.id ORDER BY o.name"),
  all('SELECT id,name,active FROM job_functions ORDER BY name'),
  all('SELECT id,equipment_id,kind,reason,opened_at,opened_by_name FROM equipment_impediments WHERE released_at IS NULL ORDER BY opened_at'),
 ]);
 return {activityTypes,orgs,people,locations,equipment,equipmentTypes,operators,functions,impediments};
}

/** Planejamento completo: etapas, necessidades, pessoas, reservas ativas e documentos. */
export type PlanStep=Row&{needs:Row[],operator_ids:string[],equipment_ids:string[],reservations:Row[]};
export type Plan=Row&{steps:PlanStep[]};
export async function loadPlan(planId:string,ex:Executor=db()):Promise<Plan|null>{
 const plan=await ex.first('SELECT p.*,t.code activity_code,t.name activity_name,v.version flow_version,w.number os_number,w.status os_status FROM plans p JOIN activity_types t ON t.id=p.activity_type_id JOIN flow_versions v ON v.id=p.flow_version_id LEFT JOIN work_orders w ON w.id=p.work_order_id WHERE p.id=?',planId);
 if(!plan)return null;
 const [steps,needs,people,reservations]=await Promise.all([
  ex.all('SELECT * FROM plan_steps WHERE plan_id=? ORDER BY position',planId),
  ex.all('SELECT * FROM plan_step_needs WHERE plan_id=?',planId),
  ex.all('SELECT * FROM plan_step_people WHERE plan_id=?',planId),
  ex.all("SELECT * FROM reservations WHERE plan_id=? AND status<>'liberada'",planId),
 ]);
 return {...plan,steps:steps.map(s=>({...s,needs:needs.filter(n=>n.plan_step_id===s.id).map(n=>({equipment_type_id:n.equipment_type_id,function_id:n.function_id,quantity:n.quantity})),operator_ids:people.filter(p=>p.plan_step_id===s.id).map(p=>p.operator_id),equipment_ids:reservations.filter(r=>r.plan_step_id===s.id).map(r=>r.equipment_id),reservations:reservations.filter(r=>r.plan_step_id===s.id)}))};
}

/** Quem vê o planejamento: rascunho só o autor e o gestor; lançado, quem consulta OS no escopo. */
function canView(a:Actor,plan:Row){
 if(plan.status==='draft'||plan.status==='discarded')return plan.author_id===a.id||isManager(a);
 return canSeeOrders(a)&&inScope(a,plan.org_id);
}
function canEdit(a:Actor,plan:Row){return plan.status==='draft'&&(plan.author_id===a.id||isManager(a));}

/** Conflitos de agenda de um equipamento num intervalo, com descrição segura para quem pergunta. */
async function conflicts(a:Actor,equipmentId:string,start:string,end:string,ignore:{planId?:string,stepId?:string}={}){
 const rows=await all(`SELECT r.id,r.start_at,r.end_at,r.status,r.plan_id,r.plan_step_id,p.status plan_status,p.author_id,p.author_name,p.org_id,s.name step_name,w.number
  FROM reservations r JOIN plans p ON p.id=r.plan_id JOIN plan_steps s ON s.id=r.plan_step_id LEFT JOIN work_orders w ON w.id=p.work_order_id
  WHERE r.equipment_id=? AND r.status<>'liberada' AND r.start_at::timestamptz < ?::timestamptz AND r.end_at::timestamptz > ?::timestamptz`,equipmentId,end,start);
 return rows.filter(r=>!(ignore.stepId&&r.plan_step_id===ignore.stepId)).map(r=>{
  const own=r.author_id===a.id||isManager(a);
  const when=period(r.start_at,r.end_at);
  const label=r.plan_status==='draft'
   ?(own?`reserva provisória de planejamento (${r.plan_id===ignore.planId?'neste rascunho, ':''}etapa “${r.step_name}”, responsável ${r.author_name}), em ${when}`:`reserva provisória de planejamento em ${when}`)
   :(inScope(a,r.org_id)?`reservado para a etapa “${r.step_name}” da ${osNumber(r.number)}, em ${when}`:`reservado para outra OS em ${when}`);
  return {...r,label};
 });
}

export async function planningState(member:Member){
 const a=await requireAny(member,['planejamento']);
 const [data,drafts]=await Promise.all([
  refs(),
  all(`SELECT p.id,p.description,p.org_id,p.planned_start,p.planned_end,p.updated_at,p.created_at,p.author_id,p.author_name,p.version,t.code activity_code,t.name activity_name,
   (SELECT count(*) FROM reservations r WHERE r.plan_id=p.id AND r.status='provisoria') reservations
   FROM plans p JOIN activity_types t ON t.id=p.activity_type_id WHERE p.status='draft'${isManager(a)?'':' AND p.author_id=?'} ORDER BY p.updated_at DESC`,...(isManager(a)?[]:[a.id])),
 ]);
 return {...data,drafts,actor:{id:a.id,manager:isManager(a)},generatedAt:now()};
}

export async function planDetail(member:Member,planId:string){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']);
 const plan=await loadPlan(idOf(planId,'Planejamento'));
 if(!plan||!canView(a,plan))throw new AppError('Planejamento não encontrado ou fora do seu acesso.',404);
 const impediments=await all("SELECT equipment_id,reason,opened_at FROM equipment_impediments WHERE released_at IS NULL AND equipment_id = ANY(?::text[])",plan.steps.flatMap(s=>s.equipment_ids));
 return {plan,impediments,editable:canEdit(a,plan)};
}

/** Situação de cada equipamento ativo no intervalo pedido (seletor da etapa). */
export async function availability(member:Member,url:URL){
 const a=await requireAny(member,['planejamento']);
 const start=instant(url.searchParams.get('start'),'Início'),end=instant(url.searchParams.get('end'),'Fim');
 if(!start||!end||ms(end)<=ms(start))throw new AppError('Informe um intervalo válido.');
 const stepId=url.searchParams.get('stepId')||undefined,planId=url.searchParams.get('planId')||undefined;
 const [equipment,impediments]=await Promise.all([all('SELECT id,tag FROM equipment WHERE active=1 ORDER BY tag'),all('SELECT equipment_id,reason FROM equipment_impediments WHERE released_at IS NULL')]);
 const out:Row[]=[];
 for(const e of equipment){
  const blocked=impediments.filter(i=>i.equipment_id===e.id);
  const busy=await conflicts(a,e.id,start,end,{planId,stepId});
  out.push({id:e.id,status:blocked.length?'bloqueado':busy.length?'reservado':'livre',detail:blocked.length?`Bloqueado por impedimento técnico: ${blocked.map(b=>b.reason).join('; ')}`:busy.map(b=>b.label).join(' · ')});
 }
 return {equipment:out};
}

/** Pendências (impedem o lançamento) e avisos. Só depende dos dados carregados. */
export function validatePlan(plan:Plan,ctx:{equipment:Row[],operators:Row[],impediments:Row[],orgs:Row[],locations:Row[]}){
 const errors:{step?:string,message:string}[]=[],warnings:{step?:string,message:string}[]=[];
 if(!plan.org_id)errors.push({message:'Informe a organização solicitante.'});
 else if(!ctx.orgs.find(o=>o.id===plan.org_id)?.active)errors.push({message:'A organização solicitante está inativa.'});
 if(!plan.location_id)errors.push({message:'Informe o local da atividade.'});
 if(!plan.planned_start||!plan.planned_end)errors.push({message:'Informe início e fim previstos da atividade.'});
 else if(ms(plan.planned_end)<=ms(plan.planned_start))errors.push({message:'O fim previsto deve ser depois do início.'});
 const included=plan.steps.filter(s=>s.included);
 if(!included.length)errors.push({message:'Inclua ao menos uma etapa.'});
 for(const s of included){
  const name=`Etapa “${s.name}”`;
  if(!s.planned_start||!s.planned_end){errors.push({step:s.step_key,message:`${name}: informe início e fim.`});continue;}
  if(ms(s.planned_end)<=ms(s.planned_start))errors.push({step:s.step_key,message:`${name}: o fim deve ser depois do início.`});
  if(plan.planned_start&&plan.planned_end&&(ms(s.planned_start)<ms(plan.planned_start)||ms(s.planned_end)>ms(plan.planned_end)))errors.push({step:s.step_key,message:`${name}: fora da janela prevista da atividade.`});
  for(const d of s.depends_on as string[]){
   const p=plan.steps.find(x=>x.step_key===d);if(!p)continue;
   if(!p.included){warnings.push({step:s.step_key,message:`${name} dependia de “${p.name}”, que não foi incluída: a dependência foi ignorada.`});continue;}
   if(p.planned_end&&ms(s.planned_start)<ms(p.planned_end))errors.push({step:s.step_key,message:`${name}: começa antes do fim de “${p.name}” (dependência término → início).`});
  }
  for(const n of s.needs as Row[]){
   if(n.equipment_type_id){
    const have=s.equipment_ids.filter((e:string)=>ctx.equipment.find(x=>x.id===e)?.type_id===n.equipment_type_id).length;
    if(have<n.quantity)errors.push({step:s.step_key,message:`${name}: faltam ${n.quantity-have} equipamento(s) do tipo exigido.`});
   }else{
    const have=s.operator_ids.filter((o:string)=>(ctx.operators.find(x=>x.id===o)?.function_ids||[]).includes(n.function_id)).length;
    if(have<n.quantity)errors.push({step:s.step_key,message:`${name}: faltam ${n.quantity-have} colaborador(es) com a função exigida.`});
   }
  }
  for(const e of s.equipment_ids as string[]){
   const eq=ctx.equipment.find(x=>x.id===e);
   if(!eq?.active)errors.push({step:s.step_key,message:`${name}: equipamento ${eq?.tag||''} inativo.`});
   const block=ctx.impediments.find(i=>i.equipment_id===e);
   if(block)errors.push({step:s.step_key,message:`${name}: equipamento ${eq?.tag} bloqueado por impedimento técnico (${block.reason}). Substitua o equipamento.`});
  }
  for(const o of s.operator_ids as string[])if(!ctx.operators.find(x=>x.id===o)?.active)errors.push({step:s.step_key,message:`${name}: colaborador inativo na seleção.`});
 }
 return {errors,warnings};
}

async function validation(plan:Plan){
 const [equipment,operators,impediments,orgs,locations]=await Promise.all([
  all('SELECT id,tag,type_id,active FROM equipment'),
  all("SELECT o.id,o.active,coalesce(array_agg(f.function_id) FILTER (WHERE f.function_id IS NOT NULL),'{}') function_ids FROM operators o LEFT JOIN operator_functions f ON f.operator_id=o.id GROUP BY o.id"),
  all('SELECT equipment_id,reason FROM equipment_impediments WHERE released_at IS NULL'),
  all('SELECT id,active FROM requester_orgs'),all('SELECT id,active FROM locations'),
 ]);
 const result=validatePlan(plan,{equipment,operators,impediments,orgs,locations});
 // Colaborador em etapas sobrepostas: aviso (não há reserva exclusiva de pessoas).
 for(const s of plan.steps.filter(x=>x.included&&x.planned_start&&x.planned_end&&x.operator_ids.length)){
  const clash=await all(`SELECT DISTINCT o.name FROM plan_step_people pp JOIN plan_steps st ON st.id=pp.plan_step_id JOIN plans p ON p.id=pp.plan_id JOIN operators o ON o.id=pp.operator_id
   WHERE pp.operator_id = ANY(?::text[]) AND pp.plan_step_id<>? AND p.status IN ('draft','launched') AND st.included=1 AND st.planned_start IS NOT NULL
   AND st.planned_start::timestamptz < ?::timestamptz AND st.planned_end::timestamptz > ?::timestamptz
   AND (p.status='launched' OR p.id=?)`,s.operator_ids,s.id,s.planned_end,s.planned_start,plan.id);
  if(clash.length)result.warnings.push({step:s.step_key,message:`Etapa “${s.name}”: ${clash.map(c=>c.name).join(', ')} também está em outra etapa no mesmo horário.`});
 }
 return result;
}

export async function validateDraft(member:Member,planId:string){
 const a=await requireAny(member,['planejamento']);
 const plan=await loadPlan(idOf(planId,'Planejamento'));
 if(!plan||!canView(a,plan))throw new AppError('Planejamento não encontrado.',404);
 return validation(plan);
}

/** Lista de OS lançadas (mesma fonte para Planejamento, Operação e contagens). */
export async function ordersList(member:Member,url:URL){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']);
 const from=instant(url.searchParams.get('from'),'Período inicial'),to=instant(url.searchParams.get('to'),'Período final');
 const where:string[]=[],values:unknown[]=[];
 const scope=scopeOf(a);if(scope){where.push('w.org_id = ANY(?::text[])');values.push(scope);}
 if(from){where.push('w.planned_end::timestamptz > ?::timestamptz');values.push(from);}
 if(to){where.push('w.planned_start::timestamptz < ?::timestamptz');values.push(to);}
 for(const [param,col] of [['org','w.org_id'],['type','w.activity_type_id'],['location','w.location_id'],['person','p.requester_person_id']] as const){const v=url.searchParams.get(param);if(v){where.push(col+'=?');values.push(v);}}
 const status=url.searchParams.get('status');
 if(status&&status!=='todas'){where.push('w.status=?');values.push(status);}else if(!status)where.push("w.status<>'cancelada'");
 const number=url.searchParams.get('number');if(number){const n=Number(number.replace(/\D/g,''));if(n)where.push('w.number='+n);}
 const rows=await all(`SELECT w.*,p.description,p.requester_person_id,t.code activity_code,t.name activity_name,
  (SELECT count(*) FROM os_steps s WHERE s.work_order_id=w.id) steps_total,(SELECT count(*) FROM os_steps s WHERE s.work_order_id=w.id AND s.status IN ('concluida','dispensada')) steps_done,
  (SELECT count(*) FROM reservations r JOIN equipment_impediments i ON i.equipment_id=r.equipment_id AND i.released_at IS NULL WHERE r.plan_id=w.current_plan_id AND r.status='confirmada') blocked_resources
  FROM work_orders w JOIN plans p ON p.id=w.current_plan_id JOIN activity_types t ON t.id=w.activity_type_id${where.length?' WHERE '+where.join(' AND '):''} ORDER BY w.number DESC LIMIT 1000`,...values);
 const t=Date.now();
 // Ordem padrão: em andamento → não iniciadas atrasadas → futuras → concluídas → canceladas.
 const rank=(r:Row)=>r.status==='em_andamento'||r.status==='encerramento_pendente'?0:r.status==='programada'?(ms(r.planned_start)<t?1:2):r.status==='concluida'?3:4;
 rows.sort((x,y)=>rank(x)-rank(y)||(rank(x)===3?ms(y.actual_end||y.planned_end)-ms(x.actual_end||x.planned_end):ms(x.planned_start)-ms(y.planned_start))||x.number-y.number);
 const counts:Record<string,number>={};for(const r of rows)counts[r.org_id]=(counts[r.org_id]||0)+1;
 return {orders:rows.map((r):Row=>({...r,late:r.status==='programada'&&ms(r.planned_start)<t})),counts,total:rows.length,scoped:!!scope};
}

export async function ordersRefs(member:Member){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']);
 const scope=scopeOf(a);
 const data=await refs();
 return {orgs:data.orgs.filter(o=>!scope||scope.includes(o.id)),people:data.people.filter(p=>!scope||scope.includes(p.org_id)),locations:data.locations,activityTypes:data.activityTypes,equipment:data.equipment,equipmentTypes:data.equipmentTypes,operators:data.operators,functions:data.functions,scoped:!!scope,canPlan:isManager(a)||(a.capabilities||[]).includes('planejamento')};
}

async function createDraftFrom(tx:Executor,a:Member,activityTypeId:string,header:Row={}){
 const type=await tx.first('SELECT t.*,v.id flow_version_id FROM activity_types t JOIN flow_versions v ON v.activity_type_id=t.id AND v.version=t.current_version WHERE t.id=?',activityTypeId);
 if(!type)throw new AppError('Tipo de atividade não encontrado.',404);
 if(!type.active)throw new AppError('Este tipo de atividade está inativo.');
 const steps=await tx.all('SELECT * FROM flow_steps WHERE flow_version_id=? ORDER BY position',type.flow_version_id);
 const deps=await tx.all('SELECT s.step_key,p.step_key depends_on FROM flow_dependencies d JOIN flow_steps s ON s.id=d.step_id JOIN flow_steps p ON p.id=d.depends_on_id WHERE d.flow_version_id=?',type.flow_version_id);
 const needs=await tx.all('SELECT * FROM flow_step_needs WHERE flow_version_id=?',type.flow_version_id);
 const pid=id(),t=now();
 await tx.run('INSERT INTO plans(id,status,activity_type_id,flow_version_id,description,org_id,requester_person_id,location_id,planned_start,planned_end,author_id,author_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',pid,'draft',type.id,type.flow_version_id,header.description||'',header.org_id||null,header.requester_person_id||null,header.location_id||null,header.planned_start||null,header.planned_end||null,a.id,a.name,t,t);
 for(const s of steps){
  const sid=id();
  await tx.run('INSERT INTO plan_steps(id,plan_id,step_key,position,name,description,required,included,default_minutes,depends_on) VALUES(?,?,?,?,?,?,?,1,?,?::text[])',sid,pid,s.step_key,s.position,s.name,s.description,s.required,s.default_minutes,deps.filter(d=>d.step_key===s.step_key).map(d=>d.depends_on));
  for(const n of needs.filter(x=>x.step_id===s.id))await tx.run('INSERT INTO plan_step_needs(id,plan_id,plan_step_id,equipment_type_id,function_id,quantity) VALUES(?,?,?,?,?,?)',id(),pid,sid,n.equipment_type_id,n.function_id,n.quantity);
 }
 return {pid,type};
}

/** Checklists previstos na OS, com a versão vigente fixada no lançamento: os vinculados ao tipo
 * de atividade (um por OS) e os vinculados a equipamento/tipo (um por equipamento alocado). */
export async function createRequirements(tx:Executor,workOrderId:string,plan:Plan){
 const versions=await tx.all(`SELECT v.*,coalesce(array_agg(l.activity_type_id) FILTER (WHERE l.activity_type_id IS NOT NULL),'{}') activity_ids,
  coalesce(array_agg(l.equipment_id) FILTER (WHERE l.equipment_id IS NOT NULL),'{}') equipment_ids,coalesce(array_agg(l.equipment_type_id) FILTER (WHERE l.equipment_type_id IS NOT NULL),'{}') type_ids
  FROM checklist_versions v JOIN checklist_templates t ON t.id=v.template_id AND t.current_version=v.version AND t.active=1 LEFT JOIN checklist_links l ON l.version_id=v.id GROUP BY v.id`);
 const used=[...new Set(plan.steps.filter(s=>s.included).flatMap(s=>s.equipment_ids))];
 const equipment=used.length?await tx.all('SELECT id,type_id FROM equipment WHERE id = ANY(?::text[])',used):[];
 let n=0;const t=now();
 for(const v of versions){
  const rows:(string|null)[]=[];
  if((v.activity_ids as string[]).includes(plan.activity_type_id))rows.push(null);
  for(const e of equipment)if((v.equipment_ids as string[]).includes(e.id)||(e.type_id&&(v.type_ids as string[]).includes(e.type_id)))rows.push(e.id);
  for(const eq of rows){await tx.run('INSERT INTO checklist_requirements(id,work_order_id,version_id,equipment_id,mandatory,moment,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',id(),workOrderId,v.id,eq,v.mandatory,v.moment,t);n++;}
 }
 return n;
}

/** Libera as reservas ativas do planejamento (rascunho descartado, gestor, cancelamento). */
async function releaseAll(tx:Executor,planId:string,reason:string,statuses=['provisoria']){
 return tx.run(`UPDATE reservations SET status='liberada',released_at=?,release_reason=? WHERE plan_id=? AND status = ANY(?::text[])`,now(),reason,planId,statuses);
}

export async function planningMutate(path:string,b:Row,member:Member){
 const a=await requireAny(member,['planejamento']);

 if(path==='planning/create'){
  const res=await db().tx(async tx=>{const r=await createDraftFrom(tx,a,idOf(b.activityTypeId,'Tipo de atividade'));await audit(tx,a,'Planejamento: rascunho criado',r.pid,{activity:r.type.code,version:r.type.current_version});return r;});
  return {id:res.pid};
 }

 const plan=await loadPlan(idOf(b.id,'Planejamento'));
 if(!plan||!canView(a,plan))throw new AppError('Planejamento não encontrado.',404);

 if(path==='planning/launch'){
  const key=required(b.launchKey,'Identificador do lançamento',100);
  // Idempotência: reenvio, duplo clique ou falha de rede devolvem a mesma OS.
  if(plan.status==='launched'||plan.status==='superseded'){const w=await first('SELECT id,number FROM work_orders WHERE id=?',plan.work_order_id);return {workOrderId:w!.id,number:w!.number,repeated:true,message:`${osNumber(w!.number)} já está lançada.`};}
  if(!canEdit(a,plan))throw new AppError('Somente o autor do rascunho ou o gestor lança esta OS.',403);
  if(b.version!==plan.version)throw new AppError('O rascunho mudou desde a sua revisão. Revise novamente antes de lançar.',409);
  const check=await validation(plan);
  if(check.errors.length)throw new AppError(`Há ${check.errors.length} pendência(s) que impedem o lançamento. Revise o planejamento.`,409);
  const result=await db().tx(async tx=>{
   const locked=await tx.first('SELECT status,version FROM plans WHERE id=? FOR UPDATE',plan.id);
   if(locked!.status!=='draft'){const w=await tx.first('SELECT w.id,w.number FROM work_orders w JOIN plans p ON p.work_order_id=w.id WHERE p.id=?',plan.id);return {workOrderId:w!.id,number:w!.number,repeated:true};}
   if(locked!.version!==plan.version)throw new AppError('O rascunho mudou desde a sua revisão. Revise novamente antes de lançar.',409);
   const wid=id(),t=now();
   const w=await tx.first('INSERT INTO work_orders(id,current_plan_id,original_plan_id,activity_type_id,org_id,location_id,planned_start,planned_end,launched_at,launched_by,launched_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING number',wid,plan.id,plan.id,plan.activity_type_id,plan.org_id,plan.location_id,plan.planned_start,plan.planned_end,t,a.id,a.name);
   await tx.run("UPDATE plans SET status='launched',work_order_id=?,launch_key=?,launched_at=?,launched_by=?,updated_at=?,version=version+1 WHERE id=?",wid,key,t,a.id,t,plan.id);
   // Promove as reservas provisórias (o banco revalida conflito e condição técnica).
   await tx.run("UPDATE reservations SET status='confirmada' WHERE plan_id=? AND status='provisoria'",plan.id);
   for(const s of plan.steps.filter(x=>x.included))await tx.run('INSERT INTO os_steps(id,work_order_id,step_key,plan_step_id) VALUES(?,?,?,?)',id(),wid,s.step_key,s.id);
   const required=await createRequirements(tx,wid,plan);
   await audit(tx,a,'Planejamento: OS lançada',wid,{number:w!.number,planId:plan.id,steps:plan.steps.filter(x=>x.included).length,reservations:plan.steps.flatMap(s=>s.equipment_ids).length,checklists:required});
   return {workOrderId:wid,number:w!.number as number};
  });
  return {...result,message:`${osNumber(result.number)} lançada e disponível na Operação.`};
 }

 if(path==='planning/cancel'){
  if(plan.status!=='launched')throw new AppError('Somente OS lançadas podem ser canceladas.',409);
  if(!inScope(a,plan.org_id))throw new AppError('OS fora do seu acesso.',403);
  const reason=required(b.reason,'Motivo do cancelamento',1200);
  const w=await first('SELECT * FROM work_orders WHERE id=?',plan.work_order_id);
  if(w!.version!==b.version)throw new AppError('A OS mudou. Atualize a tela antes de cancelar.',409);
  if(w!.status!=='programada')throw new AppError('Esta OS já tem execução registrada; o cancelamento exige encerrar as etapas na Operação.',409);
  await db().tx(async tx=>{
   const changed=await tx.run("UPDATE work_orders SET status='cancelada',cancelled_at=?,cancelled_by=?,cancel_reason=?,version=version+1 WHERE id=? AND version=? AND status='programada'",now(),a.id,reason,w!.id,w!.version);
   if(!changed)throw new AppError('A OS mudou. Atualize a tela antes de cancelar.',409);
   await releaseAll(tx,plan.id,'OS cancelada',['confirmada']);
   await audit(tx,a,'Planejamento: OS cancelada',w!.id,{number:w!.number,reason});
  });
  return {ok:true,message:`${osNumber(w!.number)} cancelada. As reservas foram liberadas.`};
 }

 if(path==='planning/release'){
  // Gestor libera reservas provisórias de um rascunho esquecido de outra pessoa.
  if(!isManager(a))throw new AppError('Somente o gestor libera reservas de rascunhos.',403);
  if(plan.status!=='draft')throw new AppError('Este planejamento não é um rascunho.',409);
  const reason=required(b.reason,'Motivo',500);
  const n=await db().tx(async tx=>{const n=await releaseAll(tx,plan.id,'Liberada pelo gestor: '+reason);await tx.run('UPDATE plans SET version=version+1,updated_at=? WHERE id=?',now(),plan.id);await audit(tx,a,'Planejamento: reservas do rascunho liberadas',plan.id,{author:plan.author_name,reason,released:n});return n;});
  return {ok:true,message:`${n} reserva(s) liberada(s). O autor verá os equipamentos retirados do rascunho.`};
 }

 if(!canEdit(a,plan))throw new AppError(plan.status==='draft'?'Somente o autor do rascunho ou o gestor pode alterá-lo.':'Planejamento lançado não pode ser alterado.',plan.status==='draft'?403:409);
 if(b.version!==plan.version)throw new AppError('Este rascunho foi alterado em outra tela. Atualize para continuar.',409);

 if(path==='planning/discard'){
  await db().tx(async tx=>{
   const changed=await tx.run("UPDATE plans SET status='discarded',updated_at=?,version=version+1 WHERE id=? AND version=? AND status='draft'",now(),plan.id,plan.version);
   if(!changed)throw new AppError('Este rascunho foi alterado em outra tela. Atualize para continuar.',409);
   const n=await releaseAll(tx,plan.id,'Rascunho descartado');
   await audit(tx,a,'Planejamento: rascunho descartado',plan.id,{released:n});
  });
  return {ok:true,message:'Rascunho descartado. As reservas provisórias foram liberadas.'};
 }

 if(path==='planning/change-type'){
  // Troca de tipo: novo rascunho com os dados gerais; etapas, horários e alocações do anterior são descartados.
  const res=await db().tx(async tx=>{
   const changed=await tx.run("UPDATE plans SET status='discarded',updated_at=?,version=version+1 WHERE id=? AND version=? AND status='draft'",now(),plan.id,plan.version);
   if(!changed)throw new AppError('Este rascunho foi alterado em outra tela. Atualize para continuar.',409);
   await releaseAll(tx,plan.id,'Tipo de atividade trocado');
   const r=await createDraftFrom(tx,a,idOf(b.activityTypeId,'Tipo de atividade'),plan);
   await audit(tx,a,'Planejamento: tipo de atividade trocado',r.pid,{from:plan.activity_code,to:r.type.code,previousPlan:plan.id});
   return r;
  });
  return {id:res.pid,message:'Tipo trocado. Etapas carregadas do novo fluxo; os dados gerais foram mantidos.'};
 }

 if(path==='planning/save')return saveDraft(a,plan,b);
 throw new AppError('Ação não encontrada.',404);
}

async function activeOr(table:string,value:unknown,label:string,keep:unknown){
 if(!value)return null;
 const r=await first(`SELECT * FROM ${table} WHERE id=?`,idOf(value,label));
 if(!r)throw new AppError(`${label} não encontrado.`,404);
 if(!r.active&&r.id!==keep)throw new AppError(`${label} inativo.`);
 return r;
}

async function saveDraft(a:Actor,plan:Plan,b:Row){
 const description=text(b.description,2000);
 const org=await activeOr('requester_orgs',b.orgId,'Organização',plan.org_id);
 if(org&&!inScope(a,org.id))throw new AppError('Organização fora do seu acesso.',403);
 const person=await activeOr('requester_people',b.requesterPersonId,'Pessoa solicitante',plan.requester_person_id);
 if(person&&person.org_id!==org?.id)throw new AppError('A pessoa solicitante deve pertencer à organização escolhida.');
 const location=await activeOr('locations',b.locationId,'Local',plan.location_id);
 const start=instant(b.plannedStart,'Início previsto'),end=instant(b.plannedEnd,'Fim previsto');
 if(start&&end&&ms(end)<=ms(start))throw new AppError('O fim previsto deve ser depois do início.');
 if(!Array.isArray(b.steps)||b.steps.length!==plan.steps.length)throw new AppError('Etapas inválidas. Atualize a tela.');
 const [equipment,operators,types,functions]=await Promise.all([all('SELECT id,tag,active,type_id FROM equipment'),all('SELECT id,active FROM operators'),all('SELECT id,active FROM equipment_types'),all('SELECT id,active FROM job_functions')]);
 const steps=plan.steps.map(s=>{
  const raw=(b.steps as Row[]).find(x=>x?.key===s.step_key);if(!raw)throw new AppError('Etapas inválidas. Atualize a tela.');
  const label=`Etapa “${s.name}”`;
  const included=s.required?1:raw.included===false?0:1;
  const ps=instant(raw.plannedStart,`${label} · início`),pe=instant(raw.plannedEnd,`${label} · fim`);
  if(ps&&pe&&ms(pe)<=ms(ps))throw new AppError(`${label}: o fim deve ser depois do início.`);
  const loc=raw.locationId?idOf(raw.locationId,'Local da etapa'):null;
  const equipmentIds=included?idList(raw.equipmentIds,`${label} · equipamentos`,30):[];
  const operatorIds=included?idList(raw.operatorIds,`${label} · colaboradores`,60):[];
  for(const e of equipmentIds){const r=equipment.find(x=>x.id===e);if(!r||(!r.active&&!s.equipment_ids.includes(e)))throw new AppError(`${label}: equipamento inativo ou inexistente.`);}
  for(const o of operatorIds){const r=operators.find(x=>x.id===o);if(!r||(!r.active&&!s.operator_ids.includes(o)))throw new AppError(`${label}: colaborador inativo ou inexistente.`);}
  if(equipmentIds.length&&(!ps||!pe))throw new AppError(`${label}: informe início e fim antes de alocar equipamento identificado (é o intervalo que fica reservado).`);
  if(raw.needs!=null&&(!Array.isArray(raw.needs)||raw.needs.length>30))throw new AppError(`${label}: necessidades inválidas.`);
  const needs=((raw.needs||[]) as Row[]).map(n=>{
   const et=n?.equipmentTypeId?idOf(n.equipmentTypeId,'Tipo'):null,fn=n?.functionId?idOf(n.functionId,'Função'):null,q=Number(n?.quantity);
   if((et?1:0)+(fn?1:0)!==1||!Number.isInteger(q)||q<1||q>99)throw new AppError(`${label}: necessidade inválida.`);
   if(et&&!types.some(x=>x.id===et))throw new AppError(`${label}: tipo de equipamento inexistente.`);
   if(fn&&!functions.some(x=>x.id===fn))throw new AppError(`${label}: função inexistente.`);
   return {et,fn,q};
  });
  if(new Set(needs.map(n=>(n.et||'')+'|'+(n.fn||''))).size!==needs.length)throw new AppError(`${label}: necessidade repetida.`);
  return {s,included,ps,pe,loc,equipmentIds,operatorIds,needs,label};
 });
 if(steps.some(x=>x.loc)){const locs=await all('SELECT id,active FROM locations WHERE id = ANY(?::text[])',steps.map(x=>x.loc).filter(Boolean));for(const x of steps)if(x.loc){const l=locs.find(y=>y.id===x.loc);if(!l||(!l.active&&x.loc!==x.s.location_id))throw new AppError(`${x.label}: local inativo ou inexistente.`);}}
 // Confere a agenda antes de gravar, para devolver o motivo detalhado (o banco garante na gravação).
 for(const x of steps)for(const e of x.equipmentIds){
  const current=x.s.reservations.find((r:Row)=>r.equipment_id===e);
  if(current&&current.start_at===x.ps&&current.end_at===x.pe)continue;
  const tag=equipment.find(y=>y.id===e)!.tag;
  const block=await first('SELECT reason FROM equipment_impediments WHERE equipment_id=? AND released_at IS NULL LIMIT 1',e);
  if(block)throw new AppError(`Equipamento ${tag} bloqueado por impedimento técnico: ${block.reason}. Escolha outro equipamento.`,409);
  const busy=(await conflicts(a,e,x.ps!,x.pe!,{planId:plan.id,stepId:x.s.id}));
  if(busy.length)throw new AppError(`Equipamento ${tag} indisponível: ${busy[0].label}. O período solicitado, ${period(x.ps!,x.pe!)}, possui sobreposição.`,409);
 }
 const t=now();let reservationChanges=0;
 try{
  await db().tx(async tx=>{
   const changed=await tx.run('UPDATE plans SET description=?,org_id=?,requester_person_id=?,location_id=?,planned_start=?,planned_end=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND status=\'draft\'',description,org?.id||null,person?.id||null,location?.id||null,start,end,t,plan.id,plan.version);
   if(!changed)throw new AppError('Este rascunho foi alterado em outra tela. Atualize para continuar.',409);
   for(const x of steps){
    await tx.run('UPDATE plan_steps SET included=?,planned_start=?,planned_end=?,location_id=? WHERE id=?',x.included,x.ps,x.pe,x.loc,x.s.id);
    await tx.run('DELETE FROM plan_step_needs WHERE plan_step_id=?',x.s.id);
    for(const n of x.needs)await tx.run('INSERT INTO plan_step_needs(id,plan_id,plan_step_id,equipment_type_id,function_id,quantity) VALUES(?,?,?,?,?,?)',id(),plan.id,x.s.id,n.et,n.fn,n.q);
    await tx.run('DELETE FROM plan_step_people WHERE plan_step_id=?',x.s.id);
    for(const o of x.operatorIds)await tx.run('INSERT INTO plan_step_people(plan_id,plan_step_id,operator_id) VALUES(?,?,?)',plan.id,x.s.id,o);
    // Reservas: retira as que saíram, ajusta intervalo das que ficaram e cria as novas.
    for(const r of x.s.reservations as Row[]){
     if(!x.equipmentIds.includes(r.equipment_id)){await tx.run("UPDATE reservations SET status='liberada',released_at=?,release_reason=? WHERE id=?",t,'Retirada do rascunho',r.id);reservationChanges++;}
     else if(r.start_at!==x.ps||r.end_at!==x.pe){await tx.run('UPDATE reservations SET start_at=?,end_at=? WHERE id=?',x.ps,x.pe,r.id);reservationChanges++;}
    }
    for(const e of x.equipmentIds.filter(e=>!x.s.equipment_ids.includes(e))){await tx.run("INSERT INTO reservations(id,plan_id,plan_step_id,equipment_id,start_at,end_at,status,created_at) VALUES(?,?,?,?,?,?,'provisoria',?)",id(),plan.id,x.s.id,e,x.ps,x.pe,t);reservationChanges++;}
   }
   if(reservationChanges)await audit(tx,a,'Planejamento: reservas provisórias atualizadas',plan.id,{reservations:steps.flatMap(x=>x.equipmentIds.map(e=>({step:x.s.step_key,equipment:equipment.find(y=>y.id===e)?.tag,start:x.ps,end:x.pe})))});
  });
 }catch(e){
  // Corrida com outra reserva ou bloqueio: o banco recusou; a mensagem orienta a atualizar.
  const msg=(e as {message?:string}).message||'';
  if(/Equipamento reservado no período/.test(msg))throw new AppError('Outro planejamento reservou um dos equipamentos agora há pouco. Atualize a disponibilidade e escolha outro equipamento ou horário.',409);
  if(/impedimento técnico/.test(msg))throw new AppError('Um dos equipamentos acabou de ser bloqueado por impedimento técnico. Escolha outro equipamento.',409);
  throw e;
 }
 return {ok:true,version:plan.version+1,savedAt:t};
}
