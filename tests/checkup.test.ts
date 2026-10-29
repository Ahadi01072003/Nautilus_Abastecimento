// Checkup: brechas encontradas na varredura geral (datas fora da faixa, horímetro que volta ou
// salta, combustível e equipamento inativados com pedido aberto, local inativo e OS de duração
// absurda no planejamento, impedimento repetido por clique duplo).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation,key} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {conditionMutate} from '../lib/condition';
import {validatePlan,type Plan} from '../lib/planning';
import {dateISO} from '../lib/domain';
import {scheduledDate} from '../lib/scheduling';
import type {Database} from '../lib/db';
import type {Member} from '../lib/permissions';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database,manager:Member;
before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 const t=new Date().toISOString();
 await db.run("INSERT INTO equipment_types(id,name,created_at,updated_at) VALUES('tp1','Empilhadeira',?,?)",t,t);
 await db.run("UPDATE equipment SET type_id='tp1'");
 await mutate('stock',{operationKey:key(),fuelId:'diesel',quantity:500,reason:'Carga inicial'},manager);
});
after(async()=>{await ctx.drop();});

const rejects=(promise:Promise<unknown>,status:number,pattern:RegExp)=>assert.rejects(promise,(e:{status?:number;message:string})=>{assert.equal(e.status,status,e.message);assert.match(e.message,pattern);return true;});
const ago=(h:number)=>new Date(Date.now()-h*3600000).toISOString();
const supply=(hourmeter:number,at:string,extra:Record<string,unknown>={})=>mutate('supplies',{operationKey:key(),equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:1,occurredAt:at,hourmeter,notes:'Registro de teste',...extra},manager) as Promise<{id:string}>;
const request=(equipmentId:string,fuelId:string,hourmeter:number)=>mutate('appointments',{operationKey:key(),equipmentId,fuelId,hourmeter},manager) as Promise<{id:string}>;
const equipment=async(id:string,fuelIds:string[])=>{const e=(await db.first('SELECT * FROM equipment WHERE id=?',id))!;return registryMutate('registry/equipment',{id,tag:e.tag,description:e.description,typeId:'tp1',fuelIds,active:true},manager);};

test('datas fora da faixa: abastecimento antes de 2020 e agendamento além de um ano são recusados',()=>{
 assert.throws(()=>dateISO('2019-12-31T12:00:00Z'),/muito antiga/);
 // Ano digitado pela metade (0026) vira o ano 26 no navegador: não pode passar como data válida.
 assert.throws(()=>dateISO('0026-05-01T10:00:00Z'),/muito antiga/);
 assert.ok(dateISO(ago(1)));
 assert.throws(()=>scheduledDate(new Date(Date.now()+400*86400000).toISOString()),/até um ano/);
 assert.ok(scheduledDate(new Date(Date.now()+30*86400000).toISOString()));
});

test('horímetro do abastecimento e da solicitação segue as leituras do equipamento',async()=>{
 await supply(100,ago(10));
 await rejects(supply(99,ago(5)),409,/menor que a leitura anterior do equipamento \(100 h\)/);
 // 100 h em 5 h de relógio: valor digitado errado.
 await rejects(supply(200,ago(5)),409,/avançou mais horas do que se passaram/);
 const ok=await supply(104,ago(5));
 // Registro retroativo acima de uma leitura posterior.
 await rejects(supply(110,ago(8)),409,/maior que uma leitura registrada depois dessa data \(104 h\)/);
 // O horímetro final também conta.
 await rejects(supply(104,ago(4),{hourmeterEnd:300}),409,/avançou mais horas/);
 // Solicitação com horímetro impossível ficaria sem abastecimento que a atendesse.
 await rejects(request('eq1','diesel',50),409,/menor que a leitura anterior/);
 await rejects(request('eq1','diesel',5000),409,/avançou mais horas/);
 await request('eq1','diesel',105);
 // Abastecimento cancelado sai das leituras: o valor anterior volta a ser a referência.
 await mutate('supplies/cancel',{id:ok.id,reason:'Horímetro digitado errado'},manager);
 await supply(101,ago(3));
});

test('combustível com solicitação em aberto não pode ser inativado',async()=>{
 const body={id:'gas',name:'Gás',unit:'cilindros',integral:true,capacity:10,minimum:2,leadDays:5,active:false};
 const {id}=await request('eq2','gas',5);
 await rejects(mutate('fuels',body,manager),409,/1 abastecimento\(s\) solicitado\(s\) ou agendado\(s\)/);
 const ap=(await db.first('SELECT version FROM appointments WHERE id=?',id))!;
 await mutate('appointments/cancel',{id,version:ap.version,reason:'Pedido em duplicidade'},manager);
 await mutate('fuels',body,manager);
 assert.equal((await db.first("SELECT active FROM fuels WHERE id='gas'"))!.active,0);
});

test('equipamento: mantém combustível já vinculado (mesmo inativo), não vincula inativo e não remove com pedido aberto',async()=>{
 // Gás ficou inativo no teste anterior e continua vinculado à EMP-02: salvar o cadastro não pode travar.
 await equipment('eq2',['gas']);
 await rejects(equipment('eq1',['diesel','gas']),400,/inválido ou inativo/);
 await db.run("INSERT INTO fuels(id,name,unit,integral,capacity_milli,minimum_milli,stock_milli,lead_days,provisional,active) VALUES('gnv','GNV','m³',0,1000000,100000,0,2,1,1)");
 await equipment('eq1',['diesel','gnv']);
 // A EMP-01 tem a solicitação de diesel aberta no teste do horímetro.
 await rejects(equipment('eq1',['gnv']),409,/abastecimento\(s\) de Diesel solicitado\(s\) ou agendado\(s\)/);
 assert.deepEqual((await db.first("SELECT fuel_ids FROM equipment WHERE id='eq1'"))!.fuel_ids,['diesel','gnv']);
});

test('planejamento: local inativo e duração acima de um ano impedem o lançamento',()=>{
 const step={step_key:'s1',name:'Içamento',included:true,planned_start:'2026-11-01T10:00:00.000Z',planned_end:'2026-11-01T18:00:00.000Z',location_id:'l2',depends_on:[],needs:[],equipment_ids:[],operator_ids:[],reservations:[]};
 const plan={org_id:'o1',location_id:'l1',planned_start:'2026-11-01T08:00:00.000Z',planned_end:'2026-11-02T08:00:00.000Z',mode:'planejada',steps:[step]} as unknown as Plan;
 const base={equipment:[],operators:[],impediments:[],orgs:[{id:'o1',active:1}],locations:[{id:'l1',active:0},{id:'l2',active:0}]};
 const messages=(r:{errors:{message:string}[]})=>r.errors.map(e=>e.message).join(' | ');
 const inactive=messages(validatePlan(plan,base));
 assert.match(inactive,/local da atividade está inativo/);
 assert.match(inactive,/Etapa “Içamento”: local inativo/);
 // Revisão que mantém o local da versão vigente (inativado depois) não é barrada por isso.
 assert.equal(messages(validatePlan(plan,{...base,keepLocations:new Set(['l1','l2'])})),'');
 const long={...plan,planned_end:new Date(Date.parse(plan.planned_start)+400*86400000).toISOString()} as unknown as Plan;
 assert.match(messages(validatePlan(long,{...base,locations:[{id:'l1',active:1},{id:'l2',active:1}]})),/no máximo um ano/);
});

test('impedimento técnico repetido (clique duplo) não abre um segundo bloqueio',async()=>{
 const first=await conditionMutate('condition/open',{equipmentId:'eq2',reason:'Pneu furado'},manager) as {id:string};
 const again=await conditionMutate('condition/open',{equipmentId:'eq2',reason:'Pneu furado'},manager) as {id:string;repeated?:boolean};
 assert.equal(again.id,first.id);assert.equal(again.repeated,true);
 await conditionMutate('condition/open',{equipmentId:'eq2',reason:'Freio com folga'},manager);
 assert.equal((await db.first("SELECT count(*)::int n FROM equipment_impediments WHERE equipment_id='eq2' AND released_at IS NULL"))!.n,2);
});
