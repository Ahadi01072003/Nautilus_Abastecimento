'use client';
// Portaria: saída de uma visita e o detalhe da visita (histórico, correção, anulação, desfazer saída, restauração).
import {useCallback,useEffect,useState,FormEvent} from 'react';
import {LoaderCircle,Pencil,Ban,Undo2,RotateCcw,AlertTriangle} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Field,fromLocalInput,toLocalInput,INPUT_MIN,INPUT_MAX,localIssue,type R} from './kit';
import {ApiError,pget,ppost,useIntent,hm,dmyhm,day,MODES,VISIT_STATUS,EVENT_NAMES,RETRO_MINUTES,ReopenDialog,PersonPicker,QuickPerson} from './portaria-kit';

/** Horário da movimentação: agora por padrão; outro horário abre a justificativa (obrigatória acima de 30 min de atraso). */
export function TimeChoice({custom,setCustom,value,setValue,justification,setJustification,label}:{custom:boolean,setCustom:(v:boolean)=>void,value:string,setValue:(v:string)=>void,justification:string,setJustification:(v:string)=>void,label:string}){
 const issue=localIssue(value);
 return <>
  <div className="por-time wide"><label className="inline-check"><input type="checkbox" checked={custom} onChange={e=>{setCustom(e.target.checked);if(!e.target.checked){setValue('');setJustification('')}}}/> {label} em outro horário (lançamento posterior)</label></div>
  {custom&&<>
   <Field label="Horário *"><Input required type="datetime-local" min={INPUT_MIN} max={INPUT_MAX} value={value} onChange={e=>setValue(e.target.value)} aria-invalid={!!issue}/></Field>
   <Field label="Justificativa" hint={`Obrigatória quando o horário é mais de ${RETRO_MINUTES} minutos anterior ao registro.`} wide><Textarea maxLength={1000} rows={2} value={justification} onChange={e=>setJustification(e.target.value)}/></Field>
   {issue&&<p className="form-error wide" role="alert">{issue}</p>}
  </>}
 </>;
}

/** Registrar a saída: placa de saída (veículo) e, se preciso, horário anterior com justificativa. */
export function ExitDialog({visit,onClose,onDone}:{visit:R|null,onClose:()=>void,onDone:(r:R)=>void}){
 const [plate,setPlate]=useState(''),[custom,setCustom]=useState(false),[when,setWhen]=useState(''),[why,setWhy]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),intent=useIntent();
 // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Reinicia o formulário só quando troca a visita.
 useEffect(()=>{if(visit){setPlate(visit.plateIn||'');setCustom(false);setWhen('');setWhy('');setError('')}},[visit?.id]);
 async function submit(e:FormEvent){
  e.preventDefault();if(!visit)return;setBusy(true);setError('');
  try{
   const occurredAt=custom?fromLocalInput(when):null;
   if(custom&&!occurredAt)throw new Error('Informe o horário da saída.');
   const r=await ppost('exit',{visitId:visit.id,version:visit.version,plateOut:plate||undefined,occurredAt:occurredAt||undefined,justification:why||undefined},intent.key());
   intent.renew();toast.success(r.message||'Saída registrada.');onDone(r);
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open={!!visit} onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Registrar saída</DialogTitle>
  <DialogDescription>{visit?`${visit.personName} · ${visit.companyName} · entrou às ${hm(visit.entryAt)}`:''}</DialogDescription></DialogHeader>
  {visit&&<form onSubmit={submit}><div className="form-grid">
   {visit.accessMode==='veiculo'&&<Field label="Placa na saída" hint={`Placa da entrada: ${visit.plateIn}`}><Input maxLength={8} value={plate} onChange={e=>setPlate(e.target.value.toUpperCase())}/></Field>}
   <TimeChoice custom={custom} setCustom={setCustom} value={when} setValue={setWhen} justification={why} setJustification={setWhy} label="Saída"/>
  </div>{error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Confirmar saída</Button></div></form>}
 </DialogContent></Dialog>;
}

type Mode='view'|'correct'|'annul'|'undo'|'restore';
/** Detalhe da visita com o documento completo (consulta auditada) e o histórico imutável de eventos. */
export function VisitDialog({visitId,manager,onClose,onChanged}:{visitId:string|null,manager:boolean,onClose:()=>void,onChanged:()=>void}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[mode,setMode]=useState<Mode>('view'),[form,setForm]=useState<R>({}),[why,setWhy]=useState(''),[busy,setBusy]=useState(false),[formError,setFormError]=useState('');
 const [closedReports,setClosedReports]=useState<R[]>([]),[reopen,setReopen]=useState<R|null>(null),[newPerson,setNewPerson]=useState(false),[person,setPerson]=useState<R|null>(null),intent=useIntent();
 const refresh=useCallback(async()=>{if(!visitId)return;try{setData(await pget<R>('visit?id='+encodeURIComponent(visitId)));setError('')}catch(e){setError((e as Error).message)}},[visitId]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor ao abrir.
 useEffect(()=>{setData(null);setMode('view');setWhy('');setFormError('');setClosedReports([]);setPerson(null);void refresh()},[refresh]);
 const v=data?.visit as R|undefined;
 function startCorrect(){
  if(!v)return;
  setForm({purpose:v.purpose,notes:v.notes||'',accessMode:v.accessMode,plateIn:v.plateIn||'',plateOut:v.plateOut||'',entryAt:toLocalInput(v.entryAt),exitAt:toLocalInput(v.exitAt)});
  setPerson(null);setWhy('');setFormError('');setClosedReports([]);setMode('correct');
 }
 async function send(path:string,body:R,done:string){
  setBusy(true);setFormError('');setClosedReports([]);
  try{await ppost(path,{visitId:v!.id,version:v!.version,...body},intent.key());intent.renew();toast.success(done);setMode('view');setWhy('');await refresh();onChanged()}
  catch(e){
   if(e instanceof ApiError&&e.code==='REPORT_CLOSED')setClosedReports((e.data?.reports as R[])||[]);
   setFormError((e as Error).message);
  }finally{setBusy(false)}
 }
 function submitCorrect(e:FormEvent){
  e.preventDefault();if(!v)return;
  const changes:R={};
  for(const k of ['purpose','notes','accessMode'])if(form[k]!==(v[k]??''))changes[k]=form[k];
  if(form.plateIn!==(v.plateIn||''))changes.plateIn=form.plateIn||null;
  if(v.status==='finalizada'&&form.plateOut!==(v.plateOut||''))changes.plateOut=form.plateOut||null;
  const entry=fromLocalInput(form.entryAt);if(!entry){setFormError('Informe o horário da entrada.');return;}
  if(entry!==v.entryAt)changes.entryAt=entry;
  if(v.status==='finalizada'){const exit=fromLocalInput(form.exitAt);if(!exit){setFormError('Informe o horário da saída.');return;}if(exit!==v.exitAt)changes.exitAt=exit;}
  if(person)changes.personId=person.id;
  if(!Object.keys(changes).length){setFormError('Nada foi alterado.');return;}
  void send('visit/correct',{changes,justification:why},'Visita corrigida.');
 }
 const status=v?VISIT_STATUS[v.status]:null;
 return <Dialog open={!!visitId} onOpenChange={x=>{if(!busy&&!x)onClose()}}><DialogContent className="n-dialog por-visit"><DialogHeader><DialogTitle>{v?v.personName:'Visita'}</DialogTitle>
  <DialogDescription>{v?`${v.companyName} · ${v.documentType} ${v.document}`:'Carregando…'}</DialogDescription></DialogHeader>
  {error&&<div className="error-panel"><AlertTriangle/><p>{error}</p></div>}
  {!data&&!error&&<Skeleton className="h-40 rounded-xl"/>}
  {v&&<>
   <div className="por-facts">
    <div><span>Situação</span><b>{status&&<Badge tone={status[1]}>{status[0]}</Badge>}</b></div>
    <div><span>Entrada</span><b>{dmyhm(v.entryAt)}</b><small>por {v.entryByName}{v.retroactive?' · lançamento posterior':''}</small></div>
    <div><span>Saída</span><b>{v.exitAt?dmyhm(v.exitAt):'—'}</b>{v.exitByName&&<small>por {v.exitByName}</small>}</div>
    <div><span>Acesso</span><b>{MODES[v.accessMode]}{v.plateIn?` · ${v.plateIn}`:''}{v.plateOut&&v.plateOut!==v.plateIn?` → ${v.plateOut}`:''}</b></div>
    <div className="wide"><span>Objetivo</span><b>{v.purpose}</b>{v.notes&&<small>{v.notes}</small>}</div>
   </div>
   {mode==='view'&&<>
    <div className="step-actions por-actions">
     {v.status!=='anulada'&&<Button variant="outline" onClick={startCorrect}><Pencil size={15}/> Corrigir</Button>}
     {v.status==='finalizada'&&<Button variant="outline" onClick={()=>{setWhy('');setFormError('');setClosedReports([]);setMode('undo')}}><Undo2 size={15}/> Desfazer saída</Button>}
     {v.status!=='anulada'&&<Button variant="outline" onClick={()=>{setWhy('');setFormError('');setClosedReports([]);setMode('annul')}}><Ban size={15}/> Anular</Button>}
     {v.status==='anulada'&&manager&&<Button variant="outline" onClick={()=>{setWhy('');setFormError('');setClosedReports([]);setMode('restore')}}><RotateCcw size={15}/> Restaurar</Button>}
    </div>
    <h4 className="por-h">Histórico</h4>
    <ol className="por-events">{(data!.events as R[]).map((e,i)=><li key={i}><b>{EVENT_NAMES[e.kind]||e.kind}</b><span>{dmyhm(e.occurredAt)} · registrado {dmyhm(e.registeredAt)} por {e.actorName}</span>{e.justification&&<small>“{e.justification}”</small>}</li>)}</ol>
    <p className="muted-text">Relatórios ligados: {(data!.reports as R[]).map(r=>`${day(r.date)} (${r.role}${r.revision?`, revisão ${r.revision}`:r.status==='aberto'?', aberto':''})`).join(' · ')}</p>
   </>}
   {mode==='correct'&&<form onSubmit={submitCorrect}><div className="form-grid">
    <Field label="Visitante" hint="Troque só se o registro foi feito para a pessoa errada." wide>
     <PersonPicker value={person||{name:v.personName,companyName:v.companyName,documentType:v.documentType,documentMasked:v.documentMasked}} onChange={p=>setPerson(p)} onNew={()=>setNewPerson(true)}/></Field>
    <Field label="Objetivo *" wide><Input required maxLength={200} value={form.purpose} onChange={e=>setForm(f=>({...f,purpose:e.target.value}))}/></Field>
    <Field label="Meio de acesso"><Choice value={form.accessMode} onChange={x=>setForm(f=>({...f,accessMode:x}))} options={Object.entries(MODES).map(([value,label])=>({value,label}))}/></Field>
    {form.accessMode==='veiculo'&&<Field label="Placa de entrada *"><Input maxLength={8} value={form.plateIn} onChange={e=>setForm(f=>({...f,plateIn:e.target.value.toUpperCase()}))}/></Field>}
    <Field label="Entrada *"><Input required type="datetime-local" min={INPUT_MIN} max={INPUT_MAX} value={form.entryAt} onChange={e=>setForm(f=>({...f,entryAt:e.target.value}))}/></Field>
    {v.status==='finalizada'&&<><Field label="Saída *"><Input required type="datetime-local" min={INPUT_MIN} max={INPUT_MAX} value={form.exitAt} onChange={e=>setForm(f=>({...f,exitAt:e.target.value}))}/></Field>
     {form.accessMode==='veiculo'&&<Field label="Placa de saída"><Input maxLength={8} value={form.plateOut} onChange={e=>setForm(f=>({...f,plateOut:e.target.value.toUpperCase()}))}/></Field>}</>}
    <Field label="Observações" wide><Textarea maxLength={500} rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))}/></Field>
    <Field label="Justificativa da correção *" wide><Textarea required maxLength={1000} rows={2} value={why} onChange={e=>setWhy(e.target.value)}/></Field>
   </div>
    <Closed reports={closedReports} message={formError} onReopen={setReopen}/>
    <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>setMode('view')}>Voltar</Button><Button type="submit" disabled={busy||!why.trim()}>{busy&&<LoaderCircle className="spin" size={16}/>} Salvar correção</Button></div></form>}
   {(mode==='annul'||mode==='undo'||mode==='restore')&&<form onSubmit={e=>{e.preventDefault();void send(mode==='annul'?'visit/annul':mode==='undo'?'visit/undo-exit':'visit/restore',{justification:why},mode==='annul'?'Visita anulada.':mode==='undo'?'Saída desfeita.':'Visita restaurada.')}}>
    <p className="muted-text">{mode==='annul'?'A visita continua rastreável, sai dos totais e libera a presença sem criar saída.':mode==='undo'?'A visita volta a ficar na base, como se a saída não tivesse sido lançada.':'A visita anulada volta a valer. A pessoa não pode ter outra visita em andamento.'}</p>
    <div className="form-grid"><Field label="Justificativa *" wide><Textarea required maxLength={1000} rows={2} value={why} onChange={e=>setWhy(e.target.value)}/></Field></div>
    <Closed reports={closedReports} message={formError} onReopen={setReopen}/>
    <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>setMode('view')}>Voltar</Button><Button type="submit" disabled={busy||!why.trim()}>{busy&&<LoaderCircle className="spin" size={16}/>} Confirmar</Button></div></form>}
  </>}
  <ReopenDialog report={reopen as {id:string,date:string}|null} onClose={()=>setReopen(null)} onDone={()=>{setReopen(null);setClosedReports([]);setFormError('');onChanged()}}/>
  <QuickPerson open={newPerson} onClose={()=>setNewPerson(false)} onCreated={p=>{setNewPerson(false);setPerson({...p,present:false})}}/>
 </DialogContent></Dialog>;
}

function Closed({reports,message,onReopen}:{reports:R[],message:string,onReopen:(r:R)=>void}){
 if(!message)return null;
 return <div className="form-error" role="alert"><p>{message}</p>{reports.map(r=><Button key={r.id} type="button" size="sm" variant="outline" onClick={()=>onReopen(r)}>Reabrir relatório de {day(r.date)}</Button>)}</div>;
}
