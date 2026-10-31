// Regras de equipamento em todas as fases: horas de uso, OS inteira em andamento (inclusive depois
// do previsto), início de etapa fora do horário reservado, inativação com reservas, revisão sem
// alterações e avisos da revisão antes de lançar.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail,validateDraft,availability} from '../lib/planning';
import {revisionMutate} from '../lib/revision';
import {orderDetail,operationMutate,startCheck} from '../lib/operation';
import {cancelOrder} from '../lib/cancel';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member;
let org:string,loc:string,type:string;
const H=3600_000,T=Date.now();
const at=(h:number)=>new Date(T+h*H).toISOString();
const key=()=>crypto.randomUUID();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const ops=(path:string,b:Row)=>operationMutate('ops/'+path,{operationKey:key(),...b},operator) as Promise<Row>;
const avail=async(a:string,b:string,eq:string)=>((await availability(planner,new URL(`http://x/?start=${encodeURIComponent(a)}&end=${encodeURIComponent(b)}`))).equipment as Row[]).find(e=>e.id===eq)!;

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Porto',acronym:'CPO',category:'cliente',color:'#2B5F7A'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 type=(await reg('equipment-types',{name:'Plataforma'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
});
after(async()=>{await ctx.drop();});

/** OS sem fluxo lançada: período da OS e, opcionalmente, horas de uso de um equipamento. */
async function freeOs(start:string,end:string,eq:string,win?:{start:string,end:string}){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'Uso de '+eq,orgId:org,locationId:loc,plannedStart:start,plannedEnd:end,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:null,plannedEnd:null,needs:[],equipmentIds:[eq],operatorIds:[],...(win?{equipmentWindows:{[eq]:win}}:{})}))},planner);
 const v=(await planDetail(planner,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as Row;
 const wo=r.workOrderId as string;
 const step=(await orderDetail(operator,wo)).steps[0] as Row;
 return {plan:id,wo,step:step.id as string};
}
/** Desloca no tempo a etapa e a reserva de uma OS (simula a passagem do tempo nos testes). */
async function shift(planId:string,start:string,end:string,resStart=start,resEnd=end){
 await db.tx(async tx=>{await tx.run('SET LOCAL session_replication_role=replica');
  await tx.run('UPDATE plan_steps SET planned_start=?,planned_end=? WHERE plan_id=?',start,end,planId);
  await tx.run("UPDATE reservations SET start_at=?,end_at=? WHERE plan_id=? AND status<>'liberada'",resStart,resEnd,planId);});
}

test('horas de uso valem mesmo com a OS em andamento: o restante da OS fica livre para outras',async()=>{
 // OS de 9 dias; a plataforma só nos 3 primeiros (caso da PTA na OS 040).
 const a=await freeOs(at(24),at(24*9),'eq1',{start:at(24),end:at(24*4)});
 await ops('start',{stepId:a.step});
 assert.equal((await avail(at(24*5),at(24*7),'eq1')).status,'livre','depois das horas de uso, livre mesmo com a OS em andamento');
 const inside=await avail(at(24*2),at(24*3),'eq1');
 assert.equal(inside.status,'reservado');assert.doesNotMatch(inside.detail,/ainda não finalizada/,'dentro das horas de uso: reserva comum, não "em uso até finalizar"');
 const b=await freeOs(at(24*5),at(24*7),'eq1');assert.ok(b.wo,'outra OS lança no período livre');
 await rejects(freeOs(at(24*3),at(24*5),'eq1'),409,/indisponível/);
});

test('OS inteira em andamento depois do previsto: o equipamento libera no fim previsto, mesmo sem finalizar',async()=>{
 const c=await freeOs(at(1),at(3),'eq2');
 await ops('start',{stepId:c.step});
 await shift(c.plan,at(-5),at(-1));
 assert.equal((await avail(at(-0.5),at(0.5),'eq2')).status,'livre','passou do fim previsto: livre');
 // Outra OS agora, com a anterior ainda em andamento: lança sem pendência nem aviso e pode começar.
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'Depois',orgId:org,locationId:loc,plannedStart:at(-0.5),plannedEnd:at(2),steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:null,plannedEnd:null,needs:[],equipmentIds:['eq2'],operatorIds:[]}))},planner);
 const review=await validateDraft(planner,id) as Row;
 assert.equal(review.errors.length,0,JSON.stringify(review.errors));
 assert.ok(!review.warnings.some((w:Row)=>/EMP-02/.test(w.message)),JSON.stringify(review.warnings));
 const v=(await planDetail(planner,id)).plan.version;
 const d=await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as Row;
 const dStep=(await orderDetail(operator,d.workOrderId)).steps[0] as Row;
 assert.ok(!((await startCheck(operator,dStep.id)).blockers as string[]).some(b=>/EMP-02/.test(b)),'a anterior passou do previsto: não barra o início');
 await ops('finish',{stepId:c.step});
});

test('início de etapa: equipamento reservado agora por outra OS barra o início antecipado; horas de uso futuras não barram',async()=>{
 // H tem a plataforma reservada para agora (não iniciada).
 const h=await freeOs(at(24*30),at(24*31),'eq1');
 await shift(h.plan,at(-1),at(5));
 // J quer começar agora, antes do horário dela: barrado com o motivo e os dois horários.
 const j=await freeOs(at(24*32),at(24*33),'eq1');
 const blockers=(await startCheck(operator,j.step)).blockers as string[];
 assert.ok(blockers.some(b=>/EMP-01 está reservado agora para a etapa .* Inicie no horário da sua reserva/.test(b)),JSON.stringify(blockers));
 await rejects(ops('start',{stepId:j.step}),409);
 // K usa a plataforma só mais tarde (horas de uso): começar agora não depende dela.
 const k=await freeOs(at(24*35),at(24*36),'eq1',{start:at(24*35+5),end:at(24*35+6)});
 assert.ok(!((await startCheck(operator,k.step)).blockers as string[]).some(b=>/EMP-01/.test(b)));
 await ops('start',{stepId:k.step});
});

test('revisão sem alterações: sinalizada e relançada, com histórico',async()=>{
 const l=await freeOs(at(24*40),at(24*41),'eq2');
 const r=await revisionMutate('planning/revision/start',{workOrderId:l.wo},planner) as Row;
 const review=await validateDraft(planner,r.id) as Row;
 assert.deepEqual(review.changes,[],'nenhuma diferença');assert.equal(review.errors.length,0);
 const v=(await planDetail(planner,r.id)).plan.version;
 await rejects(revisionMutate('planning/revision/launch',{id:r.id,version:v,launchKey:key(),reason:''},planner),400,/Motivo/);
 const out=await revisionMutate('planning/revision/launch',{id:r.id,version:v,launchKey:key(),reason:'Conferência com o cliente'},planner) as Row;
 assert.equal(out.unchanged,true);assert.match(out.message,/sem alterações/);
 const wo=(await db.first('SELECT revision,current_plan_id FROM work_orders WHERE id=?',l.wo))!;
 assert.deepEqual([wo.revision,wo.current_plan_id],[1,r.id]);
 assert.deepEqual((await db.all("SELECT plan_id,status FROM reservations WHERE plan_id IN (?,?) ORDER BY status",l.plan,r.id)).map(x=>[x.plan_id===r.id?'nova':'antiga',x.status]),[['nova','confirmada'],['antiga','liberada']]);
 const hist=(await planDetail(planner,r.id)).revisions as Row[];
 assert.equal(hist.find(h=>h.id===r.id)!.revision_unchanged,1);
 // Consultar a OS não abre revisão: o plano vigente é só lido.
 const view=await planDetail(planner,r.id);assert.equal(view.editable,false);
 assert.equal((await db.first("SELECT count(*)::int n FROM plans WHERE work_order_id=? AND status='draft'",l.wo))!.n,0);
});

test('inativar equipamento com reservas a partir de agora é recusado; sem reservas, permitido',async()=>{
 const eq=(id:string)=>db.first('SELECT * FROM equipment WHERE id=?',id);
 const body=(e:Row,active:boolean)=>({id:e.id,tag:e.tag,description:e.description,typeId:type,fuelIds:e.fuel_ids,active});
 await rejects(registryMutate('registry/equipment',body((await eq('eq2'))!,false),manager),409,/EMP-02 tem reservas a partir de agora \(OS \d{6}/);
 // Cancelada a OS futura (e finalizada a outra), a inativação passa.
 for(const w of await db.all("SELECT DISTINCT w.id FROM work_orders w JOIN reservations r ON r.plan_id=w.current_plan_id AND r.status<>'liberada' AND r.equipment_id='eq2' WHERE w.status IN ('programada','em_andamento') AND r.end_at::timestamptz > now()"))
  await cancelOrder({workOrderId:w.id,reason:'Teste de inativação'},manager);
 await registryMutate('registry/equipment',body((await eq('eq2'))!,false),manager);
 assert.equal((await eq('eq2'))!.active,0);
});

test('aviso: OS nova com início previsto no passado',async()=>{
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'Atrasada',orgId:org,locationId:loc,plannedStart:at(-3),plannedEnd:at(2),steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:null,plannedEnd:null,needs:[],equipmentIds:[],operatorIds:[]}))},planner);
 const review=await validateDraft(planner,id) as Row;
 assert.ok(review.warnings.some((w:Row)=>/início previsto .* já passou/.test(w.message)));
 assert.equal(review.errors.length,0,'é aviso, não pendência');
});

test('revisão que estende as horas de uso sobre outra OS: recusada na gravação, com o motivo',async()=>{
 // M usa a plataforma do dia 50 ao 51 (horas de uso dentro de uma OS de 50 a 55); N usa nos dias 52-53.
 const m=await freeOs(at(24*50),at(24*55),'eq1',{start:at(24*50),end:at(24*51)});
 const n=await freeOs(at(24*52),at(24*53),'eq1');assert.ok(n.wo);
 const r=await revisionMutate('planning/revision/start',{workOrderId:m.wo},planner) as Row;
 const p=(await planDetail(planner,r.id)).plan;
 const save=(win:{start:string,end:string})=>planningMutate('planning/save',{id:r.id,version:p.version,title:p.title,orgId:org,locationId:loc,plannedStart:p.planned_start,plannedEnd:p.planned_end,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:null,plannedEnd:null,needs:[],equipmentIds:['eq1'],operatorIds:[],equipmentWindows:{eq1:win}}))},planner);
 await rejects(save({start:at(24*50),end:at(24*53)}),409,/EMP-01 indisponível/);
 // Estender até antes da outra OS é aceito; a OS só muda quando a revisão for lançada.
 await save({start:at(24*50),end:at(24*52)});
 const before=(await db.first("SELECT end_at FROM reservations WHERE plan_id=? AND status<>'liberada'",m.plan))!.end_at;
 assert.equal(before,at(24*51),'a versão vigente continua com as horas de uso originais');
});

test('versões anteriores e acesso de consulta: só leitura, sem abrir revisão',async()=>{
 const o=await freeOs(at(24*60),at(24*61),'eq1');
 const r=await revisionMutate('planning/revision/start',{workOrderId:o.wo},planner) as Row;
 const v=(await planDetail(planner,r.id)).plan.version;
 await revisionMutate('planning/revision/launch',{id:r.id,version:v,launchKey:key(),reason:'Sem mudanças'},planner);
 const old=await planDetail(planner,o.plan);
 assert.equal(old.plan.status,'superseded');assert.equal(old.editable,false);
 assert.deepEqual((old.revisions as Row[]).map(x=>x.revision),[1,0]);
 // Acompanhamento (consulta) vê os detalhes da OS, mas não altera nem revisa.
 const viewer=await set(await addMember(db,'operator'),['acompanhamento'],'operator');
 assert.equal((await planDetail(viewer,r.id)).editable,false);
 await rejects(revisionMutate('planning/revision/start',{workOrderId:o.wo},viewer),403);
 await rejects(planningMutate('planning/save',{id:r.id,version:v+1},viewer),403);
});

test('inativar equipamento com abastecimento solicitado ou agendado é recusado',async()=>{
 await db.run("INSERT INTO equipment(id,tag,description,type,type_id,fuel_ids,active) VALUES('eq9','EMP-09','Empilhadeira 9','Plataforma',?,ARRAY['diesel'],1)",type);
 const fueler=await set(await addMember(db,'fueler'),[],'fueler');
 const {id}=await mutate('appointments',{operationKey:key(),equipmentId:'eq9',fuelId:'diesel',hourmeter:10},fueler) as {id:string};
 const e=(await db.first("SELECT * FROM equipment WHERE id='eq9'"))!;
 const body={id:'eq9',tag:e.tag,description:e.description,typeId:type,fuelIds:e.fuel_ids,active:false};
 await rejects(registryMutate('registry/equipment',body,manager),409,/abastecimento\(s\) solicitado/);
 const ap=(await db.first('SELECT version FROM appointments WHERE id=?',id))!;
 await mutate('appointments/cancel',{id,version:ap.version,reason:'Equipamento vai sair de operação'},manager);
 await registryMutate('registry/equipment',body,manager);
});
