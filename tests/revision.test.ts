import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {cancelOrder} from '../lib/cancel';
import {planningMutate,planDetail,validateDraft,ordersSteps} from '../lib/planning';
import {revisionMutate} from '../lib/revision';
import {conditionMutate} from '../lib/condition';
import {orderDetail,operationMutate} from '../lib/operation';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,planner2:Member,operator:Member,viewer:Member;
let flow:string,org:string,loc:string;
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const at=(day:number,h:number,m=0)=>new Date(Date.UTC(2032,2,day,h+3,m)).toISOString();
const key=()=>crypto.randomUUID();
const set=async(who:Member,caps:string[],profile='fueler')=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const ops=(path:string,b:Row,who:Member=operator)=>operationMutate('ops/'+path,{operationKey:key(),...b},who) as Promise<Row>;
const revise=(path:string,b:Row,who:Member=planner)=>revisionMutate('planning/revision/'+path,b,who) as Promise<Row>;

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 planner2=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 viewer=await set(await addMember(db,'fueler'),['acompanhamento'],'fueler');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Operação',acronym:'OPS',category:'interna',color:'#103B52'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 const type=(await reg('equipment-types',{name:'Empilhadeira'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
 flow=(await flowsMutate('flows/save',{code:'REV',name:'Movimentação revisável',steps:[
  {key:'prep-0001',name:'Preparação'},
  {key:'insp-0001',name:'Inspeção',needs:[{equipmentTypeId:type,quantity:1}]},
  {key:'move-0001',name:'Movimentação',dependsOn:['prep-0001','insp-0001']},
  {key:'limp-0001',name:'Limpeza',required:false,dependsOn:['move-0001']},
 ]},manager) as {id:string}).id;
 await reg('checklists',{code:'CK-EQ',title:'Pré-uso empilhadeira',moment:'pre_uso',mandatory:false,links:{equipmentTypeIds:[type]},questions:[{text:'Freios?',required:true,critical:false,target:'equipamento',allowNa:false,noteOn:['NC']}]});
});
after(async()=>{await ctx.drop();});

const times=(day:number):Record<string,[string,string]>=>({'prep-0001':[at(day,8),at(day,10)],'insp-0001':[at(day,8),at(day,10)],'move-0001':[at(day,10),at(day,12)],'limp-0001':[at(day,12),at(day,13)]});
/** Corpo de gravação a partir do planejamento carregado, com ajustes por etapa. */
function body(p:Row,patch:Record<string,Row>={},header:Row={}){
 return {id:p.id,version:p.version,orgId:p.org_id,locationId:p.location_id,plannedStart:p.planned_start,plannedEnd:p.planned_end,description:p.description,...header,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:!!s.included,plannedStart:s.planned_start,plannedEnd:s.planned_end,needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,quantity:n.quantity})),equipmentIds:s.equipment_ids,operatorIds:s.operator_ids,...patch[s.step_key]}))};
}
async function launch(day:number,eq='eq1'){
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 const t=times(day);
 await planningMutate('planning/save',body(p,Object.fromEntries(Object.keys(t).map(k=>[k,{included:true,plannedStart:t[k][0],plannedEnd:t[k][1],equipmentIds:k==='insp-0001'?[eq]:[],operatorIds:k==='prep-0001'?['op1']:[]}])),{orgId:org,locationId:loc,plannedStart:at(day,7),plannedEnd:at(day,18)}),planner);
 const v=(await planDetail(planner,id)).plan.version;
 return (await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as {workOrderId:string}).workOrderId;
}
const order=(wo:string)=>db.first('SELECT * FROM work_orders WHERE id=?',wo) as Promise<Row>;
const draftOf=async(id:string,who:Member=planner)=>(await planDetail(who,id)).plan;
const save=(p:Row,patch:Record<string,Row>={},header:Row={},who:Member=planner)=>planningMutate('planning/save',body(p,patch,header),who) as Promise<Row>;
async function launchRevision(id:string,reason='Cliente pediu outro horário',who:Member=planner){
 const p=await draftOf(id,who);
 return revise('launch',{id,version:p.version,launchKey:key(),reason},who);
}

test('revisão de OS programada: mesmo número, troca atômica de reservas, etapas com a mesma identidade',async()=>{
 const wo=await launch(3);
 const before=await order(wo);
 const stepsBefore=await db.all('SELECT id,step_key,plan_step_id FROM os_steps WHERE work_order_id=? ORDER BY step_key',wo);
 const {id}=await revise('start',{workOrderId:wo});
 const draft=await draftOf(id);
 assert.equal(draft.status,'draft');assert.equal(draft.revision,1);assert.equal(draft.os_number,before.number);
 assert.equal((await db.first("SELECT count(*)::int n FROM reservations WHERE plan_id=? AND status='provisoria'",id))!.n,1,'a reserva vigente é transportada para o rascunho');
 // A OS segue valendo como está enquanto a revisão é rascunho.
 assert.equal((await order(wo)).current_plan_id,before.current_plan_id);
 // Mesmo número de rascunho na reabertura; outra pessoa não abre uma segunda revisão.
 assert.equal((await revise('start',{workOrderId:wo})).id,id);
 await rejects(revise('start',{workOrderId:wo},planner2),409,/revisão em rascunho/);
 // Troca o equipamento da Inspeção e adia a Movimentação.
 await save(draft,{'insp-0001':{equipmentIds:['eq2']},'move-0001':{plannedStart:at(3,11),plannedEnd:at(3,13)},'limp-0001':{plannedStart:at(3,13),plannedEnd:at(3,14)}});
 const v=await validateDraft(planner,id) as Row;
 assert.deepEqual(v.errors,[]);
 assert.ok(v.changes.some((c:string)=>/Inspeção.*incluído.*EMP-02/.test(c)),v.changes.join(' | '));
 assert.ok(v.changes.some((c:string)=>/Inspeção.*retirado.*EMP-01/.test(c)));
 assert.ok(v.changes.some((c:string)=>/Movimentação/.test(c)));
 await rejects(revise('launch',{id,version:(await draftOf(id)).version,launchKey:key(),reason:''}),400,/Motivo da revisão/);
 const r=await launchRevision(id);
 assert.equal(r.number,before.number);assert.equal(r.revision,1);
 const after=await order(wo);
 assert.equal(after.current_plan_id,id);assert.equal(after.revision,1);assert.equal(after.original_plan_id,before.original_plan_id);
 assert.equal((await db.first('SELECT status FROM plans WHERE id=?',before.current_plan_id))!.status,'superseded');
 const res=await db.all("SELECT plan_id,equipment_id,status FROM reservations WHERE plan_id IN (?,?) ORDER BY plan_id=?",before.current_plan_id,id,id);
 assert.deepEqual(res.filter(x=>x.plan_id===before.current_plan_id).map(x=>x.status),['liberada']);
 assert.deepEqual(res.filter(x=>x.plan_id===id&&x.status!=='liberada').map(x=>[x.equipment_id,x.status]),[['eq2','confirmada']]);
 const stepsAfter=await db.all('SELECT id,step_key,plan_step_id FROM os_steps WHERE work_order_id=? ORDER BY step_key',wo);
 assert.deepEqual(stepsAfter.map(s=>s.id),stepsBefore.map(s=>s.id),'identidade das etapas preservada');
 assert.ok(stepsAfter.every(s=>!stepsBefore.some(b=>b.plan_step_id===s.plan_step_id)),'etapas apontam para a nova versão');
 // Checklist do equipamento retirado deixa de valer; o do novo equipamento passa a ser previsto.
 const reqs=await db.all('SELECT equipment_id,waived_at FROM checklist_requirements WHERE work_order_id=? ORDER BY equipment_id',wo);
 assert.deepEqual(reqs.map(x=>[x.equipment_id,!!x.waived_at]),[['eq1',true],['eq2',false]]);
 const d=await orderDetail(viewer,wo);
 assert.equal(d.plan!.id,id);
 assert.deepEqual(d.plan!.steps.find((s:Row)=>s.step_key==='insp-0001')!.equipment_ids,['eq2']);
 // Histórico e auditoria.
 const hist=(await planDetail(viewer,id)).revisions;
 assert.deepEqual(hist.map((h:Row)=>[h.revision,h.status]),[[1,'launched'],[0,'superseded']]);
 assert.equal(hist[0].revision_reason,'Cliente pediu outro horário');
 const audit=await db.first("SELECT detail FROM audits WHERE action='Planejamento: OS revisada' AND entity_id=?",wo);
 assert.match(JSON.stringify(audit!.detail),/EMP-02/);
 // O Gantt lê a nova versão.
 const g=await ordersSteps(viewer,new URL('http://x/?ids='+wo));
 assert.equal(g.steps.find((s:Row)=>s.step_key==='move-0001')!.planned_start,at(3,11));
 // Lançar de novo com outra chave: recusado; com a mesma: idempotente.
 await rejects(revise('launch',{id,version:0,launchKey:key(),reason:'x'}),409,/já foi lançada/);
});

test('revisão não disputa com a própria OS, mas segue exclusiva para as demais',async()=>{
 const wo=await launch(5);
 const other=await launch(5,'eq2');
 const {id}=await revise('start',{workOrderId:wo});
 let draft=await draftOf(id);
 // Encurta a reserva da Inspeção dentro do intervalo vigente: aceita (é a mesma reserva).
 await save(draft,{'insp-0001':{plannedStart:at(5,8,30),plannedEnd:at(5,9,30)}});
 // Tentar pegar o equipamento da outra OS no mesmo horário: recusado.
 draft=await draftOf(id);
 await rejects(save(draft,{'insp-0001':{equipmentIds:['eq1','eq2']}}),409,/EMP-02 indisponível/);
 // Um novo planejamento não reserva o EMP-01 enquanto a OS o mantém.
 const {id:p2}=await planningMutate('planning/create',{activityTypeId:flow},planner2) as {id:string};
 const np=await draftOf(p2,planner2);
 await rejects(save(np,{'insp-0001':{plannedStart:at(5,9),plannedEnd:at(5,9,45),equipmentIds:['eq1']}},{},planner2),409,/indisponível/);
 await launchRevision(id);
 void other;
});

test('etapas iniciadas e concluídas: o que pode e o que não pode mudar; retirada vira dispensa',async()=>{
 const wo=await launch(7);
 const st=async(k:string)=>(await orderDetail(operator,wo)).steps.find((s:Row)=>s.step_key===k)!;
 await ops('start',{stepId:(await st('prep-0001')).id});
 await ops('finish',{stepId:(await st('prep-0001')).id});
 await ops('start',{stepId:(await st('insp-0001')).id});
 assert.equal((await order(wo)).status,'em_andamento');
 const {id}=await revise('start',{workOrderId:wo});
 let draft=await draftOf(id);
 const detail=await planDetail(planner,id);
 assert.deepEqual(Object.fromEntries(detail.osSteps!.map((o:Row)=>[o.step_key,o.status])),{'prep-0001':'concluida','insp-0001':'em_execucao','move-0001':'nao_iniciada','limp-0001':'nao_iniciada'});
 // Etapa iniciada: não sai da OS e mantém o início previsto.
 await rejects(save(draft,{'insp-0001':{plannedStart:at(7,8,15)}}),400,/mantém o início previsto/);
 // Etapa concluída: mudanças vindas da tela são ignoradas.
 await save(draft,{'prep-0001':{plannedEnd:at(7,11)},'insp-0001':{plannedEnd:at(7,11)},'move-0001':{plannedStart:at(7,11),plannedEnd:at(7,13)},'limp-0001':{included:false}});
 draft=await draftOf(id);
 assert.equal(draft.steps.find((s:Row)=>s.step_key==='prep-0001')!.planned_end,at(7,10));
 assert.equal(draft.steps.find((s:Row)=>s.step_key==='insp-0001')!.planned_end,at(7,11));
 const r=await launchRevision(id,'Inspeção mais longa');
 assert.equal(r.revision,1);
 const d=await orderDetail(operator,wo);
 const by=(k:string)=>d.steps.find((s:Row)=>s.step_key===k)!;
 assert.equal(by('insp-0001').status,'em_execucao','execução continua sem interrupção');
 assert.equal(by('limp-0001').status,'dispensada');
 assert.match(by('limp-0001').dispensed_reason,/Retirada na revisão 1: Inspeção mais longa/);
 assert.ok(d.events.some((e:Row)=>e.kind==='dispensa'&&e.os_step_id===by('limp-0001').id));
 // O equipamento em uso segue ocupado pela nova versão (uso real).
 const busy=await db.first("SELECT r.status,o.status step FROM reservations r JOIN os_steps o ON o.plan_step_id=r.plan_step_id WHERE r.plan_id=? AND r.equipment_id='eq1'",id);
 assert.deepEqual(busy,{status:'confirmada',step:'em_execucao'});
 // Termina as etapas restantes: a OS encerra normalmente com a versão revisada.
 await ops('finish',{stepId:by('insp-0001').id});
 await ops('start',{stepId:by('move-0001').id});
 await ops('finish',{stepId:by('move-0001').id});
 assert.equal((await order(wo)).status,'concluida');
 await rejects(revise('start',{workOrderId:wo}),409,/programadas ou em andamento/);
});

test('corrida: etapa iniciada depois de a revisão mudar o início é recusada no lançamento',async()=>{
 const wo=await launch(9);
 const {id}=await revise('start',{workOrderId:wo});
 const draft=await draftOf(id);
 await save(draft,{'prep-0001':{plannedStart:at(9,8,30)}});
 const prep=(await orderDetail(operator,wo)).steps.find((s:Row)=>s.step_key==='prep-0001')!;
 await ops('start',{stepId:prep.id});
 await rejects(launchRevision(id),409,/início previsto dela não pode mudar/);
 assert.equal((await order(wo)).revision,0);
 // Volta o início e lança.
 await save(await draftOf(id),{'prep-0001':{plannedStart:at(9,8)}},{description:'Revisado após o início'});
 await launchRevision(id);
 assert.equal((await order(wo)).revision,1);
});

test('equipamento bloqueado mantido na revisão é aviso; incluí-lo de novo é pendência',async()=>{
 const wo=await launch(11);
 await conditionMutate('condition/open',{equipmentId:'eq1',reason:'Vazamento'},manager);
 const {id}=await revise('start',{workOrderId:wo});
 await save(await draftOf(id),{'move-0001':{plannedEnd:at(11,12,30)},'limp-0001':{plannedStart:at(11,12,30),plannedEnd:at(11,13,30)}});
 const v=await validateDraft(planner,id) as Row;
 assert.deepEqual(v.errors,[]);
 assert.ok(v.warnings.some((w:Row)=>/EMP-01 continua bloqueado/.test(w.message)));
 // Estender a reserva bloqueada além do intervalo vigente é reserva nova: recusada.
 await rejects(save(await draftOf(id),{'insp-0001':{plannedEnd:at(11,10,30)}}),409,/bloqueado/);
 await launchRevision(id);
 assert.equal((await order(wo)).revision,1);
 const imp=await db.first("SELECT id FROM equipment_impediments WHERE equipment_id='eq1' AND released_at IS NULL");
 await conditionMutate('condition/release',{id:imp!.id,reason:'Vedação trocada',evidence:'OM 12'},manager);
});

test('descartar revisão, acesso e rotas que não aceitam revisão',async()=>{
 const wo=await launch(13);
 const before=await order(wo);
 await rejects(revise('start',{workOrderId:wo},viewer),403);
 await rejects(revise('start',{workOrderId:wo},operator),403);
 const {id}=await revise('start',{workOrderId:wo});
 const draft=await draftOf(id);
 await rejects(planningMutate('planning/launch',{id,version:draft.version,launchKey:key()},planner),409,/Lançar revisão/);
 await rejects(planningMutate('planning/change-type',{id,version:draft.version,activityTypeId:flow},planner),409);
 await rejects(save(draft,{},{orgId:null}),400,/organização/);
 // Outro planejador não vê, não altera nem lança a revisão alheia; o gestor pode.
 await rejects(save(draft,{},{},planner2),404);
 await rejects(revise('launch',{id,version:draft.version,launchKey:key(),reason:'x'},planner2),403);
 await planningMutate('planning/discard',{id,version:draft.version},manager);
 assert.equal((await db.first("SELECT count(*)::int n FROM reservations WHERE plan_id=? AND status<>'liberada'",id))!.n,0);
 const now=await order(wo);
 assert.equal(now.current_plan_id,before.current_plan_id);assert.equal(now.revision,0);
 assert.equal((await db.first("SELECT count(*)::int n FROM reservations WHERE plan_id=? AND status='confirmada'",before.current_plan_id))!.n,1);
 // Depois do descarte, uma nova revisão pode ser aberta (por outra pessoa).
 const again=await revise('start',{workOrderId:wo},planner2);
 assert.notEqual(again.id,id);
 // OS cancelada não é revisada.
 await planningMutate('planning/discard',{id:again.id,version:(await draftOf(again.id,planner2)).version},planner2);
 await cancelOrder({id:before.current_plan_id,version:now.version,reason:'Cliente desistiu'},planner);
 await rejects(revise('start',{workOrderId:wo}),409);
 // Banco: etapa da OS só aponta para o planejamento da própria OS.
 const otherPlan=await db.first("SELECT id FROM plan_steps WHERE plan_id<>? LIMIT 1",before.current_plan_id);
 await assert.rejects(db.run('UPDATE os_steps SET plan_step_id=? WHERE work_order_id=?',otherPlan!.id,wo),/fora do planejamento/);
});
