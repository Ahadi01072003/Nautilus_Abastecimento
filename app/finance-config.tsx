'use client';
// Financeiro › Configurações: clientes habilitados para recobráveis, margem e impostos por cliente
// (cada mudança é uma nova vigência; solicitações guardam os percentuais da época) e fornecedores.
import {Fragment,useCallback,useEffect,useState,FormEvent} from 'react';
import {Plus,AlertTriangle,LoaderCircle,Building2,Pencil,History,Truck} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Badge,Empty,Field,Toggle,fmt,post,load,type R} from './kit';

const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
const day=(iso:string)=>iso.split('-').reverse().join('/');
const pct=(bp:number)=>(bp/100).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%';
const typed=(bp?:number|null)=>bp==null?'':(bp/100).toLocaleString('pt-BR',{maximumFractionDigits:2});

export default function FinanceConfig({refreshKey}:{refreshKey?:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[rate,setRate]=useState<R|null>(null),[supplier,setSupplier]=useState<R|null>(null),[open,setOpen]=useState(''),[busy,setBusy]=useState(false),[formError,setFormError]=useState('');
 const refresh=useCallback(async()=>{try{setData(await load<R>('finance/config'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 async function enable(c:R,enabled:boolean){try{const r=await post('finance/config/client',{orgId:c.orgId,enabled});toast.success(r.message);await refresh()}catch(e){toast.error((e as Error).message)}}
 async function submit(e:FormEvent,path:string,body:R,close:()=>void){e.preventDefault();setBusy(true);setFormError('');
  try{const r=await post(path,body);toast.success(r.message);close();await refresh()}catch(err){setFormError((err as Error).message)}finally{setBusy(false)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Configurações indisponíveis</h2><p>{error}</p></div>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 const clients=data.clients as R[],suppliers=data.suppliers as R[],suggestion=data.suggestion as R|null;
 // Cliente sem vigência: sugere a vigência cadastrada mais recentemente (de qualquer cliente).
 const newRate=(c:R)=>{setFormError('');const base=c.current||suggestion;setRate({orgId:c.orgId,name:c.name,margin:typed(base?.marginBp),tax:typed(base?.taxBp),validFrom:today(),suggested:!c.current&&!!suggestion})};
 return <>
  <section className="n-panel">
   <div className="panel-heading"><div><h2>Clientes</h2><p>Só os clientes habilitados aparecem nas solicitações novas. Mudar margem ou impostos cria uma nova vigência: solicitações já criadas mantêm os percentuais da época.</p></div></div>
   {clients.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th>Cliente</th><th>Habilitado</th><th>Margem</th><th>Impostos</th><th>Vigente desde</th><th></th></tr></thead><tbody>
    {clients.map(c=><Fragment key={c.orgId}><tr className={c.enabled?'current':''}><td><b>{c.acronym}</b> · {c.name}{!c.active&&<Badge>Inativo no cadastro</Badge>}</td>
     <td><Switch checked={c.enabled} aria-label={`Habilitar ${c.name} para recobráveis`} onCheckedChange={v=>void enable(c,v)}/></td>
     <td>{c.current?pct(c.current.marginBp):'—'}</td><td>{c.current?pct(c.current.taxBp):'—'}</td><td>{c.current?day(c.current.validFrom):<span className="warn-text">Sem vigência</span>}</td>
     <td className="rq-row-actions"><Button size="sm" variant="outline" onClick={()=>newRate(c)}><Plus size={14}/> Nova vigência</Button>{c.history.length>0&&<Button size="sm" variant="ghost" onClick={()=>setOpen(open===c.orgId?'':c.orgId)}><History size={14}/> Histórico ({c.history.length})</Button>}</td></tr>
     {open===c.orgId&&<tr className="fin-detail"><td colSpan={6}><ul>{(c.history as R[]).map(h=><li key={h.id}><span>{day(h.validFrom)}</span><span>margem {pct(h.marginBp)} · impostos {pct(h.taxBp)}</span><span className="muted-text">{h.createdByName} · {fmt(h.createdAt)}</span></li>)}</ul></td></tr>}</Fragment>)}
   </tbody></table></div>:<Empty icon={Building2} title="Nenhum cliente no seu acesso" description="Cadastre as organizações em Cadastros gerais › Solicitantes e clientes."/>}
  </section>

  <section className="n-panel">
   <div className="panel-heading"><div><h2>Fornecedores</h2><p>Usados nas cotações. Fornecedor inativo não aparece em cotações novas; as antigas continuam com o nome.</p></div>
    <Button onClick={()=>{setFormError('');setSupplier({name:'',cnpj:'',contact:'',active:true})}}><Plus size={16}/> Cadastrar fornecedor</Button></div>
   {suppliers.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th>Fornecedor</th><th>CNPJ</th><th>Contato</th><th>Situação</th><th></th></tr></thead><tbody>
    {suppliers.map(s=><tr key={s.id}><td><b>{s.name}</b></td><td>{s.cnpj||'—'}</td><td>{s.contact||'—'}</td><td>{s.active?<Badge tone="success">Ativo</Badge>:<Badge>Inativo</Badge>}</td>
     <td className="rq-row-actions"><Button size="sm" variant="ghost" onClick={()=>{setFormError('');setSupplier({...s,active:!!s.active})}}><Pencil size={14}/> Editar</Button></td></tr>)}
   </tbody></table></div>:<Empty icon={Truck} title="Nenhum fornecedor" description="Cadastre aqui ou direto na cotação, com “cadastrar na hora”."/>}
  </section>

  <Dialog open={!!rate} onOpenChange={v=>{if(!busy&&!v)setRate(null)}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Nova vigência · {rate?.name}</DialogTitle><DialogDescription>{rate?.suggested?'Sugestão: a vigência cadastrada mais recentemente. Confira antes de salvar.':'Vale a partir da data informada. A anterior continua no histórico.'}</DialogDescription></DialogHeader>
   {rate&&<form onSubmit={e=>void submit(e,'finance/config/rate',{orgId:rate.orgId,margin:rate.margin,tax:rate.tax,validFrom:rate.validFrom},()=>setRate(null))}><div className="form-grid">
    <Field label="Margem OCP (%) *" hint="De 0 a 99,99%."><Input required inputMode="decimal" value={rate.margin} onChange={e=>setRate(r=>({...r,margin:e.target.value}))}/></Field>
    <Field label="Impostos (%) *" hint="De 0 a 99,99%."><Input required inputMode="decimal" value={rate.tax} onChange={e=>setRate(r=>({...r,tax:e.target.value}))}/></Field>
    <Field label="Vigente a partir de *"><Input required type="date" value={rate.validFrom} onChange={e=>setRate(r=>({...r,validFrom:e.target.value}))}/></Field>
   </div>{formError&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{formError}</div>}
   <div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setRate(null)} disabled={busy}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy}>{busy&&<LoaderCircle className="animate-spin" size={16}/>} Cadastrar vigência</Button></div></form>}
  </DialogContent></Dialog>

  <Dialog open={!!supplier} onOpenChange={v=>{if(!busy&&!v)setSupplier(null)}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>{supplier?.id?`Editar ${supplier.name}`:'Cadastrar fornecedor'}</DialogTitle><DialogDescription>O nome não se repete (sem diferenciar maiúsculas).</DialogDescription></DialogHeader>
   {supplier&&<form onSubmit={e=>void submit(e,'finance/suppliers',{id:supplier.id,name:supplier.name,cnpj:supplier.cnpj,contact:supplier.contact,active:supplier.active},()=>setSupplier(null))}><div className="form-grid">
    <Field label="Nome *" wide><Input required maxLength={160} value={supplier.name} onChange={e=>setSupplier(s=>({...s,name:e.target.value}))}/></Field>
    <Field label="CNPJ"><Input maxLength={20} value={supplier.cnpj||''} onChange={e=>setSupplier(s=>({...s,cnpj:e.target.value}))}/></Field>
    <Field label="Contato"><Input maxLength={200} value={supplier.contact||''} onChange={e=>setSupplier(s=>({...s,contact:e.target.value}))} placeholder="Nome, e-mail ou telefone"/></Field>
    <div className="wide"><Toggle title="Ativo" description="Desligado: não aparece em cotações novas." checked={!!supplier.active} onChange={v=>setSupplier(s=>({...s,active:v}))}/></div>
   </div>{formError&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{formError}</div>}
   <div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setSupplier(null)} disabled={busy}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy||!supplier.name.trim()}>{busy&&<LoaderCircle className="animate-spin" size={16}/>} Salvar</Button></div></form>}
  </DialogContent></Dialog>
 </>;
}
