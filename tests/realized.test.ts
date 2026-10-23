import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail,validateDraft,ordersList,planningState} from '../lib/planning';
import {realizeActivity} from '../lib/realized';
import {orderDetail} from '../lib/operation';
import {conditionMutate} from '../lib/condition';
import {modules} from '../lib/permissions';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member,viewer:Member;
let org:string,loc:string;
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const key=()=>crypto.randomUUID();
const ago=(h:number)=>new Date(Date.now()-h*3600000).toISOString();
const set=async(who:Member,caps:string[],profile='requester')=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const body=(p:Row,header:Row,step:Row={})=>({id:p.id,version:p.version,title:p.title,code:p.code,orgId:p.org_id,locationId:p.location_id,plannedStart:p.planned_start,plannedEnd:p.planned_end,description:p.description,...header,
 steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,materialId:n.material_id,quantity:n.quantity,amount:n.amount,unit:n.unit})),equipmentIds:s.equipment_ids,operatorIds:s.operator_ids,...step}))});

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'none'),['operacao'],'none');
 viewer=await set(await addMember(db,'none'),['acompanhamento'],'none');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Operação',acronym:'OPS',category:'interna',color:'#103B52'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 for(const code of ['MNT-URG.01','PNT-02'])await reg('sectors',{code,name:'Setor '+code});
});
after(async()=>{await ctx.drop();});

test('atividade realizada: Operação registra com o formulário da OS sem fluxo, já executada',async()=>{
 assert.ok(modules(operator).includes('op-registro'));assert.ok(!modules(viewer).includes('op-registro'));
 await rejects(planningMutate('planning/create-free',{mode:'realizada'},viewer),403);
 // Quem só tem Operação não planeja OS (sem fluxo ou com fluxo).
 await rejects(planningMutate('planning/create-free',{},operator),403);
 const {id}=await planningMutate('planning/create-free',{mode:'realizada'},operator) as {id:string};
 let p=(await planDetail(operator,id)).plan;
 assert.equal(p.mode,'realizada');
 assert.ok(!(await planningState(planner)).drafts.some((d:Row)=>d.id===id),'não aparece nos rascunhos do Planejamento');
 assert.ok((await planningState(operator,'realizada')).drafts.some((d:Row)=>d.id===id));
 // Cadastro de recurso na hora também para quem tem Operação.
 const mat=await planningMutate('planning/resource',{kind:'material',name:'Absorvente de óleo',unit:'kg'},operator) as Row;
 await planningMutate('planning/save',body(p,{title:'Contenção de vazamento',code:' mnt-urg.01 ',orgId:org,locationId:loc,plannedStart:ago(5),plannedEnd:ago(2)},
  {equipmentIds:['eq1'],operatorIds:['op1'],needs:[{materialId:mat.id,amount:12.5,unit:'kg'}]}),operator);
 p=(await planDetail(operator,id)).plan;
 assert.equal(p.code,'MNT-URG.01');assert.equal(p.activity_code,'MNT-URG.01');
 await rejects(planningMutate('planning/save',body(p,{code:'código inválido!'}),operator),400,/Código do setor/);
 // Fim no futuro é pendência; "Lançar OS" não vale para registro.
 await planningMutate('planning/save',body(p,{plannedEnd:new Date(Date.now()+3600000).toISOString()}),operator);
 assert.ok((await validateDraft(operator,id) as Row).errors.some((e:Row)=>/não pode estar no futuro/.test(e.message)));
 p=(await planDetail(operator,id)).plan;
 await planningMutate('planning/save',body(p,{plannedEnd:ago(2)}),operator);
 p=(await planDetail(operator,id)).plan;
 await rejects(planningMutate('planning/launch',{id,version:p.version,launchKey:key()},operator),409,/Registrar atividade/);
 const k=key();
 const r=await realizeActivity({id,version:p.version,launchKey:k},operator) as Row;
 assert.equal(r.closure,'concluida');
 assert.equal((await realizeActivity({id,version:p.version,launchKey:k},operator) as Row).repeated,true,'idempotente');
 const w=await db.first('SELECT * FROM work_orders WHERE id=?',r.workOrderId);
 assert.equal(w!.status,'concluida');assert.equal(w!.origin,'realizada');assert.equal(w!.code,'MNT-URG.01');assert.equal(w!.title,'Contenção de vazamento');
 assert.equal(w!.actual_start,p.planned_start);assert.equal(w!.actual_end,p.planned_end);
 const d=await orderDetail(viewer,r.workOrderId);
 assert.equal(d.order.activity_code,'MNT-URG.01');assert.equal(d.steps[0].status,'concluida');
 assert.deepEqual(d.intervals.map((i:Row)=>[i.kind,i.start_at,i.end_at]),[['ativo',p.planned_start,p.planned_end]]);
 assert.ok(d.events.some((e:Row)=>e.kind==='inicio'&&e.detail.late===true),'detalhe JSON legível e marcado como registro posterior');
 assert.equal(await db.first("SELECT status FROM reservations WHERE plan_id=? AND equipment_id='eq1'",id).then(x=>x!.status),'confirmada');
 const list=await ordersList(planner,new URL('http://x/?status=todas&code=mnt-urg'));
 assert.deepEqual(list.orders.map((o:Row)=>o.id),[r.workOrderId]);
 assert.ok((await planningState(operator,'realizada')).codes.includes('MNT-URG.01'),'código sugerido nos próximos registros');
});

test('atividade realizada respeita conflito de equipamento, mas não bloqueio aberto depois do período',async()=>{
 const make=async(start:string,end:string)=>{
  const {id}=await planningMutate('planning/create-free',{mode:'realizada'},operator) as {id:string};
  const p=(await planDetail(operator,id)).plan;
  await planningMutate('planning/save',body(p,{title:'Socorro',orgId:org,locationId:loc,plannedStart:start,plannedEnd:end},{equipmentIds:['eq2']}),operator);
  return (await planDetail(operator,id)).plan;
 };
 const a=await make(ago(30),ago(28));
 await realizeActivity({id:a.id,version:a.version,launchKey:key()},operator);
 // Mesmo equipamento no mesmo horário: recusado.
 const {id:b}=await planningMutate('planning/create-free',{mode:'realizada'},operator) as {id:string};
 const pb=(await planDetail(operator,b)).plan;
 await rejects(planningMutate('planning/save',body(pb,{title:'Duplicado',orgId:org,locationId:loc,plannedStart:ago(29),plannedEnd:ago(27)},{equipmentIds:['eq2']}),operator),409,/indisponível/);
 // Bloqueio aberto agora não impede registrar o que foi feito antes dele.
 await conditionMutate('condition/open',{equipmentId:'eq2',reason:'Pneu furado'},manager);
 const c=await make(ago(10),ago(9));
 const r=await realizeActivity({id:c.id,version:c.version,launchKey:key()},operator) as Row;
 assert.ok(r.workOrderId);
 // Para o futuro, o bloqueio continua valendo (planejamento normal).
 const {id:f}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const pf=(await planDetail(planner,f)).plan;
 await rejects(planningMutate('planning/save',body(pf,{title:'Futuro',orgId:org,locationId:loc,plannedStart:new Date(Date.now()+86400000).toISOString(),plannedEnd:new Date(Date.now()+90000000).toISOString()},{equipmentIds:['eq2']}),planner),409,/bloqueado/);
});

test('OS sem fluxo planejada também leva o código',async()=>{
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 let p=(await planDetail(planner,id)).plan;
 const s=new Date(Date.now()+5*86400000).toISOString(),e=new Date(Date.now()+5*86400000+7200000).toISOString();
 await planningMutate('planning/save',body(p,{title:'Pintura do galpão',code:'PNT-02',orgId:org,locationId:loc,plannedStart:s,plannedEnd:e}),planner);
 p=(await planDetail(planner,id)).plan;
 const r=await planningMutate('planning/launch',{id,version:p.version,launchKey:key()},planner) as Row;
 const w=await db.first('SELECT code,origin FROM work_orders WHERE id=?',r.workOrderId);
 assert.deepEqual(w,{code:'PNT-02',origin:'planejada'});
 // Registro alheio: quem não é o autor não registra (nem vê).
 const {id:other}=await planningMutate('planning/create-free',{mode:'realizada'},planner) as {id:string};
 const po=(await planDetail(planner,other)).plan;
 await rejects(realizeActivity({id:other,version:po.version,launchKey:key()},operator),404);
});
