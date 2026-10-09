'use client';
import {useState} from 'react';
import {Mail,LoaderCircle,ShieldCheck} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {EmailSetup} from '@/lib/resend';

export default function EmailSetupPanel({setup}:{setup:EmailSetup}){
 const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState(''),[failed,setFailed]=useState(false),[key,setKey]=useState<string|null>(null);
 async function test(){
  if(busy)return;
  setBusy(true);setFeedback('');setFailed(false);
  const operationKey=key||crypto.randomUUID();setKey(operationKey);
  try{
   const response=await fetch('/api/emails/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationKey})});
   const data:unknown=await response.json();
   if(!data||typeof data!=='object')throw new Error('Não foi possível solicitar o teste.');
   if(!response.ok)throw new Error('error' in data&&typeof data.error==='string'?data.error:'Não foi possível solicitar o teste.');
   if(!('accepted' in data)||data.accepted!==true)throw new Error('O serviço não confirmou o teste.');
   setFeedback('message' in data&&typeof data.message==='string'?data.message:'Confira a chegada do teste na sua caixa de entrada.');setKey(null);
  }catch(e){setFailed(true);setFeedback(e instanceof Error?e.message:'Não foi possível solicitar o teste.');}
  finally{setBusy(false);}
 }
 return <section className="email-setup" aria-label="Configuração de envio por e-mail">
  <h3>Configuração de envio</h3>
  <dl className="email-checks"><div><dt>Serviço</dt><dd>{setup.provider}</dd></div><div><dt>Credencial privada</dt><dd>{setup.apiKeyConfigured?'Cadastrada':'Pendente'}</dd></div><div><dt>Remetente</dt><dd>{setup.sender||'Pendente ou inválido'}</dd></div><div><dt>Alertas automáticos</dt><dd>{setup.enabled&&setup.ready?'Ativados':'Pausados'}</dd></div></dl>
  <p>{setup.message}</p>
  <div className="notice"><ShieldCheck size={18}/><span>O teste vai somente para o e-mail cadastrado no seu usuário de gestor. As credenciais ficam protegidas no servidor.</span></div>
  <Button type="button" disabled={busy||!setup.ready} onClick={test}>{busy?<LoaderCircle size={16} className="animate-spin"/>:<Mail size={16}/>} {busy?'Solicitando teste…':'Enviar teste para minha conta'}</Button>
  {feedback&&<p role={failed?'alert':'status'}>{feedback}</p>}
 </section>;
}
