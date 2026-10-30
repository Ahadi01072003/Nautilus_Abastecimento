'use client';
// Financeiro: tarifas dos equipamentos recobráveis (por cliente, com vigência) e painel de
// recobráveis. Uma tarifa nunca é alterada: cada mudança é uma nova vigência (lib/finance).
import {useCallback,useEffect,useMemo,useState,FormEvent} from 'react';
import {Plus,AlertTriangle,LoaderCircle,Receipt} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Choice,Badge,Empty,Field,Toggle,fmt,post,load,type R} from './kit';

export const brl=(cents:number)=>(cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
const day=(iso:string)=>iso.split('-').reverse().join('/');

export function Rates({refreshKey}:{refreshKey?:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[form,setForm]=useState<R|null>(null),[busy,setBusy]=useState(false),[formError,setFormError]=useState('');
 const refresh=useCallback(async()=>{try{setData(await load<R>('finance/rates'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 // Vigência atual de cada equipamento e cliente (a mais recente até hoje) para destacar na lista.
 const current=useMemo(()=>{const t=today(),m=new Map<string,string>();for(const r of (data?.rates||[]) as R[]){const k=r.equipment_id+'|'+r.org_id;if(r.valid_from<=t&&(!m.has(k)||r.valid_from>(data!.rates as R[]).find(x=>x.id===m.get(k))!.valid_from))m.set(k,r.id);}return new Set(m.values());},[data]);
 async function submit(e:FormEvent){e.preventDefault();if(!form)return;setBusy(true);setFormError('');
  try{const r=await post('finance/rates',{...form,hourly:Number(String(form.hourly).replace(',','.')),hoursPerDay:Number(form.hoursPerDay)});toast.success(r.message||'Vigência cadastrada.');setForm(null);await refresh()}
  catch(err){setFormError((err as Error).message)}finally{setBusy(false)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Tarifas indisponíveis</h2><p>{error}</p></div>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 const rates=data.rates as R[];
 const preview=form?Math.round(Number(String(form.hourly||0).replace(',','.'))*100)*Number(form.hoursPerDay||0):0;
 return <section className="n-panel">
  <div className="panel-heading"><div><h2>Tarifas de recobráveis</h2><p>Valor por hora e horas por diária de cada equipamento cobrado, por cliente. Mudar um valor cria uma nova vigência: diárias já contadas mantêm o valor da época.</p></div>
   <Button onClick={()=>{setFormError('');setForm({equipmentId:'',orgId:'',hourly:'',hoursPerDay:8,validFrom:today(),active:true})}}><Plus size={16}/> Nova vigência</Button></div>
  {rates.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th>Equipamento</th><th>Cliente</th><th>Vigente a partir de</th><th>Valor por hora</th><th>Horas por diária</th><th>Valor da diária</th><th>Situação</th><th>Cadastrado por</th></tr></thead><tbody>
   {rates.map(r=><tr key={r.id} className={current.has(r.id)?'current':''}><td><b>{r.tag}</b></td><td>{r.org_name}</td><td>{day(r.valid_from)}</td><td>{brl(r.hourly_cents)}</td><td>{r.hours_per_day} h</td><td>{brl(r.hourly_cents*r.hours_per_day)}</td>
    <td>{r.active?<Badge tone="success">Cobrança ativa</Badge>:<Badge>Sem cobrança</Badge>}{current.has(r.id)&&<Badge tone="info">Vigente</Badge>}</td><td>{r.created_by_name}<small className="muted-text"> {fmt(r.created_at)}</small></td></tr>)}
  </tbody></table></div>:<Empty icon={Receipt} title="Nenhuma tarifa cadastrada" description="Cadastre o equipamento cobrado, o cliente, o valor por hora e as horas por diária."/>}
  <Dialog open={!!form} onOpenChange={v=>{if(!busy&&!v)setForm(null)}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Nova vigência de tarifa</DialogTitle><DialogDescription>Vale a partir da data informada. A vigência anterior continua no histórico.</DialogDescription></DialogHeader>
   {form&&<form onSubmit={submit}><div className="form-grid">
    <Field label="Equipamento *"><Choice value={form.equipmentId} onChange={v=>setForm(f=>({...f,equipmentId:v}))} options={(data.equipment as R[]).filter(e=>e.active).map(e=>({value:e.id,label:`${e.tag} · ${e.description}`}))}/></Field>
    <Field label="Cliente *"><Choice value={form.orgId} onChange={v=>setForm(f=>({...f,orgId:v}))} options={(data.orgs as R[]).filter(o=>o.active).map(o=>({value:o.id,label:o.name}))}/></Field>
    <Field label="Valor por hora (R$) *"><Input required inputMode="decimal" value={form.hourly} onChange={e=>setForm(f=>({...f,hourly:e.target.value}))} placeholder="0,00"/></Field>
    <Field label="Horas por diária *" hint="De 1 a 168."><Input required type="number" min={1} max={168} step={1} value={form.hoursPerDay} onChange={e=>setForm(f=>({...f,hoursPerDay:e.target.value}))}/></Field>
    <Field label="Vigente a partir de *"><Input required type="date" value={form.validFrom} onChange={e=>setForm(f=>({...f,validFrom:e.target.value}))}/></Field>
    <Field label="Valor da diária"><Input readOnly value={Number.isFinite(preview)?brl(preview):'—'}/></Field>
    <div className="wide"><Toggle title="Cobrança ativa" description="Desligado: a partir dessa data o equipamento deixa de ser cobrado deste cliente." checked={!!form.active} onChange={v=>setForm(f=>({...f,active:v}))}/></div>
   </div>{formError&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{formError}</div>}
   <div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setForm(null)} disabled={busy}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy||!form.equipmentId||!form.orgId}>{busy&&<LoaderCircle className="animate-spin" size={16}/>} Cadastrar vigência</Button></div>
   </form>}
  </DialogContent></Dialog>
 </section>;
}
