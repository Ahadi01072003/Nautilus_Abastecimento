// Financeiro · recobráveis por equipamento: acesso, travas no banco, tarifas, usos, fim automático,
// painel e exportação. Valores e cliente fictícios (R$ 500/h, 8 h por diária).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {modules,type Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member,fin:Member;
let org:string,other:string,loc:string;
const H=3600_000;
const key=()=>crypto.randomUUID();
const iso=(t:number)=>new Date(t).toISOString();
const ago=(h:number)=>iso(Date.now()-h*H);
const pgRejects=(p:Promise<unknown>,pattern:RegExp)=>assert.rejects(p,(e:{message:string})=>{assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 fin=await set(await addMember(db,'operator'),['financeiro'],'operator');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'})).id;
 other=(await reg('orgs',{name:'Outro Cliente',acronym:'OCL',category:'cliente',color:'#7A2B5F'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base de testes'})).id;
 const type=(await reg('equipment-types',{name:'Plataforma'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
});
after(async()=>{await ctx.drop();});

/** OS sem fluxo lançada para o cliente, com os equipamentos reservados no período inteiro. */
async function launchFree(orgId:string,start:string,end:string,eq:string[]=['eq1']){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'Içamento com plataforma',orgId,locationId:loc,plannedStart:start,plannedEnd:end,description:'',
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:null,plannedEnd:null,needs:[],equipmentIds:eq,operatorIds:[]}))},planner);
 const v=(await planDetail(planner,id)).plan.version;
 return (await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as {workOrderId:string}).workOrderId;
}
const rawUse=(wo:string,eq:string,s:string,e:string|null)=>db.run("INSERT INTO equipment_uses(id,work_order_id,equipment_id,org_id,started_at,ended_at,end_source,started_by,started_by_name,operation_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
 key(),wo,eq,org,s,e,e?'registrado':null,manager.id,'Gestor',key(),new Date().toISOString());

test('financeiro: acesso adicional libera as telas; sem ele, não',()=>{
 assert.ok(modules({...operator,capabilities:['operacao','financeiro']}).includes('fin-painel'));
 assert.ok(modules({...operator,capabilities:['operacao','financeiro']}).includes('fin-tarifas'));
 assert.ok(!modules({...operator,capabilities:['operacao']}).includes('fin-painel'));
 assert.ok(modules(manager).includes('fin-tarifas'));
});

test('banco: uso não é apagado, não se sobrepõe e fim é depois do início',async()=>{
 const wo=await launchFree(org,ago(30),ago(20),['eq2']);
 await rawUse(wo,'eq2',ago(29),ago(27));
 const u=(await db.first("SELECT id FROM equipment_uses WHERE work_order_id=?",wo))!;
 await pgRejects(db.run('DELETE FROM equipment_uses WHERE id=?',u.id),/não pode ser apagado/);
 await pgRejects(rawUse(wo,'eq2',ago(28),ago(26)),/já em uso/);
 await rawUse(wo,'eq2',ago(27),ago(26));
 await pgRejects(rawUse(wo,'eq2',ago(25),ago(25)),/depois do início/);
 await pgRejects(db.run("UPDATE equipment_uses SET equipment_id='eq1' WHERE id=?",u.id),/não pode ser alterado/);
 // Uso em aberto ocupa até "sempre": nada começa depois dele no mesmo equipamento.
 await rawUse(wo,'eq2',ago(24),null);
 await pgRejects(rawUse(wo,'eq2',ago(23),ago(22.5)),/já em uso/);
});

test('banco: tarifa não é alterada nem apagada',async()=>{
 await db.run("INSERT INTO recovery_rates(id,equipment_id,org_id,hourly_cents,hours_per_day,valid_from,active,created_at,created_by,created_by_name) VALUES('r-db','eq2',?,50000,8,'2026-01-01',1,?,?,'Gestor')",org,new Date().toISOString(),manager.id);
 await pgRejects(db.run("UPDATE recovery_rates SET hourly_cents=1 WHERE id='r-db'"),/não pode ser alterada/);
 await pgRejects(db.run("DELETE FROM recovery_rates WHERE id='r-db'"),/não pode ser alterada/);
});
