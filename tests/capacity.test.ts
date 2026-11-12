// Planejamento P1: barras (OCP e Equinor), equipes ADM e turnos 2x2, ausências, capacidade em HH por dia e
// por função, planejadores por barra e solicitante por barra.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {planningMutate,planDetail} from '../lib/planning';
import {capacityGet,capacityMutate,shiftWorking} from '../lib/capacity';
import type {Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,planner:Member,ocpPlanner:Member;
let ocpOrg:string,eqnOrg:string,loc:string;
const fn:Record<string,string>={};
const op:Record<string,string>={};
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,planningBars?:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);
 await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,...(planningBars?{planningBars}:{})},manager);return {...who,profile,capabilities:caps} as Member;};
const reg=(p:string,b:Row,who=manager)=>registryMutate('registry/'+p,b,who) as Promise<Row>;
const cap=async(bar:string,from:string,to=from)=>(await capacityGet('planning/capacity',new URL(`http://x/?bar=${bar}&from=${from}&to=${to}`),planner) as Row).days as Row[];

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 planner=await set(await addMember(db,'planner'),['planejamento'],'planner');
 ocpPlanner=await set(await addMember(db,'planner'),['planejamento'],'planner',['ocp']);
 ocpOrg=(await reg('orgs',{name:'OCP OCEANPACT',acronym:'OCP',category:'interna',color:'#14254A'})).id as string;
 eqnOrg=(await reg('orgs',{name:'Equinor Brasil',acronym:'EQN',category:'cliente',color:'#B3261E'})).id as string;
 loc=(await reg('locations',{kind:'unidade',name:'Base Açu'})).id as string;
 for(const n of ['Assistente de Operações','Assistente de Materiais','Líder de Operações','Supervisor','Artífice'])fn[n]=(await reg('functions',{name:n})).id as string;
 // Equinor: 7 ADM que entram no HH (+ supervisor fora), 7 no Turno A e 7 no Turno B. OCP: 3 ADM no HH + 1 que planeja.
 const add=async(name:string,bar:string,team:string,f:string,countsHh=true)=>{op[name]=(await reg('operators',{name,functionIds:[fn[f]],bar,team,actingFunctionId:fn[f],countsHh})).id as string;};
 for(let i=0;i<7;i++)await add(`ADM ${i}`,'equinor','adm',i<4?'Assistente de Operações':'Assistente de Materiais');
 await add('Supervisor ADM','equinor','adm','Supervisor',false);
 for(let i=0;i<7;i++)await add(`A ${i}`,'equinor','turno_a',i===0?'Líder de Operações':'Assistente de Operações');
 for(let i=0;i<7;i++)await add(`B ${i}`,'equinor','turno_b',i===0?'Líder de Operações':'Assistente de Operações');
 for(const n of ['Phillip','Yan','Italo'])await add(n,'ocp','adm','Artífice');
 await add('Jefferson','ocp','adm','Artífice',false);
});
after(async()=>{await ctx.drop();});

test('escala 2x2: Turno A trabalha 11 e 12/11/2026, Turno B 13 e 14, e assim por diante',()=>{
 const bar={shift_anchor:'2026-11-11'};
 assert.deepEqual(['2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15','2026-11-16','2026-11-10'].map(d=>[shiftWorking(bar,'turno_a',d),shiftWorking(bar,'turno_b',d)]),
  [[true,false],[true,false],[false,true],[false,true],[true,false],[true,false],[false,true]]);
});

test('capacidade Equinor: 147 HH em dia útil, 112 no sábado, 84 no domingo; supervisor fora do HH',async()=>{
 const days=await cap('equinor','2026-11-13','2026-11-16'); // sexta, sábado, domingo, segunda
 assert.deepEqual(days.map(d=>[d.day,d.total]),[['2026-11-13',147],['2026-11-14',112],['2026-11-15',84],['2026-11-16',147]]);
 assert.deepEqual(days.map(d=>d.shift),['turno_b','turno_b','turno_a','turno_a']);
 const mon=days[3];
 const by=Object.fromEntries((mon.byFunction as Row[]).map(f=>[f.name,[f.hours,f.people]]));
 assert.deepEqual(by['Assistente de Operações'],[4*9+6*12,10]);assert.deepEqual(by['Assistente de Materiais'],[3*9,3]);assert.deepEqual(by['Líder de Operações'],[12,1]);
 assert.ok(!by['Supervisor'],'supervisor não entra no HH');
 assert.equal((mon.people as Row[]).length,14,'7 ADM + 7 do turno do dia (no HH)');
});

test('capacidade OCP: 27 HH em dia útil (ADM só de segunda a sexta), 0 no fim de semana',async()=>{
 const days=await cap('ocp','2026-11-13','2026-11-16');
 assert.deepEqual(days.map(d=>d.total),[27,0,0,27]);
});

test('ausências (Gestão): férias reduzem a capacidade; cancelada, volta; só a Gestão lança',async()=>{
 const a=await reg('absences',{operatorId:op['ADM 0'],kind:'ferias',startDay:'2026-11-16',endDay:'2026-11-20',note:'Férias'});
 assert.equal((await cap('equinor','2026-11-16'))[0].total,147-9);
 assert.deepEqual(((await cap('equinor','2026-11-16'))[0].absent as Row[]).map(x=>[x.name,x.kind]),[['ADM 0','ferias']]);
 await rejects(reg('absences',{operatorId:op['ADM 1'],kind:'ferias',startDay:'2026-11-20',endDay:'2026-11-19'}),400,/último dia/);
 await rejects(reg('absences',{operatorId:op['ADM 1'],kind:'outra',startDay:'2026-11-20',endDay:'2026-11-20'}),400);
 const cadastro=await set(await addMember(db,'fueler'),['cadastros'],'fueler');
 await rejects(reg('absences',{operatorId:op['ADM 1'],kind:'ferias',startDay:'2026-11-20',endDay:'2026-11-20'},cadastro),403);
 await reg('absences/cancel',{id:a.id});
 assert.equal((await cap('equinor','2026-11-16'))[0].total,147);
});

test('barras configuráveis pela Gestão: horas ADM, turno, âncora e zonas validadas',async()=>{
 const bars=(await capacityGet('planning/bars',new URL('http://x/'),planner) as Row).bars as Row[];
 assert.deepEqual(bars.map(b=>[b.id,b.zones]),[['equinor',[85,100,115]],['ocp',[85,100,115]]]);
 await rejects(capacityMutate('planning/bars/save',{id:'ocp',admHours:[0,9,9,9,9,9,0],shiftHours:12,shiftAnchor:'2026-11-11',zoneTarget:85,zoneFull:100,zoneCeiling:115},planner),403);
 await rejects(capacityMutate('planning/bars/save',{id:'ocp',admHours:[0,9,9,9,9,9,0],shiftHours:12,shiftAnchor:'2026-11-11',zoneTarget:90,zoneFull:80,zoneCeiling:115},manager),400,/zona/i);
 await capacityMutate('planning/bars/save',{id:'ocp',admHours:[0,8,8,8,8,8,0],shiftHours:12,shiftAnchor:'2026-11-11',zoneTarget:80,zoneFull:100,zoneCeiling:110},manager);
 assert.equal((await cap('ocp','2026-11-16'))[0].total,24);
 await capacityMutate('planning/bars/save',{id:'ocp',admHours:[0,9,9,9,9,9,0],shiftHours:12,shiftAnchor:'2026-11-11',zoneTarget:85,zoneFull:100,zoneCeiling:115},manager);
});

test('planejador por barra: só lança OS da barra que planeja; sem barra definida, todas',async()=>{
 assert.deepEqual((await db.first('SELECT bar FROM requester_orgs WHERE id=?',ocpOrg))!.bar,'ocp');
 assert.deepEqual((await db.first('SELECT bar FROM requester_orgs WHERE id=?',eqnOrg))!.bar,'equinor');
 assert.deepEqual((await db.first('SELECT planning_bars FROM members WHERE id=?',ocpPlanner.id))!.planning_bars,['ocp']);
 const draft=async(who:Member,orgId:string)=>{const {id}=await planningMutate('planning/create-free',{},who) as {id:string};const p=(await planDetail(who,id)).plan;
  return planningMutate('planning/save',{id,version:p.version,title:'x',orgId,locationId:loc,plannedStart:'2031-01-10',plannedEnd:'2031-01-10',steps:p.steps.map((s:Row)=>({key:s.step_key,included:true,needs:[],equipmentIds:[],operatorIds:[]}))},who);};
 await rejects(draft(ocpPlanner,eqnOrg),403,/barra OCP/);
 assert.ok(await draft(ocpPlanner,ocpOrg));
 assert.ok(await draft(planner,eqnOrg),'sem barra definida: planeja todas');
 assert.ok(await draft(manager,eqnOrg));
 await rejects(mutate('members',{id:ocpPlanner.id,username:(await db.first('SELECT username FROM members WHERE id=?',ocpPlanner.id))!.username,name:'x',role:'planner',capabilities:['planejamento'],planningBars:['outra']},manager),400);
});
