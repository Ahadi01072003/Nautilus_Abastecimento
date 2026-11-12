// Ambiente de teste: mesmo endereço do banco, usuário próprio (que só enxerga o schema de teste).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {databaseUrl} from '../lib/db';

const PROD='postgres://nautilus_app.abcdef:segredo%40prod@aws-x.pooler.supabase.com:6543/postgres';

test('sem usuário de teste, usa o endereço como está',()=>{
 assert.equal(databaseUrl({DATABASE_URL:PROD}),PROD);
});

test('com usuário de teste, troca usuário e senha e mantém o servidor e o projeto',()=>{
 const u=new URL(databaseUrl({DATABASE_URL:PROD,DATABASE_USER:'nautilus_teste_app',DATABASE_PASSWORD:'a/b@c'}));
 assert.equal(decodeURIComponent(u.username),'nautilus_teste_app.abcdef');
 assert.equal(decodeURIComponent(u.password),'a/b@c');
 assert.equal(u.host,'aws-x.pooler.supabase.com:6543');assert.equal(u.pathname,'/postgres');
 const local=new URL(databaseUrl({DATABASE_URL:'postgres://postgres@127.0.0.1:5432/x',DATABASE_USER:'t',DATABASE_PASSWORD:'p'}));
 assert.equal(local.username,'t');
});

test('ambiente de teste sem usuário próprio se recusa a usar o banco da produção',()=>{
 assert.throws(()=>databaseUrl({DATABASE_URL:PROD,NAUTILUS_AMBIENTE:'teste'}),/teste/);
 assert.throws(()=>databaseUrl({DATABASE_URL:PROD,VERCEL_GIT_COMMIT_REF:'teste'}),/teste/);
 assert.throws(()=>databaseUrl({DATABASE_URL:PROD,DATABASE_USER:'x'}),/senha/i);
});
