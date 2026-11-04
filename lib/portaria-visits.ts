// Portaria · correções, anulações, desfazer saída e restauração, mais as consultas de visitas. Nada é
// apagado: cada alteração grava um evento com o antes e o depois, a justificativa e quem fez. Alterar o
// que já entrou numa revisão emitida exige reabrir o relatório (não se muda fotografia emitida).
import {db,type Executor,type Row} from './db';
import {audit} from './registry';
import {type Member} from './permissions';
import {type Actor,id,fail,invalid,portaria,onlyManager,baseOf,iso,localDate,instantOf,idempotent,textField,longText,justificationOf,plateOf,ACCESS_MODES,checkEventTime,pageOf,likeOf,maskDocument} from './portaria-core';
import {lockReport,bump,VISIT_SELECT,visitRow} from './portaria-data';
import {resolveCompany} from './portaria-people';

const FIELDS=['personId','companyId','purpose','notes','accessMode','plateIn','plateOut','entryAt','exitAt'];
const snap=(v:Row)=>({personId:v.person_id,personName:v.person_name,documentMasked:maskDocument(v.document_number),companyId:v.company_id,companyName:v.company_name,purpose:v.purpose,notes:v.notes,
 accessMode:v.access_mode,plateIn:v.plate_in,plateOut:v.plate_out,entryAt:iso(v.entry_at),exitAt:iso(v.exit_at),status:v.status});

/** Trava as pessoas (em ordem fixa, como a entrada) e os relatórios das datas envolvidas (por data), e
 * confere que todos estão abertos. Devolve os relatórios por data. */
async function lockScope(tx:Executor,base:Awaited<ReturnType<typeof baseOf>>,people:string[],dates:(string|null|undefined)[]){
 const ids=[...new Set(people)].sort();
 if(ids.length)await tx.all('SELECT id FROM portaria_people WHERE id = ANY(?::text[]) ORDER BY id FOR UPDATE',ids);
 const reports=new Map<string,Row>();
 for(const d of [...new Set(dates.filter(Boolean) as string[])].sort())reports.set(d,await lockReport(tx,base,d));
 const closed=[...reports.values()].filter(r=>r.status==='fechado');
 if(closed.length)throw fail(409,'REPORT_CLOSED',`Esta alteração mexe no relatório de ${closed.map(r=>r.date.split('-').reverse().join('/')).join(', ')}, que já foi fechado. Reabra o relatório (com a justificativa) antes de alterar.`,'reportId',
  {reports:closed.map(r=>({id:r.id,date:r.date}))});
 return reports;
}

async function loadVisit(tx:Executor,base:{id:string},visitId:unknown,lock=false){
 const v=await tx.first(`${VISIT_SELECT} WHERE v.id=? AND v.base_id=?${lock?' FOR UPDATE OF v':''}`,String(visitId||''),base.id);
 if(!v)throw fail(404,'VISIT_NOT_FOUND','Visita não encontrada.','visitId');
 return v;
}
function checkVersion(v:Row,version:unknown){
 const n=Number(version);
 if(!Number.isInteger(n)||n<0)throw invalid('Informe a versão da visita que está na tela.','version');
 if(Number(v.version)!==n)throw fail(409,'VERSION_CONFLICT','A visita foi alterada em outra tela. Atualize para continuar.','version',{currentVersion:Number(v.version)});
}
function overlapError(e:unknown,name:string,field='occurredAt'){
 const m=(e as {message?:string}).message||'';
 if(/portaria_visits_open/.test(m))return fail(409,'ALREADY_PRESENT',`${name} já tem uma visita em andamento na base.`,'personId');
 if(/Pessoa já tem visita/.test(m))return fail(409,'VISIT_OVERLAP',`${name} já tem uma visita registrada nesse intervalo. Confira os horários.`,field);
 return e;
}
async function finish(tx:Executor,a:Actor,v:Row,kind:'correcao'|'anulacao'|'desfazer_saida'|'restauracao',action:string,before:Row,justification:string,entryReport:Row,exitReport:Row|null,extraReports:Row[]=[]){
 const after=(await loadVisit(tx,{id:v.base_id},v.id))!;
 await tx.run('INSERT INTO portaria_events(id,visit_id,report_id,exit_report_id,kind,occurred_at,actor_id,actor_name,justification,before,after) VALUES(?,?,?,?,?,now(),?,?,?,?::text::jsonb,?::text::jsonb)',
  id(),v.id,entryReport.id,exitReport?.id||null,kind,a.id,a.name,justification,JSON.stringify(before),JSON.stringify(snap(after)));
 await bump(tx,[entryReport.id,exitReport?.id,...extraReports.map(r=>r.id)]);
 await audit(tx,a,action,v.id,{person:after.person_id,kind,justification,reports:[entryReport.date,exitReport?.date].filter(Boolean)});
 return after;
}

/** Corrige dados da visita (pessoa, empresa, objetivo, observações, meio de acesso, placas, horários). */
async function correctVisit(a:Actor,b:Row){
 const changes=(b.changes&&typeof b.changes==='object'&&!Array.isArray(b.changes)?b.changes:null) as Row|null;
 if(!changes||!Object.keys(changes).length)throw invalid('Informe o que será corrigido.','changes');
 const unknown=Object.keys(changes).filter(k=>!FIELDS.includes(k));
 if(unknown.length)throw invalid(`Campo não pode ser corrigido: ${unknown.join(', ')}.`,'changes');
 const justification=justificationOf(b.justification);
 const now=new Date();
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/visit/correct',async()=>{
  const base=await baseOf(tx);
  const seen=await loadVisit(tx,base,b.visitId);
  const newPerson='personId' in changes?String(changes.personId||''):null;
  if('entryAt' in changes&&!changes.entryAt)throw invalid('Informe o horário da entrada.','entryAt');
  const entryAt='entryAt' in changes?instantOf(changes.entryAt,'Horário da entrada','entryAt'):new Date(seen.entry_at);
  const exitAt='exitAt' in changes?(changes.exitAt?instantOf(changes.exitAt,'Horário da saída','exitAt'):null):seen.exit_at?new Date(seen.exit_at):null;
  const tz=base.timezone;
  const dates=[seen.entry_date,seen.exit_date,localDate(entryAt,tz),exitAt?localDate(exitAt,tz):null];
  const reports=await lockScope(tx,base,[seen.person_id,...(newPerson?[newPerson]:[])],dates);
  const v=await loadVisit(tx,base,b.visitId,true);
  checkVersion(v,b.version);
  if(v.status==='anulada')throw fail(409,'VISIT_ANNULLED','Esta visita foi anulada. A gestão pode restaurá-la antes de qualquer correção.','visitId');
  if(('exitAt' in changes||'plateOut' in changes)&&v.status!=='finalizada')throw invalid('A saída só pode ser corrigida em visita finalizada.','exitAt');
  if(v.status==='finalizada'&&!exitAt)throw invalid('Para desfazer uma saída lançada por engano, use "desfazer saída".','exitAt');
  if('entryAt' in changes)checkEventTime(entryAt,now,justification,'Entrada');
  if(exitAt&&'exitAt' in changes)checkEventTime(exitAt,now,justification,'Saída');
  if(exitAt&&exitAt.getTime()<entryAt.getTime())throw fail(400,'EXIT_BEFORE_ENTRY','A saída não pode ser antes da entrada.','exitAt');
  // Pessoa, empresa e dados copiados.
  let personId=v.person_id,name=v.person_name,docType=v.document_type,docNumber=v.document_number,companyId=v.company_id,companyName=v.company_name;
  if(newPerson&&newPerson!==v.person_id){
   const p=await tx.first('SELECT p.*,coalesce(o.name,c.name) company_name FROM portaria_people p JOIN portaria_companies c ON c.id=p.company_id LEFT JOIN requester_orgs o ON o.id=c.org_id WHERE p.id=?',newPerson);
   if(!p)throw fail(404,'PERSON_NOT_FOUND','Pessoa não encontrada.','personId');
   if(!p.active)throw fail(409,'PERSON_INACTIVE',`${p.name} está inativo no cadastro.`,'personId');
   if(v.status==='em_andamento'){
    const open=await tx.first("SELECT id FROM portaria_visits WHERE base_id=? AND person_id=? AND status='em_andamento' AND id<>?",base.id,p.id,v.id);
    if(open)throw fail(409,'ALREADY_PRESENT',`${p.name} já está na base. Registre a saída antes de passar esta visita para ${p.name}.`,'personId',{visitId:open.id});
   }
   personId=p.id;name=p.name;docType=p.document_type;docNumber=p.document_number;companyId=p.company_id;companyName=p.company_name;
  }
  if('companyId' in changes){const c=await resolveCompany(tx,a,changes.companyId);companyId=c.id;companyName=c.name;}
  const purpose='purpose' in changes?textField(changes.purpose,'Objetivo da visita','purpose',200):v.purpose;
  const notes='notes' in changes?longText(changes.notes,'Observações','notes',500):v.notes;
  const mode='accessMode' in changes?String(changes.accessMode||''):v.access_mode;
  if(!ACCESS_MODES.includes(mode))throw invalid('Escolha o meio de acesso.','accessMode');
  const plateIn='plateIn' in changes?plateOf(changes.plateIn,mode==='veiculo','plateIn'):mode==='veiculo'?plateOf(v.plate_in,true,'plateIn'):null;
  if(mode!=='veiculo'&&'plateIn' in changes&&plateIn)throw invalid('A placa só vale quando o meio de acesso é veículo.','plateIn');
  const plateOut='plateOut' in changes?plateOf(changes.plateOut,false,'plateOut'):v.plate_out;
  const entryReport=reports.get(localDate(entryAt,tz))!,exitReport=exitAt?reports.get(localDate(exitAt,tz))!:null;
  const before=snap(v);
  try{
   await tx.run(`UPDATE portaria_visits SET person_id=?,person_name=?,document_type=?,document_number=?,company_id=?,company_name=?,purpose=?,notes=?,access_mode=?,plate_in=?,plate_out=?,
    entry_at=?::timestamptz,exit_at=?::timestamptz,entry_report_id=?,exit_report_id=?,version=version+1,updated_at=now() WHERE id=?`,
    personId,name,docType,docNumber,companyId,companyName,purpose,notes,mode,plateIn,plateOut,entryAt.toISOString(),exitAt?exitAt.toISOString():null,entryReport.id,exitReport?.id||null,v.id);
  }catch(e){throw overlapError(e,name);}
  const old=[reports.get(v.entry_date),v.exit_date?reports.get(v.exit_date):null].filter(Boolean) as Row[];
  const after=await finish(tx,a,v,'correcao','Portaria: visita corrigida',before,justification,entryReport,exitReport,old);
  return {id:v.id,visit:visitRow(after),message:'Visita corrigida. O histórico guarda os valores anteriores.'};
 }));
}

/** Anula a visita: continua rastreável, sai dos indicadores e libera a presença sem criar saída falsa. */
async function annulVisit(a:Actor,b:Row){
 const justification=justificationOf(b.justification);
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/visit/annul',async()=>{
  const base=await baseOf(tx);
  const seen=await loadVisit(tx,base,b.visitId);
  const reports=await lockScope(tx,base,[seen.person_id],[seen.entry_date,seen.exit_date]);
  const v=await loadVisit(tx,base,b.visitId,true);
  checkVersion(v,b.version);
  if(v.status==='anulada')throw fail(409,'VISIT_ANNULLED','Esta visita já foi anulada.','visitId');
  const before=snap(v);
  await tx.run("UPDATE portaria_visits SET status='anulada',version=version+1,updated_at=now() WHERE id=?",v.id);
  const after=await finish(tx,a,v,'anulacao','Portaria: visita anulada',before,justification,reports.get(v.entry_date)!,v.exit_date?reports.get(v.exit_date)!:null);
  return {id:v.id,visit:visitRow(after),message:`Visita de ${v.person_name} anulada.`};
 }));
}

/** Desfaz uma saída lançada por engano: a visita volta a "em andamento" (revalida a presença). */
async function undoExit(a:Actor,b:Row){
 const justification=justificationOf(b.justification);
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/visit/undo-exit',async()=>{
  const base=await baseOf(tx);
  const seen=await loadVisit(tx,base,b.visitId);
  const reports=await lockScope(tx,base,[seen.person_id],[seen.exit_date]);
  const v=await loadVisit(tx,base,b.visitId,true);
  checkVersion(v,b.version);
  if(v.status!=='finalizada')throw fail(409,'VISIT_NOT_FINISHED','Só uma visita finalizada tem saída para desfazer.','visitId');
  const open=await tx.first("SELECT id FROM portaria_visits WHERE person_id=? AND status='em_andamento' AND id<>?",v.person_id,v.id);
  if(open)throw fail(409,'ALREADY_PRESENT',`${v.person_name} já tem outra visita em andamento. Dê saída nela antes de desfazer esta.`,'visitId',{visitId:open.id});
  const before=snap(v),exitReport=reports.get(v.exit_date)!;
  try{
   await tx.run(`UPDATE portaria_visits SET status='em_andamento',exit_at=NULL,plate_out=NULL,exit_report_id=NULL,exit_by=NULL,exit_by_name=NULL,exit_registered_at=NULL,version=version+1,updated_at=now() WHERE id=?`,v.id);
  }catch(e){throw overlapError(e,v.person_name);}
  const after=await finish(tx,a,v,'desfazer_saida','Portaria: saída desfeita',before,justification,exitReport,null);
  return {id:v.id,visit:visitRow(after),message:`Saída de ${v.person_name} desfeita: a visita voltou a estar em andamento.`};
 }));
}

/** Restaura uma visita anulada (gestão): revalida a presença e os horários. */
async function restoreVisit(a:Actor,b:Row){
 onlyManager(a);
 const justification=justificationOf(b.justification);
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/visit/restore',async()=>{
  const base=await baseOf(tx);
  const seen=await loadVisit(tx,base,b.visitId);
  const reports=await lockScope(tx,base,[seen.person_id],[seen.entry_date,seen.exit_date]);
  const v=await loadVisit(tx,base,b.visitId,true);
  if(b.version!=null)checkVersion(v,b.version);
  if(v.status!=='anulada')throw fail(409,'VISIT_NOT_ANNULLED','Só uma visita anulada pode ser restaurada.','visitId');
  const target=v.exit_at?'finalizada':'em_andamento';
  if(target==='em_andamento'){
   const open=await tx.first("SELECT id FROM portaria_visits WHERE person_id=? AND status='em_andamento' AND id<>?",v.person_id,v.id);
   if(open)throw fail(409,'ALREADY_PRESENT',`${v.person_name} já tem outra visita em andamento.`,'visitId',{visitId:open.id});
  }
  const before=snap(v);
  try{await tx.run('UPDATE portaria_visits SET status=?,version=version+1,updated_at=now() WHERE id=?',target,v.id);}catch(e){throw overlapError(e,v.person_name);}
  const after=await finish(tx,a,v,'restauracao','Portaria: visita restaurada',before,justification,reports.get(v.entry_date)!,v.exit_date?reports.get(v.exit_date)!:null);
  return {id:v.id,visit:visitRow(after),message:`Visita de ${v.person_name} restaurada.`};
 }));
}

export async function portariaVisitMutate(path:string,b:Row,member:Member){
 const a=await portaria(member);
 if(path==='portaria/visit/correct')return correctVisit(a,b);
 if(path==='portaria/visit/annul')return annulVisit(a,b);
 if(path==='portaria/visit/undo-exit')return undoExit(a,b);
 if(path==='portaria/visit/restore')return restoreVisit(a,b);
 return null;
}

/** Visitas filtradas e paginadas (documento mascarado). */
export async function listVisits(member:Member,url:URL){
 await portaria(member);
 const base=await baseOf(db()),{limit,page,offset}=pageOf(url,100);
 const where=['v.base_id=?'],values:unknown[]=[base.id];
 const day=(param:string)=>{const s=url.searchParams.get(param);if(!s)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(Date.parse(s+'T00:00:00Z')))throw invalid('Data inválida.',param);return s;};
 const from=day('from'),to=day('to');
 if(from){where.push("v.entry_at>=(?::date::timestamp AT TIME ZONE ?)");values.push(from,base.timezone);}
 if(to){where.push("v.entry_at<((?::date+1)::timestamp AT TIME ZONE ?)");values.push(to,base.timezone);}
 const eq=(param:string,col:string)=>{const s=url.searchParams.get(param);if(s){where.push(`${col}=?`);values.push(s);}};
 eq('personId','v.person_id');eq('companyId','v.company_id');
 const plate=(url.searchParams.get('plate')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(plate){where.push('(v.plate_in=? OR v.plate_out=?)');values.push(plate,plate);}
 const status=url.searchParams.get('status');
 if(status){if(!['em_andamento','finalizada','anulada'].includes(status))throw invalid('Situação inválida.','status');where.push('v.status=?');values.push(status);}
 const reportStatus=url.searchParams.get('reportStatus');
 if(reportStatus){if(!['aberto','fechado'].includes(reportStatus))throw invalid('Situação do relatório inválida.','reportStatus');where.push('er.status=?');values.push(reportStatus);}
 if(url.searchParams.get('present')==='1')where.push("v.status='em_andamento'");
 if(url.searchParams.get('pendingAfterClose')==='1')where.push(`EXISTS (SELECT 1 FROM portaria_events e JOIN portaria_reports r ON r.id=e.report_id AND r.status='fechado'
  WHERE e.visit_id=v.id AND e.registered_at>(SELECT max(issued_at) FROM portaria_report_versions x WHERE x.report_id=r.id))`);
 const q=(url.searchParams.get('q')||'').trim().slice(0,80);
 if(q){where.push('(v.person_name ILIKE ? OR v.company_name ILIKE ?)');values.push(likeOf(q),likeOf(q));}
 const rows=await db().all(`${VISIT_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.entry_at DESC,v.id LIMIT ? OFFSET ?`,...values,limit+1,offset);
 return {rows:rows.slice(0,limit).map(v=>visitRow(v)),page,limit,hasMore:rows.length>limit,timezone:base.timezone};
}

/** Detalhe da visita com o documento completo, os eventos e os relatórios ligados (consulta auditada). */
export async function visitDetail(member:Member,url:URL){
 const a=await portaria(member);
 const base=await baseOf(db());
 const v=await loadVisit(db(),base,url.searchParams.get('id'));
 const [events,reports]=await Promise.all([
  db().all('SELECT kind,occurred_at,registered_at,actor_name,justification,before,after FROM portaria_events WHERE visit_id=? ORDER BY registered_at,id',v.id),
  db().all("SELECT r.id,r.op_date::text date,r.status,(SELECT max(number)::int FROM portaria_report_versions x WHERE x.report_id=r.id) revision FROM portaria_reports r WHERE r.id IN (?,?)",v.entry_report_id,v.exit_report_id||v.entry_report_id),
 ]);
 await db().tx(tx=>audit(tx,a,'Portaria: documento consultado',v.id,{visit:v.id,documentMasked:maskDocument(v.document_number)}));
 return {visit:visitRow(v,true),events:events.map(e=>({kind:e.kind,occurredAt:iso(e.occurred_at),registeredAt:iso(e.registered_at),actorName:e.actor_name,justification:e.justification||null,before:e.before||null,after:e.after||null})),
  reports:reports.map(r=>({id:r.id,date:r.date,status:r.status,revision:r.revision||null,role:r.id===v.entry_report_id?'entrada':'saida'}))};
}
