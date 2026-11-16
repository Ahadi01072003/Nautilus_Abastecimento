// Planejamento P2: tela do D+1. Demanda em HH por função (pessoas × horas por dia; padrão = jornada da
// barra), pilha por prioridade com linha de corte, zona esticada com validação, adiar com prévia e revisão.
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
let ocpOrg:string,eqnOrg:string,loc:string;
const fn:Record<string,string>={};
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,planningBars?:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,...(planningBars?{planningBars}:{})},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
const board=async(bar:string,day:string,who=planner)=>await d1Get('planning/d1',new URL(`http://x/?bar=${bar}&day=${day}`),who) as Row;
const fnOf=(b:Row,name:string)=>(b.functions as Row[]).find(f=>f.name===name)!;
// 2031-01-13 é segunda-feira; 2031-01-12, domingo.
const MON='2031-01-13',TUE='2031-01-14',SUN='2031-01-12',SAT='2031-01-11';

/** OS sem fluxo com funções necessárias (horas por dia opcionais). */
async function os(org:string,start:string,end:string,needs:{f:string,q:number,h?:number}[],opts:{launch?:boolean,skipSunday?:boolean,who?:Member,title?:string}={}){
 const who=opts.who||planner;
 const {id}=await planningMutate('planning/create-free',{},who) as {id:string};
 const p=(await planDetail(who,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:opts.title||'OS teste',orgId:org,locationId:loc,plannedStart:start,plannedEnd:end,skipSunday:!!opts.skipSunday,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:[],operatorIds:[],needs:needs.map(n=>({functionId:fn[n.f],quantity:n.q,...(n.h!=null?{hoursPerDay:n.h}:{})}))}))},who);
 if(opts.launch===false)return {plan:id,wo:null as string|null};
 const v=(await planDetail(who,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:v,launchKey:key()},who) as Row;
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
 for(const n of ['Assistente de Operações','Assistente de Materiais','Líder de Operações','Artífice'])fn[n]=(await reg('functions',{name:n})).id as string;
 const add=async(name:string,bar:string,team:string,f:string)=>{await reg('operators',{name,functionIds:[fn[f]],bar,team,actingFunctionId:fn[f],countsHh:true});};
 // Equinor: segunda = 4 ADM assistentes (36 h) + 6 assistentes de turno (72 h) = 108 h de Assistente; 1 líder de turno (12 h).
 for(let i=0;i<4;i++)await add(`ADM ${i}`,'equinor','adm','Assistente de Operações');
 for(let i=0;i<7;i++)await add(`A ${i}`,'equinor','turno_a',i===0?'Líder de Operações':'Assistente de Operações');
 for(let i=0;i<7;i++)await add(`B ${i}`,'equinor','turno_b',i===0?'Líder de Operações':'Assistente de Operações');
 for(const n of ['Phillip','Yan'])await add(n,'ocp','adm','Artífice');
});
after(async()=>{await ctx.drop();});

test('HH da OS: pessoas × horas por dia; sem horas, vale a jornada da barra (Equinor 12 h, OCP 9 h)',async()=>{
 const a=await os(eqnOrg,'2031-02-03','2031-02-03',[{f:'Assistente de Operações',q:2}]);
 const b=await os(eqnOrg,'2031-02-03','2031-02-03',[{f:'Assistente de Operações',q:2,h:6}]);
 const c=await os(ocpOrg,'2031-02-03','2031-02-03',[{f:'Artífice',q:1}]);
 const e=await board('equinor','2031-02-03');
 const hh=(plan:string)=>(e.cards as Row[]).find(x=>x.planId===plan)!.hh;
 assert.equal(hh(a.plan),24);assert.equal(hh(b.plan),12);
 assert.equal(fnOf(e,'Assistente de Operações').capacity,108);
 assert.equal(fnOf(e,'Assistente de Operações').demand,36);
 const o=await board('ocp','2031-02-03');
 assert.equal((o.cards as Row[]).find(x=>x.planId===c.plan)!.hh,9);
 assert.ok(!(o.cards as Row[]).some(x=>x.planId===a.plan),'cada barra só vê as OS dos seus solicitantes');
});

test('domingo de folga: a atividade não conta no domingo, mas conta nos outros dias',async()=>{
 const p=await os(eqnOrg,SAT,MON,[{f:'Líder de Operações',q:1,h:4}],{skipSunday:true,title:'Sem domingo'});
 assert.ok(!((await board('equinor',SUN)).cards as Row[]).some(x=>x.planId===p.plan));
 assert.ok(((await board('equinor',SAT)).cards as Row[]).some(x=>x.planId===p.plan));
 assert.ok(((await board('equinor',MON)).cards as Row[]).some(x=>x.planId===p.plan));
});

test('pilha por prioridade com linha de corte; arrastar muda a ordem e quem cabe',async()=>{
 const day='2031-03-03';
 const A=await os(eqnOrg,day,day,[{f:'Assistente de Operações',q:5}],{title:'A'}); // 60 h
 const B=await os(eqnOrg,day,day,[{f:'Assistente de Operações',q:4}],{title:'B'}); // 48 h → 108 = 100%
 const C=await os(eqnOrg,day,day,[{f:'Líder de Operações',q:2}],{title:'C'});      // 24 h > 12 × 115%
 const D=await os(eqnOrg,day,day,[{f:'Assistente de Operações',q:1}],{title:'D'},); // 12 h → 111%
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan,C.plan,D.plan]},planner);
 let b=await board('equinor',day);
 assert.deepEqual((b.cards as Row[]).map(x=>[x.title,x.fits,x.zone]),[['A',true,'meta'],['B',true,'cheio'],['C',false,'acima'],['D',false,'esticado']]);
 assert.equal(b.cutAt,2,'a linha de corte cai na primeira OS que não cabe');
 await d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan,B.plan,D.plan,C.plan]},planner);
 b=await board('equinor',day);
 assert.deepEqual((b.cards as Row[]).map(x=>[x.title,x.fits]),[['A',true],['B',true],['D',true],['C',false]]);
 assert.equal(fnOf(b,'Assistente de Operações').accepted,120);assert.equal(fnOf(b,'Assistente de Operações').zone,'esticado');
 // A prioridade é da OS (lançada inclusive) e vale em todos os dias dela.
 assert.ok(Number((await db.first('SELECT priority FROM plans WHERE id=?',D.plan))!.priority)<Number((await db.first('SELECT priority FROM plans WHERE id=?',C.plan))!.priority));
 await rejects(d1Mutate('planning/d1/order',{bar:'equinor',day,order:[A.plan]},ocpPlanner),403,/barra/);
});

test('zona esticada: o planejador registra quem validou; só na barra que planeja',async()=>{
 const day='2031-03-03';
 await rejects(d1Mutate('planning/d1/stretch',{bar:'equinor',day,functionId:fn['Assistente de Operações'],validatedBy:'Wilhan'},ocpPlanner),403);
 await rejects(d1Mutate('planning/d1/stretch',{bar:'equinor',day,functionId:fn['Assistente de Operações'],validatedBy:''},planner),400);
 await d1Mutate('planning/d1/stretch',{bar:'equinor',day,functionId:fn['Assistente de Operações'],validatedBy:'Wilhan Guedes',note:'Reforço da manhã'},planner);
 const f=fnOf(await board('equinor',day),'Assistente de Operações');
 assert.equal(f.stretch.validatedBy,'Wilhan Guedes');
 // Função dentro de 100%: não há o que validar.
 await rejects(d1Mutate('planning/d1/stretch',{bar:'equinor',day,functionId:fn['Líder de Operações'],validatedBy:'Wilhan Guedes'},planner),409);
});

test('adiar rascunho: muda as datas direto; prévia mostra o dia seguinte',async()=>{
 const day='2031-04-07',next='2031-04-08';
 const p=await os(eqnOrg,day,day,[{f:'Líder de Operações',q:1,h:6}],{launch:false,title:'Rascunho'});
 const prev=await d1Get('planning/d1/preview',new URL(`http://x/?plan=${p.plan}&days=1`),planner) as Row;
 assert.deepEqual(prev.days.map((d:Row)=>d.day),[next]);
 const lider=(prev.days[0].functions as Row[]).find(f=>f.name==='Líder de Operações')!;
 assert.equal(lider.before,0);assert.equal(lider.after,6);
 const r=await d1Mutate('planning/d1/postpone',{plan:p.plan,days:1},planner) as Row;
 assert.match(r.message,/08\/04\/2031/);
 assert.ok(!((await board('equinor',day)).cards as Row[]).some(x=>x.planId===p.plan));
 assert.ok(((await board('equinor',next)).cards as Row[]).some(x=>x.planId===p.plan));
});

test('adiar OS lançada: gera e lança a revisão com o motivo; mantém a prioridade',async()=>{
 const day='2031-05-05',next='2031-05-06';
 const p=await os(eqnOrg,day,day,[{f:'Líder de Operações',q:1,h:5}],{title:'Lançada'});
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
