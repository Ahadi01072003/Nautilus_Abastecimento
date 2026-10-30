// Financeiro · regras da revisão final: dispensa pelo Planejamento, OS concluída com uso aberto,
// correção sem acesso à OS, escopo de organização nas tarifas, vigência retroativa, trava de
// alteração no banco, confirmação só das diárias novas, painel com uso de outro mês e de onde vem o
// previsto (tela e exportação). Banco próprio;
// valores e cliente fictícios (R$ 500/h, 8 h por diária).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {planningMutate,planDetail} from '../lib/planning';
import {orderDetail,operationMutate} from '../lib/operation';
import {centralState} from '../lib/central';
import {financeMutate,financeRates,financePanel} from '../lib/finance';
import {exportData} from '../lib/exports';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,operator:Member,fin:Member,finOnly:Member,scoped:Member;
let org:string,other:string,loc:string,flow:string;
const H=3600_000;
const key=()=>crypto.randomUUID();
const at=(h:number)=>new Date(Date.now()+h*H).toISOString();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const pgRejects=(p:Promise<unknown>,pattern:RegExp)=>assert.rejects(p,(e:{message:string})=>{assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,orgScope:string[]=[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,orgScope},manager);return {...who,profile,capabilities:caps} as Member;};
const ops=(path:string,b:Row)=>operationMutate('ops/'+path,{operationKey:key(),...b},operator) as Promise<Row>;
const fm=(path:string,b:Row,who:Member=fin)=>financeMutate('finance/'+path,b,who) as Promise<Row>;
const use=(id:string)=>db.first('SELECT * FROM equipment_uses WHERE id=?',id) as Promise<Row>;
const brasiliaDay=(t:number)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(t);

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 operator=await set(await addMember(db,'operator'),[],'operator');
 fin=await set(await addMember(db,'planner'),['financeiro'],'planner');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'})).id;
 other=(await reg('orgs',{name:'Outro Cliente',acronym:'OCL',category:'cliente',color:'#7A2B5F'})).id;
 // Abastecedor com o acesso Financeiro: não abre OS.
 finOnly=await set(await addMember(db,'fueler'),['financeiro'],'fueler');
 scoped=await set(await addMember(db,'fueler'),['financeiro'],'fueler',[org]);
 loc=(await reg('locations',{kind:'unidade',name:'Base de testes'})).id;
 const type=(await reg('equipment-types',{name:'Plataforma'})).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
 for(const n of [3,4,5,6,7,8,9])await db.run(`INSERT INTO equipment(id,tag,description,type,type_id,fuel_ids,active) VALUES('eq${n}','PTA-0${n}','Plataforma ${n}','Plataforma',?,ARRAY['diesel'],1)`,type);
 for(const eq of ['eq1','eq2','eq3','eq4','eq5','eq6','eq7','eq8','eq9'])await financeMutate('finance/rates',{equipmentId:eq,orgId:org,hourly:500,hoursPerDay:8,validFrom:'2020-01-01'},manager);
 await financeMutate('finance/rates',{equipmentId:'eq1',orgId:other,hourly:500,hoursPerDay:8,validFrom:'2020-01-01'},manager);
 flow=(await flowsMutate('flows/save',{code:'ICA',name:'Içamento',steps:[
  {key:'a-0001',name:'Preparação',needs:[{equipmentTypeId:type,quantity:1}]},
  {key:'b-0001',name:'Içamento',needs:[{equipmentTypeId:type,quantity:1}]},
 ]},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

/** OS do cliente com as duas etapas do fluxo; cada etapa com o seu equipamento. */
async function launch(start:number,end:number,steps:Record<string,[number,number,string]>){
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,orgId:org,locationId:loc,plannedStart:at(start),plannedEnd:at(end),description:'',
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:at(steps[s.step_key][0]),plannedEnd:at(steps[s.step_key][1]),
   needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,materialId:n.material_id,quantity:n.quantity,amount:n.amount,unit:n.unit})),equipmentIds:[steps[s.step_key][2]],operatorIds:[]}))},planner);
 const v=(await planDetail(planner,id)).plan.version;
 return (await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as {workOrderId:string}).workOrderId;
}
const stepOf=async(wo:string,k:string)=>(await orderDetail(operator,wo)).steps.find((s:Row)=>s.step_key===k)!;
async function freeOrder(orgId:string,start:string,end:string,eq:string){
 const {id}=await planningMutate('planning/create-free',{},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 await planningMutate('planning/save',{id,version:p.version,title:'Içamento com plataforma',orgId,locationId:loc,plannedStart:start,plannedEnd:end,description:'',
  steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,plannedStart:null,plannedEnd:null,needs:[],equipmentIds:[eq],operatorIds:[]}))},planner);
 const v=(await planDetail(planner,id)).plan.version;
 return (await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as {workOrderId:string}).workOrderId;
}

test('dispensa pelo Planejamento da última etapa com o equipamento encerra o uso e a OS (auditoria do Planejamento)',async()=>{
 const wo=await launch(-1,5,{'a-0001':[-1,1,'eq1'],'b-0001':[1,3,'eq1']});
 const a=await stepOf(wo,'a-0001');
 await ops('start',{stepId:a.id});
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:at(-0.5)},operator);
 await ops('finish',{stepId:a.id});
 assert.equal((await use(u.id)).ended_at,null);
 const b=await stepOf(wo,'b-0001');
 await operationMutate('ops/dispense',{stepId:b.id,reason:'Içamento feito por terceiros'},planner);
 const row=await use(u.id);
 assert.equal(row.end_source,'etapa');assert.equal(row.review,'a_conferir');
 assert.equal((await db.first('SELECT status FROM work_orders WHERE id=?',wo))!.status,'concluida');
 assert.ok(await db.first("SELECT 1 FROM audits WHERE entity_id=? AND action='Planejamento: fim automático de uso de equipamento'",u.id));
});

test('OS concluída encerra qualquer uso ainda aberto (equipamento de etapa já finalizada)',async()=>{
 const wo=await launch(-2,5,{'a-0001':[-2,0,'eq2'],'b-0001':[0,3,'eq3']});
 const a=await stepOf(wo,'a-0001');
 await ops('start',{stepId:a.id});await ops('finish',{stepId:a.id});
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq2',startedAt:at(-0.2)},operator);
 const b=await stepOf(wo,'b-0001');
 await ops('start',{stepId:b.id});await ops('finish',{stepId:b.id});
 assert.equal((await db.first('SELECT status FROM work_orders WHERE id=?',wo))!.status,'concluida');
 const row=await use(u.id);
 assert.ok(row.ended_at,'uso não fica aberto em OS concluída');assert.equal(row.end_source,'etapa');assert.equal(row.review,'a_conferir');
});

test('Financeiro sem acesso à OS: aviso leva ao painel e a correção funciona por lá',async()=>{
 const wo=await freeOrder(org,at(-12),at(4),'eq4');
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq4',startedAt:at(-9),confirm:true});
 const al=((await centralState(finOnly)).alerts as Row[]).find(x=>x.id==='use:'+u.id);
 assert.ok(al);assert.deepEqual(al!.link,{view:'fin-painel'});
 assert.deepEqual(((await centralState(operator)).alerts as Row[]).find(x=>x.id==='use:'+u.id)!.link,{view:'op-os',os:wo});
 const p=await financePanel(finOnly,new URL(`http://x/?from=${brasiliaDay(Date.now()-24*H)}&to=${brasiliaDay(Date.now())}&org=${org}`));
 assert.ok(p.detail['eq4|'+org].pending.some((x:Row)=>x.id===u.id),'uso em aberto listado para corrigir');
 await fm('uses/correct',{id:u.id,endedAt:at(-1.5),reason:'Fim informado pelo cliente',confirm:true},finOnly);
 assert.equal((await use(u.id)).review,'conferido');
});

test('escopo de organização: tarifas, clientes e cadastro de tarifa só do escopo',async()=>{
 const r=await financeRates(scoped);
 assert.ok(r.rates.length&&r.rates.every((x:Row)=>x.org_id===org),'só tarifas do cliente do escopo');
 assert.deepEqual(r.orgs.map((o:Row)=>o.id),[org]);
 await rejects(financeMutate('finance/rates',{equipmentId:'eq2',orgId:other,hourly:500,hoursPerDay:8,validFrom:'2099-01-01'},scoped),403);
 const p=await financePanel(scoped,new URL('http://x/'));
 assert.deepEqual(p.orgs.map((o:Row)=>o.id),[org]);
});

test('vigência: não pode começar antes de um uso já registrado (diárias contadas mantêm a tarifa)',async()=>{
 const wo=await freeOrder(org,at(-30),at(-20),'eq5');
 await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq5',startedAt:at(-29),endedAt:at(-27)});
 const yesterday=brasiliaDay(Date.now()-48*H);
 await rejects(financeMutate('finance/rates',{equipmentId:'eq5',orgId:org,hourly:900,hoursPerDay:8,validFrom:yesterday},manager),409,/uso registrado/);
 const tomorrow=brasiliaDay(Date.now()+24*H);
 assert.ok((await financeMutate('finance/rates',{equipmentId:'eq5',orgId:org,hourly:900,hoursPerDay:8,validFrom:tomorrow},manager) as Row).id);
 // Sem uso no período, a vigência retroativa continua possível (primeiro cadastro).
 assert.ok((await financeMutate('finance/rates',{equipmentId:'eq2',orgId:other,hourly:500,hoursPerDay:8,validFrom:'2021-01-01'},manager) as Row).id);
});

test('banco: início e fim já registrados só mudam pela correção de quem tem o Financeiro',async()=>{
 const wo=await freeOrder(org,at(-60),at(-50),'eq6');
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq6',startedAt:at(-59),endedAt:at(-58)});
 await pgRejects(db.run('UPDATE equipment_uses SET started_at=? WHERE id=?',at(-59.5),u.id),/só muda pela correção/);
 await pgRejects(db.run('UPDATE equipment_uses SET ended_at=? WHERE id=?',at(-57),u.id),/só muda pela correção/);
 await pgRejects(db.run('UPDATE equipment_uses SET ended_at=?,reviewed_by=?,reviewed_at=? WHERE id=?',at(-57),operator.id,at(0),u.id),/só muda pela correção/);
 await fm('uses/correct',{id:u.id,endedAt:at(-57.5),reason:'Horário do relatório'});
 const row=await use(u.id);
 assert.equal(row.review,'conferido');assert.equal(row.reviewed_by,fin.id);
 // Registrar o fim de um uso em aberto não é alteração: continua livre para a Operação.
 const open=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq6',startedAt:at(-56),confirm:true});
 await db.run('UPDATE equipment_uses SET ended_at=?,end_source=? WHERE id=?',at(-55),'registrado',open.id);
});

test('confirmação: conta só as diárias novas deste uso',async()=>{
 const x=await freeOrder(org,at(-48),at(-46),'eq7'),y=await freeOrder(org,at(-44),at(-20),'eq7');
 await fm('uses/start',{operationKey:key(),workOrderId:x,equipmentId:'eq7',startedAt:at(-48),endedAt:at(-46)});
 // Y entra na diária de X (aberta às -48) e passa do fim dela (-40): só uma diária nova, sem pergunta.
 const r=await fm('uses/start',{operationKey:key(),workOrderId:y,equipmentId:'eq7',startedAt:at(-44),endedAt:at(-37)});
 assert.ok(!r.confirm,'uma diária nova não pede confirmação');
 const two=await fm('uses/start',{operationKey:key(),workOrderId:y,equipmentId:'eq7',startedAt:at(-36),endedAt:at(-20)});
 assert.equal(two.confirm,true);assert.equal(two.dailies,2);assert.equal(two.valueCents,800000);
 assert.match(String(two.message),/gera 2 diárias novas \(R\$\s?8\.000,00\)/);
});

test('início em aberto no passado que já soma mais de uma diária pede confirmação',async()=>{
 const wo=await freeOrder(org,at(-30),at(4),'eq8');
 const ask=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq8',startedAt:at(-20)});
 assert.equal(ask.confirm,true);assert.equal(ask.dailies,3);
 assert.equal((await db.all("SELECT 1 FROM equipment_uses WHERE work_order_id=?",wo)).length,0,'nada gravado antes de confirmar');
 const ok=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq8',startedAt:at(-20),confirm:true});
 assert.ok(ok.id&&!ok.confirm);
});

test('painel: uso a conferir de outro mês aparece onde gera diária; diária mostra os números das OS',async()=>{
 const wo=await freeOrder(org,'2026-09-30T23:00:00.000Z','2026-10-01T03:00:00.000Z','eq1');
 // 30/09 20:00 → 01/10 08:00 (Brasília): a 2ª diária começa em outubro; uso fora do reservado → a conferir.
 const u=await fm('uses/start',{operationKey:key(),workOrderId:wo,equipmentId:'eq1',startedAt:'2026-09-30T23:00:00.000Z',endedAt:'2026-10-01T11:00:00.000Z',confirm:true});
 assert.equal((await use(u.id)).review,'a_conferir');
 const p=await financePanel(fin,new URL(`http://x/?from=2026-10-01&to=2026-10-31&org=${org}`));
 const det=p.detail['eq1|'+org];
 assert.ok(det.pending.some((x:Row)=>x.id===u.id),'uso iniciado em setembro listado em outubro');
 const n=Number((await db.first('SELECT number FROM work_orders WHERE id=?',wo))!.number);
 assert.ok(det.dailies.some((d:Row)=>d.orderNumbers?.includes(n)));
});

/** Agosto/2026 (Brasília): OS A 10/08 08–20 h e OS B 20–21 h do cliente com tarifa; OS C 11/08 09–12 h de
 * outro cliente, sem tarifa para o equipamento. */
async function forecastScenario(){
 const a=await freeOrder(org,'2026-08-10T11:00:00.000Z','2026-08-10T23:00:00.000Z','eq9');
 const b=await freeOrder(org,'2026-08-10T23:00:00.000Z','2026-08-11T00:00:00.000Z','eq9');
 const c=await freeOrder(other,'2026-08-11T12:00:00.000Z','2026-08-11T15:00:00.000Z','eq9');
 const num=async(id:string)=>Number((await db.first('SELECT number FROM work_orders WHERE id=?',id))!.number);
 return {a,b,c,na:await num(a),nb:await num(b),nc:await num(c)};
}
let scene:Awaited<ReturnType<typeof forecastScenario>>;

test('painel: previsto mostra de onde vem (por OS) e as OS do equipamento que não entram, com o motivo',async()=>{
 scene=await forecastScenario();
 const p=await financePanel(fin,new URL(`http://x/?from=2026-08-01&to=2026-08-31&org=${org}`));
 const row=p.rows.find(r=>r.equipmentId==='eq9')!;
 assert.equal(row.requests,2);assert.equal(row.plannedDailies,2);assert.equal(row.plannedCents,800000);
 const det=p.detail['eq9|'+org];
 const by=(n:number)=>(det.forecast as Row[]).find(o=>o.number===n)!;
 assert.equal(det.forecast.length,2);
 assert.deepEqual([by(scene.na).hours,by(scene.na).dailies,by(scene.na).valueCents,by(scene.na).counted],[12,2,800000,true]);
 assert.deepEqual([by(scene.nb).hours,by(scene.nb).dailies,by(scene.nb).valueCents],[1,0,0]);
 assert.deepEqual(by(scene.nb).attendedIn,[scene.na],'B é atendida dentro da 2ª diária de A');
 assert.equal((det.forecast as Row[]).reduce((s,o)=>s+o.valueCents,0),row.plannedCents,'a soma do bloco fecha com a linha');
 assert.deepEqual((det.others as Row[]).map(o=>[o.number,o.orgName,o.hours,o.reason]),[[scene.nc,'Outro Cliente',3,'cliente sem tarifa']]);
 // Quem só vê o cliente com tarifa não vê OS de outro cliente.
 const s=await financePanel(scoped,new URL(`http://x/?from=2026-08-01&to=2026-08-31&org=${org}`));
 assert.equal(s.detail['eq9|'+org].others.length,0);
});

test('exportação: Recobráveis: previsto, uma linha por OS com o motivo de entrar ou não',async()=>{
 const url=new URL(`http://x/export?sets=recobraveis_previsto&format=csv&start=2026-08-01&end=2026-08-31&org=${org}`);
 const lines=(await (await exportData(fin,url)).text()).replace(/^\uFEFF/,'').trim().split(/\r?\n/);
 assert.equal(lines[0],['Equipamento','Cliente da tarifa','OS','Cliente da OS','Situação da OS','Início da reserva','Fim da reserva','Horas no período','Diárias previstas','Valor previsto (R$)','Entra no previsto','Observação'].map(c=>'"'+c+'"').join(';'));
 const os=(n:number)=>'"OS '+String(n).padStart(6,'0')+'"';
 const line=(n:number)=>lines.find(l=>l.includes(os(n)))!;
 assert.equal(lines.length-1,3);
 assert.match(line(scene.na),/;12;2;8000;"Sim";/);
 assert.match(line(scene.nb),new RegExp(`;1;0;0;"Sim";"Atendida na diária da OS ${String(scene.na).padStart(6,'0')}"$`));
 assert.match(line(scene.nc),/"Outro Cliente".*;3;0;0;"Não";"Cliente sem tarifa"$/);
});
