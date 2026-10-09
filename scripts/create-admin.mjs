// Cria o primeiro gestor em um banco vazio. A senha informada é provisória:
// no primeiro acesso o sistema exige a troca por uma senha definitiva.
// Uso: DATABASE_URL=... node scripts/create-admin.mjs <usuario> "<Nome Completo>" <senha-provisoria> [email]
import {pbkdf2Sync,randomBytes,randomUUID} from 'node:crypto';
import postgres from 'postgres';

const [username,name,password,email]=process.argv.slice(2);
if(!process.env.DATABASE_URL||!username||!name||!password){console.error('Uso: DATABASE_URL=... node scripts/create-admin.mjs <usuario> "<Nome>" <senha-provisoria> [email]');process.exit(1);}
if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)){console.error('Usuário inválido.');process.exit(1);}
const salt=randomBytes(16),key=pbkdf2Sync(password.normalize('NFKC'),salt,310000,32,'sha256');
const hash=`pbkdf2_sha256$310000$${salt.toString('base64url')}$${key.toString('base64url')}`;
const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
try{
 const t=new Date().toISOString();
 await sql`INSERT INTO members(id,username,email,name,profile,active,created_at,password_hash,must_change_password,password_changed_at) VALUES(${randomUUID()},${username},${email?.toLowerCase()||null},${name},'manager',1,${t},${hash},1,${t})`;
 console.log(`Gestor ${username} criado. Entre com a senha provisória e defina a senha definitiva.`);
}finally{await sql.end();}
