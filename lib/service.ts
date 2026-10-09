import {scheduledDate,appointmentVersion} from './scheduling';
import {Member,Profile,isManager,canPlan,canRecord,requireProfile,modules,profiles} from './permissions';
import {enqueue,enqueueMinimum} from './notifications';
import {emailSetup,sendResendEmail} from './resend';
import {db,type Executor,type Row} from './db';
import {defaultPassword,hashPassword,normalizeUsername,checkTemporaryPassword,TEMPORARY_PASSWORD_DAYS} from './auth';
import {AppError,businessDeadline,email,required,text,milli,dateISO,safeCSV,isoDay} from './domain';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const all=(query:string,...values:unknown[])=>db().all(query,...values);
const first=(query:string,...values:unknown[])=>db().first(query,...values);
const localMonth=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit'}).format(new Date());
const LOCAL_DAY="to_char((occurred_at::timestamptz) AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD')";

/** Reconfere perfil e situação no cadastro atual: revogações valem imediatamente. */
export async function requireFresh(a:Member){const current=await first('SELECT profile,active FROM members WHERE id=?',a.id);if(!current?.active||current.profile!==a.profile)throw new AppError('Seu acesso mudou. Atualize a tela.',403);}
function audit(tx:Executor,a:Row,action:string,entityId:string,detail:unknown){return tx.run('INSERT INTO audits(id,action,entity_id,author_id,author_name,created_at,detail) VALUES(?,?,?,?,?,?,?)',id(),action,entityId,a.id,a.name,now(),JSON.stringify(detail));}
/** Abre a solicitação de reposição quando o saldo atinge o mínimo (uma ativa por combustível). */
async function openReplenishment(tx:Executor,fuelId:string,leadDays?:number){
 const fuel=await tx.first('SELECT lead_days FROM fuels WHERE id=?',fuelId);const lead=leadDays??fuel?.lead_days;if(lead===undefined)return;
 const hs=await tx.all('SELECT date FROM holidays');const opened=now();const deadline=businessDeadline(opened,lead,hs.map(h=>h.date));
 await tx.run("INSERT INTO requests(id,fuel_id,requested_milli,stock_reference_milli,opened_at,deadline,status) SELECT ?::text,id,capacity_milli-stock_milli,stock_milli,?::text,?::text,'open' FROM fuels WHERE id=? AND active=1 AND stock_milli<=minimum_milli AND NOT EXISTS(SELECT 1 FROM requests WHERE fuel_id=? AND status IN ('open','purchasing','partial')) ON CONFLICT DO NOTHING",id(),opened,deadline,fuelId,fuelId);
 await enqueueMinimum(tx,fuelId,opened);
}
const idOf=(value:unknown,label:string)=>required(value,label,100);
const flag=(value:unknown)=>value===false?0:1;

export async function state(a:Member,page=0){
 if(!Number.isSafeInteger(page)||page<0||page>10000)throw new AppError('Página inválida.');
 const manager=isManager(a),requester=a.profile==='requester',fueler=a.profile==='fueler',limit=100,offset=page*limit;
 const appointmentWhere=requester?' WHERE a.requester_id=?':fueler?" WHERE a.status='scheduled' OR EXISTS(SELECT 1 FROM supplies own WHERE own.appointment_id=a.id AND own.author_id=?)":'';
 const appointmentArgs=requester||fueler?[a.id]:[];
 const supplyWhere=manager?'':' WHERE s.author_id=?',supplyArgs=manager?[]:[a.id];
 const none=Promise.resolve([] as Row[]);
 const [fuels,equipment,operators,supplies,movements,requests,holidays,members,audits,stats,daily,appointments,executors,notifications,appointmentCount,supplyCount]=await Promise.all([
  all(manager?'SELECT * FROM fuels ORDER BY name':`SELECT id,name,unit,integral,active${fueler?',stock_milli':''} FROM fuels WHERE active=1 ORDER BY name`),
  all(manager?'SELECT * FROM equipment ORDER BY tag':'SELECT id,tag,description,type,fuel_ids,active FROM equipment WHERE active=1 ORDER BY tag'),
  manager||fueler?all('SELECT id,name,badge,active FROM operators'+(manager?'':' WHERE active=1')+' ORDER BY name'):none,
  manager||fueler?all('SELECT s.id,s.appointment_id,s.fuel_id,s.equipment_id,s.operator_id,s.quantity_milli,s.occurred_at,s.created_at,s.author_id,s.author_name,s.equipment_tag,s.equipment_name,s.operator_name,s.fuel_name,s.unit,s.hourmeter_milli,s.hourmeter_end_milli,s.notes,s.status,s.cancel_reason FROM supplies s'+supplyWhere+' ORDER BY s.occurred_at DESC LIMIT ? OFFSET ?',...supplyArgs,limit,offset):none,
  manager?all('SELECT m.*,f.name fuel_name,f.unit FROM movements m JOIN fuels f ON f.id=m.fuel_id ORDER BY m.occurred_at DESC LIMIT 200'):none,
  manager?all('SELECT r.id,r.fuel_id,r.requested_milli,r.received_milli,r.stock_reference_milli,r.opened_at,r.deadline,r.status,f.name fuel_name,f.unit,f.stock_milli,f.minimum_milli FROM requests r JOIN fuels f ON f.id=r.fuel_id ORDER BY r.opened_at DESC LIMIT 200'):none,
  manager?all('SELECT * FROM holidays ORDER BY date'):none,
  manager?all('SELECT id,username,email,name,profile AS role,notify_requests,notify_schedule,active,created_at,must_change_password,password_changed_at,locked_until,last_login_at FROM members ORDER BY name'):none,
  manager?all('SELECT * FROM audits ORDER BY created_at DESC LIMIT 100'):none,
  manager?all(`SELECT fuel_id,COUNT(*) count,SUM(quantity_milli)::bigint quantity_milli FROM supplies WHERE status='confirmed' AND substr(${LOCAL_DAY},1,7)=? GROUP BY fuel_id`,localMonth()):none,
  // Histórico diário completo (por dia e combustível) para o gráfico com zoom ano › mês › dia.
  manager?all(`SELECT ${LOCAL_DAY} AS day,fuel_id,SUM(quantity_milli)::bigint quantity_milli,COUNT(*) count FROM supplies WHERE status='confirmed' GROUP BY 1,2 ORDER BY 1`):none,
  all(`SELECT a.id,a.equipment_id,a.equipment_tag,a.equipment_name,a.fuel_id,a.fuel_name,a.hourmeter_milli,a.requester_id,a.requester_name,a.created_at,a.status,a.scheduled_at,a.assigned_member_id,a.assigned_name,a.updated_at,a.completed_at,a.cancel_reason,a.version,s.id supply_id FROM appointments a LEFT JOIN supplies s ON s.appointment_id=a.id AND s.status='confirmed'${appointmentWhere} ORDER BY CASE WHEN a.status='scheduled' THEN 0 WHEN a.status='requested' THEN 1 ELSE 2 END,a.created_at DESC LIMIT ? OFFSET ?`,...appointmentArgs,limit,offset),
  canPlan(a)?all("SELECT id,name FROM members WHERE active=1 AND profile IN ('fueler','manager') ORDER BY name"):none,
  manager?all('SELECT n.id,n.status,n.attempts,n.sent_at,n.last_error,n.created_at,e.kind,m.name recipient_name FROM notifications n JOIN notification_events e ON e.id=n.event_id JOIN members m ON m.id=n.member_id ORDER BY n.created_at DESC LIMIT 100'):none,
  first('SELECT count(*) total FROM appointments a'+appointmentWhere,...appointmentArgs),
  manager||fueler?first('SELECT count(*) total FROM supplies s'+supplyWhere,...supplyArgs):Promise.resolve({total:0})
 ]);
 await requireFresh(a);
 let standard:string|null=null;
 if(manager){try{standard=defaultPassword();}catch{standard=null;}}
 const setup=emailSetup();
 return {
  actor:{id:a.id,name:a.name,username:a.username,role:a.profile,canFuel:canRecord(a),canPlan:canPlan(a),canRequest:a.profile==='requester'||manager,modules:modules(a)},
  fuels,equipment,operators,supplies,movements,requests,holidays,members,audits,stats,daily,appointments,executors,notifications,
  pagination:{page,limit,appointments:appointmentCount?.total||0,supplies:supplyCount?.total||0},
  emailReady:setup.ready&&setup.enabled,...(manager?{emailSetup:setup,access:{defaultPassword:standard,temporaryPasswordDays:TEMPORARY_PASSWORD_DAYS}}:{}),generatedAt:now()
 };
}

export async function mutate(path:string,b:Row,a:Member){
 await requireFresh(a);
 const t=now();
 if(path==='appointments'){
  requireProfile(a,['requester','manager']);
  const key=required(b.operationKey,'Identificador da solicitação',100);
  const previous=await first('SELECT id,requester_id FROM appointments WHERE operation_key=?',key);
  if(previous){if(previous.requester_id!==a.id)throw new AppError('Esta solicitação pertence a outra pessoa.',403);return {id:previous.id,repeated:true};}
  const [e,f]=await Promise.all([first('SELECT * FROM equipment WHERE id=? AND active=1',idOf(b.equipmentId,'Equipamento')),first('SELECT * FROM fuels WHERE id=? AND active=1',idOf(b.fuelId,'Tipo de abastecimento'))]);
  if(!e||!f)throw new AppError('Selecione equipamento e combustível ativos.');
  if(!e.fuel_ids.includes(f.id))throw new AppError('Combustível incompatível com este equipamento.');
  const hour=milli(b.hourmeter,false,true),created=id();
  await db().tx(async tx=>{
   await tx.run('INSERT INTO appointments(id,operation_key,equipment_id,equipment_tag,equipment_name,fuel_id,fuel_name,hourmeter_milli,requester_id,requester_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',created,key,e.id,e.tag,e.description,f.id,f.name,hour,a.id,a.name,t,t);
   await audit(tx,a,'Abastecimento solicitado',created,{equipment:e.tag,fuel:f.name,hourmeter:hour/1000});
   await enqueue(tx,'requested',created,t);
  });
  return {id:created};
 }
 if(path==='appointments/schedule'){
  requireProfile(a,['planner','manager']);const aid=idOf(b.id,'Solicitação'),version=appointmentVersion(b.version),date=scheduledDate(b.scheduledAt);
  const assigned=b.assignedMemberId?await first("SELECT id,name FROM members WHERE id=? AND active=1 AND profile IN ('fueler','manager')",idOf(b.assignedMemberId,'Responsável previsto')):null;
  if(b.assignedMemberId&&!assigned)throw new AppError('Escolha uma pessoa ativa da equipe de abastecimento.');
  const previous=await first('SELECT * FROM appointments WHERE id=?',aid);
  if(!previous||!['requested','scheduled'].includes(previous.status))throw new AppError('Solicitação já encerrada ou não encontrada.',409);
  await db().tx(async tx=>{
   const changed=await tx.run("UPDATE appointments SET status='scheduled',scheduled_at=?,assigned_member_id=?,assigned_name=?,scheduled_by_id=?,scheduled_by_name=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND status IN ('requested','scheduled')",date,assigned?.id||null,assigned?.name||null,a.id,a.name,t,aid,version);
   if(!changed)throw new AppError('A solicitação mudou. Atualize a tela antes de agendar.',409);
   await audit(tx,a,previous.status==='scheduled'?'Abastecimento reagendado':'Abastecimento agendado',aid,{before:{scheduledAt:previous.scheduled_at,assignedId:previous.assigned_member_id},after:{scheduledAt:date,assignedId:assigned?.id||null,assignedName:assigned?.name||null}});
   await enqueue(tx,'scheduled',aid,t,version+1);
  });
  return {ok:true};
 }
 if(path==='appointments/cancel'){
  requireProfile(a,['requester','planner','manager']);
  const aid=idOf(b.id,'Solicitação'),version=appointmentVersion(b.version),reason=required(b.reason,'Justificativa',1200);
  const previous=await first('SELECT * FROM appointments WHERE id=?'+(a.profile==='requester'?' AND requester_id=?':''),aid,...(a.profile==='requester'?[a.id]:[]));
  if(!previous||!['requested','scheduled'].includes(previous.status))throw new AppError('Solicitação já encerrada ou não encontrada.',409);
  if(!canPlan(a)&&!(a.profile==='requester'&&previous.requester_id===a.id&&previous.status==='requested'))throw new AppError('Seu perfil não permite cancelar esta solicitação.',403);
  await db().tx(async tx=>{
   const changed=await tx.run("UPDATE appointments SET status='cancelled',cancel_reason=?,cancelled_by_id=?,cancelled_by_name=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND status IN ('requested','scheduled')",reason,a.id,a.name,t,aid,version);
   if(!changed)throw new AppError('A solicitação mudou. Atualize a tela antes de cancelar.',409);
   await audit(tx,a,'Solicitação de abastecimento cancelada',aid,{reason});
   await enqueue(tx,'cancelled',aid,t,version+1);
  });
  return {ok:true};
 }
 if(path==='supplies'){
  requireProfile(a,['fueler','manager']);const key=required(b.operationKey,'Identificador da operação',100);
  const previous=await first('SELECT id,author_id FROM supplies WHERE operation_key=?',key);if(previous){if(previous.author_id!==a.id)throw new AppError('Operação já utilizada.',409);return {id:previous.id,repeated:true};}
  const [f,e,o]=await Promise.all([first('SELECT * FROM fuels WHERE id=? AND active=1',idOf(b.fuelId,'Combustível')),first('SELECT * FROM equipment WHERE id=? AND active=1',idOf(b.equipmentId,'Equipamento')),first('SELECT * FROM operators WHERE id=? AND active=1',idOf(b.operatorId,'Operador'))]);
  if(!f||!e||!o)throw new AppError('Selecione combustível, equipamento e operador ativos.');
  if(!e.fuel_ids.includes(f.id))throw new AppError('Combustível incompatível com este equipamento.');
  const quantity=milli(b.quantity,!!f.integral),date=dateISO(b.occurredAt),notes=text(b.notes,1200);
  const hour=b.hourmeter==null||b.hourmeter===''?null:milli(b.hourmeter,false,true);const end=b.hourmeterEnd==null||b.hourmeterEnd===''?null:milli(b.hourmeterEnd,false,true);
  if(end!==null&&(hour===null||end<hour))throw new AppError('Horímetro final deve ser igual ou maior que o inicial.');
  let appointment:Row|null=null;
  if(b.appointmentId){
   appointment=await first('SELECT * FROM appointments WHERE id=?',idOf(b.appointmentId,'Agendamento'));
   if(!appointment||appointment.status!=='scheduled')throw new AppError('Agendamento indisponível ou já realizado.',409);
   if(appointment.equipment_id!==e.id||appointment.fuel_id!==f.id)throw new AppError('Equipamento e combustível devem corresponder ao agendamento.');
   if(hour===null||hour<appointment.hourmeter_milli)throw new AppError('O horímetro inicial deve ser igual ou maior que o informado na solicitação.');
   if(date<appointment.created_at)throw new AppError('A data do abastecimento não pode ser anterior à solicitação.');
  }
  if(!appointment&&!isManager(a))throw new AppError('Registre o consumo a partir de um abastecimento agendado.',403);
  if(!appointment&&!notes)throw new AppError('Justifique o registro excepcional sem agendamento.');
  const created=id();
  await db().tx(async tx=>{
   await tx.run('INSERT INTO supplies(id,operation_key,fuel_id,equipment_id,operator_id,quantity_milli,occurred_at,created_at,author_id,author_name,equipment_tag,equipment_name,operator_name,fuel_name,unit,hourmeter_milli,hourmeter_end_milli,notes,appointment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',created,key,f.id,e.id,o.id,quantity,date,t,a.id,a.name,e.tag,e.description,o.name,f.name,f.unit,hour,end,notes,appointment?.id||null);
   await audit(tx,a,'Abastecimento registrado',created,{quantity:quantity/1000,equipment:e.tag,fuel:f.name,appointmentId:appointment?.id||null});
   await enqueue(tx,'completed',created,t,0,'supplies');
   await openReplenishment(tx,f.id);
  });
  return {id:created};
 }
 if(path==='supplies/cancel'){
  requireProfile(a,['manager']);const s=await first('SELECT * FROM supplies WHERE id=?',idOf(b.id,'Abastecimento'));if(!s||s.status!=='confirmed')throw new AppError('Registro já cancelado ou não encontrado.',409);
  const reason=required(b.reason,'Justificativa',1200);
  await db().tx(async tx=>{
   const changed=await tx.run("UPDATE supplies SET status='cancelled',cancel_reason=? WHERE id=? AND status='confirmed'",reason,s.id);
   if(!changed)throw new AppError('Registro já cancelado.',409);
   // Só estorna o que de fato saiu do estoque: registros históricos importados não têm baixa.
   const debited=await tx.first("SELECT id FROM movements WHERE supply_id=? AND kind='debit'",s.id);
   if(debited)await tx.run("INSERT INTO movements(id,operation_key,fuel_id,delta_milli,kind,supply_id,occurred_at,author_id,author_name,reason) VALUES(?,?,?,?,'reversal',?,?,?,?,?)",id(),'cancel:'+s.id,s.fuel_id,s.quantity_milli,s.id,t,a.id,a.name,reason);
   await audit(tx,a,'Abastecimento cancelado',s.id,{reason,reversal:!!debited});
   await enqueue(tx,'cancelled',s.id,t,0,'supplies');
  });
  return {ok:true};
 }
 if(path==='stock'){
  requireProfile(a,['manager']);const f=await first('SELECT * FROM fuels WHERE id=? AND active=1',idOf(b.fuelId,'Combustível'));if(!f)throw new AppError('Combustível não encontrado.');
  const key=required(b.operationKey,'Identificador da operação',100);const repeat=await first('SELECT id FROM movements WHERE operation_key=?',key);if(repeat)return {repeated:true};
  const reason=required(b.reason,'Justificativa',1200);
  const adjustment=b.kind==='adjustment';
  let delta:number,requestId:string|null=null;
  if(adjustment){if(!Number.isSafeInteger(b.version)||b.version!==f.version)throw new AppError('O estoque mudou. Atualize a tela e confira o saldo novamente.',409);delta=milli(b.balance,!!f.integral,true)-f.stock_milli;}
  else{delta=milli(b.quantity,!!f.integral);if(b.requestId)requestId=idOf(b.requestId,'Solicitação de reposição');}
  await db().tx(async tx=>{
   await tx.run('INSERT INTO movements(id,operation_key,fuel_id,delta_milli,kind,request_id,expected_version,occurred_at,author_id,author_name,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id(),key,f.id,delta,adjustment?'adjustment':'receipt',requestId,adjustment?b.version:null,t,a.id,a.name,reason);
   if(adjustment)await tx.run('UPDATE fuels SET provisional=0 WHERE id=?',f.id);
   await audit(tx,a,adjustment?'Estoque conferido':'Reposição recebida',f.id,{delta:delta/1000,reason,requestId});
   await openReplenishment(tx,f.id);
  });
  return {ok:true};
 }
 if(path==='equipment'){
  requireProfile(a,['manager']);const tag=required(b.tag,'TAG',60).toUpperCase(),description=required(b.description,'Descrição',250),type=required(b.type,'Tipo',100);
  if(!Array.isArray(b.fuelIds)||!b.fuelIds.length||b.fuelIds.length>50||b.fuelIds.some((f:unknown)=>typeof f!=='string'))throw new AppError('Selecione ao menos um combustível compatível.');
  const fuelIds=[...new Set(b.fuelIds as string[])];
  const allowed=await all('SELECT id FROM fuels WHERE active=1');if(fuelIds.some(f=>!allowed.some(v=>v.id===f)))throw new AppError('Combustível inválido.');
  const old=b.id?await first('SELECT * FROM equipment WHERE id=?',idOf(b.id,'Equipamento')):null;if(b.id&&!old)throw new AppError('Equipamento não encontrado.',404);
  const eid=old?.id||id();
  await db().tx(async tx=>{
   await tx.run('INSERT INTO equipment(id,tag,description,type,fuel_ids,active) VALUES(?,?,?,?,?::text[],?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag,description=excluded.description,type=excluded.type,fuel_ids=excluded.fuel_ids,active=excluded.active',eid,tag,description,type,fuelIds,flag(b.active));
   await audit(tx,a,old?'Equipamento atualizado':'Equipamento cadastrado',eid,{before:old,after:{tag,description,type,fuelIds,active:b.active!==false}});
  });
  return {id:eid};
 }
 if(path==='operators'){
  requireProfile(a,['manager']);const name=required(b.name,'Nome',180),badge=text(b.badge,60);
  const old=b.id?await first('SELECT * FROM operators WHERE id=?',idOf(b.id,'Operador')):null;if(b.id&&!old)throw new AppError('Operador não encontrado.',404);
  const oid=old?.id||id();
  await db().tx(async tx=>{
   await tx.run('INSERT INTO operators(id,name,badge,active) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,badge=excluded.badge,active=excluded.active',oid,name,badge,flag(b.active));
   await audit(tx,a,old?'Operador atualizado':'Operador cadastrado',oid,{before:old,after:{name,badge,active:b.active!==false}});
  });
  return {id:oid};
 }
 if(path==='members'){
  requireProfile(a,['manager']);
  const username=normalizeUsername(b.username),name=required(b.name,'Nome',180),addr=b.email?email(b.email):null;
  if(!profiles.includes(b.role))throw new AppError('Perfil inválido.');
  const profile=b.role as Profile;
  const existing=b.id?await first('SELECT * FROM members WHERE id=?',idOf(b.id,'Usuário')):null;if(b.id&&!existing)throw new AppError('Usuário não encontrado.',404);
  if(existing?.id===a.id&&(b.active===false||profile!=='manager'))throw new AppError('Você não pode retirar o seu próprio acesso de gestor.');
  const clash=await first('SELECT id,username,email FROM members WHERE (username=? OR email=?) AND id<>?',username,addr,existing?.id||'');
  if(clash)throw new AppError(clash.username===username?'Este usuário já está em uso. Escolha outro.':'Este e-mail já pertence a outro cadastro.',409);
  const notifyRequests=profile==='planner'?Number(b.notifyRequests!==false):1,notifySchedule=profile==='fueler'?Number(b.notifySchedule!==false):1,active=flag(b.active);
  if(!existing){
   const temporary=b.temporaryPassword?checkTemporaryPassword(b.temporaryPassword):defaultPassword();
   const hash=await hashPassword(temporary),mid=id();
   await db().tx(async tx=>{
    await tx.run('INSERT INTO members(id,username,email,name,profile,notify_requests,notify_schedule,active,created_at,password_hash,must_change_password,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)',mid,username,addr,name,profile,notifyRequests,notifySchedule,active,t,hash,t);
    await audit(tx,a,'Acesso criado',mid,{username,profile,active:!!active,customTemporaryPassword:!!b.temporaryPassword});
   });
   return {id:mid,username,message:`Usuário ${username} criado. No primeiro acesso a pessoa usa a senha ${b.temporaryPassword?'provisória informada':'padrão'} e define a senha definitiva.`};
  }
  await db().tx(async tx=>{
   await tx.run('UPDATE members SET username=?,email=?,name=?,profile=?,notify_requests=?,notify_schedule=?,active=? WHERE id=?',username,addr,name,profile,notifyRequests,notifySchedule,active,existing.id);
   if(!active||existing.profile!==profile)await tx.run('DELETE FROM sessions WHERE member_id=?',existing.id);
   await audit(tx,a,'Acesso atualizado',existing.id,{before:{username:existing.username,email:existing.email,profile:existing.profile,active:existing.active},after:{username,email:addr,profile,active,notifyRequests,notifySchedule}});
  });
  return {id:existing.id,username};
 }
 if(path==='members/reset-password'||path==='members/unlock'){
  requireProfile(a,['manager']);
  const target=await first('SELECT id,username,name FROM members WHERE id=?',idOf(b.id,'Usuário'));if(!target)throw new AppError('Usuário não encontrado.',404);
  if(path==='members/unlock'){
   await db().tx(async tx=>{await tx.run('UPDATE members SET failed_attempts=0,locked_until=NULL WHERE id=?',target.id);await audit(tx,a,'Acesso desbloqueado',target.id,{username:target.username});});
   return {ok:true,message:`Acesso de ${target.name} desbloqueado.`};
  }
  if(target.id===a.id)throw new AppError('Para trocar a sua própria senha, use Minha conta › Alterar senha.');
  const temporary=b.temporaryPassword?checkTemporaryPassword(b.temporaryPassword):defaultPassword();
  const hash=await hashPassword(temporary);
  await db().tx(async tx=>{
   await tx.run('UPDATE members SET password_hash=?,must_change_password=1,password_changed_at=?,failed_attempts=0,locked_until=NULL WHERE id=?',hash,t,target.id);
   await tx.run('DELETE FROM sessions WHERE member_id=?',target.id);
   await audit(tx,a,'Senha redefinida pelo gestor',target.id,{username:target.username,customTemporaryPassword:!!b.temporaryPassword});
  });
  return {ok:true,message:`Senha de ${target.name} redefinida. No próximo acesso será exigida uma nova senha definitiva.`};
 }
 if(path==='fuels'){
  requireProfile(a,['manager']);
  const old=b.id?await first('SELECT * FROM fuels WHERE id=?',idOf(b.id,'Combustível')):null;if(b.id&&!old)throw new AppError('Combustível não encontrado.',404);
  const fid=old?.id||id(),name=required(b.name,'Nome',100),unit=required(b.unit,'Unidade',30),integral=!!b.integral,capacity=milli(b.capacity,integral),minimum=milli(b.minimum,integral,true),lead=Number(b.leadDays);
  if(minimum>=capacity)throw new AppError('O mínimo deve ser menor que a capacidade máxima.');if(!Number.isInteger(lead)||lead<1||lead>60)throw new AppError('Prazo deve ser de 1 a 60 dias úteis.');
  if(old&&(old.unit!==unit||old.integral!==Number(integral))&&(await first('SELECT id FROM movements WHERE fuel_id=? LIMIT 1',fid)))throw new AppError('A unidade de um combustível com movimentações não pode ser alterada. Cadastre outro combustível.');
  if(old&&capacity<old.stock_milli)throw new AppError('Capacidade não pode ser menor que o saldo atual.');
  const balance=old?0:milli(b.balance??0,integral,true);
  if(!old&&balance>capacity)throw new AppError('O saldo inicial não pode exceder a capacidade máxima.');
  await db().tx(async tx=>{
   if(old)await tx.run('UPDATE fuels SET name=?,unit=?,integral=?,minimum_milli=?,capacity_milli=?,lead_days=?,active=? WHERE id=?',name,unit,Number(integral),minimum,capacity,lead,flag(b.active),fid);
   else{
    await tx.run('INSERT INTO fuels(id,name,unit,integral,capacity_milli,minimum_milli,stock_milli,lead_days,provisional,active) VALUES(?,?,?,?,?,?,0,?,1,1)',fid,name,unit,Number(integral),capacity,minimum,lead);
    await tx.run("INSERT INTO movements(id,operation_key,fuel_id,delta_milli,kind,occurred_at,author_id,author_name,reason) VALUES(?,?,?,?,'initial',?,?,?,'Saldo inicial provisório')",id(),'initial:'+fid,fid,balance,t,a.id,a.name);
   }
   await audit(tx,a,old?'Parâmetros atualizados':'Combustível cadastrado',fid,{before:old,after:{name,unit,capacity:capacity/1000,minimum:minimum/1000,lead,active:b.active!==false}});
   await openReplenishment(tx,fid,lead);
  });
  return {id:fid};
 }
 if(path==='requests/status'){
  requireProfile(a,['manager']);if(!['purchasing','cancelled'].includes(b.status))throw new AppError('Estado inválido.');
  const r=await first('SELECT * FROM requests WHERE id=?',idOf(b.id,'Solicitação'));if(!r||!['open','purchasing','partial'].includes(r.status))throw new AppError('Solicitação já encerrada.',409);
  const reason=text(b.reason,1200);if(b.status==='cancelled'&&!reason)throw new AppError('Informe a justificativa do cancelamento.');
  // "Em compra" vale somente para reposições ainda abertas: não apaga um recebimento parcial.
  const from=b.status==='purchasing'?['open']:['open','purchasing','partial'];
  if(!from.includes(r.status))throw new AppError('Esta reposição já está em compra ou com recebimento parcial.',409);
  await db().tx(async tx=>{
   const changed=await tx.run(`UPDATE requests SET status=? WHERE id=? AND status IN (${from.map(()=>'?').join(',')})`,b.status,r.id,...from);
   if(!changed)throw new AppError('A solicitação mudou. Atualize a tela.',409);
   await audit(tx,a,'Solicitação atualizada',r.id,{status:b.status,reason});
   if(b.status==='cancelled')await enqueue(tx,'cancelled',r.id,t,0,'requests');
  });
  return {ok:true};
 }
 if(path==='holidays'){
  requireProfile(a,['manager']);const date=isoDay(b.date);
  const name=b.remove?text(b.name,180):required(b.name,'Nome',180);
  await db().tx(async tx=>{
   if(b.remove)await tx.run('DELETE FROM holidays WHERE date=?',date);
   else await tx.run('INSERT INTO holidays(date,name) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET name=excluded.name',date,name);
   await audit(tx,a,b.remove?'Feriado removido':'Feriado cadastrado',date,{name});
  });
  return {ok:true};
 }
 if(path==='emails/test'){
  requireProfile(a,['manager']);
  if(!emailSetup().ready)throw new AppError('Configure o remetente e a chave privada do Resend antes de testar.',409);
  const key=required(b.operationKey,'Identificador do teste',80);if(!/^[A-Za-z0-9_-]{16,80}$/.test(key))throw new AppError('Identificador do teste inválido.');
  const recipient=await first("SELECT email FROM members WHERE id=? AND active=1 AND profile='manager'",a.id);
  if(!recipient)throw new AppError('Seu acesso mudou. Atualize a tela.',403);
  if(!recipient.email)throw new AppError('Cadastre um e-mail no seu usuário para receber o teste.',409);
  await sendResendEmail(recipient.email,'NAUTILUS · Teste de envio','Este é um teste solicitado pela sua conta de gestor. Nenhum dado de abastecimento foi incluído. Confira a chegada deste aviso na caixa de entrada e no spam.',`nautilus-test/${a.id}/${key}`);
  await db().tx(tx=>audit(tx,a,'Teste de e-mail solicitado',a.id,{accepted:true}));
  return {accepted:true,message:'O Resend aceitou o teste. Confira a chegada no e-mail do seu cadastro.'};
 }
 if(path==='emails/retry'){requireProfile(a,['manager']);const setup=emailSetup();if(!setup.ready||!setup.enabled)throw new AppError('Configure o remetente e ative os alertas antes de tentar novamente.',409);await db().run("UPDATE notifications SET attempts=0,last_error='',locked_at=NULL WHERE status='failed'");return {ok:true};}
 throw new AppError('Ação não encontrada.',404);
}

export async function exportCSV(url:URL,a:Member){
 requireProfile(a,['manager']);const kind=url.searchParams.get('kind')||'supplies',start=url.searchParams.get('start'),end=url.searchParams.get('end'),fuel=url.searchParams.get('fuel');
 const defs:Record<string,{query:string,datecol:string,alias:string,headers:string[],map:(r:Row)=>unknown[]}>= {
 supplies:{query:'SELECT s.* FROM supplies s',datecol:'s.occurred_at',alias:'s',headers:['ID','Data_UTC','Data_Local','Equipamento_ID','TAG','Equipamento','Operador_ID','Operador','Combustivel_ID','Combustivel','Quantidade','Unidade','Horimetro_Inicial','Horimetro_Final','Responsavel_ID','Responsavel_Lancamento','Lancado_Em_UTC','Situacao','Observacao','Justificativa_Cancelamento','Solicitacao_Abastecimento_ID'],map:r=>[r.id,r.occurred_at,new Date(r.occurred_at).toLocaleString('sv-SE',{timeZone:'America/Sao_Paulo'}),r.equipment_id,r.equipment_tag,r.equipment_name,r.operator_id,r.operator_name,r.fuel_id,r.fuel_name,r.quantity_milli/1000,r.unit,r.hourmeter_milli===null?'':r.hourmeter_milli/1000,r.hourmeter_end_milli===null?'':r.hourmeter_end_milli/1000,r.author_id,r.author_name,r.created_at,r.status,r.notes,r.cancel_reason,r.appointment_id]},
 movements:{query:'SELECT m.*,f.name fuel_name,f.unit FROM movements m JOIN fuels f ON f.id=m.fuel_id',datecol:'m.occurred_at',alias:'m',headers:['ID','Data_UTC','Combustivel_ID','Combustivel','Tipo','Quantidade_Com_Sinal','Saldo_Apos','Unidade','Abastecimento_ID','Solicitacao_ID','Responsavel_ID','Responsavel','Justificativa'],map:r=>[r.id,r.occurred_at,r.fuel_id,r.fuel_name,r.kind,r.delta_milli/1000,r.balance_after_milli===null?'':r.balance_after_milli/1000,r.unit,r.supply_id,r.request_id,r.author_id,r.author_name,r.reason]},
 requests:{query:'SELECT r.*,f.name fuel_name,f.unit FROM requests r JOIN fuels f ON f.id=r.fuel_id',datecol:'r.opened_at',alias:'r',headers:['ID','Combustivel_ID','Combustivel','Abertura_UTC','Prazo_UTC','Quantidade_Solicitada','Quantidade_Recebida','Unidade','Situacao'],map:r=>[r.id,r.fuel_id,r.fuel_name,r.opened_at,r.deadline,r.requested_milli/1000,r.received_milli/1000,r.unit,r.status]}
 };const def=defs[kind];if(!def)throw new AppError('Tipo de exportação inválido.');
 const where:string[]=[];const values:unknown[]=[];
 if(start){where.push(def.datecol+'>=?');values.push(new Date(isoDay(start)+'T00:00:00-03:00').toISOString());}
 if(end){where.push(def.datecol+'<=?');values.push(new Date(isoDay(end)+'T23:59:59.999-03:00').toISOString());}
 if(fuel&&fuel!=='all'){where.push(def.alias+'.fuel_id=?');values.push(fuel);}
 const filter=where.length?' WHERE '+where.join(' AND '):'';
 const total=(await first('SELECT count(*) total FROM ('+def.query+filter+') x',...values))?.total||0;
 if(total>10000)throw new AppError('Selecione um período menor: limite de 10.000 registros por exportação.',413);
 const lines=[def.headers.map(safeCSV).join(';')];
 for(let offset=0;offset<total;offset+=1000){const rows=await all(def.query+filter+' ORDER BY '+def.datecol+' ASC,'+def.alias+'.id ASC LIMIT 1000 OFFSET ?',...values,offset);lines.push(...rows.map(r=>def.map(r).map(safeCSV).join(';')));if(rows.length<1000)break;}
 await requireFresh(a);
 return new Response('﻿'+lines.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="nautilus_${kind}_${now().slice(0,10)}.csv"`,'Cache-Control':'no-store'}});
}
