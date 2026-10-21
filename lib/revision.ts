// Planejamento › Revisão de OS lançada: nova versão do planejamento com o mesmo número.
// A revisão começa como rascunho ligado à OS (cópia da versão vigente, com as mesmas reservas,
// sem disputar com elas) e, ao ser lançada, substitui planejamento, reservas e etapas da OS numa
// única transação. Etapas concluídas ou dispensadas não mudam; etapas iniciadas mantêm o início
// previsto e não saem da OS; etapas não iniciadas retiradas ficam registradas como dispensadas.
import {db,type Executor,type Row} from './db';
import {AppError,required} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {loadPlan,validation,revisionChanges,createRequirements,osNumber,type Plan,type PlanStep} from './planning';
import {checkClosure,event} from './operation';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const idOf=(value:unknown,label:string)=>required(value,label,100);
type Actor=Member&{org_scope:string[]};
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);
const REVISABLE=['programada','em_andamento'];
const FROZEN=['concluida','dispensada'];
const STATUS:Record<string,string>={concluida:'concluída',dispensada:'dispensada',em_execucao:'iniciada',pausada:'iniciada',bloqueada:'iniciada'};

/** Mesmo conteúdo de etapa (o que uma etapa concluída ou dispensada não pode ter mudado). */
const fingerprint=(s:PlanStep)=>JSON.stringify([s.included,s.planned_start,s.planned_end,s.location_id,[...s.equipment_ids].sort(),[...s.operator_ids].sort()]);

/** Abre a revisão (ou reabre a que já está em rascunho): cópia da versão vigente com as mesmas reservas. */
async function start(tx:Executor,a:Actor,workOrderId:string){
 const wo=await tx.first('SELECT * FROM work_orders WHERE id=? FOR UPDATE',workOrderId);
 if(!wo||!inScope(a,wo.org_id))throw new AppError('OS não encontrada ou fora do seu acesso.',404);
 if(!REVISABLE.includes(wo.status))throw new AppError('Só OS programadas ou em andamento podem ser revisadas.',409);
 const open=await tx.first("SELECT id,author_id,author_name FROM plans WHERE work_order_id=? AND status='draft'",wo.id);
 if(open){
  if(open.author_id===a.id||isManager(a))return {id:open.id,repeated:true,message:'A revisão em rascunho foi reaberta.'};
  throw new AppError(`${osNumber(wo.number)} já tem uma revisão em rascunho com ${open.author_name}. Ela precisa ser lançada ou descartada (o gestor pode descartá-la).`,409);
 }
 const base=(await loadPlan(wo.current_plan_id,tx))!;
 const pid=id(),t=now();
 await tx.run(`INSERT INTO plans(id,work_order_id,status,activity_type_id,flow_version_id,title,code,description,org_id,requester_person_id,location_id,planned_start,planned_end,author_id,author_name,created_at,updated_at,revision,base_plan_id)
  VALUES(?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,pid,wo.id,base.activity_type_id,base.flow_version_id,base.title??null,base.code??null,base.description,base.org_id,base.requester_person_id,base.location_id,base.planned_start,base.planned_end,a.id,a.name,t,t,wo.revision+1,base.id);
 for(const s of base.steps){
  const sid=id();
  await tx.run('INSERT INTO plan_steps(id,plan_id,step_key,position,name,description,required,included,default_minutes,depends_on,planned_start,planned_end,location_id) VALUES(?,?,?,?,?,?,?,?,?,?::text[],?,?,?)',sid,pid,s.step_key,s.position,s.name,s.description,s.required,s.included,s.default_minutes,s.depends_on,s.planned_start,s.planned_end,s.location_id);
  for(const n of s.needs)await tx.run('INSERT INTO plan_step_needs(id,plan_id,plan_step_id,equipment_type_id,function_id,material_id,quantity,amount,unit) VALUES(?,?,?,?,?,?,?,?,?)',id(),pid,sid,n.equipment_type_id,n.function_id,n.material_id,n.quantity,n.amount,n.unit);
  for(const o of s.operator_ids)await tx.run('INSERT INTO plan_step_people(plan_id,plan_step_id,operator_id) VALUES(?,?,?)',pid,sid,o);
  // Mesma reserva, agora também no rascunho: o banco a reconhece como transportada (não é compromisso novo).
  for(const r of s.reservations)await tx.run("INSERT INTO reservations(id,plan_id,plan_step_id,equipment_id,start_at,end_at,status,created_at) VALUES(?,?,?,?,?,?,'provisoria',?)",id(),pid,sid,r.equipment_id,r.start_at,r.end_at,t);
 }
 await audit(tx,a,'Planejamento: revisão da OS iniciada',wo.id,{number:wo.number,revision:wo.revision+1,draft:pid});
 return {id:pid,message:`Revisão ${wo.revision+1} da ${osNumber(wo.number)} aberta em rascunho. A OS segue valendo como está até a revisão ser lançada.`};
}

/** Lança a revisão: troca planejamento, reservas e etapas da OS de forma atômica. */
async function launch(a:Actor,b:Row){
 const plan=await loadPlan(idOf(b.id,'Planejamento'));
 if(!plan||!plan.work_order_id||!plan.base_plan_id||!inScope(a,plan.org_id))throw new AppError('Revisão não encontrada.',404);
 const key=required(b.launchKey,'Identificador do lançamento',100);
 if(plan.status!=='draft'){
  if(plan.launch_key===key)return {workOrderId:plan.work_order_id,number:plan.os_number,repeated:true,message:`${osNumber(plan.os_number)} já foi revisada.`};
  throw new AppError('Esta revisão já foi lançada ou descartada.',409);
 }
 if(plan.author_id!==a.id&&!isManager(a))throw new AppError('Somente o autor da revisão ou o gestor a lança.',403);
 if(b.version!==plan.version)throw new AppError('A revisão mudou desde a sua conferência. Revise novamente antes de lançar.',409);
 const reason=required(b.reason,'Motivo da revisão',1200);
 const check=await validation(plan);
 if(check.errors.length)throw new AppError(`Há ${check.errors.length} pendência(s) que impedem o lançamento da revisão. Revise o planejamento.`,409);
 try{
  return await db().tx(async tx=>{
   const wo=await tx.first('SELECT * FROM work_orders WHERE id=? FOR UPDATE',plan.work_order_id);
   if(!wo||!REVISABLE.includes(wo.status))throw new AppError('A OS não está mais programada nem em andamento: a revisão não pode ser lançada. Descarte o rascunho.',409);
   if(wo.current_plan_id!==plan.base_plan_id)throw new AppError('A OS foi revisada por outro lançamento. Descarte este rascunho e abra uma nova revisão.',409);
   const locked=await tx.first('SELECT status,version FROM plans WHERE id=? FOR UPDATE',plan.id);
   if(locked!.status!=='draft'||locked!.version!==plan.version)throw new AppError('A revisão mudou desde a sua conferência. Revise novamente antes de lançar.',409);
   const [base,draft]=await Promise.all([loadPlan(plan.base_plan_id,tx),loadPlan(plan.id,tx)]) as [Plan,Plan];
   const osSteps=await tx.all('SELECT o.*,p.name FROM os_steps o JOIN plan_steps p ON p.id=o.plan_step_id WHERE o.work_order_id=? FOR UPDATE OF o',wo.id);
   const n=draft.revision as number,t=now();
   // Confere a execução travada (pode ter andado enquanto a revisão era preparada).
   for(const d of draft.steps){
    const os=osSteps.find(o=>o.step_key===d.step_key),bs=base.steps.find(s=>s.step_key===d.step_key);
    if(!os||os.status==='nao_iniciada')continue;
    const label=`A etapa “${d.name}” foi ${STATUS[os.status]}`;
    if(FROZEN.includes(os.status)){if(!bs||fingerprint(d)!==fingerprint(bs))throw new AppError(`${label} depois que a revisão começou, e a revisão a altera. Descarte este rascunho e abra uma nova revisão.`,409);continue;}
    if(!d.included)throw new AppError(`${label}: ela não pode ser retirada da OS. Inclua-a de novo na revisão.`,409);
    if(d.planned_start!==bs?.planned_start)throw new AppError(`${label}: o início previsto dela não pode mudar. Volte o início para o da versão vigente.`,409);
   }
   const changes=await revisionChanges(base,draft,tx);
   if(!changes.length)throw new AppError('A revisão não muda nada em relação à versão vigente. Altere o planejamento ou descarte a revisão.',409);
   // Etapas concluídas ou dispensadas: reservas iguais às da versão vigente (término real já registrado).
   for(const d of draft.steps.filter(s=>FROZEN.includes(osSteps.find(o=>o.step_key===s.step_key)?.status))){
    const bs=base.steps.find(s=>s.step_key===d.step_key)!;
    for(const r of d.reservations){
     const br=bs.reservations.find((x:Row)=>x.equipment_id===r.equipment_id);
     if(!br)await tx.run("UPDATE reservations SET status='liberada',released_at=?,release_reason=? WHERE id=?",t,'Etapa encerrada na versão vigente',r.id);
     else if(br.start_at!==r.start_at||br.end_at!==r.end_at)await tx.run('UPDATE reservations SET start_at=?,end_at=? WHERE id=?',br.start_at,br.end_at,r.id);
    }
   }
   // Troca atômica: confirma as reservas da revisão (o banco revalida as novas) e libera as da versão vigente.
   await tx.run("UPDATE reservations SET status='confirmada' WHERE plan_id=? AND status='provisoria'",draft.id);
   await tx.run("UPDATE reservations SET status='liberada',released_at=?,release_reason=? WHERE plan_id=? AND status<>'liberada'",t,`Substituída pela revisão ${n}`,base.id);
   await tx.run("UPDATE plans SET status='superseded' WHERE id=?",base.id);
   await tx.run("UPDATE plans SET status='launched',launch_key=?,launched_at=?,launched_by=?,revision_reason=?,updated_at=?,version=version+1 WHERE id=?",key,t,a.id,reason,t,draft.id);
   // Etapas da OS: mesma identidade (eventos, intervalos e apontamentos continuam ligados), nova versão do plano.
   let dispensed=0,added=0;
   for(const d of draft.steps){
    const os=osSteps.find(o=>o.step_key===d.step_key);
    if(!os){if(d.included){await tx.run('INSERT INTO os_steps(id,work_order_id,step_key,plan_step_id) VALUES(?,?,?,?)',id(),wo.id,d.step_key,d.id);added++;}continue;}
    await tx.run('UPDATE os_steps SET plan_step_id=? WHERE id=?',d.id,os.id);
    if(os.status==='nao_iniciada'&&!d.included){
     const why=`Retirada na revisão ${n}: ${reason}`;
     await event(tx,a,wo,os.id,'dispensa',`revision:${draft.id}:${os.id}`,{reason:why,revision:n});
     await tx.run("UPDATE os_steps SET status='dispensada',dispensed_reason=? WHERE id=?",why,os.id);
     dispensed++;
    }
   }
   await tx.run('UPDATE work_orders SET current_plan_id=?,location_id=?,planned_start=?,planned_end=?,revision=?,title=?,code=?,version=version+1 WHERE id=?',draft.id,draft.location_id,draft.planned_start,draft.planned_end,n,draft.free?draft.title:null,draft.free?draft.code||null:null,wo.id);
   // Checklists previstos: novos para equipamentos incluídos; os de equipamento retirado deixam de valer (sem apagar).
   const required=await createRequirements(tx,wo.id,draft);
   const used=[...new Set(draft.steps.filter(s=>s.included).flatMap(s=>s.equipment_ids))];
   await tx.run('UPDATE checklist_requirements SET waived_at=NULL,waived_reason=NULL WHERE work_order_id=? AND waived_at IS NOT NULL AND equipment_id = ANY(?::text[])',wo.id,used);
   const waived=await tx.run(`UPDATE checklist_requirements r SET waived_at=?,waived_reason=? WHERE r.work_order_id=? AND r.waived_at IS NULL AND r.equipment_id IS NOT NULL AND NOT (r.equipment_id = ANY(?::text[]))
    AND NOT EXISTS (SELECT 1 FROM checklist_instances i WHERE i.requirement_id=r.id AND i.status='concluido')`,t,`Equipamento retirado na revisão ${n}`,wo.id,used);
   await audit(tx,a,'Planejamento: OS revisada',wo.id,{number:wo.number,revision:n,reason,changes,dispensed,added,checklists:{created:required,waived}});
   const closure=await checkClosure(tx,a,{...wo,current_plan_id:draft.id});
   return {workOrderId:wo.id,number:wo.number as number,revision:n,closure,message:`${osNumber(wo.number)} revisada (revisão ${n}). A Operação já vê a nova versão.`};
  });
 }catch(e){
  const msg=(e as {message?:string}).message||'';
  if(/Equipamento reservado no período/.test(msg))throw new AppError('Outro planejamento reservou um dos equipamentos novos da revisão. Atualize a disponibilidade e escolha outro equipamento ou horário.',409);
  if(/impedimento técnico/.test(msg))throw new AppError('Um dos equipamentos novos da revisão acabou de ser bloqueado por impedimento técnico. Escolha outro equipamento.',409);
  throw e;
 }
}

export async function revisionMutate(path:string,b:Row,member:Member){
 const a=await requireAny(member,['planejamento']);
 if(path==='planning/revision/start')return db().tx(tx=>start(tx,a,idOf(b.workOrderId,'OS')));
 if(path==='planning/revision/launch')return launch(a,b);
 throw new AppError('Ação não encontrada.',404);
}
