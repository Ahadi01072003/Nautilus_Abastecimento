// Portaria · fechamento do relatório diário: conferência, fechamento com pessoas presentes, revisão
// imutável, movimentos depois do fechamento, reabertura e consultas. Dados fictícios.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {type Member} from '../lib/permissions';
import {portariaPeopleMutate} from '../lib/portaria-people';
import {portariaCoreMutate,presentNow,dayReport} from '../lib/portaria';
import {portariaReportMutate,reportCheck,listReports,reportVersions,reportVersion} from '../lib/portaria-reports';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,porteiro:Member,porteiro2:Member,operator:Member,orgId:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,code:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const core=(path:string,b:Row,who:Member=porteiro)=>portariaCoreMutate('portaria/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const rep=(path:string,b:Row,who:Member=porteiro)=>portariaReportMutate('portaria/report/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const at=(day:number,h:number,m=0)=>new Date(Date.UTC(2025,3,day,h+3,m)).toISOString();
const late={justification:'Digitação posterior de teste'};
let n=0;
async function person(name='Visitante Teste'){
 return (await portariaPeopleMutate('portaria/person/quick',{idempotencyKey:key(),name,documentType:'CPF',documentNumber:`700.000.${String(++n).padStart(3,'0')}-22`,companyId:'org:'+orgId},porteiro) as Row).id as string;
}
const entry=(p:string,day:number,h:number,who:Member=porteiro)=>core('entry',{personId:p,purpose:'Reunião',accessMode:'a_pe',occurredAt:at(day,h),...late},who);
const exit=(v:Row,day:number,h:number,m=0)=>core('exit',{visitId:(v.visit as Row).id,version:(v.visit as Row).version,occurredAt:at(day,h,m),...late});
const open=async(day:number)=>(await core('report/open',{date:`2025-04-${String(day).padStart(2,'0')}`}) as Row).report as Row;
/** Conferência e fechamento do dia, como a tela faz. */
async function close(report:Row,extra:Row={},who:Member=porteiro){
 const c=await reportCheck(who,url({reportId:report.id as string}));
 return rep('close',{reportId:report.id,expectedVersion:c.expectedVersion,expectedPresent:c.expectedPresent,...extra},who);
}
/** Dá saída em quem estiver na base, para os testes que precisam do relatório sem presentes. */
async function clearPresent(){
 for(const v of (await presentNow(porteiro)).rows as Row[])
  await core('exit',{visitId:v.id,version:v.version,occurredAt:new Date(Math.max(Date.parse(v.entryAt as string)+60000,0)).toISOString(),...late});
}

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 porteiro=await set(await addMember(db,'porteiro'),[],'porteiro');
 porteiro2=await set(await addMember(db,'porteiro'),[],'porteiro');
 operator=await set(await addMember(db,'operator'),[],'operator');
 orgId=(await registryMutate('registry/orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

test('fechar: gera a revisão 1 (original) com totais e documentos completos; reenvio idempotente; segundo fechamento recusado',async()=>{
 const [a,b]=[await person('Fechar A'),await person('Fechar B')];
 const ea=await entry(a,1,8),eb=await entry(b,1,9);
 await exit(ea,1,12);await exit(eb,1,13);
 const r=await open(1);
 const c=await reportCheck(porteiro,url({reportId:r.id as string}));
 assert.equal(c.requiresConfirmation,false);assert.equal(c.canClose,true);assert.equal((c.totals as Row).entradas,2);
 const k=key(),body={idempotencyKey:k,reportId:r.id,expectedVersion:c.expectedVersion,expectedPresent:c.expectedPresent};
 const closed=await portariaReportMutate('portaria/report/close',body,porteiro) as Row;
 assert.equal((closed.report as Row).status,'fechado');assert.equal((closed.version as Row).number,1);assert.equal((closed.version as Row).kind,'original');
 const again=await portariaReportMutate('portaria/report/close',body,porteiro) as Row;
 assert.equal(again.replayed,true);assert.equal(Number((await db.first('SELECT count(*)::int n FROM portaria_report_versions WHERE report_id=?',r.id))!.n),1);
 await rejects(rep('close',{reportId:r.id,expectedVersion:c.expectedVersion,expectedPresent:c.expectedPresent}),409,'REPORT_ALREADY_CLOSED');
 const v=await reportVersion(porteiro,url({id:(closed.version as Row).id as string}));
 assert.equal(v.partial,false);
 const snap=v.snapshot as Row;
 assert.equal(snap.date,'2025-04-01');assert.equal(snap.timezone,'America/Sao_Paulo');assert.equal((snap.totals as Row).entradas,2);assert.equal((snap.totals as Row).saidas,2);
 assert.match((snap.entries as Row[])[0].document as string,/^700\.000\.\d{3}-22$/,'a impressão mostra o documento completo');
 assert.equal((await db.first('SELECT closed_by_name FROM portaria_reports WHERE id=?',r.id))!.closed_by_name,porteiro.name);
 assert.ok(await db.first("SELECT 1 FROM audits WHERE action='Exportação: relatório da Portaria' AND entity_id=?",(closed.version as Row).id));
 assert.ok(!JSON.stringify(await db.all("SELECT detail FROM audits WHERE action LIKE 'Portaria:%'")).includes('700.000.'));
});

test('fechar com pessoas presentes: exige confirmação e justificativa, não encerra visita nenhuma',async()=>{
 await clearPresent();
 const [a,b]=[await person('Presente A'),await person('Presente B')];
 const ea=await entry(a,2,8),eb=await entry(b,2,9);
 const r=await open(2);
 const c=await reportCheck(porteiro,url({reportId:r.id as string}));
 assert.equal(c.requiresConfirmation,true);assert.equal((c.present as Row[]).length,2);
 const base={reportId:r.id,expectedVersion:c.expectedVersion,expectedPresent:c.expectedPresent};
 await assert.rejects(rep('close',base),(e:{code:string,data:{present:Row[]}})=>{assert.equal(e.code,'PRESENT_CONFIRMATION_REQUIRED');assert.equal(e.data.present.length,2);return true;});
 await rejects(rep('close',{...base,confirmPresent:true}),400,'JUSTIFICATION_REQUIRED');
 const closed=await rep('close',{...base,confirmPresent:true,justification:'Equipe de manutenção segue na base à noite'});
 assert.equal((closed.version as Row).closedWithPresent,2);
 const snap=(await reportVersion(porteiro,url({id:(closed.version as Row).id as string}))).snapshot as Row;
 assert.equal((snap.present as Row[]).length,2);assert.equal(snap.closeJustification,'Equipe de manutenção segue na base à noite');
 // Ninguém foi encerrado.
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_visits WHERE id IN (?,?) AND status='em_andamento'",(ea.visit as Row).id,(eb.visit as Row).id))!.n),2);
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_events WHERE kind='saida' AND visit_id IN (?,?)",(ea.visit as Row).id,(eb.visit as Row).id))!.n),0);
});

test('saída depois do fechamento do relatório de entrada: a revisão antiga não muda e a saída vai para o relatório do dia',async()=>{
 const p=(await presentNow(porteiro)).rows as Row[];
 const target=p.find(v=>(v.personName as string)==='Presente A')!;
 const v1=await db.first("SELECT v.id,v.snapshot FROM portaria_report_versions v JOIN portaria_reports r ON r.id=v.report_id WHERE r.op_date='2025-04-02'");
 const before=JSON.stringify(v1!.snapshot);
 const out=await core('exit',{visitId:target.id,version:target.version,occurredAt:at(3,7),...late});
 assert.equal((out.visit as Row).entryDate,'2025-04-02');assert.equal((out.visit as Row).exitDate,'2025-04-03');
 assert.equal(out.postClose,false,'o relatório do dia da saída está aberto');
 assert.equal(JSON.stringify((await db.first('SELECT snapshot FROM portaria_report_versions WHERE id=?',v1!.id))!.snapshot),before,'a revisão fechada é a fotografia original');
 const d3=await dayReport(porteiro,url({date:'2025-04-03'}));
 assert.ok((d3.exits as Row[]).some(v=>v.id===target.id&&v.fromPreviousDay===true));
 // O relatório do dia 2 não ganhou pendência: a saída não faz parte do conteúdo dele.
 assert.equal((await dayReport(porteiro,url({date:'2025-04-02'}))).pendingAfterClose,0);
 const snap2=(await reportVersion(porteiro,url({id:v1!.id as string}))).snapshot as Row;
 assert.ok((snap2.present as Row[]).some(v=>v.id===target.id),'a revisão de 02/04 continua mostrando a pessoa como presente');
});

test('entrada depois do fechamento na mesma data: gravada, sinalizada, e a reabertura gera a revisão seguinte sem tocar na anterior',async()=>{
 await clearPresent();
 const r=await open(4);
 const first=await person('Dia 4 A');const ea=await entry(first,4,8);await exit(ea,4,10);
 const closed=await close(r);
 const v1Snapshot=JSON.stringify((await db.first('SELECT snapshot FROM portaria_report_versions WHERE id=?',(closed.version as Row).id))!.snapshot);
 // Nova entrada no mesmo dia, com o relatório fechado.
 const late2=await person('Dia 4 B');
 const eb=await entry(late2,4,15);
 assert.equal(eb.postClose,true);assert.equal((eb.report as Row).status,'fechado');
 const day=await dayReport(porteiro,url({date:'2025-04-04'}));
 assert.equal(day.pendingAfterClose,1);assert.equal((day.entries as Row[]).length,2,'o movimento posterior aparece na consulta operacional');
 const listed=(await listReports(porteiro,url({pending:'1'}))).rows as Row[];
 assert.ok(listed.some(x=>x.date==='2025-04-04'&&x.pendingAfterClose===1));
 // A versão fechada segue idêntica.
 assert.equal(JSON.stringify((await db.first('SELECT snapshot FROM portaria_report_versions WHERE id=?',(closed.version as Row).id))!.snapshot),v1Snapshot);
 assert.equal(((await reportVersion(porteiro,url({id:(closed.version as Row).id as string}))).snapshot as Row).entries.length,1);
 // Reabrir exige motivo válido e justificativa.
 await rejects(rep('reopen',{reportId:r.id,reasonKind:'qualquer',justification:'x'}),400,'VALIDATION');
 await rejects(rep('reopen',{reportId:r.id,reasonKind:'movimento_posterior'}),400,'JUSTIFICATION_REQUIRED');
 const reopened=await rep('reopen',{reportId:r.id,reasonKind:'movimento_posterior',justification:'Visitante chegou depois do fechamento'});
 assert.equal((reopened.report as Row).status,'aberto');
 await rejects(rep('reopen',{reportId:r.id,reasonKind:'movimento_posterior',justification:'de novo'}),409,'REPORT_NOT_CLOSED');
 await exit(eb,4,17);
 const second=await close(r);
 assert.equal((second.version as Row).number,2);assert.equal((second.version as Row).kind,'atualizada');assert.equal((second.version as Row).reason,'Visitante chegou depois do fechamento');
 const s2=(await reportVersion(porteiro,url({id:(second.version as Row).id as string}))).snapshot as Row;
 assert.equal((s2.entries as Row[]).length,2);assert.equal((s2.totals as Row).saidas,2);
 assert.equal(JSON.stringify((await db.first('SELECT snapshot FROM portaria_report_versions WHERE id=?',(closed.version as Row).id))!.snapshot),v1Snapshot,'a revisão 1 continua como foi emitida');
 const versions=(await reportVersions(porteiro,url({reportId:r.id as string}))).versions as Row[];
 assert.deepEqual(versions.map(v=>[v.number,v.kind]),[[2,'atualizada'],[1,'original']]);
 assert.equal((await dayReport(porteiro,url({date:'2025-04-04'}))).pendingAfterClose,0);
 // Reabrir por correção gera revisão "retificada".
 await rep('reopen',{reportId:r.id,reasonKind:'correcao',justification:'Empresa digitada errado'});
 const third=await close(r);
 assert.equal((third.version as Row).kind,'retificada');assert.equal((third.version as Row).number,3);
});

test('fechamento concorrente com uma movimentação: conflito de versão ou movimento posterior, nunca conteúdo diferente do conferido',async()=>{
 await clearPresent();
 const r=await open(5);
 const p=await person('Corrida Fechamento'),q=await person('Corrida Fechamento 2');
 const e0=await entry(p,5,8);await exit(e0,5,9);
 const c=await reportCheck(porteiro,url({reportId:r.id as string}));
 // Alguém registra entre a conferência e a confirmação.
 const e1=await entry(q,5,10,porteiro2);await exit(e1,5,11);
 await rejects(rep('close',{reportId:r.id,expectedVersion:c.expectedVersion,expectedPresent:c.expectedPresent}),409,'VERSION_CONFLICT');
 assert.equal((await dayReport(porteiro,url({date:'2025-04-05'}))).report!.status,'aberto' as never);
 // Corrida de verdade: fechamento e entrada ao mesmo tempo.
 const c2=await reportCheck(porteiro,url({reportId:r.id as string}));
 const w=await person('Corrida Final');
 const results=await Promise.allSettled([
  rep('close',{reportId:r.id,expectedVersion:c2.expectedVersion,expectedPresent:c2.expectedPresent}),
  entry(w,5,12,porteiro2),
 ]);
 const entryResult=results[1],closeResult=results[0];
 assert.equal(entryResult.status,'fulfilled');
 const wid=(entryResult as PromiseFulfilledResult<Row>).value.visit as Row;
 if(closeResult.status==='fulfilled'){
  const snap=(await reportVersion(porteiro,url({id:((closeResult.value.version) as Row).id as string}))).snapshot as Row;
  const included=(snap.entries as Row[]).some(v=>v.id===wid.id);
  const day=await dayReport(porteiro,url({date:'2025-04-05'}));
  assert.equal(included,false,'o fechamento só leva o que foi conferido');
  assert.equal(day.pendingAfterClose,1,'e o movimento concorrente ficou como posterior');
 }else{
  assert.equal((closeResult.reason as {code:string}).code,'VERSION_CONFLICT');
  assert.equal((await dayReport(porteiro,url({date:'2025-04-05'}))).report!.status,'aberto' as never);
 }
 // Dois fechamentos ao mesmo tempo: um só vale.
 await clearPresent();
 const r6=await open(6);
 const ee=await entry(await person('Fecha 2x'),6,8);await exit(ee,6,9);
 const c6=await reportCheck(porteiro,url({reportId:r6.id as string}));
 const both=await Promise.allSettled([
  rep('close',{reportId:r6.id,expectedVersion:c6.expectedVersion,expectedPresent:c6.expectedPresent},porteiro),
  rep('close',{reportId:r6.id,expectedVersion:c6.expectedVersion,expectedPresent:c6.expectedPresent},porteiro2),
 ]);
 assert.equal(both.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(Number((await db.first('SELECT count(*)::int n FROM portaria_report_versions WHERE report_id=?',r6.id))!.n),1);
 assert.equal((both.find(x=>x.status==='rejected') as PromiseRejectedResult).reason.code,'REPORT_ALREADY_CLOSED');
});

test('presentes que mudam entre a conferência e o fechamento também bloqueiam',async()=>{
 await clearPresent();
 const r=await open(7);
 const c=await reportCheck(porteiro,url({reportId:r.id as string}));
 // Entrada retroativa em outra data muda quem está na base sem mexer neste relatório.
 await entry(await person('Presente Escondido'),6,23);
 await rejects(rep('close',{reportId:r.id,expectedVersion:c.expectedVersion,expectedPresent:c.expectedPresent}),409,'VERSION_CONFLICT');
 await rejects(rep('close',{reportId:r.id,expectedVersion:c.expectedVersion}),400,'VALIDATION');
 await rejects(rep('close',{reportId:'nao-existe',expectedVersion:0,expectedPresent:'x'}),404,'REPORT_NOT_FOUND');
});

test('relatório aberto só sai como PARCIAL; relatórios antigos abertos aparecem; consultas respeitam o acesso',async()=>{
 const r=await open(8);
 const partial=await reportVersion(porteiro,url({reportId:r.id as string}));
 assert.equal(partial.partial,true);assert.equal((partial.snapshot as Row).kind,'parcial');assert.equal(partial.version,null);
 await assert.rejects(reportVersion(porteiro,url({id:'nao-existe'})),(e:{code:string})=>e.code==='VERSION_NOT_FOUND');
 await assert.rejects(reportVersion(operator,url({reportId:r.id as string})),(e:{code:string})=>e.code==='FORBIDDEN');
 await assert.rejects(reportCheck(operator,url({reportId:r.id as string})),(e:{code:string})=>e.code==='FORBIDDEN');
 await assert.rejects(listReports(operator,url()),(e:{code:string})=>e.code==='FORBIDDEN');
 const stale=(await listReports(porteiro,url({pending:'1'}))).rows as Row[];
 assert.ok(stale.some(x=>x.date==='2025-04-08'&&x.staleOpen===true));
 const abertos=(await listReports(porteiro,url({status:'aberto',from:'2025-04-08',to:'2025-04-08'}))).rows as Row[];
 assert.equal(abertos.length,1);
 await assert.rejects(listReports(porteiro,url({status:'x'})),(e:{code:string})=>e.code==='VALIDATION');
});
