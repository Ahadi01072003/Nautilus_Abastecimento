// Operação: execução das OS por etapa (iniciar, bloquear, pausar, retomar, finalizar,
// dispensar), apontamentos, checklists na OS, NC crítica com bloqueio global do equipamento
// e encerramento automático. Cada comando trava a OS e a etapa; repetições não duplicam.
import {db,type Executor,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {loadPlan,instant,osNumber} from './planning';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const idOf=(value:unknown,label:string)=>required(value,label,100);
type Actor=Member&{org_scope:string[]};
const ACTIVE=['em_execucao','bloqueada','pausada'];
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);

/** Detalhe completo da OS para a tela da Operação (planejamento vigente + execução autoritativa). */
export async function orderDetail(member:Member,workOrderId:string){
 const a=await requireAny(member,['planejamento','acompanhamento','operacao']);
 const wo=await db().first('SELECT w.*,t.code activity_code,t.name activity_name FROM work_orders w JOIN activity_types t ON t.id=w.activity_type_id WHERE w.id=?',idOf(workOrderId,'OS'));
 if(!wo||!inScope(a,wo.org_id))throw new AppError('OS não encontrada ou fora do seu acesso.',404);
 const plan=await loadPlan(wo.current_plan_id);
 const [steps,intervals,occurrences,events,requirements,instances,answers,impediments,categories]=await Promise.all([
  db().all('SELECT * FROM os_steps WHERE work_order_id=?',wo.id),
  db().all('SELECT i.* FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id WHERE s.work_order_id=? ORDER BY i.start_at',wo.id),
  db().all('SELECT o.*,c.name category_name FROM occurrences o LEFT JOIN occurrence_categories c ON c.id=o.category_id WHERE o.work_order_id=? ORDER BY o.occurred_at DESC',wo.id),
  db().all('SELECT id,os_step_id,kind,occurred_at,registered_at,author_name,detail FROM execution_events WHERE work_order_id=? ORDER BY registered_at DESC LIMIT 300',wo.id),
  db().all('SELECT r.*,v.title,v.version,v.template_id,t.code FROM checklist_requirements r JOIN checklist_versions v ON v.id=r.version_id JOIN checklist_templates t ON t.id=v.template_id WHERE r.work_order_id=? ORDER BY r.moment,t.code',wo.id),
  db().all('SELECT i.*,v.title,v.version,v.moment,t.code FROM checklist_instances i JOIN checklist_versions v ON v.id=i.version_id JOIN checklist_templates t ON t.id=v.template_id WHERE i.work_order_id=? ORDER BY i.created_at',wo.id),
  db().all('SELECT a.* FROM checklist_answers a JOIN checklist_instances i ON i.id=a.instance_id WHERE i.work_order_id=?',wo.id),
  db().all('SELECT i.*,e.tag FROM equipment_impediments i JOIN equipment e ON e.id=i.equipment_id WHERE i.released_at IS NULL'),
  db().all('SELECT id,kind,name FROM occurrence_categories WHERE active=1 ORDER BY name'),
 ]);
 const versionIds=[...new Set(instances.map(i=>i.version_id))];
 const questions=versionIds.length?await db().all('SELECT * FROM checklist_questions WHERE version_id = ANY(?::text[]) ORDER BY position',versionIds):[];
 // Modelos complementares disponíveis: uso geral ou aplicáveis à atividade/equipamentos da OS.
 const used=[...new Set(plan!.steps.flatMap(s=>s.equipment_ids))];
 const complementary=await db().all(`SELECT t.id template_id,t.code,v.id version_id,v.title,v.moment,v.general_use FROM checklist_templates t JOIN checklist_versions v ON v.template_id=t.id AND v.version=t.current_version
  WHERE t.active=1 AND (v.general_use=1 OR EXISTS (SELECT 1 FROM checklist_links l LEFT JOIN equipment e ON e.id = ANY(?::text[]) WHERE l.version_id=v.id AND (l.activity_type_id=? OR l.equipment_id = ANY(?::text[]) OR l.equipment_type_id=e.type_id))) ORDER BY t.code`,used,wo.activity_type_id,used);
 const caps=a.capabilities||[];
 return {order:wo,plan,steps,intervals,occurrences,events,requirements,instances:instances.map(i=>({...i,answers:answers.filter(x=>x.instance_id===i.id)})),questions,complementary,categories,
  impediments:impediments.filter(i=>used.includes(i.equipment_id)),serverNow:now(),
  can:{execute:isManager(a)||caps.includes('operacao'),plan:isManager(a)||caps.includes('planejamento')}};
}

async function lockOrder(tx:Executor,a:Actor,workOrderId:string){
 const wo=await tx.first('SELECT * FROM work_orders WHERE id=? FOR UPDATE',workOrderId);
 if(!wo||!inScope(a,wo.org_id))throw new AppError('OS não encontrada ou fora do seu acesso.',404);
 if(wo.status==='cancelada')throw new AppError('OS cancelada: não aceita registros de execução.',409);
 return wo;
}
async function stepOf(tx:Executor,stepId:string){
 const s=await tx.first('SELECT o.*,p.name,p.depends_on,p.planned_start,p.planned_end,p.plan_id FROM os_steps o JOIN plan_steps p ON p.id=o.plan_step_id WHERE o.id=? FOR UPDATE OF o',stepId);
 if(!s)throw new AppError('Etapa não encontrada.',404);
 return s;
}
async function event(tx:Executor,a:Member,wo:Row,stepId:string|null,kind:string,key:string,detail:Row={},occurredAt?:string){
 const eid=id();
 await tx.run('INSERT INTO execution_events(id,work_order_id,os_step_id,kind,occurred_at,registered_at,author_id,author_name,operation_key,detail) VALUES(?,?,?,?,?,?,?,?,?,?::jsonb)',eid,wo.id,stepId,kind,occurredAt||now(),now(),a.id,a.name,key,JSON.stringify(detail));
 return eid;
}
async function openInterval(tx:Executor,stepId:string,kind:'ativo'|'interrompido',eventId:string,at:string){await tx.run('INSERT INTO step_intervals(id,os_step_id,kind,start_at,start_event_id) VALUES(?,?,?,?,?)',id(),stepId,kind,at,eventId);}
async function closeInterval(tx:Executor,stepId:string,eventId:string,at:string){await tx.run('UPDATE step_intervals SET end_at=?,end_event_id=? WHERE os_step_id=? AND end_at IS NULL',at,eventId,stepId);}
const stepEquipment=(tx:Executor,s:Row)=>tx.all("SELECT r.equipment_id,e.tag FROM reservations r JOIN equipment e ON e.id=r.equipment_id WHERE r.plan_step_id=? AND r.status<>'liberada'",s.plan_step_id);
const openBlocks=(tx:Executor,stepId:string)=>tx.all("SELECT * FROM occurrences WHERE os_step_id=? AND blocking=1 AND status='aberto'",stepId);

/** Interrompe a etapa ativa (bloqueio/NC): fecha o intervalo ativo e abre o interrompido. */
async function interrupt(tx:Executor,s:Row,eventId:string,at:string){
 if(s.status==='em_execucao'){await closeInterval(tx,s.id,eventId,at);await openInterval(tx,s.id,'interrompido',eventId,at);}
 if(ACTIVE.includes(s.status))await tx.run("UPDATE os_steps SET status='bloqueada' WHERE id=?",s.id);
}

/** Encerra a OS quando todas as etapas aplicáveis e obrigações estão atendidas (uma única vez). */
async function checkClosure(tx:Executor,a:Member,wo:Row){
 const steps=await tx.all('SELECT status,actual_end FROM os_steps WHERE work_order_id=?',wo.id);
 if(!steps.length||steps.some(s=>!['concluida','dispensada'].includes(s.status)))return null;
 if(await tx.first('SELECT 1 FROM step_intervals i JOIN os_steps s ON s.id=i.os_step_id WHERE s.work_order_id=? AND i.end_at IS NULL',wo.id))return null;
 const pending=await tx.all("SELECT r.id,v.title FROM checklist_requirements r JOIN checklist_versions v ON v.id=r.version_id WHERE r.work_order_id=? AND r.mandatory=1 AND NOT EXISTS (SELECT 1 FROM checklist_instances i WHERE i.requirement_id=r.id AND i.status='concluido')",wo.id);
 const physicalEnd=steps.map(s=>s.actual_end).filter(Boolean).sort().pop()||null;
 if(pending.length){
  if(wo.status!=='encerramento_pendente'){
   await tx.run("UPDATE work_orders SET status='encerramento_pendente',actual_end=coalesce(?,actual_end),version=version+1 WHERE id=?",physicalEnd,wo.id);
   await event(tx,a,wo,null,'encerramento_pendente','pending:'+wo.id+':'+Date.now(),{pending:pending.map(p=>p.title)});
  }
  return 'encerramento_pendente';
 }
 // Chave fixa: o encerramento acontece uma vez, mesmo com comandos concorrentes ou repetidos.
 if(await tx.first('SELECT 1 FROM execution_events WHERE operation_key=?','close:'+wo.id))return 'concluida';
 await tx.run("UPDATE work_orders SET status='concluida',actual_end=coalesce(?,actual_end),closed_at=?,version=version+1 WHERE id=?",physicalEnd,now(),wo.id);
 await event(tx,a,wo,null,'encerramento','close:'+wo.id,{physicalEnd});
 await audit(tx,a,'Operação: OS encerrada',wo.id,{number:wo.number,physicalEnd});
 return 'concluida';
}

/** Pendências para iniciar a etapa (dependências, checklists, recursos, bloqueios). */
async function startBlockers(tx:Executor,wo:Row,s:Row){
 const out:string[]=[];
 const siblings=await tx.all('SELECT o.step_key,o.status,p.name FROM os_steps o JOIN plan_steps p ON p.id=o.plan_step_id WHERE o.work_order_id=?',wo.id);
 for(const d of s.depends_on as string[]){const dep=siblings.find(x=>x.step_key===d);if(dep&&!['concluida','dispensada'].includes(dep.status))out.push(`Aguardando a conclusão de “${dep.name}”.`);}
 const equipment=await stepEquipment(tx,s);
 const reqs=await tx.all(`SELECT r.*,v.title FROM checklist_requirements r JOIN checklist_versions v ON v.id=r.version_id WHERE r.work_order_id=? AND r.mandatory=1 AND ((r.moment='pre_atividade' AND r.equipment_id IS NULL) OR (r.moment='pre_uso' AND r.equipment_id = ANY(?::text[])))
  AND NOT EXISTS (SELECT 1 FROM checklist_instances i WHERE i.requirement_id=r.id AND i.status='concluido')`,wo.id,equipment.map(e=>e.equipment_id));
 for(const r of reqs)out.push(`Checklist obrigatório pendente: ${r.title}${r.equipment_id?' ('+equipment.find(e=>e.equipment_id===r.equipment_id)?.tag+')':''}.`);
 for(const e of equipment){
  await tx.run('SELECT 1 FROM equipment WHERE id=? FOR UPDATE',e.equipment_id);
  const imp=await tx.first('SELECT reason,kind FROM equipment_impediments WHERE equipment_id=? AND released_at IS NULL LIMIT 1',e.equipment_id);
  if(imp)out.push(`Equipamento ${e.tag} bloqueado (${imp.kind==='nc_critica'?'NC crítica':'impedimento técnico'}: ${imp.reason}). Aguarda liberação técnica ou substituição pelo Planejamento.`);
  const busy=await tx.first(`SELECT w.number,p.name FROM reservations r JOIN os_steps o ON o.plan_step_id=r.plan_step_id JOIN plan_steps p ON p.id=o.plan_step_id JOIN work_orders w ON w.id=o.work_order_id
   WHERE r.equipment_id=? AND r.status<>'liberada' AND o.status = ANY(?::text[]) AND o.id<>? LIMIT 1`,e.equipment_id,ACTIVE,s.id);
  if(busy)out.push(`Equipamento ${e.tag} ainda em uso na etapa “${busy.name}” da ${osNumber(busy.number)}.`);
 }
 if((await openBlocks(tx,s.id)).length)out.push('Há bloqueio aberto registrado nesta etapa.');
 return out;
}

export async function startCheck(member:Member,stepId:string){
 const a=await requireAny(member,['operacao','planejamento','acompanhamento']);
 return db().tx(async tx=>{const s=await stepOf(tx,idOf(stepId,'Etapa'));const wo=await tx.first('SELECT * FROM work_orders WHERE id=?',s.work_order_id);if(!inScope(a,wo!.org_id))throw new AppError('Etapa fora do seu acesso.',404);return {blockers:s.status==='nao_iniciada'?await startBlockers(tx,wo!,s):[]};});
}

export async function operationMutate(path:string,b:Row,member:Member){
 if(path==='ops/dispense')return dispense(b,await requireAny(member,['planejamento']));
 const a=await requireAny(member,['operacao']);
 const key=required(b.operationKey,'Identificador da operação',100);
 const repeated=async()=>(await db().first('SELECT 1 FROM execution_events WHERE operation_key=?',key))||(await db().first('SELECT 1 FROM occurrences WHERE operation_key=?',key))||(await db().first('SELECT 1 FROM checklist_instances WHERE operation_key=?',key));
 if(path!=='ops/checklist/answer'&&path!=='ops/checklist/complete'&&path!=='ops/resolve'&&await repeated())return {ok:true,repeated:true};
 const t=now();

 if(path.startsWith('ops/checklist/'))return checklistMutate(path,b,a,key);

 if(path==='ops/resolve'){
  return db().tx(async tx=>{
   const o=await tx.first('SELECT * FROM occurrences WHERE id=? FOR UPDATE',idOf(b.id,'Apontamento'));
   if(!o)throw new AppError('Apontamento não encontrado.',404);
   await lockOrder(tx,a,o.work_order_id);
   if(o.status==='resolvido')return {ok:true,repeated:true};
   const resolution=required(b.resolution,'Como foi resolvido',1200);
   await tx.run("UPDATE occurrences SET status='resolvido',resolved_at=?,resolved_by=?,resolved_by_name=?,resolution=? WHERE id=?",t,a.id,a.name,resolution,o.id);
   await audit(tx,a,'Operação: apontamento resolvido',o.work_order_id,{occurrence:o.id,resolution});
   return {ok:true,message:o.impediment_id?'Bloqueio local resolvido. O equipamento continua bloqueado até a liberação técnica.':o.blocking?'Bloqueio resolvido. Use “Retomar” quando a etapa puder continuar.':'Apontamento resolvido.'};
  });
 }

 const stepId=idOf(b.stepId,'Etapa');
 return db().tx(async tx=>{
  const pre=await tx.first('SELECT work_order_id FROM os_steps WHERE id=?',stepId);if(!pre)throw new AppError('Etapa não encontrada.',404);
  const wo=await lockOrder(tx,a,pre.work_order_id);
  const s=await stepOf(tx,stepId);
  const label=`Etapa “${s.name}”`;

  if(path==='ops/start'){
   if(s.status!=='nao_iniciada')throw new AppError(`${label} já foi iniciada ou encerrada. Atualize a tela.`,409);
   if(!['programada','em_andamento'].includes(wo.status))throw new AppError('Esta OS não aceita novos inícios.',409);
   const blockers=await startBlockers(tx,wo,s);
   if(blockers.length)throw new AppError(`Não é possível iniciar: ${blockers.join(' ')}`,409);
   const ev=await event(tx,a,wo,s.id,'inicio',key,{early:s.planned_start&&t<s.planned_start?Math.round((Date.parse(s.planned_start)-Date.parse(t))/60000):0});
   await openInterval(tx,s.id,'ativo',ev,t);
   await tx.run("UPDATE os_steps SET status='em_execucao',actual_start=? WHERE id=?",t,s.id);
   if(wo.status==='programada')await tx.run("UPDATE work_orders SET status='em_andamento',actual_start=?,version=version+1 WHERE id=?",t,wo.id);
   await audit(tx,a,'Operação: etapa iniciada',wo.id,{number:wo.number,step:s.step_key});
   return {ok:true,message:`${label} iniciada.`};
  }

  if(path==='ops/block'||path==='ops/note'){
   const kind=path==='ops/block'?'bloqueio':b.kind;
   if(!['ocorrencia','impacto','bloqueio'].includes(kind))throw new AppError('Escolha o tipo de apontamento.');
   const blocking=kind==='bloqueio'||(kind==='impacto'&&b.blocking===true)?1:0;
   const description=required(b.description,'Descrição',2000);
   const category=b.categoryId?await tx.first('SELECT * FROM occurrence_categories WHERE id=? AND active=1',idOf(b.categoryId,'Categoria')):null;
   if(b.categoryId&&!category)throw new AppError('Categoria inativa ou inexistente.');
   if(category&&category.kind!==kind)throw new AppError('A categoria escolhida é de outro tipo de apontamento.');
   if(blocking&&!category)throw new AppError('Escolha a categoria do bloqueio.');
   const occurred=instant(b.occurredAt,'Momento ocorrido')||t;
   if(Date.parse(occurred)>Date.now()+60000)throw new AppError('O momento ocorrido não pode estar no futuro.');
   if(blocking&&!['nao_iniciada','em_execucao','pausada','bloqueada'].includes(s.status))throw new AppError(`${label} já foi encerrada: não aceita bloqueio.`,409);
   const late=['concluida','dispensada'].includes(s.status)?1:0;
   const severity=kind==='impacto'?(['baixa','media','alta'].includes(b.severity)?b.severity:'media'):null;
   const impactStart=kind==='impacto'?instant(b.impactStart,'Início do impacto'):null,impactEnd=kind==='impacto'?instant(b.impactEnd,'Fim do impacto'):null;
   if(impactStart&&impactEnd&&impactEnd<=impactStart)throw new AppError('O fim do impacto deve ser depois do início.');
   const equipmentId=b.equipmentId?idOf(b.equipmentId,'Equipamento'):null;
   const oid=id();
   await tx.run('INSERT INTO occurrences(id,work_order_id,os_step_id,kind,blocking,category_id,description,severity,equipment_id,impact_start,impact_end,occurred_at,registered_at,late,author_id,author_name,operation_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',oid,wo.id,s.id,kind,blocking,category?.id||null,description,severity,equipmentId,impactStart,impactEnd,occurred,t,late,a.id,a.name,key);
   if(blocking){
    const ev=await event(tx,a,wo,s.id,'bloqueio','block:'+key,{occurrence:oid,category:category?.name});
    await interrupt(tx,s,ev,t);
   }
   await audit(tx,a,`Operação: ${kind==='bloqueio'?'bloqueio registrado':kind==='impacto'?(blocking?'impacto com bloqueio registrado':'impacto registrado'):'ocorrência registrada'}`,wo.id,{number:wo.number,step:s.step_key,occurrence:oid,late:!!late});
   return {ok:true,id:oid,message:blocking?`${label} bloqueada. O tempo efetivo parou; o prazo continua correndo.`:'Apontamento registrado.'};
  }

  if(path==='ops/pause'){
   if(s.status!=='em_execucao')throw new AppError(`${label} não está em execução.`,409);
   const reason=required(b.reason,'Motivo da pausa',1200);
   const ev=await event(tx,a,wo,s.id,'pausa',key,{reason});
   await closeInterval(tx,s.id,ev,t);await openInterval(tx,s.id,'interrompido',ev,t);
   await tx.run("UPDATE os_steps SET status='pausada' WHERE id=?",s.id);
   await audit(tx,a,'Operação: etapa pausada',wo.id,{number:wo.number,step:s.step_key,reason});
   return {ok:true,message:`${label} pausada.`};
  }

  if(path==='ops/resume'){
   if(!['pausada','bloqueada'].includes(s.status))throw new AppError(`${label} não está pausada nem bloqueada.`,409);
   const blocks=await openBlocks(tx,s.id);
   if(blocks.length)throw new AppError(`Resolva antes ${blocks.length===1?'o bloqueio aberto':`os ${blocks.length} bloqueios abertos`} desta etapa.`,409);
   for(const e of await stepEquipment(tx,s)){
    await tx.run('SELECT 1 FROM equipment WHERE id=? FOR UPDATE',e.equipment_id);
    const imp=await tx.first('SELECT reason FROM equipment_impediments WHERE equipment_id=? AND released_at IS NULL LIMIT 1',e.equipment_id);
    if(imp)throw new AppError(`Equipamento ${e.tag} continua bloqueado (${imp.reason}). Só a liberação técnica ou a substituição pelo Planejamento permitem retomar.`,409);
   }
   const ev=await event(tx,a,wo,s.id,'retomada',key);
   await closeInterval(tx,s.id,ev,t);await openInterval(tx,s.id,'ativo',ev,t);
   await tx.run("UPDATE os_steps SET status='em_execucao' WHERE id=?",s.id);
   await audit(tx,a,'Operação: etapa retomada',wo.id,{number:wo.number,step:s.step_key});
   return {ok:true,message:`${label} retomada.`};
  }

  if(path==='ops/finish'){
   if(!ACTIVE.includes(s.status))throw new AppError(`${label} não está em andamento.`,409);
   const blocks=await openBlocks(tx,s.id);
   if(s.status==='bloqueada'||blocks.length){
    const resolution=text(b.resolution,1200);
    if(!resolution)throw new AppError('Etapa bloqueada: informe como o impedimento foi resolvido ou como ocorreu a interrupção final.');
    for(const o of blocks)await tx.run("UPDATE occurrences SET status='resolvido',resolved_at=?,resolved_by=?,resolved_by_name=?,resolution=? WHERE id=?",t,a.id,a.name,resolution,o.id);
   }
   const ev=await event(tx,a,wo,s.id,'termino',key,{resolution:b.resolution||null});
   await closeInterval(tx,s.id,ev,t);
   await tx.run("UPDATE os_steps SET status='concluida',actual_end=? WHERE id=?",t,s.id);
   // O equipamento fica livre a partir do término real (se antes do previsto).
   await tx.run("UPDATE reservations SET end_at=? WHERE plan_step_id=? AND status='confirmada' AND end_at::timestamptz > ?::timestamptz AND start_at::timestamptz < ?::timestamptz",t,s.plan_step_id,t,t);
   await audit(tx,a,'Operação: etapa concluída',wo.id,{number:wo.number,step:s.step_key});
   const closed=await checkClosure(tx,a,wo);
   return {ok:true,closure:closed,message:closed==='concluida'?`${label} concluída. ${osNumber(wo.number)} encerrada automaticamente.`:closed==='encerramento_pendente'?`${label} concluída. A OS ficou em encerramento pendente: há checklist obrigatório a concluir.`:`${label} concluída.`};
  }
  throw new AppError('Ação não encontrada.',404);
 });
}

/** Dispensa formal de etapa não iniciada (Planejamento), com motivo. */
async function dispense(b:Row,a:Actor){
 const reason=required(b.reason,'Motivo da dispensa',1200);
 return db().tx(async tx=>{
  const pre=await tx.first('SELECT work_order_id FROM os_steps WHERE id=?',idOf(b.stepId,'Etapa'));if(!pre)throw new AppError('Etapa não encontrada.',404);
  const wo=await lockOrder(tx,a,pre.work_order_id);
  const s=await stepOf(tx,b.stepId);
  if(s.status==='dispensada')return {ok:true,repeated:true};
  if(s.status!=='nao_iniciada')throw new AppError('Só etapas não iniciadas podem ser dispensadas.',409);
  const ev=await event(tx,a,wo,s.id,'dispensa','dispense:'+s.id,{reason});void ev;
  await tx.run("UPDATE os_steps SET status='dispensada',dispensed_reason=? WHERE id=?",reason,s.id);
  await tx.run("UPDATE reservations SET status='liberada',released_at=?,release_reason='Etapa dispensada' WHERE plan_step_id=? AND status<>'liberada'",now(),s.plan_step_id);
  await audit(tx,a,'Planejamento: etapa dispensada',wo.id,{number:wo.number,step:s.step_key,reason});
  const closed=await checkClosure(tx,a,wo);
  return {ok:true,closure:closed,message:`Etapa “${s.name}” dispensada.`};
 });
}

async function checklistMutate(path:string,b:Row,a:Actor,key:string){
 const t=now();
 if(path==='ops/checklist/start'){
  return db().tx(async tx=>{
   const wo=await lockOrder(tx,a,idOf(b.workOrderId,'OS'));
   if(b.requirementId){
    const r=await tx.first('SELECT * FROM checklist_requirements WHERE id=? AND work_order_id=?',idOf(b.requirementId,'Checklist previsto'),wo.id);
    if(!r)throw new AppError('Checklist previsto não encontrado.',404);
    const existing=await tx.first('SELECT id FROM checklist_instances WHERE requirement_id=?',r.id);
    if(existing)return {id:existing.id,repeated:true};
    const iid=id();
    await tx.run('INSERT INTO checklist_instances(id,work_order_id,requirement_id,version_id,equipment_id,created_at,created_by,created_by_name,operation_key) VALUES(?,?,?,?,?,?,?,?,?)',iid,wo.id,r.id,r.version_id,r.equipment_id,t,a.id,a.name,key);
    await audit(tx,a,'Operação: checklist iniciado',wo.id,{number:wo.number,instance:iid});
    return {id:iid};
   }
   // Complementar: versão vigente de modelo ativo aplicável à OS (uso geral, atividade ou equipamento).
   const v=await tx.first('SELECT v.* FROM checklist_templates t JOIN checklist_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE t.id=? AND t.active=1',idOf(b.templateId,'Checklist'));
   if(!v)throw new AppError('Checklist inativo ou inexistente.',404);
   const used=(await tx.all("SELECT DISTINCT r.equipment_id FROM reservations r JOIN plans p ON p.id=r.plan_id WHERE p.id=? AND r.status<>'liberada'",wo.current_plan_id)).map(r=>r.equipment_id as string);
   const equipmentId=b.equipmentId?idOf(b.equipmentId,'Equipamento'):null;
   if(equipmentId&&!used.includes(equipmentId))throw new AppError('Escolha um equipamento alocado nesta OS.');
   const links=await tx.all('SELECT l.*,e.type_id FROM checklist_links l LEFT JOIN equipment e ON e.id = ANY(?::text[]) WHERE l.version_id=?',used,v.id);
   const ok=v.general_use||links.some(l=>l.activity_type_id===wo.activity_type_id||(l.equipment_id&&used.includes(l.equipment_id))||(l.equipment_type_id&&l.equipment_type_id===l.type_id));
   if(!ok)throw new AppError('Este checklist não se aplica a esta OS.');
   const stepId=b.stepId?idOf(b.stepId,'Etapa'):null;
   if(stepId&&!await tx.first('SELECT 1 FROM os_steps WHERE id=? AND work_order_id=?',stepId,wo.id))throw new AppError('Etapa de outra OS.',400);
   const iid=id();
   await tx.run('INSERT INTO checklist_instances(id,work_order_id,version_id,equipment_id,os_step_id,created_at,created_by,created_by_name,operation_key) VALUES(?,?,?,?,?,?,?,?,?)',iid,wo.id,v.id,equipmentId,stepId,t,a.id,a.name,key);
   await audit(tx,a,'Operação: checklist complementar iniciado',wo.id,{number:wo.number,instance:iid});
   return {id:iid};
  });
 }
 return db().tx(async tx=>{
  const inst=await tx.first('SELECT * FROM checklist_instances WHERE id=? FOR UPDATE',idOf(b.instanceId,'Checklist'));
  if(!inst)throw new AppError('Checklist não encontrado.',404);
  const wo=await lockOrder(tx,a,inst.work_order_id);
  if(inst.status==='concluido')throw new AppError('Checklist concluído: as respostas não podem mais ser alteradas.',409);
  const questions=await tx.all('SELECT * FROM checklist_questions WHERE version_id=? ORDER BY position',inst.version_id);

  if(path==='ops/checklist/answer'){
   const q=questions.find(x=>x.id===b.questionId);if(!q)throw new AppError('Pergunta não pertence a este checklist.',400);
   if(!['C','NC','NA'].includes(b.answer))throw new AppError('Responda C, NC ou N/A.');
   if(b.answer==='NA'&&!q.allow_na)throw new AppError('Esta pergunta não aceita N/A.');
   const note=text(b.note,1200);
   await tx.run('INSERT INTO checklist_answers(instance_id,version_id,question_id,answer,note,answered_at,answered_by,answered_by_name) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (instance_id,question_id) DO UPDATE SET answer=excluded.answer,note=excluded.note,answered_at=excluded.answered_at,answered_by=excluded.answered_by,answered_by_name=excluded.answered_by_name',inst.id,inst.version_id,q.id,b.answer,note,t,a.id,a.name);
   let message='Resposta salva.';
   if(b.answer==='NC'&&q.critical){
    if(q.target==='equipamento'){
     // NC crítica de equipamento: bloqueio global imediato, antes de concluir o checklist.
     const equipmentId=inst.equipment_id||(b.equipmentId?idOf(b.equipmentId,'Equipamento'):null);
     if(!equipmentId)throw new AppError('Informe qual equipamento apresentou a não conformidade crítica.');
     const e=await tx.first("SELECT e.id,e.tag FROM equipment e JOIN reservations r ON r.equipment_id=e.id JOIN plans p ON p.id=r.plan_id WHERE e.id=? AND p.id=? AND r.status<>'liberada' LIMIT 1",equipmentId,wo.current_plan_id)||(inst.equipment_id?await tx.first('SELECT id,tag FROM equipment WHERE id=?',equipmentId):null);
     if(!e)throw new AppError('Escolha um equipamento alocado nesta OS.');
     const source=`checklist:${inst.id}:${q.id}`;
     if(!await tx.first('SELECT 1 FROM equipment_impediments WHERE source_ref=? AND released_at IS NULL',source)){
      const imp=id();
      await tx.run("INSERT INTO equipment_impediments(id,equipment_id,kind,reason,source_ref,opened_at,opened_by,opened_by_name) VALUES(?,?,'nc_critica',?,?,?,?,?)",imp,e.id,`NC crítica: “${q.text}” (${osNumber(wo.number)})`,source,t,a.id,a.name);
      await event(tx,a,wo,inst.os_step_id,'nc_critica','nc:'+source,{equipment:e.tag,question:q.text,impediment:imp});
      await audit(tx,a,'Condição técnica: NC crítica',e.id,{tag:e.tag,question:q.text,workOrder:wo.number,impediment:imp});
      // Etapas em andamento que usam o equipamento (em qualquer OS) são interrompidas com o motivo.
      const affected=await tx.all(`SELECT o.*,w.id wid,w.number FROM os_steps o JOIN reservations r ON r.plan_step_id=o.plan_step_id AND r.status<>'liberada' JOIN work_orders w ON w.id=o.work_order_id
       WHERE r.equipment_id=? AND o.status = ANY(?::text[]) FOR UPDATE OF o`,e.id,ACTIVE);
      for(const s of affected){
       const ev=await event(tx,a,{id:s.wid},s.id,'interrupcao_tecnica',`ncstop:${imp}:${s.id}`,{equipment:e.tag,impediment:imp});
       await tx.run("INSERT INTO occurrences(id,work_order_id,os_step_id,kind,blocking,description,equipment_id,impediment_id,occurred_at,registered_at,author_id,author_name,operation_key) VALUES(?,?,?,'bloqueio',1,?,?,?,?,?,?,?,?)",id(),s.wid,s.id,`Equipamento ${e.tag} bloqueado por NC crítica: “${q.text}”.`,e.id,imp,t,t,a.id,a.name,`ncocc:${imp}:${s.id}`);
       await interrupt(tx,s,ev,t);
      }
      message=`Equipamento ${e.tag} bloqueado em todo o sistema por NC crítica.${affected.length?` ${affected.length} etapa(s) em andamento foram interrompidas.`:''} A liberação é feita pela liberação técnica.`;
     }else message=`Equipamento ${e.tag} já está bloqueado por esta NC crítica.`;
    }else{
     // NC crítica da atividade: impedimento local na etapa informada.
     const stepId=inst.os_step_id||(b.stepId?idOf(b.stepId,'Etapa'):null);
     if(!stepId)throw new AppError('Informe qual etapa fica impedida por esta não conformidade crítica.');
     const s=await tx.first('SELECT * FROM os_steps WHERE id=? AND work_order_id=? FOR UPDATE',stepId,wo.id);
     if(!s)throw new AppError('Etapa de outra OS.',400);
     const okey=`ncact:${inst.id}:${q.id}`;
     if(!await tx.first('SELECT 1 FROM occurrences WHERE operation_key=?',okey)&&!['concluida','dispensada'].includes(s.status)){
      const ev=await event(tx,a,wo,s.id,'bloqueio','ev'+okey,{question:q.text});
      await tx.run("INSERT INTO occurrences(id,work_order_id,os_step_id,kind,blocking,description,occurred_at,registered_at,author_id,author_name,operation_key) VALUES(?,?,?,'bloqueio',1,?,?,?,?,?,?)",id(),wo.id,s.id,`NC crítica no checklist: “${q.text}”.`,t,t,a.id,a.name,okey);
      await interrupt(tx,s,ev,t);
      message='Etapa impedida pela NC crítica da atividade. Resolva o bloqueio para retomar.';
     }
    }
   }
   return {ok:true,message};
  }

  if(path==='ops/checklist/complete'){
   const answers=await tx.all('SELECT * FROM checklist_answers WHERE instance_id=?',inst.id);
   const missing:string[]=[];
   for(const q of questions){
    const ans=answers.find(x=>x.question_id===q.id);
    if(!ans){if(q.required)missing.push(`${q.position}. sem resposta`);continue;}
    if((q.note_on as string[]).includes(ans.answer)&&!ans.note.trim())missing.push(`${q.position}. observação obrigatória para ${ans.answer==='NA'?'N/A':ans.answer}`);
   }
   if(missing.length)throw new AppError(`Pendências: ${missing.join('; ')}.`,409);
   await tx.run("UPDATE checklist_instances SET status='concluido',completed_at=?,completed_by=?,completed_by_name=? WHERE id=?",t,a.id,a.name,inst.id);
   const nc=answers.filter(x=>x.answer==='NC').length;
   await audit(tx,a,'Operação: checklist concluído',wo.id,{number:wo.number,instance:inst.id,nc});
   const closed=wo.status==='encerramento_pendente'?await checkClosure(tx,a,wo):null;
   return {ok:true,closure:closed,message:closed==='concluida'?`Checklist concluído. ${osNumber(wo.number)} encerrada automaticamente.`:`Checklist concluído${nc?` com ${nc} NC`:''}.`};
  }
  throw new AppError('Ação não encontrada.',404);
 });
}
