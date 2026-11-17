// Programação do dia · reunião das 16h, por barra: consolidar grava um retrato imutável da barra no dia (lista, ordem,
// HH, duração, recursos, participantes e observações). Consolidar de novo cria a versão seguinte. OS que entra no dia
// depois da 1ª consolidação da barra (nova ou adiada para ele) é Emergencial, para sempre. Alerta das 16h por barra.
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
let eqnOrg:string,ocpOrg:string,loc:string,oil:string,fn:string;
const key=()=>crypto.randomUUID();
const DAY='2031-06-02',PREV='2031-06-01';
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,planningBars?:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,...(planningBars?{planningBars}:{})},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
const board=async(bar:string,day=DAY)=>await d1Get('planning/d1',new URL(`http://x/?bar=${bar}&day=${day}`),planner) as Row;
const consolidate=(b:Row={},who=planner)=>d1Mutate('planning/d1/consolidate',{bar:'equinor',day:DAY,participants:['Ivo Azevedo','Jorge Barreto'],notes:'Priorizar o PSV',...b},who) as Promise<Row>;
const consolidated=async(extra='',bar='equinor')=>await d1Get('planning/d1/consolidated',new URL(`http://x/?bar=${bar}&day=${DAY}${extra}`),operator) as Row;

async function os(org:string,start:string,end:string,hours:number,q:number,opts:{launch?:boolean,title?:string,material?:number}={}){
 const who=org===ocpOrg?ocpPlanner:planner;
 const {id}=await planningMutate('planning/create-free',{},who) as {id:string};
 const p=(await planDetail(who,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:opts.title||'OS',orgId:org,locationId:loc,plannedStart:start,plannedEnd:end,estimatedHours:hours,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:[],operatorIds:[],needs:[{functionId:fn,quantity:q},...(opts.material?[{materialId:oil,amount:opts.material,unit:'L'}]:[])]}))},who);
 if(opts.launch===false)return {plan:id,wo:null as string|null};
 const v=(await planDetail(who,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:v,launchKey:key()},who) as Row;
 return {plan:id,wo:r.workOrderId as string};
}

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner',['equinor']);
 ocpPlanner=await set(await addMember(db,'planner'),['planejamento'],'planner',['ocp']);
 operator=await set(await addMember(db,'operator'),['operacao'],'operator');
 eqnOrg=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 ocpOrg=(await reg('orgs',{name:'OCEANPACT',acronym:'OCPT',category:'interna',color:'#14254A',bar:'ocp'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 oil=(await reg('materials',{name:'Óleo hidráulico',unit:'L'})).id as string;
 fn=(await reg('functions',{name:'Assistente de Operações'})).id as string;
 for(let i=0;i<3;i++)await reg('operators',{name:`ADM ${i}`,functionIds:[fn],bar:'equinor',schedule:'adm'});   // 24 HH em dia útil
});
after(async()=>{await ctx.drop();});

test('consolidar por barra: só OS lançadas, com participantes; só quem planeja a barra consolida',async()=>{
 const A=await os(eqnOrg,DAY,DAY,4,2,{title:'A',material:20});
 const B=await os(eqnOrg,DAY,DAY,3,3,{title:'B'});
 await os(eqnOrg,DAY,DAY,1,1,{title:'Rascunho',launch:false});
 await os(ocpOrg,DAY,DAY,2,1,{title:'OCP 1'});
 await d1Mutate('planning/d1/order',{bar:'equinor',day:DAY,order:[B.plan,A.plan]},planner);
 assert.equal((await board('equinor')).consolidation,null);
 await rejects(consolidate({},operator),403);
 await rejects(consolidate({},ocpPlanner),403,/barra/);
 await rejects(consolidate({participants:[]}),400,/participantes/i);
 const r=await consolidate();
 assert.equal(r.version,1);assert.match(r.message,/Equinor/);
 const c=await consolidated();
 assert.equal(c.version,1);assert.deepEqual(c.participants,['Ivo Azevedo','Jorge Barreto']);assert.equal(c.notes,'Priorizar o PSV');
 const eq=c.snapshot;
 assert.deepEqual((eq.cards as Row[]).map(x=>[x.title,x.hh]),[['B',9],['A',8]]);
 assert.deepEqual([eq.demandHh,eq.staff.hh],[17,24]);
 assert.deepEqual((eq.resources.materials as Row[]).map(m=>[m.name,m.amount]),[['Óleo hidráulico',20]]);
 assert.deepEqual((eq.resources.functions as Row[]).map(f=>f.activities),[2],'rascunho não entra nos recursos consolidados');
 assert.equal((await consolidated('','ocp')).version,null,'a OCP consolida na própria reunião');
 assert.equal((await board('ocp')).consolidation,null);
 const o=await d1Mutate('planning/d1/consolidate',{bar:'ocp',day:DAY,participants:['Jefferson Ribeiro']},ocpPlanner) as Row;
 assert.equal(o.version,1);
 assert.deepEqual(((await consolidated('','ocp')).snapshot.cards as Row[]).map(x=>x.title),['OCP 1']);
 const b=await board('equinor');
 assert.deepEqual([b.consolidation.version,b.consolidation.changed],[1,false]);
 await assert.rejects(db.run('UPDATE plan_day_consolidations SET version=9'),/não pode ser alterad/);
});

test('emergencial: OS lançada ou adiada para o dia depois da consolidação; continua emergencial na v2',async()=>{
 const E=await os(eqnOrg,DAY,DAY,2,2,{title:'Emergência'});
 const M=await os(eqnOrg,PREV,PREV,1,1,{title:'Movida'});
 await d1Mutate('planning/d1/postpone',{plan:M.plan,days:1,reason:'Cliente pediu'},planner);
 let b=await board('equinor');
 const em=(b.cards as Row[]).filter(x=>x.emergency).map(x=>x.title).sort();
 assert.deepEqual(em,['Emergência','Movida']);
 assert.equal((b.cards as Row[]).find(x=>x.title==='A')!.emergency,false);
 assert.equal(b.consolidation.changed,true);
 const r=await consolidate({notes:'Entraram duas emergenciais'});
 assert.equal(r.version,2);
 b=await board('equinor');
 assert.deepEqual([b.consolidation.version,b.consolidation.changed],[2,false]);
 assert.equal((b.cards as Row[]).find(x=>x.workOrderId===E.wo)!.emergency,true);
 const v1=await consolidated('&version=1');
 assert.equal((v1.snapshot.cards as Row[]).length,2);
 assert.deepEqual((await consolidated()).versions.map((v:Row)=>v.version),[2,1]);
 assert.deepEqual(((await consolidated()).snapshot.cards as Row[]).filter(x=>x.emergency).length,2);
});

test('alerta das 16h: barra com OS no dia seguinte e não consolidada aparece; consolidada some',async()=>{
 const today='2031-07-07',tomorrow='2031-07-08';
 await os(eqnOrg,tomorrow,tomorrow,2,1,{title:'Amanhã'});
 const at=(hm:string)=>Date.parse(`${today}T${hm}:00-03:00`);
 assert.deepEqual(await d1Late(at('15:59')),[]);
 assert.deepEqual((await d1Late(at('16:01'))).map(x=>[x.bar,x.day,x.cards]),[['equinor',tomorrow,1]]);
 await d1Mutate('planning/d1/consolidate',{bar:'equinor',day:tomorrow,participants:['Ivo Azevedo']},planner);
 assert.deepEqual(await d1Late(at('16:01')),[]);
});
