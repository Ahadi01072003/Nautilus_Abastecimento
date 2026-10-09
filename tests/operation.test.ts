import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation,key} from './helpers';
import {mutate,state,exportCSV} from '../lib/service';
import type {Database} from '../lib/db';
import type {Member} from '../lib/permissions';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,requester:Member,requester2:Member,planner:Member,fueler:Member,fueler2:Member;
before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 requester=await addMember(db,'requester');requester2=await addMember(db,'requester');
 planner=await addMember(db,'planner',{email:null});
 fueler=await addMember(db,'fueler');fueler2=await addMember(db,'fueler');
 // Entrada física inicial: 500 L de diesel e 6 cilindros.
 await mutate('stock',{operationKey:key(),fuelId:'diesel',quantity:500,reason:'Carga inicial'},manager);
 await mutate('stock',{operationKey:key(),fuelId:'gas',quantity:6,reason:'Carga inicial'},manager);
});
after(async()=>{await ctx.drop();});

const rejects=(promise:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(promise,(e:{status?:number;code?:string;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const fuel=(id:string)=>db.first('SELECT * FROM fuels WHERE id=?',id);
const future=(h=2)=>new Date(Date.now()+h*3600000).toISOString();
async function request(who:Member,equipmentId='eq1',fuelId='diesel',hourmeter=100){return (await mutate('appointments',{operationKey:key(),equipmentId,fuelId,hourmeter},who) as {id:string}).id;}
async function schedule(id:string,who:Member=planner,at=future()){const a=await db.first('SELECT version FROM appointments WHERE id=?',id);return mutate('appointments/schedule',{id,version:a!.version,scheduledAt:at},who);}

test('fluxo completo: solicitar, agendar, abastecer e baixar o estoque',async()=>{
 const id=await request(requester);
 await rejects(mutate('supplies',{operationKey:key(),appointmentId:id,equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:10,occurredAt:new Date().toISOString(),hourmeter:100},fueler),409,/Agendamento indisponível/);
 await schedule(id);
 // Qualquer abastecedor atende a agenda compartilhada.
 const supply=await mutate('supplies',{operationKey:key(),appointmentId:id,equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:42.5,occurredAt:new Date().toISOString(),hourmeter:101,hourmeterEnd:102.5},fueler2) as {id:string};
 assert.equal((await fuel('diesel'))!.stock_milli,457500);
 const appointment=await db.first('SELECT * FROM appointments WHERE id=?',id);
 assert.equal(appointment!.status,'completed');
 const movement=await db.first("SELECT * FROM movements WHERE supply_id=? AND kind='debit'",supply.id);
 assert.equal(movement!.delta_milli,-42500);assert.equal(movement!.balance_after_milli,457500);
 // Eventos de aviso: gestor e abastecedores (agendamento); planejador sem e-mail não entra na fila.
 const scheduled=await db.all("SELECT n.member_id FROM notifications n JOIN notification_events e ON e.id=n.event_id WHERE e.kind='scheduled' AND e.entity_id=?",id);
 assert.deepEqual(new Set(scheduled.map(r=>r.member_id)),new Set([manager.id,fueler.id,fueler2.id]));
 const requested=await db.all("SELECT n.member_id FROM notifications n JOIN notification_events e ON e.id=n.event_id WHERE e.kind='requested' AND e.entity_id=?",id);
 assert.deepEqual(requested.map(r=>r.member_id),[manager.id]);
});

test('reenvio com a mesma operationKey não duplica consumo',async()=>{
 const id=await request(requester);await schedule(id,manager,future(3));
 const body={operationKey:key(),appointmentId:id,equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:5,occurredAt:new Date().toISOString(),hourmeter:100};
 const before=(await fuel('diesel'))!.stock_milli;
 const a=await mutate('supplies',body,fueler) as {id:string};
 const b=await mutate('supplies',body,fueler) as {id:string;repeated?:boolean};
 assert.equal(a.id,b.id);assert.equal(b.repeated,true);
 assert.equal((await fuel('diesel'))!.stock_milli,before-5000);
 await rejects(mutate('supplies',body,fueler2),409,/já utilizada/);
});

test('perfis: solicitante só vê os próprios pedidos; planejador não registra consumo',async()=>{
 const mine=await request(requester2);
 const view=await state(requester2);
 assert.ok(view.appointments.every(a=>a.requester_id===requester2.id));
 assert.ok(view.appointments.some(a=>a.id===mine));
 assert.deepEqual(view.members,[]);assert.deepEqual(view.supplies,[]);assert.deepEqual(view.movements,[]);
 assert.equal('access' in view,false,'senha padrão só aparece para o gestor');
 await schedule(mine);
 await rejects(mutate('supplies',{operationKey:key(),appointmentId:mine,equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:1,occurredAt:new Date().toISOString(),hourmeter:100},planner),403);
 await rejects(mutate('stock',{operationKey:key(),fuelId:'diesel',quantity:1,reason:'x'},fueler),403);
 await rejects(mutate('members',{username:'novo',name:'Novo',role:'manager'},planner),403);
 // Solicitante não cancela pedido já agendado nem pedido de outra pessoa.
 const a=await db.first('SELECT version FROM appointments WHERE id=?',mine);
 await rejects(mutate('appointments/cancel',{id:mine,version:a!.version,reason:'x'},requester2),403);
 await rejects(mutate('appointments/cancel',{id:mine,version:a!.version,reason:'x'},requester),409);
 const managerView=await state(manager);
 assert.equal(managerView.access?.defaultPassword,'Primeiro@2026');
 assert.ok(managerView.members.every(m=>!('password_hash' in m)),'hash de senha nunca sai do servidor');
 const fuelerView=await state(fueler);
 assert.ok(fuelerView.supplies.every(s=>s.author_id===fueler.id));
});

test('abastecedor exige agendamento; gestor registra exceção somente com justificativa',async()=>{
 const base={equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:2,occurredAt:new Date().toISOString(),hourmeter:10};
 await rejects(mutate('supplies',{...base,operationKey:key()},fueler),403,/agendado/);
 await rejects(mutate('supplies',{...base,operationKey:key()},manager),400,/Justifique/);
 await mutate('supplies',{...base,operationKey:key(),notes:'Emergência no turno'},manager);
 await rejects(mutate('supplies',{...base,operationKey:key(),notes:'x',occurredAt:new Date(Date.now()+3600000).toISOString()},manager),400,/futuro/);
 await rejects(mutate('supplies',{...base,operationKey:key(),notes:'x',equipmentId:'eq2'},manager),400,/incompatível/);
 await rejects(mutate('supplies',{...base,operationKey:key(),notes:'x',fuelId:undefined},manager),400,/Combustível é obrigatório/);
});

test('estoque nunca fica negativo e cilindros não aceitam frações',async()=>{
 const id=await request(requester,'eq2','gas',5);await schedule(id,planner,future(4));
 const base={appointmentId:id,equipmentId:'eq2',fuelId:'gas',operatorId:'op1',occurredAt:new Date().toISOString(),hourmeter:5};
 await rejects(mutate('supplies',{...base,operationKey:key(),quantity:1.5},fueler),400,/frações/);
 await assert.rejects(mutate('supplies',{...base,operationKey:key(),quantity:7},fueler),/Estoque insuficiente/);
 assert.equal((await fuel('gas'))!.stock_milli,6000);
});

test('estoque mínimo abre uma única reposição; recebimento parcial e "em compra"',async()=>{
 const id=await request(requester,'eq2','gas',5);await schedule(id,planner,future(5));
 await mutate('supplies',{operationKey:key(),appointmentId:id,equipmentId:'eq2',fuelId:'gas',operatorId:'op1',quantity:4,occurredAt:new Date().toISOString(),hourmeter:6},fueler);
 const requests=await db.all("SELECT * FROM requests WHERE fuel_id='gas'");
 assert.equal(requests.length,1);
 const r=requests[0];assert.equal(r.status,'open');assert.equal(r.requested_milli,8000);
 const minimum=await db.all("SELECT n.member_id FROM notifications n JOIN notification_events e ON e.id=n.event_id WHERE e.kind='minimum'");
 assert.deepEqual(minimum.map(x=>x.member_id),[manager.id]);
 // Segundo consumo abaixo do mínimo não abre outra reposição.
 const id2=await request(requester,'eq2','gas',7);await schedule(id2,planner,future(6));
 await mutate('supplies',{operationKey:key(),appointmentId:id2,equipmentId:'eq2',fuelId:'gas',operatorId:'op1',quantity:1,occurredAt:new Date().toISOString(),hourmeter:7},fueler);
 assert.equal((await db.all("SELECT id FROM requests WHERE fuel_id='gas'")).length,1);
 await mutate('stock',{operationKey:key(),fuelId:'gas',quantity:3,requestId:r.id,reason:'Recebimento parcial'},manager);
 assert.equal((await db.first('SELECT status,received_milli FROM requests WHERE id=?',r.id))!.status,'partial');
 // Corrigido: "em compra" não apaga um recebimento parcial.
 await rejects(mutate('requests/status',{id:r.id,status:'purchasing'},manager),409);
 await assert.rejects(mutate('stock',{operationKey:key(),fuelId:'gas',quantity:6,requestId:r.id,reason:'Excesso'},manager),/Recebimento excede/);
 await mutate('stock',{operationKey:key(),fuelId:'gas',quantity:5,requestId:r.id,reason:'Restante'},manager);
 assert.equal((await db.first('SELECT status FROM requests WHERE id=?',r.id))!.status,'received');
 assert.equal((await fuel('gas'))!.stock_milli,9000);
});

test('cancelar abastecimento estorna uma vez e reabre a solicitação',async()=>{
 const id=await request(requester);await schedule(id,planner,future(7));
 const s=await mutate('supplies',{operationKey:key(),appointmentId:id,equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:20,occurredAt:new Date().toISOString(),hourmeter:100},fueler) as {id:string};
 const before=(await fuel('diesel'))!.stock_milli;
 await rejects(mutate('supplies/cancel',{id:s.id,reason:''},manager),400,/Justificativa/);
 await mutate('supplies/cancel',{id:s.id,reason:'Lançamento em duplicidade'},manager);
 assert.equal((await fuel('diesel'))!.stock_milli,before+20000);
 const a=await db.first('SELECT * FROM appointments WHERE id=?',id);
 assert.equal(a!.status,'requested');assert.equal(a!.scheduled_at,null);
 await rejects(mutate('supplies/cancel',{id:s.id,reason:'de novo'},manager),409);
 assert.equal((await db.all("SELECT id FROM movements WHERE supply_id=? AND kind='reversal'",s.id)).length,1);
 await assert.rejects(db.run('UPDATE movements SET delta_milli=0 WHERE supply_id=?',s.id),/não podem ser alteradas/);
});

test('conflito de versão e de horário no agendamento',async()=>{
 const id=await request(requester);
 const at=future(30);
 await mutate('appointments/schedule',{id,version:0,scheduledAt:at},planner);
 await rejects(mutate('appointments/schedule',{id,version:0,scheduledAt:future(31)},planner),409,/mudou/);
 const other=await request(requester);
 await assert.rejects(mutate('appointments/schedule',{id:other,version:0,scheduledAt:at},planner),(e:{code?:string;constraint_name?:string})=>e.code==='23505'&&e.constraint_name==='idx_appointment_equipment_time');
 await rejects(mutate('appointments/schedule',{id:other,version:0,scheduledAt:new Date(Date.now()-3600000).toISOString()},planner),400,/futura/);
});

test('conferência de estoque usa versão e remove a marcação provisória',async()=>{
 const f=(await fuel('diesel'))!;
 await rejects(mutate('stock',{operationKey:key(),fuelId:'diesel',kind:'adjustment',balance:400,version:f.version-1,reason:'Conferência'},manager),409);
 await mutate('stock',{operationKey:key(),fuelId:'diesel',kind:'adjustment',balance:400,version:f.version,reason:'Conferência física'},manager);
 const after=(await fuel('diesel'))!;
 assert.equal(after.stock_milli,400000);assert.equal(after.provisional,0);
 await assert.rejects(mutate('stock',{operationKey:key(),fuelId:'diesel',quantity:700,reason:'Excesso'},manager),/capacidade/);
});

test('cadastros: feriado inválido, equipamento, combustível e operador',async()=>{
 await rejects(mutate('holidays',{date:'2026-02-30',name:'Inválido'},manager),400,/Data inválida/);
 await mutate('holidays',{date:'2026-11-20',name:'Consciência Negra'},manager);
 await rejects(mutate('equipment',{tag:'emp-03',description:'Nova',type:'Empilhadeira',fuelIds:['nao-existe']},manager),400,/inválido/);
 const eq=await mutate('equipment',{tag:'emp-03',description:'Nova',type:'Empilhadeira',fuelIds:['diesel','diesel']},manager) as {id:string};
 const row=await db.first('SELECT * FROM equipment WHERE id=?',eq.id);
 assert.equal(row!.tag,'EMP-03');assert.deepEqual(row!.fuel_ids,['diesel']);
 await rejects(mutate('equipment',{id:'nao-existe',tag:'X',description:'X',type:'X',fuelIds:['diesel']},manager),404);
 const fuelId=(await mutate('fuels',{name:'Arla 32',unit:'L',integral:false,capacity:200,minimum:20,leadDays:3,balance:10},manager) as {id:string}).id;
 // Saldo inicial abaixo do mínimo já abre reposição.
 assert.equal((await db.all("SELECT id FROM requests WHERE fuel_id=? AND status='open'",fuelId)).length,1);
 await rejects(mutate('fuels',{name:'Excesso',unit:'L',capacity:10,minimum:1,leadDays:2,balance:20},manager),400,/capacidade/);
 await rejects(mutate('fuels',{id:fuelId,name:'Arla 32',unit:'L',capacity:5,minimum:1,leadDays:3},manager),400,/menor que o saldo/);
 const op=await mutate('operators',{name:'Operador Dois',badge:'123'},manager) as {id:string};
 assert.ok(await db.first('SELECT id FROM operators WHERE id=?',op.id));
 const view=await state(manager);
 assert.ok(view.stats.length>=1);assert.ok(view.daily.length>=1);
 assert.ok(view.audits.length>0);
});

test('exportação CSV neutraliza fórmulas e respeita filtros',async()=>{
 await db.run("UPDATE operators SET name='=CMD()' WHERE id='op1'");
 const id=await request(requester);await schedule(id,planner,future(9));
 await mutate('supplies',{operationKey:key(),appointmentId:id,equipmentId:'eq1',fuelId:'diesel',operatorId:'op1',quantity:1,occurredAt:new Date().toISOString(),hourmeter:100,notes:'+SOMA(1)'},fueler);
 const bytes=new Uint8Array(await (await exportCSV(new URL('http://x/api/export?kind=supplies&fuel=diesel'),manager)).arrayBuffer());
 assert.deepEqual([...bytes.slice(0,3)],[0xEF,0xBB,0xBF],'BOM UTF-8 para o Excel');
 const csv=new TextDecoder().decode(bytes);
 assert.ok(csv.startsWith('"ID";'));
 assert.ok(csv.includes(`"'=CMD()"`));assert.ok(csv.includes(`"'+SOMA(1)"`));
 assert.ok(!csv.includes('"gas"'));
 await rejects(exportCSV(new URL('http://x/api/export?kind=supplies&start=2026-13-01'),manager),400);
 await rejects(exportCSV(new URL('http://x/api/export?kind=supplies'),fueler),403);
 const movements=await (await exportCSV(new URL('http://x/api/export?kind=movements'),manager)).text();
 assert.ok(movements.split('\r\n').length>5);
});

test('histórico importado (sem baixa) aparece no gráfico e o cancelamento não estorna estoque',async()=>{
 const before=(await fuel('diesel'))!.stock_milli;
 await db.run('ALTER TABLE supplies DISABLE TRIGGER supply_after_insert');
 try{
  await db.run("INSERT INTO supplies(id,operation_key,fuel_id,equipment_id,operator_id,quantity_milli,occurred_at,created_at,author_id,author_name,equipment_tag,equipment_name,operator_name,fuel_name,unit,notes) VALUES('hist1','planilha:teste','diesel','eq1','op1',100000,'2026-03-25T15:00:00.000Z',?,?,?,'EMP-01','Empilhadeira','Operador Um','Diesel','L','Histórico importado')",new Date().toISOString(),manager.id,manager.name);
 }finally{await db.run('ALTER TABLE supplies ENABLE TRIGGER supply_after_insert');}
 assert.equal((await fuel('diesel'))!.stock_milli,before,'importação não mexe no estoque');
 const view=await state(manager);
 assert.ok(view.daily.some(d=>d.day==='2026-03-25'&&d.fuel_id==='diesel'&&d.quantity_milli===100000&&d.count===1),'histórico completo no gráfico');
 await mutate('supplies/cancel',{id:'hist1',reason:'Lançado em duplicidade na planilha'},manager);
 assert.equal((await fuel('diesel'))!.stock_milli,before,'sem estorno de algo que não saiu do estoque');
 assert.equal((await db.all("SELECT id FROM movements WHERE supply_id='hist1'")).length,0);
});
