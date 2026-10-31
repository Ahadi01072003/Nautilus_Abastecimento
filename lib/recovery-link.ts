// Financeiro · Frente B: a solicitação de recobrável acompanha a OS ligada a ela. Cada gancho só mexe
// na solicitação que está na situação esperada: lançar o rascunho ligado (Autorizada → Em execução),
// concluir a OS (Em execução → Concluída) e cancelar a OS (Em execução → Autorizada, sem OS). Concluída
// e cancelada não mudam. A auditoria segue o acesso de quem age.
import type {Executor} from './db';
import type {Member} from './permissions';
import {audit} from './registry';

const now=()=>new Date().toISOString();

/** OS lançada a partir do rascunho ligado à solicitação (só do mesmo cliente que autorizou). */
export async function onPlanLaunched(tx:Executor,a:Member,planId:string,workOrderId:string){
 const r=await tx.first("UPDATE recovery_requests SET status='em_execucao',work_order_id=?,version=version+1,updated_at=? WHERE plan_id=? AND status='autorizada' AND work_order_id IS NULL AND org_id IS NOT DISTINCT FROM (SELECT org_id FROM work_orders WHERE id=?) RETURNING id,number",workOrderId,now(),planId,workOrderId);
 if(r)await audit(tx,a,'Planejamento: solicitação de recobrável em execução',r.id,{number:r.number,workOrderId});
}

/** Troca de tipo de atividade: o vínculo passa do rascunho descartado para o novo. */
export async function onPlanReplaced(tx:Executor,a:Member,oldPlanId:string,newPlanId:string){
 const r=await tx.first("UPDATE recovery_requests SET plan_id=?,version=version+1,updated_at=? WHERE plan_id=? AND status='autorizada' RETURNING id,number",newPlanId,now(),oldPlanId);
 if(r)await audit(tx,a,'Planejamento: rascunho da solicitação de recobrável trocado',r.id,{number:r.number,from:oldPlanId,to:newPlanId});
}

export async function onOrderClosed(tx:Executor,a:Member,workOrderId:string,origin='Planejamento'){
 const r=await tx.first("UPDATE recovery_requests SET status='concluida',version=version+1,updated_at=? WHERE work_order_id=? AND status='em_execucao' RETURNING id,number",now(),workOrderId);
 if(r)await audit(tx,a,`${origin}: solicitação de recobrável concluída`,r.id,{number:r.number,workOrderId});
}

export async function onOrderCancelled(tx:Executor,a:Member,workOrderId:string){
 const r=await tx.first("UPDATE recovery_requests SET status='autorizada',work_order_id=NULL,plan_id=NULL,version=version+1,updated_at=? WHERE work_order_id=? AND status='em_execucao' RETURNING id,number",now(),workOrderId);
 if(r)await audit(tx,a,'Planejamento: solicitação de recobrável voltou a Autorizada (OS cancelada)',r.id,{number:r.number,workOrderId});
}
