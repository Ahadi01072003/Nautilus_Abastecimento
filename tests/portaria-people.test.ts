// Portaria · visitantes e empresas: cadastro na hora, revisão da gestão, busca de homônimos, documento
// mascarado nas listas e completo no detalhe, isolamento dos colaboradores e das empresas dos outros módulos.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {type Member} from '../lib/permissions';
import {portariaPeopleMutate,searchPeople,searchCompanies,personDetail,pendingReview,registryList} from '../lib/portaria-people';
import {maskDocument,normDocument} from '../lib/portaria-core';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,porteiro:Member,operator:Member,orgId:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,code:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const pp=(path:string,b:Row,who:Member=porteiro)=>portariaPeopleMutate('portaria/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
let n=0;
const quick=(b:Row={})=>pp('person/quick',{name:'Pessoa Teste',documentType:'CPF',documentNumber:`900.000.${String(++n).padStart(3,'0')}-00`,companyId:'org:'+orgId,...b});

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 porteiro=await set(await addMember(db,'porteiro'),[],'porteiro');
 operator=await set(await addMember(db,'operator'),[],'operator');
 orgId=(await registryMutate('registry/orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

test('documento: normalização e máscara preservam os separadores e mostram só o final',()=>{
 assert.equal(normDocument('111.222.333-44'),'11122233344');
 assert.equal(maskDocument('111.222.333-44'),'•••.•••.••3-44');
 assert.equal(maskDocument('AB12345'),'•••••45');
 assert.equal(maskDocument('123'),'••3');
});

test('empresa na hora: fica só na Portaria, reaproveita pelo nome e espelha a do cadastro sem duplicar',async()=>{
 const before=Number((await db.first('SELECT count(*)::int n FROM requester_orgs'))!.n);
 const a=await pp('company/quick',{name:'  Transportadora   Exemplo '});
 assert.equal(a.created,true);assert.equal(a.name,'Transportadora Exemplo');
 assert.equal(Number((await db.first('SELECT count(*)::int n FROM requester_orgs'))!.n),before,'não vai para o cadastro dos outros módulos');
 const again=await pp('company/quick',{name:'transportadora exemplo'});
 assert.equal(again.created,false);assert.equal(again.id,a.id);
 // Empresa já cadastrada em Solicitantes e clientes: espelhada uma vez, mesmo escolhendo duas vezes.
 const m1=await pp('company/quick',{name:'cliente teste'}),m2=await pp('company/quick',{name:'Cliente Teste'});
 assert.equal(m1.id,m2.id);assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_companies WHERE org_id=?",orgId))!.n),1);
 // Pendente de revisão só a criada na hora.
 const list=(await pendingReview(manager,url())).rows;
 assert.ok(list.some((r:Row)=>r.kind==='empresa'&&r.name==='Transportadora Exemplo'));
 assert.ok(!list.some((r:Row)=>r.name==='Cliente Teste'));
 // Inativa: erro claro.
 const setOrg=async(active:boolean)=>registryMutate('registry/orgs',{id:orgId,updatedAt:(await db.first('SELECT updated_at FROM requester_orgs WHERE id=?',orgId))!.updated_at,name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A',active},manager);
 await setOrg(false);
 await rejects(pp('company/quick',{name:'Cliente Teste'}),409,'COMPANY_INACTIVE');
 await setOrg(true);
});

test('visitante na hora: pendente de revisão, documento duplicado recusado e idempotência',async()=>{
 const k=key();
 const p=await pp('person/quick',{idempotencyKey:k,name:'Maria Visitante',documentType:'CPF',documentNumber:'111.222.333-44',companyId:'org:'+orgId});
 assert.equal((p.person as Row).documentMasked,'•••.•••.••3-44');
 assert.ok(!JSON.stringify(p).includes('111.222.333-44'),'a resposta do cadastro não devolve o documento completo');
 // Mesma requisição reenviada: mesma resposta, um só cadastro.
 const replay=await pp('person/quick',{idempotencyKey:k,name:'Maria Visitante',documentType:'CPF',documentNumber:'111.222.333-44',companyId:'org:'+orgId});
 assert.equal(replay.id,p.id);assert.equal(replay.replayed,true);
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM portaria_people WHERE document_norm='11122233344'"))!.n),1);
 // Mesma chave, dados diferentes.
 await rejects(pp('person/quick',{idempotencyKey:k,name:'Outra Pessoa',documentType:'CPF',documentNumber:'999',companyId:'org:'+orgId}),409,'IDEMPOTENCY_KEY_REUSED');
 await rejects(portariaPeopleMutate('portaria/person/quick',{name:'Sem Chave',documentType:'CPF',documentNumber:'555.666',companyId:'org:'+orgId},porteiro),400,'VALIDATION');
 // Documento igual com outra formatação.
 await rejects(pp('person/quick',{name:'Maria Clone',documentType:'CPF',documentNumber:'11122233344',companyId:'org:'+orgId}),409,'DOCUMENT_DUPLICATE');
 // Mesmo número em outro tipo de documento é outra identificação.
 await pp('person/quick',{name:'Maria RG',documentType:'RG',documentNumber:'11122233344',companyId:'org:'+orgId});
 // Validações de campo.
 await rejects(pp('person/quick',{name:'',documentType:'CPF',documentNumber:'123456',companyId:'org:'+orgId}),400,'VALIDATION');
 await rejects(pp('person/quick',{name:'X',documentType:'XYZ',documentNumber:'123456',companyId:'org:'+orgId}),400,'VALIDATION');
 await rejects(pp('person/quick',{name:'X',documentType:'CPF',documentNumber:'--',companyId:'org:'+orgId}),400,'VALIDATION');
 await rejects(pp('person/quick',{name:'X',documentType:'CPF',documentNumber:'123456',companyId:'org:inexistente'}),404,'COMPANY_NOT_FOUND');
 assert.ok((await pendingReview(manager,url())).rows.some((r:Row)=>r.kind==='pessoa'&&r.name==='Maria Visitante'));
 // Auditoria não carrega o documento.
 const audits=await db.all("SELECT detail FROM audits WHERE action LIKE 'Portaria:%'");
 assert.ok(audits.length>0&&audits.every(r=>!String(r.detail).includes('11122233344')&&!String(r.detail).includes('111.222.333-44')));
});

test('busca: homônimos se distinguem por empresa e final do documento; lista só com documento mascarado',async()=>{
 const other=(await pp('company/quick',{name:'Empresa Homônima'})).id as string;
 const a=await quick({name:'João da Silva',companyId:'org:'+orgId}),b=await quick({name:'João da Silva',companyId:other});
 const rows=(await searchPeople(porteiro,url({q:'joão da silva'}))).rows as Row[];
 assert.equal(rows.length,2);
 assert.notEqual(rows[0].id,rows[1].id);
 assert.deepEqual(new Set(rows.map(r=>r.companyName)),new Set(['Cliente Teste','Empresa Homônima']));
 assert.ok(rows.every(r=>/^[•.\-0-9]+$/.test(r.documentMasked as string)&&String(r.documentMasked).includes('•')));
 assert.ok(!JSON.stringify(rows).includes('900.000.'),'lista nunca traz o documento completo');
 // Por empresa e por documento completo (exato).
 assert.equal((await searchPeople(porteiro,url({q:'Empresa Homônima'}))).rows.some((r:Row)=>r.id===b.id),true);
 const doc=(await db.first('SELECT document_number FROM portaria_people WHERE id=?',a.id))!.document_number as string;
 const byDoc=(await searchPeople(porteiro,url({q:doc}))).rows as Row[];
 assert.deepEqual(byDoc.map(r=>r.id),[a.id]);
 assert.equal((await searchPeople(porteiro,url({q:doc.slice(0,6)}))).rows.some((r:Row)=>r.id===a.id),false,'documento parcial não encontra');
 // Paginação.
 for(let i=0;i<4;i++)await quick({name:'Paginada '+i});
 const p1=await searchPeople(porteiro,url({q:'Paginada',limit:'3'})),p2=await searchPeople(porteiro,url({q:'Paginada',limit:'3',page:'2'}));
 assert.equal(p1.rows.length,3);assert.equal(p1.hasMore,true);assert.equal(p2.rows.length,1);assert.equal(p2.hasMore,false);
 // Empresas na lista suspensa: as da Portaria e as do cadastro.
 const companies=(await searchCompanies(porteiro,url({q:'Empresa'}))).rows as Row[];
 assert.ok(companies.some(c=>c.name==='Empresa Homônima'&&c.origin==='portaria'));
 assert.ok((await searchCompanies(porteiro,url({q:'Cliente'}))).rows.some((c:Row)=>c.name==='Cliente Teste'));
 // Sem acesso.
 await assert.rejects(searchPeople(operator,url()),(e:{status:number})=>e.status===403);
});

test('detalhe da pessoa: documento completo só para a gestão e a consulta é auditada (o porteiro vê o documento no detalhe da visita e na impressão)',async()=>{
 const p=await quick({name:'Consulta Documento'});
 await rejects(Promise.resolve().then(()=>personDetail(porteiro,p.id as string)),403,'FORBIDDEN');
 const d=await personDetail(manager,p.id as string);
 assert.match(d.documentNumber as string,/^900\.000\.\d{3}-00$/);
 assert.ok(await db.first("SELECT 1 FROM audits WHERE action='Portaria: documento consultado' AND entity_id=?",p.id));
 await assert.rejects(personDetail(operator,p.id as string),(e:{status:number})=>e.status===403);
 await assert.rejects(personDetail(manager,'nao-existe'),(e:{code:string})=>e.code==='PERSON_NOT_FOUND');
});

test('gestão: cadastra, edita, inativa e revisa; porteiro não',async()=>{
 const p=await quick({name:'Para Revisar'});
 await rejects(pp('person/save',{id:p.id,name:'X',documentType:'CPF',documentNumber:'123456',companyId:'org:'+orgId}),403,'FORBIDDEN');
 await rejects(pp('review/mark',{id:'x'}),403,'FORBIDDEN');
 const pending=(await pendingReview(manager,url())).rows.find((r:Row)=>r.entityId===p.id)!;
 await assert.rejects(pendingReview(porteiro,url()),(e:{code:string})=>e.code==='FORBIDDEN');
 await pp('review/mark',{id:pending.id},manager);
 assert.ok(!(await pendingReview(manager,url())).rows.some((r:Row)=>r.entityId===p.id));
 assert.ok((await pendingReview(manager,url({all:'1'}))).rows.some((r:Row)=>r.entityId===p.id&&r.reviewedAt));
 // Edição e inativação.
 const saved=await pp('person/save',{id:p.id,name:'Nome Corrigido',documentType:'CPF',documentNumber:'900.111.222-33',companyId:'org:'+orgId,active:false},manager);
 assert.equal(saved.id,p.id);
 const row=await db.first('SELECT name,active FROM portaria_people WHERE id=?',p.id);
 assert.deepEqual([row!.name,row!.active],['Nome Corrigido',0]);
 assert.equal((await searchPeople(porteiro,url({q:'Nome Corrigido',active:'1'}))).rows.length,0);
 // Documento de outra pessoa não pode ser reaproveitado.
 const other=await quick({name:'Outra'});
 await rejects(pp('person/save',{id:other.id,name:'Outra',documentType:'CPF',documentNumber:'900.111.222-33',companyId:'org:'+orgId},manager),409,'DOCUMENT_DUPLICATE');
 // Empresa: só as da Portaria se editam.
 const c=await pp('company/quick',{name:'Empresa Editável'});
 await pp('company/save',{id:c.id,name:'Empresa Editada',active:true},manager);
 assert.equal((await db.first('SELECT name FROM portaria_companies WHERE id=?',c.id))!.name,'Empresa Editada');
 const mirrored=(await db.first('SELECT id FROM portaria_companies WHERE org_id=?',orgId))!.id;
 await rejects(pp('company/save',{id:mirrored,name:'Outro Nome',active:true},manager),409,'COMPANY_READ_ONLY');
 const list=await registryList(manager,url());
 assert.ok((list.companies as Row[]).some(x=>x.name==='Empresa Editada')&&!(list.companies as Row[]).some(x=>x.name==='Cliente Teste'));
});

test('isolamento: visitantes e empresas da Portaria não aparecem nos colaboradores nem no cadastro dos outros módulos',async()=>{
 await quick({name:'Visitante Isolado'});
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM operators WHERE name LIKE 'Visitante Isolado%'"))!.n),0);
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM requester_people WHERE name LIKE 'Visitante Isolado%'"))!.n),0);
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM requester_orgs WHERE name LIKE 'Empresa Homônima%' OR name LIKE 'Transportadora%'"))!.n),0);
});
