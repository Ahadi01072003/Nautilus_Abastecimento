// Portaria · correções, anulações, desfazer saída, restauração e consultas. Nada é apagado, o histórico
// guarda antes e depois, e o que já entrou numa revisão emitida só muda depois de reabrir o relatório.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {type Member} from '../lib/permissions';
import {portariaPeopleMutate} from '../lib/portaria-people';
import {portariaCoreMutate,presentNow,dayReport} from '../lib/portaria';
import {portariaReportMutate,reportCheck,reportVersion} from '../lib/portaria-reports';
import {portariaVisitMutate,listVisits,visitDetail} from '../lib/portaria-visits';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,porteiro:Member,operator:Member,orgId:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,code:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const core=(path:string,b:Row,who:Member=porteiro)=>portariaCoreMutate('portaria/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const rep=(path:string,b:Row,who:Member=porteiro)=>portariaReportMutate('portaria/report/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const vis=(path:string,b:Row,who:Member=porteiro)=>portariaVisitMutate('portaria/visit/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const at=(day:number,h:number,m=0)=>new Date(Date.UTC(2025,4,day,h+3,m)).toISOString();
const late={justification:'Digitação posterior de teste'};
let n=0;
async function person(name='Visitante Teste',company='org:'+orgId){
 return (await portariaPeopleMutate('portaria/person/quick',{idempotencyKey:key(),name,documentType:'CPF',documentNumber:`600.000.${String(++n).padStart(3,'0')}-33`,companyId:company},porteiro) as Row).id as string;
}
const entry=(p:string,day:number,h:number,b:Row={})=>core('entry',{personId:p,purpose:'Reunião',accessMode:'a_pe',occurredAt:at(day,h),...late,...b});
const exit=(v:Row,day:number,h:number)=>core('exit',{visitId:(v.visit as Row).id,version:(v.visit as Row).version,occurredAt:at(day,h),...late});
const open=async(day:number)=>(await core('report/open',{date:`2025-05-${String(day).padStart(2,'0')}`}) as Row).report as Row;
async function close(report:Row,extra:Row={}){
 const c=await reportCheck(porteiro,url({reportId:report.id as string}));
 return rep('close',{reportId:report.id,expectedVersion:c.expectedVersion,expectedPresent:c.expectedPresent,confirmPresent:true,justification:'Fechamento de teste',...extra});
}
const events=(id:string)=>db.all('SELECT kind,justification,before,after FROM portaria_events WHERE visit_id=? ORDER BY registered_at,id',id);

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 porteiro=await set(await addMember(db,'porteiro'),[],'porteiro');
 operator=await set(await addMember(db,'operator'),[],'operator');
 orgId=(await registryMutate('registry/orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

test('corrigir: pessoa, empresa, objetivo, placa e horários, com antes e depois; justificativa e versão obrigatórias',async()=>{
 const [a,b]=[await person('Pessoa Errada'),await person('Pessoa Certa')];
 const outra=(await portariaPeopleMutate('portaria/company/quick',{idempotencyKey:key(),name:'Empresa Correta'},porteiro) as Row).id;
 const e=await entry(a,1,8,{purpose:'Objetivo antigo'});
 const v=e.visit as Row;
 await rejects(vis('correct',{visitId:v.id,version:v.version,changes:{purpose:'Novo'}}),400,'JUSTIFICATION_REQUIRED');
 await rejects(vis('correct',{visitId:v.id,version:v.version,changes:{},...late}),400,'VALIDATION');
 await rejects(vis('correct',{visitId:v.id,version:v.version,changes:{nome:'x'},...late}),400,'VALIDATION');
 await rejects(vis('correct',{visitId:v.id,version:99,changes:{purpose:'Novo'},...late}),409,'VERSION_CONFLICT');
 const r=await vis('correct',{visitId:v.id,version:v.version,changes:{personId:b,companyId:outra,purpose:'Objetivo novo',accessMode:'veiculo',plateIn:'abc-1234',entryAt:at(1,9)},justification:'Pessoa selecionada por engano'});
 const after=r.visit as Row;
 assert.equal(after.personName,'Pessoa Certa');assert.equal(after.companyName,'Empresa Correta');assert.equal(after.purpose,'Objetivo novo');assert.equal(after.plateIn,'ABC1234');assert.equal(after.entryAt,at(1,9));
 assert.equal(after.version,(v.version as number)+1);
 const ev=(await events(v.id as string)).find(x=>x.kind==='correcao')!;
 assert.equal(ev.justification,'Pessoa selecionada por engano');
 assert.equal(ev.before.personName,'Pessoa Errada');assert.equal(ev.after.personName,'Pessoa Certa');assert.equal(ev.before.purpose,'Objetivo antigo');
 assert.ok(!JSON.stringify(ev).includes('600.000.'),'o histórico guarda só o documento mascarado');
 // Saída: corrigir só em visita finalizada; placa de saída; horário não pode inverter.
 await rejects(vis('correct',{visitId:v.id,version:after.version,changes:{plateOut:'ZZZ9999'},...late}),400,'VALIDATION');
 const x=await core('exit',{visitId:v.id,version:after.version,occurredAt:at(1,12),...late});
 await rejects(vis('correct',{visitId:v.id,version:(x.visit as Row).version,changes:{exitAt:at(1,8)},...late}),400,'EXIT_BEFORE_ENTRY');
 await rejects(vis('correct',{visitId:v.id,version:(x.visit as Row).version,changes:{exitAt:new Date(Date.now()+3600e3).toISOString()},...late}),400,'FUTURE_TIME');
 const y=await vis('correct',{visitId:v.id,version:(x.visit as Row).version,changes:{exitAt:at(1,13),plateOut:'xyz-0001'},...late});
 assert.equal((y.visit as Row).exitAt,at(1,13));assert.equal((y.visit as Row).plateOut,'XYZ0001');
 // Pessoa inativa não serve de destino da correção.
 const dead=await person('Inativa');
 await portariaPeopleMutate('portaria/person/save',{id:dead,name:'Inativa',documentType:'CPF',documentNumber:(await db.first('SELECT document_number FROM portaria_people WHERE id=?',dead))!.document_number,companyId:'org:'+orgId,active:false},manager);
 await rejects(vis('correct',{visitId:v.id,version:(y.visit as Row).version,changes:{personId:dead},...late}),409,'PERSON_INACTIVE');
 // Meio de acesso para veículo exige placa.
 const f=await entry(await person('A pé'),2,8);
 await rejects(vis('correct',{visitId:(f.visit as Row).id,version:(f.visit as Row).version,changes:{accessMode:'veiculo'},...late}),400,'PLATE_REQUIRED');
});

test('corrigir a pessoa para quem já está na base ou com horário sobreposto é recusado',async()=>{
 const [a,b]=[await person('Dentro A'),await person('Dentro B')];
 await entry(a,3,8);
 const eb=await entry(b,3,9);
 await rejects(vis('correct',{visitId:(eb.visit as Row).id,version:(eb.visit as Row).version,changes:{personId:a},...late}),409,'ALREADY_PRESENT');
 const done=await entry(await person('Com histórico'),4,8);const xd=await exit(done,4,10);
 const c=await entry(await person('Outra'),4,11);
 // Mudar a pessoa de C para a que já teve visita de 08h–10h no mesmo dia, com entrada às 09h: sobrepõe.
 await rejects(vis('correct',{visitId:(c.visit as Row).id,version:(c.visit as Row).version,changes:{personId:(done.visit as Row).personId,entryAt:at(4,9)},...late}),409,'VISIT_OVERLAP');
 void xd;
});

test('anular: a visita continua rastreável, sai da presença e dos totais, sem saída falsa; anular de novo é recusado',async()=>{
 const p=await person('Anular');
 const e=await entry(p,5,8);
 const v=e.visit as Row;
 assert.ok(((await presentNow(porteiro)).rows as Row[]).some(x=>x.id===v.id));
 await rejects(vis('annul',{visitId:v.id,version:v.version}),400,'JUSTIFICATION_REQUIRED');
 const r=await vis('annul',{visitId:v.id,version:v.version,justification:'Registrada por engano'});
 assert.equal((r.visit as Row).status,'anulada');assert.equal((r.visit as Row).exitAt,null);
 assert.ok(!((await presentNow(porteiro)).rows as Row[]).some(x=>x.id===v.id),'a presença foi liberada');
 const day=await dayReport(porteiro,url({date:'2025-05-05'}));
 assert.ok(!(day.entries as Row[]).some(x=>x.id===v.id));assert.equal((day.totals as Row).anuladas,1);
 assert.equal(Number((await db.first('SELECT count(*)::int n FROM portaria_visits WHERE id=?',v.id))!.n),1,'nada foi apagado');
 assert.equal((await events(v.id as string)).map(x=>x.kind).join(),'entrada,anulacao');
 await rejects(vis('annul',{visitId:v.id,version:(r.visit as Row).version,justification:'de novo'}),409,'VISIT_ANNULLED');
 await rejects(vis('correct',{visitId:v.id,version:(r.visit as Row).version,changes:{purpose:'x'},...late}),409,'VISIT_ANNULLED');
 // A pessoa pode entrar de novo depois da anulação.
 await entry(p,5,10);
 // Restaurar é da gestão e revalida a presença.
 await rejects(vis('restore',{visitId:v.id,justification:'x'}),403,'FORBIDDEN');
 await rejects(vis('restore',{visitId:v.id,justification:'Anulada sem querer'},manager),409,'ALREADY_PRESENT');
});

test('anular e restaurar uma visita finalizada atualiza os indicadores e volta ao mesmo estado',async()=>{
 const p=await person('Finalizada');
 const e=await entry(p,6,8);const x=await exit(e,6,9);
 const id=(x.visit as Row).id as string;
 const annulled=await vis('annul',{visitId:id,version:(x.visit as Row).version,justification:'Lançada em duplicidade'});
 const day=await dayReport(porteiro,url({date:'2025-05-06'}));
 assert.equal((day.totals as Row).entradas,0);assert.equal((day.totals as Row).saidas,0);
 const restored=await vis('restore',{visitId:id,version:(annulled.visit as Row).version,justification:'Foi um engano da anulação'},manager);
 assert.equal((restored.visit as Row).status,'finalizada');
 assert.equal(((await dayReport(porteiro,url({date:'2025-05-06'}))).totals as Row).entradas,1);
 assert.deepEqual((await events(id)).map(x=>x.kind),['entrada','saida','anulacao','restauracao']);
});

test('desfazer saída lançada por engano: volta a em andamento e revalida a presença',async()=>{
 const p=await person('Saída Errada');
 const e=await entry(p,7,8);const x=await exit(e,7,9);
 const v=x.visit as Row;
 await rejects(vis('undo-exit',{visitId:v.id,version:v.version}),400,'JUSTIFICATION_REQUIRED');
 await rejects(vis('undo-exit',{visitId:(e.visit as Row).id,version:99,justification:'x'}),409,'VERSION_CONFLICT');
 const r=await vis('undo-exit',{visitId:v.id,version:v.version,justification:'Saída lançada na pessoa errada'});
 assert.equal((r.visit as Row).status,'em_andamento');assert.equal((r.visit as Row).exitAt,null);assert.equal((r.visit as Row).plateOut,null);
 assert.ok(((await presentNow(porteiro)).rows as Row[]).some(y=>y.id===v.id));
 await rejects(vis('undo-exit',{visitId:v.id,version:(r.visit as Row).version,justification:'x'}),409,'VISIT_NOT_FINISHED');
 // Se a pessoa já entrou de novo, desfazer a saída anterior é recusado.
 const x2=await exit(r,7,10);
 await entry(p,7,11);
 await rejects(vis('undo-exit',{visitId:v.id,version:(x2.visit as Row).version,justification:'tentativa'}),409,'ALREADY_PRESENT');
});

test('relatório fechado: corrigir o que está numa revisão exige reabrir; a revisão emitida fica intacta e a nova mostra a correção',async()=>{
 const p=await person('Revisão Errada');
 const e=await entry(p,8,8);const x=await exit(e,8,9);
 const r=await open(8);
 const closed=await close(r);
 const v1=JSON.stringify((await db.first('SELECT snapshot FROM portaria_report_versions WHERE id=?',(closed.version as Row).id))!.snapshot);
 const v=x.visit as Row;
 await assert.rejects(vis('correct',{visitId:v.id,version:v.version,changes:{purpose:'Corrigido'},...late}),(err:{status:number,code:string,data:{reports:Row[]}})=>{
  assert.equal(err.status,409);assert.equal(err.code,'REPORT_CLOSED');assert.equal(err.data.reports[0].date,'2025-05-08');return true;});
 await assert.rejects(vis('annul',{visitId:v.id,version:v.version,justification:'x'}),(err:{code:string})=>err.code==='REPORT_CLOSED');
 await rep('reopen',{reportId:r.id,reasonKind:'correcao',justification:'Objetivo digitado errado'});
 const fixed=await vis('correct',{visitId:v.id,version:v.version,changes:{purpose:'Objetivo correto'},...late});
 assert.equal((fixed.visit as Row).purpose,'Objetivo correto');
 const second=await close(r);
 assert.equal((second.version as Row).kind,'retificada');
 assert.equal(((await reportVersion(porteiro,url({id:(second.version as Row).id as string}))).snapshot as Row).entries[0].purpose,'Objetivo correto');
 assert.equal(JSON.stringify((await db.first('SELECT snapshot FROM portaria_report_versions WHERE id=?',(closed.version as Row).id))!.snapshot),v1,'a revisão 1 continua com o objetivo original');
 assert.equal(JSON.parse(v1).entries[0].purpose,'Reunião');
});

test('correção de horário que muda o dia move a visita de relatório (os dois precisam estar abertos)',async()=>{
 const p=await person('Muda de Dia');
 const e=await entry(p,9,23);
 const moved=await vis('correct',{visitId:(e.visit as Row).id,version:(e.visit as Row).version,changes:{entryAt:at(10,0,30)},justification:'Horário digitado no dia errado'});
 assert.equal((moved.visit as Row).entryDate,'2025-05-10');
 assert.ok(!((await dayReport(porteiro,url({date:'2025-05-09'}))).entries as Row[]).some(v=>v.id===(e.visit as Row).id));
 assert.ok(((await dayReport(porteiro,url({date:'2025-05-10'}))).entries as Row[]).some(v=>v.id===(e.visit as Row).id));
 // Com o relatório de destino fechado, a correção pede para reabrir.
 const target=await open(11);await close(target);
 await rejects(vis('correct',{visitId:(e.visit as Row).id,version:(moved.visit as Row).version,changes:{entryAt:at(11,8)},justification:'Mover para dia fechado'}),409,'REPORT_CLOSED');
});

test('consultas: filtros por período, pessoa, empresa, placa, estado e presença; detalhe com documento completo e histórico',async()=>{
 const empresa=(await portariaPeopleMutate('portaria/company/quick',{idempotencyKey:key(),name:'Empresa Filtro'},porteiro) as Row).id as string;
 const a=await person('Filtro A',empresa),b=await person('Filtro B');
 const ea=await entry(a,12,8,{accessMode:'veiculo',plateIn:'FIL1T23'}),eb=await entry(b,13,8);
 await exit(ea,12,9);
 const q=async(o:Record<string,string>)=>((await listVisits(porteiro,url(o))).rows as Row[]).map(v=>v.id);
 assert.deepEqual(await q({from:'2025-05-12',to:'2025-05-12',companyId:empresa}),[(ea.visit as Row).id]);
 assert.ok((await q({from:'2025-05-12',to:'2025-05-13'})).includes((eb.visit as Row).id));
 assert.deepEqual(await q({personId:a,from:'2025-05-12',to:'2025-05-13'}),[(ea.visit as Row).id]);
 assert.deepEqual(await q({plate:'fil-1t23'}),[(ea.visit as Row).id]);
 assert.deepEqual(await q({status:'finalizada',from:'2025-05-12',to:'2025-05-13',personId:a}),[(ea.visit as Row).id]);
 assert.ok((await q({present:'1'})).includes((eb.visit as Row).id)&&!(await q({present:'1'})).includes((ea.visit as Row).id));
 assert.ok((await q({q:'Filtro B'})).includes((eb.visit as Row).id));
 // Visitas de relatório fechado e pendências posteriores.
 const day=await open(14);const pa=await person('Fecha Dia 14');const e14=await entry(pa,14,8);await exit(e14,14,9);
 await close(day,{confirmPresent:true});
 assert.ok((await q({reportStatus:'fechado',from:'2025-05-14',to:'2025-05-14'})).includes((e14.visit as Row).id));
 const late14=await entry(await person('Depois do Fechamento'),14,15);
 assert.deepEqual(await q({pendingAfterClose:'1'}),[(late14.visit as Row).id]);
 await assert.rejects(listVisits(porteiro,url({status:'x'})),(e:{code:string})=>e.code==='VALIDATION');
 await assert.rejects(listVisits(porteiro,url({from:'ontem'})),(e:{code:string})=>e.code==='VALIDATION');
 await assert.rejects(listVisits(operator,url()),(e:{code:string})=>e.code==='FORBIDDEN');
 // Lista nunca traz o documento completo; o detalhe traz e audita.
 assert.ok(!JSON.stringify((await listVisits(porteiro,url({personId:a}))).rows).includes('600.000.'));
 const d=await visitDetail(porteiro,url({id:(ea.visit as Row).id as string}));
 assert.match((d.visit as Row).document as string,/^600\.000\.\d{3}-33$/);
 assert.deepEqual((d.events as Row[]).map(e=>e.kind),['entrada','saida']);
 assert.ok(await db.first("SELECT 1 FROM audits WHERE action='Portaria: documento consultado' AND entity_id=?",(ea.visit as Row).id));
 await assert.rejects(visitDetail(porteiro,url({id:'nao-existe'})),(e:{code:string})=>e.code==='VISIT_NOT_FOUND');
 await assert.rejects(visitDetail(operator,url({id:(ea.visit as Row).id as string})),(e:{code:string})=>e.code==='FORBIDDEN');
});

test('permissões: sem acesso à Portaria nenhuma alteração passa',async()=>{
 const e=await entry(await person('Alvo Permissão'),15,8);
 const v=e.visit as Row;
 for(const [path,b] of [['correct',{changes:{purpose:'x'}}],['annul',{}],['undo-exit',{}],['restore',{}]] as [string,Row][])
  await rejects(vis(path,{visitId:v.id,version:v.version,justification:'x',...b},operator),403,'FORBIDDEN');
});
