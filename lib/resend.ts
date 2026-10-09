import {env} from './db';
import {AppError,email} from './domain';

export type EmailSetup={provider:'Resend';ready:boolean;enabled:boolean;status:'missing'|'invalid'|'configured';apiKeyConfigured:boolean;senderConfigured:boolean;sender:string|null;domain:string|null;message:string};
function sender(value:string){
 if(!value||value.length>254||/[\x00-\x1f\x7f]/.test(value))return null;
 const match=value.match(/^(?:[^<>]+\s*<)?([A-Za-z0-9.!#$%&'*+\/=\?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>?$/);
 if(!match||value.includes('<')!==value.endsWith('>'))return null;
 const domain=match[1].split('@')[1].toLowerCase();
 if(domain==='resend.dev'||domain.endsWith('.resend.dev'))return null;
 return {value,domain};
}
export function emailSetup():EmailSetup{
 const cfg=env(),key=cfg.RESEND_API_KEY||'',from=cfg.EMAIL_FROM||'',parsed=sender(from);
 const apiKeyConfigured=!!key,senderConfigured=!!from,missing=!key||!from;
 const ready=!missing&&/^re_[A-Za-z0-9_-]{16,200}$/.test(key)&&!!parsed;
 return {provider:'Resend',ready,enabled:cfg.EMAIL_ENABLED==='true',status:missing?'missing':ready?'configured':'invalid',apiKeyConfigured,senderConfigured,sender:parsed?.value||null,domain:parsed?.domain||null,message:missing?'Falta configurar a chave privada e o remetente.':ready?'Configuração preenchida. Confirme o domínio no Resend e teste a entrega.':'Revise o formato da chave e do remetente. Use um domínio próprio verificado, sem resend.dev.'};
}
/** Envio individual; não retorna resposta bruta nem recebe credenciais do navegador. */
export async function sendResendEmail(to:string,subject:string,body:string,idempotencyKey:string){
 const setup=emailSetup();if(!setup.ready)throw new AppError('Configure o remetente e a chave privada do Resend antes de enviar.',409);
 if(!/^[A-Za-z0-9_:./-]{1,256}$/.test(idempotencyKey))throw new AppError('Identificador de envio inválido.');
 const recipient=email(to),cfg=env();
 try{
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${cfg.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({from:setup.sender,to:[recipient],subject,text:body}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('provider');
  const data:unknown=await response.json();
  if(!data||typeof data!=='object'||!('id' in data)||typeof data.id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(data.id))throw new Error('provider');
  return {accepted:true as const};
 }catch{throw new AppError('O serviço de envio não confirmou a solicitação. Verifique a configuração e tente novamente.',502);}
}
