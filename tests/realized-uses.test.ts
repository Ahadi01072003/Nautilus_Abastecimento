// Registro de atividade realizada · horas de uso dos equipamentos: cada linha com equipamento, início,
// fim e "entra no cálculo de recobráveis". Recobráveis viram usos no Financeiro ligados à OS; as demais
// ficam guardadas na OS. Banco próprio; valores e cliente fictícios (R$ 500/h, 8 h por diária).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {realizeActivity,validateRealized,recoverableEquipment} from '../lib/realized';
import {orderDetail} from '../lib/operation';
import {financeMutate} from '../lib/finance';
import {exportData} from '../lib/exports';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member;
let org:string,loc:string;
const H=3600_000,T=Date.now();
const at=(h:number)=>new Date(T-h*H).toISOString();
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const use=(equipmentId:string,s:number,e:number,recoverable:boolean)=>({key:key(),equipmentId,start:at(s),end:at(e),recoverable});

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base de testes'})).id;
 // Só o eq1 é recobrável para o cliente.
 await financeMutate('finance/rates',{equipmentId:'eq1',orgId:org,hourly:500,hoursPerDay:8,validFrom:'2020-01-01'},manager);
});
after(async()=>{await ctx.drop();});

/** Rascunho de atividade realizada com eq1 e eq2 em "Recursos usados", no período informado. */
async function draft(s:number,e:number,equipmentIds=['eq1','eq2']){
 const {id}=await planningMutate('planning/create-free',{mode:'realizada'},operator) as {id:string};
 const p=(await planDetail(operator,id)).plan;
 const save=(uses:unknown[])=>planningMutate('planning/save',{id,version:p.version,title:'Içamento emergencial',orgId:org,locationId:loc,plannedStart:at(s),plannedEnd:at(e),description:'',notes:[],uses,
  steps:p.steps.map((x:Row)=>({key:x.step_key,included:true,needs:[],equipmentIds,operatorIds:[]}))},operator);
 return {id,save,version:async()=>(await planDetail(operator,id)).plan.version};
}

test('linhas de uso: dentro do período real, sem sobreposição no mesmo equipamento e só de equipamento usado',async()=>{
 const d=await draft(60,52);
 await rejects(d.save([use('eq1',61,59,false)]),400,/entre o início e o fim reais/);
 await rejects(d.save([use('eq1',60,56,true),use('eq1',57,55,true)]),400,/sobrepost/);
 await rejects(d.save([use('eq3',59,58,false)]),400,/Recursos usados/);
 await rejects(d.save([use('eq1',56,56,false)]),400,/depois do início/);
});

test('recobráveis viram usos no Financeiro ligados à OS; os demais ficam só na OS; conferência mostra horas e diárias',async()=>{
 const d=await draft(10,2);
 await d.save([use('eq1',10,6,true),use('eq1',5,3,true),use('eq2',9,8,false)]);
 assert.deepEqual(await recoverableEquipment(operator,new URL(`http://x/?org=${org}&at=${encodeURIComponent(at(10))}`)),{equipmentIds:['eq1']});
 const check=await validateRealized(operator,d.id);
 assert.equal(check.errors.length,0,JSON.stringify(check.errors));
 const rv=check.realized!;
 assert.deepEqual([rv.recoverableHours,rv.otherHours,rv.dailies,rv.valueCents],[6,1,1,400000]);
 const r=await realizeActivity({id:d.id,version:await d.version(),launchKey:key()},operator) as Row;
 const uses=await db.all('SELECT * FROM equipment_uses WHERE work_order_id=? ORDER BY started_at::timestamptz',r.workOrderId);
 assert.deepEqual(uses.map(u=>[u.equipment_id,u.end_source,u.review]),[['eq1','registrado','normal'],['eq1','registrado','normal']]);
 assert.ok(await db.first("SELECT 1 FROM audits WHERE entity_id=? AND action='Operação: uso de equipamento registrado'",uses[0].id));
 const det=await orderDetail(operator,r.workOrderId);
 assert.deepEqual((det.realizedUses as Row[]).map(u=>[u.equipmentId,u.hours,u.recoverable]),[['eq1',4,true],['eq2',1,false],['eq1',2,true]]);
 // Período ocupado na agenda: do primeiro início ao último fim das linhas de cada equipamento.
 const res=await db.all("SELECT r.equipment_id,r.start_at,r.end_at FROM reservations r JOIN work_orders w ON w.current_plan_id=r.plan_id WHERE w.id=? AND r.status<>'liberada' ORDER BY r.equipment_id",r.workOrderId);
 assert.deepEqual(res.map(x=>[x.equipment_id,Date.parse(x.start_at),Date.parse(x.end_at)]),[['eq1',Date.parse(at(10)),Date.parse(at(3))],['eq2',Date.parse(at(9)),Date.parse(at(8))]]);
});

test('recobrável sem tarifa para o cliente é pendência e impede o registro',async()=>{
 const d=await draft(20,14);
 await d.save([use('eq2',19,18,true)]);
 const check=await validateRealized(operator,d.id);
 assert.ok(check.errors.some((e:Row)=>/sem tarifa de recobrável/.test(e.message)),JSON.stringify(check.errors));
 await rejects(realizeActivity({id:d.id,version:await d.version(),launchKey:key()},operator),409,/pendência/);
});

test('equipamento já em uso no Financeiro em outra OS no horário: pendência citando a OS',async()=>{
 // OS livre com o eq1 reservado antes; o Financeiro registra um uso dela mais tarde (fora da reserva).
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'Outra OS',orgId:org,locationId:loc,plannedStart:at(40),plannedEnd:at(39),description:'',
  steps:p.steps.map((x:Row)=>({key:x.step_key,included:true,needs:[],equipmentIds:['eq1'],operatorIds:[]}))},planner);
 const wo=(await planningMutate('planning/launch',{id,version:(await planDetail(planner,id)).plan.version,launchKey:key()},planner) as Row).workOrderId;
 const n=Number((await db.first('SELECT number FROM work_orders WHERE id=?',wo))!.number);
 await financeMutate('finance/uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:at(35),endedAt:at(33)},manager);
 const d=await draft(36,32,['eq1']);
 await d.save([use('eq1',35,34,true)]);
 const check=await validateRealized(operator,d.id);
 assert.ok(check.errors.some((e:Row)=>new RegExp(`já está em uso.*OS ${String(n).padStart(6,'0')}`).test(e.message)),JSON.stringify(check.errors));
});

test('exportação: Horas de uso realizadas, uma linha por uso com "entra no recobrável"',async()=>{
 const url=new URL(`http://x/export?sets=usos_realizados&format=csv&org=${org}`);
 const lines=(await (await exportData(operator,url)).text()).replace(/^﻿/,'').trim().split(/\r?\n/);
 assert.equal(lines[0],['OS','Atividade','Equipamento','Início','Fim','Horas','Entra no recobrável'].map(c=>'"'+c+'"').join(';'));
 const rows=lines.slice(1).filter(l=>l.includes('"Içamento emergencial"'));
 assert.ok(rows.length>=3);
 assert.ok(rows.some(l=>/;4;"Sim"$/.test(l))&&rows.some(l=>/;1;"Não"$/.test(l)),rows.join('\n'));
});
