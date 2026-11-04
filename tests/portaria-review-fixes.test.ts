// Portaria · correções da revisão final: presença do relatório é a do FIM DO DIA do relatório (não a de agora),
// documento completo não trafega em URL e o detalhe da pessoa é da gestão.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {type Member} from '../lib/permissions';
import {portariaGet,portariaPost} from '../lib/portaria-api';
import {reportCheck} from '../lib/portaria-reports';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,porteiro:Member,orgId:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,code:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const at=(d:number,h:number,m=0)=>new Date(Date.UTC(2025,6,d,h+3,m)).toISOString();
const late={justification:'Digitação posterior de teste'};
const post=(path:string,b:Row,who:Member=porteiro)=>portariaPost('portaria/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
let n=0;
const person=async(name:string)=>(await post('person/quick',{name,documentType:'CPF',documentNumber:`800.000.${String(++n).padStart(3,'0')}-55`,companyId:'org:'+orgId})).id as string;
const entry=(p:string,d:number,h:number)=>post('entry',{personId:p,purpose:'Visita',accessMode:'a_pe',occurredAt:at(d,h),...late});
const exit=(v:Row,d:number,h:number)=>post('exit',{visitId:(v.visit as Row).id,version:(v.visit as Row).version,occurredAt:at(d,h),...late});
const open=async(d:number)=>(await post('report/open',{date:`2025-07-${String(d).padStart(2,'0')}`})).report as Row;
const check=(r:Row)=>reportCheck(porteiro,url({reportId:r.id as string}));

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 porteiro=await set(await addMember(db,'porteiro'),[],'porteiro');
 orgId=(await registryMutate('registry/orgs',{name:'Cliente Rev',acronym:'CRV',category:'cliente',color:'#2B5F7A'},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

test('fechar um dia antigo não herda quem está na base hoje, e o token não muda com movimento de hoje',async()=>{
 const old=await open(1);
 const before=await check(old);
 assert.equal((before.present as Row[]).length,0);
 assert.equal(before.requiresConfirmation,false);
 // Entra alguém agora (hoje): não pertence ao fim do dia 01/07/2025.
 const p=await person('Entrou hoje');
 await post('entry',{personId:p,purpose:'Visita',accessMode:'a_pe'});
 const after=await check(old);
 assert.equal((after.present as Row[]).length,0,'o relatório antigo não vê quem entrou hoje');
 assert.equal(after.expectedPresent,before.expectedPresent,'o token do dia antigo não depende de hoje');
 const closed=await post('report/close',{reportId:old.id,expectedVersion:after.expectedVersion,expectedPresent:after.expectedPresent});
 assert.equal((closed.version as Row).closedWithPresent,0);
});

test('visita que atravessa a meia-noite aparece como presente no fim do dia da entrada e não no do dia seguinte',async()=>{
 const p=await person('Atravessa a noite');
 const e=await entry(p,10,22);
 await exit(e,11,6);
 const d10=await open(10),d11=await open(11);
 const c10=await check(d10),c11=await check(d11);
 assert.deepEqual((c10.present as Row[]).map(v=>v.personName),['Atravessa a noite']);
 assert.equal(c10.requiresConfirmation,true);
 assert.equal((c11.present as Row[]).length,0);
});

test('documento completo só pela busca em corpo de POST; a busca por URL não o aceita; detalhe da pessoa é da gestão',async()=>{
 const p=await person('Busca Doc');
 const doc=String((await db.first('SELECT document_number FROM portaria_people WHERE id=?',p))!.document_number);
 const byGet=await portariaGet('portaria/people',url({q:doc}),porteiro) as Row;
 assert.equal((byGet.rows as Row[]).length,0,'GET não encontra pelo documento');
 const byPost=await portariaPost('portaria/people/search',{q:doc},porteiro) as Row;
 assert.equal((byPost.rows as Row[]).length,1);
 assert.equal((byPost.rows as Row[])[0].documentMasked.includes('800'),false);
 await rejects(portariaGet('portaria/person',url({id:p}),porteiro),403,'FORBIDDEN');
 const d=await portariaGet('portaria/person',url({id:p}),manager) as Row;
 assert.equal(d.documentNumber,doc);
});
