'use client';
// Portaria: peças compartilhadas pelas telas (chamadas à API com código de erro e chave de idempotência,
// formatação no fuso da base, seletor de pessoa, cadastro na hora e reabertura do relatório).
import {useEffect,useRef,useState,FormEvent} from 'react';
import {Search,UserPlus,Building2,LoaderCircle,AlertTriangle} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Field,type R} from './kit';
import './portaria.css';

export const TZ='America/Sao_Paulo';
/** Erro da API com o código estável (ex.: REPORT_CLOSED) e os dados que o servidor devolve junto. */
export class ApiError extends Error{
 constructor(message:string,public status:number,public code?:string,public field?:string,public data?:R){super(message);}
}
async function call(path:string,init?:RequestInit){
 const r=await fetch('/api/'+path,{cache:'no-store',...init});
 const j:R=await r.json().catch(()=>({}));
 if(r.status===401){window.location.reload();throw new ApiError('Sua sessão expirou. Entre novamente.',401,'AUTH_REQUIRED');}
 if(!r.ok)throw new ApiError(j.error||'Não foi possível concluir.',r.status,j.code,j.field,j.data);
 return j;
}
export const pget=<T=R,>(path:string):Promise<T>=>call('portaria/'+path) as Promise<T>;
/** Comando com chave de idempotência: o mesmo envio repetido (duplo clique, rede) devolve o mesmo resultado. */
export const ppost=(path:string,body:R,key:string):Promise<R>=>call('portaria/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,idempotencyKey:key})});
/** Uma chave por intenção do usuário: renova depois de um envio concluído. */
export function useIntent(){
 const ref=useRef<string|null>(null);
 if(ref.current==null)ref.current=crypto.randomUUID();
 return {key:()=>ref.current as string,renew:()=>{ref.current=crypto.randomUUID();}};
}
export const query=(o:Record<string,string|number|boolean|undefined|null>)=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!==undefined&&v!==null&&v!==''&&v!==false).map(([k,v])=>[k,String(v===true?1:v)])).toString();

export const hm=(iso:string|null|undefined,tz=TZ)=>iso?new Intl.DateTimeFormat('pt-BR',{timeZone:tz,hour:'2-digit',minute:'2-digit'}).format(new Date(iso)):'—';
export const dmyhm=(iso:string|null|undefined,tz=TZ)=>iso?new Intl.DateTimeFormat('pt-BR',{timeZone:tz,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso)).replace(',',''):'—';
export const day=(d:string)=>d.split('-').reverse().join('/');
export const todayLocal=(tz=TZ)=>new Intl.DateTimeFormat('sv-SE',{timeZone:tz}).format(new Date());
export const MODES:Record<string,string>={a_pe:'A pé',veiculo:'Veículo',outro:'Outro'};
export const DOC_TYPES=['CPF','RG','CNH','PASSAPORTE','OUTRO'];
export const VISIT_STATUS:Record<string,[string,string]>={em_andamento:['Na base','success'],finalizada:['Finalizada','muted'],anulada:['Anulada','danger']};
export const KIND_NAMES:Record<string,string>={original:'Original',atualizada:'Atualizada',retificada:'Retificada',parcial:'Parcial'};
export const EVENT_NAMES:Record<string,string>={entrada:'Entrada',saida:'Saída',correcao:'Correção',anulacao:'Anulação',desfazer_saida:'Saída desfeita',restauracao:'Restauração'};
export const RETRO_MINUTES=30;
/** Página de impressão do relatório (revisão emitida ou parcial). */
export const printUrl=(q:Record<string,string>)=>'/portaria/relatorio?'+new URLSearchParams(q);
/** Data escolhida em Relatórios para abrir no Registro do dia (guardada só nesta sessão do navegador). */
export const DAY_KEY='nautilus.por.date';
/** Texto do relatório fechado (REPORT_CLOSED) ou da conferência, para mostrar a causa e o caminho. */
export const isCode=(e:unknown,code:string)=>e instanceof ApiError&&e.code===code;

/** Seletor de pessoa: busca por nome, empresa ou documento completo; o documento aparece mascarado. */
export function PersonPicker({value,onChange,onNew,refreshKey}:{value:R|null,onChange:(p:R|null)=>void,onNew:()=>void,refreshKey?:number}){
 const [q,setQ]=useState(''),[rows,setRows]=useState<R[]>([]),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
 useEffect(()=>{
  if(!open)return;
  const t=setTimeout(async()=>{setBusy(true);try{setRows((await pget<R>('people?'+query({q,active:1,limit:8}))).rows)}catch{setRows([])}finally{setBusy(false)}},q?220:0);
  return()=>clearTimeout(t);
 },[q,open,refreshKey]);
 if(value)return <div className="por-picked"><div><b>{value.name}</b><small>{value.companyName} · {value.documentType} {value.documentMasked}</small></div>
  {value.present&&<Badge tone="warning">Já está na base</Badge>}<Button type="button" variant="ghost" size="sm" onClick={()=>{onChange(null);setQ('')}}>Trocar</Button></div>;
 return <div className="por-picker">
  <div className="por-search"><Search size={16} aria-hidden/><Input value={q} placeholder="Nome, empresa ou documento completo" aria-label="Buscar visitante" autoComplete="off" onFocus={()=>setOpen(true)} onChange={e=>{setQ(e.target.value);setOpen(true)}}/>{busy&&<LoaderCircle className="spin" size={16}/>}</div>
  {open&&<ul className="por-suggest" role="listbox">
   {rows.map(p=><li key={p.id}><button type="button" role="option" aria-selected={false} onClick={()=>{onChange(p);setOpen(false)}}>
    <b>{p.name}</b><small>{p.companyName} · {p.documentType} {p.documentMasked}</small>{p.present&&<Badge tone="warning">Na base</Badge>}</button></li>)}
   {!rows.length&&!busy&&<li className="por-none">Nenhum visitante encontrado{q?` para “${q}”`:''}.</li>}
   <li><button type="button" className="por-new" onClick={()=>{setOpen(false);onNew()}}><UserPlus size={15}/> Cadastrar visitante novo</button></li>
  </ul>}
 </div>;
}

/** Seletor de empresa (clientes e solicitantes entram só leitura; empresas novas nascem na hora). */
export function CompanyPicker({value,onChange}:{value:R|null,onChange:(c:R|null)=>void}){
 const [q,setQ]=useState(''),[rows,setRows]=useState<R[]>([]),[open,setOpen]=useState(false),[err,setErr]=useState(''),intent=useIntent();
 useEffect(()=>{if(!open)return;const t=setTimeout(async()=>{try{setRows((await pget<R>('companies?'+query({q}))).rows)}catch{setRows([])}},q?220:0);return()=>clearTimeout(t)},[q,open]);
 async function create(){
  setErr('');
  try{const r=await ppost('company/quick',{name:q.trim()},intent.key());intent.renew();onChange({id:r.id,name:r.name});setOpen(false);toast.success(r.message)}
  catch(e){setErr((e as Error).message)}
 }
 if(value)return <div className="por-picked"><div><b>{value.name}</b></div><Button type="button" variant="ghost" size="sm" onClick={()=>onChange(null)}>Trocar</Button></div>;
 const exact=rows.some(r=>r.name.toLowerCase()===q.trim().toLowerCase());
 return <div className="por-picker">
  <div className="por-search"><Building2 size={16} aria-hidden/><Input value={q} placeholder="Empresa do visitante" aria-label="Buscar empresa" autoComplete="off" onFocus={()=>setOpen(true)} onChange={e=>{setQ(e.target.value);setOpen(true)}}/></div>
  {open&&<ul className="por-suggest" role="listbox">
   {rows.map(c=><li key={c.id}><button type="button" role="option" aria-selected={false} onClick={()=>{onChange(c);setOpen(false)}}><b>{c.name}</b>{c.pending&&<Badge tone="warning">Aguarda revisão</Badge>}</button></li>)}
   {q.trim().length>=2&&!exact&&<li><button type="button" className="por-new" onClick={()=>void create()}><Building2 size={15}/> Cadastrar “{q.trim()}” como empresa nova</button></li>}
   {!rows.length&&q.trim().length<2&&<li className="por-none">Digite o nome da empresa.</li>}
  </ul>}
  {err&&<p className="form-error" role="alert">{err}</p>}
 </div>;
}

/** Cadastro do visitante na hora (porteiro ou gestão): fica em Cadastros › Colaboradores › Visitantes para revisão. */
export function QuickPerson({open,onClose,onCreated}:{open:boolean,onClose:()=>void,onCreated:(p:R)=>void}){
 const [form,setForm]=useState<R>({name:'',documentType:'CPF',documentNumber:''}),[company,setCompany]=useState<R|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),intent=useIntent();
 async function submit(e:FormEvent){
  e.preventDefault();setError('');
  if(!company){setError('Escolha a empresa do visitante.');return;}
  setBusy(true);
  try{
   const r=await ppost('person/quick',{name:form.name,documentType:form.documentType,documentNumber:form.documentNumber,companyId:company.id},intent.key());
   intent.renew();toast.success(r.message);setForm({name:'',documentType:'CPF',documentNumber:''});setCompany(null);onCreated(r.person);
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open={open} onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Cadastrar visitante</DialogTitle><DialogDescription>O cadastro vale na hora e a gestão revisa depois. Visitantes ficam separados dos colaboradores do Planejamento.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Nome completo *" wide><Input required maxLength={180} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></Field>
   <Field label="Tipo de documento *"><Choice value={form.documentType} onChange={v=>setForm(f=>({...f,documentType:v}))} options={DOC_TYPES.map(t=>({value:t,label:t}))}/></Field>
   <Field label="Número do documento *"><Input required maxLength={40} value={form.documentNumber} onChange={e=>setForm(f=>({...f,documentNumber:e.target.value}))}/></Field>
   <Field label="Empresa *" wide><CompanyPicker value={company} onChange={setCompany}/></Field>
  </div>{error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Cadastrar</Button></div></form>
 </DialogContent></Dialog>;
}

/** Reabertura do relatório: justificativa e motivo; nada é apagado e o próximo fechamento gera a revisão seguinte. */
export function ReopenDialog({report,onClose,onDone}:{report:{id:string,date:string}|null,onClose:()=>void,onDone:()=>void}){
 const [kind,setKind]=useState('movimento_posterior'),[why,setWhy]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),intent=useIntent();
 async function submit(e:FormEvent){
  e.preventDefault();if(!report)return;setBusy(true);setError('');
  try{const r=await ppost('report/reopen',{reportId:report.id,reasonKind:kind,justification:why},intent.key());intent.renew();toast.success(r.message);setWhy('');onDone()}
  catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open={!!report} onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Reabrir relatório {report?day(report.date):''}</DialogTitle>
  <DialogDescription>O relatório e as revisões já emitidas continuam como estão. Depois de ajustar, feche de novo para gerar a próxima revisão.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Motivo *" wide><Choice value={kind} onChange={setKind} options={[{value:'movimento_posterior',label:'Movimento posterior (entrou ou saiu alguém depois do fechamento)'},{value:'correcao',label:'Correção de dados já fechados'}]}/></Field>
   <Field label="Justificativa *" wide><Textarea required maxLength={1000} rows={3} value={why} onChange={e=>setWhy(e.target.value)}/></Field>
  </div>{error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy||!why.trim()}>{busy&&<LoaderCircle className="spin" size={16}/>} Reabrir</Button></div></form>
 </DialogContent></Dialog>;
}

/** Painel de erro de carregamento, no padrão das demais telas. */
export function LoadError({title,message}:{title:string,message:string}){return <div className="error-panel"><AlertTriangle/><h2>{title}</h2><p>{message}</p></div>;}

/** Recarrega periodicamente enquanto a tela está visível (vários porteiros registram no mesmo dia). */
export function usePolling(fn:()=>void,ms=30000){
 const ref=useRef(fn);
 useEffect(()=>{ref.current=fn});
 useEffect(()=>{const t=setInterval(()=>{if(document.visibilityState==='visible')ref.current()},ms);return()=>clearInterval(t)},[ms]);
}
