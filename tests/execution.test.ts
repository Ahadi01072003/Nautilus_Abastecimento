import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {planningMutate,planDetail} from '../lib/planning';
import {conditionMutate} from '../lib/condition';
import {orderDetail,operationMutate,startCheck} from '../lib/operation';
import {opsBoard,opsDashboard} from '../lib/board';
import {orderReport,orderWorkbook} from '../lib/reports';
import {exportData,exportPreview} from '../lib/exports';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member,viewer:Member;
let flow:string,org:string,loc:string,catBlock:string,catOcc:string,catImpact:string;
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const pgRejects=(p:Promise<unknown>,pattern:RegExp)=>assert.rejects(p,(e:{message:string})=>{assert.match(e.message,pattern);return true;});
const at=(day:number,h:number,m=0)=>new Date(Date.UTC(2031,1,day,h+3,m)).toISOString();
const key=()=>crypto.randomUUID();
const set=async(who:Member,caps:string[],profile='requester')=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const ops=(path:string,b:Row,who:Member=operator)=>operationMutate('ops/'+path,{operationKey:key(),...b},who) as Promise<Row>;
const q=(c:string)=>({text:c,required:true,critical:false,target:'atividade',allowNa:true,noteOn:['NC']});

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'none'),['operacao'],'none');
 viewer=await set(await addMember(db,'none'),['acompanhamento'],'none');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Operação',acronym:'OPS',category:'interna',color:'#103B52'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 const type=(await reg('equipment-types',{name:'Empilhadeira'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
 catBlock=(await reg('categories',{kind:'bloqueio',name:'Chuva'})).id;
 catOcc=(await reg('categories',{kind:'ocorrencia',name:'Observação'})).id;
 catImpact=(await reg('categories',{kind:'impacto',name:'Atraso de material'})).id;
 flow=(await flowsMutate('flows/save',{code:'MOV',name:'Movimentação',steps:[
  {key:'prep-0001',name:'Preparação'},
  {key:'insp-0001',name:'Inspeção',needs:[{equipmentTypeId:type,quantity:1}]},
  {key:'move-0001',name:'Movimentação',dependsOn:['prep-0001','insp-0001']},
 ]},manager) as {id:string}).id;
 await reg('checklists',{code:'CK-ATV',title:'Liberação da área',moment:'pre_atividade',mandatory:true,links:{activityTypeIds:[flow]},questions:[q('Área isolada?'),{...q('Risco de queda?'),critical:true}]});
 await reg('checklists',{code:'CK-EQ',title:'Pré-uso empilhadeira',moment:'pre_uso',mandatory:false,links:{equipmentTypeIds:[type]},questions:[{...q('Freios?'),critical:true,target:'equipamento',allowNa:false}]});
 await reg('checklists',{code:'CK-POS',title:'Encerramento',moment:'pos_atividade',mandatory:true,links:{activityTypeIds:[flow]},questions:[q('Área limpa?')]});
});
after(async()=>{await ctx.drop();});

/** Cria e lança uma OS completa com o equipamento na Inspeção. */
async function launch(day:number,eq='eq1'){
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 const times:Record<string,[string,string]>={'prep-0001':[at(day,8),at(day,10)],'insp-0001':[at(day,8),at(day,10)],'move-0001':[at(day,10),at(day,12)]};
 await planningMutate('planning/save',{id,version:p.version,orgId:org,locationId:loc,plannedStart:at(day,7),plannedEnd:at(day,18),steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:times[s.step_key][0],plannedEnd:times[s.step_key][1],needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,quantity:n.quantity})),equipmentIds:s.step_key==='insp-0001'?[eq]:[],operatorIds:[]}))},planner);
 const v=(await planDetail(planner,id)).plan.version;
 const r=await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as {workOrderId:string};
 return r.workOrderId;
}
const detail=(wo:string,who:Member=operator)=>orderDetail(who,wo);
const step=async(wo:string,k:string)=>(await detail(wo)).steps.find((s:Row)=>s.step_key===k)!;
async function fill(wo:string,code:string,answers:Record<string,{answer:string,note?:string}>,extra:Row={}){
 const d=await detail(wo);
 const req=d.requirements.find((r:Row)=>r.code===code&&(!extra.equipmentId||r.equipment_id===extra.equipmentId))!;
 const {id}=await ops('checklist/start',{workOrderId:wo,requirementId:req.id});
 const qs=(await detail(wo)).questions.filter((x:Row)=>x.version_id===req.version_id);
 for(const x of qs){const a=answers[x.text];if(a)await ops('checklist/answer',{instanceId:id,questionId:x.id,...a,...extra});}
 return {id,questions:qs};
}

test('acesso: só quem tem Operação executa; acompanhamento consulta',async()=>{
 const wo=await launch(3);
 const d=await detail(wo,viewer);
 assert.equal(d.can.execute,false);assert.equal(d.requirements.length,3,'atividade (2) + equipamento eq1 (1)');
 const s=d.steps.find((x:Row)=>x.step_key==='prep-0001')!;void s;
 await rejects(ops('start',{stepId:s.id},viewer),403);
 await rejects(ops('start',{stepId:s.id},planner),403);
});

test('execução: checklist pré-atividade, paralelismo, dependência, idempotência e corrida',async()=>{
 const wo=await launch(5);
 const prep=await step(wo,'prep-0001'),insp=await step(wo,'insp-0001'),move=await step(wo,'move-0001');
 assert.match((await startCheck(operator,prep.id)).blockers.join(' '),/Checklist obrigatório pendente: Liberação da área/);
 await rejects(ops('start',{stepId:prep.id}),409,/Liberação da área/);
 const ck=await fill(wo,'CK-ATV',{'Área isolada?':{answer:'NC'},'Risco de queda?':{answer:'C'}});
 await rejects(ops('checklist/complete',{instanceId:ck.id}),409,/observação obrigatória para NC/);
 await ops('checklist/answer',{instanceId:ck.id,questionId:ck.questions[0].id,answer:'C'});
 await ops('checklist/complete',{instanceId:ck.id});
 await rejects(ops('checklist/answer',{instanceId:ck.id,questionId:ck.questions[0].id,answer:'NC',note:'x'}),409,/concluído/);
 await pgRejects(db.run("UPDATE checklist_answers SET answer='NA' WHERE instance_id=?",ck.id),/concluído/);
 const k=key();
 await operationMutate('ops/start',{operationKey:k,stepId:prep.id},operator);
 assert.equal((await operationMutate('ops/start',{operationKey:k,stepId:prep.id},operator) as Row).repeated,true);
 assert.equal((await db.all("SELECT * FROM execution_events WHERE os_step_id=? AND kind='inicio'",prep.id)).length,1);
 const r=await Promise.allSettled([ops('start',{stepId:insp.id}),ops('start',{stepId:insp.id})]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1,'duas tentativas simultâneas: um só início');
 assert.equal((await db.first('SELECT status FROM work_orders WHERE id=?',wo))!.status,'em_andamento');
 await rejects(ops('start',{stepId:move.id}),409,/Aguardando a conclusão de “Preparação”.*Aguardando a conclusão de “Inspeção”/);
 await pgRejects(db.run("UPDATE execution_events SET kind='termino' WHERE os_step_id=?",prep.id),/não pode ser alterado/);
 await pgRejects(db.run('DELETE FROM audits'),/Auditoria não pode ser alterada/);
 await ops('finish',{stepId:prep.id});await ops('finish',{stepId:insp.id});
});

test('bloqueios: dois bloqueios exigem duas resoluções; ocorrência não para o relógio; impacto com bloqueio para',async()=>{
 const wo=await launch(7,'eq2');
 const ck=await fill(wo,'CK-ATV',{'Área isolada?':{answer:'C'},'Risco de queda?':{answer:'C'}});await ops('checklist/complete',{instanceId:ck.id});
 const prep=await step(wo,'prep-0001');
 await ops('start',{stepId:prep.id});
 await ops('note',{stepId:prep.id,kind:'ocorrencia',categoryId:catOcc,description:'Visita da fiscalização'});
 assert.equal((await step(wo,'prep-0001')).status,'em_execucao');
 await rejects(ops('block',{stepId:prep.id,description:'Sem categoria'}),400,/categoria/);
 const b1=await ops('block',{stepId:prep.id,categoryId:catBlock,description:'Chuva forte'});
 const b2=await ops('note',{stepId:prep.id,kind:'impacto',blocking:true,categoryId:catImpact,description:'Material atrasou',severity:'alta'});
 const d=await detail(wo);
 assert.equal(d.steps.find((s:Row)=>s.id===prep.id)!.status,'bloqueada');
 const iv=d.intervals.filter((i:Row)=>i.os_step_id===prep.id);
 assert.deepEqual(iv.map((i:Row)=>[i.kind,!!i.end_at]),[['ativo',true],['interrompido',false]],'um só intervalo de parada para bloqueios sobrepostos');
 await ops('resolve',{id:b1.id,resolution:'Chuva passou'});
 await rejects(ops('resume',{stepId:prep.id}),409,/bloqueio aberto/);
 await ops('resolve',{id:b2.id,resolution:'Material chegou'});
 await ops('resume',{stepId:prep.id});
 await ops('pause',{stepId:prep.id,reason:'Almoço'});
 await ops('resume',{stepId:prep.id});
 const iv2=(await detail(wo)).intervals.filter((i:Row)=>i.os_step_id===prep.id);
 assert.deepEqual(iv2.map((i:Row)=>i.kind),['ativo','interrompido','ativo','interrompido','ativo']);
 await pgRejects(db.run("UPDATE occurrences SET description='x' WHERE id=?",b1.id),/não pode ser alterado/);
 await ops('block',{stepId:prep.id,categoryId:catBlock,description:'Chuva de novo'});
 await rejects(ops('finish',{stepId:prep.id}),400,/informe como o impedimento foi resolvido/);
 await ops('finish',{stepId:prep.id,resolution:'Encerrada sob chuva fraca, área coberta'});
 assert.equal((await step(wo,'prep-0001')).status,'concluida');
 // Registro tardio permitido após o término, identificado.
 const late=await ops('note',{stepId:prep.id,kind:'ocorrencia',description:'Esquecido: lona rasgada',occurredAt:new Date(Date.now()-3600000).toISOString()});
 assert.equal((await db.first('SELECT late FROM occurrences WHERE id=?',late.id))!.late,1);
});

test('NC crítica de equipamento: bloqueio global imediato, interrupção, sem liberação por resposta C',async()=>{
 const wo=await launch(9,'eq1');
 const ck=await fill(wo,'CK-ATV',{'Área isolada?':{answer:'C'},'Risco de queda?':{answer:'C'}});await ops('checklist/complete',{instanceId:ck.id});
 const insp=await step(wo,'insp-0001');
 await ops('start',{stepId:insp.id});
 const eqck=await fill(wo,'CK-EQ',{},{equipmentId:'eq1'});
 await rejects(ops('checklist/answer',{instanceId:eqck.id,questionId:eqck.questions[0].id,answer:'NA'}),400,/não aceita N\/A/);
 const r=await ops('checklist/answer',{instanceId:eqck.id,questionId:eqck.questions[0].id,answer:'NC',note:'Pedal sem resposta'});
 assert.match(r.message,/bloqueado em todo o sistema.*1 etapa/);
 assert.equal((await step(wo,'insp-0001')).status,'bloqueada');
 const imp=await db.first("SELECT * FROM equipment_impediments WHERE equipment_id='eq1' AND released_at IS NULL");
 assert.equal(imp!.kind,'nc_critica');
 // Responder C depois não libera; resolver o bloqueio local também não.
 await ops('checklist/answer',{instanceId:eqck.id,questionId:eqck.questions[0].id,answer:'C'});
 assert.ok(await db.first("SELECT 1 FROM equipment_impediments WHERE equipment_id='eq1' AND released_at IS NULL"));
 const local=(await detail(wo)).occurrences.find((o:Row)=>o.impediment_id===imp!.id)!;
 const msg=await ops('resolve',{id:local.id,resolution:'Operador ciente'});
 assert.match(msg.message,/continua bloqueado/);
 await rejects(ops('resume',{stepId:insp.id}),409,/continua bloqueado/);
 // Outro planejamento não consegue reservar o equipamento.
 await rejects(launch(11,'eq1'),409,/bloqueado por impedimento técnico/);
 await conditionMutate('condition/release',{id:imp!.id,reason:'Freio regulado',evidence:'OM 77'},manager);
 await ops('resume',{stepId:insp.id});
 assert.equal((await step(wo,'insp-0001')).status,'em_execucao');
});

test('encerramento: pendente sem checklist pós-atividade; automático e único depois; equipamento ocupado além do previsto',async()=>{
 const wo=await launch(13,'eq2');
 const ck=await fill(wo,'CK-ATV',{'Área isolada?':{answer:'C'},'Risco de queda?':{answer:'C'}});await ops('checklist/complete',{instanceId:ck.id});
 const prep=await step(wo,'prep-0001'),insp=await step(wo,'insp-0001'),move=await step(wo,'move-0001');
 await ops('start',{stepId:insp.id});
 // Execução real em aberto: reserva planejada já terminou (13/02 10h), mas o equipamento segue ocupado.
 const other=await planningMutate('planning/create',{activityTypeId:flow},planner) as {id:string};
 const p=(await planDetail(planner,other.id)).plan;
 await rejects(planningMutate('planning/save',{id:other.id,version:p.version,steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:s.step_key==='insp-0001'?at(13,11):null,plannedEnd:s.step_key==='insp-0001'?at(13,12):null,needs:[],equipmentIds:s.step_key==='insp-0001'?['eq2']:[],operatorIds:[]}))},planner),409);
 await ops('start',{stepId:prep.id});
 await ops('finish',{stepId:prep.id});await ops('finish',{stepId:insp.id});
 await ops('start',{stepId:move.id});
 const r=await ops('finish',{stepId:move.id});
 assert.equal(r.closure,'encerramento_pendente');
 const w1=await db.first('SELECT * FROM work_orders WHERE id=?',wo);
 assert.equal(w1!.status,'encerramento_pendente');assert.ok(w1!.actual_end,'término físico preservado');
 const pos=await fill(wo,'CK-POS',{'Área limpa?':{answer:'C'}});
 const done=await ops('checklist/complete',{instanceId:pos.id});
 assert.equal(done.closure,'concluida');
 const w2=await db.first('SELECT * FROM work_orders WHERE id=?',wo);
 assert.equal(w2!.status,'concluida');assert.equal(w2!.actual_end,w1!.actual_end,'encerramento administrativo não altera o término operacional');
 assert.equal((await db.all("SELECT * FROM execution_events WHERE work_order_id=? AND kind='encerramento'",wo)).length,1);
 // Apontamento complementar após o encerramento continua possível (registro tardio identificado).
 await ops('note',{stepId:move.id,kind:'ocorrencia',description:'Conferência posterior'});
});

test('dispensa formal pelo Planejamento libera dependentes e reservas',async()=>{
 const wo=await launch(17,'eq2');
 const insp=await step(wo,'insp-0001');
 await rejects(operationMutate('ops/dispense',{stepId:insp.id,reason:'x'},operator),403);
 await operationMutate('ops/dispense',{stepId:insp.id,reason:'Equipamento inspecionado ontem'},planner);
 assert.equal((await step(wo,'insp-0001')).status,'dispensada');
 assert.equal((await db.all("SELECT * FROM reservations r JOIN os_steps o ON o.plan_step_id=r.plan_step_id WHERE o.id=? AND r.status<>'liberada'",insp.id)).length,0);
 assert.ok(!(await startCheck(operator,(await step(wo,'move-0001')).id)).blockers.some((b:string)=>/Inspeção/.test(b)));
});

test('painel de OS, planilha, relatório e exportação: escopo, tempo efetivo sem dupla contagem e auditoria',async()=>{
 const wo=await launch(21,'eq2');
 const ck=await fill(wo,'CK-ATV',{'Área isolada?':{answer:'C'},'Risco de queda?':{answer:'C'}});await ops('checklist/complete',{instanceId:ck.id});
 const prep=await step(wo,'prep-0001'),insp=await step(wo,'insp-0001');
 await ops('start',{stepId:prep.id});await ops('start',{stepId:insp.id});
 await ops('note',{stepId:insp.id,kind:'ocorrencia',categoryId:catOcc,description:'=CMD()'});
 await ops('pause',{stepId:prep.id,reason:'Aguardando material'});await ops('finish',{stepId:insp.id});
 // Horários fixos: Preparação 08:00–09:00 (parada 09:00–09:30) e Inspeção 08:30–10:00, em paralelo.
 await db.run('ALTER TABLE step_intervals DISABLE TRIGGER interval_guard');
 try{
  await db.run("UPDATE step_intervals SET start_at=?,end_at=? WHERE os_step_id=? AND kind='ativo'",at(21,8),at(21,9),prep.id);
  await db.run("UPDATE step_intervals SET start_at=?,end_at=? WHERE os_step_id=? AND kind='interrompido'",at(21,9),at(21,9,30),prep.id);
  await db.run("UPDATE step_intervals SET start_at=?,end_at=? WHERE os_step_id=?",at(21,8,30),at(21,10),insp.id);
 }finally{await db.run('ALTER TABLE step_intervals ENABLE TRIGGER interval_guard');}
 const url=(q:string)=>new URL('http://x/api/'+q);

 const board=await opsBoard(viewer,url('ops/board?group=andamento'));
 const card=board.orders.find(o=>o.id===wo)!;
 assert.ok(card,'OS em andamento no painel');assert.equal(card.steps.length,3);assert.equal(card.intervals.length,3);assert.equal(card.occurrences.length,1);
 assert.ok(board.counts.andamento>=1);assert.equal(board.canExecute,false);
 assert.ok((await opsBoard(viewer,url('ops/board?group=todas&q=mov'))).orders.some(o=>o.id===wo),'busca pelo código da atividade');
 await rejects(opsBoard(viewer,url('ops/board?group=qualquer')),400);
 assert.ok((await opsDashboard(operator)).kpis.running>=1);

 assert.equal((await orderReport(operator,wo)).effective,120*60000,'união dos intervalos ativos: 2h, não 2h30');

 const book=await orderWorkbook(viewer,wo);
 assert.match(book.headers.get('Content-Type')||'',/spreadsheetml/);assert.match(book.headers.get('Content-Disposition')||'',/OS-\d{6}_/);
 assert.equal(new TextDecoder().decode(new Uint8Array(await book.arrayBuffer()).slice(0,2)),'PK');
 assert.ok(await db.first("SELECT 1 FROM audits WHERE action='Exportação: planilha da OS' AND entity_id=? AND author_id=?",wo,viewer.id));

 const n=(await db.first('SELECT number FROM work_orders WHERE id=?',wo))!.number;
 const osCsv=await (await exportData(viewer,url('export?sets=os&format=csv'))).text();
 const line=osCsv.split('\r\n').find(l=>l.startsWith(`"OS ${String(n).padStart(6,'0')}"`))!;
 assert.ok(line.includes(';120;30;'),'tempo efetivo 120 min e parado 30 min');
 const notes=await (await exportData(viewer,url('export?sets=apontamentos&format=csv'))).text();
 assert.ok(notes.includes(`"'=CMD()"`),'fórmula neutralizada');
 const zipped=await exportData(viewer,url('export?sets=os,etapas,periodos&format=csv'));
 assert.equal(zipped.headers.get('Content-Type'),'application/zip');
 const all=await exportData(viewer,url('export?sets=os,etapas,periodos,apontamentos,checklists&format=xlsx&start=2031-02-21&end=2031-02-21'));
 assert.equal(new TextDecoder().decode(new Uint8Array(await all.arrayBuffer()).slice(0,2)),'PK');
 assert.ok(await db.first("SELECT 1 FROM audits WHERE action='Exportação: planilha de dados' AND author_id=?",viewer.id));
 assert.equal((await exportPreview(viewer,url('export/preview?sets=os&start=2031-02-21&end=2031-02-21'))).counts.os,1);
 await rejects(exportData(viewer,url('export?sets=supplies')),403);
 await rejects(exportData(viewer,url('export?sets=os,qualquer')),400);
 await rejects(exportData(viewer,url('export?sets=os&start=2031-02-22&end=2031-02-21')),400);

 // Escopo: quem só vê outra organização não enxerga a OS em nenhuma saída.
 const other=(await registryMutate('registry/orgs',{name:'Cliente B',acronym:'CLB',category:'cliente',color:'#F47A04'},manager) as {id:string}).id;
 const scoped=await addMember(db,'none');const m=await db.first('SELECT * FROM members WHERE id=?',scoped.id);
 await mutate('members',{id:scoped.id,username:m!.username,name:m!.name,role:'none',capabilities:['acompanhamento'],orgScope:[other]},manager);
 assert.ok(!(await opsBoard(scoped,url('ops/board?group=todas'))).orders.some(o=>o.id===wo));
 await rejects(orderWorkbook(scoped,wo),404);
 assert.equal((await exportPreview(scoped,url('export/preview?sets=os,apontamentos'))).counts.os,0);
 await rejects(exportData(scoped,url(`export?sets=os&org=${org}`)),403);
 // A auditoria só aceita exportação de quem consulta OS (gatilho no banco, além do servidor).
 const fuelOnly=await addMember(db,'fueler');
 await pgRejects(db.run("INSERT INTO audits(id,action,entity_id,author_id,author_name,created_at,detail) VALUES(?,?,?,?,?,?,?)",key(),'Exportação: forjada',wo,fuelOnly.id,'x',new Date().toISOString(),'{}'),/Auditoria sem autorização/);
 await rejects(opsBoard(viewer,url('ops/board?group=constructor')),400);
 assert.equal((await opsBoard(viewer,url('ops/board?group=todas&q=99999999999'))).orders.length,0);
});
