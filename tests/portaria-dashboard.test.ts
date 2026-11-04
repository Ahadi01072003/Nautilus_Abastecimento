// Portaria · indicadores e tabela de rotas. Entradas × pessoas únicas × presença, visita que atravessa o período,
// anuladas fora de tudo, empresa histórica e o roteador (GET/POST) com acesso só de porteiro e gestão.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {type Member} from '../lib/permissions';
import {portariaGet,portariaPost} from '../lib/portaria-api';
import {portariaDashboard} from '../lib/portaria-dashboard';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,porteiro:Member,operator:Member,orgA:string,orgB:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,code:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const at=(day:number,h:number,m=0)=>new Date(Date.UTC(2025,5,day,h+3,m)).toISOString();
const late={justification:'Digitação posterior de teste'};
const post=(path:string,b:Row,who:Member=porteiro)=>portariaPost('portaria/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
let n=0;
async function person(name:string,company:string){
 return (await post('person/quick',{name,documentType:'CPF',documentNumber:`700.000.${String(++n).padStart(3,'0')}-44`,companyId:'org:'+company})).id as string;
}
const entry=(p:string,day:number,h:number)=>post('entry',{personId:p,purpose:'Visita',accessMode:'a_pe',occurredAt:at(day,h),...late});
const exit=(v:Row,day:number,h:number)=>post('exit',{visitId:(v.visit as Row).id,version:(v.visit as Row).version,occurredAt:at(day,h),...late});

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 porteiro=await set(await addMember(db,'porteiro'),[],'porteiro');
 operator=await set(await addMember(db,'operator'),[],'operator');
 orgA=(await registryMutate('registry/orgs',{name:'Empresa A',acronym:'EMA',category:'cliente',color:'#2B5F7A'},manager) as {id:string}).id;
 orgB=(await registryMutate('registry/orgs',{name:'Empresa B',acronym:'EMB',category:'cliente',color:'#7A2B5F'},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

test('três entradas da mesma pessoa no dia = 3 entradas e 1 pessoa; anulada fica fora',async()=>{
 const p=await person('Vai e vem',orgA);
 for(const h of [8,10,14]){const e=await entry(p,2,h);await exit(e,2,h+1);}
 const q=await person('Anulada',orgA);
 const x=await entry(q,2,9);await post('visit/annul',{visitId:(x.visit as Row).id,version:(x.visit as Row).version,justification:'Engano'});
 const d=await portariaDashboard(porteiro,url({from:'2025-06-02',to:'2025-06-02'}));
 assert.equal(d.totals.entries,3);assert.equal(d.totals.uniquePeople,1);assert.equal(d.totals.exits,3);
 assert.deepEqual(d.series.map(s=>[s.bucket,s.entries,s.exits,s.people]),[['2025-06-02',3,3,1]]);
 assert.equal(d.timezone.length>0,true);assert.equal(d.granularity,'day');
});

test('pessoas únicas valem para o período todo, não somam dias; mês agrupa; empresa histórica',async()=>{
 const p=await person('Recorrente',orgB);
 for(const day of [3,4,5]){const e=await entry(p,day,8);await exit(e,day,17);}
 const d=await portariaDashboard(manager,url({from:'2025-06-03',to:'2025-06-05'}));
 assert.equal(d.totals.entries,3);assert.equal(d.totals.uniquePeople,1,'1 pessoa em 3 dias');
 assert.equal(d.series.length,3);
 const m=await portariaDashboard(manager,url({from:'2025-06-01',to:'2025-06-30',granularity:'month'}));
 assert.equal(m.series.length,1);assert.equal(m.series[0].bucket,'2025-06-01');
 assert.equal(m.totals.entries,6);assert.equal(m.totals.uniquePeople,2,'Vai e vem + Recorrente; a anulada não conta');
 const byName=Object.fromEntries(m.byCompany.map(c=>[c.name,c]));
 assert.equal(byName['Empresa A'].entries,3);assert.equal(byName['Empresa B'].entries,3);assert.equal(byName['Empresa B'].uniquePeople,1);
 // Filtro por empresa.
 const ob=await db.first("SELECT id FROM portaria_companies WHERE org_id=?",orgB);
 const f=await portariaDashboard(manager,url({from:'2025-06-01',to:'2025-06-30',company:ob!.id as string}));
 assert.equal(f.totals.entries,3);assert.equal(f.byCompany.length,1);
 // Mudar a empresa do cadastro depois não reescreve o passado.
 await post('person/save',{id:p,name:'Recorrente',documentType:'CPF',documentNumber:(await db.first('SELECT document_number FROM portaria_people WHERE id=?',p))!.document_number,companyId:'org:'+orgA,active:true},manager);
 const again=await portariaDashboard(manager,url({from:'2025-06-01',to:'2025-06-30',company:ob!.id as string}));
 assert.equal(again.totals.entries,3,'continua na empresa histórica');
});

test('visita iniciada antes do período e presença em um instante histórico',async()=>{
 const p=await person('Atravessa',orgA);
 const e=await entry(p,10,22);await exit(e,11,6);
 const during=await portariaDashboard(porteiro,url({from:'2025-06-11',to:'2025-06-11',at:at(11,1)}));
 assert.equal(during.totals.entries,0,'a entrada foi no dia 10');assert.equal(during.totals.exits,1);
 assert.equal(during.presentAt!.count>=1,true,'estava na base à 01h do dia 11');
 const after=await portariaDashboard(porteiro,url({from:'2025-06-11',to:'2025-06-11',at:at(11,7)}));
 assert.equal(after.presentAt!.count,0);
 // Presentes agora = em andamento.
 const q=await person('Fica',orgA);await entry(q,12,8);
 assert.equal((await portariaDashboard(porteiro,url({from:'2025-06-12',to:'2025-06-12'}))).totals.presentNow>=1,true);
});

test('validações do período e acesso',async()=>{
 await rejects(portariaDashboard(porteiro,url({from:'2025-06-05',to:'2025-06-01'})),400,'VALIDATION');
 await rejects(portariaDashboard(porteiro,url({granularity:'semana'})),400,'VALIDATION');
 await rejects(portariaDashboard(porteiro,url({from:'2025-02-30'})),400,'VALIDATION');
 await rejects(portariaDashboard(porteiro,url({company:'nao-existe'})),404,'COMPANY_NOT_FOUND');
 await rejects(portariaDashboard(operator,url()),403,'FORBIDDEN');
});

test('roteador: rotas conhecidas respondem, desconhecida é 404 e quem não tem acesso é barrado',async()=>{
 for(const p of ['people','companies','present','visits','reports','dashboard','pending-review'])
  await portariaGet('portaria/'+p,url(),manager);
 await portariaGet('portaria/report',url({date:'2025-06-02'}),porteiro);
 await rejects(portariaGet('portaria/nada',url(),manager),404,'ROUTE_NOT_FOUND');
 await rejects(portariaPost('portaria/nada',{},manager),404,'ROUTE_NOT_FOUND');
 await rejects(portariaGet('portaria/present',url(),operator),403,'FORBIDDEN');
 await rejects(portariaPost('portaria/entry',{idempotencyKey:key()},operator),403,'FORBIDDEN');
});
