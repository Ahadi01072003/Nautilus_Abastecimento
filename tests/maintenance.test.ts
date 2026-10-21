import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {maintenancePanel,maintenanceCriteria,maintenanceRecord,maintenanceRecords,maintenanceReadings,maintenanceMutate} from '../lib/maintenance';
import {conditionMutate} from '../lib/condition';
import {dateOf,localDay} from '../lib/maintenance-cycle';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,tech:Member,operator:Member,planner:Member,requester:Member;
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const key=()=>crypto.randomUUID();
const ago=(h:number)=>new Date(Date.now()-h*3600000).toISOString();
const today=()=>localDay(Date.now());
const set=async(who:Member,caps:string[],profile='requester')=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const m=(path:string,b:Row,who:Member=tech)=>maintenanceMutate('maint/'+path,b,who) as Promise<Row>;
const panel=async(who:Member=tech)=>maintenancePanel(who,new URL('http://x/?periodo=30'));
const row=async(planId:string)=>(await panel()).rows.find((r:Row)=>r.planId===planId)!;

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 tech=await set(await addMember(db,'none'),['manutencao'],'none');
 operator=await set(await addMember(db,'none'),['operacao'],'none');
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 requester=await addMember(db,'requester');
 const type=(await registryMutate('registry/equipment-types',{name:'Empilhadeira'},manager) as Row).id;
 await db.run("UPDATE equipment SET type_id=? WHERE id IN ('eq1','eq2')",type);
});
after(async()=>{await ctx.drop();});

const plan=(b:Row)=>m('plan',{tasks:['Trocar óleo','Verificar freios'],attention:['Vazamento no cilindro'],nonconformities:['Freio com folga'],cycleMode:'fixo',...b});

test('critério por dias: ciclo calculado, situação, início com parada e conclusão',async()=>{
 const {id}=await plan({equipmentId:'eq1',name:'Preventiva mensal',method:'dias',interval:30,tolerance:5,anchorDate:dateOf(today()-40)});
 let r=await row(id);
 assert.equal(r.status,'atrasada','venceu há 10 dias, além da abrangência de 5');assert.equal(r.remaining,-10);assert.equal(r.target,1);
 const p=await panel();
 assert.equal(p.cards.equipment,1);assert.equal(p.cards.atrasados,1);
 // Marco desatualizado é recusado; o início com parada bloqueia o equipamento.
 await rejects(m('start',{operationKey:key(),planId:id,cycle:2,startedAt:ago(3),responsibleId:'op1'}),409,/marcos mudaram/);
 const s=await m('start',{operationKey:key(),planId:id,cycle:1,startedAt:ago(3),responsibleId:'op1',teamIds:['op1'],stopped:true});
 assert.ok(await db.first("SELECT 1 FROM equipment_impediments WHERE equipment_id='eq1' AND kind='manutencao' AND released_at IS NULL"));
 await rejects(m('start',{operationKey:key(),planId:id,startedAt:ago(2),responsibleName:'Outro'}),409,/em andamento/);
 r=await row(id);assert.equal(r.openRecord!.id,s.id);
 await m('update',{id:s.id,items:[{done:true},{done:false}],nonconformities:['Freio com folga']});
 await m('note',{id:s.id,text:'Freio traseiro regulado'});
 await rejects(m('finish',{id:s.id,endedAt:ago(4)}),400,/depois do início/);
 const f=await m('finish',{id:s.id,endedAt:ago(1),items:[{done:true},{done:true}],nonconformities:['Freio com folga'],notes:'OK'});
 assert.equal(f.hours,2);
 assert.ok(!await db.first("SELECT 1 FROM equipment_impediments WHERE equipment_id='eq1' AND released_at IS NULL"),'fim da manutenção libera a parada');
 r=await row(id);
 assert.equal(r.status,'em_dia');assert.equal(r.firstOpen,2);assert.equal(r.remaining,20);assert.equal(r.lastDone!.cycle,1);
 const d=await maintenanceRecord(planner,s.id);
 assert.equal(d.record.hours,2);assert.equal(d.record.manHours,4);assert.equal(d.notes.length,1);assert.deepEqual((d.record as Row).items.map((x:Row)=>x.done),[true,true]);
 // Concluído não muda; só o gestor anula, e o marco volta a ficar em aberto.
 await rejects(m('update',{id:s.id,notes:'x'}),409);
 await rejects(m('void',{id:s.id,reason:'Engano'}),403);
 await m('void',{id:s.id,reason:'Registro em equipamento errado'},manager);
 r=await row(id);assert.equal(r.status,'atrasada');
 await assert.rejects(db.run("UPDATE maintenance_records SET notes='x' WHERE id=?",s.id),/não pode ser alterado/);
 await assert.rejects(db.run('DELETE FROM maintenance_records WHERE id=?',s.id),/não pode ser apagado/);
 assert.equal((await panel()).cards.hours.count,0,'anulado não conta horas');
});

test('leituras: nunca voltam, horímetro não anda mais que o tempo, abastecimento conta, operação registra',async()=>{
 await m('reading',{equipmentId:'eq2',kind:'horimetro',value:120,readAt:ago(10)},operator);
 await rejects(m('reading',{equipmentId:'eq2',kind:'horimetro',value:119,readAt:ago(5)}),409,/menor que a anterior/);
 await rejects(m('reading',{equipmentId:'eq2',kind:'horimetro',value:140,readAt:ago(5)}),409,/mais horas do que se passaram/);
 await rejects(m('reading',{equipmentId:'eq2',kind:'horimetro',value:121,readAt:ago(-2)}),400,/futuro/);
 await m('reading',{equipmentId:'eq2',kind:'horimetro',value:124.5,readAt:ago(5)});
 await rejects(m('reading',{equipmentId:'eq2',kind:'horimetro',value:130,readAt:ago(8)}),409,/maior que uma leitura registrada depois/);
 await rejects(m('reading',{equipmentId:'eq2',kind:'horimetro',value:130,readAt:ago(1)},planner),403);
 // Abastecimento com horímetro entra como leitura.
 await db.run("UPDATE fuels SET stock_milli=10000,provisional=0 WHERE id='gas'");
 await db.run("INSERT INTO supplies(id,operation_key,fuel_id,equipment_id,operator_id,quantity_milli,occurred_at,created_at,author_id,author_name,equipment_tag,equipment_name,operator_name,fuel_name,unit,hourmeter_milli,notes) VALUES('s1','k-s1','gas','eq2','op1',2000,?,?,?,'Gestor','EMP-02','Empilhadeira a gás','Operador Um','Gás','cilindros',127000,'Teste')",ago(2),ago(2),manager.id);
 const list=await maintenanceReadings(operator,new URL('http://x/?equipment=eq2'));
 const e=list.equipment.find((x:Row)=>x.id==='eq2')!;
 assert.equal(e.horimetro!.value,127);assert.equal(e.horimetro!.source,'abastecimento');
 assert.deepEqual(list.history.map((h:Row)=>h.source),['abastecimento','manual','manual']);
 // Anulação de leitura: só gestor, com motivo.
 const manual=list.history.find((h:Row)=>h.manual&&h.value===124.5)!;
 await rejects(m('reading/void',{id:manual.id,reason:'Digitação'}),403);
 await m('reading/void',{id:manual.id,reason:'Digitação'},manager);
 await assert.rejects(db.run('UPDATE equipment_readings SET value=1 WHERE id=?',manual.id),/não pode ser alterada/);
});

test('critério por horímetro: previsão pelo ritmo, leitura obrigatória no fim e regra do ciclo com motivo',async()=>{
 const {id}=await plan({equipmentId:'eq2',name:'Preventiva 50 h',method:'horimetro',interval:50,tolerance:10,anchorReading:100});
 let r=await row(id);
 assert.equal(r.current,127);assert.equal(r.status,'em_dia');assert.equal(r.remaining,23);assert.equal(r.firstOpenLabel,'150 h');
 const s=await m('start',{operationKey:key(),planId:id,startedAt:ago(1.5),responsibleName:'Mecânico terceirizado'});
 await rejects(m('finish',{id:s.id,endedAt:ago(0.5)}),400,/Leitura do horímetro/);
 await m('finish',{id:s.id,endedAt:ago(0.5),reading:127.5});
 r=await row(id);assert.equal(r.firstOpen,2);assert.equal(r.current,127.5);
 // Mudar a regra do ciclo exige motivo; mudar o método com registros é recusado.
 const c=(await maintenanceCriteria(tech)).plans.find((x:Row)=>x.id===id)!;
 const base={id,version:c.version,equipmentId:'eq2',name:c.name,method:'horimetro',interval:50,tolerance:10,anchorReading:100,tasks:c.tasks};
 await rejects(m('plan',{...base,interval:60}),400,/Motivo/);
 await m('plan',{...base,interval:60,reason:'Recomendação do fabricante'});
 await rejects(m('plan',{...base,version:c.version+1,method:'dias',anchorDate:'2030-01-01',reason:'x'}),409,/método não muda/);
 await rejects(m('plan',{...base,version:c.version+1,name:'Preventiva mensal 2',tolerance:70,interval:60,reason:'x'}),400,/abrangência/);
 const audit=await db.first("SELECT detail FROM audits WHERE action='Manutenção: critério atualizado' AND entity_id=?",id);
 assert.match(JSON.stringify(audit!.detail),/Recomendação do fabricante/);
 await rejects(plan({equipmentId:'eq2',name:'preventiva 50 H',method:'dias',interval:10,anchorDate:'2030-01-01'}),409,/mesmo nome|já tem um critério/);
});

test('corretivas: registro completo, em andamento com parada, liberação técnica de impedimento, cartões e acesso',async()=>{
 await rejects(m('corrective',{operationKey:key(),equipmentId:'eq1',startedAt:ago(5),endedAt:ago(4),responsibleId:'op1',points:[]}),400,/ponto manutenido/);
 const done=await m('corrective',{operationKey:key(),equipmentId:'eq1',startedAt:ago(50),endedAt:ago(49),responsibleId:'op1',points:['Troca da mangueira hidráulica'],failure:'Vazamento',notes:'Peça do estoque'});
 assert.equal((await db.first('SELECT late FROM maintenance_records WHERE id=?',done.id))!.late,1,'registrado mais de 24 h depois: tardio');
 // NC crítica aberta é liberada na corretiva, com justificativa.
 const imp=await conditionMutate('condition/open',{equipmentId:'eq1',reason:'Freio sem eficiência'},tech) as Row;
 const open=await m('corrective',{operationKey:key(),equipmentId:'eq1',startedAt:ago(3),responsibleName:'Oficina',stopped:true,failure:'Freio'});
 assert.equal((await db.all("SELECT id FROM equipment_impediments WHERE equipment_id='eq1' AND released_at IS NULL")).length,2);
 const detail=await maintenanceRecord(tech,open.id);
 assert.deepEqual(detail.impediments.map((i:Row)=>i.id),[imp.id],'mostra os outros impedimentos para liberar');
 await rejects(m('finish',{id:open.id,endedAt:ago(1),items:['Regulagem do freio'],releaseImpedimentIds:[imp.id]}),400,/Justificativa/);
 await m('finish',{id:open.id,endedAt:ago(1),items:['Regulagem do freio'],releaseImpedimentIds:[imp.id],releaseReason:'Freio regulado e testado'});
 assert.equal((await db.all("SELECT id FROM equipment_impediments WHERE equipment_id='eq1' AND released_at IS NULL")).length,0);
 const repeated=await m('corrective',{operationKey:key(),equipmentId:'eq1',startedAt:ago(2),endedAt:ago(1.5),responsibleId:'op1',points:['Aperto de parafusos']});
 const list=await maintenanceRecords(tech,new URL('http://x/?periodo=30'));
 assert.equal(list.cards.total,3,'o tardio de 50 h atrás também está no período de 30 dias');
 assert.ok(list.records.some((r:Row)=>r.id===repeated.id));
 assert.equal(list.cards.open,0);assert.equal(list.cards.top.tag,'EMP-01');
 const all=await maintenanceRecords(tech,new URL('http://x/?periodo=todos'));
 assert.equal(all.cards.total,3);assert.equal(all.cards.hours,3.5);
 // Acesso: consulta do painel para Planejamento/Operação; corretivas e critérios só para Manutenção.
 await panel(planner);await panel(operator);
 await rejects(panel(requester),403);
 await rejects(maintenanceRecords(planner,new URL('http://x/')),403);
 await rejects(maintenanceCriteria(operator),403);
 await rejects(m('corrective',{operationKey:key(),equipmentId:'eq1',startedAt:ago(1),responsibleName:'x'},planner),403);
});
