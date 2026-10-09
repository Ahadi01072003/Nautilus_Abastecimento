import {cookies} from 'next/headers';
import {after} from 'next/server';
import {state,mutate,exportCSV} from '@/lib/service';
import {AppError} from '@/lib/domain';
import {db,env} from '@/lib/db';
import {boundedJSON,sameOrigin,rateLimit,bearerMatches,clientKey} from '@/lib/security';
import {SESSION_COOKIE,SESSION_MAX_MS,sessionMember,login,destroySession,changeOwnPassword} from '@/lib/auth';
import {flushNotifications} from '@/lib/notifications';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;

function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});}
const known=['Responsável sem autorização','Agendamento sem autorização','Agendamento indisponível','Acesso sem autorização','Equipamento incompatível ou inativo','Estoque insuficiente','Quantidade excede','Recebimento excede','Quantidade deve ser inteira','Operador inativo','Estoque alterado durante conferência','Mantenha ao menos um gestor ativo','Cancelamento sem autorização','Estoque sem autorização','Combustível indisponível','Registro sem agendamento exige gestor e justificativa','Solicitante sem acesso ativo','Auditoria sem autorização'];
function error(e:unknown){
 if(e instanceof AppError)return json({error:e.message},e.status);
 const pg=e as {code?:string;message?:string;constraint_name?:string};
 const msg=pg?.message||'';
 if(pg?.code==='P0001'){const found=known.find(x=>msg.includes(x));if(found)return json({error:found==='Quantidade excede'?'Quantidade excede a capacidade máxima.':found+'.'},409);}
 if(pg?.code==='23505'){
  if(pg.constraint_name==='idx_appointment_equipment_time')return json({error:'Já existe um agendamento para esse equipamento no mesmo horário. Escolha outro horário.'},409);
  if(pg.constraint_name==='equipment_tag_key')return json({error:'Já existe um equipamento com esta TAG.'},409);
  if(pg.constraint_name==='fuels_name_key')return json({error:'Já existe um combustível com este nome.'},409);
  if(pg.constraint_name==='members_username_key')return json({error:'Este usuário já está em uso. Escolha outro.'},409);
  if(pg.constraint_name==='members_email_key')return json({error:'Este e-mail já pertence a outro cadastro.'},409);
  return json({error:'Este cadastro ou lançamento já existe. Atualize a tela.'},409);
 }
 if(pg?.code==='23514')return json({error:'Os valores informados ultrapassam os limites permitidos. Confira capacidade, mínimo e saldo.'},409);
 console.error('NAUTILUS: falha interna na operação.',pg?.code||'');
 return json({error:'Não foi possível concluir. Atualize a tela e confira o resultado antes de tentar novamente.'},500);
}
async function session(allowPendingPassword=false){
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token);
 if(!member||!token)throw new AppError('Sua sessão expirou. Entre novamente.',401);
 if(member.must_change_password&&!allowPendingPassword)throw new AppError('Defina sua senha definitiva para continuar.',403);
 return {member,token};
}
function flushLater(req:Request){
 const origin=env().APP_URL||new URL(req.url).origin;
 after(()=>flushNotifications(origin).catch(()=>console.error('NAUTILUS: fila de avisos pendente.')));
}
const route=(req:Request)=>new URL(req.url).pathname.replace(/^\/api\//,'');

export async function GET(req:Request){try{
 const url=new URL(req.url),path=route(req);
 if(path==='health'){await db().first('SELECT 1 ok');return json({ok:true});}
 if(path==='cron/notifications'){
  if(!await bearerMatches(req.headers.get('Authorization'),env().CRON_SECRET))return json({error:'Acesso negado.'},401);
  await rateLimit('cron','cron');
  await db().run('DELETE FROM sessions WHERE expires_at<?',new Date().toISOString());
  await db().run('DELETE FROM rate_limits WHERE window_start<?',Math.floor(Date.now()/60000)-10);
  await flushNotifications(env().APP_URL||url.origin);
  return json({ok:true});
 }
 const {member}=await session();
 if(path==='state'){await rateLimit(member.id,'read');const result=await state(member,Number(url.searchParams.get('page')||0));flushLater(req);return json(result);}
 if(path==='export'){await rateLimit(member.id,'export');return await exportCSV(url,member);}
 return json({error:'Página não encontrada.'},404);
}catch(e){return error(e);}}

export async function POST(req:Request){try{
 const path=route(req);
 sameOrigin(req);
 if(path==='auth/login'){
  await rateLimit(clientKey(req),'login');
  const body=await boundedJSON(req);
  const result=await login(body.username,body.password);
  (await cookies()).set(SESSION_COOKIE,result.token,{httpOnly:true,secure:new URL(req.url).protocol==='https:',sameSite:'lax',path:'/',maxAge:SESSION_MAX_MS/1000});
  return json({ok:true,mustChangePassword:result.mustChangePassword});
 }
 if(path==='auth/logout'){
  const jar=await cookies();await destroySession(jar.get(SESSION_COOKIE)?.value);jar.delete(SESSION_COOKIE);
  return json({ok:true});
 }
 if(path==='auth/password'){
  const {member,token}=await session(true);await rateLimit(member.id,'password');
  const body=await boundedJSON(req);
  return json(await changeOwnPassword(member,body.currentPassword,body.newPassword,token));
 }
 const {member}=await session();
 await rateLimit(member.id,'write');if(path==='emails/test')await rateLimit(member.id,'email_test');
 const body=await boundedJSON(req);
 const result=await mutate(path,body,member);
 flushLater(req);
 return json(result);
}catch(e){return error(e);}}
