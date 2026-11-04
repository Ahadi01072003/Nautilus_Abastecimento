// Portaria · fechamento do relatório diário em revisões imutáveis. Fechar gera uma revisão (fotografia);
// reabrir não apaga nada e o próximo fechamento gera a revisão seguinte do mesmo relatório. Movimento
// gravado depois do fechamento nunca se perde: o relatório indica que há movimentos posteriores.
import {createHash} from 'node:crypto';
import {db,type Executor,type Row} from './db';
import {audit} from './registry';
import {type Member} from './permissions';
import {type Actor,id,fail,invalid,portaria,baseOf,iso,idempotent,longText,justificationOf,pageOf,localDate} from './portaria-core';
import {reportContent,presentToken,reportRow} from './portaria-data';
import {postCloseCount} from './portaria';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,24);
export const REOPEN_KINDS=['movimento_posterior','correcao'];

const versionRow=(v:Row)=>({id:v.id,number:Number(v.number),kind:v.kind,reason:v.reason||null,issuedAt:iso(v.issued_at),issuedByName:v.issued_by_name,closedWithPresent:Number(v.closed_with_present),closeJustification:v.close_justification||null,reportVersion:Number(v.report_version)});

async function loadReport(ex:Executor,reportId:unknown,lock=false){
 const r=await ex.first(`SELECT r.*,r.op_date::text date FROM portaria_reports r WHERE r.id=?${lock?' FOR UPDATE':''}`,String(reportId||''));
 if(!r)throw fail(404,'REPORT_NOT_FOUND','Relatório não encontrado.','reportId');
 return r;
}

/** Conferência antes de fechar: quem está na base, os totais e as marcas que o fechamento vai exigir. */
export async function reportCheck(member:Member,url:URL){
 await portaria(member);
 const base=await baseOf(db()),r=await loadReport(db(),url.searchParams.get('reportId'));
 const content=await reportContent(db(),base,r);
 return {report:reportRow(r),totals:content.totals,present:content.present,entries:content.entries.length,exits:content.exits.length,
  expectedVersion:Number(r.version),expectedPresent:hash(await presentToken(db(),base)),
  requiresConfirmation:content.present.length>0,canClose:r.status==='aberto',pendingAfterClose:await postCloseCount(db(),r),generatedAt:new Date().toISOString()};
}

/** Fecha o relatório: confere a versão e quem está na base, monta a revisão imutável e muda o estado. */
async function closeReport(a:Actor,b:Row){
 const expectedVersion=Number(b.expectedVersion);
 if(!Number.isInteger(expectedVersion)||expectedVersion<0)throw invalid('Informe a versão do relatório que foi conferida.','expectedVersion');
 if(typeof b.expectedPresent!=='string'||!b.expectedPresent)throw invalid('Informe a conferência de quem está na base.','expectedPresent');
 const justification=longText(b.justification,'Justificativa','justification',1000);
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/report/close',async()=>{
  const base=await baseOf(tx);
  const r=await loadReport(tx,b.reportId,true);
  if(r.base_id!==base.id)throw fail(404,'REPORT_NOT_FOUND','Relatório não encontrado.','reportId');
  if(r.status==='fechado'){
   const last=await tx.first('SELECT number FROM portaria_report_versions WHERE report_id=? ORDER BY number DESC LIMIT 1',r.id);
   throw fail(409,'REPORT_ALREADY_CLOSED','Este relatório já foi fechado. Para incluir movimentos novos, reabra o relatório.','reportId',{versionNumber:last?Number(last.number):null});
  }
  if(Number(r.version)!==expectedVersion)throw fail(409,'VERSION_CONFLICT','O relatório mudou desde a conferência (houve novo registro). Confira de novo antes de fechar.','expectedVersion',{currentVersion:Number(r.version)});
  const token=hash(await presentToken(tx,base));
  if(token!==b.expectedPresent)throw fail(409,'VERSION_CONFLICT','Quem está na base mudou desde a conferência. Confira de novo antes de fechar.','expectedPresent');
  const content=await reportContent(tx,base,r,true);
  const present=content.present;
  if(present.length){
   if(b.confirmPresent!==true)throw fail(409,'PRESENT_CONFIRMATION_REQUIRED',`Há ${present.length} pessoa(s) ainda na base. Confirme o fechamento e informe a justificativa para fechar com visitas em andamento.`,'confirmPresent',
    {present:present.map(v=>({visitId:v.id,personName:v.personName,companyName:v.companyName,entryAt:v.entryAt}))});
   if(!justification)throw fail(400,'JUSTIFICATION_REQUIRED','Informe a justificativa para fechar com visitas em andamento.','justification');
  }
  const last=await tx.first('SELECT coalesce(max(number),0)::int n FROM portaria_report_versions WHERE report_id=?',r.id);
  const number=Number(last!.n)+1;
  const kind=number===1?'original':r.reopen_kind==='correcao'?'retificada':'atualizada';
  const reason=number===1?null:r.reopen_reason||null;
  const snapshot={base:{id:base.id,name:base.name},date:r.date,timezone:base.timezone,reportId:r.id,number,kind,reason,
   closedWithPresent:present.length,closeJustification:justification||null,totals:content.totals,byCompany:content.byCompany,
   entries:content.entries,exits:content.exits,present:content.present,reportVersion:Number(r.version)};
  const vid=id();
  await tx.run(`INSERT INTO portaria_report_versions(id,report_id,number,kind,reason,report_version,snapshot,closed_with_present,close_justification,issued_by,issued_by_name)
   VALUES(?,?,?,?,?,?,?::text::jsonb,?,?,?,?)`,vid,r.id,number,kind,reason,Number(r.version),JSON.stringify(snapshot),present.length,justification||null,a.id,a.name);
  await tx.run("UPDATE portaria_reports SET status='fechado',closed_at=clock_timestamp(),closed_by=?,closed_by_name=?,reopen_kind=NULL,reopen_reason=NULL WHERE id=?",a.id,a.name,r.id);
  await audit(tx,a,'Portaria: relatório fechado',r.id,{date:r.date,revision:number,kind,present:present.length,justification:justification||undefined});
  const after=await loadReport(tx,r.id);
  const v=await tx.first('SELECT * FROM portaria_report_versions WHERE id=?',vid);
  return {report:reportRow(after),version:versionRow(v!),message:`Relatório de ${r.date.split('-').reverse().join('/')} fechado (revisão ${number}).`};
 }));
}

/** Reabre o relatório sem apagar nada: o próximo fechamento gera a revisão seguinte. */
async function reopenReport(a:Actor,b:Row){
 const kind=String(b.reasonKind||'');
 if(!REOPEN_KINDS.includes(kind))throw invalid('Informe o motivo da reabertura: movimento posterior ou correção.','reasonKind');
 const justification=justificationOf(b.justification);
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/report/reopen',async()=>{
  const r=await loadReport(tx,b.reportId,true);
  if(r.status!=='fechado')throw fail(409,'REPORT_NOT_CLOSED','Este relatório já está aberto.','reportId');
  await tx.run("UPDATE portaria_reports SET status='aberto',closed_at=NULL,closed_by=NULL,closed_by_name=NULL,reopen_kind=?,reopen_reason=?,version=version+1 WHERE id=?",kind,justification,r.id);
  await audit(tx,a,'Portaria: relatório reaberto',r.id,{date:r.date,reasonKind:kind,justification});
  const after=await loadReport(tx,r.id);
  return {report:reportRow(after),message:`Relatório de ${r.date.split('-').reverse().join('/')} reaberto. Ao fechar de novo será gerada a próxima revisão.`};
 }));
}

/** Histórico de relatórios: filtros por período e situação; "pending" mostra os com movimentos posteriores
 * e os antigos ainda abertos. */
export async function listReports(member:Member,url:URL){
 await portaria(member);
 const base=await baseOf(db()),today=localDate(new Date(),base.timezone),{limit,page,offset}=pageOf(url,100);
 const where=['r.base_id=?'],values:unknown[]=[base.id];
 const status=url.searchParams.get('status');if(status){if(!['aberto','fechado'].includes(status))throw invalid('Situação inválida.','status');where.push('r.status=?');values.push(status);}
 for(const [param,op] of [['from','>='],['to','<=']] as const){const v=url.searchParams.get(param);if(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v))throw invalid('Data inválida.',param);where.push(`r.op_date ${op} ?::date`);values.push(v);}}
 const cond=where.join(' AND ');
 const pendingExpr=`(SELECT count(*)::int FROM portaria_events e WHERE r.status='fechado' AND (e.report_id=r.id OR e.exit_report_id=r.id)
   AND e.registered_at>(SELECT max(issued_at) FROM portaria_report_versions x WHERE x.report_id=r.id))`;
 const rows=await db().all(`SELECT * FROM (SELECT r.*,r.op_date::text date,${pendingExpr} pending_after,
   (SELECT count(*)::int FROM portaria_visits v WHERE v.entry_report_id=r.id AND v.status<>'anulada') entradas,
   (SELECT count(*)::int FROM portaria_visits v WHERE v.exit_report_id=r.id AND v.status='finalizada') saidas,
   (SELECT coalesce(max(number),0)::int FROM portaria_report_versions x WHERE x.report_id=r.id) revisions
   FROM portaria_reports r WHERE ${cond}) q
   WHERE (?::boolean IS NOT TRUE OR pending_after>0 OR (status='aberto' AND date<?)) ORDER BY date DESC LIMIT ? OFFSET ?`,...values,url.searchParams.get('pending')==='1',today,limit+1,offset);
 return {rows:rows.slice(0,limit).map(r=>({...reportRow(r),entradas:r.entradas,saidas:r.saidas,revisions:r.revisions,pendingAfterClose:r.pending_after,staleOpen:r.status==='aberto'&&r.date<today})),page,limit,hasMore:rows.length>limit,today};
}

export async function reportVersions(member:Member,url:URL){
 await portaria(member);
 const r=await loadReport(db(),url.searchParams.get('reportId'));
 const rows=await db().all('SELECT * FROM portaria_report_versions WHERE report_id=? ORDER BY number DESC',r.id);
 return {report:reportRow(r),versions:rows.map(versionRow)};
}

/** Revisão pronta para imprimir: documentos completos (só porteiro e gestão chegam aqui). Cada consulta
 * para impressão vai para a auditoria. Resposta sem cache. */
export async function reportVersion(member:Member,url:URL){
 const a=await portaria(member);
 const reportId=url.searchParams.get('reportId'),versionId=url.searchParams.get('id');
 const base=await baseOf(db());
 if(versionId){
  const v=await db().first('SELECT * FROM portaria_report_versions WHERE id=?',versionId);
  if(!v)throw fail(404,'VERSION_NOT_FOUND','Revisão não encontrada.');
  const r=await loadReport(db(),v.report_id);
  const latest=await db().first('SELECT max(number)::int n FROM portaria_report_versions WHERE report_id=?',r.id);
  await db().tx(tx=>audit(tx,a,'Exportação: relatório da Portaria',v.id,{report:r.id,date:r.date,revision:Number(v.number)}));
  return {partial:false,report:reportRow(r),version:versionRow(v),latestNumber:Number(latest!.n),snapshot:v.snapshot as Row,generatedAt:new Date().toISOString(),printedBy:a.name};
 }
 // Relatório aberto: só como PARCIAL (nunca como revisão emitida).
 const r=await loadReport(db(),reportId);
 const content=await reportContent(db(),base,r,true);
 await db().tx(tx=>audit(tx,a,'Exportação: relatório da Portaria',r.id,{report:r.id,date:r.date,partial:true}));
 return {partial:true,report:reportRow(r),version:null,latestNumber:null,generatedAt:new Date().toISOString(),printedBy:a.name,
  snapshot:{base:{id:base.id,name:base.name},date:r.date,timezone:base.timezone,reportId:r.id,number:null,kind:'parcial',reason:null,closedWithPresent:content.present.length,closeJustification:null,
   totals:content.totals,byCompany:content.byCompany,entries:content.entries,exits:content.exits,present:content.present,reportVersion:Number(r.version)}};
}

export async function portariaReportMutate(path:string,b:Row,member:Member){
 const a=await portaria(member);
 if(path==='portaria/report/close')return closeReport(a,b);
 if(path==='portaria/report/reopen')return reopenReport(a,b);
 return null;
}

