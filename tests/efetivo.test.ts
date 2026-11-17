// Programação do dia: HH disponível = soma das janelas do dia, cada uma com quem está presente (colaborador com barra e
// escala: ADM, Turno A ou Turno B; almoço de 1 h descontado na janela das 12–13). Turno A em 19/11/2026 (2x2).
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
// 17/11/2026 terça (Turno B), 19 quinta (Turno A), 21 sábado, 22 domingo.
const TUE='2026-11-17',THU='2026-11-19',SAT='2026-11-21',SUN='2026-11-22';
const win=(d:Row)=>(d.windows as Row[]).map(w=>[w.label,w.hh]);

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 ocpPlanner=await set(await addMember(db,'planner'),['planejamento'],'planner',['ocp']);
 ocpOrg=(await reg('orgs',{name:'OCP OCEANPACT',acronym:'OCP',category:'interna',color:'#14254A'})).id as string;
 eqnOrg=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 const fn=(await reg('functions',{name:'Assistente de Operações'})).id as string;
 const add=(name:string,bar:string|null,schedule:string|null)=>reg('operators',{name,functionIds:[fn],bar,schedule});
 for(let i=0;i<7;i++){await add(`ADM ${i}`,'equinor','adm');await add(`A ${i}`,'equinor','turno_a');await add(`B ${i}`,'equinor','turno_b');}
 await add('Supervisor','equinor',null);await add('TST A','equinor',null);
 for(let i=0;i<5;i++)await add(`OCP ${i}`,'ocp','adm');
});
after(async()=>{await ctx.drop();});

test('HH do dia por janelas: Equinor 133 (112 + 21) seg–sex, 105 sábado, 77 domingo; OCP 40 e 0 no fim de semana',async()=>{
 const [tue,thu,sat,sun]=await staffFor('equinor',[TUE,THU,SAT,SUN]);
 assert.deepEqual(win(tue),[['08–17',112],['17–20',21]]);
 assert.deepEqual([tue.hh,tue.computedHh,tue.turnoOfDay,tue.people.adm,tue.people.turno,tue.maxShiftHours],[133,133,'turno_b',7,7,11]);
 assert.equal(thu.turnoOfDay,'turno_a');
 assert.deepEqual([win(sat),sat.hh],[[['08–12',56],['12–20',49]],105]);
 assert.deepEqual([win(sun),sun.hh],[[['08–20',77]],77]);
 const [otue,osat]=await staffFor('ocp',[TUE,SAT]);
 assert.deepEqual([win(otue),otue.hh,otue.maxShiftHours],[[['08–17',40]],40,8]);
 assert.deepEqual([win(osat),osat.hh],[[],0]);
});

test('jornadas da barra: só a Gestão altera; horário inválido é recusado',async()=>{
 const bars=(await capacityGet('planning/bars',new URL('http://x/'),planner) as Row).bars as Row[];
 const ocp=bars.find(b=>b.id==='ocp')!;
 assert.deepEqual(ocp.schedule.adm.weekday,{start:'08:00',end:'17:00',lunch:true});
 assert.equal(ocp.schedule.adm.saturday,null);
 const sched=structuredClone(ocp.schedule);
 sched.adm.saturday={start:'08:00',end:'12:00',lunch:false};
 await rejects(capacityMutate('planning/bars/save',{id:'ocp',schedule:sched},planner),403);
 await rejects(capacityMutate('planning/bars/save',{id:'ocp',schedule:{...sched,adm:{...sched.adm,weekday:{start:'17:00',end:'08:00',lunch:true}}}},manager),400,/horário/i);
 await capacityMutate('planning/bars/save',{id:'ocp',schedule:sched},manager);
 assert.equal((await staffFor('ocp',[SAT]))[0].hh,20);
 await capacityMutate('planning/bars/save',{id:'ocp',schedule:ocp.schedule},manager);
 assert.equal((await staffFor('ocp',[SAT]))[0].hh,0);
});

test('ajuste do dia: o planejador da barra troca o HH de um dia; vazio volta ao calculado',async()=>{
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:TUE,hh:120},ocpPlanner),403,/barra/);
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:TUE,hh:-1},planner),400,/HH/);
 const r=await d1Mutate('planning/d1/staff',{bar:'equinor',day:TUE,hh:120,note:'2 de férias'},planner) as Row;
 assert.match(r.message,/120 HH/);
 let d=(await staffFor('equinor',[TUE]))[0];
 assert.deepEqual([d.hh,d.computedHh,d.source,d.note],[120,133,'dia','2 de férias']);
 assert.equal((await staffFor('equinor',[THU]))[0].hh,133,'só o dia ajustado muda');
 await d1Mutate('planning/d1/staff',{bar:'equinor',day:TUE,hh:''},planner);
 d=(await staffFor('equinor',[TUE]))[0];
 assert.deepEqual([d.hh,d.source],[133,'padrao']);
 const op=await set(await addMember(db,'operator'),['operacao'],'operator');
 await rejects(d1Mutate('planning/d1/staff',{bar:'equinor',day:TUE,hh:100},op),403);
});

test('colaborador: barra e escala válidas; sem escala fica fora do HH',async()=>{
 const fn=(await db.first("SELECT id FROM job_functions LIMIT 1"))!.id;
 await rejects(reg('operators',{name:'X',functionIds:[fn],bar:'equinor',schedule:'turno_c'}),400,/escala/i);
 await rejects(reg('operators',{name:'X',functionIds:[fn],bar:'outra',schedule:'adm'}),400,/barra/i);
 const o=await reg('operators',{name:'Novo ADM',functionIds:[fn],bar:'equinor',schedule:'adm'});
 assert.equal((await staffFor('equinor',[TUE]))[0].computedHh,141);
 const row=await db.first('SELECT * FROM operators WHERE id=?',o.id);
 await reg('operators',{id:o.id,name:'Novo ADM',functionIds:[fn],bar:'equinor',schedule:null,active:row!.active});
 assert.equal((await staffFor('equinor',[TUE]))[0].computedHh,133);
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
