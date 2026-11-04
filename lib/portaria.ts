// Portaria · núcleo do registro contínuo: entrada, saída, quem está na base e o relatório do dia.
// Cada operação grava na hora, em uma transação, travando a linha do relatório da data. Nada depende de
// sessão, navegador ou formulário aberto durante o dia.
import {db,type Executor,type Row} from './db';
import {audit} from './registry';
import {type Member} from './permissions';
import {type Actor,id,fail,invalid,portaria,baseOf,iso,localDate,instantOf,idempotent,textField,longText,plateOf,ACCESS_MODES,checkEventTime} from './portaria-core';
import {lockReport,bump,VISIT_SELECT,visitRow,reportRow,reportContent} from './portaria-data';

const clock=(d:Date,tz:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:tz,hour:'2-digit',minute:'2-digit'}).format(d);
const stamp=(d:Date|string,tz:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:tz,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(d)).replace(',','');

/** Data da consulta (padrão: hoje no fuso da base). Data futura é recusada. */
export function dateParam(value:unknown,timezone:string,field='date'){
 const today=localDate(new Date(),timezone);
 if(value==null||value==='')return today;
 const s=String(value);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw invalid('Data inválida.',field);
 if(s>today)throw invalid('A data não pode estar no futuro.',field);
 if(s<'2000-01-01')throw invalid('Data fora da faixa.',field);
 return s;
}

/** Entrada: cria a visita e o evento de entrada de forma atômica, no relatório da data da entrada. */
async function registerEntry(a:Actor,b:Row){
 const personId=textField(b.personId,'Pessoa','personId',100);
 const purpose=textField(b.purpose,'Objetivo da visita','purpose',200);
 const notes=longText(b.notes,'Observações','notes',500);
 const mode=String(b.accessMode||'');
 if(!ACCESS_MODES.includes(mode))throw invalid('Escolha o meio de acesso.','accessMode');
 const plateIn=plateOf(b.plateIn,mode==='veiculo','plateIn');
 if(mode!=='veiculo'&&plateIn)throw invalid('A placa só vale quando o meio de acesso é veículo.','plateIn');
 const justification=longText(b.justification,'Justificativa','justification',1000);
 const now=new Date(),occurred=instantOf(b.occurredAt,'Horário da entrada','occurredAt');
 const retro=checkEventTime(occurred,now,justification,'Entrada');
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/entry',async()=>{
  const base=await baseOf(tx);
  // A pessoa fica travada: entradas, correções e restaurações dela passam uma de cada vez.
  const p=await tx.first(`SELECT p.*,coalesce(o.name,c.name) company_name FROM portaria_people p JOIN portaria_companies c ON c.id=p.company_id
   LEFT JOIN requester_orgs o ON o.id=c.org_id WHERE p.id=? FOR UPDATE OF p`,personId);
  if(!p)throw fail(404,'PERSON_NOT_FOUND','Pessoa não encontrada.','personId');
  if(!p.active)throw fail(409,'PERSON_INACTIVE',`${p.name} está inativo no cadastro e não pode iniciar uma visita. Peça à gestão para reativar o cadastro.`,'personId');
  const open=await tx.first(`${VISIT_SELECT} WHERE v.person_id=? AND v.status='em_andamento'`,p.id);
  if(open)throw fail(409,'ALREADY_PRESENT',`${p.name} já está na base desde ${stamp(open.entry_at,base.timezone)}. Registre a saída antes de uma nova entrada.`,'personId',{visitId:open.id,entryAt:iso(open.entry_at)});
  const report=await lockReport(tx,base,localDate(occurred,base.timezone));
  const vid=id();
  try{
   await tx.run(`INSERT INTO portaria_visits(id,base_id,person_id,person_name,document_type,document_number,company_id,company_name,purpose,notes,access_mode,plate_in,entry_at,status,entry_report_id,entry_by,entry_by_name,retroactive)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?::timestamptz,'em_andamento',?,?,?,?)`,vid,base.id,p.id,p.name,p.document_type,p.document_number,p.company_id,p.company_name,purpose,notes,mode,plateIn,occurred.toISOString(),report.id,a.id,a.name,retro?1:0);
  }catch(e){
   const m=(e as {message?:string}).message||'';
   if(/portaria_visits_open/.test(m))throw fail(409,'ALREADY_PRESENT',`${p.name} já está na base. Registre a saída antes de uma nova entrada.`,'personId');
   if(/Pessoa já tem visita/.test(m))throw fail(409,'VISIT_OVERLAP',`${p.name} já tem uma visita registrada nesse intervalo. Confira o horário da entrada.`,'occurredAt');
   throw e;
  }
  await tx.run(`INSERT INTO portaria_events(id,visit_id,report_id,kind,occurred_at,actor_id,actor_name,justification,after) VALUES(?,?,?,'entrada',?::timestamptz,?,?,?,?::text::jsonb)`,
   id(),vid,report.id,occurred.toISOString(),a.id,a.name,justification||null,JSON.stringify({purpose,accessMode:mode,plateIn,entryAt:occurred.toISOString()}));
  await bump(tx,[report.id]);
  await audit(tx,a,'Portaria: entrada registrada',vid,{person:p.id,company:p.company_id,date:report.date,retroactive:retro,justification:justification||undefined});
  const v=(await tx.first(`${VISIT_SELECT} WHERE v.id=?`,vid))!;
  const after=await tx.first('SELECT r.*,r.op_date::text date FROM portaria_reports r WHERE r.id=?',report.id);
  const late=report.status==='fechado';
  return {id:vid,visit:visitRow(v),report:reportRow(after!),postClose:late,
   message:`${p.name} entrou às ${clock(occurred,base.timezone)}.${late?' O relatório do dia já estava fechado: o movimento fica pendente de uma nova revisão.':''}`};
 }));
}

/** Saída: identifica a visita pelo id (nunca escolhe sozinho), grava o evento e finaliza na mesma transação. */
async function registerExit(a:Actor,b:Row){
 const visitId=textField(b.visitId,'Visita','visitId',100);
 const version=Number(b.version);
 if(!Number.isInteger(version)||version<0)throw invalid('Informe a versão da visita que está na tela.','version');
 const plateOut=plateOf(b.plateOut,false,'plateOut');
 const justification=longText(b.justification,'Justificativa','justification',1000);
 const now=new Date(),occurred=instantOf(b.occurredAt,'Horário da saída','occurredAt');
 const retro=checkEventTime(occurred,now,justification,'Saída');
 return await db().tx(tx=>idempotent(tx,a,b,'portaria/exit',async()=>{
  const base=await baseOf(tx);
  const report=await lockReport(tx,base,localDate(occurred,base.timezone));
  const v=await tx.first('SELECT * FROM portaria_visits WHERE id=? AND base_id=? FOR UPDATE',visitId,base.id);
  if(!v)throw fail(404,'VISIT_NOT_FOUND','Visita não encontrada.','visitId');
  if(v.status!=='em_andamento'){
   const why=v.status==='anulada'?'foi anulada':`já teve a saída registrada${v.exit_at?' às '+stamp(v.exit_at,base.timezone):''}`;
   throw fail(409,'VISIT_NOT_IN_PROGRESS',`A visita de ${v.person_name} ${why}.`,'visitId',{status:v.status,exitAt:iso(v.exit_at)});
  }
  if(Number(v.version)!==version)throw fail(409,'VERSION_CONFLICT','A visita foi alterada em outra tela. Atualize para continuar.','version',{currentVersion:Number(v.version)});
  if(occurred.getTime()<new Date(v.entry_at).getTime())throw fail(400,'EXIT_BEFORE_ENTRY',`A saída não pode ser antes da entrada (${stamp(v.entry_at,base.timezone)}).`,'occurredAt');
  await tx.run(`UPDATE portaria_visits SET status='finalizada',exit_at=?::timestamptz,plate_out=?,exit_report_id=?,exit_by=?,exit_by_name=?,exit_registered_at=clock_timestamp(),
   retroactive=greatest(retroactive,?::smallint),version=version+1,updated_at=now() WHERE id=?`,occurred.toISOString(),plateOut,report.id,a.id,a.name,retro?1:0,v.id);
  await tx.run(`INSERT INTO portaria_events(id,visit_id,report_id,kind,occurred_at,actor_id,actor_name,justification,after) VALUES(?,?,?,'saida',?::timestamptz,?,?,?,?::text::jsonb)`,
   id(),v.id,report.id,occurred.toISOString(),a.id,a.name,justification||null,JSON.stringify({exitAt:occurred.toISOString(),plateOut}));
  await bump(tx,[report.id]);
  await audit(tx,a,'Portaria: saída registrada',v.id,{person:v.person_id,date:report.date,retroactive:retro,justification:justification||undefined});
  const updated=(await tx.first(`${VISIT_SELECT} WHERE v.id=?`,v.id))!;
  const after=await tx.first('SELECT r.*,r.op_date::text date FROM portaria_reports r WHERE r.id=?',report.id);
  const late=report.status==='fechado';
  return {id:v.id,visit:visitRow(updated),report:reportRow(after!),postClose:late,
   message:`${v.person_name} saiu às ${clock(occurred,base.timezone)}.${late?' O relatório do dia já estava fechado: o movimento fica pendente de uma nova revisão.':''}`};
 }));
}

/** Relatório do dia: criado na primeira movimentação (ou aqui, ao abrir o dia); não duplica. */
async function openReport(a:Actor,b:Row){
 return await db().tx(async tx=>{
  const base=await baseOf(tx),date=dateParam(b.date,base.timezone);
  const r=await lockReport(tx,base,date);
  if(r.created)await audit(tx,a,'Portaria: relatório do dia aberto',r.id,{date});
  return {created:!!r.created,report:reportRow(r)};
 });
}

/** Quem está na base agora (visitas em andamento, inclusive as de dias anteriores). */
export async function presentNow(member:Member){
 await portaria(member);
 const base=await baseOf(db()),today=localDate(new Date(),base.timezone);
 const rows=await db().all(`${VISIT_SELECT} WHERE v.base_id=? AND v.status='em_andamento' ORDER BY v.entry_at,v.id`,base.id);
 return {rows:rows.map(v=>({...visitRow(v),fromPreviousDay:v.entry_date<today})),count:rows.length,timezone:base.timezone,generatedAt:new Date().toISOString()};
}

/** Movimentos gravados depois da última revisão emitida (relatório fechado). */
export async function postCloseCount(ex:Executor,report:Row){
 if(report.status!=='fechado')return 0;
 const r=await ex.first(`SELECT count(*)::int n FROM portaria_events e WHERE (e.report_id=? OR e.exit_report_id=?)
  AND e.registered_at>(SELECT max(issued_at) FROM portaria_report_versions WHERE report_id=?)`,report.id,report.id,report.id);
 return Number(r?.n||0);
}

/** Visão do relatório de uma data: situação, entradas, saídas, presentes, totais e revisões. */
export async function dayReport(member:Member,url:URL){
 await portaria(member);
 const base=await baseOf(db()),date=dateParam(url.searchParams.get('date'),base.timezone);
 const today=localDate(new Date(),base.timezone);
 const r=await db().first('SELECT r.*,r.op_date::text date FROM portaria_reports r WHERE r.base_id=? AND r.op_date=?::date',base.id,date);
 const content=await reportContent(db(),base,r||{id:''});
 const versions=r?await db().all('SELECT id,number,kind,reason,issued_at,issued_by_name,closed_with_present FROM portaria_report_versions WHERE report_id=? ORDER BY number',r.id):[];
 const older=await db().all("SELECT id,op_date::text date FROM portaria_reports WHERE base_id=? AND status='aberto' AND op_date<?::date ORDER BY op_date",base.id,today);
 return {exists:!!r,date,today,timezone:base.timezone,base:{id:base.id,name:base.name},report:r?reportRow(r):null,...content,
  pendingAfterClose:r?await postCloseCount(db(),r):0,
  versions:versions.map(v=>({id:v.id,number:Number(v.number),kind:v.kind,reason:v.reason,issuedAt:iso(v.issued_at),issuedByName:v.issued_by_name,closedWithPresent:Number(v.closed_with_present)})),
  olderOpenReports:older.map(o=>({id:o.id,date:o.date})),generatedAt:new Date().toISOString()};
}

export async function portariaCoreMutate(path:string,b:Row,member:Member){
 const a=await portaria(member);
 if(path==='portaria/entry')return registerEntry(a,b);
 if(path==='portaria/exit')return registerExit(a,b);
 if(path==='portaria/report/open')return openReport(a,b);
 return null;
}
