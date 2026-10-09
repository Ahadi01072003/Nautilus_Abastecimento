import {db,type Executor,type Row} from './db';
import {Profile} from './permissions';
import {emailSetup,sendResendEmail} from './resend';
export type NoticeKind='requested'|'scheduled'|'completed'|'minimum'|'cancelled';
const recipientSQL="active=1 AND email IS NOT NULL AND (profile='manager' OR (?='requested' AND profile='planner' AND notify_requests=1) OR (?='scheduled' AND profile='fueler' AND notify_schedule=1))";
// Em failed, locked_at guarda a próxima tentativa; em sending, guarda o início.
const eligibleSQL="(status='pending' OR (status='failed' AND (locked_at IS NULL OR locked_at<=?)) OR (status='sending' AND locked_at<?))";
export function recipientAllowed(member:{active:number;profile:Profile;notify_requests:number;notify_schedule:number;email?:string|null},kind:NoticeKind){return !!member.active&&member.email!==null&&(member.profile==='manager'||kind==='requested'&&member.profile==='planner'&&!!member.notify_requests||kind==='scheduled'&&member.profile==='fueler'&&!!member.notify_schedule);}
/** Cria o evento e um aviso por destinatário elegível, na mesma transação da operação. */
export async function enqueue(tx:Executor,kind:NoticeKind,entityId:string,time:string,version=0,entityType='appointments'){
 const eventId=`${kind}:${entityType}:${entityId}:${version}`;
 await tx.run('INSERT INTO notification_events(id,kind,entity_type,entity_id,version,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',eventId,kind,entityType,entityId,version,time);
 await tx.run(`INSERT INTO notifications(id,event_id,member_id,created_at) SELECT ?::text||':'||id,?,id,? FROM members WHERE ${recipientSQL} ON CONFLICT DO NOTHING`,eventId,eventId,time,kind,kind);
}
export async function enqueueMinimum(tx:Executor,fuelId:string,time:string){
 await tx.run("INSERT INTO notification_events(id,kind,entity_type,entity_id,version,created_at) SELECT 'minimum:requests:'||id||':0','minimum','requests',id,0,?::text FROM requests WHERE fuel_id=? AND status IN ('open','purchasing','partial') ON CONFLICT DO NOTHING",time,fuelId);
 await tx.run("INSERT INTO notifications(id,event_id,member_id,created_at) SELECT e.id||':'||m.id,e.id,m.id,?::text FROM notification_events e JOIN requests r ON r.id=e.entity_id JOIN members m ON m.active=1 AND m.profile='manager' AND m.email IS NOT NULL WHERE e.kind='minimum' AND r.fuel_id=? AND r.status IN ('open','purchasing','partial') ON CONFLICT DO NOTHING",time,fuelId);
}
const titles:Record<NoticeKind,string>={requested:'Nova solicitação de abastecimento',scheduled:'Abastecimento agendado',completed:'Abastecimento realizado',minimum:'Estoque mínimo · reposição necessária',cancelled:'Cancelamento registrado'};
const first=(sql:string,...args:unknown[])=>db().first(sql,...args);
async function message(event:Row,origin:string){
 const footer=(module:string)=>`\nEntre com seu usuário e senha para consultar os detalhes: ${origin}/?modulo=${module}`;
 if(event.entity_type==='appointments'){
  const a=await first('SELECT * FROM appointments WHERE id=?',event.entity_id);if(!a)return null;
  if(event.kind==='scheduled'&&!((a.status==='scheduled'&&a.version===event.version)||(a.status==='completed'&&a.version===event.version+1))||event.kind==='cancelled'&&(a.status!=='cancelled'||a.version!==event.version))return null;
  const context=event.kind==='scheduled'?'Há um abastecimento agendado para a equipe.':event.kind==='cancelled'?'Uma solicitação de abastecimento foi cancelada.':'Há uma solicitação de abastecimento para consultar.';
  return context+footer('solicitacoes');
 }
 if(event.entity_type==='supplies'){
  const s=await first('SELECT * FROM supplies WHERE id=?',event.entity_id);if(!s||event.kind==='completed'&&s.status!=='confirmed'||event.kind==='cancelled'&&s.status!=='cancelled')return null;
  return (event.kind==='completed'?'Um abastecimento foi realizado.':'Um registro foi cancelado com estorno.')+footer('abastecimentos');
 }
 const r=await first('SELECT r.* FROM requests r WHERE r.id=?',event.entity_id);
 if(!r||event.kind==='cancelled'&&r.status!=='cancelled')return null;
 if(event.kind==='minimum'&&!['open','purchasing','partial'].includes(r.status))return null;
 return (event.kind==='minimum'?'Um combustível atingiu o estoque mínimo. Consulte a solicitação de reposição.':'Uma solicitação de reposição foi cancelada.')+footer('alertas');
}
const memberColumns='m.email,m.active,m.profile,m.notify_requests,m.notify_schedule';
export async function flushNotifications(origin:string){
 const setup=emailSetup();if(!setup.ready||!setup.enabled)return;
 if(!/^https?:\/\//.test(origin))return;
 // Inicia tentativas por até 15 s; cada envio expira em 10 s.
 const deadline=Date.now()+15000;
 let nextSendAt=0;
 const stale=()=>new Date(Date.now()-300000).toISOString();
 const candidates=await db().all(`SELECT id FROM notifications WHERE ${eligibleSQL} AND attempts<10 ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at LIMIT 20`,new Date().toISOString(),stale());
 for(const item of candidates){
  if(Date.now()>=deadline)break;
  const row=await first(`SELECT n.*,e.kind,e.entity_type,e.entity_id,e.version,${memberColumns} FROM notifications n JOIN notification_events e ON e.id=n.event_id JOIN members m ON m.id=n.member_id WHERE n.id=?`,item.id);
  if(!row)continue;
  const body=recipientAllowed(row as never,row.kind)?await message(row,origin):null;
  if(!body){await db().run(`UPDATE notifications SET status='skipped',last_error='' WHERE id=? AND ${eligibleSQL}`,row.id,new Date().toISOString(),stale());continue;}
  const delay=nextSendAt-Date.now();if(delay>0)await new Promise<void>(resolve=>setTimeout(resolve,delay));
  if(Date.now()>=deadline)break;
  const claimed=await db().run(`UPDATE notifications SET status='sending',locked_at=?,attempts=attempts+1 WHERE id=? AND ${eligibleSQL} AND attempts<10`,new Date().toISOString(),row.id,new Date().toISOString(),stale());if(!claimed)continue;
  // Reconfere revogação e destinatário imediatamente antes do envio.
  const member=await first('SELECT * FROM members WHERE id=?',row.member_id);
  if(!member||!recipientAllowed(member as never,row.kind)){await db().run("UPDATE notifications SET status='skipped',last_error='' WHERE id=?",row.id);continue;}
  const currentBody=await message(row,origin);if(!currentBody){await db().run("UPDATE notifications SET status='skipped',last_error='' WHERE id=?",row.id);continue;}
  try{
   nextSendAt=Date.now()+500;
   await sendResendEmail(member.email,`NAUTILUS · ${titles[row.kind as NoticeKind]}`,currentBody,`nautilus-notice/${row.id}`);
   await db().run("UPDATE notifications SET status='sent',sent_at=?,last_error='' WHERE id=?",new Date().toISOString(),row.id);
  }catch{const next=new Date(Date.now()+Math.min(3600000,60000*2**row.attempts)).toISOString();await db().run("UPDATE notifications SET status='failed',locked_at=?,last_error='Serviço de envio indisponível. Nova tentativa pendente.' WHERE id=?",next,row.id);}
 }
}
