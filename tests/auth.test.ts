import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {login,sessionMember,changeOwnPassword,hashPassword,verifyPassword,checkPasswordPolicy,createSession,SESSION_IDLE_MS} from '../lib/auth';
import {mutate} from '../lib/service';
import type {Database} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
before(async()=>{ctx=await freshDatabase();db=ctx.database;});
after(async()=>{await ctx.drop();});

const rejects=(promise:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(promise,(e:{status?:number;message:string})=>{assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});

test('hash PBKDF2 confere somente a senha correta',async()=>{
 const hash=await hashPassword('Senha123');
 assert.match(hash,/^pbkdf2_sha256\$310000\$/);
 assert.equal(await verifyPassword('Senha123',hash),true);
 assert.equal(await verifyPassword('senha123',hash),false);
 assert.equal(await verifyPassword('Senha123',null),false);
 assert.equal(await verifyPassword('Senha123','lixo'),false);
});

test('política da senha definitiva',()=>{
 assert.throws(()=>checkPasswordPolicy('curta1','joao'),/8 caracteres/);
 assert.throws(()=>checkPasswordPolicy('somenteletras','joao'),/letras e números/);
 assert.throws(()=>checkPasswordPolicy('joao.silva2026','joao.silva'),/usuário/);
 assert.throws(()=>checkPasswordPolicy('Primeiro@2026','maria'),/senha padrão/);
 assert.equal(checkPasswordPolicy('Barco2026!','maria'),'Barco2026!');
});

test('primeiro acesso: login com senha padrão exige troca e libera depois',async()=>{
 const m=await addMember(db,'requester',{username:'joao.silva'});
 const first=await login('JOAO.SILVA','Primeiro@2026');
 assert.equal(first.mustChangePassword,true);
 const session=await sessionMember(first.token);
 assert.equal(session?.id,m.id);
 assert.equal(session?.must_change_password,1);
 // Abre uma segunda sessão que deve ser encerrada após a troca.
 const other=await login('joao.silva','Primeiro@2026');
 await rejects(changeOwnPassword(m,'errada','Barco2026x',first.token),400,/senha atual/);
 await rejects(changeOwnPassword(m,'Primeiro@2026','Primeiro@2026',first.token),400);
 await changeOwnPassword(m,'Primeiro@2026','Barco2026x',first.token);
 assert.equal((await sessionMember(first.token))?.must_change_password,0);
 assert.equal(await sessionMember(other.token),null,'outras sessões encerradas');
 await rejects(login('joao.silva','Primeiro@2026'),401);
 assert.equal((await login('joao.silva','Barco2026x')).mustChangePassword,false);
 const audit=await db.first("SELECT * FROM audits WHERE action='Senha definida pelo usuário' AND entity_id=?",m.id);
 assert.ok(audit);
 assert.ok(!audit.detail.includes('Barco2026x'),'senha nunca vai para a auditoria');
});

test('usuário inexistente, inativo ou senha errada recebem a mesma mensagem',async()=>{
 await addMember(db,'planner',{username:'inativo',active:false});
 await rejects(login('naoexiste','Primeiro@2026'),401,/Usuário ou senha inválidos/);
 await rejects(login('inativo','Primeiro@2026'),401,/Usuário ou senha inválidos/);
});

test('bloqueio após 5 tentativas e desbloqueio pelo gestor',async()=>{
 const manager=await addMember(db,'manager',{mustChange:false});
 const m=await addMember(db,'fueler',{username:'bloqueado'});
 for(let i=0;i<4;i++)await rejects(login('bloqueado','errada'),401);
 await rejects(login('bloqueado','errada'),423,/bloqueado/);
 await rejects(login('bloqueado','Primeiro@2026'),423,/bloqueado/);
 await mutate('members/unlock',{id:m.id},manager);
 assert.ok((await login('bloqueado','Primeiro@2026')).token);
});

test('senha provisória expira após 7 dias',async()=>{
 await addMember(db,'requester',{username:'expirado'});
 await db.run("UPDATE members SET password_changed_at=? WHERE username='expirado'",new Date(Date.now()-8*86400000).toISOString());
 await rejects(login('expirado','Primeiro@2026'),401,/expirou/);
});

test('sessão expira por inatividade e é revogada ao desativar o usuário',async()=>{
 const manager=await addMember(db,'manager',{mustChange:false});
 const m=await addMember(db,'requester');
 const token=await createSession(m.id);
 assert.ok(await sessionMember(token));
 await db.run('UPDATE sessions SET expires_at=? WHERE member_id=?',new Date(Date.now()-1000).toISOString(),m.id);
 assert.equal(await sessionMember(token),null);
 const token2=await createSession(m.id);
 await mutate('members',{id:m.id,username:m.username,name:m.name,role:'requester',active:false},manager);
 assert.equal(await sessionMember(token2),null);
 assert.equal(await sessionMember('token-invalido'),null);
 assert.equal(await sessionMember(undefined),null);
 assert.ok(SESSION_IDLE_MS>0);
});

test('gestor cria usuário, redefine senha e não pode rebaixar a si mesmo',async()=>{
 const manager=await addMember(db,'manager',{mustChange:false});
 const created=await mutate('members',{username:'Maria.Souza',name:'Maria Souza',email:'Maria@Example.com',role:'fueler'},manager) as {id:string;username:string};
 assert.equal(created.username,'maria.souza');
 const row=await db.first('SELECT * FROM members WHERE id=?',created.id);
 assert.equal(row?.email,'maria@example.com');
 assert.equal(row?.must_change_password,1);
 const first=await login('maria.souza','Primeiro@2026');
 await changeOwnPassword({...created,profile:'fueler',name:'Maria Souza'},'Primeiro@2026','Navio2026z',first.token);
 assert.ok(await sessionMember(first.token));
 // Redefinição com senha provisória personalizada encerra as sessões.
 await mutate('members/reset-password',{id:created.id,temporaryPassword:'Temp1234'},manager);
 assert.equal(await sessionMember(first.token),null);
 const again=await login('maria.souza','Temp1234');
 assert.equal(again.mustChangePassword,true);
 await rejects(mutate('members',{username:'outra',name:'X',role:'requester'},{...created,profile:'fueler',name:'Maria'}),403);
 await rejects(mutate('members',{username:'maria.souza',name:'Duplicada',role:'requester'},manager),409,/já está em uso/);
 await rejects(mutate('members',{id:manager.id,username:manager.username,name:manager.name,role:'planner'},manager),400,/próprio acesso/);
 await rejects(mutate('members/reset-password',{id:manager.id},manager),400,/Minha conta/);
 await rejects(mutate('members',{username:'x y',name:'Inválido',role:'requester'},manager),400,/Usuário deve/);
});

test('o banco preserva ao menos um gestor ativo',async()=>{
 const isolated=await freshDatabase();
 try{
  const only=await addMember(isolated.database,'manager',{mustChange:false});
  await assert.rejects(isolated.database.run("UPDATE members SET profile='planner' WHERE id=?",only.id),/Mantenha ao menos um gestor ativo/);
  await assert.rejects(isolated.database.run('DELETE FROM members WHERE id=?',only.id),/Mantenha ao menos um gestor ativo/);
 }finally{await isolated.drop();}
});
