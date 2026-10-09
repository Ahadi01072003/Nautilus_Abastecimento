// Aplica db/migrations/*.sql em ordem, uma única vez cada (tabela schema_migrations).
// Uso: DATABASE_URL=postgres://... node scripts/migrate.mjs
import {readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';

const url=process.env.DATABASE_URL;
if(!url){console.error('Defina DATABASE_URL.');process.exit(1);}
const dir=join(dirname(fileURLToPath(import.meta.url)),'..','db','migrations');
const sql=postgres(url,{prepare:false,max:1,onnotice:()=>{}});
try{
 await sql`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
 const done=new Set((await sql`SELECT name FROM schema_migrations`).map(r=>r.name));
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){
  if(done.has(file))continue;
  await sql.begin(async tx=>{await tx.unsafe(readFileSync(join(dir,file),'utf8'));await tx`INSERT INTO schema_migrations(name) VALUES(${file})`;});
  console.log('Migração aplicada:',file);
 }
 console.log('Banco atualizado.');
}finally{await sql.end();}
