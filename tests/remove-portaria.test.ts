// Migração 0025: a Portaria saiu do banco e as regras de perfil e auditoria voltaram ao que valia antes.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import type {Database} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
before(async()=>{ctx=await freshDatabase();db=ctx.database;});
after(async()=>{await ctx.drop();});

test('as tabelas e funções da Portaria não existem mais',async()=>{
 const t=await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'portaria\\_%'");
 assert.deepEqual(t,[]);
 const f=await db.all("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname LIKE 'nautilus\\_portaria%'");
 assert.deepEqual(f,[]);
});

test('perfil Porteiro e acesso portaria são recusados pelo banco',async()=>{
 await assert.rejects(addMember(db,'porteiro' as never),/members_profile_check|violates check/i);
 const m=await addMember(db,'operator');
 await assert.rejects(db.run("UPDATE members SET capabilities=ARRAY['portaria']::text[] WHERE id=?",m.id),/member_capabilities|violates check/i);
});

test('a auditoria não aceita mais ações da Portaria de quem não é gestor',async()=>{
 const m=await addMember(db,'operator');
 const ins=(action:string)=>db.run("INSERT INTO audits(id,action,entity_id,author_id,author_name,created_at,detail) VALUES(?,?,?,?,?,now(),'{}')",crypto.randomUUID(),action,'x',m.id,'Teste');
 await ins('Operação: teste');
 await assert.rejects(ins('Portaria: relatório do dia aberto'),/Auditoria sem autorização/);
});
