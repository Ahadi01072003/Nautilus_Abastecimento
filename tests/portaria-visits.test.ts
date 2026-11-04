// Portaria · registro contínuo: entrada, saída, idempotência, concorrência, visitas que atravessam a
// meia-noite, histórico preservado e relatório do dia. Dados fictícios.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {type Member} from '../lib/permissions';
import {portariaPeopleMutate} from '../lib/portaria-people';
import {portariaCoreMutate,presentNow,dayReport} from '../lib/portaria';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,porteiro:Member,porteiro2:Member,operator:Member,orgId:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,code:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const core=(path:string,b:Row,who:Member=porteiro)=>portariaCoreMutate('portaria/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
// Horário de Brasília (UTC−3) em 2025: sempre no passado para o relógio dos testes.
const at=(day:number,h:number,m=0,s=0)=>new Date(Date.UTC(2025,2,day,h+3,m,s)).toISOString();
const late={justification:'Digitação posterior de teste'};
let n=0;
async function person(name='Visitante Teste',extra:Row={}){
 const r=await portariaPeopleMutate('portaria/person/quick',{idempotencyKey:key(),name,documentType:'CPF',documentNumber:`800.000.${String(++n).padStart(3,'0')}-11`,companyId:'org:'+orgId,...extra},porteiro) as Row;
 return r.id as string;
}
const entry=(personId:string,b:Row={},who:Member=porteiro)=>core('entry',{personId,purpose:'Reunião',accessMode:'a_pe',...b},who);
const exit=(v:Row,b:Row={},who:Member=porteiro)=>core('exit',{visitId:(v.visit as Row).id,version:(v.visit as Row).version,...b},who);

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 porteiro=await set(await addMember(db,'porteiro'),[],'porteiro');
 porteiro2=await set(await addMember(db,'porteiro'),[],'porteiro');
 operator=await set(await addMember(db,'operator'),[],'operator');
 orgId=(await registryMutate('registry/orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

test('sem acesso à Portaria: 403 com código estável',async()=>{
 await rejects(portariaCoreMutate('portaria/entry',{idempotencyKey:key(),personId:'x',purpose:'x',accessMode:'a_pe'},operator),403,'FORBIDDEN');
 await assert.rejects(presentNow(operator),(e:{code:string})=>e.code==='FORBIDDEN');
 await assert.rejects(dayReport(operator,url()),(e:{code:string})=>e.code==='FORBIDDEN');
});

test('entrada: cria a visita com cópia histórica, abre o relatório do dia e não vaza o documento',async()=>{
 const p=await person('Ana Entrada');
 const r=await entry(p,{purpose:'Entrega de material',notes:'Crachá 12'});
 const v=r.visit as Row;
 assert.equal(v.status,'em_andamento');assert.equal(v.exitAt,null);assert.equal(v.personName,'Ana Entrada');assert.equal(v.companyName,'Cliente Teste');
 assert.match(v.document as string,/•/);assert.ok(!JSON.stringify(r).includes('800.000.'),'a resposta de lista não traz o documento completo');
 assert.equal((r.report as Row).status,'aberto');assert.equal((r.report as Row).version,1);assert.equal(r.postClose,false);
 assert.equal(Number((await db.first('SELECT count(*)::int n FROM portaria_events WHERE visit_id=?',v.id))!.n),1);
 const audit=await db.first("SELECT detail FROM audits WHERE action='Portaria: entrada registrada' AND entity_id=?",v.id);
 assert.ok(audit&&!String(audit.detail).includes('800.000.')&&!String(audit.detail).includes('Ana Entrada'));
 // Campos obrigatórios e limites.
 await rejects(entry(p,{purpose:''}),400,'VALIDATION');
 await rejects(entry(p,{purpose:'x'.repeat(201)}),400,'VALIDATION');
 await rejects(entry(p,{notes:'x'.repeat(501)}),400,'VALIDATION');
 await rejects(entry(p,{accessMode:'avião'}),400,'VALIDATION');
 await rejects(entry('inexistente'),404,'PERSON_NOT_FOUND');
});

test('placas: opcionais a pé, obrigatória com veículo, normalizadas, saída pode ter outra placa e várias pessoas dividem a mesma',async()=>{
 const [a,b]=[await person('Carro A'),await person('Carro B')];
 await rejects(entry(a,{accessMode:'veiculo'}),400,'PLATE_REQUIRED');
 await rejects(entry(a,{accessMode:'veiculo',plateIn:'x'}),400,'PLATE_INVALID');
 await rejects(entry(a,{accessMode:'a_pe',plateIn:'ABC1D23'}),400,'VALIDATION');
 const e1=await entry(a,{accessMode:'veiculo',plateIn:'abc-1d23'}),e2=await entry(b,{accessMode:'veiculo',plateIn:'ABC1D23'});
 assert.equal((e1.visit as Row).plateIn,'ABC1D23');assert.equal((e2.visit as Row).plateIn,'ABC1D23');
 const x1=await exit(e1,{plateOut:'xyz 9k88'});
 assert.equal((x1.visit as Row).plateOut,'XYZ9K88');assert.equal((x1.visit as Row).plateIn,'ABC1D23');
 const walker=await entry(await person('A Pé'));
 assert.equal((walker.visit as Row).plateIn,null);assert.equal((walker.visit as Row).accessMode,'a_pe');
});

test('mudança cadastral não altera o histórico das visitas',async()=>{
 const p=await person('Nome Antigo');
 const r=await entry(p);
 await portariaPeopleMutate('portaria/person/save',{id:p,name:'Nome Novo',documentType:'CPF',documentNumber:'123.456.789-00',companyId:'org:'+orgId},manager);
 const other=(await portariaPeopleMutate('portaria/company/quick',{idempotencyKey:key(),name:'Outra Empresa Hist'},manager) as Row).id;
 await portariaPeopleMutate('portaria/person/save',{id:p,name:'Nome Novo',documentType:'CPF',documentNumber:'123.456.789-00',companyId:other},manager);
 const v=await db.first('SELECT person_name,document_number,company_name FROM portaria_visits WHERE id=?',(r.visit as Row).id);
 assert.deepEqual([v!.person_name,v!.document_number,v!.company_name],['Nome Antigo',(await db.first("SELECT v.document_number FROM portaria_visits v WHERE v.id=?",(r.visit as Row).id))!.document_number,'Cliente Teste']);
 assert.match(v!.document_number as string,/^800\.000\./);
});

test('pessoa inativa não inicia visita, mas a saída da visita em andamento continua permitida',async()=>{
 const p=await person('Vai Inativar');
 const r=await entry(p);
 await portariaPeopleMutate('portaria/person/save',{id:p,name:'Vai Inativar',documentType:'CPF',documentNumber:(await db.first('SELECT document_number FROM portaria_people WHERE id=?',p))!.document_number,companyId:'org:'+orgId,active:false},manager);
 const out=await exit(r);
 assert.equal((out.visit as Row).status,'finalizada');
 await rejects(entry(p),409,'PERSON_INACTIVE');
});

test('uma visita em andamento por pessoa: duas entradas simultâneas, uma passa; reenvio com a mesma chave não duplica',async()=>{
 const p=await person('Corrida');
 const results=await Promise.allSettled([entry(p,{},porteiro),entry(p,{},porteiro2)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const lost=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
 assert.equal((lost.reason as {code:string}).code,'ALREADY_PRESENT');
 assert.ok((lost.reason as {data:Row}).data.visitId,'o erro aponta a visita em andamento');
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_visits WHERE person_id=? AND status='em_andamento'",p))!.n),1);
 // Mesma requisição reenviada após falha de rede.
 const q=await person('Reenvio');
 const k=key(),body={idempotencyKey:k,personId:q,purpose:'Visita técnica',accessMode:'a_pe'};
 const first=await portariaCoreMutate('portaria/entry',body,porteiro) as Row,again=await portariaCoreMutate('portaria/entry',body,porteiro) as Row;
 assert.equal(again.replayed,true);assert.equal(again.id,first.id);
 assert.equal(Number((await db.first('SELECT count(*)::int n FROM portaria_visits WHERE person_id=?',q))!.n),1);
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_events WHERE visit_id=? AND kind='entrada'",first.id))!.n),1);
 await rejects(portariaCoreMutate('portaria/entry',{...body,purpose:'Outro objetivo'},porteiro),409,'IDEMPOTENCY_KEY_REUSED');
});

test('saída: versão conferida, idempotente, única por visita, nunca antes da entrada e sem escolher visita sozinha',async()=>{
 const p=await person('Saída Teste');
 const r=await entry(p,{occurredAt:at(11,8),...late});
 await rejects(core('exit',{visitId:(r.visit as Row).id,version:(r.visit as Row).version,occurredAt:at(11,7),...late}),400,'EXIT_BEFORE_ENTRY');
 await rejects(core('exit',{visitId:(r.visit as Row).id,occurredAt:at(11,9),...late}),400,'VALIDATION');
 await rejects(core('exit',{visitId:(r.visit as Row).id,version:99,occurredAt:at(11,9),...late}),409,'VERSION_CONFLICT');
 await rejects(core('exit',{visitId:(r.visit as Row).id,version:(r.visit as Row).version,occurredAt:new Date(Date.now()+3600e3).toISOString()}),400,'FUTURE_TIME');
 await rejects(core('exit',{visitId:(r.visit as Row).id,version:(r.visit as Row).version,occurredAt:at(11,9)}),400,'JUSTIFICATION_REQUIRED');
 const k=key(),body={idempotencyKey:k,visitId:(r.visit as Row).id,version:(r.visit as Row).version,occurredAt:at(11,9),...late};
 const a=await portariaCoreMutate('portaria/exit',body,porteiro) as Row,b=await portariaCoreMutate('portaria/exit',body,porteiro) as Row;
 assert.equal(b.replayed,true);assert.equal((a.visit as Row).exitAt,at(11,9));
 // Outra saída (chave diferente) da mesma visita: conflito claro.
 await rejects(core('exit',{visitId:(r.visit as Row).id,version:(a.visit as Row).version,occurredAt:at(11,10),...late}),409,'VISIT_NOT_IN_PROGRESS');
 await rejects(core('exit',{visitId:'nao-existe',version:0}),404,'VISIT_NOT_FOUND');
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_events WHERE visit_id=? AND kind='saida'",(r.visit as Row).id))!.n),1);
 // A entrada preservada.
 assert.equal((a.visit as Row).entryAt,at(11,8));assert.equal((a.visit as Row).purpose,'Reunião');
});

test('horário: retroativo até 30 minutos passa direto, acima exige justificativa e fica marcado; futuro é recusado',async()=>{
 const p=await person('Retroativo');
 await rejects(entry(p,{occurredAt:new Date(Date.now()-3*3600e3).toISOString()}),400,'JUSTIFICATION_REQUIRED');
 const old=await entry(p,{occurredAt:new Date(Date.now()-3*3600e3).toISOString(),...late});
 assert.equal((old.visit as Row).retroactive,true);
 const ev=await db.first("SELECT justification,registered_at,occurred_at FROM portaria_events WHERE visit_id=?",(old.visit as Row).id);
 assert.equal(ev!.justification,late.justification);assert.ok(new Date(ev!.registered_at).getTime()>new Date(ev!.occurred_at).getTime()+3600e3,'guarda quando ocorreu e quando foi registrado');
 await exit(old,{occurredAt:new Date(Date.now()-2.5*3600e3).toISOString(),...late});
 const recent=await entry(p,{occurredAt:new Date(Date.now()-20*60000).toISOString()});
 assert.equal((recent.visit as Row).retroactive,false);
 await exit(recent);
 // Entrada sobreposta a uma visita já registrada da mesma pessoa.
 await rejects(entry(p,{occurredAt:new Date(Date.now()-2.7*3600e3).toISOString(),...late}),409,'VISIT_OVERLAP');
 await rejects(entry(p,{occurredAt:new Date(Date.now()+3600e3).toISOString()}),400,'FUTURE_TIME');
 await rejects(entry(p,{occurredAt:'ontem'}),400,'VALIDATION');
});

test('várias entradas e saídas no mesmo dia: três entradas, uma pessoa única; cada entrada é uma nova visita',async()=>{
 const p=await person('Vai e Volta');
 for(const [h,out] of [[8,9],[10,11],[13,14]]){
  const r=await entry(p,{occurredAt:at(12,h),...late});
  await exit(r,{occurredAt:at(12,out),...late});
 }
 const day=await dayReport(porteiro,url({date:'2025-03-12'}));
 const mine=(day.entries as Row[]).filter(v=>v.personId===p);
 assert.equal(mine.length,3);assert.equal(new Set(mine.map(v=>v.id)).size,3);
 assert.equal((day.exits as Row[]).filter(v=>v.personId===p).length,3);
 assert.equal((day.totals as Row).pessoasUnicas,1);assert.equal((day.totals as Row).entradas,3);
});

test('visita que atravessa a meia-noite: entrada num dia, saída no outro, sem contar como entrada nova',async()=>{
 const p=await person('Noturno');
 const r=await entry(p,{occurredAt:at(13,23,50),...late});
 const x=await exit(r,{occurredAt:at(14,0,10),...late});
 assert.equal((x.visit as Row).entryDate,'2025-03-13');assert.equal((x.visit as Row).exitDate,'2025-03-14');
 const d13=await dayReport(porteiro,url({date:'2025-03-13'})),d14=await dayReport(porteiro,url({date:'2025-03-14'}));
 assert.ok((d13.entries as Row[]).some(v=>v.personId===p));assert.ok(!(d13.exits as Row[]).some(v=>v.personId===p));
 assert.ok(!(d14.entries as Row[]).some(v=>v.personId===p),'a saída não vira entrada do dia seguinte');
 const out=(d14.exits as Row[]).find(v=>v.personId===p)!;
 assert.equal(out.fromPreviousDay,true);assert.equal((d14.totals as Row).saidasDeVisitasAnteriores>=1,true);
 // Nada fecha sozinho: enquanto não há saída, a visita segue em andamento.
 const q=await person('Ainda dentro');
 await entry(q,{occurredAt:at(13,23,0),...late});
 const now=await presentNow(porteiro);
 const row=(now.rows as Row[]).find(v=>v.personId===q)!;
 assert.equal(row.status,'em_andamento');assert.equal(row.fromPreviousDay,true);
});

test('horários próximos da meia-noite caem no dia local certo (Brasília)',async()=>{
 const [a,b,c]=[await person('Meia-noite 1'),await person('Meia-noite 2'),await person('Meia-noite 3')];
 const before=await entry(a,{occurredAt:'2025-03-17T02:59:59Z',...late}),after=await entry(b,{occurredAt:'2025-03-17T03:00:00Z',...late});
 assert.equal((before.visit as Row).entryDate,'2025-03-16');assert.equal((after.visit as Row).entryDate,'2025-03-17');
 const edge=await entry(c,{occurredAt:'2025-03-17T02:00:00Z',...late});
 assert.equal((edge.visit as Row).entryDate,'2025-03-16');
});

test('relatório do dia: único por data mesmo com aberturas simultâneas; abrir de novo não duplica',async()=>{
 const results=await Promise.all([core('report/open',{date:'2025-03-20'},porteiro),core('report/open',{date:'2025-03-20'},porteiro2),core('report/open',{date:'2025-03-20'},manager)]);
 assert.equal(new Set(results.map(r=>(r.report as Row).id)).size,1);
 assert.equal(results.filter(r=>r.created).length,1);
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_reports WHERE op_date='2025-03-20'"))!.n),1);
 await rejects(core('report/open',{date:'2999-01-01'}),400,'VALIDATION');
 await rejects(core('report/open',{date:'20/03/2025'}),400,'VALIDATION');
 // Relatórios antigos ainda abertos aparecem na visão do dia, sem impedir o dia de hoje.
 const today=await dayReport(porteiro,url());
 assert.ok((today.olderOpenReports as Row[]).some(r=>r.date==='2025-03-20'));
});

test('vários porteiros registram ao longo do dia e tudo fica gravado na hora',async()=>{
 const people=await Promise.all(Array.from({length:6},(_,i)=>person('Fluxo '+i)));
 await Promise.all(people.slice(0,3).map(p=>entry(p,{occurredAt:at(21,7),...late},porteiro)));
 await Promise.all(people.slice(3).map(p=>entry(p,{occurredAt:at(21,8),...late},porteiro2)));
 const day=await dayReport(manager,url({date:'2025-03-21'}));
 assert.equal((day.entries as Row[]).length,6);
 assert.equal((day.report as Row).version,6,'cada operação deixou sua marca no relatório');
 const names=new Set((day.entries as Row[]).map(v=>v.entryByName));
 assert.equal(names.size,2);
});
