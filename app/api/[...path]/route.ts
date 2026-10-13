import {cookies} from 'next/headers';
import {after} from 'next/server';
import {state,mutate,exportCSV} from '@/lib/service';
import {registryState,registryMutate,checklistVersions} from '@/lib/registry';
import {flowsState,flowsMutate,flowVersion} from '@/lib/flows';
import {planningState,planningMutate,planDetail,availability,validateDraft,ordersList,ordersRefs} from '@/lib/planning';
import {conditionState,conditionMutate} from '@/lib/condition';
import {AppError} from '@/lib/domain';
import {db,env} from '@/lib/db';
import {boundedJSON,sameOrigin,rateLimit,bearerMatches,clientKey} from '@/lib/security';
import {SESSION_COOKIE,SESSION_MAX_MS,sessionMember,login,destroySession,changeOwnPassword} from '@/lib/auth';
import {flushNotifications} from '@/lib/notifications';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;

function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});}
const known=['Responsável sem autorização','Agendamento sem autorização','Agendamento indisponível','Acesso sem autorização','Equipamento incompatível ou inativo','Estoque insuficiente','Quantidade excede','Recebimento excede','Quantidade deve ser inteira','Operador inativo','Estoque alterado durante conferência','Mantenha ao menos um gestor ativo','Cancelamento sem autorização','Estoque sem autorização','Combustível indisponível','Registro sem agendamento exige gestor e justificativa','Solicitante sem acesso ativo','Auditoria sem autorização','Hierarquia de local inválida','Nível do local não pode ser alterado','Dependência circular entre etapas','Versão publicada é imutável','Planejamento lançado não pode ser alterado','Liberação técnica sem autorização','Impedimento técnico não pode ser alterado','Equipamento bloqueado por impedimento técnico','Equipamento reservado no período'];
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
  const unique:Record<string,string>={requester_orgs_name_key:'Já existe uma organização com este nome.',requester_orgs_acronym_key:'Já existe uma organização com esta sigla.',locations_name_key:'Já existe um local com este nome no mesmo nível.',equipment_types_name_key:'Já existe um tipo de equipamento com este nome.',job_functions_name_key:'Já existe uma função com este nome.',occurrence_categories_name_key:'Já existe uma categoria com este nome neste tipo.',activity_types_code_key:'Já existe um tipo de atividade com este código.',activity_types_name_key:'Já existe um tipo de atividade com este nome.',checklist_templates_code_key:'Já existe um checklist com este código.',operators_member_key:'Este usuário já está vinculado a outro colaborador.'};
  if(pg.constraint_name&&unique[pg.constraint_name])return json({error:unique[pg.constraint_name]},409);
  if(pg.constraint_name==='members_email_key')return json({error:'Este e-mail já pertence a outro cadastro.'},409);
  return json({error:'Este cadastro ou lançamento já existe. Atualize a tela.'},409);
 }
 if(pg?.code==='23503')return json({error:'Um item vinculado não existe mais. Atualize a tela e confira a seleção.'},409);
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
 if(path==='health'){
  // Diagnóstico público mínimo: só a categoria da falha, nunca a mensagem ou credenciais.
  try{await db().first('SELECT 1 ok');return json({ok:true});}
  catch(e){const x=e as {code?:string;message?:string};const reason=/tenant or user not found/i.test(x.message||'')?'pooler_tenant':/password authentication/i.test(x.message||'')?'auth':String(x.code||'unknown').slice(0,40);return json({ok:false,reason},503);}
 }
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
 if(path==='registry'){await rateLimit(member.id,'read');return json(await registryState(member));}
 if(path==='registry/checklist-versions'){await rateLimit(member.id,'read');return json(await checklistVersions(member,url.searchParams.get('id')||''));}
 if(path==='flows'){await rateLimit(member.id,'read');return json(await flowsState(member));}
 if(path==='flows/version'){await rateLimit(member.id,'read');return json(await flowVersion(member,url.searchParams.get('id')||''));}
 if(path==='planning'){await rateLimit(member.id,'read');return json(await planningState(member));}
 if(path==='planning/plan'){await rateLimit(member.id,'read');return json(await planDetail(member,url.searchParams.get('id')||''));}
 if(path==='planning/availability'){await rateLimit(member.id,'read');return json(await availability(member,url));}
 if(path==='planning/validate'){await rateLimit(member.id,'read');return json(await validateDraft(member,url.searchParams.get('id')||''));}
 if(path==='orders'){await rateLimit(member.id,'read');return json(await ordersList(member,url));}
 if(path==='orders/refs'){await rateLimit(member.id,'read');return json(await ordersRefs(member));}
 if(path==='condition'){await rateLimit(member.id,'read');return json(await conditionState(member));}
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
 // Fluxos e checklists levam várias etapas/perguntas por envio.
 const body=await boundedJSON(req,path==='flows/save'||path==='registry/checklists'||path==='planning/save'?262144:undefined);
 if(path.startsWith('registry/'))return json(await registryMutate(path,body,member));
 if(path.startsWith('flows/'))return json(await flowsMutate(path,body,member));
 if(path.startsWith('planning/'))return json(await planningMutate(path,body,member));
 if(path.startsWith('condition/'))return json(await conditionMutate(path,body,member));
 const result=await mutate(path,body,member);
 flushLater(req);
 return json(result);
}catch(e){return error(e);}}
