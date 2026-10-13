'use client';
// Condição técnica dos equipamentos: impedimentos ativos, compromissos afetados,
// registro de impedimento e liberação técnica (com justificativa e evidência).
import {useCallback,useEffect,useState,FormEvent} from 'react';
import {Lock,ShieldCheck,AlertTriangle,Plus,History,LoaderCircle} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,fmt,post,load,type R} from './kit';

export default function Condition({equipment,refreshKey}:{equipment:R[],refreshKey:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[opening,setOpening]=useState<R|null>(null),[releasing,setReleasing]=useState<R|null>(null),[saving,setSaving]=useState(false),[formError,setFormError]=useState('');
 const refresh=useCallback(async()=>{try{setData(await load<R>('condition'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 async function submit(e:FormEvent,path:string,body:R,done:()=>void){e.preventDefault();setSaving(true);setFormError('');try{const r=await post(path,body);toast.success(r.message||'Registrado.');done();await refresh()}catch(err){setFormError((err as Error).message)}finally{setSaving(false)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Condição técnica indisponível</h2><p>{error}</p></div>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 return <>
  <section className="n-panel"><div className="panel-heading"><div><h2>Impedimentos técnicos ativos</h2><p>Equipamento com impedimento não pode ser reservado, lançado ou iniciado em nenhum módulo. Reservas existentes continuam visíveis para substituição ou reprogramação.</p></div>{data.canOpen&&<Button onClick={()=>{setFormError('');setOpening({equipmentId:'',reason:''})}}><Plus size={16}/> Registrar impedimento</Button>}</div>
   {data.open.length?<ul className="impediment-list">{data.open.map((i:R)=><li key={i.id}><Lock size={18}/><div><b>{i.tag} · {i.kind==='nc_critica'?'NC crítica':'Impedimento registrado'}</b><span>{i.reason}</span><small>Desde {fmt(i.opened_at)} · {i.opened_by_name}</small>{data.affected.filter((x:R)=>x.equipment_id===i.equipment_id).map((x:R,k:number)=><small key={k} className="danger-text">Compromisso afetado: {x.label}</small>)}</div>{data.canRelease?<Button variant="outline" onClick={()=>{setFormError('');setReleasing({...i,reason:'',evidence:''})}}><ShieldCheck size={16}/> Liberação técnica</Button>:<Badge tone="danger">Aguardando liberação técnica</Badge>}</li>)}</ul>:<Empty icon={ShieldCheck} title="Nenhum impedimento ativo" description="Todos os equipamentos estão tecnicamente aptos. Disponibilidade de agenda é verificada no planejamento."/>}
  </section>
  {data.history.length>0&&<section className="n-panel"><div className="panel-heading"><div><h2>Liberações recentes</h2><p>Histórico preservado: o impedimento original nunca é apagado.</p></div><History size={20}/></div><ul className="impediment-list released">{data.history.map((i:R)=><li key={i.id}><ShieldCheck size={18}/><div><b>{i.tag} · {i.reason}</b><span>Liberado por {i.released_by_name} em {fmt(i.released_at)}: {i.release_reason}</span><small>Evidência: {i.release_evidence}</small></div></li>)}</ul></section>}

  <Dialog open={!!opening} onOpenChange={v=>{if(!saving&&!v)setOpening(null)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Lock size={16}/> CONDIÇÃO TÉCNICA</div><DialogTitle>Registrar impedimento</DialogTitle><DialogDescription>O equipamento fica bloqueado em todo o sistema, na hora, até a liberação técnica. Reservas já feitas passam a aparecer como afetadas.</DialogDescription></DialogHeader>
   {opening&&<form onSubmit={e=>void submit(e,'condition/open',opening,()=>setOpening(null))}><div className="form-grid"><Field label="Equipamento *" wide><Choice value={opening.equipmentId} onChange={v=>setOpening(o=>o&&{...o,equipmentId:v})} options={equipment.filter(e=>e.active).map(e=>({value:e.id,label:`${e.tag} · ${e.description}`}))}/></Field><Field label="Motivo *" wide><Textarea required maxLength={500} value={opening.reason} onChange={e=>setOpening(o=>o&&{...o,reason:e.target.value})} placeholder="Ex.: vazamento hidráulico identificado na inspeção"/></Field></div>{formError&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{formError}</div>}<div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setOpening(null)}>Voltar</Button><Button type="submit" className="primary-action" disabled={saving||!opening.equipmentId}>{saving?<LoaderCircle className="animate-spin" size={16}/>:<Lock size={16}/>} Bloquear equipamento</Button></div></form>}
  </DialogContent></Dialog>
  <Dialog open={!!releasing} onOpenChange={v=>{if(!saving&&!v)setReleasing(null)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><ShieldCheck size={16}/> LIBERAÇÃO TÉCNICA</div><DialogTitle>{releasing?.tag}: {releasing?.reason}</DialogTitle><DialogDescription>Libera somente este impedimento. Se houver outros ativos, o equipamento continua bloqueado. Etapas paradas não reiniciam sozinhas.</DialogDescription></DialogHeader>
   {releasing&&<form onSubmit={e=>void submit(e,'condition/release',{id:releasing.id,reason:releasing.reason,evidence:releasing.evidence},()=>setReleasing(null))}><div className="form-grid"><Field label="O que foi feito *" wide><Textarea required maxLength={1200} value={releasing.reason} onChange={e=>setReleasing(o=>o&&{...o,reason:e.target.value})} placeholder="Ex.: mangueira substituída e sistema testado"/></Field><Field label="Evidência *" wide hint="Ordem de manutenção, laudo, teste realizado, responsável técnico."><Textarea required maxLength={1200} value={releasing.evidence} onChange={e=>setReleasing(o=>o&&{...o,evidence:e.target.value})}/></Field></div>{formError&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{formError}</div>}<div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setReleasing(null)}>Voltar</Button><Button type="submit" className="primary-action" disabled={saving}>{saving?<LoaderCircle className="animate-spin" size={16}/>:<ShieldCheck size={16}/>} Confirmar liberação</Button></div></form>}
  </DialogContent></Dialog>
 </>;
}
