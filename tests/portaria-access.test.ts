// Portaria · acesso e travas do banco: perfil Porteiro, revogação imediata e regras que o banco garante
// sozinho (uma visita em andamento por pessoa, sem apagar, eventos e versões imutáveis, auditoria por ator).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {modules,requireAny,type Member} from '../lib/permissions';
import {audit} from '../lib/registry';
import type {Database} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,porteiro:Member,operator:Member;
const key=()=>crypto.randomUUID();
const pgRejects=(p:Promise<unknown>,pattern:RegExp)=>assert.rejects(p,(e:{message:string})=>{assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string)=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 porteiro=await set(await addMember(db,'porteiro'),[],'porteiro');
 operator=await set(await addMember(db,'operator'),[],'operator');
});
after(async()=>{await ctx.drop();});

test('perfil Porteiro: módulos da Portaria e nada dos outros; gestão vê tudo; sem acesso, 403 com código',async()=>{
 const mine=modules(porteiro);
 assert.ok(['por-registro','por-relatorios','por-painel'].every(m=>mine.includes(m)));
 assert.ok(!mine.some(m=>m.startsWith('fin-')||m.startsWith('plan-')||m.startsWith('op-')||m==='exportacao'||m.startsWith('cad-')));
 assert.ok(modules(manager).includes('por-registro'));
 assert.ok(!modules(operator).includes('por-registro'));
 assert.equal((await requireAny(porteiro,['portaria'])).id,porteiro.id);
 await assert.rejects(requireAny(operator,['portaria']),(e:{status:number,code:string})=>{assert.equal(e.status,403);assert.equal(e.code,'FORBIDDEN');return true;});
 // O acesso adicional "portaria" libera a Portaria para outro perfil.
 const extra=await set(await addMember(db,'planner'),['portaria'],'planner');
 assert.ok(modules(extra).includes('por-registro'));
});

test('revogar o acesso vale na próxima chamada, mesmo com a pessoa logada',async()=>{
 const p=await set(await addMember(db,'porteiro'),[],'porteiro');
 await requireAny(p,['portaria']);
 await set(p,[],'fueler');
 await assert.rejects(requireAny(p,['portaria']),(e:{status:number})=>e.status===403);
 const q=await set(await addMember(db,'porteiro'),[],'porteiro');
 await db.run('UPDATE members SET active=0 WHERE id=?',q.id);
 await assert.rejects(requireAny(q,['portaria']),(e:{status:number})=>e.status===403);
});

// ---- Travas do banco ----
let days=0;
async function seed(){
 const company=key(),person=key(),report=key();
 await db.run("INSERT INTO portaria_companies(id,name,origin,created_by) VALUES(?,?,'portaria',?)",company,'Empresa '+company.slice(0,6),manager.id);
 await db.run("INSERT INTO portaria_people(id,name,document_type,document_number,document_norm,company_id,created_by) VALUES(?,?,'CPF',?,?,?,?)",person,'Pessoa Teste','111.222.333-44','11122233344'+person.slice(0,2).toUpperCase().replace(/[^A-Z0-9]/g,'0'),company,manager.id);
 await db.run("INSERT INTO portaria_reports(id,base_id,op_date) VALUES(?,'base-acu',?)",report,new Date(Date.UTC(2031,0,1+(++days))).toISOString().slice(0,10));
 return {company,person,report};
}
const visit=(s:{person:string,company:string,report:string},id:string,o:Record<string,unknown>={})=>{
 const v={status:'em_andamento',entry:'2031-06-01T11:00:00Z',exit:null as string|null,mode:'a_pe',plate:null as string|null,...o};
 return db.run(`INSERT INTO portaria_visits(id,base_id,person_id,person_name,document_type,document_number,company_id,company_name,purpose,access_mode,plate_in,entry_at,exit_at,status,entry_report_id,entry_by,entry_by_name)
  VALUES(?,'base-acu',?,'Pessoa Teste','CPF','111',?,'Empresa','Reunião',?,?,?,?,?,?,?,'Gestor')`,id,s.person,s.company,v.mode,v.plate,v.entry,v.exit,v.status,s.report,manager.id);
};

test('banco: uma visita em andamento por pessoa, sem sobreposição, documento único e restrições de campo',async()=>{
 const s=await seed();
 await visit(s,key());
 await pgRejects(visit(s,key(),{entry:'2031-06-01T12:00:00Z'}),/Pessoa já tem visita|portaria_visits_open/);
 // Visita finalizada não segura a pessoa, mas outra sobreposta no tempo é recusada.
 const other=await seed();
 await visit(other,key(),{status:'finalizada',entry:'2031-06-02T10:00:00Z',exit:'2031-06-02T12:00:00Z'});
 await pgRejects(visit(other,key(),{status:'finalizada',entry:'2031-06-02T11:00:00Z',exit:'2031-06-02T13:00:00Z'}),/Pessoa já tem visita/);
 await visit(other,key(),{status:'finalizada',entry:'2031-06-02T12:00:00Z',exit:'2031-06-02T13:00:00Z'});
 // Anulada não conta para sobreposição.
 await visit(other,key(),{status:'anulada',entry:'2031-06-02T10:30:00Z'});
 await pgRejects(visit(other,key(),{status:'finalizada',entry:'2031-06-03T12:00:00Z',exit:'2031-06-03T11:00:00Z'}),/portaria_visit_exit_after_entry/);
 await pgRejects(visit(other,key(),{status:'finalizada',entry:'2031-06-03T12:00:00Z'}),/portaria_visit_state/);
 await pgRejects(visit(other,key(),{status:'em_andamento',entry:'2031-06-04T12:00:00Z',exit:'2031-06-04T13:00:00Z'}),/portaria_visit_state/);
 await pgRejects(visit(other,key(),{mode:'veiculo',entry:'2031-06-05T12:00:00Z'}),/portaria_visit_vehicle/);
 await pgRejects(visit(other,key(),{mode:'a_pe',plate:'ABC1D23',entry:'2031-06-05T12:00:00Z'}),/portaria_visit_vehicle/);
 await pgRejects(visit(other,key(),{mode:'veiculo',plate:'a-b',entry:'2031-06-05T12:00:00Z'}),/portaria_visits_plate_in_check|check/);
 await visit(other,key(),{mode:'veiculo',plate:'ABC1D23',entry:'2031-06-05T12:00:00Z',status:'finalizada',exit:'2031-06-05T13:00:00Z'});
 // Documento duplicado (mesmo tipo e número normalizado).
 await pgRejects(db.run("INSERT INTO portaria_people(id,name,document_type,document_number,document_norm,company_id,created_by) SELECT ?,'Outro','CPF',document_number,document_norm,company_id,created_by FROM portaria_people WHERE id=?",key(),s.person),/portaria_people_document/);
 // Um relatório por base e data.
 const r=await db.first('SELECT base_id,op_date FROM portaria_reports WHERE id=?',s.report);
 await pgRejects(db.run('INSERT INTO portaria_reports(id,base_id,op_date) VALUES(?,?,?)',key(),r!.base_id,r!.op_date),/portaria_reports_base_id_op_date_key/);
});

test('banco: nada é apagado, eventos e versões não mudam, identificação da visita é fixa',async()=>{
 const s=await seed(),v=key();
 await visit(s,v);
 for(const [table,id] of [['portaria_visits',v],['portaria_people',s.person],['portaria_companies',s.company],['portaria_reports',s.report]])
  await pgRejects(db.run(`DELETE FROM ${table} WHERE id=?`,id),/não pode ser apagado/);
 const ev=key();
 await db.run("INSERT INTO portaria_events(id,visit_id,report_id,kind,occurred_at,actor_id,actor_name) VALUES(?,?,?,'entrada',now(),?,'Gestor')",ev,v,s.report,manager.id);
 await pgRejects(db.run("UPDATE portaria_events SET justification='x' WHERE id=?",ev),/não pode ser alterado/);
 await pgRejects(db.run('DELETE FROM portaria_events WHERE id=?',ev),/não pode ser alterado/);
 const ver=key();
 await db.run("INSERT INTO portaria_report_versions(id,report_id,number,kind,report_version,snapshot,issued_by,issued_by_name) VALUES(?,?,1,'original',0,'{}'::jsonb,?,'Gestor')",ver,s.report,manager.id);
 await pgRejects(db.run("UPDATE portaria_report_versions SET reason='x' WHERE id=?",ver),/não pode ser alterado/);
 await pgRejects(db.run('DELETE FROM portaria_report_versions WHERE id=?',ver),/não pode ser alterado/);
 await pgRejects(db.run("UPDATE portaria_visits SET entry_by=? WHERE id=?",porteiro.id,v),/Identificação da visita/);
 await pgRejects(db.run("UPDATE portaria_reports SET op_date='2031-01-01' WHERE id=?",s.report),/Identificação do relatório/);
 // Relatório fechado exige o instante do fechamento.
 await pgRejects(db.run("UPDATE portaria_reports SET status='fechado' WHERE id=?",s.report),/portaria_report_closed/);
});

test('auditoria: a Portaria só grava ações da Portaria; outro acesso não grava nelas',async()=>{
 await db.tx(tx=>audit(tx,porteiro,'Portaria: entrada registrada',key(),{ok:true}));
 await pgRejects(db.tx(tx=>audit(tx,porteiro,'Financeiro: cotação registrada',key(),{})),/Auditoria sem autorização/);
 await pgRejects(db.tx(tx=>audit(tx,operator,'Portaria: entrada registrada',key(),{})),/Auditoria sem autorização/);
 await db.tx(tx=>audit(tx,porteiro,'Exportação: relatório da Portaria',key(),{}));
});
