// Financeiro · recobráveis por equipamento: acesso, travas no banco, tarifas, usos, fim automático,
// painel e exportação. Valores e cliente fictícios (R$ 500/h, 8 h por diária).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {modules,type Member} from '../lib/permissions';
import {financeMutate,financeRates,orderUses,financePanel} from '../lib/finance';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member,fin:Member;
let org:string,other:string,loc:string;
const H=3600_000;
const key=()=>crypto.randomUUID();
const iso=(t:number)=>new Date(t).toISOString();
const ago=(h:number)=>iso(Date.now()-h*H);
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const fm=(path:string,b:Row,who:Member)=>financeMutate('finance/'+path,b,who) as Promise<Row>;
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

// ---- Tarefa 3: tarifas e usos ----
let wo:string;
test('tarifas: só Financeiro/Gestão; nova vigência não altera a anterior; data repetida recusa',async()=>{
 await rejects(fm('rates',{equipmentId:'eq1',orgId:org,hourly:500,hoursPerDay:8,validFrom:'2020-01-01'},operator),403);
 const r=await fm('rates',{equipmentId:'eq1',orgId:org,hourly:500,hoursPerDay:8,validFrom:'2020-01-01'},fin);
 await rejects(fm('rates',{equipmentId:'eq1',orgId:org,hourly:600,hoursPerDay:8,validFrom:'2020-01-01'},fin),409,/vigência nessa data/);
 await rejects(fm('rates',{equipmentId:'eq1',orgId:org,hourly:500,hoursPerDay:200,validFrom:'2020-02-01'},fin),400,/horas por diária/i);
 const list=(await financeRates(fin)).rates as Row[];
 assert.deepEqual(list.filter(x=>x.equipment_id==='eq1').map(x=>[x.id,x.hourly_cents,x.hours_per_day]),[[r.id,50000,8]]);
 await rejects(financeRates(operator),403);
});

test('uso: Operação inicia e encerra; idempotente pela operationKey; sem tarifa recusa',async()=>{
 wo=await launchFree(org,ago(20),ago(-4),['eq1']);
 const k=key();
 const u=await fm('uses/start',{operationKey:k,workOrderId:wo,equipmentId:'eq1',startedAt:ago(19)},operator);
 assert.equal((await fm('uses/start',{operationKey:k,workOrderId:wo,equipmentId:'eq1',startedAt:ago(19)},operator)).id,u.id);
 await fm('uses/end',{id:u.id,endedAt:ago(17)},operator);
 const row=(await db.first('SELECT * FROM equipment_uses WHERE id=?',u.id))!;
 assert.deepEqual([row.end_source,row.review,row.started_by],['registrado','normal',operator.id]);
 const view=await orderUses(operator,wo);
 assert.equal(view.eligible,true);assert.deepEqual(view.equipment.map(e=>e.id),['eq1']);
 assert.equal(view.dailies.length,1);assert.equal(view.dailies[0].valueCents,400000);
 const woOther=await launchFree(other,ago(60),ago(50),['eq2']);
 await rejects(fm('uses/start',{operationKey:key(),workOrderId:woOther,equipmentId:'eq2',startedAt:ago(59)},operator),400,/sem tarifa/);
 assert.equal((await orderUses(operator,woOther)).eligible,false);
 await rejects(fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq2',startedAt:ago(16)},operator),400,/reservado nesta OS/);
});

test('uso: sobreposição do mesmo equipamento em outra OS recusa citando a OS',async()=>{
 const wo2=await launchFree(org,ago(40),ago(36),['eq1']);
 const open=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:ago(15)},operator);
 await rejects(fm('uses/start',{operationKey:key(),workOrderId:wo2,equipmentId:'eq1',startedAt:ago(14)},operator),409,/OS \d{6}/);
 await fm('uses/end',{id:open.id,endedAt:ago(14.5)},operator);
});

test('uso: mais de uma diária pede confirmação e não grava sem ela',async()=>{
 // Começa às 13 h atrás, dentro da diária aberta pelo uso das 19 h atrás (vai até 11 h atrás), e
 // termina 4 h atrás: entra na 1ª diária e abre a 2ª.
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:ago(13)},operator);
 const ask=await fm('uses/end',{id:u.id,endedAt:ago(4)},operator);
 assert.equal(ask.confirm,true);assert.equal(ask.dailies,2);assert.match(String(ask.message),/gera 2 diárias \(R\$\s?8\.000,00\)/);
 assert.equal((await db.first('SELECT ended_at FROM equipment_uses WHERE id=?',u.id))!.ended_at,null,'nada gravado');
 await fm('uses/end',{id:u.id,endedAt:ago(4),confirm:true},operator);
 assert.ok((await db.first('SELECT ended_at FROM equipment_uses WHERE id=?',u.id))!.ended_at);
 // Registro retroativo completo (início e fim juntos) também pede confirmação.
 const w2=await launchFree(org,ago(200),ago(180),['eq1']);
 const k=key();
 assert.equal((await fm('uses/start',{operationKey:k,workOrderId:w2,equipmentId:'eq1',startedAt:ago(199),endedAt:ago(185)},fin)).confirm,true);
 assert.ok(!(await db.first('SELECT 1 FROM equipment_uses WHERE operation_key=?',k)));
});

test('uso retroativo: início sem fim antes de um uso já registrado pede o fim junto',async()=>{
 await rejects(fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:ago(19.5)},operator),409,/informe também o fim/);
});

test('uso: fora do reservado por mais de 30 min fica a conferir; dentro fica normal',async()=>{
 const w=await launchFree(org,ago(100),ago(96),['eq1']);
 const inside=await fm('uses/start',{operationKey:key(),workOrderId:w,equipmentId:'eq1',startedAt:ago(99.9),endedAt:ago(96.2)},operator);
 assert.equal((await db.first('SELECT review FROM equipment_uses WHERE id=?',inside.id))!.review,'normal');
 const out=await fm('uses/start',{operationKey:key(),workOrderId:w,equipmentId:'eq1',startedAt:ago(96),endedAt:ago(95)},operator);
 assert.equal((await db.first('SELECT review FROM equipment_uses WHERE id=?',out.id))!.review,'a_conferir');
});

test('uso: Operação não registra em OS concluída; Financeiro registra',async()=>{
 const w=await launchFree(org,ago(130),ago(126),['eq1']);
 await db.run("UPDATE work_orders SET status='concluida' WHERE id=?",w);
 await rejects(fm('uses/start',{operationKey:key(),workOrderId:w,equipmentId:'eq1',startedAt:ago(129)},operator),409,/Financeiro/);
 const u=await fm('uses/start',{operationKey:key(),workOrderId:w,equipmentId:'eq1',startedAt:ago(129),endedAt:ago(127)},fin);
 assert.ok(await db.first("SELECT 1 FROM audits WHERE action='Financeiro: uso registrado' AND entity_id=?",u.id));
});

test('correção: exige motivo, audita antes/depois, não cria sobreposição; confirmar passa a conferido',async()=>{
 const w=await launchFree(org,ago(160),ago(150),['eq1']);
 const a=await fm('uses/start',{operationKey:key(),workOrderId:w,equipmentId:'eq1',startedAt:ago(159),endedAt:ago(158)},operator);
 const b=await fm('uses/start',{operationKey:key(),workOrderId:w,equipmentId:'eq1',startedAt:ago(157),endedAt:ago(156)},operator);
 await rejects(fm('uses/correct',{id:a.id,endedAt:ago(157.5)},fin),400,/Motivo/);
 await rejects(fm('uses/correct',{id:a.id,endedAt:ago(156.5),reason:'Fim digitado errado'},fin),409,/OS \d{6}/);
 await rejects(fm('uses/correct',{id:a.id,endedAt:ago(157.5),reason:'x'},operator),403);
 const fixed=ago(157.5);
 await fm('uses/correct',{id:a.id,endedAt:fixed,reason:'Fim digitado errado'},fin);
 const row=(await db.first('SELECT * FROM equipment_uses WHERE id=?',a.id))!;
 assert.equal(row.ended_at,fixed,'fim corrigido');
 assert.equal(row.review,'conferido');
 const au=(await db.first("SELECT detail FROM audits WHERE action='Financeiro: uso corrigido' AND entity_id=?",a.id))!;
 const det=typeof au.detail==='string'?JSON.parse(au.detail):au.detail;
 assert.ok(det.before.endedAt&&det.after.endedAt&&det.reason==='Fim digitado errado');
 await fm('uses/confirm',{id:b.id},fin);
 assert.equal((await db.first('SELECT review FROM equipment_uses WHERE id=?',b.id))!.review,'conferido');
});

test('datas: futuro e antes de 2020 recusados',async()=>{
 await rejects(fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:iso(Date.now()+2*H)},operator),400,/futuro/);
 await rejects(fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:'2019-06-01T12:00:00Z'},fin),400,/2020/);
});

// ---- Tarefa 6: painel ----
test('painel: previsto pelas reservas e realizado pelos usos, no período',async()=>{
 const L=(d:string,h:string)=>new Date(`${d}T${h}:00-03:00`).toISOString();
 // OS programada em 10/09 (08–18) e OS concluída de 11/09 08:00 a 12/09 12:00, ambas com a eq1.
 const P=await launchFree(org,L('2026-09-10','08:00'),L('2026-09-10','18:00'),['eq1']);
 const C=await launchFree(org,L('2026-09-11','08:00'),L('2026-09-12','12:00'),['eq1']);
 await db.run("UPDATE work_orders SET status='concluida' WHERE id=?",C);
 const reg=(wo:string,a:string,b:string)=>fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:a,endedAt:b,confirm:true},fin);
 await reg(P,L('2026-09-10','22:00'),L('2026-09-11','01:00')); // fora do reservado: a conferir; diária começa em 10/09
 await reg(C,L('2026-09-11','08:00'),L('2026-09-11','10:00')); // dentro: conferida
 await reg(C,L('2026-09-12','09:00'),L('2026-09-12','10:00'));
 await reg(C,L('2026-09-12','11:00'),L('2026-09-12','13:00')); // passa 60 min do reservado: a conferir
 const panel=(q:string)=>financePanel(fin,new URL('http://x/?'+q));
 const all=(await panel(`from=2026-09-10&to=2026-09-12&org=${org}`)).rows.find(r=>r.equipmentId==='eq1')!;
 assert.deepEqual([all.requests,all.scheduled,all.plannedHours],[2,1,38]);
 // Reservas: 10/09 08–18 (2 diárias) + 11/09 08:00 a 12/09 12:00 (4 diárias).
 assert.deepEqual([all.plannedDailies,all.plannedCents,all.avgPerOrderCents],[6,2400000,1200000]);
 assert.deepEqual([all.dailies,all.confirmedCents,all.pendingCents],[3,400000,800000]);
 // Período só com 11 e 12/09: a OS de 10/09 e a diária que começou em 10/09 ficam de fora.
 const part=(await panel(`from=2026-09-11&to=2026-09-12&org=${org}`)).rows.find(r=>r.equipmentId==='eq1')!;
 assert.deepEqual([part.requests,part.scheduled,part.dailies,part.confirmedCents,part.pendingCents],[1,0,2,400000,400000]);
 const det=(await panel(`from=2026-09-11&to=2026-09-12&org=${org}`)).detail[`eq1|${org}`];
 assert.equal(det.dailies.length,2);assert.equal(det.pending.length,1);
 await rejects(panel('from=2026-09-12&to=2026-09-11'),400);
 await rejects(financePanel(operator,new URL('http://x/')),403);
});
