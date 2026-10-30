// Financeiro · fim automático do uso de equipamento (etapa finalizada ou OS cancelada) e avisos do
// Painel central. Banco próprio: os testes iniciam etapas e usos "agora". Valores fictícios.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {planningMutate,planDetail} from '../lib/planning';
import {orderDetail,operationMutate} from '../lib/operation';
import {cancelOrder} from '../lib/cancel';
import {centralState} from '../lib/central';
import {financeMutate,orderUses} from '../lib/finance';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member,fin:Member;
let org:string,loc:string,flow:string;
const H=3600_000;
const key=()=>crypto.randomUUID();
const at=(h:number)=>new Date(Date.now()+h*H).toISOString();
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const ops=(path:string,b:Row)=>operationMutate('ops/'+path,{operationKey:key(),...b},operator) as Promise<Row>;
const fm=(path:string,b:Row,who:Member=operator)=>financeMutate('finance/'+path,b,who) as Promise<Row>;
const use=(id:string)=>db.first('SELECT * FROM equipment_uses WHERE id=?',id) as Promise<Row>;

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 fin=await set(await addMember(db,'planner'),['financeiro'],'planner');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base de testes'})).id;
 const type=(await reg('equipment-types',{name:'Plataforma'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
 await db.run("INSERT INTO equipment(id,tag,description,type,type_id,fuel_ids,active) VALUES('eq3','PTA-03','Plataforma 3','Plataforma',?,ARRAY['diesel'],1)",type);
 for(const eq of ['eq1','eq2','eq3'])await financeMutate('finance/rates',{equipmentId:eq,orgId:org,hourly:500,hoursPerDay:8,validFrom:'2020-01-01'},manager);
 flow=(await flowsMutate('flows/save',{code:'ICA',name:'Içamento',steps:[
  {key:'a-0001',name:'Preparação',needs:[{equipmentTypeId:type,quantity:1}]},
  {key:'b-0001',name:'Içamento',needs:[{equipmentTypeId:type,quantity:1}]},
 ]},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

async function launch(start:number,end:number,eq:string,steps?:Record<string,[number,number]>){
 const {id}=await planningMutate(steps?'planning/create':'planning/create-free',steps?{activityTypeId:flow}:{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:p.free?'Içamento':undefined,orgId:org,locationId:loc,plannedStart:at(start),plannedEnd:at(end),description:'',
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:steps?at(steps[s.step_key][0]):null,plannedEnd:steps?at(steps[s.step_key][1]):null,
   needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,materialId:n.material_id,quantity:n.quantity,amount:n.amount,unit:n.unit})),equipmentIds:[eq],operatorIds:[]}))},planner);
 const v=(await planDetail(planner,id)).plan.version;
 return (await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as {workOrderId:string}).workOrderId;
}
const stepOf=async(wo:string,k:string)=>(await orderDetail(operator,wo)).steps.find((s:Row)=>s.step_key===k)!;

test('fim automático: finalizar a última etapa aberta com o equipamento encerra o uso como a conferir; etapa intermediária não',async()=>{
 const wo=await launch(-1,5,'eq1',{'a-0001':[-1,1],'b-0001':[1,3]});
 const a=await stepOf(wo,'a-0001');
 await ops('start',{stepId:a.id});
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:at(-0.5)});
 await ops('finish',{stepId:a.id});
 assert.equal((await use(u.id)).ended_at,null,'a etapa Içamento ainda usa o equipamento');
 const b=await stepOf(wo,'b-0001');
 await ops('start',{stepId:b.id});await ops('finish',{stepId:b.id});
 const row=await use(u.id);
 assert.ok(row.ended_at);assert.equal(row.end_source,'etapa');assert.equal(row.review,'a_conferir');
});

test('fim automático: cancelar a OS encerra o uso aberto',async()=>{
 const wo=await launch(-3,3,'eq2');
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq2',startedAt:at(-2)});
 await cancelOrder({workOrderId:wo,reason:'Cliente desistiu'},planner);
 const row=await use(u.id);
 assert.equal(row.end_source,'cancelamento');assert.equal(row.review,'a_conferir');
});

test('aviso: uso aberto há 9 h aparece no Painel central; as diárias contam até agora e ficam a conferir',async()=>{
 const wo=await launch(-12,2,'eq3');
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq3',startedAt:at(-9)});
 const forOps=(await centralState(operator)).alerts as Row[];
 const al=forOps.find(x=>x.id==='use:'+u.id);
 assert.ok(al,'Operação vê o aviso');assert.equal(al!.module,'financeiro');assert.match(al!.title,/PTA-03 em uso há 9 h sem fim registrado/);
 assert.deepEqual(al!.link,{view:'op-os',os:wo});
 assert.ok(!forOps.some(x=>x.id==='uses:review'),'conferência é do Financeiro');
 const forFin=(await centralState(fin)).alerts as Row[];
 assert.ok(forFin.some(x=>x.id==='uses:review'&&/2 uso\(s\) de equipamento a conferir/.test(x.title)));
 const d=(await orderUses(fin,wo)).dailies;
 assert.equal(d.length,2);assert.ok(d.every(x=>x.pending));
});
