// Migração 0030: a barra do solicitante vem do cadastro existente (OceanPact → OCP; demais → Equinor).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import postgres from 'postgres';
import {ADMIN_URL} from './helpers';

test('0030: OceanPact (OCPT / OCEANPACT, e variações OCP) vai para a barra OCP; clientes para Equinor',async()=>{
 const name='nautilus_m30_'+Math.random().toString(36).slice(2,8),admin=postgres(ADMIN_URL,{max:1,onnotice:()=>{}});
 await admin.unsafe(`CREATE DATABASE ${name}`);
 const url=new URL(ADMIN_URL);url.pathname='/'+name;const sql=postgres(url.toString(),{max:1,onnotice:()=>{}});
 try{
  const dir=join(import.meta.dirname,'..','db','migrations'),files=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
  for(const f of files.filter(f=>f<'0030'))await sql.unsafe(readFileSync(join(dir,f),'utf8'));
  const orgs=[['a','OCPT','OCEANPACT','interna'],['b','OCP','OCP OCEANPACT','interna'],['c','EQN','Equinor','cliente'],['d','TFMC','Technip FMC','cliente'],['e','OPL','OceanPact Log','interna']];
  for(const [id,acr,nm,cat] of orgs)await sql`INSERT INTO requester_orgs(id,acronym,name,category,color,active,created_at,updated_at) VALUES(${id},${acr},${nm},${cat},'#123456',1,'2026-11-16T00:00:00.000Z','2026-11-16T00:00:00.000Z')`;
  await sql.unsafe(readFileSync(join(dir,files.find(f=>f.startsWith('0030'))!),'utf8'));
  const rows=Object.fromEntries((await sql`SELECT id,bar FROM requester_orgs`).map(r=>[r.id,r.bar]));
  assert.deepEqual(rows,{a:'ocp',b:'ocp',c:'equinor',d:'equinor',e:'ocp'});
 }finally{await sql.end();await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}
});
