// Operação › Registrar atividade realizada: atividade feita sem planejamento prévio (urgência).
// Usa o mesmo rascunho e formulário da OS sem fluxo; ao registrar, cria a OS já executada com o
// início e o fim reais (eventos, período de trabalho e término), confirma as reservas do período,
// aplica os checklists previstos e encerra a OS (ou deixa em encerramento pendente, se faltar checklist).
import {db,type Row} from './db';
import {AppError,required} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {loadPlan,validation,createRequirements,osNumber} from './planning';
import {checkClosure,event} from './operation';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const idOf=(value:unknown,label:string)=>required(value,label,100);
type Actor=Member&{capabilities:string[],org_scope:string[]};
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);
const tag=(a:Actor)=>isManager(a)||a.capabilities.includes('planejamento')?'Planejamento':'Operação';

export async function realizeActivity(b:Row,member:Member){
 const a=await requireAny(member,['planejamento','operacao']) as Actor;
 const plan=await loadPlan(idOf(b.id,'Registro'));
 if(!plan||plan.mode!=='realizada'||(plan.author_id!==a.id&&!isManager(a)))throw new AppError('Registro de atividade não encontrado.',404);
 const key=required(b.launchKey,'Identificador do registro',100);
 if(plan.status!=='draft'){
  if(plan.launch_key===key&&plan.work_order_id){const w=await db().first('SELECT id,number FROM work_orders WHERE id=?',plan.work_order_id);return {workOrderId:w!.id,number:w!.number,repeated:true,message:`${osNumber(w!.number)} já foi registrada.`};}
  throw new AppError('Este registro já foi concluído ou descartado.',409);
 }
 if(plan.org_id&&!inScope(a,plan.org_id))throw new AppError('Organização fora do seu acesso.',403);
 if(b.version!==plan.version)throw new AppError('O registro mudou desde a sua conferência. Confira de novo antes de registrar.',409);
 const check=await validation(plan);
 if(check.errors.length)throw new AppError(`Há ${check.errors.length} pendência(s) no registro. Confira o formulário.`,409);
 try{
  return await db().tx(async tx=>{
   const locked=await tx.first('SELECT status,version FROM plans WHERE id=? FOR UPDATE',plan.id);
   if(locked!.status!=='draft'||locked!.version!==plan.version)throw new AppError('O registro mudou desde a sua conferência. Confira de novo antes de registrar.',409);
   const wid=id(),t=now(),start=plan.planned_start as string,end=plan.planned_end as string;
   const w=await tx.first(`INSERT INTO work_orders(id,current_plan_id,original_plan_id,activity_type_id,org_id,location_id,planned_start,planned_end,actual_start,launched_at,launched_by,launched_by_name,title,code,origin,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'realizada','em_andamento') RETURNING number`,wid,plan.id,plan.id,plan.activity_type_id,plan.org_id,plan.location_id,start,end,start,t,a.id,a.name,plan.title,plan.code||null);
   await tx.run("UPDATE plans SET status='launched',work_order_id=?,launch_key=?,launched_at=?,launched_by=?,updated_at=?,version=version+1 WHERE id=?",wid,key,t,a.id,t,plan.id);
   await tx.run("UPDATE reservations SET status='confirmada' WHERE plan_id=? AND status='provisoria'",plan.id);
   // Execução já ocorrida: início e término nas datas reais, com o período de trabalho entre eles.
   const step=plan.steps.find(s=>s.included)!;
   const sid=id();
   await tx.run("INSERT INTO os_steps(id,work_order_id,step_key,plan_step_id,status,actual_start,actual_end) VALUES(?,?,?,?,'concluida',?,?)",sid,wid,step.step_key,step.id,start,end);
   const wo={id:wid,number:w!.number,status:'em_andamento'};
   const e1=await event(tx,a,wo,sid,'inicio',`realize:start:${wid}`,{late:true,source:'atividade realizada'},start);
   const e2=await event(tx,a,wo,sid,'termino',`realize:end:${wid}`,{late:true,source:'atividade realizada'},end);
   await tx.run("INSERT INTO step_intervals(id,os_step_id,kind,start_at,end_at,start_event_id,end_event_id) VALUES(?,?,'ativo',?,?,?,?)",id(),sid,start,end,e1,e2);
   const required=await createRequirements(tx,wid,plan);
   await audit(tx,a,`${tag(a)}: atividade realizada registrada`,wid,{number:w!.number,code:plan.code||undefined,title:plan.title,start,end,reservations:plan.steps.flatMap(s=>s.equipment_ids).length,checklists:required});
   const closure=await checkClosure(tx,a,wo);
   return {workOrderId:wid,number:w!.number as number,closure,message:closure==='concluida'?`${osNumber(w!.number)} registrada e encerrada.`:`${osNumber(w!.number)} registrada. Falta preencher checklist obrigatório para encerrar (em Apontamentos).`};
  });
 }catch(e){
  const msg=(e as {message?:string}).message||'';
  if(/Equipamento reservado no período/.test(msg))throw new AppError('Um dos equipamentos já estava reservado para outra atividade nesse período. Confira o equipamento ou o horário.',409);
  if(/impedimento técnico/.test(msg))throw new AppError('Um dos equipamentos estava bloqueado por impedimento técnico nesse período. Confira o equipamento.',409);
  throw e;
 }
}
