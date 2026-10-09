import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect,placeholders} from '../lib/db';
import {ADMIN_URL} from './helpers';

test('placeholders convertem ? fora de literais',()=>{
 assert.equal(placeholders("SELECT ? , '?' , ?"),"SELECT $1 , '?' , $2");
});

test('consultas simultâneas nunca excedem o pool (sem pipelining no pooler)',async()=>{
 const database=connect(ADMIN_URL,{max:2});
 try{
  // Cada consulta informa quantas conexões do próprio cliente estão ativas naquele instante.
  const rows=await Promise.all(Array.from({length:12},()=>database.first<{active:number}>("SELECT pg_sleep(0.03), (SELECT count(*) FROM pg_stat_activity WHERE application_name='postgres.js' AND state='active') active")));
  assert.equal(rows.length,12);
  assert.ok(rows.every(r=>r!.active<=2),'no máximo uma consulta por conexão');
  const value=await database.tx(async tx=>{await tx.run('SELECT 1');return (await tx.first<{n:number}>('SELECT 2 n'))!.n;});
  assert.equal(value,2);
 }finally{await database.end();}
});
