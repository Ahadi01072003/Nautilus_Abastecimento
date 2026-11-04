// Portaria · leitura e trava do relatório diário, linhas de visita e o conteúdo consolidado do dia.
import {type Executor,type Row} from './db';
import {id,iso,maskDocument,type Base} from './portaria-core';

/** Relatório da data (cria se não existir) e trava a linha até o fim da transação: entradas, saídas,
 * correções e fechamento do mesmo dia passam um de cada vez. */
export async function lockReport(tx:Executor,base:Base,date:string){
 const created=await tx.run('INSERT INTO portaria_reports(id,base_id,op_date) VALUES(?,?,?::date) ON CONFLICT (base_id,op_date) DO NOTHING',id(),base.id,date);
 const r=(await tx.first('SELECT r.*,r.op_date::text date FROM portaria_reports r WHERE r.base_id=? AND r.op_date=?::date FOR UPDATE',base.id,date))!;
 return {...r,created:created>0} as Row&{created:boolean};
}
/** Todo evento que muda o conteúdo de um relatório acrescenta 1 ao contador que o fechamento confere. */
export async function bump(tx:Executor,reportIds:(string|null|undefined)[]){
 const ids=[...new Set(reportIds.filter(Boolean) as string[])];
 if(ids.length)await tx.run('UPDATE portaria_reports SET version=version+1 WHERE id = ANY(?::text[])',ids);
}

export const VISIT_SELECT=`SELECT v.*,er.op_date::text entry_date,xr.op_date::text exit_date
 FROM portaria_visits v JOIN portaria_reports er ON er.id=v.entry_report_id LEFT JOIN portaria_reports xr ON xr.id=v.exit_report_id`;

/** Linha de visita para a API. Listas usam o documento mascarado; a impressão e o detalhe, o completo. */
export function visitRow(v:Row,full=false){
 return {id:v.id,personId:v.person_id,personName:v.person_name,companyId:v.company_id,companyName:v.company_name,documentType:v.document_type,
  document:full?v.document_number:maskDocument(v.document_number),documentMasked:maskDocument(v.document_number),
  purpose:v.purpose,notes:v.notes,accessMode:v.access_mode,plateIn:v.plate_in,plateOut:v.plate_out,
  entryAt:iso(v.entry_at),exitAt:iso(v.exit_at),status:v.status,retroactive:!!v.retroactive,
  entryDate:v.entry_date,exitDate:v.exit_date||null,entryReportId:v.entry_report_id,exitReportId:v.exit_report_id||null,
  entryByName:v.entry_by_name,exitByName:v.exit_by_name||null,entryRegisteredAt:iso(v.entry_registered_at),exitRegisteredAt:iso(v.exit_registered_at),
  version:Number(v.version)};
}

export const reportRow=(r:Row)=>({id:r.id,date:r.date,status:r.status,version:Number(r.version),closedAt:iso(r.closed_at),closedByName:r.closed_by_name||null,reopenKind:r.reopen_kind||null,reopenReason:r.reopen_reason||null});

/** Conteúdo do dia: entradas e saídas da data, quem está na base agora e os totais. As saídas incluem
 * as de visitas iniciadas em dias anteriores. Anuladas ficam fora de tudo (só a contagem). */
export async function reportContent(ex:Executor,base:Base,report:Row,full=false,asOfDay=false){
 const [entries,exits,present,annulled]=await Promise.all([
  ex.all(`${VISIT_SELECT} WHERE v.entry_report_id=? AND v.status<>'anulada' ORDER BY v.entry_at,v.id`,report.id),
  ex.all(`${VISIT_SELECT} WHERE v.exit_report_id=? AND v.status='finalizada' ORDER BY v.exit_at,v.id`,report.id),
  asOfDay&&report.date?presentAtEndOfDay(ex,base,String(report.date)):ex.all(`${VISIT_SELECT} WHERE v.base_id=? AND v.status='em_andamento' ORDER BY v.entry_at,v.id`,base.id),
  ex.first("SELECT count(*)::int n FROM portaria_visits WHERE (entry_report_id=? OR exit_report_id=?) AND status='anulada'",report.id,report.id),
 ]);
 const companies=new Map<string,{companyId:string,companyName:string,entradas:number,people:Set<string>}>();
 for(const v of entries){
  const c=companies.get(v.company_id)||{companyId:v.company_id,companyName:v.company_name,entradas:0,people:new Set<string>()};
  c.entradas++;c.people.add(v.person_id);companies.set(v.company_id,c);
 }
 const entryRows=entries.map(v=>visitRow(v,full)),exitRows=exits.map(v=>({...visitRow(v,full),fromPreviousDay:v.entry_report_id!==report.id}));
 return {
  entries:entryRows,exits:exitRows,present:present.map(v=>visitRow(v,full)),
  totals:{entradas:entries.length,saidas:exits.length,pessoasUnicas:new Set(entries.map(v=>v.person_id)).size,presentes:present.length,
   saidasDeVisitasAnteriores:exits.filter(v=>v.entry_report_id!==report.id).length,anuladas:Number(annulled!.n)},
  byCompany:[...companies.values()].map(c=>({companyId:c.companyId,companyName:c.companyName,entradas:c.entradas,pessoasUnicas:c.people.size})).sort((a,b)=>a.companyName.localeCompare(b.companyName)),
 };
}

/** Quem estava na base no FIM do dia do relatório (meia-noite local seguinte, ou agora se o dia é hoje): entrou antes e
 * ainda não tinha saído. Um relatório antigo não herda quem entrou depois dele, e visita que atravessa a noite conta. */
export async function presentAtEndOfDay(ex:Executor,base:Base,date:string){
 const end="least(clock_timestamp(),((?::date+1)::timestamp AT TIME ZONE ?::text))";
 return ex.all(`${VISIT_SELECT} WHERE v.base_id=? AND v.status<>'anulada' AND v.entry_at<${end} AND (v.exit_at IS NULL OR v.exit_at>=${end}) ORDER BY v.entry_at,v.id`,
  base.id,date,base.timezone,date,base.timezone);
}

/** Identificação do conjunto de presentes (para o fechamento detectar mudança entre a conferência e o fechamento). */
export const presentToken=(present:Row[])=>present.map(v=>`${v.id}:${v.version}`).join('|');
