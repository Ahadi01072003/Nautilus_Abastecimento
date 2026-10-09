'use client';
import {useState,type FormEvent,type ReactNode} from 'react';
import {Compass,Anchor,LoaderCircle,AlertTriangle,Eye,EyeOff,KeyRound,LogOut,Check,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import './nautilus.css';

async function postJSON(path:string,body:unknown){
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Não foi possível concluir. Tente novamente.');
 return data;
}
export async function signOut(){
 try{await postJSON('/api/auth/logout',{});}finally{window.location.reload();}
}

function Shell({children}:{children:ReactNode}){
 return <main className="auth-shell">
  <section className="auth-brand" aria-hidden="true">
   <div className="brand"><Compass size={38} strokeWidth={1.5}/><div><b>NAUTILUS</b><small>ABASTECIMENTOS</small></div></div>
   <div className="auth-brand-copy"><span>BASE AÇU</span><h2>Solicitações, agenda, consumo e estoque em um só lugar.</h2></div>
   <div className="sidebar-signature"><Anchor size={19}/><span>Precisão. Profundidade.<br/><b>Clareza.</b></span></div>
  </section>
  <section className="auth-panel">{children}</section>
 </main>;
}
function PasswordInput({id,value,onChange,autoComplete,label}:{id:string,value:string,onChange:(v:string)=>void,autoComplete:string,label:string}){
 const [visible,setVisible]=useState(false);
 return <div className="auth-password"><Input id={id} type={visible?'text':'password'} required autoComplete={autoComplete} value={value} onChange={e=>onChange(e.target.value)} maxLength={128}/><button type="button" onClick={()=>setVisible(v=>!v)} aria-label={visible?`Ocultar ${label}`:`Mostrar ${label}`}>{visible?<EyeOff size={17}/>:<Eye size={17}/>}</button></div>;
}
function ErrorBox({message}:{message:string}){return message?<div className="form-error" role="alert"><AlertTriangle size={17}/>{message}</div>:null;}

export function LoginScreen({unavailable=false}:{unavailable?:boolean}){
 const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(unavailable?'O serviço está temporariamente indisponível. Tente novamente em instantes.':'');
 async function submit(e:FormEvent){
  e.preventDefault();if(busy)return;setBusy(true);setError('');
  try{await postJSON('/api/auth/login',{username,password});window.location.reload();}
  catch(err){setError(err instanceof Error?err.message:'Não foi possível entrar.');setPassword('');setBusy(false);}
 }
 return <Shell><form className="auth-card" onSubmit={submit}>
  <div className="modal-eyebrow"><Compass size={16}/> NAUTILUS · ACESSO</div>
  <h1>Entrar</h1>
  <p>Use o usuário criado pelo gestor. No primeiro acesso, entre com a senha padrão informada pela equipe e defina sua senha definitiva.</p>
  <div className="n-field"><label htmlFor="login-user">Usuário</label><Input id="login-user" required autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" placeholder="ex.: nome.sobrenome" value={username} onChange={e=>setUsername(e.target.value)} maxLength={60}/></div>
  <div className="n-field"><label htmlFor="login-password">Senha</label><PasswordInput id="login-password" label="senha" autoComplete="current-password" value={password} onChange={setPassword}/></div>
  <ErrorBox message={error}/>
  <Button type="submit" className="primary-action auth-submit" disabled={busy||!username||!password}>{busy?<><LoaderCircle className="animate-spin" size={16}/> Entrando…</>:'Entrar'}</Button>
  <small className="auth-help">Esqueceu a senha ou o acesso foi bloqueado? Peça ao gestor para redefinir ou desbloquear seu usuário.</small>
 </form></Shell>;
}

export const passwordRules=(password:string,username:string)=>[
 {ok:password.length>=8,label:'Pelo menos 8 caracteres'},
 {ok:/[A-Za-zÀ-ÿ]/.test(password)&&/\d/.test(password),label:'Letras e números'},
 {ok:!!password&&!password.toLowerCase().includes(username.toLowerCase()),label:'Não contém o seu usuário'},
];
export function PasswordForm({username,onDone,firstAccess=false,onCancel}:{username:string,onDone:()=>void,firstAccess?:boolean,onCancel?:()=>void}){
 const [current,setCurrent]=useState(''),[next,setNext]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const rules=passwordRules(next,username),valid=rules.every(r=>r.ok)&&next===confirm;
 async function submit(e:FormEvent){
  e.preventDefault();if(busy||!valid)return;setBusy(true);setError('');
  try{await postJSON('/api/auth/password',{currentPassword:current,newPassword:next});onDone();}
  catch(err){setError(err instanceof Error?err.message:'Não foi possível alterar a senha.');setBusy(false);}
 }
 return <form className="auth-form" onSubmit={submit}>
  <div className="n-field"><label htmlFor="pw-current">{firstAccess?'Senha de primeiro acesso':'Senha atual'}</label><PasswordInput id="pw-current" label="senha atual" autoComplete="current-password" value={current} onChange={setCurrent}/></div>
  <div className="n-field"><label htmlFor="pw-new">Nova senha definitiva</label><PasswordInput id="pw-new" label="nova senha" autoComplete="new-password" value={next} onChange={setNext}/></div>
  <div className="n-field"><label htmlFor="pw-confirm">Confirme a nova senha</label><PasswordInput id="pw-confirm" label="confirmação da senha" autoComplete="new-password" value={confirm} onChange={setConfirm}/></div>
  <ul className="password-rules" aria-label="Requisitos da senha">{[...rules,{ok:!!next&&next===confirm,label:'Confirmação igual à nova senha'}].map(r=><li key={r.label} className={r.ok?'ok':''}>{r.ok?<Check size={14}/>:<X size={14}/>}{r.label}</li>)}</ul>
  <ErrorBox message={error}/>
  <div className="auth-actions">{onCancel&&<Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Voltar</Button>}<Button type="submit" className="primary-action auth-submit" disabled={busy||!valid||!current}>{busy?<><LoaderCircle className="animate-spin" size={16}/> Salvando…</>:firstAccess?'Definir senha e entrar':'Alterar senha'}</Button></div>
 </form>;
}

export function FirstAccessScreen({identity}:{identity:{name:string,username:string}}){
 return <Shell><div className="auth-card">
  <div className="modal-eyebrow"><KeyRound size={16}/> PRIMEIRO ACESSO</div>
  <h1>Olá, {identity.name.split(' ')[0]}</h1>
  <p>Para proteger seus registros, defina agora a sua senha definitiva. Ela é pessoal: não compartilhe com outras pessoas. Usuário: <b>{identity.username}</b></p>
  <PasswordForm username={identity.username} firstAccess onDone={()=>window.location.reload()}/>
  <button type="button" className="text-action auth-signout" onClick={()=>void signOut()}><LogOut size={14}/> Sair e entrar com outro usuário</button>
 </div></Shell>;
}
