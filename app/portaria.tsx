'use client';
// Portaria · registro do dia: entrada, saída, quem está na base, movimentos do dia e fechamento do relatório.
// Módulo isolado (sem ligação com OS, Planejamento, Operação ou Financeiro).
import {useCallback,useEffect,useState,FormEvent} from 'react';
import {LogIn,LogOut,Printer,Lock,LockOpen,RefreshCw,LoaderCircle,AlertTriangle,Users,CarFront,Footprints} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,fromLocalInput,type R} from './kit';
import {ApiError,pget,ppost,query,useIntent,usePolling,hm,dmyhm,day,MODES,KIND_NAMES,printUrl,DAY_KEY,PersonPicker,QuickPerson,ReopenDialog,LoadError} from './portaria-kit';
import {ExitDialog,VisitDialog,TimeChoice} from './portaria-visit';

const PURPOSES=['Reunião','Entrega','Visita técnica','Manutenção','Treinamento','Serviço terceirizado'];

function EntryForm({onDone}:{onDone:()=>void}){
 const [person,setPerson]=useState<R|null>(null),[purpose,setPurpose]=useState(''),[mode,setMode]=useState('a_pe'),[plate,setPlate]=useState(''),[notes,setNotes]=useState('');
 const [custom,setCustom]=useState(false),[when,setWhen]=useState(''),[why,setWhy]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[newPerson,setNewPerson]=useState(false),intent=useIntent();
 async function submit(e:FormEvent){
  e.preventDefault();setError('');
  if(!person){setError('Escolha o visitante.');return;}
  setBusy(true);
  try{
   const occurredAt=custom?fromLocalInput(when):null;
   if(custom&&!occurredAt)throw new Error('Informe o horário da entrada.');
   const r=await ppost('entry',{personId:person.id,purpose,accessMode:mode,plateIn:mode==='veiculo'?plate:undefined,notes:notes||undefined,occurredAt:occurredAt||undefined,justification:why||undefined},intent);
   intent.renew();toast.success(r.message||'Entrada registrada.');
   setPerson(null);setPurpose('');setMode('a_pe');setPlate('');setNotes('');setCustom(false);setWhen('');setWhy('');onDone();
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <section className="n-panel por-entry"><div className="panel-heading"><div><h2>Registrar entrada</h2><p>Busque pelo nome, empresa ou documento completo. Quem ainda não tem cadastro é cadastrado na hora.</p></div></div>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Visitante *" wide><PersonPicker value={person} onChange={setPerson} onNew={()=>setNewPerson(true)}/></Field>
   <Field label="Objetivo da visita *" wide><Input required maxLength={200} list="por-purposes" value={purpose} onChange={e=>setPurpose(e.target.value)} placeholder="Ex.: Reunião com a Operação"/></Field>
   <datalist id="por-purposes">{PURPOSES.map(p=><option key={p} value={p}/>)}</datalist>
   <Field label="Meio de acesso *"><Choice value={mode} onChange={setMode} options={Object.entries(MODES).map(([value,label])=>({value,label}))}/></Field>
   {mode==='veiculo'&&<Field label="Placa *"><Input required maxLength={8} value={plate} onChange={e=>setPlate(e.target.value.toUpperCase())} placeholder="ABC1D23"/></Field>}
   <Field label="Observações" wide><Textarea maxLength={500} rows={2} value={notes} onChange={e=>setNotes(e.target.value)}/></Field>
   <TimeChoice custom={custom} setCustom={setCustom} value={when} setValue={setWhen} justification={why} setJustification={setWhy} label="Entrada"/>
  </div>{error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button type="submit" disabled={busy||!person}>{busy?<LoaderCircle className="spin" size={16}/>:<LogIn size={16}/>} Registrar entrada</Button></div></form>
  <QuickPerson open={newPerson} onClose={()=>setNewPerson(false)} onCreated={p=>{setNewPerson(false);setPerson({...p,present:false})}}/>
 </section>;
}

/** Fechamento: confere os números e quem ainda está na base; a revisão emitida é imutável. */
function CloseDialog({date,report,onClose,onDone}:{date:string,report:R|null,onClose:()=>void,onDone:()=>void}){
 const [check,setCheck]=useState<R|null>(null),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[why,setWhy]=useState(''),[busy,setBusy]=useState(false),intent=useIntent(),open=useIntent();
 const load=useCallback(async()=>{
  setError('');
  try{
   let id=report?.id as string|undefined;
   if(!id){id=(await ppost('report/open',{date},open)).report.id}
   setCheck(await pget<R>('report/check?reportId='+id));
  }catch(e){setError((e as Error).message)}
 // eslint-disable-next-line react-hooks/exhaustive-deps -- open.key é estável por abertura.
 },[date,report?.id]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor ao abrir.
 useEffect(()=>{setCheck(null);setConfirm(false);setWhy('');void load()},[load]);
 async function submit(e:FormEvent){
  e.preventDefault();if(!check)return;setBusy(true);setError('');
  try{
   const r=await ppost('report/close',{reportId:check.report.id,expectedVersion:check.expectedVersion,expectedPresent:check.expectedPresent,confirmPresent:confirm,justification:why||undefined},intent);
   intent.renew();toast.success(r.message);onDone();
  }catch(err){
   setError((err as Error).message);
   if(err instanceof ApiError&&err.code==='VERSION_CONFLICT'){setCheck(null);await load()}
  }finally{setBusy(false)}
 }
 const present=(check?.present||[]) as R[],t=check?.totals as R|undefined;
 return <Dialog open onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog por-dialog"><DialogHeader><DialogTitle>Fechar relatório de {day(date)}</DialogTitle>
  <DialogDescription>Fechar gera uma revisão que não muda mais. Se alguém entrar ou sair depois, o movimento é registrado e o relatório pode ser reaberto para uma nova revisão.</DialogDescription></DialogHeader>
  {!check&&!error&&<Skeleton className="h-32 rounded-xl"/>}
  {check&&<form onSubmit={submit}>
   <div className="por-kpis"><div><span>Entradas</span><b>{t!.entradas}</b></div><div><span>Saídas</span><b>{t!.saidas}</b></div><div><span>Pessoas únicas</span><b>{t!.pessoasUnicas}</b></div><div className={present.length?'warn':''}><span>Ainda na base</span><b>{present.length}</b></div></div>
   {check.pendingAfterClose>0&&<p className="muted-text">Há {check.pendingAfterClose} movimento(s) registrados depois da última revisão. Esta revisão os inclui.</p>}
   {present.length>0&&<><h4 className="por-h">Ainda na base</h4><ul className="por-list">{present.map(v=><li key={v.id}><b>{v.personName}</b><span>{v.companyName} · entrou {dmyhm(v.entryAt)}</span></li>)}</ul>
    <label className="inline-check"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/> Confirmo fechar com {present.length} pessoa(s) ainda na base</label>
    <Field label="Justificativa *" wide><Textarea required maxLength={1000} rows={2} value={why} onChange={e=>setWhy(e.target.value)} placeholder="Ex.: equipe de turno noturno permanece na base"/></Field></>}
   {error&&<p className="form-error" role="alert">{error}</p>}
   <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button>
    <Button type="submit" disabled={busy||!check.canClose||(present.length>0&&(!confirm||!why.trim()))}>{busy?<LoaderCircle className="spin" size={16}/>:<Lock size={16}/>} Fechar relatório</Button></div></form>}
  {error&&!check&&<p className="form-error" role="alert">{error}</p>}
 </DialogContent></Dialog>;
}

export default function PortariaRegistro({refreshKey,manager}:{refreshKey?:number,manager:boolean}){
 const [date,setDate]=useState(()=>{try{const d=sessionStorage.getItem(DAY_KEY)||'';sessionStorage.removeItem(DAY_KEY);return d}catch{return ''}}),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[exit,setExit]=useState<R|null>(null),[visitId,setVisitId]=useState<string|null>(null);
 const [closing,setClosing]=useState(false),[reopen,setReopen]=useState<R|null>(null);
 const refresh=useCallback(async()=>{try{setData(await pget<R>('report?'+query({date})));setError('')}catch(e){setError((e as Error).message)}},[date]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 usePolling(()=>void refresh());
 if(error&&!data)return <LoadError title="Portaria indisponível" message={error}/>;
 if(!data)return <Skeleton className="h-96 rounded-xl"/>;
 const tz=data.timezone as string,t=data.totals as R,report=data.report as R|null,isToday=data.date===data.today,closed=report?.status==='fechado';
 const versions=(data.versions||[]) as R[],last=versions[versions.length-1];
 const present=data.present as R[],entries=data.entries as R[],exits=data.exits as R[];
 const moves=[...entries.map(v=>({v,kind:'entrada',at:v.entryAt})),...exits.map(v=>({v,kind:'saida',at:v.exitAt}))].sort((a,b)=>a.at<b.at?-1:1);
 return <div className="por-screen">
  <section className="n-panel por-head"><div className="por-head-main">
   <Field label="Data do relatório"><Input type="date" max={data.today} value={data.date} onChange={e=>setDate(e.target.value&&e.target.value<=data.today?e.target.value:'')}/></Field>
   <div className="por-state">
    <span>{data.base.name} · {day(data.date)}{isToday?' (hoje)':''}</span>
    {!report?<Badge tone="muted">Ainda sem movimento</Badge>:closed?<Badge tone="success">Fechado · revisão {last?.number} {last?KIND_NAMES[last.kind]:''}</Badge>:<Badge tone="info">Aberto{versions.length?` · reaberto (já houve revisão ${last?.number})`:''}</Badge>}
    {data.pendingAfterClose>0&&<Badge tone="warning">{data.pendingAfterClose} movimento(s) após o fechamento</Badge>}
   </div></div>
   <div className="por-head-actions">
    <Button variant="outline" onClick={()=>void refresh()}><RefreshCw size={15}/> Atualizar</Button>
    {report&&<Button variant="outline" onClick={()=>window.open(closed&&last?printUrl({id:last.id}):printUrl({reportId:report.id}),'_blank','noopener')}><Printer size={15}/> {closed?'Imprimir revisão':'Imprimir parcial'}</Button>}
    {closed?<Button onClick={()=>setReopen({id:report!.id,date:data.date})}><LockOpen size={15}/> Reabrir</Button>:<Button onClick={()=>setClosing(true)}><Lock size={15}/> Fechar relatório</Button>}
   </div>
  </section>
  {(data.olderOpenReports as R[]).filter(o=>o.date!==data.date).length>0&&<div className="por-alert" role="status"><AlertTriangle size={16}/> Há relatório(s) de dia anterior ainda aberto(s):
   {(data.olderOpenReports as R[]).filter(o=>o.date!==data.date).map(o=><button key={o.id} type="button" className="link" onClick={()=>setDate(o.date)}>{day(o.date)}</button>)}</div>}
  {closed&&data.pendingAfterClose>0&&<div className="por-alert" role="status"><AlertTriangle size={16}/> Este relatório foi fechado e depois recebeu movimentos. Reabra para incluí-los em uma nova revisão.</div>}
  <div className="por-kpis"><div><span>Entradas</span><b>{t.entradas}</b></div><div><span>Saídas</span><b>{t.saidas}</b>{t.saidasDeVisitasAnteriores>0&&<small>{t.saidasDeVisitasAnteriores} de visitas de dias anteriores</small>}</div><div><span>Pessoas únicas</span><b>{t.pessoasUnicas}</b></div><div className={t.presentes?'warn':''}><span>Na base agora</span><b>{t.presentes}</b></div>{t.anuladas>0&&<div><span>Anuladas</span><b>{t.anuladas}</b></div>}</div>
  <div className="por-cols">
   {isToday?<EntryForm onDone={()=>void refresh()}/>:<section className="n-panel"><Empty icon={Users} title="Lançamentos do dia ficam em Hoje" description="Para registrar uma entrada de hoje, volte à data de hoje. Para corrigir um lançamento antigo, abra a linha em Movimentos do dia." action={<Button onClick={()=>setDate('')}>Voltar para hoje</Button>}/></section>}
   <section className="n-panel"><div className="panel-heading"><div><h2>Na base agora</h2><p>{present.length?`${present.length} pessoa(s) com visita em andamento.`:'Ninguém com visita em andamento.'}</p></div></div>
    {present.length?<ul className="por-present">{present.map(v=><li key={v.id}><div><b>{v.personName}</b><small>{v.companyName} · {v.purpose}</small><small>Entrou {dmyhm(v.entryAt,tz)}{v.plateIn?` · ${v.plateIn}`:''}</small></div>
     <div className="por-row-actions">{v.accessMode==='veiculo'?<CarFront size={16} aria-label="Veículo"/>:<Footprints size={16} aria-label="A pé"/>}<Button size="sm" variant="outline" onClick={()=>setVisitId(v.id)}>Detalhes</Button><Button size="sm" onClick={()=>setExit(v)}><LogOut size={14}/> Saída</Button></div></li>)}</ul>
     :<Empty icon={Users} title="Base vazia" description="As entradas registradas aparecem aqui até a saída."/>}
   </section>
  </div>
  <section className="n-panel"><div className="panel-heading"><div><h2>Movimentos do dia</h2><p>Entradas e saídas de {day(data.date)}, em ordem de horário. Clique numa linha para ver o histórico ou corrigir.</p></div></div>
   {moves.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th>Hora</th><th>Movimento</th><th>Visitante</th><th>Empresa</th><th>Objetivo</th><th>Acesso</th><th>Registrado por</th></tr></thead><tbody>
    {moves.map(({v,kind,at})=><tr key={kind+v.id} className="clickable" onClick={()=>setVisitId(v.id)}><td>{hm(at,tz)}{v.retroactive&&kind==='entrada'&&<small className="muted-text"> posterior</small>}</td>
     <td>{kind==='entrada'?<Badge tone="info">Entrada</Badge>:<Badge tone="muted">Saída{v.fromPreviousDay?' · de dia anterior':''}</Badge>}</td><td><button type="button" className="por-link" aria-label={`Abrir detalhes de ${v.personName}`} onClick={e=>{e.stopPropagation();setVisitId(v.id)}}><b>{v.personName}</b></button><small className="muted-text"> {v.document}</small></td><td>{v.companyName}</td><td>{v.purpose}</td>
     <td>{MODES[v.accessMode]}{(kind==='entrada'?v.plateIn:v.plateOut)?` · ${kind==='entrada'?v.plateIn:v.plateOut}`:''}</td><td>{kind==='entrada'?v.entryByName:v.exitByName}</td></tr>)}
   </tbody></table></div>:<Empty icon={Users} title="Sem movimentos" description="Nenhuma entrada ou saída neste dia."/>}
  </section>
  <ExitDialog visit={exit} onClose={()=>setExit(null)} onDone={()=>{setExit(null);void refresh()}}/>
  <VisitDialog visitId={visitId} manager={manager} onClose={()=>setVisitId(null)} onChanged={()=>void refresh()}/>
  {closing&&<CloseDialog date={data.date} report={report} onClose={()=>setClosing(false)} onDone={()=>{setClosing(false);void refresh()}}/>}
  <ReopenDialog report={reopen as {id:string,date:string}|null} onClose={()=>setReopen(null)} onDone={()=>{setReopen(null);void refresh()}}/>
 </div>;
}
