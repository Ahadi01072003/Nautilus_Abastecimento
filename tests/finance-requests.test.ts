// Financeiro · Frente B: solicitação de recobráveis por atividade — banco, configuração, cotações,
// envio, autorização, anexos, ligação com o Planejamento, painel e exportação. Banco próprio;
// valores, clientes e fornecedores fictícios (margem 10% e impostos 10%).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {modules,type Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,operator:Member;
let org:string,person:string;
const key=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const pgRejects=(p:Promise<unknown>,pattern:RegExp)=>assert.rejects(p,(e:{message:string})=>{assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,orgScope:string[]=[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,orgScope},manager);return {...who,profile,capabilities:caps} as Member;};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 operator=await set(await addMember(db,'operator'),[],'operator');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'})).id;
 person=(await reg('people',{orgId:org,name:'Pessoa Teste',role:'Fiscal'})).id;
});
after(async()=>{await ctx.drop();});

/** Solicitação inserida direto no banco (testes das travas). */
async function rawRequest(status='em_cotacao'){
 const id=key();
 await db.run(`INSERT INTO recovery_requests(id,org_id,requester_person_id,title,description,planned_start,margin_bp,tax_bp,created_at,created_by,created_by_name,updated_at)
  VALUES(?,?,?,?,?,?,1000,1000,?,?,'Gestor',?)`,id,org,person,'Içamento de teste','',now(),now(),manager.id,now());
 if(status!=='em_cotacao')await db.run('UPDATE recovery_requests SET status=? WHERE id=?',status,id);
 return id;
}

test('banco: caminhos de situação, cotação travada, autorização exige relatório assinado, anexo não se apaga',async()=>{
 assert.ok(modules({...operator,capabilities:['financeiro']}).includes('fin-solicitacoes'));
 assert.ok(modules({...operator,capabilities:['financeiro']}).includes('fin-config'));
 const r=await rawRequest();
 await pgRejects(db.run("UPDATE recovery_requests SET status='autorizada' WHERE id=?",r),/Situação/);
 const sup=key();await db.run("INSERT INTO suppliers(id,name,active,created_at,created_by) VALUES(?,'Fornecedor Alfa',1,?,?)",sup,now(),manager.id);
 const q=key();
 await db.run('INSERT INTO recovery_quotes(id,request_id,supplier_id,value_cents,created_at,created_by,created_by_name,updated_at) VALUES(?,?,?,1000000,?,?,?,?)',q,r,sup,now(),manager.id,'Gestor',now());
 await db.run("UPDATE recovery_requests SET status='enviada',justification='Só um fornecedor atende' WHERE id=?",r);
 await pgRejects(db.run("UPDATE recovery_requests SET title='Outro título' WHERE id=?",r),/não pode ser alterad/);
 const sup2=key();await db.run("INSERT INTO suppliers(id,name,active,created_at,created_by) VALUES(?,'Fornecedor Beta',1,?,?)",sup2,now(),manager.id);
 await pgRejects(db.run('INSERT INTO recovery_quotes(id,request_id,supplier_id,value_cents,created_at,created_by,created_by_name,updated_at) VALUES(?,?,?,500,?,?,?,?)',key(),r,sup2,now(),manager.id,'Gestor',now()),/Cotação só muda em "Em cotação"/);
 await pgRejects(db.run("UPDATE recovery_requests SET status='autorizada',chosen_quote_id=? WHERE id=?",q,r),/relatório assinado/);
 const att=key();
 await db.run("INSERT INTO finance_attachments(id,request_id,kind,file_name,content_type,size_bytes,content,created_at,created_by,created_by_name) VALUES(?,?,'relatorio_assinado','assinado.pdf','application/pdf',5,?,?,?,'Gestor')",att,r,Buffer.from('%PDF-'),now(),manager.id);
 await db.run("UPDATE recovery_requests SET status='autorizada',chosen_quote_id=? WHERE id=?",q,r);
 await pgRejects(db.run('DELETE FROM finance_attachments WHERE id=?',att),/não pode ser apagado/);
 await pgRejects(db.run("UPDATE finance_attachments SET file_name='x.pdf' WHERE id=?",att),/não pode ser alterad/);
 await pgRejects(db.run('DELETE FROM recovery_requests WHERE id=?',r),/não pode ser apagad/);
 await db.run("INSERT INTO finance_client_rates(id,org_id,margin_bp,tax_bp,valid_from,created_at,created_by,created_by_name) VALUES(?,?,1000,1000,'2026-01-01',?,?,'Gestor')",key(),org,now(),manager.id);
 await pgRejects(db.run('UPDATE finance_client_rates SET tax_bp=1250 WHERE org_id=?',org),/nova vigência/);
 // Número sequencial por sequência do banco.
 const n=await db.all('SELECT number FROM recovery_requests ORDER BY number');
 assert.ok(n.length>=1&&Number(n[0].number)>=1);
});
