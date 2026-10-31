'use client';
// Financeiro › Solicitação de recobráveis: lista, detalhe (dados, recursos, cotações lado a lado com
// o cálculo da regra A, anexos, relatórios e histórico) e as ações de cada situação. O servidor
// confere acesso, escopo e situação de cada comando (lib/finance-requests, lib/finance-files).
import {useCallback,useEffect,useMemo,useState,FormEvent,ReactNode} from 'react';
import {Plus,AlertTriangle,LoaderCircle,FileText,Send,Undo2,BadgeCheck,Ban,CalendarPlus,Link2,Pencil,Paperclip,Download,ArrowLeft,Printer,ExternalLink,X} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,fmt,post,load,toLocalInput,fromLocalInput,localIssue,INPUT_MIN,INPUT_MAX,Period,type R} from './kit';
import {NeedAdder,needLabel,type Need} from './planning';
import {brl} from './finance';
import {quoteTotals} from '@/lib/recovery-quote';

export const REQUEST_STATUS:Record<string,[string,string]>={em_cotacao:['Em cotação','info'],enviada:['Enviada ao cliente','warning'],autorizada:['Autorizada','success'],em_execucao:['Em execução','success'],concluida:['Concluída','muted'],cancelada:['Cancelada','danger']};
const KIND:Record<string,string>={proposta:'Proposta do fornecedor',relatorio_assinado:'Relatório assinado',outro:'Documento'};
const ORDER_STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
const day=(iso?:string|null)=>iso?iso.slice(0,10).split('-').reverse().join('/'):'—';
const pct=(bp:number)=>(bp/100).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%';
const osLabel=(n:number)=>'OS '+String(n).padStart(6,'0');
const MAX_FILE=4*1024*1024;
/** Valor digitado em reais ("10.000,00", "8333,33") em centavos, só para a prévia (o servidor confere). */
const cents=(v:string)=>{let s=String(v||'').trim().replace(/^R\$\s*/,'').replace(/\s/g,'');if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');const n=Number(s);return s&&Number.isFinite(n)&&n>=0?Math.round(n*100):null;};
const totalsOf=(c:number|null,m:number,t:number)=>{if(c==null)return null;try{return quoteTotals(c,m,t)}catch{return null}};
/** Envio do anexo: corpo binário, parâmetros na URL. */
async function sendFile(params:R,file:File){
 if(file.size>MAX_FILE)throw new Error('Arquivo acima de 4 MB.');
 const q=new URLSearchParams(Object.entries(params).filter(([,v])=>v!=null&&v!=='') as [string,string][]);
 const r=await fetch('/api/finance/attachments?'+q,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
 const j:R=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Não foi possível enviar o arquivo.');return j;
}
const FileInput=({onChange}:{onChange:(f:File|null)=>void})=><Input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={e=>onChange(e.target.files?.[0]||null)}/>;

type Props={refreshKey?:number,canPlan:boolean,canCreateResource:boolean,onOpenPlan:(id:string)=>void,onOpenOrder?:(id:string)=>void};

export default function RecoveryRequests(props:Props){
 const [config,setConfig]=useState<R|null>(null),[error,setError]=useState(''),[open,setOpen]=useState<string|null>(null),[form,setForm]=useState<R|null>(null),[tick,setTick]=useState(0);
 const refreshConfig=useCallback(async()=>{try{setConfig(await load<R>('finance/config'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refreshConfig()},[refreshConfig,props.refreshKey]);
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Solicitações indisponíveis</h2><p>{error}</p></div>;
 if(!config)return <Skeleton className="h-64 rounded-xl"/>;
 return <>
  {open?<RequestDetail id={open} config={config} tick={tick} {...props} onBack={()=>setOpen(null)} onEdit={r=>setForm(r)}/>
   :<RequestList config={config} tick={tick} refreshKey={props.refreshKey} onOpen={setOpen} onCreate={()=>setForm({})}/>}
  {form&&<RequestForm initial={form} config={config} canCreateResource={props.canCreateResource} onRefs={refreshConfig} onClose={()=>setForm(null)} onSaved={id=>{setForm(null);setTick(t=>t+1);setOpen(id)}}/>}
 </>;
}

function RequestList({config,tick,refreshKey,onOpen,onCreate}:{config:R,tick:number,refreshKey?:number,onOpen:(id:string)=>void,onCreate:()=>void}){
 const [query,setQuery]=useState<R>({status:'',org:'',from:'',to:''}),[rows,setRows]=useState<R[]|null>(null),[error,setError]=useState('');
 const refresh=useCallback(async()=>{const q=new URLSearchParams(Object.entries(query).filter(([,v])=>v) as [string,string][]);
  try{setRows((await load<R>('finance/requests?'+q)).rows);setError('')}catch(e){setError((e as Error).message)}},[query]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey,tick]);
 const clients=config.clients as R[];
 return <>
  <section className="n-panel fin-filters rq-filters"><div className="form-grid">
   <Field label="Situação"><Choice value={query.status||'all'} onChange={v=>setQuery(q=>({...q,status:v==='all'?'':v}))} options={[{value:'all',label:'Todas'},...Object.entries(REQUEST_STATUS).map(([value,[label]])=>({value,label}))]}/></Field>
   <Field label="Solicitante"><Choice value={query.org||'all'} onChange={v=>setQuery(q=>({...q,org:v==='all'?'':v}))} options={[{value:'all',label:'Todos'},...clients.map(o=>({value:o.orgId,label:o.name}))]}/></Field>
   <Field label="Início previsto de"><Input type="date" value={query.from} onChange={e=>setQuery(q=>({...q,from:e.target.value}))}/></Field>
   <Field label="até"><Input type="date" value={query.to} onChange={e=>setQuery(q=>({...q,to:e.target.value}))}/></Field>
  </div></section>
  <section className="n-panel">
   <div className="panel-heading"><div><h2>Solicitações de recobráveis</h2><p>Cada atividade recobrável com as cotações dos fornecedores, o valor a faturar e a OS ligada. Clique numa linha para abrir.</p></div>
    <Button onClick={onCreate}><Plus size={16}/> Criar nova solicitação</Button></div>
   {error?<div className="form-error" role="alert"><AlertTriangle size={17}/>{error}</div>:!rows?<Skeleton className="h-40 rounded-xl"/>:rows.length?<div className="table-scroll"><table className="eu-table fin-table"><thead><tr><th>Número</th><th>Solicitante</th><th>Atividade</th><th>Data prevista</th><th>Situação</th><th>Cotações</th><th>Fornecedor escolhido</th><th>Valor a faturar</th><th>OS</th></tr></thead><tbody>
    {rows.map(r=><tr key={r.id} className="clickable" tabIndex={0} onClick={()=>onOpen(r.id)} onKeyDown={e=>{if(e.key==='Enter')onOpen(r.id)}}><td><b>{r.rec}</b></td><td>{r.orgAcronym} · {r.orgName}</td><td>{r.activity}</td><td className="nw">{fmt(r.plannedStart)}</td>
     <td><Badge tone={REQUEST_STATUS[r.status]?.[1]}>{REQUEST_STATUS[r.status]?.[0]||r.status}</Badge></td><td className={r.quotes<3&&r.status==='em_cotacao'?'warn-text':''}>{r.quotes} de 3</td><td>{r.chosenSupplier||'—'}</td><td className="nw">{r.totalCents==null?'—':<b>{brl(r.totalCents)}</b>}</td><td className="nw">{r.workOrderNumber?osLabel(r.workOrderNumber):'—'}</td></tr>)}
   </tbody></table></div>:<Empty icon={FileText} title="Nenhuma solicitação" description="Crie uma solicitação para registrar as cotações de uma atividade recobrável." action={<Button onClick={onCreate}><Plus size={16}/> Criar nova solicitação</Button>}/>}
  </section>
 </>;
}

/* ───────────────────────── Detalhe ───────────────────────── */

type Modal={kind:'quote'|'send'|'reopen'|'authorize'|'cancel'|'link'|'attach',item?:R};
function RequestDetail({id,config,tick,refreshKey,canPlan,onOpenPlan,onOpenOrder,onBack,onEdit}:Props&{id:string,config:R,tick:number,onBack:()=>void,onEdit:(r:R)=>void}){
 const [d,setD]=useState<R|null>(null),[error,setError]=useState(''),[modal,setModal]=useState<Modal|null>(null),[busy,setBusy]=useState(false);
 const refresh=useCallback(async()=>{try{setD(await load<R>('finance/request?id='+encodeURIComponent(id)));setError('')}catch(e){setError((e as Error).message)}},[id]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey,tick]);
 async function plan(){setBusy(true);try{const r=await post('finance/requests/plan',{id});toast.success(r.message);onOpenPlan(r.planId)}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Solicitação indisponível</h2><p>{error}</p><Button variant="outline" onClick={onBack}>Voltar à lista</Button></div>;
 if(!d)return <Skeleton className="h-64 rounded-xl"/>;
 const r=d.request as R,can=d.can as R,quotes=d.quotes as R[],attachments=d.attachments as R[],reports=d.reports as R[];
 const current=attachments.filter(a=>!a.replaced_by),replaced=attachments.filter(a=>a.replaced_by);
 const lastReport=reports[reports.length-1];
 const done=()=>{setModal(null);void refresh()};
 const resources=(r.resources||[]) as Need[],refs=refsOf(config);
 return <div className="rq-detail">
  <div className="rq-back"><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={15}/> Solicitações</Button></div>
  <section className="n-panel rq-head">
   <div className="oshead"><div className="row"><span className="id">{r.rec} · {r.org_acronym} · {r.org_name}</span><Badge tone={REQUEST_STATUS[r.status]?.[1]}>{REQUEST_STATUS[r.status]?.[0]}</Badge></div><h2>{r.activity}</h2></div>
   <dl className="facts"><div><dt>Pessoa solicitante</dt><dd>{r.person_name}</dd></div><div><dt>Data prevista</dt><dd><Period a={r.planned_start} b={r.planned_end} open="sem fim previsto"/></dd></div>
    <div><dt>Margem e impostos</dt><dd>{pct(r.margin_bp)} · {pct(r.tax_bp)}</dd></div>
    <div><dt>Valor a faturar</dt><dd>{r.chosen_total_cents==null?'—':<b>{brl(Number(r.chosen_total_cents))}</b>}</dd></div>
    <div><dt>OS</dt><dd>{r.work_order_id?<>{osLabel(r.wo_number)} · {ORDER_STATUS[r.wo_status]||r.wo_status}{onOpenOrder&&<button type="button" className="text-action" onClick={()=>onOpenOrder(r.work_order_id)}> Abrir</button>}</>:r.plan_id?'Rascunho no Planejamento':'—'}</dd></div></dl>
   {r.status==='autorizada'&&r.signer_name&&<p className="rq-note">Autorizada por {r.signer_name} ({r.signer_role}) em {day(r.signed_at)}.</p>}
   {r.status==='cancelada'&&r.cancel_reason&&<p className="rq-note">Cancelada: {r.cancel_reason}</p>}
   <div className="rq-actions">
    {can.edit&&<Button variant="outline" onClick={()=>onEdit(r)}><Pencil size={15}/> Editar dados</Button>}
    {can.send&&<Button className="primary-action" onClick={()=>setModal({kind:'send'})}><Send size={15}/> Enviar ao cliente</Button>}
    {can.authorize&&<Button className="primary-action" onClick={()=>setModal({kind:'authorize'})}><BadgeCheck size={15}/> Autorizar</Button>}
    {can.plan&&canPlan&&<Button className="primary-action" disabled={busy} onClick={()=>void plan()}>{busy?<LoaderCircle size={15} className="animate-spin"/>:<CalendarPlus size={15}/>} {r.plan_id?'Abrir rascunho da OS':'Planejar OS'}</Button>}
    {r.status==='autorizada'&&!r.work_order_id&&<Button variant="outline" onClick={()=>setModal({kind:'link'})}><Link2 size={15}/> Vincular OS existente</Button>}
    {lastReport&&<a className="rq-link" href={`/recobravel/${r.id}`} target="_blank" rel="noopener"><Printer size={15}/> Imprimir relatório (versão {lastReport.version})</a>}
    {can.reopen&&<Button variant="outline" onClick={()=>setModal({kind:'reopen'})}><Undo2 size={15}/> Reabrir cotação</Button>}
    {can.cancel&&<Button variant="ghost" onClick={()=>setModal({kind:'cancel'})}><Ban size={15}/> Cancelar solicitação</Button>}
   </div>
  </section>

  <section className="n-panel">
   <div className="panel-heading"><div><h2>Dados e recursos</h2></div></div>
   <div className="rq-body">
    <div><h4>Descrição</h4><p>{r.description||'Sem descrição.'}</p></div>
    <div><h4>Recursos necessários</h4>{resources.length?<ul>{resources.map((n,i)=><li key={i}>{needLabel(n,refs)}</li>)}</ul>:<p className="muted-text">Sem recursos informados.</p>}</div>
    {r.notes&&<div><h4>Observações</h4><p>{r.notes}</p></div>}
    {r.justification&&<div><h4>Justificativa (menos de 3 cotações)</h4><p>{r.justification}</p></div>}
   </div>
  </section>

  <section className="n-panel">
   <div className="panel-heading"><div><h2>Cotações <span className={`rq-count${quotes.length<3?' warn-text':''}`}>{quotes.length} de 3</span></h2><p>Valor a faturar pela regra A: margem sobre o valor cotado e impostos por dentro; os impostos absorvem o centavo da diferença.</p></div>
    {can.edit&&<Button onClick={()=>setModal({kind:'quote'})}><Plus size={16}/> Registrar cotação</Button>}</div>
   {quotes.length?<div className="rq-quotes">{quotes.map(q=>{const t=q.totals as R,prop=current.find(a=>a.kind==='proposta'&&a.quote_id===q.id);return <article key={q.id} className={`rq-quote${q.chosen?' chosen':''}`}>
    <header><b>{q.supplierName}</b>{q.chosen&&<Badge tone="success">Escolhida pelo cliente</Badge>}</header>
    <small>{[q.proposalNumber&&`Proposta ${q.proposalNumber}`,q.validUntil&&`validade ${day(q.validUntil)}`,q.leadTime&&`prazo ${q.leadTime}`,q.receivedAt&&`recebida ${day(q.receivedAt)}`].filter(Boolean).join(' · ')||'Sem dados da proposta'}</small>
    <dl><div><dt>Valor cotado</dt><dd>{brl(t.quotedCents)}</dd></div><div><dt>Margem</dt><dd>{brl(t.marginCents)}</dd></div><div><dt>Subtotal</dt><dd>{brl(t.subtotalCents)}</dd></div><div><dt>Impostos</dt><dd>{brl(t.taxCents)}</dd></div><div className="total"><dt>Valor a faturar</dt><dd>{brl(t.totalCents)}</dd></div></dl>
    {q.notes&&<p className="rq-qnotes">{q.notes}</p>}
    <footer>{prop?<a className="text-action" href={`/api/finance/attachment?id=${prop.id}`}><Download size={13} className="inline"/> {prop.file_name}</a>:<span className="muted-text">Sem anexo da proposta</span>}
     {can.edit&&<><button type="button" className="text-action" onClick={()=>setModal({kind:'attach',item:{kind:'proposta',quote:q}})}><Paperclip size={13} className="inline"/> {prop?'Substituir':'Anexar'}</button><button type="button" className="text-action" onClick={()=>setModal({kind:'quote',item:q})}><Pencil size={13} className="inline"/> Editar</button></>}</footer>
   </article>})}</div>:<Empty icon={FileText} title="Nenhuma cotação ainda" description="Registre cada cotação quando ela chegar. São 3 para enviar ao cliente; com menos, escreva a justificativa."/>}
  </section>

  <section className="n-panel">
   <div className="panel-heading"><div><h2>Anexos</h2><p>PDF, JPG ou PNG de até 4 MB. Enviar outro arquivo no mesmo lugar deixa o anterior como substituído, no histórico.</p></div>
    {r.status!=='cancelada'&&<Button variant="outline" onClick={()=>setModal({kind:'attach',item:{kind:'outro'}})}><Paperclip size={15}/> Anexar documento</Button>}</div>
   {current.length?<ul className="eu-list">{current.map(a=><AttachmentRow key={a.id} a={a} quotes={quotes}/>)}</ul>:<p className="eu-empty muted-text">Nenhum anexo.</p>}
   {replaced.length>0&&<details className="rq-replaced"><summary>Substituídos ({replaced.length})</summary><ul className="eu-list">{replaced.map(a=><AttachmentRow key={a.id} a={a} quotes={quotes}/>)}</ul></details>}
  </section>

  <section className="n-panel">
   <div className="panel-heading"><div><h2>Relatórios enviados</h2><p>Cada envio ao cliente guarda uma versão; versões antigas continuam disponíveis.</p></div></div>
   {reports.length?<ul className="eu-list">{reports.slice().reverse().map(v=><li key={v.version}><div className="eu-line"><b>Versão {v.version}</b><span>{fmt(v.issued_at)}</span><span className="muted-text">por {v.issued_by_name}</span>
    <a className="text-action" href={`/recobravel/${r.id}?versao=${v.version}`} target="_blank" rel="noopener"><ExternalLink size={13} className="inline"/> Abrir</a></div></li>)}</ul>:<p className="eu-empty muted-text">Ainda não enviada ao cliente.</p>}
  </section>

  <section className="n-panel">
   <div className="panel-heading"><div><h2>Histórico</h2></div></div>
   <ul className="eu-list rq-history">{(d.history as R[]).slice().reverse().map((h,i)=><li key={i}><div className="eu-line"><span>{fmt(h.created_at)}</span><b>{h.action.replace(/^Financeiro: /,'')}</b><span className="muted-text">{h.author_name}</span>{h.detail?.reason&&<span>“{h.detail.reason}”</span>}</div></li>)}</ul>
  </section>

  {modal?.kind==='quote'&&<QuoteForm request={r} quote={modal.item} quotes={quotes} suppliers={config.suppliers} onClose={()=>setModal(null)} onDone={done}/>}
  {modal&&['send','reopen','cancel'].includes(modal.kind)&&<ReasonDialog kind={modal.kind as 'send'|'reopen'|'cancel'} request={r} quotes={quotes.length} onClose={()=>setModal(null)} onDone={done}/>}
  {modal?.kind==='authorize'&&<AuthorizeDialog request={r} quotes={quotes} attachments={attachments} lastReport={lastReport} onClose={()=>setModal(null)} onDone={done}/>}
  {modal?.kind==='link'&&<LinkDialog request={r} orders={d.linkable} onClose={()=>setModal(null)} onDone={done}/>}
  {modal?.kind==='attach'&&<AttachDialog request={r} kind={modal.item!.kind} quote={modal.item!.quote} onClose={()=>setModal(null)} onDone={done}/>}
 </div>;
}

function AttachmentRow({a,quotes}:{a:R,quotes:R[]}){
 const q=a.quote_id?quotes.find(x=>x.id===a.quote_id):null;
 return <li><div className="eu-line"><Badge tone={a.kind==='relatorio_assinado'?'success':a.kind==='proposta'?'info':'muted'}>{KIND[a.kind]}</Badge><a className="text-action" href={`/api/finance/attachment?id=${a.id}`}><Download size={13} className="inline"/> {a.file_name}</a>
  <span className="muted-text">{q?`${q.supplierName} · `:''}{a.description?`${a.description} · `:''}{Math.max(1,Math.round(a.size_bytes/1024)).toLocaleString('pt-BR')} KB · {a.created_by_name} · {fmt(a.created_at)}</span></div></li>;
}

/** Referências do seletor de recursos (o cadastro já vem só com os ativos). */
const refsOf=(c:R)=>({equipmentTypes:(c.equipmentTypes as R[]).map(x=>({...x,active:1})),functions:(c.functions as R[]).map(x=>({...x,active:1})),materials:(c.materials as R[]).map(x=>({...x,active:1}))});

function Shell({title,description,children,onClose,busy}:{title:string,description?:string,children:ReactNode,onClose:()=>void,busy:boolean}){
 return <Dialog open onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog rq-dialog"><DialogHeader><DialogTitle>{title}</DialogTitle>{description&&<DialogDescription>{description}</DialogDescription>}</DialogHeader>{children}</DialogContent></Dialog>;
}
function Footer({busy,label,disabled,onClose,error}:{busy:boolean,label:string,disabled?:boolean,onClose:()=>void,error:string}){
 return <>{error&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
  <div className="modal-footer"><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy||disabled}>{busy&&<LoaderCircle className="animate-spin" size={16}/>} {label}</Button></div></>;
}
/** Envio padrão dos diálogos: mensagem do servidor no rodapé, sucesso em aviso. */
function useSubmit(onDone:()=>void){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const run=async(e:FormEvent,fn:()=>Promise<R|void>)=>{e.preventDefault();setBusy(true);setError('');try{const r=await fn();if(r?.message)toast.success(r.message);onDone()}catch(err){setError((err as Error).message)}finally{setBusy(false)}};
 return {busy,error,run};
}

function RequestForm({initial,config,canCreateResource,onRefs,onClose,onSaved}:{initial:R,config:R,canCreateResource:boolean,onRefs:()=>Promise<void>,onClose:()=>void,onSaved:(id:string)=>void}){
 const editing=!!initial.id;
 const [f,setF]=useState<R>(()=>({orgId:initial.org_id||'',personId:initial.requester_person_id||'',mode:initial.id&&!initial.activity_type_id?'livre':initial.activity_type_id?'tipo':'livre',activityTypeId:initial.activity_type_id||'',title:initial.title||'',
  description:initial.description||'',start:toLocalInput(initial.planned_start),end:toLocalInput(initial.planned_end),notes:initial.notes||'',resources:(initial.resources||[]) as Need[]}));
 const {busy,error,run}=useSubmit(()=>{});
 const clients=(config.clients as R[]).filter(c=>(c.enabled&&c.active)||c.orgId===initial.org_id);
 const people=(config.people as R[]).filter(p=>p.org_id===f.orgId&&(p.active||p.id===initial.requester_person_id));
 const client=clients.find(c=>c.orgId===f.orgId);
 const refs=useMemo(()=>refsOf(config),[config]);
 const submit=(e:FormEvent)=>run(e,async()=>{
  const r=await post('finance/requests/save',{id:initial.id,version:initial.version,orgId:f.orgId,personId:f.personId,activityTypeId:f.mode==='tipo'?f.activityTypeId:null,title:f.mode==='livre'?f.title:'',description:f.description,
   plannedStart:fromLocalInput(f.start),plannedEnd:f.end?fromLocalInput(f.end):null,resources:f.resources,notes:f.notes});
  toast.success(r.message);onSaved(r.id);
 });
 return <Shell title={editing?`Editar ${initial.rec}`:'Nova solicitação de recobrável'} description="Só aparecem os clientes habilitados em Financeiro › Configurações. Margem e impostos ficam os vigentes no dia da criação." onClose={onClose} busy={busy}>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Cliente *" hint={client&&!client.current?'Este cliente ainda não tem margem e impostos cadastrados.':client?.current?`Margem ${pct(client.current.marginBp)} · impostos ${pct(client.current.taxBp)}`:undefined}><Choice value={f.orgId} onChange={v=>setF(x=>({...x,orgId:v,personId:''}))} options={clients.map(c=>({value:c.orgId,label:`${c.acronym} · ${c.name}`}))}/></Field>
   <Field label="Pessoa solicitante *"><Choice value={f.personId} disabled={!f.orgId} onChange={v=>setF(x=>({...x,personId:v}))} options={people.map(p=>({value:p.id,label:p.role?`${p.name} · ${p.role}`:p.name}))}/></Field>
   <Field label="Atividade *" hint={f.mode==='tipo'?'Vira OS com fluxo: as etapas vêm do Cadastro de fluxo.':'Vira OS sem fluxo, com título próprio.'}><Choice value={f.mode} onChange={v=>setF(x=>({...x,mode:v}))} options={[{value:'tipo',label:'Tipo de atividade cadastrado'},{value:'livre',label:'Atividade livre (sem fluxo)'}]}/></Field>
   {f.mode==='tipo'?<Field label="Tipo de atividade *"><Choice value={f.activityTypeId} onChange={v=>setF(x=>({...x,activityTypeId:v}))} options={(config.activityTypes as R[]).map(t=>({value:t.id,label:`${t.code} · ${t.name}`}))}/></Field>
    :<Field label="Título da atividade *"><Input required maxLength={160} value={f.title} onChange={e=>setF(x=>({...x,title:e.target.value}))} placeholder="Ex.: Içamento de tubulação"/></Field>}
   <Field label="Início previsto (Brasília) *" hint={localIssue(f.start)||undefined}><Input type="datetime-local" required min={INPUT_MIN} max={INPUT_MAX} value={f.start} onChange={e=>setF(x=>({...x,start:e.target.value}))}/></Field>
   <Field label="Fim previsto (opcional)" hint={localIssue(f.end)||undefined}><Input type="datetime-local" min={INPUT_MIN} max={INPUT_MAX} value={f.end} onChange={e=>setF(x=>({...x,end:e.target.value}))}/></Field>
   <Field label="Descrição" wide><Textarea maxLength={2000} rows={3} value={f.description} onChange={e=>setF(x=>({...x,description:e.target.value}))}/></Field>
   <div className="wide rq-needs"><b>Recursos necessários</b>
    {(f.resources as Need[]).length>0&&<ul>{(f.resources as Need[]).map((n,i)=><li key={i}><span>{needLabel(n,refs)}</span><button type="button" className="text-action" aria-label="Remover recurso" onClick={()=>setF(x=>({...x,resources:(x.resources as Need[]).filter((_,j)=>j!==i)}))}><X size={14}/></button></li>)}</ul>}
    <NeedAdder refs={refs} needs={f.resources} onRefs={onRefs} create={canCreateResource} onAdd={n=>setF(x=>({...x,resources:[...x.resources,n]}))}/>
   </div>
   <Field label="Observações" wide><Textarea maxLength={2000} rows={2} value={f.notes} onChange={e=>setF(x=>({...x,notes:e.target.value}))}/></Field>
  </div><Footer busy={busy} error={error} onClose={onClose} label={editing?'Salvar':'Criar solicitação'} disabled={!f.orgId||!f.personId||!f.start||(f.mode==='tipo'?!f.activityTypeId:!f.title.trim())}/></form>
 </Shell>;
}

function QuoteForm({request:r,quote:q,quotes,suppliers,onClose,onDone}:{request:R,quote?:R,quotes:R[],suppliers:R[],onClose:()=>void,onDone:()=>void}){
 const [f,setF]=useState<R>(()=>({supplierId:q?.supplierId||'',supplierName:'',value:q?(q.totals.quotedCents/100).toLocaleString('pt-BR',{minimumFractionDigits:2}):'',proposalNumber:q?.proposalNumber||'',validUntil:q?.validUntil||'',leadTime:q?.leadTime||'',receivedAt:q?.receivedAt||today(),notes:q?.notes||''}));
 const {busy,error,run}=useSubmit(onDone);
 const taken=new Set(quotes.filter(x=>x.id!==q?.id).map(x=>x.supplierId));
 const options=suppliers.filter(s=>(s.active&&!taken.has(s.id))||s.id===q?.supplierId).map(s=>({value:s.id,label:s.name}));
 const t=totalsOf(cents(f.value),Number(r.margin_bp),Number(r.tax_bp));
 const creating=f.supplierId==='__new';
 const submit=(e:FormEvent)=>run(e,()=>post('finance/quotes',{id:q?.id,requestId:r.id,supplierId:creating?null:f.supplierId,supplierName:creating?f.supplierName:undefined,value:f.value,proposalNumber:f.proposalNumber,validUntil:f.validUntil||null,leadTime:f.leadTime,receivedAt:f.receivedAt||null,notes:f.notes}));
 return <Shell title={q?`Editar cotação · ${q.supplierName}`:`Registrar cotação · ${r.rec}`} description={`Cotação ${q?quotes.findIndex(x=>x.id===q.id)+1:quotes.length+1} de 3. Margem ${pct(r.margin_bp)} e impostos ${pct(r.tax_bp)} desta solicitação.`} onClose={onClose} busy={busy}>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Fornecedor *"><Choice value={f.supplierId} onChange={v=>setF(x=>({...x,supplierId:v}))} options={[...options,{value:'__new',label:'+ Cadastrar na hora…'}]}/></Field>
   {creating&&<Field label="Nome do novo fornecedor *"><Input required maxLength={160} value={f.supplierName} onChange={e=>setF(x=>({...x,supplierName:e.target.value}))}/></Field>}
   <Field label="Valor da proposta (R$) *"><Input required inputMode="decimal" placeholder="0,00" value={f.value} onChange={e=>setF(x=>({...x,value:e.target.value}))}/></Field>
   <Field label="Número da proposta"><Input maxLength={60} value={f.proposalNumber} onChange={e=>setF(x=>({...x,proposalNumber:e.target.value}))}/></Field>
   <Field label="Validade"><Input type="date" value={f.validUntil} onChange={e=>setF(x=>({...x,validUntil:e.target.value}))}/></Field>
   <Field label="Prazo de execução"><Input maxLength={80} placeholder="Ex.: 5 dias úteis" value={f.leadTime} onChange={e=>setF(x=>({...x,leadTime:e.target.value}))}/></Field>
   <Field label="Recebida em"><Input type="date" max={today()} value={f.receivedAt} onChange={e=>setF(x=>({...x,receivedAt:e.target.value}))}/></Field>
   <Field label="Observações" wide><Textarea maxLength={1000} rows={2} value={f.notes} onChange={e=>setF(x=>({...x,notes:e.target.value}))}/></Field>
   <dl className="wide rq-preview">{t?<><div><dt>Margem</dt><dd>{brl(t.marginCents)}</dd></div><div><dt>Subtotal</dt><dd>{brl(t.subtotalCents)}</dd></div><div><dt>Impostos</dt><dd>{brl(t.taxCents)}</dd></div><div className="total"><dt>Valor a faturar</dt><dd>{brl(t.totalCents)}</dd></div></>:<div><dt>Valor a faturar</dt><dd>Informe o valor da proposta</dd></div>}</dl>
  </div><Footer busy={busy} error={error} onClose={onClose} label={q?'Salvar cotação':'Registrar cotação'} disabled={!f.supplierId||(creating&&!f.supplierName.trim())||!t}/></form>
 </Shell>;
}

function ReasonDialog({kind,request:r,quotes,onClose,onDone}:{kind:'send'|'reopen'|'cancel',request:R,quotes:number,onClose:()=>void,onDone:()=>void}){
 const [text,setText]=useState(''),{busy,error,run}=useSubmit(onDone);
 const send=kind==='send',needText=!send||quotes<3;
 const copy={send:{title:`Enviar ${r.rec} ao cliente`,description:quotes<3?`Há ${quotes} de 3 cotações: escreva a justificativa, que sai no relatório.`:'Gera e guarda uma nova versão do relatório para o cliente escolher e assinar. As cotações ficam travadas até reabrir.',label:'Justificativa *',action:'Enviar ao cliente'},
  reopen:{title:`Reabrir a cotação de ${r.rec}`,description:'Volta a "Em cotação". Escolha, assinatura e rascunho de OS ligados deixam de valer; o próximo envio gera uma nova versão do relatório.',label:'Motivo *',action:'Reabrir cotação'},
  cancel:{title:`Cancelar ${r.rec}`,description:'A solicitação fica no histórico como cancelada e não volta.',label:'Motivo *',action:'Cancelar solicitação'}}[kind];
 const submit=(e:FormEvent)=>run(e,()=>post('finance/requests/'+kind,{id:r.id,version:r.version,...(send?{justification:text}:{reason:text})}));
 return <Shell title={copy.title} description={copy.description} onClose={onClose} busy={busy}>
  <form onSubmit={submit}>{needText&&<Field label={copy.label} wide><Textarea maxLength={1000} rows={3} value={text} onChange={e=>setText(e.target.value)}/></Field>}
   <Footer busy={busy} error={error} onClose={onClose} label={copy.action} disabled={!send&&!text.trim()}/></form>
 </Shell>;
}

function AuthorizeDialog({request:r,quotes,attachments,lastReport,onClose,onDone}:{request:R,quotes:R[],attachments:R[],lastReport?:R,onClose:()=>void,onDone:()=>void}){
 const [f,setF]=useState<R>({quoteId:'',signerName:'',signerRole:'',signedAt:today()}),[file,setFile]=useState<File|null>(null);
 const {busy,error,run}=useSubmit(onDone);
 // O relatório assinado tem de ser posterior ao último envio (o servidor confere).
 const signed=attachments.find(a=>a.kind==='relatorio_assinado'&&!a.replaced_by&&lastReport&&a.created_at>=lastReport.issued_at);
 const submit=(e:FormEvent)=>run(e,async()=>{
  if(file)await sendFile({request:r.id,kind:'relatorio_assinado',name:file.name},file);
  return post('finance/requests/authorize',{id:r.id,version:r.version,...f});
 });
 return <Shell title={`Autorizar ${r.rec}`} description={`Marque a cotação escolhida pelo cliente e anexe o relatório assinado (versão ${lastReport?.version||1}). Depois de autorizar, os valores ficam travados.`} onClose={onClose} busy={busy}>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Cotação escolhida *" wide><Choice value={f.quoteId} onChange={v=>setF(x=>({...x,quoteId:v}))} options={quotes.map(q=>({value:q.id,label:`${q.supplierName} · ${brl(q.totals.totalCents)} a faturar`}))}/></Field>
   <Field label="Nome de quem assinou pelo cliente *"><Input required maxLength={160} value={f.signerName} onChange={e=>setF(x=>({...x,signerName:e.target.value}))}/></Field>
   <Field label="Cargo *"><Input required maxLength={120} value={f.signerRole} onChange={e=>setF(x=>({...x,signerRole:e.target.value}))}/></Field>
   <Field label="Data da assinatura *"><Input required type="date" max={today()} value={f.signedAt} onChange={e=>setF(x=>({...x,signedAt:e.target.value}))}/></Field>
   <Field label={signed?'Relatório assinado (substituir)':'Relatório assinado *'} hint={signed?`Anexado: ${signed.file_name}`:'PDF, JPG ou PNG de até 4 MB.'}><FileInput onChange={setFile}/></Field>
  </div><Footer busy={busy} error={error} onClose={onClose} label="Autorizar" disabled={!f.quoteId||!f.signerName.trim()||!f.signerRole.trim()||!f.signedAt||(!signed&&!file)}/></form>
 </Shell>;
}

function LinkDialog({request:r,orders,onClose,onDone}:{request:R,orders:R[],onClose:()=>void,onDone:()=>void}){
 const [wo,setWo]=useState(''),{busy,error,run}=useSubmit(onDone);
 const submit=(e:FormEvent)=>run(e,()=>post('finance/requests/link',{id:r.id,workOrderId:wo}));
 return <Shell title={`Vincular OS a ${r.rec}`} description={`OS de ${r.org_name}, não cancelada e sem outra solicitação. A solicitação passa a "Em execução" (ou "Concluída", se a OS já terminou).`} onClose={onClose} busy={busy}>
  <form onSubmit={submit}>{orders.length?<Field label="OS *" wide><Choice value={wo} onChange={setWo} options={orders.map(o=>({value:o.id,label:`${osLabel(o.number)} · ${o.activity} · ${fmt(o.planned_start,true)} · ${ORDER_STATUS[o.status]||o.status}`}))}/></Field>
   :<p className="muted-text">Nenhuma OS deste cliente disponível para vincular.</p>}
   <Footer busy={busy} error={error} onClose={onClose} label="Vincular OS" disabled={!wo}/></form>
 </Shell>;
}

function AttachDialog({request:r,kind,quote,onClose,onDone}:{request:R,kind:string,quote?:R,onClose:()=>void,onDone:()=>void}){
 const [file,setFile]=useState<File|null>(null),[description,setDescription]=useState(''),{busy,error,run}=useSubmit(onDone);
 const submit=(e:FormEvent)=>run(e,()=>sendFile({request:r.id,kind,quote:quote?.id,name:file!.name,description},file!));
 return <Shell title={kind==='proposta'?`Proposta · ${quote?.supplierName}`:`Anexar documento a ${r.rec}`} description="PDF, JPG ou PNG de até 4 MB. O tipo é conferido pelo conteúdo do arquivo." onClose={onClose} busy={busy}>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Arquivo *" wide><FileInput onChange={setFile}/></Field>
   {kind==='outro'&&<Field label="Descrição *" wide><Input required maxLength={300} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Ex.: e-mail do cliente com o escopo"/></Field>}
  </div><Footer busy={busy} error={error} onClose={onClose} label="Enviar arquivo" disabled={!file||(kind==='outro'&&!description.trim())}/></form>
 </Shell>;
}
