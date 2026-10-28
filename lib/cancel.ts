// Cancelamento de OS (planejador ou gestor, com justificativa): vale para OS programada e em
// andamento. Em andamento, as etapas abertas terminam como canceladas no momento do cancelamento e
// os períodos de trabalho já registrados ficam preservados (histórico). Todos os recursos voltam a
// ficar livres: as reservas de equipamento são liberadas e a equipe deixa de contar como ocupada.
import {db,type Row} from './db';
import {AppError,required} from './domain';
import {type Member,isManager,requireAny,canCancelOrders} from './permissions';
import {audit} from './registry';
import {osNumber} from './planning';
import {event} from './operation';

const now=()=>new Date().toISOString();
const idOf=(value:unknown,label:string)=>required(value,label,100);
type Actor=Member&{org_scope:string[]};
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);
const OPEN=['nao_iniciada','em_execucao','bloqueada','pausada'];

export async function cancelOrder(b:Row,member:Member){
 const a=await requireAny(member,['planejamento']) as Actor;
 // Cancelar é do perfil Planejador ou Gestão; o acesso adicional ao Planejamento não basta.
 if(!canCancelOrders(a))throw new AppError('Só o perfil Planejador ou Gestão pode cancelar OS.',403);
 const reason=required(b.reason,'Justificativa do cancelamento',1200);
 // A tela da Lista de OS envia o planejamento; a dos Apontamentos, a OS.
 const ref=b.workOrderId?await db().first('SELECT id FROM work_orders WHERE id=?',idOf(b.workOrderId,'OS'))
  :await db().first('SELECT work_order_id id FROM plans WHERE id=?',idOf(b.id,'Planejamento'));
 if(!ref?.id)throw new AppError('OS não encontrada.',404);
 return db().tx(async tx=>{
  const w=await tx.first('SELECT * FROM work_orders WHERE id=? FOR UPDATE',ref.id);
  if(!w||!inScope(a,w.org_id))throw new AppError('OS não encontrada ou fora do seu acesso.',404);
  if(w.status==='cancelada')return {ok:true,repeated:true,message:`${osNumber(w.number)} já estava cancelada.`};
  if(b.version!=null&&b.version!==w.version)throw new AppError('A OS mudou. Atualize a tela antes de cancelar.',409);
  if(!['programada','em_andamento'].includes(w.status))throw new AppError(w.status==='encerramento_pendente'?'A execução desta OS já terminou: conclua o checklist pendente para encerrá-la.':'Esta OS já foi encerrada.',409);
  const t=now(),running=w.status==='em_andamento';
  // Revisão em aberto deixaria reservas provisórias presas a uma OS cancelada.
  for(const d of await tx.all("SELECT id FROM plans WHERE work_order_id=? AND status='draft'",w.id)){
   await tx.run("UPDATE plans SET status='discarded',updated_at=?,version=version+1 WHERE id=?",t,d.id);
   await tx.run("UPDATE reservations SET status='liberada',released_at=?,release_reason='OS cancelada' WHERE plan_id=? AND status<>'liberada'",t,d.id);
  }
  const steps=await tx.all('SELECT * FROM os_steps WHERE work_order_id=? AND status = ANY(?::text[]) FOR UPDATE',w.id,OPEN);
  if(running){
   const ev=await event(tx,a,w,null,'cancelamento','cancel:'+w.id,{reason,steps:steps.length});
   await tx.run('UPDATE step_intervals SET end_at=?,end_event_id=? WHERE end_at IS NULL AND os_step_id = ANY(?::text[])',t,ev,steps.map(s=>s.id));
   await tx.run("UPDATE occurrences SET status='resolvido',resolved_at=?,resolved_by=?,resolved_by_name=?,resolution=? WHERE work_order_id=? AND blocking=1 AND status='aberto'",t,a.id,a.name,'OS cancelada: '+reason,w.id);
  }
  for(const s of steps)await tx.run("UPDATE os_steps SET status='cancelada',actual_end=CASE WHEN actual_start IS NOT NULL THEN ? ELSE actual_end END WHERE id=?",t,s.id);
  // Todas as reservas da OS são liberadas (o uso real fica nos períodos de trabalho das etapas).
  await tx.run("UPDATE reservations SET status='liberada',released_at=?,release_reason='OS cancelada' WHERE plan_id=? AND status<>'liberada'",t,w.current_plan_id);
  await tx.run("UPDATE work_orders SET status='cancelada',cancelled_at=?,cancelled_by=?,cancel_reason=?,actual_end=CASE WHEN ?::boolean THEN ? ELSE actual_end END,version=version+1 WHERE id=?",t,a.id,reason,running,t,w.id);
  await audit(tx,a,'Planejamento: OS cancelada',w.id,{number:w.number,reason,inProgress:running,openSteps:steps.length});
  return {ok:true,message:running?`${osNumber(w.number)} cancelada. As etapas abertas foram encerradas e os equipamentos liberados.`:`${osNumber(w.number)} cancelada. As reservas foram liberadas.`};
 });
}
