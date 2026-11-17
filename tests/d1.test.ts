// Planejamento simplificado · D+1: por barra e dia, o HH das OS do dia (funcionários × horas por dia de cada
// função; sem horas, a jornada do dia) contra o HH disponível (funcionários do dia × horas trabalhadas).
// Passou: só avisa (em vermelho). Ordem da pilha por arrastar; adiar com prévia (rascunho muda direto; OS
// lançada vira revisão automática com motivo).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {capacityMutate} from '../lib/capacity';
import {d1Get,d1Mutate} from '../lib/d1';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,ocpPlanner:Member;
let ocpOrg:string,eqnOrg:string,loc:string;
const fn:Record<string,string>={};
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,planningBars?:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,...(planningBars?{planningBars}:{})},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
const board=async(bar:string,day:string,who=planner)=>await d1Get('planning/d1',new URL(`http://x/?bar=${bar}&day=${day}`),who) as Row;
const card=(b:Row,plan:string)=>(b.cards as Row[]).find(x=>x.planId===plan);
// 2031-01-13 é segunda-feira; 2031-01-12, domingo; 2031-01-11, sábado.
const MON='2031-01-13',SUN='2031-01-12',SAT='2031-01-11';

/** OS sem fluxo com funcionários por função (horas por dia opcionais). */
async function os(org:string,start:string,end:string,needs:{f:string,q:number,h?:number}[],opts:{launch?:boolean,skipSunday?:boolean,title?:string}={}){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:opts.title||'OS teste',orgId:org,locationId:loc,plannedStart:start,plannedEnd:end,skipSunday:!!opts.skipSunday,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:[],operatorIds:[],needs:needs.map(n=>({functionId:fn[n.f],quantity:n.q,...(n.h!=null?{hoursPerDay:n.h}:{})}))}))},planner);
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
 ocpOrg=(await reg('orgs',{name:'OCEANPACT',acronym:'OCPT',category:'interna',color:'#14254A',bar:'ocp'})).id as string;
 eqnOrg=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 for(const n of ['Assistente de Operações','Líder de Operações','Artífice'])fn[n]=(await reg('functions',{name:n})).id as string;
 // Equinor: ADM 3 × 8 h + turno 8 × 12 h = 120 HH em dia útil. OCP: só ADM, 3 × 9 h = 27 HH.
 await capacityMutate('planning/bars/save',{id:'equinor',admPeople:3,admHours:8,admSaturdayHours:4,shiftPeople:8,shiftHours:12},manager);
 await capacityMutate('planning/bars/save',{id:'ocp',admPeople:3,admHours:9,admSaturdayHours:0,shiftPeople:0,shiftHours:12},manager);
});
after(async()=>{await ctx.drop();});

test('HH da OS: funcionários × horas por dia; sem horas, as horas do turno do dia; cada barra vê só os seus solicitantes',async()=>{
 const day='2031-02-03';
 const a=await os(eqnOrg,day,day,[{f:'Assistente de Operações',q:3},{f:'Líder de Operações',q:1,h:6}]);
 const c=await os(ocpOrg,day,day,[{f:'Artífice',q:2}]);
 const e=await board('equinor',day);
 assert.deepEqual([card(e,a.plan)!.hh,card(e,a.plan)!.people],[42,4]);
 assert.deepEqual((card(e,a.plan)!.byFunction as Row[]).map(f=>[f.name,f.people,f.hh]),[['Assistente de Operações',3,36],['Líder de Operações',1,6]]);
 assert.deepEqual([e.staff.people,e.staff.hh,e.demand,e.over],[11,120,42,false]);
 const o=await board('ocp',day);
 assert.equal(card(o,c.plan)!.hh,18);assert.equal(o.staff.hh,27);
 assert.ok(!card(o,a.plan),'cada barra só vê as OS dos seus solicitantes');
 // Turno menor no dia: a OS sem horas acompanha as horas do turno do dia.
 await d1Mutate('planning/d1/staff',{bar:'equinor',day,shiftHours:10},planner);
 const e2=await board('equinor',day);
 assert.deepEqual([card(e2,a.plan)!.hh,e2.staff.hh],[36,104]);
});

test('domingo de folga: a atividade não conta no domingo; fim de semana usa o efetivo de fim de semana',async()=>{
 const p=await os(eqnOrg,SAT,MON,[{f:'Líder de Operações',q:1}],{skipSunday:true,title:'Sem domingo'});
 assert.ok(!card(await board('equinor',SUN),p.plan));
 const sat=await board('equinor',SAT);
 assert.ok(card(sat,p.plan));assert.deepEqual([sat.staff.people,sat.staff.hh],[11,108]);
 assert.ok(card(await board('equinor',MON),p.plan));
});

test('passou do HH disponível: avisa (over e quanto falta) e marca a partir de qual OS; arrastar muda a ordem',async()=>{
 const day='2031-03-03';
 const A=await os(eqnOrg,day,day,[{f:'Assistente de Operações',q:5}],{title:'A'});      // 60
 const B=await os(eqnOrg,day,day,[{f:'Assistente de Operações',q:4}],{title:'B'});      // 48 → 108
 const C=await os(eqnOrg,day,day,[{f:'Líder de Operações',q:3,h:8}],{title:'C'});       // 24 → 132
 const D=await os(eqnOrg,day,day,[{f:'Assistente de Operações',q:1}],{title:'D'});      // 12 → 144
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan,C.plan,D.plan]},planner);
 let b=await board('equinor',day);
 assert.deepEqual((b.cards as Row[]).map(x=>[x.title,x.cumulative,x.exceeds]),[['A',60,false],['B',108,false],['C',132,true],['D',144,true]]);
 assert.deepEqual([b.demand,b.staff.hh,b.over,b.missing],[144,120,true,24]);
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan,D.plan,C.plan]},planner);
 b=await board('equinor',day);
 assert.deepEqual((b.cards as Row[]).map(x=>[x.title,x.exceeds]),[['A',false],['B',false],['D',false],['C',true]]);
 // A prioridade é da OS (lançada inclusive) e vale em todos os dias dela.
 assert.ok(Number((await db.first('SELECT priority FROM plans WHERE id=?',D.plan))!.priority)<Number((await db.first('SELECT priority FROM plans WHERE id=?',C.plan))!.priority));
 await rejects(d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan]},ocpPlanner),403,/barra/);
 // Efetivo do dia corrigido: ADM 3 × 8 h + turno 10 × 12 h = 144 HH, tudo cabe.
 await d1Mutate('planning/d1/staff',{bar:'equinor',day,shiftPeople:10},planner);
 b=await board('equinor',day);
 assert.deepEqual([b.over,b.missing,b.staff.hh,b.staff.source],[false,0,144,'dia']);
});

test('adiar rascunho: muda as datas direto; prévia mostra o HH antes e depois no novo dia',async()=>{
 const day='2031-04-07',next='2031-04-08';
 await os(eqnOrg,next,next,[{f:'Assistente de Operações',q:8}],{title:'Já no dia'});
 const p=await os(eqnOrg,day,day,[{f:'Líder de Operações',q:3}],{launch:false,title:'Rascunho'}); // 36 HH
 assert.equal(card(await board('equinor',day),p.plan)!.status,'rascunho');
 const prev=await d1Get('planning/d1/preview',new URL(`http://x/?plan=${p.plan}&days=1`),planner) as Row;
 assert.deepEqual(prev.days.map((d:Row)=>[d.day,d.staff,d.before,d.after,d.over]),[[next,120,96,132,true]]);
 const r=await d1Mutate('planning/d1/postpone',{plan:p.plan,days:1},planner) as Row;
 assert.match(r.message,/08\/04\/2031/);
 assert.ok(!card(await board('equinor',day),p.plan));
 assert.ok(card(await board('equinor',next),p.plan));
});

test('adiar OS lançada: gera e lança a revisão com o motivo; mantém a prioridade',async()=>{
 const day='2031-05-05',next='2031-05-06';
 const p=await os(eqnOrg,day,day,[{f:'Líder de Operações',q:1}],{title:'Lançada'});
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[p.plan]},planner);
 await rejects(d1Mutate('planning/d1/postpone',{plan:p.plan,days:1},planner),400,/[Mm]otivo/);
 await rejects(d1Mutate('planning/d1/postpone',{plan:p.plan,days:1,reason:'Sem equipe'},ocpPlanner),403);
 const r=await d1Mutate('planning/d1/postpone',{plan:p.plan,days:1,reason:'Equipe toda no navio'},planner) as Row;
 const wo=await db.first('SELECT * FROM work_orders WHERE id=?',p.wo);
 assert.equal(wo!.revision,1);assert.equal(wo!.planned_start,`${next}T03:00:00.000Z`);
 const cur=await db.first('SELECT priority,revision_reason FROM plans WHERE id=?',wo!.current_plan_id);
 assert.match(cur!.revision_reason,/Equipe toda no navio/);
 assert.equal(cur!.priority,(await db.first('SELECT priority FROM plans WHERE id=?',p.plan))!.priority);
 assert.ok(((await board('equinor',next)).cards as Row[]).some(x=>x.workOrderId===p.wo));
 assert.ok(!((await board('equinor',day)).cards as Row[]).some(x=>x.workOrderId===p.wo));
 assert.match(r.message,/revis/i);
});

test('acesso: Operação e Acompanhamento consultam; quem não tem planejamento não muda',async()=>{
 const op=await set(await addMember(db,'operator'),['operacao'],'operator');
 await board('equinor','2031-03-03',op);
 await rejects(d1Mutate('planning/d1/order',{bar:'equinor',day:'2031-03-03',order:[]},op),403);
});
