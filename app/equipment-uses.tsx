'use client';
// Uso de equipamentos recobráveis na OS: início e fim do uso real (com registro retroativo), as
// diárias em que cada uso entrou e, para o Financeiro, correção e conferência. Aparece só quando o
// cliente da OS tem tarifa para algum equipamento dela (lib/finance).
import {useCallback,useEffect,useState,FormEvent} from 'react';
import {Play,Square,Pencil,CheckCheck,AlertTriangle,LoaderCircle,BadgeDollarSign} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Field,fmt,post,load,fromLocalInput,toLocalInput,type R} from './kit';

type Mode={kind:'start'|'end'|'correct',use?:R};
const H=3600_000;
const localNow=()=>toLocalInput(new Date().toISOString());
const brl=(cents:number)=>(cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const hours=(a:string,b?:string|null)=>{const h=((b?Date.parse(b):Date.now())-Date.parse(a))/H;return `${(Math.round(h*10)/10).toLocaleString('pt-BR')} h`;};
const os=(n:number)=>'OS '+String(n).padStart(6,'0');
const REVIEW:Record<string,[string,string]>={a_conferir:['A conferir','warning'],conferido:['Conferido','success']};

export default function EquipmentUses({orderId,refreshKey,onChanged}:{orderId:string,refreshKey?:number,onChanged?:()=>void}){
 const [data,setData]=useState<R|null>(null),[mode,setMode]=useState<Mode|null>(null),[form,setForm]=useState<R>({}),[ask,setAsk]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const refresh=useCallback(async()=>{try{setData(await load<R>('finance/order-uses?os='+encodeURIComponent(orderId)))}catch{setData(null)}},[orderId]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 if(!data?.eligible)return null;
 const open=(m:Mode)=>{setError('');setAsk('');setMode(m);setForm({key:crypto.randomUUID(),equipmentId:data.equipment[0]?.id||'',start:m.use?toLocalInput(m.use.started_at):localNow(),end:m.kind==='end'?localNow():m.use?.ended_at?toLocalInput(m.use.ended_at):'',reason:''});};
 async function send(confirm=false){
  if(!mode)return;setBusy(true);setError('');
  const iso=(v:string)=>v?fromLocalInput(v):null;
  const body=mode.kind==='start'?{operationKey:form.key,workOrderId:orderId,equipmentId:form.equipmentId,startedAt:iso(form.start),endedAt:iso(form.end),confirm}
   :mode.kind==='end'?{id:mode.use!.id,endedAt:iso(form.end),confirm}:{id:mode.use!.id,startedAt:iso(form.start),endedAt:iso(form.end),reason:form.reason,confirm};
  try{
   const r=await post('finance/uses/'+mode.kind,body);
   if(r.confirm){setAsk(r.message);return;}
   toast.success(r.message||'Registrado.');setMode(null);await refresh();onChanged?.();
  }catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 async function confirmUse(u:R){try{const r=await post('finance/uses/confirm',{id:u.id});toast.success(r.message||'Conferido.');await refresh()}catch(e){toast.error((e as Error).message)}}
 const submit=(e:FormEvent)=>{e.preventDefault();void send(false);};
 const uses=data.uses as R[],dailies=data.dailies as R[];
 return <section className="n-panel eu-panel">
  <div className="panel-heading"><div><h2>Uso de equipamentos recobráveis</h2><p>Registre quando o equipamento começou e terminou de ser usado. Pode ser retroativo. A diária vale para todas as OS do cliente dentro do mesmo período.</p></div>
   {data.can.register&&data.equipment.length>0&&<Button onClick={()=>open({kind:'start'})}><Play size={15}/> Início de uso</Button>}</div>
  {uses.length?<ul className="eu-list">{uses.map(u=><li key={u.id}>
   <div className="eu-line"><b>{u.tag}</b><span>{fmt(u.started_at)} → {u.ended_at?fmt(u.ended_at):'em uso'}</span><span className="eu-dur">{hours(u.started_at,u.ended_at)}</span>
    {!u.ended_at&&<Badge tone="info">Em uso</Badge>}{u.end_source&&u.end_source!=='registrado'&&<Badge tone="warning">Fim automático</Badge>}{REVIEW[u.review]&&<Badge tone={REVIEW[u.review][1]}>{REVIEW[u.review][0]}</Badge>}</div>
   <div className="eu-line eu-meta"><small>Registrado por {u.started_by_name}{u.ended_by_name&&u.ended_by_name!==u.started_by_name?` · fim por ${u.ended_by_name}`:''}{u.reviewed_by_name?` · conferido por ${u.reviewed_by_name}`:''}</small>
    <span className="eu-actions">{!u.ended_at&&data.can.register&&<Button size="sm" variant="outline" onClick={()=>open({kind:'end',use:u})}><Square size={14}/> Fim de uso</Button>}
     {data.can.correct&&<Button size="sm" variant="ghost" onClick={()=>open({kind:'correct',use:u})}><Pencil size={14}/> Corrigir</Button>}
     {data.can.correct&&u.ended_at&&u.review!=='conferido'&&<Button size="sm" variant="ghost" onClick={()=>void confirmUse(u)}><CheckCheck size={14}/> Conferir</Button>}</span></div>
  </li>)}</ul>:<p className="muted-text eu-empty">Nenhum uso registrado nesta OS.</p>}
  {dailies.length>0&&<div className="eu-dailies"><h3><BadgeDollarSign size={16}/> Diárias desta OS</h3><ul>{dailies.map((d,i)=><li key={i}>
   <span>{fmt(new Date(d.start).toISOString())} → {fmt(new Date(d.end).toISOString())}</span>
   <span>{d.openerOrderId===orderId?'Aberta por esta OS':`Atendida dentro da diária da ${os(d.openerNumber)}`}</span>
   {data.can.correct&&<b>{d.openerOrderId===orderId?brl(d.valueCents):'sem cobrança'}</b>}
   {d.pending&&<Badge tone="warning">A conferir</Badge>}</li>)}</ul></div>}
  <Dialog open={!!mode} onOpenChange={v=>{if(!busy&&!v)setMode(null)}}><DialogContent className="n-dialog">
   <DialogHeader><DialogTitle>{mode?.kind==='start'?'Início de uso do equipamento':mode?.kind==='end'?`Fim de uso · ${mode.use?.tag}`:`Corrigir uso · ${mode?.use?.tag}`}</DialogTitle>
    <DialogDescription>{mode?.kind==='correct'?'A correção fica na auditoria com o motivo e o uso passa a conferido.':'Data e hora de Brasília. Pode ser anterior ao registro.'}</DialogDescription></DialogHeader>
   {mode&&<form onSubmit={submit}><div className="form-grid">
    {mode.kind==='start'&&<Field label="Equipamento *" wide><Choice value={form.equipmentId} onChange={v=>setForm(f=>({...f,equipmentId:v}))} options={(data.equipment as R[]).map(e=>({value:e.id,label:e.tag}))}/></Field>}
    {mode.kind!=='end'&&<Field label="Início *"><Input required type="datetime-local" value={form.start} onChange={e=>setForm(f=>({...f,start:e.target.value}))}/></Field>}
    <Field label={mode.kind==='end'?'Fim *':'Fim'} hint={mode.kind==='start'?'Opcional: preencha para registrar um uso que já terminou.':undefined}><Input required={mode.kind==='end'} type="datetime-local" value={form.end} onChange={e=>setForm(f=>({...f,end:e.target.value}))}/></Field>
    {mode.kind==='correct'&&<Field label="Motivo da correção *" wide><Textarea required maxLength={1200} value={form.reason} onChange={e=>setForm(f=>({...f,reason:e.target.value}))}/></Field>}
   </div>
   {ask&&<div className="notice eu-ask" role="alert"><AlertTriangle size={17}/><span>{ask}</span></div>}
   {error&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
   <div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setMode(null)} disabled={busy}>Voltar</Button>
    {ask?<Button type="button" className="primary-action" disabled={busy} onClick={()=>void send(true)}>{busy&&<LoaderCircle className="animate-spin" size={16}/>} Confirmar</Button>
     :<Button type="submit" className="primary-action" disabled={busy||(mode.kind==='start'&&!form.equipmentId)}>{busy&&<LoaderCircle className="animate-spin" size={16}/>} Registrar</Button>}</div>
   </form>}
  </DialogContent></Dialog>
 </section>;
}
