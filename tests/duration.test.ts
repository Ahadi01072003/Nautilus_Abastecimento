// Programação do dia: a OS (com ou sem fluxo) tem a duração estimada de execução, em horas (0,25 a 24, de quarto
// em quarto). Sem ela a OS lança, mas a Programação do dia marca "sem duração". A revisão copia; o equipamento da OS usa a mesma duração por dia.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {revisionMutate} from '../lib/revision';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,org:string,loc:string,fn:string;
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<Row>;
async function draft(extra:Row){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'OS',orgId:org,locationId:loc,plannedStart:'2031-08-04',plannedEnd:'2031-08-04',
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:extra.equipment||[],operatorIds:[],needs:[{functionId:fn,quantity:2}]})),...extra},planner);
 return id;
}

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 const m=await addMember(db,'planner');const row=await db.first('SELECT * FROM members WHERE id=?',m.id);
 await mutate('members',{id:m.id,username:row!.username,name:row!.name,role:'planner',capabilities:['planejamento']},manager);planner={...m,profile:'planner',capabilities:['planejamento']} as Member;
 org=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 fn=(await reg('functions',{name:'Assistente de Operações'})).id as string;
});
after(async()=>{await ctx.drop();});

test('duração estimada: grava e valida (0,25 a 24, de quarto em quarto); sem duração a OS lança e fica marcada no dia',async()=>{
 const id=await draft({estimatedHours:2.5});
 assert.equal(Number((await db.first('SELECT estimated_hours FROM plans WHERE id=?',id))!.estimated_hours),2.5);
 assert.equal((await planDetail(planner,id)).plan.estimated_hours,2.5);
 await rejects(draft({estimatedHours:0.3}),400,/duração/i);
 await rejects(draft({estimatedHours:25}),400,/duração/i);
 const none=await draft({});
 assert.ok(((await planningMutate('planning/launch',{id:none,version:(await planDetail(planner,none)).plan.version,launchKey:key()},planner)) as Row).workOrderId);
});

test('equipamento usa a duração da OS por dia; a revisão copia a duração',async()=>{
 const id=await draft({estimatedHours:3,equipment:['eq1']});
 assert.equal(Number((await db.first('SELECT hours_per_day FROM reservations WHERE plan_id=?',id))!.hours_per_day),3);
 const r=await planningMutate('planning/launch',{id,version:(await planDetail(planner,id)).plan.version,launchKey:key()},planner) as Row;
 const rev=await revisionMutate('planning/revision/start',{workOrderId:r.workOrderId},planner) as Row;
 assert.equal(Number((await db.first('SELECT estimated_hours FROM plans WHERE id=?',rev.id))!.estimated_hours),3);
});
