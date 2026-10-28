import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {planningMutate,planDetail,ordersList,availability,validateDraft} from '../lib/planning';
import {revisionMutate} from '../lib/revision';
import {realizeActivity} from '../lib/realized';
import {cancelOrder} from '../lib/cancel';
import {orderDetail,operationMutate} from '../lib/operation';
import {opsBoard,opsDashboard} from '../lib/board';
import {orderWorkbook} from '../lib/reports';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member;
let org:string,loc:string,flow:string,cat:string,type:string;
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const key=()=>crypto.randomUUID();
const H=3600000;
const at=(h:number)=>new Date(Date.now()+h*H).toISOString();
const set=async(who:Member,caps:string[],profile='fueler')=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who:Member=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
const ops=(path:string,b:Row,who:Member=operator)=>operationMutate('ops/'+path,{operationKey:key(),...b},who) as Promise<Row>;
const q=(text:string)=>({text,required:true,critical:false,target:'atividade',allowNa:true,noteOn:['NC']});

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 org=(await reg('orgs',{name:'Operação',acronym:'OPS',category:'interna',color:'#103B52'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base'})).id;
 type=(await reg('equipment-types',{name:'Empilhadeira'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
 cat=(await reg('categories',{kind:'bloqueio',name:'Chuva'})).id;
 flow=(await flowsMutate('flows/save',{code:'MOV',name:'Movimentação',steps:[{key:'prep-0001',name:'Preparação'},{key:'move-0001',name:'Movimentação',dependsOn:['prep-0001']}]},manager) as Row).id;
});
after(async()=>{await ctx.drop();});

/** OS com fluxo de duas etapas, equipamento na segunda; código do setor opcional. */
async function launch(s:number,e:number,eq='eq1',code='',people:string[]=[]){
 // Um instante só por chamada: sem diferença de milissegundos entre a janela da OS e a das etapas.
 const T=Date.now(),at=(h:number)=>new Date(T+h*H).toISOString();
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as Row;
 const p=(await planDetail(planner,id)).plan;
 const mid=(s+e)/2;
 await planningMutate('planning/save',{id,version:p.version,code,orgId:org,locationId:loc,plannedStart:at(s),plannedEnd:at(e),steps:p.steps.map((x:Row)=>({key:x.step_key,included:true,plannedStart:x.step_key==='prep-0001'?at(s):at(mid),plannedEnd:x.step_key==='prep-0001'?at(mid):at(e),needs:[],equipmentIds:x.step_key==='move-0001'?[eq]:[],operatorIds:x.step_key==='move-0001'?people:[]}))},planner);
 const v=(await planDetail(planner,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as Row;
 return {plan:id,wo:r.workOrderId as string};
}
const step=async(wo:string,k:string)=>(await orderDetail(operator,wo)).steps.find((s:Row)=>s.step_key===k)!;

test('setores: cadastro com código fixo, código da OS vem do cadastro (com ou sem fluxo) e filtro exato',async()=>{
 const s=await reg('sectors',{code:' log.01 ',name:'Logística'});
 assert.equal(s.code,'LOG.01');
 await rejects(reg('sectors',{code:'LOG.01',name:'Outro'}),409,/já está cadastrado/);
 const row=await db.first('SELECT * FROM sectors WHERE id=?',s.id);
 await reg('sectors',{id:s.id,updatedAt:row!.updated_at,code:'OUTRO',name:'Logística portuária'});
 assert.deepEqual(await db.first('SELECT code,name FROM sectors WHERE id=?',s.id),{code:'LOG.01',name:'Logística portuária'},'o código não muda na edição');
 await assert.rejects(db.run("UPDATE sectors SET code='X' WHERE id=?",s.id),/não pode ser alterado/);
 // Código fora do cadastro é recusado; o cadastro na hora pelo planejamento entra em Setores.
 await rejects(launch(30,34,'eq1','NAO-EXISTE'),400,/não está cadastrado/);
 const quick=await planningMutate('planning/resource',{kind:'sector',code:'man-02',name:'Manutenção'},planner) as Row;
 assert.equal(quick.code,'MAN-02');
 assert.equal((await planningMutate('planning/resource',{kind:'sector',code:'MAN-02'},operator) as Row).existing,true);
 const a=await launch(30,34,'eq1','LOG.01');
 assert.equal((await db.first('SELECT code FROM work_orders WHERE id=?',a.wo))!.code,'LOG.01','OS com fluxo também leva o código do setor');
 const list=await ordersList(planner,new URL('http://x/?sector=LOG.01'));
 assert.deepEqual(list.orders.map((o:Row)=>o.id),[a.wo]);
 // Setor inativo não pode ser escolhido de novo.
 const r2=await db.first('SELECT * FROM sectors WHERE id=?',s.id);
 await reg('sectors',{id:s.id,updatedAt:r2!.updated_at,name:'Logística portuária',active:false});
 await rejects(launch(40,44,'eq1','LOG.01'),400,/inativo/);
});

test('cancelamento: só planejador ou gestor, com justificativa; em andamento encerra etapas e libera o equipamento',async()=>{
 const {wo}=await launch(-1,3,'eq2');
 const prep=await step(wo,'prep-0001');
 await ops('start',{stepId:prep.id});
 await rejects(cancelOrder({workOrderId:wo,reason:'x'},operator),403);
 await rejects(cancelOrder({workOrderId:wo,reason:''},planner),400,/Justificativa/);
 const w=await db.first('SELECT version FROM work_orders WHERE id=?',wo);
 const r=await cancelOrder({workOrderId:wo,version:w!.version,reason:'Navio desatracou antes'},planner) as Row;
 assert.match(r.message,/etapas abertas foram encerradas/);
 const d=await orderDetail(operator,wo);
 assert.equal(d.order.status,'cancelada');
 assert.deepEqual(d.steps.map((s:Row)=>s.status).sort(),['cancelada','cancelada']);
 assert.ok(d.intervals.every((i:Row)=>i.end_at),'nenhum período aberto');
 assert.ok(d.events.some((e:Row)=>e.kind==='cancelamento'));
 assert.equal((await db.first("SELECT count(*)::int n FROM reservations r JOIN plans p ON p.id=r.plan_id WHERE p.work_order_id=? AND r.status<>'liberada'",wo))!.n,0,'nenhuma reserva da OS cancelada fica ativa');
 await rejects(ops('start',{stepId:(await step(wo,'move-0001')).id}),409,/cancelada/);
 // Outra OS consegue o mesmo equipamento no mesmo horário.
 await launch(1,3,'eq2');
});

test('OS cancelada libera equipamento e equipe: outra OS no mesmo horário não tem conflito',async()=>{
 const a=await launch(110,114,'eq1','',['op1']);
 // Mesmo horário, mesmo equipamento e a mesma pessoa: com a primeira OS ativa, há disputa.
 await rejects(launch(110,114,'eq1','',['op1']),409,/reservado/);
 const busy=await availability(planner,new URL(`http://x/?start=${at(110)}&end=${at(114)}`));
 assert.equal(busy.operators.find((o:Row)=>o.id==='op1')?.status,'ocupado');
 await cancelOrder({workOrderId:a.wo,reason:'Mudança de prioridade'},planner);
 const free=await availability(planner,new URL(`http://x/?start=${at(110)}&end=${at(114)}`));
 assert.equal(free.equipment.find((e:Row)=>e.id==='eq1')?.status,'livre','equipamento da OS cancelada fica livre');
 assert.equal(free.operators.find((o:Row)=>o.id==='op1')?.status,'livre','colaborador da OS cancelada fica livre');
 const b=await launch(110,114,'eq1','',['op1']);
 const v=await validateDraft(planner,b.plan);
 assert.ok(!v.warnings.some((w:Row)=>w.kind==='paralelismo'),'colaborador da OS cancelada não conta como ocupado');
});

test('cancelar OS com revisão em aberto libera as reservas da revisão',async()=>{
 const {wo}=await launch(50,54,'eq1');
 const rev=await revisionMutate('planning/revision/start',{workOrderId:wo},planner) as Row;
 assert.ok(await db.first("SELECT 1 FROM reservations WHERE plan_id=? AND status='provisoria'",rev.id));
 await cancelOrder({workOrderId:wo,reason:'Cliente desistiu'},manager);
 assert.equal((await db.first('SELECT status FROM plans WHERE id=?',rev.id))!.status,'discarded');
 await launch(50,54,'eq1');
});

test('término antes do horário reservado libera a reserva; dispensa retira checklist do equipamento não usado',async()=>{
 const ck=await reg('checklists',{code:'CK-EQ',title:'Pré-uso',moment:'pre_uso',mandatory:true,links:{equipmentTypeIds:[type]},questions:[{...q('Freios?'),target:'equipamento',allowNa:false}]});void ck;
 // Dispensa: a etapa com o equipamento é dispensada; a OS encerra sem exigir o pré-uso.
 const a=await launch(60,64,'eq1');
 const prepA=await step(a.wo,'prep-0001');
 await ops('start',{stepId:prepA.id});
 await operationMutate('ops/dispense',{stepId:(await step(a.wo,'move-0001')).id,reason:'Carga não chegou'},planner);
 await ops('finish',{stepId:prepA.id});
 assert.equal((await db.first('SELECT status FROM work_orders WHERE id=?',a.wo))!.status,'concluida');
 // Término antecipado: etapa do equipamento feita agora, reserva era para daqui a 70 h.
 const b=await launch(68,72,'eq2');
 const d=await orderDetail(operator,b.wo);
 const req=d.requirements.find((r:Row)=>r.equipment_id==='eq2')!;
 const inst=await ops('checklist/start',{workOrderId:b.wo,requirementId:req.id});
 const qs=(await orderDetail(operator,b.wo)).questions.filter((x:Row)=>x.version_id===req.version_id);
 for(const x of qs)await ops('checklist/answer',{instanceId:inst.id,questionId:x.id,answer:'C'});
 await ops('checklist/complete',{instanceId:inst.id});
 for(const k of ['prep-0001','move-0001']){const s=await step(b.wo,k);await ops('start',{stepId:s.id});await ops('finish',{stepId:s.id});}
 assert.equal((await db.first("SELECT count(*)::int n FROM reservations r JOIN plans p ON p.id=r.plan_id WHERE p.work_order_id=? AND r.status<>'liberada'",b.wo))!.n,0);
 await launch(68,72,'eq2');
});

test('revisão depois de nova versão do checklist não cria outra exigência',async()=>{
 await reg('checklists',{code:'CK-ATV',title:'Liberação v1',moment:'pre_atividade',mandatory:true,links:{activityTypeIds:[flow]},questions:[q('Área isolada?')]});
 const {wo}=await launch(80,84,'eq1');
 const d=await orderDetail(operator,wo);
 const req=d.requirements.find((r:Row)=>r.code==='CK-ATV')!;
 const inst=await ops('checklist/start',{workOrderId:wo,requirementId:req.id});
 const qs=(await orderDetail(operator,wo)).questions.filter((x:Row)=>x.version_id===req.version_id);
 for(const x of qs)await ops('checklist/answer',{instanceId:inst.id,questionId:x.id,answer:'C'});
 await ops('checklist/complete',{instanceId:inst.id});
 const t=await db.first("SELECT * FROM checklist_templates WHERE code='CK-ATV'");
 await reg('checklists',{id:t!.id,expectedVersion:t!.current_version,updatedAt:t!.updated_at,code:'CK-ATV',title:'Liberação v2',moment:'pre_atividade',mandatory:true,links:{activityTypeIds:[flow]},questions:[q('Área isolada e sinalizada?')]});
 const rev=await revisionMutate('planning/revision/start',{workOrderId:wo},planner) as Row;
 const p=(await planDetail(planner,rev.id)).plan;
 await planningMutate('planning/save',{id:rev.id,version:p.version,orgId:org,locationId:loc,plannedStart:p.planned_start,plannedEnd:at(85),steps:p.steps.map((x:Row)=>({key:x.step_key,included:true,plannedStart:x.planned_start,plannedEnd:x.step_key==='move-0001'?at(85):x.planned_end,needs:[],equipmentIds:x.equipment_ids,operatorIds:[]}))},planner);
 const v=(await planDetail(planner,rev.id)).plan.version;
 await revisionMutate('planning/revision/launch',{id:rev.id,version:v,launchKey:key(),reason:'Mais tempo'},planner);
 assert.equal((await db.first("SELECT count(*)::int n FROM checklist_requirements r JOIN checklist_versions v ON v.id=r.version_id JOIN checklist_templates t ON t.id=v.template_id WHERE r.work_order_id=? AND t.code='CK-ATV'",wo))!.n,1);
 const prep=await step(wo,'prep-0001');
 await ops('start',{stepId:prep.id});
});

test('atividade realizada com apontamentos: bloqueio divide o período e desconta do tempo efetivo',async()=>{
 const {id}=await planningMutate('planning/create-free',{mode:'realizada'},operator) as Row;
 const p=(await planDetail(operator,id)).plan;
 const body=(notes:Row[])=>({id,version:p.version,title:'Socorro no cais',orgId:org,locationId:loc,plannedStart:at(-6),plannedEnd:at(-2),notes,
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:[],equipmentIds:[],operatorIds:[]}))});
 await rejects(planningMutate('planning/save',body([{kind:'bloqueio',categoryId:cat,description:'Chuva',at:at(-7),until:at(-5)}]),operator),400,/depois do início real/);
 await rejects(planningMutate('planning/save',body([{kind:'bloqueio',description:'Chuva',at:at(-5),until:at(-4)}]),operator),400,/categoria/);
 await planningMutate('planning/save',body([{kind:'ocorrencia',description:'Fiscal acompanhou',at:at(-5.5)},{kind:'bloqueio',categoryId:cat,description:'Chuva forte',at:at(-5),until:at(-4)}]),operator);
 const v=(await planDetail(operator,id)).plan.version;
 const r=await realizeActivity({id,version:v,launchKey:key()},operator) as Row;
 const d=await orderDetail(operator,r.workOrderId);
 assert.deepEqual(d.intervals.map((i:Row)=>i.kind),['ativo','interrompido','ativo']);
 assert.equal(d.occurrences.length,2);
 assert.ok(d.occurrences.every((o:Row)=>o.late===1));
 assert.equal(d.occurrences.find((o:Row)=>o.kind==='bloqueio')!.status,'resolvido');
 assert.equal(d.order.status,'concluida');
 // Aparece no Painel de OS (concluídas) com a marca de realizada.
 const board=await opsBoard(planner,new URL('http://x/?group=concluidas'));
 assert.equal(board.orders.find((o:Row)=>o.id===r.workOrderId)!.origin,'realizada');
 // Planilha com o histórico completo.
 const res=await orderWorkbook(planner,r.workOrderId);assert.equal(res.status,200);
});

test('painel de OS: filtros de período, setor e solicitante; gráfico só com os últimos 30 dias',async()=>{
 await reg('sectors',{code:'PNL-1',name:'Painel'});
 const a=await launch(200,204,'eq1','PNL-1');
 const day=(h:number)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date(Date.now()+h*H));
 const f=await opsBoard(planner,new URL(`http://x/?group=todas&sector=PNL-1&from=${day(190)}&to=${day(210)}`));
 assert.deepEqual(f.orders.map((o:Row)=>o.id),[a.wo]);
 assert.equal((await opsBoard(planner,new URL(`http://x/?group=todas&sector=PNL-1&from=${day(0)}&to=${day(24)}`))).orders.length,0);
 await rejects(opsBoard(planner,new URL('http://x/?from=2026-13-40')),400);
 const dash=await opsDashboard(planner,new URL('http://x/?sector=PNL-1'));
 assert.equal(dash.byOrg.length,0,'OS futura não entra no gráfico dos últimos 30 dias');
 assert.ok(dash.sectors.some((s:Row)=>s.code==='PNL-1'));
});

test('disponibilidade segue a regra do banco: equipamento de etapa em execução fica ocupado até o fim previsto da etapa, não indefinidamente',async()=>{
 const a=await launch(130,134,'eq2');
 const d=await orderDetail(operator,a.wo);
 for(const req of d.requirements as Row[]){
  const inst=await ops('checklist/start',{workOrderId:a.wo,requirementId:req.id});
  for(const x of (await orderDetail(operator,a.wo)).questions.filter((y:Row)=>y.version_id===req.version_id))await ops('checklist/answer',{instanceId:inst.id,questionId:x.id,answer:'C'});
  await ops('checklist/complete',{instanceId:inst.id});
 }
 const prep=await step(a.wo,'prep-0001');await ops('start',{stepId:prep.id});await ops('finish',{stepId:prep.id});
 await ops('start',{stepId:(await step(a.wo,'move-0001')).id});
 // Dentro do período previsto da etapa em andamento: ocupado, dizendo até quando.
 const during=await availability(planner,new URL(`http://x/?start=${at(132)}&end=${at(133)}`));
 const e=during.equipment.find((x:Row)=>x.id==='eq2')!;
 assert.equal(e.status,'reservado');assert.match(e.detail,/ainda não finalizada: ocupado até/);
 await rejects(launch(132,133,'eq2'),409);
 // Depois do fim previsto da etapa (134 h), outra OS reserva normalmente (antes, ficava travado para sempre).
 const later=await availability(planner,new URL(`http://x/?start=${at(140)}&end=${at(144)}`));
 assert.equal(later.equipment.find((x:Row)=>x.id==='eq2')!.status,'livre');
 const b=await launch(140,144,'eq2');assert.ok(b.wo);
});

test('perfis: módulo principal + acessos adicionais; cancelar OS só Planejador ou Gestão',async()=>{
 const {modules}=await import('../lib/permissions');
 // Abastecedor com Planejamento adicional vê o Planejamento, mas não cancela OS.
 const fueler=await set(await addMember(db,'fueler'),['planejamento'],'fueler');
 assert.ok(modules(fueler).includes('plan-os')&&modules(fueler).includes('abastecimentos'));
 assert.ok(!modules(fueler).includes('op-os'),'sem Operação adicional, a Operação não aparece');
 const a=await launch(150,154,'eq1');
 await rejects(cancelOrder({workOrderId:a.wo,reason:'Teste'},fueler),403,/Planejador ou Gestão/);
 // Planejador sem acessos adicionais: só o Planejamento (sem Abastecimento nem Operação).
 const pl=await set(await addMember(db,'planner'),[],'planner');
 assert.deepEqual(modules(pl).filter(m=>m!=='painel'&&m!=='exportacao'),['plan-fluxos','plan-atividade','plan-os']);
 await cancelOrder({workOrderId:a.wo,reason:'Prioridade mudou'},pl);
 // O módulo principal não é repetido como acesso adicional na tela, mas fica gravado (regras do banco).
 const stored=(await db.first('SELECT capabilities FROM members WHERE id=?',pl.id))!.capabilities;
 assert.deepEqual(stored,['planejamento']);
});

test('função e colaborador só avisam (não bloqueiam o lançamento); agenda de recursos e exportação única de equipamentos',async()=>{
 const fn=(await reg('functions',{name:'Sinaleiro'})).id;
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as Row;
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,orgId:org,locationId:loc,plannedStart:at(160),plannedEnd:at(164),steps:p.steps.map((x:Row)=>({key:x.step_key,included:true,plannedStart:x.step_key==='prep-0001'?at(160):at(162),plannedEnd:x.step_key==='prep-0001'?at(162):at(164),needs:x.step_key==='prep-0001'?[{functionId:fn,quantity:2}]:[],equipmentIds:x.step_key==='move-0001'?['eq1']:[],operatorIds:[]}))},planner);
 const v=await validateDraft(planner,id) as Row;
 assert.equal(v.errors.length,0,JSON.stringify(v.errors));
 assert.ok(v.warnings.some((w:Row)=>w.kind==='funcao'&&/faltam 2 de 2 colaborador\(es\) com a função Sinaleiro/.test(w.message)));
 const ver=(await planDetail(planner,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:ver,launchKey:key()},planner) as Row;
 const {ordersResources}=await import('../lib/planning');
 const res=await ordersResources(planner,new URL('http://x/?status=todas')) as Row;
 const mine=(res.allocations as Row[]).filter(x=>x.orderId===r.workOrderId);
 assert.ok(mine.some(x=>x.kind==='equipamento'&&x.label==='EMP-01'),'equipamento reservado');
 assert.ok(mine.some(x=>x.kind==='funcao'&&x.label==='Sinaleiro'&&x.quantity===2),'função pedida, com quantidade');
 const {exportData}=await import('../lib/exports');
 const csv=await (await exportData(manager,new URL('http://x/?sets=equipamentos&format=csv'))).text();
 const header=csv.replace(/^\uFEFF/,'').split(/\r?\n/)[0].replaceAll('"','');
 assert.equal(header,'OS;Data;Atividade;Etapa;Tipo de equipamento;TAG do equipamento;Horas planejadas');
});
