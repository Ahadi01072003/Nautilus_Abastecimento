// Programação do dia · indicadores por barra, do dia e do mês até hoje: cumprimento (HH concluído ÷ HH consolidado, sem
// emergenciais), ocupação (HH programado ÷ HH disponível), precisão da estimativa (tempo efetivo × duração estimada) e
// emergenciais à parte. Exporta Excel com as abas Dias e OS.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {d1Mutate} from '../lib/d1';
import {operationMutate} from '../lib/operation';
import {indicatorsGet} from '../lib/day-indicators';
import {staffFor} from '../lib/capacity';
import {dayOf} from '../lib/days';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member,org:string,loc:string,fn:string;
const key=()=>crypto.randomUUID();
const today=dayOf(Date.now()),month=today.slice(0,7);
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<Row>;
async function os(hours:number,q:number,title:string){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title,orgId:org,locationId:loc,plannedStart:today,plannedEnd:today,estimatedHours:hours,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,equipmentIds:[],operatorIds:[],needs:[{functionId:fn,quantity:q}]}))},planner);
 const r=await planningMutate('planning/launch',{id,version:(await planDetail(planner,id)).plan.version,launchKey:key()},planner) as Row;
 return r.workOrderId as string;
}
const indicators=async()=>await indicatorsGet('planning/indicators',new URL(`http://x/?bar=equinor&month=${month}`),planner) as Row;

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),['operacao'],'operator');
 org=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 fn=(await reg('functions',{name:'Assistente de Operações'})).id as string;
 for(let i=0;i<3;i++)await reg('operators',{name:`ADM ${i}`,functionIds:[fn],bar:'equinor',schedule:'adm'});
 for(let i=0;i<3;i++)await reg('operators',{name:`T ${i}`,functionIds:[fn],bar:'equinor',schedule:i<2?'turno_a':'turno_b'});
});
after(async()=>{await ctx.drop();});

test('indicadores do dia e do mês: cumprimento, ocupação, precisão e emergenciais; Excel',async()=>{
 const A=await os(4,2,'A');                 // 8 HH
 await os(3,2,'B');                        // 6 HH
 await d1Mutate('planning/d1/consolidate',{day:today,participants:['Ivo Azevedo']},planner);
 await os(2,1,'Emergência');               // 2 HH, depois da consolidação
 const step=await db.first('SELECT id FROM os_steps WHERE work_order_id=?',A);
 await operationMutate('ops/start',{operationKey:key(),stepId:step!.id},operator);
 await operationMutate('ops/finish',{operationKey:key(),stepId:step!.id},operator);
 assert.equal((await db.first('SELECT status FROM work_orders WHERE id=?',A))!.status,'concluida');
 const r=await indicators();
 const d=(r.days as Row[]).find(x=>x.day===today)!;
 const available=(await staffFor('equinor',[today]))[0].hh;
 assert.deepEqual([d.plannedHh,d.doneHh,d.programmedHh,d.availableHh,d.emergencyCount,d.emergencyHh],[14,8,16,available,1,2]);
 assert.equal(d.compliance,57.1);
 assert.equal(d.occupancy,available?Math.round(16/available*1000)/10:null);
 assert.equal(d.precision,0,'executou em segundos uma OS estimada em 4 h');
 assert.deepEqual([r.month.compliance,r.month.emergencyCount,r.month.emergencyHh],[57.1,1,2]);
 const x=await indicatorsGet('planning/indicators/export',new URL(`http://x/?bar=equinor&month=${month}`),planner) as Response;
 assert.match(x.headers.get('content-type')||'',/spreadsheetml/);
 await assert.rejects(indicatorsGet('planning/indicators',new URL(`http://x/?bar=equinor&month=2031-13`),planner),/mês/i);
});
