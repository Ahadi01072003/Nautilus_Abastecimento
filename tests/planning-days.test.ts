// Planejamento por dia (P0): datas sem hora (dia inteiro de Brasília), dependência no mesmo dia,
// equipamento em horas por dia (até 12 h somando as OS, padrão 12 h), rascunho não segura e a
// atividade realizada mantém data e hora reais.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {planningMutate,planDetail,validateDraft,availability,period} from '../lib/planning';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member;
let org:string,loc:string,flow:string,typeEmp:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
/** Início do dia (00h de Brasília) e fim exclusivo (00h do dia seguinte). */
const d0=(day:string)=>`${day}T03:00:00.000Z`;
const d1=(day:string)=>{const t=new Date(`${day}T03:00:00.000Z`);t.setUTCDate(t.getUTCDate()+1);return t.toISOString();};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),['operacao'],'operator');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Porto',acronym:'CPO',category:'cliente',color:'#2B5F7A'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 typeEmp=(await reg('equipment-types',{name:'Empilhadeira'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",typeEmp);
 flow=(await flowsMutate('flows/save',{code:'DIA',name:'Por dia',steps:[
  {key:'a-0001',name:'Montagem'},
  {key:'b-0001',name:'Içamento',dependsOn:['a-0001']},
 ]},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

/** OS sem fluxo: período em dias e horas por dia de cada equipamento (sem horas = padrão). */
async function free(start:string,end:string,eqs:string[],hours?:Record<string,number>,launch=true,who=planner){
 const {id}=await planningMutate('planning/create-free',{},who) as {id:string};
 const p=(await planDetail(who,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'Uso '+eqs.join(','),orgId:org,locationId:loc,plannedStart:start,plannedEnd:end,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:[],equipmentIds:eqs,operatorIds:[],...(hours?{equipmentHours:hours}:{})}))},who);
 if(!launch)return {plan:id};
 const v=(await planDetail(who,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:v,launchKey:key()},who) as Row;
 return {plan:id,wo:r.workOrderId as string};
}
const avail=async(start:string,end:string,eq:string,hours?:number)=>((await availability(planner,new URL(`http://x/?start=${start}&end=${end}${hours!=null?`&hours=${hours}`:''}`))).equipment as Row[]).find(e=>e.id===eq)!;

test('datas por dia: grava o dia inteiro de Brasília e normaliza data e hora antigas',async()=>{
 const a=await free('2031-01-10','2031-01-12',[],undefined,false);
 let p=(await planDetail(planner,a.plan)).plan;
 assert.equal(p.planned_start,d0('2031-01-10'));assert.equal(p.planned_end,d1('2031-01-12'));
 assert.equal(p.steps[0].planned_start,d0('2031-01-10'));assert.equal(p.steps[0].planned_end,d1('2031-01-12'));
 // Cliente antigo mandando data e hora: vale o dia (Brasília) de cada uma.
 await planningMutate('planning/save',{id:a.plan,version:p.version,title:'x',orgId:org,locationId:loc,plannedStart:'2031-01-10T17:30:00.000Z',plannedEnd:'2031-01-12T22:00:00.000Z',
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:[],equipmentIds:[],operatorIds:[]}))},planner);
 p=(await planDetail(planner,a.plan)).plan;
 assert.equal(p.planned_start,d0('2031-01-10'));assert.equal(p.planned_end,d1('2031-01-12'));
 await rejects(planningMutate('planning/save',{id:a.plan,version:p.version,title:'x',orgId:org,locationId:loc,plannedStart:'2031-01-12',plannedEnd:'2031-01-10',
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:[],equipmentIds:[],operatorIds:[]}))},planner),400,/fim/i);
 // Um dia só: início e fim no mesmo dia é válido.
 const b=await free('2031-01-15','2031-01-15',[],undefined,false);
 assert.equal((await planDetail(planner,b.plan)).plan.planned_end,d1('2031-01-15'));
});

test('dependência: a etapa seguinte pode começar no mesmo dia em que a anterior termina',async()=>{
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as {id:string};
 const save=async(bStart:string)=>{const p=(await planDetail(planner,id)).plan;
  await planningMutate('planning/save',{id,version:p.version,orgId:org,locationId:loc,plannedStart:'2031-02-01',plannedEnd:'2031-02-05',
   steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:[],equipmentIds:[],operatorIds:[],...(s.step_key==='a-0001'?{plannedStart:'2031-02-01',plannedEnd:'2031-02-03'}:{plannedStart:bStart,plannedEnd:'2031-02-05'})}))},planner);
  return (await validateDraft(planner,id)).errors.map(e=>e.message).join(' | ');};
 assert.doesNotMatch(await save('2031-02-03'),/dependência/,'mesmo dia em que a anterior termina');
 assert.match(await save('2031-02-02'),/dependência/,'antes do último dia da anterior');
});

test('equipamento em horas por dia: soma até 12 h entre as OS; acima é recusado com o motivo',async()=>{
 await free('2031-03-10','2031-03-10',['eq1'],{eq1:6});
 assert.equal((await avail('2031-03-10','2031-03-10','eq1',6)).status,'parcial','6 h usadas, 6 h livres');
 assert.equal((await avail('2031-03-10','2031-03-10','eq1',7)).status,'reservado');
 await free('2031-03-10','2031-03-10',['eq1'],{eq1:6});
 assert.equal((await avail('2031-03-10','2031-03-10','eq1',1)).status,'reservado','12 h usadas');
 await rejects(free('2031-03-09','2031-03-11',['eq1'],{eq1:1}),409,/12 h/);
 assert.equal((await avail('2031-03-11','2031-03-11','eq1')).status,'livre','o dia seguinte segue livre');
 const r=await free('2031-03-11','2031-03-12',['eq1'],{eq1:12});assert.ok(r.wo);
 await rejects(free('2031-03-10','2031-03-10',['eq1'],{eq1:13}),400,/12/);
 await rejects(free('2031-03-20','2031-03-20',['eq1'],{eq1:0}),400);
});

test('padrão 12 h: sem horas informadas, o equipamento ocupa o dia todo',async()=>{
 const a=await free('2031-04-01','2031-04-02',['eq2']);
 const r=await db.first("SELECT hours_per_day,start_at,end_at FROM reservations WHERE plan_id=? AND status<>'liberada'",a.plan);
 assert.equal(Number(r!.hours_per_day),12);assert.equal(r!.start_at,d0('2031-04-01'));assert.equal(r!.end_at,d1('2031-04-02'));
 await rejects(free('2031-04-02','2031-04-02',['eq2'],{eq2:1}),409,/indisponível/);
});

test('rascunho não segura: dois rascunhos no mesmo dia; o primeiro a lançar fica com o equipamento',async()=>{
 const x=await free('2031-05-05','2031-05-05',['eq1'],{eq1:8},false),y=await free('2031-05-05','2031-05-05',['eq1'],{eq1:8},false);
 const launch=async(id:string)=>{const v=(await planDetail(planner,id)).plan.version;return planningMutate('planning/launch',{id,version:v,launchKey:key()},planner);};
 await launch(x.plan);
 await rejects(launch(y.plan),409);
});

test('banco: reserva gravada direto acima de 12 h no dia é recusada',async()=>{
 const a=await free('2031-06-01','2031-06-01',['eq2'],{eq2:10});
 const step=await db.first('SELECT plan_id,id FROM plan_steps WHERE plan_id=?',a.plan);
 const b=await free('2031-06-01','2031-06-01',[],undefined,false);
 const bs=await db.first('SELECT id FROM plan_steps WHERE plan_id=?',b.plan);
 await db.run("UPDATE plans SET status='launched',version=version+1 WHERE id=?",b.plan).catch(()=>{});
 await assert.rejects(db.run("INSERT INTO reservations(id,plan_id,plan_step_id,equipment_id,start_at,end_at,hours_per_day,status,created_at) VALUES(?,?,?,'eq2',?,?,3,'confirmada',?)",
  key(),b.plan,bs!.id,d0('2031-06-01'),d1('2031-06-01'),new Date().toISOString()),/reservado/);
 await assert.rejects(db.run('UPDATE reservations SET hours_per_day=13 WHERE plan_id=?',step!.plan_id),/hours_per_day|12|check/i);
});

test('atividade realizada mantém data e hora reais',async()=>{
 const {id}=await planningMutate('planning/create-free',{mode:'realizada'},operator) as {id:string};
 const p=(await planDetail(operator,id)).plan;
 const s='2026-10-05T11:15:00.000Z',e='2026-10-05T14:40:00.000Z';
 await planningMutate('planning/save',{id,version:p.version,title:'Feito',orgId:org,locationId:loc,plannedStart:s,plannedEnd:e,
  steps:p.steps.map((x:Row)=>({key:x.step_key,included:true,needs:[],equipmentIds:[],operatorIds:[]}))},operator);
 const q=(await planDetail(operator,id)).plan;
 assert.equal(q.planned_start,s);assert.equal(q.planned_end,e);
});

test('período exibido por dia',()=>{
 assert.equal(period(d0('2031-01-10'),d1('2031-01-10')),'10/01/2031');
 assert.equal(period(d0('2031-01-10'),d1('2031-01-12')),'10/01/2031 a 12/01/2031');
 assert.match(period('2031-01-10T11:00:00.000Z','2031-01-10T15:00:00.000Z'),/08h00 às 12h00/,'com hora (atividade realizada) continua com hora');
});
