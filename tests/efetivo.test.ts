// Planejamento: HH disponível da barra = ADM (funcionários × horas do dia: segunda a sexta, sábado; domingo não)
// + Turno do dia (funcionários × horas, todos os dias). A Gestão define o padrão; o planejador corrige um dia.
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

test('padrão da barra: ADM + Turno; HH = ADM (8 h seg–sex, 4 h sáb, 0 dom) + turno (12 h todo dia)',async()=>{
 await rejects(capacityMutate('planning/bars/save',{id:'equinor',admPeople:7,admHours:8,admSaturdayHours:4,shiftPeople:7,shiftHours:12},planner),403);
 await rejects(capacityMutate('planning/bars/save',{id:'equinor',admPeople:-1,admHours:8,admSaturdayHours:4,shiftPeople:7,shiftHours:12},manager),400,/funcionários/i);
 await rejects(capacityMutate('planning/bars/save',{id:'equinor',admPeople:7,admHours:8,admSaturdayHours:4,shiftPeople:2.5,shiftHours:12},manager),400,/funcionários/i);
 await rejects(capacityMutate('planning/bars/save',{id:'equinor',admPeople:7,admHours:8,admSaturdayHours:4,shiftPeople:7,shiftHours:25},manager),400,/horas/i);
 await capacityMutate('planning/bars/save',{id:'equinor',admPeople:7,admHours:8,admSaturdayHours:4,shiftPeople:7,shiftHours:12},manager);
 await capacityMutate('planning/bars/save',{id:'ocp',admPeople:4,admHours:'8,5',admSaturdayHours:0,shiftPeople:0,shiftHours:12},manager);
 const bars=(await capacityGet('planning/bars',new URL('http://x/'),planner) as Row).bars as Row[];
 assert.deepEqual(bars.map(b=>[b.id,b.admPeople,b.admHours,b.admSaturdayHours,b.shiftPeople,b.shiftHours]),[['equinor',7,8,4,7,12],['ocp',4,8.5,0,0,12]]);
 assert.deepEqual((await staffFor('equinor',[FRI,SAT,SUN,MON])).map(d=>[d.day,d.adm.hours,d.people,d.hh,d.source]),
  [[FRI,8,14,140,'padrao'],[SAT,4,14,112,'padrao'],[SUN,0,7,84,'padrao'],[MON,8,14,140,'padrao']]);
 const ocp=await staffFor('ocp',[FRI,SAT]);
 assert.deepEqual(ocp.map(d=>[d.hh,d.osHours]),[[34,8.5],[0,12]],'sem turno, a OS sem horas usa a jornada do ADM');
 assert.equal((await staffFor('equinor',[FRI]))[0].osHours,12,'com turno, a OS sem horas usa as horas do turno');
});

test('efetivo do dia: o planejador da barra corrige ADM e turno de um dia; vazio volta ao padrão',async()=>{
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,shiftPeople:6},ocpPlanner),403,/barra/);
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,admPeople:1000},planner),400,/funcionários/i);
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,shiftHours:30},planner),400,/horas/i);
 const r=await d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,admPeople:5,admHours:8,shiftPeople:6,shiftHours:12,note:'2 de férias'},planner) as Row;
 assert.match(r.message,/ADM 5 × 8 h \+ turno 6 × 12 h = 112 HH/);
 let d=(await staffFor('equinor',[MON]))[0];
 assert.deepEqual([d.adm.people,d.shift.people,d.hh,d.source,d.standard.adm.people,d.note],[5,6,112,'dia',7,'2 de férias']);
 assert.equal((await staffFor('equinor',[FRI]))[0].hh,140,'só o dia corrigido muda');
 // Só o turno: o ADM continua como valia no dia.
 await d1Mutate('planning/d1/staff',{bar:'equinor',day:FRI,shiftPeople:6},planner);
 d=(await staffFor('equinor',[FRI]))[0];
 assert.deepEqual([d.adm.people,d.adm.hours,d.shift.people,d.hh],[7,8,6,128]);
 await d1Mutate('planning/d1/staff',{bar:'equinor',day:MON},planner);
 d=(await staffFor('equinor',[MON]))[0];
 assert.deepEqual([d.hh,d.source],[140,'padrao']);
 const op=await set(await addMember(db,'operator'),['operacao'],'operator');
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:MON,shiftPeople:3},op),403);
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
