import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate,state} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {cancelOrder} from '../lib/cancel';
import {planningMutate,planningState,planDetail,validateDraft,ordersList,availability} from '../lib/planning';
import {conditionMutate,conditionState} from '../lib/condition';
import {modules,type Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,planner2:Member,client:Member,tech:Member;
let orgA:string,orgB:string,loc:string,typeEmp:string,fnOp:string,flow:string,opIds:string[]=[];
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const pgRejects=(p:Promise<unknown>,pattern:RegExp)=>assert.rejects(p,(e:{message:string})=>{assert.match(e.message,pattern);return true;});
const key=()=>crypto.randomUUID();
const at=(day:number,h:number,m=0)=>new Date(Date.UTC(2031,0,day,h+3,m)).toISOString(); // horário de Brasília em janeiro de 2031
const set=async(who:Member,caps:string[],profile='fueler',orgScope:string[]=[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,orgScope},manager);return {...who,profile,capabilities:caps.includes('manutencao')?[...new Set([...caps,'cadastros'])]:caps} as Member;};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 planner2=await set(await addMember(db,'fueler'),['planejamento']);
 tech=await set(await addMember(db,'fueler'),['manutencao'],'fueler');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 orgA=(await reg('orgs',{name:'Operação interna',acronym:'OPS',category:'interna',color:'#103B52'})).id;
 orgB=(await reg('orgs',{name:'Cliente B',acronym:'CLB',category:'cliente',color:'#F2C94C'})).id;
 client=await set(await addMember(db,'fueler'),['acompanhamento'],'fueler',[orgB]);
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 typeEmp=(await reg('equipment-types',{name:'Empilhadeira'})).id;
 await db.run('UPDATE equipment SET type_id=? WHERE id IN (\'eq1\',\'eq2\')',typeEmp);
 await reg('equipment',{tag:'EMP-03',description:'Terceira',typeId:typeEmp,fuelIds:['diesel']});
 fnOp=(await reg('functions',{name:'Operador'})).id;
 opIds=[(await reg('operators',{name:'Ana',functionIds:[fnOp]})).id,(await reg('operators',{name:'Bruno',functionIds:[fnOp]})).id];
 flow=(await flowsMutate('flows/save',{code:'MOV',name:'Movimentação',steps:[
  {key:'prep-0001',name:'Preparação'},
  {key:'insp-0001',name:'Inspeção',needs:[{equipmentTypeId:typeEmp,quantity:1}]},
  {key:'move-0001',name:'Movimentação',dependsOn:['prep-0001','insp-0001'],needs:[{functionId:fnOp,quantity:1}]},
  {key:'conf-0001',name:'Conferência',required:false,dependsOn:['move-0001']},
 ]},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

async function draft(who:Member=planner){const {id}=await planningMutate('planning/create',{activityTypeId:flow},who) as {id:string};return id;}
async function plan(id:string,who:Member=planner){return (await planDetail(who,id)).plan;}
/** Monta o corpo de gravação a partir do rascunho atual, com alterações. */
async function save(id:string,patch:Row={},steps:Record<string,Row>={},who:Member=planner){
 const p=await plan(id,who);
 return planningMutate('planning/save',{id,version:p.version,description:p.description,orgId:p.org_id,requesterPersonId:p.requester_person_id,locationId:p.location_id,plannedStart:p.planned_start,plannedEnd:p.planned_end,...patch,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:!!s.included,plannedStart:s.planned_start,plannedEnd:s.planned_end,locationId:s.location_id,needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,quantity:n.quantity})),equipmentIds:s.equipment_ids,operatorIds:s.operator_ids,...(steps[s.step_key]||{})}))},who) as Promise<{version:number}>;
}
const complete=(day:number,eq='eq1')=>({patch:{orgId:orgA,locationId:loc,plannedStart:at(day,7),plannedEnd:at(day,18)},steps:{
 'prep-0001':{plannedStart:at(day,8),plannedEnd:at(day,10)},
 'insp-0001':{plannedStart:at(day,8),plannedEnd:at(day,10),equipmentIds:[eq]},
 'move-0001':{plannedStart:at(day,10),plannedEnd:at(day,12),operatorIds:[opIds[0]]},
 'conf-0001':{included:false},
}});

test('acessos: módulos do planejamento, da operação e do cliente',()=>{
 // Só o módulo principal do perfil e os módulos dos acessos adicionais.
 assert.ok(modules(planner).includes('plan-atividade')&&!modules(planner).includes('plan-rascunhos'));
 assert.equal(modules(planner).includes('op-os'),(planner.capabilities||[]).includes('operacao')||planner.profile==='manager');
 assert.deepEqual(modules(client),['painel','solicitacoes','abastecimentos','op-painel','op-os','exportacao']);
 assert.ok(!modules(tech).includes('plan-atividade'));
});

test('rascunho carrega o fluxo, salva incompleto e só reserva com intervalo completo',async()=>{
 const id=await draft();
 const p=await plan(id);
 assert.equal(p.steps.length,4);assert.deepEqual([...p.steps[2].depends_on].sort(),['insp-0001','prep-0001']);
 await save(id,{description:'Só a descrição'});
 assert.equal((await plan(id)).description,'Só a descrição');
 await rejects(save(id,{},{'insp-0001':{equipmentIds:['eq1']}}),400,/informe início e fim antes de alocar/);
 await save(id,{},{'prep-0001':{included:false}});
 assert.equal((await plan(id)).steps[0].included,1,'etapa obrigatória continua incluída');
 const v=await validateDraft(planner,id);
 assert.ok(v.errors.some(e=>/organização/.test(e.message)));
 // Versão antiga é recusada.
 await rejects(planningMutate('planning/save',{id,version:0,steps:[]},planner),409,/alterado em outra tela/);
 await rejects(planDetail(planner2,id),404);
});

test('intertravamento: rascunho não segura equipamento; OS lançada bloqueia; horário adjacente aceito; mesma OS também conflita',async()=>{
 const a=await draft(),b=await draft(planner2);
 await save(a,{},{'insp-0001':{plannedStart:at(14,8),plannedEnd:at(14,10),equipmentIds:['eq1']}});
 // Outro rascunho no mesmo horário: aceito (rascunho não segura o equipamento).
 await save(b,{},{'insp-0001':{plannedStart:at(14,9),plannedEnd:at(14,11),equipmentIds:['eq1']}},planner2);
 const av=await availability(planner2,new URL(`http://x/?start=${encodeURIComponent(at(14,9))}&end=${encodeURIComponent(at(14,11))}`));
 assert.equal(av.equipment.find(e=>e.id==='eq1')!.status,'livre');
 // Etapa paralela do mesmo rascunho com o mesmo equipamento: conflita.
 await rejects(save(a,{},{'prep-0001':{plannedStart:at(14,9),plannedEnd:at(14,11),equipmentIds:['eq1']}}),409,/neste rascunho/);
 // Lançada a primeira, ela bloqueia: o outro rascunho fica com pendência e não lança.
 await save(a,complete(14).patch,{...complete(14).steps,'insp-0001':{plannedStart:at(14,8),plannedEnd:at(14,10),equipmentIds:['eq1']}});
 await planningMutate('planning/launch',{id:a,version:(await plan(a)).version,launchKey:key()},planner);
 const v=await validateDraft(planner2,b) as Row;
 assert.ok((v.errors as Row[]).some(e=>/EMP-01 indisponível em 14\/01\/2031 das 09h00 às 11h00: reservado para a etapa/.test(e.message)),JSON.stringify(v.errors));
 await rejects(save(b,{},{'insp-0001':{plannedStart:at(14,9),plannedEnd:at(14,12),equipmentIds:['eq1']}},planner2),409,/reservado para a etapa/);
 // Horário adjacente ao da OS lançada: aceito.
 await save(b,{},{'insp-0001':{plannedStart:at(14,10),plannedEnd:at(14,12),equipmentIds:['eq1']}},planner2);
 // O banco recusa sobreposição com OS lançada mesmo sem passar pelo serviço.
 const pb=await plan(b,planner2);
 await pgRejects(db.run("INSERT INTO reservations(id,plan_id,plan_step_id,equipment_id,start_at,end_at,status,created_at) VALUES('x',?,?,'eq1',?,?,'provisoria',?)",b,pb.steps[1].id,at(14,9),at(14,9,30),new Date().toISOString()),/reservado no período/);
});

test('corrida: dois rascunhos com o mesmo equipamento e horário; só um lança',async()=>{
 const a=await draft(),b=await draft(planner2);
 await save(a,complete(16,'eq2').patch,complete(16,'eq2').steps);
 await save(b,complete(16,'eq2').patch,complete(16,'eq2').steps,planner2);
 const r=await Promise.allSettled([planningMutate('planning/launch',{id:a,version:(await plan(a)).version,launchKey:key()},planner),planningMutate('planning/launch',{id:b,version:(await plan(b,planner2)).version,launchKey:key()},planner2)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(r.map(x=>x.status==='rejected'?String(x.reason):'ok')));
 assert.equal((await db.all("SELECT * FROM reservations WHERE equipment_id='eq2' AND status='confirmada' AND start_at LIKE '2031-01-16%'")).length,1);
});

test('lançamento: pendências impedem; lançamento idempotente congela o planejamento e confirma reservas',async()=>{
 const id=await draft();
 await rejects(planningMutate('planning/launch',{id,version:(await plan(id)).version,launchKey:'k1'},planner),409,/pendência/);
 const c=complete(20);
 await save(id,c.patch,{...c.steps,'move-0001':{plannedStart:at(20,9),plannedEnd:at(20,12),operatorIds:[opIds[0]]}});
 const v=await validateDraft(planner,id);
 assert.ok(v.errors.some(e=>/começa antes do fim de “Preparação”/.test(e.message)));
 assert.ok(v.warnings.some(w=>/Conferência.*não foi incluída/.test(w.message))===false,'aviso só para quem depende da opcional');
 await save(id,{},{'move-0001':{plannedStart:at(20,10),plannedEnd:at(20,12),operatorIds:[]}});
 // Falta de colaborador na função: aviso, não pendência (só equipamento bloqueia).
 {const w=await validateDraft(planner,id);assert.ok(w.warnings.some(e=>/faltam 1 de 1 colaborador/.test(e.message)));assert.ok(!w.errors.some(e=>/colaborador/.test(e.message)));}
 await save(id,{},{'move-0001':{operatorIds:[opIds[0]]}});
 assert.deepEqual((await validateDraft(planner,id)).errors,[]);
 const version=(await plan(id)).version;
 await rejects(planningMutate('planning/launch',{id,version,launchKey:'k2'},planner2),404);
 const [r1,r2]=await Promise.all([planningMutate('planning/launch',{id,version,launchKey:'k3'},planner),planningMutate('planning/launch',{id,version,launchKey:'k3'},planner)]) as {number:number,workOrderId:string}[];
 assert.equal(r1.number,r2.number);
 assert.equal((await db.all('SELECT * FROM work_orders WHERE current_plan_id=?',id)).length,1);
 assert.equal((await db.all("SELECT * FROM reservations WHERE plan_id=? AND status='confirmada'",id)).length,1);
 assert.equal((await db.all('SELECT * FROM os_steps WHERE work_order_id=?',r1.workOrderId)).length,3,'opcional não incluída não vira etapa da OS');
 await pgRejects(db.run("UPDATE plan_steps SET name='x' WHERE plan_id=?",id),/não pode ser alterado/);
 await rejects(save(id),409,/lançado não pode ser alterado/);
 const list=await ordersList(planner,new URL('http://x/?from='+encodeURIComponent(at(20,11))+'&to='+encodeURIComponent(at(20,12))));
 assert.ok(list.orders.some(o=>o.id===r1.workOrderId),'filtro por sobreposição inclui OS que atravessa o período');
 assert.equal(list.counts[orgA],list.orders.filter(o=>o.org_id===orgA).length);
 // Cancelamento libera as reservas confirmadas.
 const w=await db.first('SELECT version FROM work_orders WHERE id=?',r1.workOrderId);
 await cancelOrder({id,version:w!.version,reason:'Cliente adiou'},planner);
 assert.equal((await db.all("SELECT * FROM reservations WHERE plan_id=? AND status<>'liberada'",id)).length,0);
 assert.ok(!(await ordersList(planner,new URL('http://x/'))).orders.some(o=>o.id===r1.workOrderId),'cancelada fica fora da lista padrão');
});

test('condição técnica: bloqueio impede reserva; liberação só com acesso técnico; duas NC exigem duas liberações',async()=>{
 const opened=await conditionMutate('condition/open',{equipmentId:'eq3',reason:'Vazamento hidráulico'},planner).catch(e=>e);
 assert.equal((opened as {status:number}).status,403,'planejador sem Cadastros/Manutenção não bloqueia');
 const eq3=(await db.first("SELECT id FROM equipment WHERE tag='EMP-03'"))!.id;
 const i1=await conditionMutate('condition/open',{equipmentId:eq3,reason:'Vazamento hidráulico'},manager) as {id:string};
 const i2=await conditionMutate('condition/open',{equipmentId:eq3,reason:'Freio'},tech) as {id:string};
 const id=await draft();
 await rejects(save(id,{},{'insp-0001':{plannedStart:at(22,8),plannedEnd:at(22,10),equipmentIds:[eq3]}}),409,/bloqueado por impedimento técnico: Vazamento/);
 await rejects(conditionMutate('condition/release',{id:i1.id,reason:'ok',evidence:'teste'},planner),403);
 await pgRejects(db.run("UPDATE equipment_impediments SET released_at=now()::text,released_by=?,release_reason='x' WHERE id=?",planner.id,i1.id),/sem autorização/);
 await pgRejects(db.run('DELETE FROM equipment_impediments WHERE id=?',i1.id),/não pode ser apagado/);
 await rejects(conditionMutate('condition/release',{id:i1.id,reason:'Trocada a mangueira'},tech),400,/evidência/);
 const r=await conditionMutate('condition/release',{id:i1.id,reason:'Trocada a mangueira',evidence:'OM 123'},tech) as {message:string};
 assert.match(r.message,/ainda tem 1 impedimento/);
 await rejects(save(id,{},{'insp-0001':{plannedStart:at(22,8),plannedEnd:at(22,10),equipmentIds:[eq3]}}),409,/Freio/);
 await conditionMutate('condition/release',{id:i2.id,reason:'Freio regulado',evidence:'Teste de frenagem'},manager);
 await save(id,{},{'insp-0001':{plannedStart:at(22,8),plannedEnd:at(22,10),equipmentIds:[eq3]}});
 // Bloqueio depois da reserva: o compromisso aparece como afetado e o lançamento fica impedido.
 await conditionMutate('condition/open',{equipmentId:eq3,reason:'Pneu'},manager);
 assert.ok((await conditionState(manager)).affected.some(x=>/etapa “Inspeção”/.test(x.label)));
 const c=complete(22,eq3);await save(id,c.patch,c.steps);
 assert.ok((await validateDraft(planner,id)).errors.some(e=>/bloqueado por impedimento técnico \(Pneu\)/.test(e.message)));
});

test('rascunho esquecido: gestor libera reservas; descartar libera as provisórias',async()=>{
 const id=await draft(planner2);
 await save(id,{},{'insp-0001':{plannedStart:at(25,8),plannedEnd:at(25,10),equipmentIds:['eq1']}},planner2);
 await rejects(planningMutate('planning/release',{id,reason:'x'},planner),404);
 await planningMutate('planning/release',{id,reason:'Rascunho parado há 30 dias'},manager);
 assert.deepEqual((await plan(id,planner2)).steps[1].equipment_ids,[]);
 const id2=await draft();
 await save(id2,{},{'insp-0001':{plannedStart:at(26,8),plannedEnd:at(26,10),equipmentIds:['eq1']}});
 await planningMutate('planning/discard',{id:id2,version:(await plan(id2)).version},planner);
 assert.equal((await db.all("SELECT * FROM reservations WHERE plan_id=? AND status<>'liberada'",id2)).length,0);
 assert.ok(!(await planningState(planner)).drafts.some(d=>d.id===id2));
});

test('escopo: cliente vê só as OS da sua organização, sem abastecimento',async()=>{
 const mk=async(org:string,day:number,eq:string)=>{const id=await draft();const c=complete(day,eq);await save(id,{...c.patch,orgId:org},c.steps);return planningMutate('planning/launch',{id,version:(await plan(id)).version,launchKey:crypto.randomUUID()},planner) as Promise<{workOrderId:string,number:number}>;};
 const a=await mk(orgA,27,'eq1'),b=await mk(orgB,28,'eq1');
 const seen=await ordersList(client,new URL('http://x/'));
 assert.ok(seen.scoped);assert.ok(seen.orders.every(o=>o.org_id===orgB));assert.ok(seen.orders.some(o=>o.id===b.workOrderId));
 const pa=await db.first('SELECT current_plan_id FROM work_orders WHERE id=?',a.workOrderId);
 await rejects(planDetail(client,pa!.current_plan_id),404);
 await rejects(planningMutate('planning/create',{activityTypeId:flow},client),403);
 assert.deepEqual((await state(client)).appointments,[]);
 // O escopo é editável pelo gestor: sem escopo, vê todas.
 const all=await set(client,['acompanhamento'],'fueler',[]);
 assert.ok((await ordersList(all,new URL('http://x/'))).orders.some(o=>o.id===a.workOrderId));
 await set(client,['acompanhamento'],'fueler',[orgB]);
});
