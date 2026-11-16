// Planejamento simplificado: efetivo do dia em pessoas por barra (OCP e Equinor). A Gestão define o padrão
// (dia útil e fim de semana); o planejador da barra corrige um dia específico (falta, férias, reforço).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {capacityGet,capacityMutate,staffFor} from '../lib/capacity';
import {d1Mutate} from '../lib/d1';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,ocpPlanner:Member;
let ocpOrg:string,eqnOrg:string,loc:string;
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,planningBars?:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,...(planningBars?{planningBars}:{})},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
// 2026-11-13 sexta, 14 sábado, 15 domingo, 16 segunda.
const FRI='2026-11-13',SAT='2026-11-14',SUN='2026-11-15',MON='2026-11-16';

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 ocpPlanner=await set(await addMember(db,'planner'),['planejamento'],'planner',['ocp']);
 ocpOrg=(await reg('orgs',{name:'OCP OCEANPACT',acronym:'OCP',category:'interna',color:'#14254A'})).id as string;
 eqnOrg=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
});
after(async()=>{await ctx.drop();});

test('efetivo padrão: a Gestão define dia útil e fim de semana; o planejador não',async()=>{
 await rejects(capacityMutate('planning/bars/save',{id:'equinor',staffWeekday:14,staffWeekend:8},planner),403);
 await rejects(capacityMutate('planning/bars/save',{id:'equinor',staffWeekday:-1,staffWeekend:8},manager),400,/efetivo/i);
 await rejects(capacityMutate('planning/bars/save',{id:'equinor',staffWeekday:2.5,staffWeekend:8},manager),400,/efetivo/i);
 await capacityMutate('planning/bars/save',{id:'equinor',staffWeekday:14,staffWeekend:8},manager);
 await capacityMutate('planning/bars/save',{id:'ocp',staffWeekday:4,staffWeekend:0},manager);
 const bars=(await capacityGet('planning/bars',new URL('http://x/'),planner) as Row).bars as Row[];
 assert.deepEqual(bars.map(b=>[b.id,b.staffWeekday,b.staffWeekend]),[['equinor',14,8],['ocp',4,0]]);
 assert.deepEqual((await staffFor('equinor',[FRI,SAT,SUN,MON])).map(d=>[d.day,d.people,d.source]),
  [[FRI,14,'padrao'],[SAT,8,'padrao'],[SUN,8,'padrao'],[MON,14,'padrao']]);
 assert.deepEqual((await staffFor('ocp',[FRI,SAT])).map(d=>d.people),[4,0]);
});

test('efetivo do dia: o planejador da barra corrige um dia; vazio volta ao padrão',async()=>{
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,people:12},ocpPlanner),403,/barra/);
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,people:1000},planner),400,/efetivo/i);
 const r=await d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,people:12,note:'2 de férias'},planner) as Row;
 assert.match(r.message,/12 pessoas/);
 let d=(await staffFor('equinor',[MON]))[0];
 assert.deepEqual([d.people,d.source,d.standard,d.note],[12,'dia',14,'2 de férias']);
 assert.equal((await staffFor('equinor',[FRI]))[0].people,14,'só o dia corrigido muda');
 await d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,people:''},planner);
 d=(await staffFor('equinor',[MON]))[0];
 assert.deepEqual([d.people,d.source],[14,'padrao']);
 const op=await set(await addMember(db,'operator'),['operacao'],'operator');
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,people:10},op),403);
});

test('planejador por barra: só lança OS da barra que planeja; sem barra definida, todas',async()=>{
 assert.deepEqual((await db.first('SELECT bar FROM requester_orgs WHERE id=?',ocpOrg))!.bar,'ocp');
 assert.deepEqual((await db.first('SELECT bar FROM requester_orgs WHERE id=?',eqnOrg))!.bar,'equinor');
 assert.deepEqual((await db.first('SELECT planning_bars FROM members WHERE id=?',ocpPlanner.id))!.planning_bars,['ocp']);
 const draft=async(who:Member,orgId:string)=>{const {id}=await planningMutate('planning/create-free',{},who) as {id:string};const p=(await planDetail(who,id)).plan;
  return planningMutate('planning/save',{id,version:p.version,title:'x',orgId,locationId:loc,plannedStart:'2031-01-10',plannedEnd:'2031-01-10',steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:[],equipmentIds:[],operatorIds:[]}))},who);};
 await rejects(draft(ocpPlanner,eqnOrg),403,/barra OCP/);
 assert.ok(await draft(ocpPlanner,ocpOrg));
 assert.ok(await draft(planner,eqnOrg),'sem barra definida: planeja todas');
 assert.ok(await draft(manager,eqnOrg));
 await rejects(mutate('members',{id:ocpPlanner.id,username:(await db.first('SELECT username FROM members WHERE id=?',ocpPlanner.id))!.username,name:'x',role:'planner',capabilities:['planejamento'],planningBars:['outra']},manager),400);
});
