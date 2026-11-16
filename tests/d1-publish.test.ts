// Planejamento P3: reunião das 16:00 e publicação do D+1 por barra. Marcação Confirmado/Ajustar, trava
// completa (pendências), versão imutável com lideranças e retrato do dia, mudança depois de publicar pede
// nova versão com justificativa, programação publicada (TV/celular), lista de separação e alerta das 16:00.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {d1Get,d1Mutate,d1Late} from '../lib/d1';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,ocpPlanner:Member,operator:Member;
let eqnOrg:string,loc:string,oil:string;
const fn:Record<string,string>={};
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,planningBars?:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,...(planningBars?{planningBars}:{})},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
const board=async(day:string,who=planner,bar='equinor')=>await d1Get('planning/d1',new URL(`http://x/?bar=${bar}&day=${day}`),who) as Row;
const mark=(day:string,plan:string,m:string,who=planner)=>d1Mutate('planning/d1/mark',{bar:'equinor',day,plan,mark:m},who);
const publish=(day:string,b:Row={},who=planner)=>d1Mutate('planning/d1/publish',{bar:'equinor',day,leaders:['Wilhan Guedes','Jorge'],...b},who) as Promise<Row>;

async function os(start:string,end:string,needs:{f:string,q:number,h?:number}[],opts:{launch?:boolean,title?:string,material?:number}={}){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:opts.title||'OS',orgId:eqnOrg,locationId:loc,plannedStart:start,plannedEnd:end,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:[],operatorIds:[],needs:[...needs.map(n=>({functionId:fn[n.f],quantity:n.q,...(n.h!=null?{hoursPerDay:n.h}:{})})),
   ...(opts.material?[{materialId:oil,amount:opts.material,unit:'L'}]:[])]}))},planner);
 if(opts.launch===false)return {plan:id,wo:null as string|null};
 const v=(await planDetail(planner,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as Row;
 return {plan:id,wo:r.workOrderId as string};
}

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 ocpPlanner=await set(await addMember(db,'planner'),['planejamento'],'planner',['ocp']);
 operator=await set(await addMember(db,'operator'),['operacao'],'operator');
 eqnOrg=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 oil=(await reg('materials',{name:'Óleo hidráulico',unit:'L'})).id as string;
 for(const n of ['Assistente de Operações','Líder de Operações'])fn[n]=(await reg('functions',{name:n})).id as string;
 const add=async(name:string,team:string,f:string)=>{await reg('operators',{name,functionIds:[fn[f]],bar:'equinor',team,actingFunctionId:fn[f],countsHh:true});};
 for(let i=0;i<4;i++)await add(`ADM ${i}`,'adm','Assistente de Operações');
 for(let i=0;i<7;i++)await add(`A ${i}`,'turno_a',i===0?'Líder de Operações':'Assistente de Operações');
 for(let i=0;i<7;i++)await add(`B ${i}`,'turno_b',i===0?'Líder de Operações':'Assistente de Operações');
});
after(async()=>{await ctx.drop();});

test('publicar exige: OS confirmadas, sem rascunho, nada abaixo da linha, esticado validado e lideranças',async()=>{
 const day='2031-06-02';
 const A=await os(day,day,[{f:'Assistente de Operações',q:5}],{title:'A',material:20});
 const B=await os(day,day,[{f:'Assistente de Operações',q:5}],{title:'B'});                 // 120/108 = 111%: esticado
 const D=await os(day,day,[{f:'Líder de Operações',q:1,h:4}],{title:'Rasc',launch:false});    // rascunho
 const C=await os(day,day,[{f:'Líder de Operações',q:2}],{title:'C'});                        // 24 h de líder: acima do teto
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan,D.plan,C.plan]},planner);
 let b=await board(day);
 assert.equal(b.publication,null);
 const pend=(b.checks.pending as string[]).join(' | ');
 assert.match(pend,/não confirmad/i);assert.match(pend,/rascunho/i);assert.match(pend,/linha de corte/i);assert.match(pend,/esticad/i);
 await rejects(publish(day),409,/pendência/);
 // Resolve: confirma, adia o rascunho e a OS que não cabe, valida a zona esticada.
 await mark(day,A.plan,'confirmado');await mark(day,B.plan,'ajustar');
 await d1Mutate('planning/d1/postpone',{plan:D.plan,days:1},planner);
 await d1Mutate('planning/d1/postpone',{plan:C.plan,days:1,reason:'Sem líder disponível'},planner);
 b=await board(day);
 assert.match((b.checks.pending as string[]).join(' | '),/Ajustar/);
 await mark(day,B.plan,'confirmado');
 await d1Mutate('planning/d1/stretch',{bar:'equinor',day,functionId:fn['Assistente de Operações'],validatedBy:'Wilhan Guedes'},planner);
 b=await board(day);
 assert.deepEqual(b.checks.pending,[]);
 await rejects(publish(day,{leaders:[]}),400,/lideran/i);
 await rejects(publish(day,{},ocpPlanner),403);
 const r=await publish(day);
 assert.equal(r.version,1);
 b=await board(day);
 assert.equal(b.publication.version,1);assert.equal(b.publication.changed,false);assert.deepEqual(b.publication.leaders,['Wilhan Guedes','Jorge']);
 await assert.rejects(db.run('UPDATE plan_d1_publications SET leaders=?::text[] WHERE bar=?',['x'],'equinor'),/não pode ser alterada/);
});

test('programação publicada e lista de separação: retrato do dia, para quem consulta',async()=>{
 const day='2031-06-02';
 const p=await d1Get('planning/d1/published',new URL(`http://x/?bar=equinor&day=${day}`),operator) as Row;
 assert.equal(p.version,1);
 assert.deepEqual((p.snapshot.cards as Row[]).map(c=>c.title),['A','B']);
 const mats=p.snapshot.materials as Row[];
 assert.deepEqual(mats.map(m=>[m.name,m.unit,m.amount]),[['Óleo hidráulico','L',20]]);
 assert.equal((p.snapshot.functions as Row[]).find(f=>f.name==='Assistente de Operações')!.stretch.validatedBy,'Wilhan Guedes');
 const none=await d1Get('planning/d1/published',new URL(`http://x/?bar=ocp&day=${day}`),operator) as Row;
 assert.equal(none.version,null);
});

test('mudou depois de publicar: aviso e nova versão só com justificativa; OS revisada pede nova confirmação',async()=>{
 const day='2031-06-02';
 const E=await os(day,day,[{f:'Líder de Operações',q:1,h:4}],{title:'E'});
 let b=await board(day);
 assert.equal(b.publication.changed,true);
 assert.match((b.checks.pending as string[]).join(' | '),/não confirmad/i);
 await mark(day,E.plan,'confirmado');
 await rejects(publish(day),400,/[Jj]ustificativa/);
 const r=await publish(day,{justification:'Entrou a OS E depois da reunião'});
 assert.equal(r.version,2);
 b=await board(day);assert.equal(b.publication.version,2);assert.equal(b.publication.changed,false);
 // Adiar uma OS confirmada gera revisão (novo planejamento): ela some do dia e o dia fica alterado.
 await d1Mutate('planning/d1/postpone',{plan:E.plan,days:1,reason:'Líder realocado'},planner);
 b=await board(day);assert.equal(b.publication.changed,true);
 const versions=await d1Get('planning/d1/published',new URL(`http://x/?bar=equinor&day=${day}&version=1`),operator) as Row;
 assert.equal(versions.version,1);assert.equal((versions.snapshot.cards as Row[]).length,2);
});

test('alerta das 16:00: D+1 com OS e sem publicação aparece depois das 16h de Brasília',async()=>{
 const today='2031-07-07',tomorrow='2031-07-08';
 await os(tomorrow,tomorrow,[{f:'Líder de Operações',q:1,h:2}],{title:'Amanhã'});
 const at=(hm:string)=>Date.parse(`${today}T${hm}:00-03:00`);
 assert.deepEqual(await d1Late(at('15:59')),[]);
 assert.deepEqual((await d1Late(at('16:01'))).map(x=>[x.bar,x.day]),[['equinor',tomorrow]]);
});
