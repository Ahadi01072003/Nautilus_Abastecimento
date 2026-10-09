import {pbkdf2,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {db,env,type Executor} from './db';
import {AppError} from './domain';
import {profiles,type Member} from './permissions';

const derive=promisify(pbkdf2);
const ITERATIONS=310000,KEY_BYTES=32;
export const SESSION_COOKIE='nautilus_session';
export const SESSION_IDLE_MS=12*3600_000;        // expira após 12 h sem uso
export const SESSION_MAX_MS=7*86400_000;         // e no máximo 7 dias após o login
export const MAX_FAILED_ATTEMPTS=5;
export const LOCK_MS=15*60_000;
export const TEMPORARY_PASSWORD_DAYS=7;          // senha de primeiro acesso vale 7 dias
const now=()=>new Date().toISOString();

export function defaultPassword(){
 const value=env().DEFAULT_PASSWORD;
 if(value)return value;
 if(process.env.NODE_ENV==='production')throw new AppError('A senha padrão de primeiro acesso não está configurada no servidor.',500);
 return 'Nautilus@2026';
}

export async function hashPassword(password:string){
 const salt=randomBytes(16);
 const key=await derive(password.normalize('NFKC'),salt,ITERATIONS,KEY_BYTES,'sha256');
 return `pbkdf2_sha256$${ITERATIONS}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password:string,stored:string|null|undefined){
 const [scheme,iterations,salt,hash]=(stored||'').split('$');
 const valid=scheme==='pbkdf2_sha256'&&Number(iterations)>=100000&&!!salt&&!!hash;
 // Usuário inexistente também gasta o mesmo tempo de cálculo.
 const expected=valid?Buffer.from(hash,'base64url'):Buffer.alloc(KEY_BYTES);
 const key=await derive(password.normalize('NFKC'),valid?Buffer.from(salt,'base64url'):Buffer.alloc(16),valid?Number(iterations):ITERATIONS,expected.length||KEY_BYTES,'sha256');
 return valid&&key.length===expected.length&&timingSafeEqual(key,expected);
}

export function normalizeUsername(value:unknown){
 const s=String(value??'').trim().toLowerCase();
 if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(s))throw new AppError('Usuário deve ter de 3 a 40 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.');
 return s;
}
/** Política da senha definitiva. */
export function checkPasswordPolicy(password:unknown,username:string){
 if(typeof password!=='string')throw new AppError('Informe a nova senha.');
 if(password.length<8)throw new AppError('A senha deve ter pelo menos 8 caracteres.');
 if(password.length>128)throw new AppError('A senha deve ter no máximo 128 caracteres.');
 if(!/[A-Za-zÀ-ÿ]/.test(password)||!/\d/.test(password))throw new AppError('A senha deve combinar letras e números.');
 if(password.toLowerCase().includes(username.toLowerCase()))throw new AppError('A senha não pode conter o seu usuário.');
 let standard:string|null=null;try{standard=defaultPassword();}catch{standard=null;}
 if(standard&&password===standard)throw new AppError('Escolha uma senha diferente da senha padrão de primeiro acesso.');
 return password;
}
export function checkTemporaryPassword(password:unknown){
 if(typeof password!=='string'||password.length<6||password.length>128)throw new AppError('A senha provisória deve ter de 6 a 128 caracteres.');
 return password;
}

const tokenId=(token:string)=>createHash('sha256').update(token).digest('hex');

export async function createSession(memberId:string,executor:Executor=db()){
 const token=randomBytes(32).toString('base64url'),t=now();
 await executor.run('INSERT INTO sessions(id,member_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)',tokenId(token),memberId,t,new Date(Date.now()+SESSION_IDLE_MS).toISOString(),t);
 return token;
}
export async function destroySession(token:string|undefined){
 if(token)await db().run('DELETE FROM sessions WHERE id=?',tokenId(token));
}

/** Membro autenticado e ativo da sessão, ou null. A autorização segue o cadastro atual. */
export async function sessionMember(token:string|undefined|null):Promise<(Member&{must_change_password:number})|null>{
 if(!token||token.length>100)return null;
 const id=tokenId(token);
 const row=await db().first("SELECT s.created_at session_created,s.expires_at,s.last_seen_at,m.id,m.username,m.email,m.name,m.profile,m.active,m.must_change_password FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.id=?",id);
 if(!row)return null;
 const t=Date.now();
 if(!row.active||!profiles.includes(row.profile)||row.expires_at<new Date(t).toISOString()||Date.parse(row.session_created)+SESSION_MAX_MS<t){
  await db().run('DELETE FROM sessions WHERE id=?',id);return null;
 }
 // Renova a validade por inatividade no máximo a cada 5 minutos.
 if(Date.parse(row.last_seen_at)<t-300_000)await db().run('UPDATE sessions SET last_seen_at=?,expires_at=? WHERE id=?',new Date(t).toISOString(),new Date(t+SESSION_IDLE_MS).toISOString(),id);
 const {session_created:_c,expires_at:_e,last_seen_at:_l,...member}=row;void _c;void _e;void _l;
 return member as Member&{must_change_password:number};
}

const INVALID='Usuário ou senha inválidos.';
export async function login(usernameInput:unknown,passwordInput:unknown){
 const username=String(usernameInput??'').trim().toLowerCase().slice(0,60),password=typeof passwordInput==='string'?passwordInput.slice(0,200):'';
 if(!username||!password)throw new AppError('Informe usuário e senha.');
 const member=await db().first('SELECT id,username,name,profile,active,password_hash,must_change_password,password_changed_at,failed_attempts,locked_until FROM members WHERE username=?',username);
 const ok=await verifyPassword(password,member?.password_hash);
 if(!member||!member.active||!profiles.includes(member.profile))throw new AppError(INVALID,401);
 const t=new Date();
 if(member.locked_until&&member.locked_until>t.toISOString())throw new AppError('Acesso bloqueado temporariamente por tentativas inválidas. Aguarde 15 minutos ou peça ao gestor para desbloquear.',423);
 if(!ok){
  const failed=member.failed_attempts+1,lock=failed>=MAX_FAILED_ATTEMPTS;
  await db().run('UPDATE members SET failed_attempts=?,locked_until=? WHERE id=?',lock?0:failed,lock?new Date(t.valueOf()+LOCK_MS).toISOString():null,member.id);
  if(lock)throw new AppError('Acesso bloqueado temporariamente por tentativas inválidas. Aguarde 15 minutos ou peça ao gestor para desbloquear.',423);
  throw new AppError(INVALID,401);
 }
 if(member.must_change_password&&member.password_changed_at&&Date.parse(member.password_changed_at)+TEMPORARY_PASSWORD_DAYS*86400_000<t.valueOf())
  throw new AppError('A senha de primeiro acesso expirou. Peça ao gestor para redefinir sua senha.',401);
 return db().tx(async tx=>{
  await tx.run('UPDATE members SET failed_attempts=0,locked_until=NULL,last_login_at=? WHERE id=?',t.toISOString(),member.id);
  await tx.run('DELETE FROM sessions WHERE expires_at<?',t.toISOString());
  return {token:await createSession(member.id,tx),mustChangePassword:!!member.must_change_password};
 });
}

/** Troca de senha pelo próprio usuário (inclui a definição da senha definitiva no primeiro acesso). */
export async function changeOwnPassword(member:Member,currentPassword:unknown,newPassword:unknown,keepToken:string){
 const row=await db().first('SELECT id,username,name,password_hash,active,must_change_password FROM members WHERE id=?',member.id);
 if(!row?.active)throw new AppError('Seu acesso mudou. Entre novamente.',401);
 if(typeof currentPassword!=='string'||!await verifyPassword(currentPassword,row.password_hash))throw new AppError('A senha atual não confere.',400);
 const password=checkPasswordPolicy(newPassword,row.username);
 if(password===currentPassword)throw new AppError('A nova senha deve ser diferente da atual.');
 const hash=await hashPassword(password),t=now(),firstAccess=!!row.must_change_password;
 await db().tx(async tx=>{
  await tx.run('UPDATE members SET password_hash=?,must_change_password=0,password_changed_at=?,failed_attempts=0,locked_until=NULL WHERE id=?',hash,t,row.id);
  // Outras sessões abertas desta conta são encerradas.
  await tx.run('DELETE FROM sessions WHERE member_id=? AND id<>?',row.id,tokenId(keepToken));
  await tx.run("INSERT INTO audits(id,action,entity_id,author_id,author_name,created_at,detail) VALUES(?,'Senha definida pelo usuário',?,?,?,?,?)",crypto.randomUUID(),row.id,row.id,row.name,t,JSON.stringify({firstAccess}));
 });
 return {ok:true};
}
