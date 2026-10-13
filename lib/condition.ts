// Condição técnica dos equipamentos: impedimentos (manuais agora; NC crítica na Operação)
// e liberação técnica com justificativa e evidência. Nada é apagado.
import {db,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {period,osNumber} from './planning';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const all=(q:string,...v:unknown[])=>db().all(q,...v);

export async function conditionState(member:Member){
 const a=await requireAny(member,['cadastros','manutencao','planejamento']);
 const [open,history,affected]=await Promise.all([
  all('SELECT i.*,e.tag FROM equipment_impediments i JOIN equipment e ON e.id=i.equipment_id WHERE i.released_at IS NULL ORDER BY i.opened_at DESC'),
  all('SELECT i.*,e.tag FROM equipment_impediments i JOIN equipment e ON e.id=i.equipment_id WHERE i.released_at IS NOT NULL ORDER BY i.released_at DESC LIMIT 50'),
  // Compromissos futuros ou em curso que dependem de equipamento bloqueado: precisam de substituição ou reprogramação.
  all(`SELECT r.equipment_id,r.start_at,r.end_at,r.status,p.status plan_status,p.author_name,s.name step_name,w.number FROM reservations r
   JOIN plans p ON p.id=r.plan_id JOIN plan_steps s ON s.id=r.plan_step_id LEFT JOIN work_orders w ON w.id=p.work_order_id
   WHERE r.status<>'liberada' AND r.end_at::timestamptz > now() AND r.equipment_id IN (SELECT equipment_id FROM equipment_impediments WHERE released_at IS NULL) ORDER BY r.start_at`),
 ]);
 const caps=a.capabilities||[];
 return {open,history,affected:affected.map(r=>({...r,label:(r.plan_status==='draft'?`Rascunho de ${r.author_name}`:osNumber(r.number))+` · etapa “${r.step_name}” · ${period(r.start_at,r.end_at)}`})),
  canOpen:isManager(a)||caps.includes('cadastros')||caps.includes('manutencao'),canRelease:isManager(a)||caps.includes('manutencao')};
}

export async function conditionMutate(path:string,b:Row,member:Member){
 if(path==='condition/open'){
  const a=await requireAny(member,['cadastros','manutencao']);
  const e=await db().first('SELECT id,tag FROM equipment WHERE id=?',required(b.equipmentId,'Equipamento',100));
  if(!e)throw new AppError('Equipamento não encontrado.',404);
  const reason=required(b.reason,'Motivo',500),iid=id();
  await db().tx(async tx=>{
   await tx.run("INSERT INTO equipment_impediments(id,equipment_id,kind,reason,opened_at,opened_by,opened_by_name) VALUES(?,?,'manual',?,?,?,?)",iid,e.id,reason,now(),a.id,a.name);
   await audit(tx,a,'Condição técnica: impedimento registrado',e.id,{tag:e.tag,reason,impediment:iid});
  });
  return {id:iid,message:`${e.tag} bloqueado. Novas reservas e lançamentos com este equipamento ficam impedidos até a liberação técnica.`};
 }
 if(path==='condition/release'){
  const a=await requireAny(member,['manutencao']);
  const reason=required(b.reason,'Justificativa da liberação',1200),evidence=text(b.evidence,1200);
  if(!evidence)throw new AppError('Descreva a evidência da correção (ex.: ordem de manutenção, laudo, teste realizado).');
  const imp=await db().first('SELECT i.*,e.tag FROM equipment_impediments i JOIN equipment e ON e.id=i.equipment_id WHERE i.id=?',required(b.id,'Impedimento',100));
  if(!imp)throw new AppError('Impedimento não encontrado.',404);
  if(imp.released_at)throw new AppError('Este impedimento já foi liberado.',409);
  await db().tx(async tx=>{
   const changed=await tx.run('UPDATE equipment_impediments SET released_at=?,released_by=?,released_by_name=?,release_reason=?,release_evidence=? WHERE id=? AND released_at IS NULL',now(),a.id,a.name,reason,evidence,imp.id);
   if(!changed)throw new AppError('Este impedimento já foi liberado.',409);
   await audit(tx,a,'Condição técnica: liberação técnica',imp.equipment_id,{tag:imp.tag,impediment:imp.id,reason,evidence});
  });
  const still=await db().first('SELECT count(*) n FROM equipment_impediments WHERE equipment_id=? AND released_at IS NULL',imp.equipment_id);
  return {ok:true,message:still!.n?`Impedimento liberado, mas ${imp.tag} ainda tem ${still!.n} impedimento(s) ativo(s).`:`${imp.tag} liberado tecnicamente. Volta a ficar disponível conforme a agenda.`};
 }
 throw new AppError('Ação não encontrada.',404);
}
