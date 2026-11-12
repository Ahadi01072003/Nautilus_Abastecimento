import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate,registryState} from '../lib/registry';
import {flowsMutate,flowsState} from '../lib/flows';
import {planningMutate,planDetail,validateDraft,ordersList,planningState,availability} from '../lib/planning';
import {revisionMutate} from '../lib/revision';
import {orderDetail,operationMutate} from '../lib/operation';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member;
let org:string,loc:string;
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const at=(day:number,h:number)=>new Date(Date.UTC(2033,4,day,h+3)).toISOString();
/** Planejamento por dia: 00h de Brasília do dia e do dia seguinte (fim exclusivo). */
const d0=(day:number)=>at(day,0),d1=(day:number)=>at(day+1,0);
const ymd=(day:number)=>`2033-05-${String(day).padStart(2,'0')}`;
const key=()=>crypto.randomUUID();
const set=async(who:Member,caps:string[],profile='fueler')=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Porto',acronym:'CPO',category:'cliente',color:'#2B5F7A'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 const type=(await reg('equipment-types',{name:'Empilhadeira'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
});
after(async()=>{await ctx.drop();});

const body=(p:Row,header:Row,stepPatch:Row={})=>({id:p.id,version:p.version,title:p.title,orgId:p.org_id,locationId:p.location_id,plannedStart:p.planned_start,plannedEnd:p.planned_end,description:p.description,...header,
 steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:null,plannedEnd:null,needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,materialId:n.material_id,quantity:n.quantity,amount:n.amount,unit:n.unit})),equipmentIds:s.equipment_ids,operatorIds:s.operator_ids,...stepPatch}))});

test('OS sem fluxo: título, início e fim pelas datas macro, recursos com material e cadastro na hora',async()=>{
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 let p=(await planDetail(planner,id)).plan;
 assert.equal(p.free,1);assert.equal(p.steps.length,1);assert.equal(p.steps[0].step_key,'execucao');
 // O tipo de sistema não aparece no Cadastro de fluxo, nem no seletor de tipos.
 assert.ok(!(await flowsState(manager)).activityTypes.some((t:Row)=>t.system));
 assert.ok((await planningState(planner)).activityTypes.some((t:Row)=>t.system),'o seletor filtra no cliente pela marca system');
 // Cadastro na hora: função e material novos; nome repetido devolve o mesmo cadastro.
 const fn=await planningMutate('planning/resource',{kind:'function',name:'Amarrador'},planner) as Row;
 const again=await planningMutate('planning/resource',{kind:'function',name:'amarrador'},planner) as Row;
 assert.equal(again.id,fn.id);assert.equal(again.existing,true);
 const mat=await planningMutate('planning/resource',{kind:'material',name:'Cinta de amarração 5 t',unit:'un'},planner) as Row;
 await rejects(planningMutate('planning/resource',{kind:'material',name:'Óleo'},planner),400,/Unidade de medida/);
 await rejects(planningMutate('planning/resource',{kind:'outro',name:'X'},planner),400);
 // Operação também cadastra recurso na hora (registro de atividade realizada usa o mesmo formulário).
 assert.ok((await planningMutate('planning/resource',{kind:'material',name:'Óleo',unit:'L'},operator) as Row).id);
 const type=(await db.first("SELECT id FROM equipment_types WHERE name='Empilhadeira'"))!.id;
 await db.run('INSERT INTO operator_functions(operator_id,function_id) VALUES(?,?)','op1',fn.id);
 // Validação: falta título.
 await planningMutate('planning/save',body(p,{orgId:org,locationId:loc,plannedStart:at(3,8),plannedEnd:at(3,17)}),planner);
 assert.ok((await validateDraft(planner,id) as Row).errors.some((e:Row)=>/título/.test(e.message)));
 p=(await planDetail(planner,id)).plan;
 await rejects(planningMutate('planning/save',body(p,{title:'Remoção de sucata'},{needs:[{materialId:mat.id,amount:0,unit:'un'}]}),planner),400,/quantidade do material/);
 await rejects(planningMutate('planning/save',body(p,{title:'Remoção de sucata'},{needs:[{materialId:mat.id,amount:2,unit:'un'},{materialId:mat.id,amount:1,unit:'un'}]}),planner),400,/repetido/);
 // As datas da etapa vêm do cabeçalho, mesmo que a tela mande outras.
 await planningMutate('planning/save',body(p,{title:'Remoção de sucata'},{plannedStart:at(1,1),plannedEnd:at(1,2),equipmentIds:['eq1'],operatorIds:['op1'],
  needs:[{equipmentTypeId:type,quantity:1},{functionId:fn.id,quantity:1},{materialId:mat.id,amount:12.5,unit:'un'}]}),planner);
 p=(await planDetail(planner,id)).plan;
 assert.equal(p.activity_name,'Remoção de sucata');
 assert.equal(p.steps[0].planned_start,d0(3));assert.equal(p.steps[0].planned_end,d1(3),'por dia: o dia 3 inteiro');
 assert.deepEqual(p.steps[0].needs.find((n:Row)=>n.material_id)!.amount,12.5);
 const r=await db.first("SELECT start_at,end_at,status FROM reservations WHERE plan_id=? AND status<>'liberada'",id);
 assert.deepEqual(r,{start_at:d0(3),end_at:d1(3),status:'provisoria'});
 const v=await validateDraft(planner,id) as Row;
 assert.deepEqual(v.errors.map((e:Row)=>e.message),[],JSON.stringify(v.errors));
 // Não troca de tipo e é lançada com o título.
 await rejects(planningMutate('planning/change-type',{id,version:p.version,activityTypeId:p.activity_type_id},planner),409);
 const launched=await planningMutate('planning/launch',{id,version:p.version,launchKey:key()},planner) as Row;
 const list=await ordersList(planner,new URL('http://x/?status=todas'));
 const row=list.orders.find((o:Row)=>o.id===launched.workOrderId)!;
 assert.equal(row.activity_name,'Remoção de sucata');assert.equal(row.free,1);
 const d=await orderDetail(operator,launched.workOrderId);
 assert.equal(d.order.activity_name,'Remoção de sucata');assert.equal(d.steps.length,1);
 // Execução: início e fim da OS.
 await operationMutate('ops/start',{operationKey:key(),stepId:d.steps[0].id},operator);
 await operationMutate('ops/finish',{operationKey:key(),stepId:d.steps[0].id},operator);
 assert.equal((await db.first('SELECT status FROM work_orders WHERE id=?',launched.workOrderId))!.status,'concluida');
});

test('revisão de OS sem fluxo leva o título e os materiais',async()=>{
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 let p=(await planDetail(planner,id)).plan;
 const mat=(await db.first("SELECT id FROM materials LIMIT 1"))!.id;
 await planningMutate('planning/save',body(p,{title:'Arrumação do pátio',orgId:org,locationId:loc,plannedStart:at(6,8),plannedEnd:at(6,12)},{needs:[{materialId:mat,amount:3,unit:'un'}]}),planner);
 p=(await planDetail(planner,id)).plan;
 const {workOrderId}=await planningMutate('planning/launch',{id,version:p.version,launchKey:key()},planner) as Row;
 const rev=await revisionMutate('planning/revision/start',{workOrderId},planner) as Row;
 let d=(await planDetail(planner,rev.id)).plan;
 assert.equal(d.title,'Arrumação do pátio');assert.equal(d.steps[0].needs[0].amount,3);
 await planningMutate('planning/save',body(d,{title:'Arrumação dos pátios 2 e 3',plannedEnd:at(7,14)},{needs:[{materialId:mat,amount:5,unit:'un'}]}),planner);
 const changes=(await validateDraft(planner,rev.id) as Row).changes as string[];
 assert.ok(changes.some(c=>/Título/.test(c)));assert.ok(changes.some(c=>/necessidades/.test(c)));
 d=(await planDetail(planner,rev.id)).plan;
 await revisionMutate('planning/revision/launch',{id:rev.id,version:d.version,launchKey:key(),reason:'Escopo ampliado'},planner);
 const w=await db.first('SELECT title,planned_end FROM work_orders WHERE id=?',workOrderId);
 assert.deepEqual(w,{title:'Arrumação dos pátios 2 e 3',planned_end:d1(7)});
});

test('materiais em Cadastros gerais e códigos de sistema reservados',async()=>{
 const m=await registryMutate('registry/materials',{name:'Óleo hidráulico',unit:'L'},manager) as Row;
 await rejects(registryMutate('registry/materials',{name:'óleo hidráulico',unit:'L'},manager) as Promise<unknown>,0);
 const state=await registryState(manager);
 assert.ok(state.materials.some((x:Row)=>x.id===m.id&&x.unit==='L'));
 await rejects(flowsMutate('flows/save',{code:'SYS.TESTE',name:'Teste',steps:[{key:'a-0001',name:'A'}]},manager),400,/reservados/);
 const free=await db.first("SELECT id,updated_at FROM activity_types WHERE system=1");
 await rejects(flowsMutate('flows/status',{id:free!.id,updatedAt:free!.updated_at,active:false},manager),404);
});

test('OS sem fluxo: dias e horas de uso por equipamento; outra OS divide o dia até 12 h; ano fora da faixa é recusado',async()=>{
 const make=async()=>{const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};return id;};
 const a=await make(),b=await make();
 let p=(await planDetail(planner,a)).plan;
 // Ano 0026 (digitado errado) não é gravado: mensagem clara, nada muda.
 await rejects(planningMutate('planning/save',body(p,{title:'Uso parcial',orgId:org,locationId:loc,plannedStart:'0026-05-20T11:00:00.000Z',plannedEnd:at(20,17)}),planner),400,/ano 26 fora da faixa/);
 // OS de 20 a 22; a empilhadeira só no dia 20, 4 h.
 await planningMutate('planning/save',body(p,{title:'Uso parcial',orgId:org,locationId:loc,plannedStart:ymd(20),plannedEnd:ymd(22)},{equipmentIds:['eq1'],equipmentWindows:{eq1:{start:ymd(20),end:ymd(20)}},equipmentHours:{eq1:4}}),planner);
 const r=(await db.first("SELECT start_at,end_at,hours_per_day FROM reservations WHERE plan_id=? AND status<>'liberada'",a))!;
 assert.deepEqual([r.start_at,r.end_at,Number(r.hours_per_day)],[d0(20),d1(20),4]);
 // Outra OS usa a mesma empilhadeira nos dias 21 e 22: livre, sem conflito.
 let q=(await planDetail(planner,b)).plan;
 const avail=await availability(planner,new URL(`http://x/?start=${ymd(21)}&end=${ymd(22)}&planId=${b}`)) as Row;
 assert.equal(avail.equipment.find((e:Row)=>e.id==='eq1').status,'livre');
 await planningMutate('planning/save',body(q,{title:'Depois',orgId:org,locationId:loc,plannedStart:ymd(21),plannedEnd:ymd(22)},{equipmentIds:['eq1']}),planner);
 // Rascunho não segura o equipamento: o dia 20 inteiro em outro rascunho é aceito (depois volta).
 q=(await planDetail(planner,b)).plan;
 await planningMutate('planning/save',body(q,{title:'Depois',orgId:org,locationId:loc,plannedStart:ymd(20),plannedEnd:ymd(22)},{equipmentIds:['eq1']}),planner);
 q=(await planDetail(planner,b)).plan;
 await planningMutate('planning/save',body(q,{title:'Depois',orgId:org,locationId:loc,plannedStart:ymd(21),plannedEnd:ymd(22)},{equipmentIds:['eq1']}),planner);
 // Dias fora da OS são recusados.
 p=(await planDetail(planner,a)).plan;
 await rejects(planningMutate('planning/save',body(p,{},{equipmentIds:['eq1'],equipmentWindows:{eq1:{start:ymd(19),end:ymd(20)}},equipmentHours:{eq1:4}}),planner),400,/dentro dos dias da OS/);
 assert.equal((p.steps[0].reservations as Row[])[0].start_at,d0(20),'o rascunho carrega os dias salvos');
 await planningMutate('planning/launch',{id:a,version:p.version,launchKey:key()},planner);
 const c=(await db.first("SELECT start_at,end_at,status,hours_per_day FROM reservations WHERE plan_id=? AND status<>'liberada'",a))!;
 assert.deepEqual([c.status,c.start_at,c.end_at,Number(c.hours_per_day)],['confirmada',d0(20),d1(20),4]);
 // Lançada A (4 h no dia 20): B com o dia 20 inteiro é recusada com o motivo; com 8 h cabe (4 + 8 = 12).
 q=(await planDetail(planner,b)).plan;
 await rejects(planningMutate('planning/save',body(q,{title:'Depois',orgId:org,locationId:loc,plannedStart:ymd(20),plannedEnd:ymd(22)},{equipmentIds:['eq1']}),planner),409,/indisponível.*já há 4 h de 12 h/);
 assert.equal((await availability(planner,new URL(`http://x/?start=${ymd(20)}&end=${ymd(20)}&hours=8&planId=${b}`)) as Row).equipment.find((e:Row)=>e.id==='eq1').status,'parcial');
 await planningMutate('planning/save',body(q,{title:'Depois',orgId:org,locationId:loc,plannedStart:ymd(20),plannedEnd:ymd(22)},{equipmentIds:['eq1'],equipmentHours:{eq1:8}}),planner);
 q=(await planDetail(planner,b)).plan;
 await planningMutate('planning/save',body(q,{title:'Depois',orgId:org,locationId:loc,plannedStart:ymd(21),plannedEnd:ymd(22)},{equipmentIds:['eq1']}),planner);
 // A entra em execução: B (21 e 22) segue sem pendência; no dia 20 o equipamento continua com 4 h de A.
 const ops=(path:string,x:Row)=>operationMutate('ops/'+path,{operationKey:key(),...x},operator) as Promise<Row>;
 const wo=(await db.first('SELECT work_order_id FROM plans WHERE id=?',a))!.work_order_id;
 for(const req of (await orderDetail(operator,wo)).requirements as Row[]){
  const inst=await ops('checklist/start',{workOrderId:wo,requirementId:req.id});
  for(const x of (await orderDetail(operator,wo)).questions.filter((y:Row)=>y.version_id===req.version_id))await ops('checklist/answer',{instanceId:inst.id,questionId:x.id,answer:'C'});
  await ops('checklist/complete',{instanceId:inst.id});
 }
 await ops('start',{stepId:(await orderDetail(operator,wo)).steps[0].id});
 const review=await validateDraft(planner,b) as Row;
 assert.equal(review.errors.length,0,JSON.stringify(review.errors));
 assert.equal(((await availability(planner,new URL(`http://x/?start=${ymd(20)}&end=${ymd(20)}`))) as Row).equipment.find((e:Row)=>e.id==='eq1').status,'reservado','12 h não cabem no dia 20');
 q=(await planDetail(planner,b)).plan;
 await planningMutate('planning/launch',{id:b,version:q.version,launchKey:key()},planner);
 const bWo=(await db.first('SELECT work_order_id FROM plans WHERE id=?',b))!.work_order_id;
 await ops('start',{stepId:(await orderDetail(operator,bWo)).steps[0].id});
 const busy=await availability(planner,new URL(`http://x/?start=${ymd(21)}&end=${ymd(21)}`)) as Row;
 assert.match(busy.equipment.find((e:Row)=>e.id==='eq1').detail,/reservado para a etapa .* em 21\/05\/2033 a 22\/05\/2033 \(12 h\/dia\)/);
});
