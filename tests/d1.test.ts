// Programação do dia · o dia de cada barra: HH da OS = duração estimada × pessoas, contra o HH disponível (janelas do
// cadastro). Passou: só avisa (exceeds, extraHh). Barra de duração informativa (avisa a atividade maior que a jornada).
// Ordem por arrastar, ajuste do HH do dia, adiar com prévia, recursos do dia.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {d1Get,d1Mutate} from '../lib/d1';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,ocpPlanner:Member;
let ocpOrg:string,eqnOrg:string,loc:string,oil:string;
const fn:Record<string,string>={};
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,planningBars?:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,...(planningBars?{planningBars}:{})},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
const board=async(bar:string,day:string,who=planner)=>await d1Get('planning/d1',new URL(`http://x/?bar=${bar}&day=${day}`),who) as Row;
const card=(b:Row,plan:string)=>(b.cards as Row[]).find(x=>x.planId===plan);
// 2031-02-03 e 2031-03-03 são segundas; 2031-01-11 sábado, 12 domingo, 13 segunda.
const MON='2031-01-13',SUN='2031-01-12',SAT='2031-01-11';

/** OS sem fluxo: duração estimada, funções com pessoas, equipamento e material opcionais. */
async function os(org:string,start:string,end:string,hours:number|null,needs:{f:string,q:number}[],opts:{launch?:boolean,title?:string,equipment?:string[],material?:number,team?:{f:string,q:number}[]}={}){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:opts.title||'OS teste',orgId:org,locationId:loc,plannedStart:start,plannedEnd:end,...(opts.team?{team:opts.team.map(t=>({functionId:fn[t.f],quantity:t.q}))}:{}),
  ...(hours!=null?{estimatedHours:hours}:{}),
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:opts.equipment||[],operatorIds:[],needs:[...needs.map(n=>({functionId:fn[n.f],quantity:n.q})),
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
 ocpOrg=(await reg('orgs',{name:'OCEANPACT',acronym:'OCPT',category:'interna',color:'#14254A',bar:'ocp'})).id as string;
 eqnOrg=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 oil=(await reg('materials',{name:'Óleo hidráulico',unit:'L'})).id as string;
 for(const n of ['Assistente de Operações','Líder de Operações','Artífice'])fn[n]=(await reg('functions',{name:n})).id as string;
 // Equinor: 5 ADM, 5 Turno A, 5 Turno B → seg–sex 80 + 15 = 95 HH; domingo 5 × 11 = 55. OCP: 2 ADM → 16 HH.
 const add=(name:string,bar:string,schedule:string)=>reg('operators',{name,functionIds:[fn['Assistente de Operações']],bar,schedule});
 for(let i=0;i<5;i++){await add(`ADM ${i}`,'equinor','adm');await add(`A ${i}`,'equinor','turno_a');await add(`B ${i}`,'equinor','turno_b');}
 for(let i=0;i<2;i++)await add(`OCP ${i}`,'ocp','adm');
});
after(async()=>{await ctx.drop();});

test('HH da OS = duração × pessoas; cada barra vê só os seus solicitantes; sem duração fica marcada',async()=>{
 const day='2031-02-03';
 const a=await os(eqnOrg,day,day,2,[{f:'Assistente de Operações',q:2},{f:'Líder de Operações',q:1}]);
 const c=await os(ocpOrg,day,day,4,[{f:'Artífice',q:2}]);
 const n=await os(eqnOrg,day,day,null,[{f:'Assistente de Operações',q:3}],{title:'Sem duração'});
 const e=await board('equinor',day);
 assert.deepEqual([card(e,a.plan)!.hours,card(e,a.plan)!.people,card(e,a.plan)!.hh],[2,3,6]);
 assert.deepEqual([card(e,n.plan)!.hh,card(e,n.plan)!.noDuration],[0,true]);
 assert.deepEqual([e.staff.hh,e.demandHh,e.durationTotal,e.over],[95,6,2,false]);
 assert.deepEqual((e.staff.windows as Row[]).map(w=>[w.label,w.hh]),[['08–17',80],['17–20',15]]);
 const o=await board('ocp',day);
 assert.deepEqual([card(o,c.plan)!.hh,o.staff.hh],[8,16]);
 assert.ok(!card(o,a.plan),'cada barra só vê as OS dos seus solicitantes');
});

test('expediente automático: a OS só consome nos dias em que a barra trabalha (OCP sem fim de semana; Equinor todo dia)',async()=>{
 const FRI='2031-01-10';
 const o=await os(ocpOrg,FRI,MON,4,[{f:'Artífice',q:1}],{title:'OCP sexta a segunda'});
 assert.ok(card(await board('ocp',FRI),o.plan));
 assert.ok(!card(await board('ocp',SAT),o.plan));assert.ok(!card(await board('ocp',SUN),o.plan));
 assert.ok(card(await board('ocp',MON),o.plan));
 const e=await os(eqnOrg,SAT,MON,4,[{f:'Líder de Operações',q:1}],{title:'Equinor fim de semana'});
 const sun=await board('equinor',SUN);
 assert.ok(card(sun,e.plan));assert.equal(sun.staff.hh,55);
});

test('equipe da atividade: funções e quantidade na OS (vale para todos os dias); HH = duração × equipe',async()=>{
 const day='2031-02-10';
 const t=await os(eqnOrg,day,day,2,[],{title:'Com equipe',team:[{f:'Assistente de Operações',q:3},{f:'Líder de Operações',q:1}]});
 const c=card(await board('equinor',day),t.plan)!;
 assert.deepEqual([c.people,c.hh],[4,8]);
 assert.deepEqual((c.byFunction as Row[]).map(f=>[f.name,f.people]),[['Assistente de Operações',3],['Líder de Operações',1]]);
 assert.deepEqual((await planDetail(planner,t.plan)).plan.team.map((x:Row)=>x.quantity),[3,1]);
 await rejects(os(eqnOrg,day,day,2,[],{team:[{f:'Assistente de Operações',q:0}]}),400,/equipe/i);
});

test('passou do HH disponível: exceeds a partir da OS, extraHh; arrastar muda a ordem; ajuste do dia',async()=>{
 const day='2031-03-03';
 const A=await os(eqnOrg,day,day,8,[{f:'Assistente de Operações',q:5}],{title:'A'});   // 40
 const B=await os(eqnOrg,day,day,8,[{f:'Assistente de Operações',q:4}],{title:'B'});   // 32 → 72
 const C=await os(eqnOrg,day,day,6,[{f:'Líder de Operações',q:3}],{title:'C'});        // 18 → 90
 const D=await os(eqnOrg,day,day,4,[{f:'Assistente de Operações',q:2}],{title:'D'});   // 8  → 98
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan,C.plan,D.plan]},planner);
 let b=await board('equinor',day);
 assert.deepEqual((b.cards as Row[]).map(x=>[x.title,x.cumulative,x.exceeds]),[['A',40,false],['B',72,false],['C',90,false],['D',98,true]]);
 assert.deepEqual([b.demandHh,b.staff.hh,b.over,b.extraHh],[98,95,true,3]);
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan,D.plan,C.plan]},planner);
 b=await board('equinor',day);
 assert.deepEqual((b.cards as Row[]).map(x=>[x.title,x.exceeds]),[['A',false],['B',false],['D',false],['C',true]]);
 await rejects(d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan]},ocpPlanner),403,/barra/);
 await d1Mutate('planning/d1/staff',{bar:'equinor',day,hh:100},planner);
 b=await board('equinor',day);
 assert.deepEqual([b.over,b.extraHh,b.staff.hh,b.staff.source],[false,0,100,'dia']);
});

test('barra de duração: soma informativa; avisa a atividade maior que a jornada do dia (11 h)',async()=>{
 const day='2031-04-14';
 await os(eqnOrg,day,day,3,[{f:'Assistente de Operações',q:1}],{title:'Curta'});
 await os(eqnOrg,day,day,12,[{f:'Assistente de Operações',q:1}],{title:'Longa'});
 const b=await board('equinor',day);
 assert.equal(b.durationTotal,15);
 assert.deepEqual(b.longest,{title:'Longa',hours:12,limit:11});
});

test('recursos do dia: equipamento soma as durações e avisa acima da jornada (11 h); materiais somados; funções',async()=>{
 const day='2031-04-15';
 await os(eqnOrg,day,day,8,[{f:'Assistente de Operações',q:2}],{title:'Carga',equipment:['eq1'],material:20});
 await os(eqnOrg,day,day,3.5,[{f:'Assistente de Operações',q:1},{f:'Líder de Operações',q:1}],{title:'Descarga',equipment:['eq1'],material:5});
 const r=(await board('equinor',day)).resources;
 assert.deepEqual((r.equipment as Row[]).map(e=>[e.tag,e.activities,e.hours,e.over]),[['EMP-01',2,11.5,true]]);
 assert.deepEqual((r.materials as Row[]).map(m=>[m.name,m.amount,m.unit]),[['Óleo hidráulico',25,'L']]);
 assert.deepEqual((r.functions as Row[]).map(f=>[f.name,f.activities,f.maxPeople]),[['Assistente de Operações',2,2],['Líder de Operações',1,1]]);
});

test('adiar rascunho: muda as datas direto; prévia mostra o HH antes e depois no novo dia',async()=>{
 const day='2031-04-07',next='2031-04-08';
 await os(eqnOrg,next,next,8,[{f:'Assistente de Operações',q:10}],{title:'Já no dia'});   // 80
 const p=await os(eqnOrg,day,day,6,[{f:'Líder de Operações',q:3}],{launch:false,title:'Rascunho'}); // 18
 assert.equal(card(await board('equinor',day),p.plan)!.status,'rascunho');
 const prev=await d1Get('planning/d1/preview',new URL(`http://x/?plan=${p.plan}&days=1`),planner) as Row;
 assert.deepEqual(prev.days.map((d:Row)=>[d.day,d.staff,d.before,d.after,d.over]),[[next,95,80,98,true]]);
 const r=await d1Mutate('planning/d1/postpone',{plan:p.plan,days:1},planner) as Row;
 assert.match(r.message,/08\/04\/2031/);
 assert.ok(!card(await board('equinor',day),p.plan));
 assert.ok(card(await board('equinor',next),p.plan));
});

test('adiar OS lançada: gera e lança a revisão com o motivo; mantém a prioridade e a duração',async()=>{
 const day='2031-05-05',next='2031-05-06';
 const p=await os(eqnOrg,day,day,3,[{f:'Líder de Operações',q:1}],{title:'Lançada'});
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[p.plan]},planner);
 await rejects(d1Mutate('planning/d1/postpone',{plan:p.plan,days:1},planner),400,/[Mm]otivo/);
 await rejects(d1Mutate('planning/d1/postpone',{plan:p.plan,days:1,reason:'Sem equipe'},ocpPlanner),403);
 const r=await d1Mutate('planning/d1/postpone',{plan:p.plan,days:1,reason:'Equipe toda no navio'},planner) as Row;
 const wo=await db.first('SELECT * FROM work_orders WHERE id=?',p.wo);
 assert.equal(wo!.revision,1);assert.equal(wo!.planned_start,`${next}T03:00:00.000Z`);
 const cur=await db.first('SELECT priority,revision_reason,estimated_hours FROM plans WHERE id=?',wo!.current_plan_id);
 assert.match(cur!.revision_reason,/Equipe toda no navio/);
 assert.equal(Number(cur!.estimated_hours),3);
 assert.ok(((await board('equinor',next)).cards as Row[]).some(x=>x.workOrderId===p.wo));
 assert.match(r.message,/revis/i);
});

test('acesso: Operação e Acompanhamento consultam; quem não tem planejamento não muda',async()=>{
 const op=await set(await addMember(db,'operator'),['operacao'],'operator');
 await board('equinor','2031-03-03',op);
 await rejects(d1Mutate('planning/d1/order',{bar:'equinor',day:'2031-03-03',order:[]},op),403);
});
