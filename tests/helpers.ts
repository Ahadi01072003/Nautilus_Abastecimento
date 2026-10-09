// Banco Postgres isolado por arquivo de teste. Requer TEST_DATABASE_URL apontando
// para um servidor local descartável (nunca produção). Nenhum e-mail real é enviado.
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import postgres from 'postgres';
import {connect,setTestDatabase,type Database} from '../lib/db';
import {hashPassword} from '../lib/auth';
import type {Member} from '../lib/permissions';

export const ADMIN_URL=process.env.TEST_DATABASE_URL||'postgres://postgres@127.0.0.1:55432/postgres';
process.env.DEFAULT_PASSWORD='Primeiro@2026';
process.env.EMAIL_ENABLED='false';

export async function freshDatabase(){
 const name='nautilus_t_'+Math.random().toString(36).slice(2,10);
 const admin=postgres(ADMIN_URL,{max:1,onnotice:()=>{}});
 await admin.unsafe(`CREATE DATABASE ${name}`);
 const url=new URL(ADMIN_URL);url.pathname='/'+name;
 const setup=postgres(url.toString(),{max:1,onnotice:()=>{}});
 const dir=join(import.meta.dirname,'..','db','migrations');
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await setup.unsafe(readFileSync(join(dir,file),'utf8'));
 await setup.end();
 const database=connect(url.toString(),{max:4});
 setTestDatabase(database);
 return {database,async drop(){setTestDatabase(null);await database.end();await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}};
}

let counter=0;
export async function addMember(database:Database,profile:Member['profile'],opts:{username?:string;email?:string|null;password?:string;mustChange?:boolean;active?:boolean}={}){
 const id=crypto.randomUUID(),username=opts.username||`${profile}${++counter}`,t=new Date().toISOString();
 await database.run('INSERT INTO members(id,username,email,name,profile,active,created_at,password_hash,must_change_password,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,username,opts.email===undefined?`${username}@example.com`:opts.email,'Pessoa '+username,profile,opts.active===false?0:1,t,await hashPassword(opts.password||'Primeiro@2026'),opts.mustChange===false?0:1,t);
 return {id,username,name:'Pessoa '+username,profile,active:1} as Member&{username:string};
}

/** Cadastro operacional mínimo: diesel (L) e gás (cilindros), equipamento e operador. */
export async function seedOperation(database:Database){
 await database.run("INSERT INTO fuels(id,name,unit,integral,capacity_milli,minimum_milli,stock_milli,lead_days,provisional,active) VALUES('diesel','Diesel','L',0,1000000,100000,0,2,1,1),('gas','Gás','cilindros',1,10000,2000,0,5,1,1)");
 await database.run("INSERT INTO equipment(id,tag,description,type,fuel_ids,active) VALUES('eq1','EMP-01','Empilhadeira','Empilhadeira',ARRAY['diesel'],1),('eq2','EMP-02','Empilhadeira a gás','Empilhadeira',ARRAY['gas'],1)");
 await database.run("INSERT INTO operators(id,name,badge,active) VALUES('op1','Operador Um','',1)");
}
export const key=()=>crypto.randomUUID();
