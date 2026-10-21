import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {flowsMutate} from '../lib/flows';
import {planningMutate,planDetail,validateDraft} from '../lib/planning';
import {maintenanceMutate} from '../lib/maintenance';
import {centralState} from '../lib/central';
import {dateOf,localDay} from '../lib/maintenance-cycle';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,tech:Member,client:Member,requester:Member;
let orgA:string,orgB:string,loc:string,flow:string;
const key=()=>crypto.randomUUID();
const ago=(h:number)=>new Date(Date.now()-h*3600000).toISOString();
const set=async(who:Member,caps:string[],profile='requester',orgScope:string[]=[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,orgScope},manager);return {...who,profile,capabilities:caps} as Member;};
const ids=(s:Row)=>(s.alerts as Row[]).map(a=>a.id as string);

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 orgA=(await reg('orgs',{name:'Cliente A',acronym:'CLA',category:'cliente',color:'#2B5F7A'})).id;
 orgB=(await reg('orgs',{name:'Cliente B',acronym:'CLB',category:'cliente',color:'#7A2B5F'})).id;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id;
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 tech=await set(await addMember(db,'none'),['manutencao'],'none');
 client=await set(await addMember(db,'none'),['acompanhamento'],'none',[orgA]);
 requester=await addMember(db,'requester');
 flow=(await flowsMutate('flows/save',{code:'CEN',name:'Atividade central',steps:[{key:'a-0001',name:'Única'}]},manager) as {id:string}).id;
});
after(async()=>{await ctx.drop();});

/** OS lançada com início no passado (fica com início vencido). */
async function lateOrder(org:string,eq?:string):Promise<Row>{
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 const start=ago(30),end=new Date(Date.now()+3600000).toISOString();
 await planningMutate('planning/save',{id,version:p.version,orgId:org,locationId:loc,plannedStart:start,plannedEnd:end,steps:[{key:'a-0001',included:true,plannedStart:start,plannedEnd:end,needs:[],equipmentIds:eq?[eq]:[],operatorIds:[]}]},planner);
 const v=(await planDetail(planner,id)).plan.version;
 return {plan:id,...await planningMutate('planning/launch',{id,version:v,launchKey:key()},planner) as Row};
}

test('painel central: avisos e resumo conforme o acesso de cada pessoa',async()=>{
 const a=await lateOrder(orgA),b=await lateOrder(orgB);
 await db.run("UPDATE fuels SET stock_milli=50000,provisional=0 WHERE id='diesel'");
 await maintenanceMutate('maint/plan',{equipmentId:'eq1',name:'Mensal',method:'dias',interval:30,tolerance:2,anchorDate:dateOf(localDay(Date.now())-40),tasks:['Lubrificar']},tech);
 await maintenanceMutate('maint/corrective',{operationKey:key(),equipmentId:'eq2',startedAt:ago(5),responsibleName:'Oficina',stopped:true,failure:'Pneu furado'},tech);

 const m=await centralState(manager);
 assert.ok(ids(m).includes('fuel:diesel'),'combustível no mínimo para o gestor');
 assert.ok(ids(m).includes('late:'+a.workOrderId)&&ids(m).includes('late:'+b.workOrderId));
 assert.equal(m.alerts.find((x:Row)=>x.id==='late:'+a.workOrderId).severity,'critico','início vencido há mais de 24 h');
 assert.equal(m.alerts.find((x:Row)=>x.id==='late:'+a.workOrderId).link.os,a.workOrderId);
 assert.ok(m.alerts.some((x:Row)=>x.module==='manutencao'&&x.severity==='critico'&&/Preventiva atrasada/.test(x.title)));
 assert.ok(m.alerts.some((x:Row)=>/Corretiva em aberto/.test(x.title)));
 assert.ok(m.alerts.some((x:Row)=>x.id.startsWith('imp:')&&/EMP-02/.test(x.title)),'equipamento parado aparece como bloqueado');
 assert.equal(m.alerts[0].severity,'critico','ordenados por gravidade');
 assert.equal(m.sections.manutencao.atrasados,1);assert.equal(m.sections.operacao.late,2);

 // Cliente com escopo: só a OS da própria organização; sem abastecimento, sem manutenção.
 const c=await centralState(client);
 assert.ok(ids(c).includes('late:'+a.workOrderId));assert.ok(!ids(c).includes('late:'+b.workOrderId));
 assert.ok(!c.alerts.some((x:Row)=>x.module!=='operacao'));
 assert.equal(c.sections.abastecimento,undefined);assert.equal(c.sections.manutencao,undefined);assert.equal(c.sections.operacao.late,1);

 // Manutenção sem outros acessos: só avisos de manutenção.
 const t=await centralState(tech);
 assert.ok(t.alerts.length&&t.alerts.every((x:Row)=>x.module==='manutencao'));
 assert.equal(t.sections.manutencao.openCorrectives,1);

 // Solicitante: só o resumo das próprias solicitações.
 const r=await centralState(requester);
 assert.deepEqual(r.alerts,[]);assert.equal(r.sections.solicitacoes.own,true);assert.equal(r.sections.operacao,undefined);
});

test('planejamento avisa quando o equipamento reservado tem preventiva vencida',async()=>{
 const {id}=await planningMutate('planning/create',{activityTypeId:flow},planner) as {id:string};
 const p=(await planDetail(planner,id)).plan;
 const start=new Date(Date.now()+48*3600000).toISOString(),end=new Date(Date.now()+50*3600000).toISOString();
 await planningMutate('planning/save',{id,version:p.version,orgId:orgA,locationId:loc,plannedStart:start,plannedEnd:end,steps:[{key:'a-0001',included:true,plannedStart:start,plannedEnd:end,needs:[],equipmentIds:['eq1'],operatorIds:[]}]},planner);
 const v=await validateDraft(planner,id) as Row;
 assert.deepEqual(v.errors,[]);
 assert.ok(v.warnings.some((w:Row)=>/EMP-01: preventiva “Mensal” atrasada/.test(w.message)),JSON.stringify(v.warnings));
});
