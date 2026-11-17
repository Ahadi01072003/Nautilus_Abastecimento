// Planejamento simplificado · publicar o D+1: um clique publica o que a TV, o celular e a lista de separação
// mostram (só OS lançadas; rascunho não entra). Publicar de novo cria a versão seguinte (histórico
// automático, sem justificativa). Alerta das 16:00 no Painel central para barra com OS e sem publicação.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {capacityMutate} from '../lib/capacity';
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
const board=async(day:string,who=planner)=>await d1Get('planning/d1',new URL(`http://x/?bar=equinor&day=${day}`),who) as Row;
const publish=(day:string,who=planner)=>d1Mutate('planning/d1/publish',{bar:'equinor',day},who) as Promise<Row>;
const published=async(day:string,bar='equinor',extra='')=>await d1Get('planning/d1/published',new URL(`http://x/?bar=${bar}&day=${day}${extra}`),operator) as Row;

async function os(start:string,end:string,q:number,opts:{launch?:boolean,title?:string,material?:number}={}){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:opts.title||'OS',orgId:eqnOrg,locationId:loc,plannedStart:start,plannedEnd:end,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:[],operatorIds:[],needs:[{functionId:fn.a,quantity:q},
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
 fn.a=(await reg('functions',{name:'Assistente de Operações'})).id as string;
 await capacityMutate('planning/bars/save',{id:'equinor',admPeople:0,admHours:8,admSaturdayHours:4,shiftPeople:6,shiftHours:12},manager);
});
after(async()=>{await ctx.drop();});

test('publicar: um clique, mesmo passando do efetivo; rascunho não entra; só o planejador da barra',async()=>{
 const day='2031-06-02';
 const A=await os(day,day,4,{title:'A',material:20});
 const B=await os(day,day,3,{title:'B'});
 await os(day,day,1,{title:'Rascunho',launch:false});
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan]},planner);
 let b=await board(day);
 assert.equal(b.publication,null);assert.equal(b.over,true);assert.equal(b.drafts,1);
 await rejects(publish(day,ocpPlanner),403);
 await rejects(publish(day,operator),403);
 const r=await publish(day);
 assert.equal(r.version,1);assert.match(r.message,/publicad/);
 b=await board(day);
 assert.deepEqual([b.publication.version,b.publication.changed],[1,false]);
 await assert.rejects(db.run('UPDATE plan_d1_publications SET version=9 WHERE bar=?','equinor'),/não pode ser alterada/);
});

test('programação publicada e lista de separação: retrato do dia, só OS lançadas, com materiais',async()=>{
 const day='2031-06-02';
 const p=await published(day);
 assert.equal(p.version,1);
 assert.deepEqual((p.snapshot.cards as Row[]).map(c=>[c.title,c.people,c.hh]),[['A',4,48],['B',3,36]]);
 assert.deepEqual([p.snapshot.staff.people,p.snapshot.staff.hh,p.snapshot.hh],[6,72,84]);
 assert.deepEqual((p.snapshot.materials as Row[]).map(m=>[m.name,m.unit,m.amount]),[['Óleo hidráulico','L',20]]);
 const none=await published(day,'ocp');
 assert.equal(none.version,null);
});

test('mudou depois de publicar: aviso de alterado; publicar de novo cria a versão 2 sem justificativa',async()=>{
 const day='2031-06-02';
 await os(day,day,1,{title:'E'});
 let b=await board(day);
 assert.equal(b.publication.changed,true);
 const r=await publish(day);
 assert.equal(r.version,2);
 b=await board(day);assert.deepEqual([b.publication.version,b.publication.changed],[2,false]);
 const v1=await published(day,'equinor','&version=1');
 assert.equal((v1.snapshot.cards as Row[]).length,2);
 assert.equal(((await published(day)).snapshot.cards as Row[]).length,3);
 assert.deepEqual((await published(day)).versions.map((v:Row)=>v.version),[2,1]);
});

test('alerta das 16:00: D+1 com OS e sem publicação aparece depois das 16h de Brasília',async()=>{
 const today='2031-07-07',tomorrow='2031-07-08';
 await os(tomorrow,tomorrow,1,{title:'Amanhã'});
 const at=(hm:string)=>Date.parse(`${today}T${hm}:00-03:00`);
 assert.deepEqual(await d1Late(at('15:59')),[]);
 assert.deepEqual((await d1Late(at('16:01'))).map(x=>[x.bar,x.day]),[['equinor',tomorrow]]);
});
