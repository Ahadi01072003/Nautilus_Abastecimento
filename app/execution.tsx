'use client';
// Operação › OS: linha do tempo das etapas, etapa selecionada com ações e cronômetros,
// apontamentos, checklists e histórico. Os horários vêm do servidor; o relógio da tela
// só anda entre as atualizações (nunca é a referência gravada).
import {useCallback,useEffect,useMemo,useState,FormEvent} from 'react';
import {Play,Pause,Square,Ban,RotateCcw,MessageSquarePlus,ListChecks,History,AlertTriangle,CheckCircle2,Lock,Clock,LoaderCircle,Truck,Users,ShieldAlert,ArrowRight,FileText} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import EquipmentUses from './equipment-uses';
import {Choice,Badge,Empty,Field,OrgTag,fmt,post,load,fromLocalInput,Period,type R} from './kit';
import {osLabel} from './planning';
import OsRuler,{effective} from './os-ruler';
import {Digits,hms} from './ops-board';

const MIN=60000;
/** Duração em HH:MM com horas acumuladas (02:15, 27:35, 125:08). */
export const dur=(ms:number)=>{const m=Math.max(0,Math.floor(ms/MIN));return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`};
const dmhmFmt=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
/** Data e hora curtas (26/10 09:00): início e fim sempre com a data, também em OS de vários dias. */
const dmhm=(s:string)=>dmhmFmt.format(new Date(s)).replace(',','');
const dh=(ms:number)=>{const m=Math.floor(Math.abs(ms)/MIN);return `${String(Math.floor(m/60)).padStart(2,'0')}h${String(m%60).padStart(2,'0')}`};
/** Desvio legível: atraso, antecipação, no horário ou menos de 1 minuto. */
export function deviation(actual:number,planned:number,done=true){const d=actual-planned;if(d===0)return 'No horário';if(Math.abs(d)<MIN)return d>0?'Atraso de menos de 1 minuto':'Menos de 1 minuto antes';return d>0?`Atraso de ${dh(d)}`:`${done?'Concluída':'Iniciada'} ${dh(d)} antes`}
const stepNames:Record<string,[string,string]>={nao_iniciada:['Não iniciada','muted'],em_execucao:['Em execução','success'],bloqueada:['Bloqueada','danger'],pausada:['Pausada','warning'],concluida:['Concluída','info'],dispensada:['Dispensada','muted'],cancelada:['Cancelada','danger']};
const orderNames:Record<string,[string,string]>={programada:['Programada','info'],em_andamento:['Em andamento','success'],encerramento_pendente:['Encerramento pendente','warning'],concluida:['Concluída','muted'],cancelada:['Cancelada','danger']};
const kindNames:Record<string,string>={ocorrencia:'Ocorrência',impacto:'Impacto',bloqueio:'Bloqueio'};
/** Impacto ainda sem fim: aguarda o registro da solução. */
const openImpact=(o:R)=>o.kind==='impacto'&&o.status==='aberto'&&!o.impact_end;
const eventNames:Record<string,string>={inicio:'Início',bloqueio:'Bloqueio',pausa:'Pausa',retomada:'Retomada',termino:'Término',dispensa:'Dispensa',encerramento:'Encerramento',encerramento_pendente:'Encerramento pendente',nc_critica:'NC crítica',interrupcao_tecnica:'Interrupção técnica',cancelamento:'Cancelamento da OS'};
const moments:Record<string,string>={pre_atividade:'Pré-atividade',pre_uso:'Pré-uso',durante:'Durante',pos_atividade:'Pós-atividade'};
const localNow=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).replace(' ','T');

type Action={kind:'block'|'note'|'pause'|'finish'|'resolve'|'dispense'|'cancel',step?:R,item?:R,key:string};

export default function OrderExecution({orderId,onChanged}:{orderId:string,onChanged?:()=>void}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[selected,setSelected]=useState<string|null>(null),[tick,setTick]=useState(()=>Date.now()),[action,setAction]=useState<Action|null>(null),[form,setForm]=useState<R>({}),[busy,setBusy]=useState(false),[formError,setFormError]=useState(''),[blockerMap,setBlockerMap]=useState<Record<string,string[]>>({}),[checklist,setChecklist]=useState<string|null>(null),[complementary,setComplementary]=useState<R>({});
 const [offset,setOffset]=useState(0);
 const refresh=useCallback(async()=>{try{const d=await load<R>('ops/order?id='+encodeURIComponent(orderId));setOffset(Date.parse(d.serverNow)-Date.now());setData(d);setError('')}catch(e){setError((e as Error).message)}},[orderId]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Execução vinda do servidor.
 useEffect(()=>{void refresh()},[refresh]);
 // Atualiza a execução de outras pessoas periodicamente; o relógio local só move os cronômetros.
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh()},20000);const c=setInterval(()=>setTick(Date.now()),1000);return()=>{clearInterval(t);clearInterval(c)}},[refresh]);
 const now=tick+offset;
 const steps=useMemo(()=>{if(!data)return [] as R[];return (data.steps as R[]).map((s):R=>{const p=(data.plan.steps as R[]).find(x=>x.id===s.plan_step_id)!;const iv=(data.intervals as R[]).filter(i=>i.os_step_id===s.id);return {...s,plan:p,intervals:iv}}).sort((a,b)=>a.plan.position-b.plan.position)},[data]);
 const sel=steps.find(s=>s.id===selected)||null;
 const tags=useTags(data);
 // Pré-requisitos de início da etapa selecionada (consulta ao servidor).
 useEffect(()=>{if(!sel||sel.status!=='nao_iniciada')return;let alive=true;const sid=sel.id;load<R>('ops/start-check?stepId='+sid).then(r=>{if(alive)setBlockerMap(m=>({...m,[sid]:r.blockers}))}).catch(()=>{});return()=>{alive=false}},[sel?.id,sel?.status,data]); // eslint-disable-line react-hooks/exhaustive-deps
 const blockers=sel&&sel.status==='nao_iniciada'?blockerMap[sel.id]??null:null;

 if(error)return <div className="error-panel ap-center"><AlertTriangle/><h2>OS indisponível</h2><p>{error}</p></div>;
 if(!data)return <div className="ap-center"><Skeleton className="h-96 rounded-xl"/></div>;
 const {order,plan,can}=data;
 const sum=(iv:R[],kind:string)=>iv.filter(i=>i.kind===kind).reduce((n,i)=>n+((i.end_at?Date.parse(i.end_at):now)-Date.parse(i.start_at)),0);
 const timing=(s:R)=>{const ps=Date.parse(s.plan.planned_start),pe=Date.parse(s.plan.planned_end);
  if(s.status==='nao_iniciada')return now<ps?`Início previsto em ${dur(ps-now)}`:`Início atrasado em ${dur(now-ps)}`;
  if(s.status==='em_execucao')return now<=pe?`Restam ${dur(pe-now)}`:`Fim previsto vencido há ${dur(now-pe)}`;
  if(s.status==='bloqueada'||s.status==='pausada'){const open=s.intervals.find((i:R)=>!i.end_at);return `Parada há ${dur(open?now-Date.parse(open.start_at):0)}`}
  if(s.status==='concluida')return deviation(Date.parse(s.actual_end),pe);
  return s.status==='cancelada'?'Cancelada com a OS':'Dispensada';};
 const active=steps.filter(s=>['em_execucao','bloqueada','pausada'].includes(s.status));
 // Apontamentos (ocorrências, impactos e bloqueios juntos): do registro mais recente para o mais antigo.
 const occ=(data.occurrences as R[]).filter(o=>!sel||o.os_step_id===sel.id).sort((x,y)=>Date.parse(y.registered_at)-Date.parse(x.registered_at)||String(y.id).localeCompare(String(x.id)));
 const name=(id:string)=>steps.find(s=>s.id===id)?.plan.name||'—';
 const open=(kind:Action['kind'],step?:R,item?:R)=>{setFormError('');setAction({kind,step,item,key:crypto.randomUUID()});setForm({kind:'ocorrencia',categoryId:'',description:'',reason:'',resolution:'',occurredAt:localNow(),impactEnd:kind==='resolve'?localNow():''})};
 const iso=fromLocalInput;
 async function run(path:string,body:R,done?:()=>void){setBusy(true);setFormError('');try{const r=await post(path,body);toast.success(r.message||'Registrado.');done?.();await refresh();onChanged?.()}catch(e){setFormError((e as Error).message);toast.error((e as Error).message)}finally{setBusy(false)}}
 const simple=(path:string,s:R)=>run(path,{operationKey:crypto.randomUUID(),stepId:s.id});
 async function submit(e:FormEvent){e.preventDefault();if(!action)return;const f=form,k=action.key,s=action.step;
  if(action.kind==='block')await run('ops/block',{operationKey:k,stepId:s!.id,categoryId:f.categoryId,description:f.description},()=>setAction(null));
  if(action.kind==='note')await run('ops/note',{operationKey:k,stepId:s!.id,kind:f.kind,categoryId:f.categoryId||null,description:f.description,occurredAt:iso(f.occurredAt),impactEnd:f.kind==='impacto'?iso(f.impactEnd):null},()=>setAction(null));
  if(action.kind==='pause')await run('ops/pause',{operationKey:k,stepId:s!.id,reason:f.reason},()=>setAction(null));
  if(action.kind==='finish')await run('ops/finish',{operationKey:k,stepId:s!.id,resolution:f.resolution},()=>setAction(null));
  if(action.kind==='resolve')await run('ops/resolve',{operationKey:k,id:action.item!.id,resolution:f.resolution,impactEnd:openImpact(action.item!)?iso(f.impactEnd):null},()=>setAction(null));
  if(action.kind==='dispense')await run('ops/dispense',{stepId:s!.id,reason:f.reason},()=>setAction(null));
  if(action.kind==='cancel')await run('planning/cancel',{workOrderId:order.id,version:order.version,reason:f.reason},()=>setAction(null));
 }
 const categories=(kind:string)=>(data.categories as R[]).filter(c=>c.kind===kind).map(c=>({value:c.id,label:c.name}));
 const blockedTags=new Set((data.impediments as R[]).map(i=>i.equipment_id));
 const openBlocks=(s:R)=>(data.occurrences as R[]).filter(o=>o.os_step_id===s.id&&o.blocking&&o.status==='aberto');
 const dependents=(s:R)=>steps.filter(x=>(x.plan.depends_on as string[]).includes(s.step_key)&&x.status==='nao_iniciada');

 const rulerSteps=steps.map(s=>({id:s.id,status:s.status,name:s.plan.name,planned_start:s.plan.planned_start,planned_end:s.plan.planned_end,position:s.plan.position}));
 const eff=effective(data.intervals as R[],now);
 const ps=Date.parse(order.planned_start),pe=Date.parse(order.planned_end),first=order.actual_start?Date.parse(order.actual_start):null;
 const done=steps.filter(s=>['concluida','dispensada'].includes(s.status)).length;
 const allOpenBlocks=(data.occurrences as R[]).filter(o=>o.blocking&&o.status==='aberto');
 return <>
  <div className="ap-center">
   <div className="oshead">
    <div className="row"><span className="id">{osLabel(order.number)} · {plan.free?(order.activity_code||'sem fluxo'):`${plan.activity_code} v${plan.flow_version}`}{order.origin==='realizada'?' · realizada sem planejamento':''}{order.revision?` · revisão ${order.revision}`:''}</span><span className="row" style={{gap:10}}>{active.some(s=>s.status==='bloqueada')&&<span className="st bloqueada"><i/>Etapa bloqueada</span>}<span className={`st ${order.status}`}><i/>{orderNames[order.status][0]}</span></span></div>
    <h2>{order.activity_name}</h2>
   </div>
   <dl className="facts"><div><dt>Solicitante</dt><dd><OrgOf data={data}/></dd></div><div><dt>Planejado</dt><dd><Period a={order.planned_start} b={order.planned_end}/></dd></div><div><dt>Real</dt><dd>{order.actual_start?<Period a={order.actual_start} b={order.actual_end}/>:'Não iniciada'}</dd></div><div><dt>Etapas</dt><dd>{done} de {steps.length} concluídas{order.closed_at?` · encerrada ${fmt(order.closed_at)}`:''}</dd></div></dl>
   {/* Descrição da atividade: entre o cabeçalho da OS e a régua. */}
   <section className="os-desc" aria-label="Descrição da atividade"><span className="lab">Descrição da atividade</span><p>{plan.description?.trim()||'Sem descrição informada no planejamento.'}</p></section>
   {data.impediments.length>0&&<div className="form-error"><ShieldAlert size={17}/><span>{(data.impediments as R[]).map(i=>`${i.tag} bloqueado (${i.kind==='nc_critica'?'NC crítica':'impedimento técnico'}): ${i.reason}`).join(' · ')}. Aguardando liberação técnica ou substituição pelo Planejamento.</span></div>}
   {order.status==='cancelada'&&<div className="form-error"><Ban size={17}/><span>OS cancelada{order.cancelled_at?` em ${fmt(order.cancelled_at)}`:''}: {order.cancel_reason||'sem justificativa registrada'}</span></div>}
   {order.status==='encerramento_pendente'&&<div className="notice warn"><AlertTriangle size={17}/><span>Todas as etapas terminaram. Falta concluir checklist obrigatório para encerrar a OS (aba Checklists).</span></div>}
   <OsRuler order={order} steps={rulerSteps} intervals={data.intervals as R[]} occurrences={data.occurrences as R[]} now={now} selected={sel?.id||null} onSelect={setSelected}/>
   <div className="stepchips" role="group" aria-label="Etapas"><button type="button" aria-pressed={!sel} onClick={()=>setSelected(null)}>Todas as etapas</button>{steps.map(s=><button key={s.id} type="button" aria-pressed={sel?.id===s.id} onClick={()=>setSelected(sel?.id===s.id?null:s.id)}><span className={`st ${s.status}`}><i/></span>{s.plan.name}<small className="mono">{timing(s)}</small></button>)}</div>
   {sel&&<section className="n-panel step-panel"><div className="panel-heading"><div><h2>{sel.plan.name} <Badge tone={stepNames[sel.status][1]}>{stepNames[sel.status][0]}</Badge></h2><p>{sel.plan.description||'Sem descrição.'}</p></div></div>
    <div className="step-side" style={{padding:'16px 20px',display:'grid',gap:12}}>
     <div className="resources"><b><Truck size={14} className="inline"/> Equipamentos</b>{(sel.plan.equipment_ids as string[]).length?(sel.plan.equipment_ids as string[]).map(e=><span key={e} className={blockedTags.has(e)?'blocked':''}>{tags.equipment(e)}{blockedTags.has(e)&&' · bloqueado'}</span>):<span>—</span>}
      <b><Users size={14} className="inline"/> Colaboradores</b>{(sel.plan.operator_ids as string[]).length?(sel.plan.operator_ids as string[]).map(o=><span key={o}>{tags.operator(o)}</span>):<span>—</span>}</div>
     {sel.status==='nao_iniciada'&&blockers&&blockers.length>0&&<div className="notice warn"><AlertTriangle size={17}/><div><b>Pré-requisitos para iniciar</b><ul>{blockers.map((b,i)=><li key={i}>{b}</li>)}</ul></div></div>}
     {openBlocks(sel).length>0&&<div className="form-error"><Lock size={17}/><span>{openBlocks(sel).length} bloqueio(s) aberto(s): {openBlocks(sel).map(o=>o.description).join(' · ')}</span></div>}
     {can.plan&&sel.status==='nao_iniciada'&&<button className="text-action" onClick={()=>open('dispense',sel)}>Dispensar etapa (Planejamento)</button>}
    </div>
   </section>}

  {(data.realizedUses as R[]|undefined)?.length?<section className="n-panel eu-panel"><div className="panel-heading"><div><h2>Horas de uso realizadas</h2><p>Informadas no registro da atividade realizada. As recobráveis foram para o Financeiro ligadas a esta OS.</p></div></div>
   <ul className="eu-list">{(data.realizedUses as R[]).map((u,i)=><li key={i}><div className="eu-line"><b>{u.tag}</b><span>{fmt(u.start)} → {fmt(u.end)}</span><span className="eu-dur">{Number(u.hours).toLocaleString('pt-BR')} h</span>{u.recoverable?<Badge tone="info">Recobrável</Badge>:<Badge>Não recobrável</Badge>}</div></li>)}</ul></section>:null}
  <EquipmentUses orderId={orderId} refreshKey={Date.parse(data.serverNow)} onChanged={()=>void refresh()}/>
  <Tabs defaultValue="notes"><TabsList className="n-tabs"><TabsTrigger value="notes">Apontamentos{sel?` · ${sel.plan.name}`:''}</TabsTrigger><TabsTrigger value="checklists">Checklists</TabsTrigger><TabsTrigger value="history">Histórico</TabsTrigger></TabsList>
   <TabsContent value="notes"><section className="n-panel">{occ.length?<ul className="occ-list">{occ.map(o=><li key={o.id} className={o.blocking&&o.status==='aberto'?'open':''}><div><Badge tone={o.kind==='bloqueio'?'danger':o.kind==='impacto'?'warning':'info'}>{kindNames[o.kind]}{o.kind==='impacto'&&o.blocking?' com bloqueio':''}</Badge>{openImpact(o)&&<Badge tone="warning">Em aberto</Badge>}{o.category_name&&<Badge>{o.category_name}</Badge>}{o.late?<Badge tone="warning">Registro tardio</Badge>:null}{o.impediment_id&&<Badge tone="danger">NC crítica</Badge>}<b>{o.description}</b></div>
     <small>{!sel&&<>Etapa “{name(o.os_step_id)}” · </>}Ocorrido {fmt(o.occurred_at)} · registrado {fmt(o.registered_at)} por {o.author_name}{o.severity?` · severidade ${({baixa:'baixa',media:'média',alta:'alta'} as Record<string,string>)[o.severity]||o.severity}`:''}{o.impact_start?` · impacto ${fmt(o.impact_start)} → ${o.impact_end?fmt(o.impact_end):'em aberto'}`:''}</small>
     {o.status==='resolvido'?<small className="positive">{o.resolution?<>Resolvido por {o.resolved_by_name} em {fmt(o.resolved_at)}: {o.resolution}</>:<>Encerrado no registro por {o.resolved_by_name}</>}</small>:(o.blocking||o.kind==='impacto')&&can.execute?<button className="text-action" onClick={()=>open('resolve',undefined,o)}>{o.kind==='impacto'?'Registrar solução':'Registrar resolução'}</button>:null}</li>)}</ul>
     :<Empty icon={MessageSquarePlus} title={sel?'Nenhuma ocorrência registrada nesta etapa':'Nenhum apontamento registrado'} description="Ocorrências não alteram o estado. Bloqueios param o tempo efetivo; o prazo continua correndo."/>}</section></TabsContent>
   <TabsContent value="checklists"><Checklists data={data} steps={steps} can={can.execute} onOpen={setChecklist} onRefresh={refresh} complementary={complementary} setComplementary={setComplementary} tags={tags}/></TabsContent>
   <TabsContent value="history"><section className="n-panel">{data.events.length?<ul className="event-list">{(data.events as R[]).filter(e=>!sel||e.os_step_id===sel.id).map(e=><li key={e.id}><History size={14}/><b>{eventNames[e.kind]}</b><span>{e.os_step_id?name(e.os_step_id):'OS'}</span><small>{fmt(e.occurred_at)} · {e.author_name}{e.detail?.reason?` · ${e.detail.reason}`:''}{e.detail?.equipment?` · ${e.detail.equipment}`:''}</small></li>)}</ul>:<Empty icon={History} title="Sem eventos ainda" description="Início, pausas, bloqueios, término e encerramento aparecem aqui."/>}</section></TabsContent>
  </Tabs>
  </div>
  <aside className="helm" data-st={order.status} aria-live="polite">
   <span className="state"><i/>{orderNames[order.status][0]}</span>
   <div style={{display:'grid',gap:10}}><span className="lab">Tempo efetivo da OS</span>
    <div className="clockbig clock-roll" aria-label={`Tempo efetivo ${hms(eff)}`}><Digits value={hms(eff)}/></div>
    <span className="sub">{active.length?<>{active.length} etapa(s) ativa(s) · <b>{active.filter(s=>s.status==='em_execucao').length} em execução</b></>:order.status==='programada'?`Início planejado ${fmt(order.planned_start)}`:`${done} de ${steps.length} etapas concluídas`}</span>
   </div>
   {['programada','em_andamento'].includes(order.status)&&<div className="gauge"><span className={`bar${now>pe?' over':''}`}><i style={{width:`${Math.max(0,Math.min(100,(now-ps)/Math.max(1,pe-ps)*100)).toFixed(1)}%`}}/></span><span className="cap"><span>{first?`real desde ${dmhm(order.actual_start)}`:'não iniciada'}</span><span>{now<pe?`faltam ${dur(pe-now)}`:`prazo vencido há ${dur(now-pe)}`}</span></span></div>}
   <dl><div><dt>Início planejado</dt><dd>{dmhm(order.planned_start)}</dd></div><div><dt>Fim planejado</dt><dd>{dmhm(order.planned_end)}</dd></div>
    {order.actual_start&&<div><dt>Início real</dt><dd>{dmhm(order.actual_start)}</dd></div>}{order.actual_end&&<div><dt>Fim real</dt><dd>{dmhm(order.actual_end)}</dd></div>}
    <div><dt>Etapas concluídas</dt><dd>{done}/{steps.length}</dd></div><div><dt>Bloqueios abertos</dt><dd>{allOpenBlocks.length}</dd></div><div><dt>Apontamentos</dt><dd>{(data.occurrences as R[]).length}</dd></div></dl>
   {sel?<div className="stepbox">
    <span className="lab">Etapa selecionada</span><b>{sel.plan.name} · {stepNames[sel.status][0]}</b>
    <dl style={{paddingTop:0,borderTop:0}}><div><dt>Início planejado</dt><dd>{dmhm(sel.plan.planned_start)}</dd></div><div><dt>Fim planejado</dt><dd>{dmhm(sel.plan.planned_end)}</dd></div><div><dt>Efetivo</dt><dd>{dur(sum(sel.intervals,'ativo'))}</dd></div><div><dt>Parado</dt><dd>{dur(sum(sel.intervals,'interrompido'))}</dd></div>
     <div><dt>Decorrido</dt><dd>{sel.actual_start?dur((sel.actual_end?Date.parse(sel.actual_end):now)-Date.parse(sel.actual_start)):'—'}</dd></div><div><dt>Prazo</dt><dd>{timing(sel)}</dd></div>
     {['em_execucao','bloqueada','pausada'].includes(sel.status)&&dependents(sel).length>0&&(()=>{const next=dependents(sel).sort((a,b)=>Date.parse(a.plan.planned_start)-Date.parse(b.plan.planned_start))[0];const d=Date.parse(next.plan.planned_start)-now;return <div style={{gridColumn:'1/-1'}}><dt>Próximo marco</dt><dd>{d>=0?`${dur(d)} até o início de “${next.plan.name}”`:`início de “${next.plan.name}” vencido há ${dur(-d)}`}</dd></div>})()}</dl>
    {can.execute&&<div className="acts">
     {sel.status==='nao_iniciada'&&<button type="button" className="go" disabled={busy||!!blockers?.length||order.status==='cancelada'} onClick={()=>void simple('ops/start',sel)}><span style={{display:'inline-flex',gap:8,alignItems:'center'}}><Play size={16}/>Iniciar etapa</span><ArrowRight size={16}/></button>}
     {sel.status==='em_execucao'&&<><button type="button" onClick={()=>open('pause',sel)}><Pause size={15}/>Pausar</button><button type="button" className="go" disabled={busy} onClick={()=>open('finish',sel)}><span style={{display:'inline-flex',gap:8,alignItems:'center'}}><Square size={15}/>Finalizar etapa</span><ArrowRight size={16}/></button></>}
     {['pausada','bloqueada'].includes(sel.status)&&<><button type="button" className="go" disabled={busy} onClick={()=>void simple('ops/resume',sel)}><span style={{display:'inline-flex',gap:8,alignItems:'center'}}><RotateCcw size={15}/>Retomar</span><ArrowRight size={16}/></button><button type="button" onClick={()=>open('finish',sel)}><Square size={15}/>Finalizar</button></>}
     {['nao_iniciada','em_execucao','pausada','bloqueada'].includes(sel.status)&&<button type="button" onClick={()=>open('block',sel)}><Ban size={15}/>Bloquear</button>}
     <button type="button" onClick={()=>open('note',sel)}><MessageSquarePlus size={15}/>{['concluida','dispensada'].includes(sel.status)?'Apontamento tardio':'Registrar apontamento'}</button>
    </div>}
    {sel.status==='nao_iniciada'&&blockers&&blockers.length>0&&<div className="warn"><b>Pré-requisitos para iniciar</b><ul>{blockers.map((b,i)=><li key={i}>{b}</li>)}</ul></div>}
   </div>:<div className="stepbox"><span className="lab">Etapas</span><span className="note">Escolha uma etapa na régua (passe o mouse para abrir) ou nos botões abaixo dela para iniciar, pausar, bloquear, finalizar ou registrar apontamentos.</span>
    {active.length>0&&<div className="acts">{active.map(s=><button key={s.id} type="button" onClick={()=>setSelected(s.id)}>{s.plan.name} · {stepNames[s.status][0].toLowerCase()}</button>)}</div>}</div>}
   {!can.execute&&<span className="note">Consulta: registrar execução exige o acesso “Operação”.</span>}
   <div className="links"><a href={`/relatorio/${order.id}`} target="_blank" rel="noopener"><FileText size={14}/>Relatório PDF</a>{can.cancel&&['programada','em_andamento'].includes(order.status)&&<button type="button" className="danger-link" onClick={()=>open('cancel')} title="Somente perfil Planejador ou Gestão, com justificativa"><Ban size={14}/>Cancelar OS</button>}</div>
  </aside>

  <Dialog open={!!action} onOpenChange={v=>{if(!busy&&!v)setAction(null)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Clock size={16}/> {osLabel(order.number)}{action?.step?` · ${action.step.plan.name}`:''}</div><DialogTitle>{{block:'Bloquear etapa',note:'Registrar apontamento',pause:'Pausar etapa',finish:'Finalizar etapa',resolve:action?.item?.kind==='impacto'?'Registrar solução do impacto':'Registrar resolução',dispense:'Dispensar etapa',cancel:'Cancelar OS'}[action?.kind||'block']}</DialogTitle><DialogDescription>{action?.kind==='cancel'?(order.status==='em_andamento'?'A OS já começou: as etapas abertas serão encerradas agora como canceladas, os períodos de trabalho ficam registrados e os equipamentos são liberados. Não pode ser desfeito.':'A OS deixa de valer e as reservas de equipamento são liberadas. Não pode ser desfeito.'):action?.kind==='block'?'Interrompe o tempo efetivo da etapa; o prazo continua correndo. A retomada exige resolver o bloqueio.':action?.kind==='finish'?'Registra o término real agora. Etapa bloqueada só termina informando como o impedimento foi resolvido.':action?.kind==='dispense'?'A etapa não será executada. Dependentes deixam de esperar por ela e as reservas dela são liberadas.':action?.kind==='resolve'?(action.item?.kind==='impacto'?'A solução e o fim do impacto ficam registrados no apontamento.':'A resolução fica registrada. Retomar a etapa é uma ação separada.'):'O registro fica ligado à etapa e não pode ser apagado.'}</DialogDescription></DialogHeader>
   {action&&<form onSubmit={submit}><div className="form-grid">
    {action.kind==='note'&&<><Field label="Tipo *"><Choice value={form.kind} onChange={v=>setForm(f=>({...f,kind:v,categoryId:''}))} options={[{value:'ocorrencia',label:'Ocorrência'},{value:'impacto',label:'Impacto'}]}/></Field><Field label="Categoria"><Choice value={form.categoryId} onChange={v=>setForm(f=>({...f,categoryId:v}))} options={categories(form.kind)} placeholder="Opcional"/></Field>
     <Field label="Quando ocorreu (Brasília)" hint="Pode ser anterior ao registro."><Input type="datetime-local" value={form.occurredAt} onChange={e=>setForm(f=>({...f,occurredAt:e.target.value}))}/></Field>
     {form.kind==='impacto'&&<Field label="Fim do impacto (Brasília)" hint="Opcional. Em branco, o impacto fica em aberto e a solução é registrada depois."><Input type="datetime-local" value={form.impactEnd} onChange={e=>setForm(f=>({...f,impactEnd:e.target.value}))}/></Field>}</>}
    {action.kind==='block'&&<Field label="Categoria do bloqueio *" wide><Choice value={form.categoryId} onChange={v=>setForm(f=>({...f,categoryId:v}))} options={categories('bloqueio')} placeholder={categories('bloqueio').length?'Selecione':'Cadastre categorias em Cadastros gerais'}/></Field>}
    {(action.kind==='block'||action.kind==='note')&&<Field label={action.kind==='block'||(form.kind==='impacto'&&form.blocking)?'Justificativa do bloqueio *':'Descrição *'} wide><Textarea required maxLength={2000} value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))}/></Field>}
    {(action.kind==='pause'||action.kind==='dispense'||action.kind==='cancel')&&<Field label={action.kind==='pause'?'Justificativa da pausa *':action.kind==='cancel'?'Justificativa do cancelamento *':'Motivo da dispensa *'} wide><Textarea required maxLength={1200} value={form.reason} onChange={e=>setForm(f=>({...f,reason:e.target.value}))}/></Field>}
    {action.kind==='resolve'&&openImpact(action.item!)&&<Field label="Fim do impacto (Brasília) *" hint="Pode ser anterior ao registro."><Input required type="datetime-local" value={form.impactEnd} onChange={e=>setForm(f=>({...f,impactEnd:e.target.value}))}/></Field>}
    {(action.kind==='resolve'||(action.kind==='finish'&&(action.step!.status==='bloqueada'||openBlocks(action.step!).length>0)))&&<Field label={action.kind==='resolve'?'Como foi resolvido *':'Como o impedimento foi resolvido ou como ocorreu a interrupção final *'} wide><Textarea required maxLength={1200} value={form.resolution} onChange={e=>setForm(f=>({...f,resolution:e.target.value}))}/></Field>}
    {action.kind==='finish'&&action.step!.status!=='bloqueada'&&!openBlocks(action.step!).length&&<p className="wide notice"><CheckCircle2 size={16}/> Término registrado com o horário do servidor no momento da confirmação.</p>}
   </div>{formError&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{formError}</div>}<div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setAction(null)} disabled={busy}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy}>{busy?<LoaderCircle className="animate-spin" size={16}/>:null} Confirmar</Button></div></form>}
  </DialogContent></Dialog>
  {checklist&&<ChecklistFill instanceId={checklist} data={data} steps={steps} can={can.execute} tags={tags} onClose={()=>{setChecklist(null);void refresh()}} onSaved={refresh}/>}
 </>;
}

function useTags(data:R|null){
 return useMemo(()=>{const eq=new Map<string,string>(),op=new Map<string,string>();for(const s of (data?.plan?.steps||[]) as R[]){for(const r of s.reservations||[])eq.set(r.equipment_id,r.equipment_id)}
  for(const i of (data?.impediments||[]) as R[])eq.set(i.equipment_id,i.tag);for(const t of (data?.equipmentTags||[]) as R[])eq.set(t.id,t.tag);for(const o of (data?.operatorNames||[]) as R[])op.set(o.id,o.name);
  return {equipment:(id:string)=>eq.get(id)||id,operator:(id:string)=>op.get(id)||id}},[data]);
}
function OrgOf({data}:{data:R}){return <OrgTag org={(data.orgs as R[]|undefined)?.find(o=>o.id===data.order.org_id)}/>}

function Checklists({data,steps,can,onOpen,onRefresh,complementary,setComplementary,tags}:{data:R,steps:R[],can:boolean,onOpen:(id:string)=>void,onRefresh:()=>Promise<void>,complementary:R,setComplementary:(f:(x:R)=>R)=>void,tags:{equipment:(id:string)=>string}}){
 const [busy,setBusy]=useState(false);
 const instances=data.instances as R[];
 async function start(body:R){setBusy(true);try{const r=await post('ops/checklist/start',{operationKey:crypto.randomUUID(),...body});await onRefresh();onOpen(r.id)}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 const status=(i?:R)=>!i?<Badge>Pendente</Badge>:i.status==='concluido'?<Badge tone="success">Concluído{i.answers.filter((a:R)=>a.answer==='NC').length?` · ${i.answers.filter((a:R)=>a.answer==='NC').length} NC`:''}</Badge>:<Badge tone="warning">Em preenchimento</Badge>;
 const used=[...new Set(steps.flatMap(s=>s.plan.equipment_ids as string[]))];
 return <section className="n-panel">
  <div className="panel-heading"><div><h2>Checklists previstos</h2><p>Versões fixadas no lançamento. Obrigatórios de pré-atividade/pré-uso impedem o início; os demais obrigatórios impedem o encerramento.</p></div></div>
  {data.requirements.length?<ul className="ck-list">{(data.requirements as R[]).map(r=>{const i=instances.find(x=>x.requirement_id===r.id);return <li key={r.id}><div><b>{r.title}</b><small>{r.code} v{r.version} · {moments[r.moment]}{r.equipment_id?` · ${tags.equipment(r.equipment_id)}`:''}</small></div>{r.waived_at?<Badge>Não se aplica · {r.waived_reason}</Badge>:r.mandatory?<Badge tone="danger">Obrigatório</Badge>:<Badge>Opcional</Badge>}{status(i)}{i?<Button size="sm" variant="outline" onClick={()=>onOpen(i.id)}>{i.status==='concluido'?'Ver':'Continuar'}</Button>:can&&!r.waived_at&&<Button size="sm" disabled={busy} onClick={()=>void start({workOrderId:data.order.id,requirementId:r.id})}><ListChecks size={14}/> Preencher</Button>}</li>})}</ul>:<Empty icon={ListChecks} title="Nenhum checklist previsto" description="Esta OS não tem checklist vinculado ao tipo de atividade ou aos equipamentos."/>}
  {instances.filter(i=>!i.requirement_id).length>0&&<><div className="panel-heading"><h2>Complementares</h2></div><ul className="ck-list">{instances.filter(i=>!i.requirement_id).map(i=><li key={i.id}><div><b>{i.title}</b><small>{i.code} v{i.version} · {moments[i.moment]}{i.equipment_id?` · ${tags.equipment(i.equipment_id)}`:''}{i.os_step_id?` · ${steps.find(s=>s.id===i.os_step_id)?.plan.name}`:''}</small></div>{status(i)}<Button size="sm" variant="outline" onClick={()=>onOpen(i.id)}>{i.status==='concluido'?'Ver':'Continuar'}</Button></li>)}</ul></>}
  {can&&data.complementary.length>0&&<div className="filters"><Choice label="Checklist complementar" value={complementary.templateId||''} onChange={v=>setComplementary(x=>({...x,templateId:v}))} options={(data.complementary as R[]).map(c=>({value:c.template_id,label:`${c.code} · ${c.title}`}))} placeholder="Checklist complementar"/><Choice label="Equipamento" value={complementary.equipmentId||'none'} onChange={v=>setComplementary(x=>({...x,equipmentId:v==='none'?'':v}))} options={[{value:'none',label:'Sem equipamento'},...used.map(e=>({value:e,label:tags.equipment(e)}))]}/><Choice label="Etapa" value={complementary.stepId||'none'} onChange={v=>setComplementary(x=>({...x,stepId:v==='none'?'':v}))} options={[{value:'none',label:'OS inteira'},...steps.map(s=>({value:s.id,label:s.plan.name}))]}/><Button disabled={busy||!complementary.templateId} onClick={()=>void start({workOrderId:data.order.id,templateId:complementary.templateId,equipmentId:complementary.equipmentId||null,stepId:complementary.stepId||null})}><ListChecks size={15}/> Iniciar</Button></div>}
 </section>;
}

function ChecklistFill({instanceId,data,steps,can,tags,onClose,onSaved}:{instanceId:string,data:R,steps:R[],can:boolean,tags:{equipment:(id:string)=>string},onClose:()=>void,onSaved:()=>Promise<void>}){
 const inst=(data.instances as R[]).find(i=>i.id===instanceId);
 const questions=(data.questions as R[]).filter(q=>q.version_id===inst?.version_id);
 const [notes,setNotes]=useState<Record<string,string>>(()=>Object.fromEntries((inst?.answers||[]).map((a:R)=>[a.question_id,a.note])));
 const [target,setTarget]=useState<R>({equipmentId:'',stepId:''}),[saving,setSaving]=useState<string|null>(null),[err,setErr]=useState('');
 if(!inst)return null;
 const readOnly=inst.status==='concluido'||!can;
 const answerOf=(q:R)=>(inst.answers as R[]).find(a=>a.question_id===q.id);
 const used=[...new Set(steps.flatMap(s=>s.plan.equipment_ids as string[]))];
 async function answer(q:R,value:string){setSaving(q.id);setErr('');try{const r=await post('ops/checklist/answer',{operationKey:crypto.randomUUID(),instanceId,questionId:q.id,answer:value,note:notes[q.id]||'',equipmentId:target.equipmentId||null,stepId:target.stepId||null});if(r.message&&r.message!=='Resposta salva.')toast.warning(r.message);await onSaved()}catch(e){setErr((e as Error).message)}finally{setSaving(null)}}
 async function complete(){setErr('');try{const r=await post('ops/checklist/complete',{operationKey:crypto.randomUUID(),instanceId});toast.success(r.message);onClose()}catch(e){setErr((e as Error).message)}}
 const needsEquipment=!inst.equipment_id&&questions.some(q=>q.critical&&q.target==='equipamento');
 const needsStep=!inst.os_step_id&&questions.some(q=>q.critical&&q.target==='atividade');
 const answered=(inst.answers as R[]).length,nc=(inst.answers as R[]).filter(a=>a.answer==='NC').length;
 return <Dialog open onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="n-dialog n-dialog-wide"><DialogHeader><div className="modal-eyebrow"><ListChecks size={16}/> {inst.code} v{inst.version}{inst.equipment_id?` · ${tags.equipment(inst.equipment_id)}`:''}</div><DialogTitle>{inst.title}</DialogTitle><DialogDescription>{readOnly?`Concluído por ${inst.completed_by_name||'—'}${inst.completed_at?' em '+fmt(inst.completed_at):''}. As respostas não podem mais ser alteradas.`:'Cada resposta é salva na hora. Resposta vazia não é N/A. NC em pergunta crítica de equipamento bloqueia o equipamento imediatamente.'}</DialogDescription></DialogHeader>
  <div className="ck-summary"><span>{answered}/{questions.length} respondidas</span>{nc>0&&<Badge tone="danger">{nc} NC</Badge>}</div>
  {!readOnly&&(needsEquipment||needsStep)&&<div className="form-grid ck-target">{needsEquipment&&<Field label="Equipamento avaliado (para NC crítica)"><Choice value={target.equipmentId} onChange={v=>setTarget(t=>({...t,equipmentId:v}))} options={used.map(e=>({value:e,label:tags.equipment(e)}))}/></Field>}{needsStep&&<Field label="Etapa afetada (para NC crítica da atividade)"><Choice value={target.stepId} onChange={v=>setTarget(t=>({...t,stepId:v}))} options={steps.map(s=>({value:s.id,label:s.plan.name}))}/></Field>}</div>}
  <ol className="ck-questions">{questions.map(q=>{const a=answerOf(q);const needNote=a&&(q.note_on as string[]).includes(a.answer);return <li key={q.id} className={a?.answer==='NC'?'nc':''}>
   <div className="ck-q"><b>{q.position}. {q.text}</b>{q.critical?<Badge tone="danger">Crítica{q.target==='equipamento'?' · equipamento':''}</Badge>:null}{q.required?null:<Badge>Opcional</Badge>}</div>
   <div className="segmented" role="group" aria-label={`Resposta da pergunta ${q.position}`}>{['C','NC',...(q.allow_na?['NA']:[])].map(v=><button key={v} type="button" disabled={readOnly||saving===q.id} aria-pressed={a?.answer===v} onClick={()=>void answer(q,v)}>{v==='NA'?'N/A':v}</button>)}{saving===q.id&&<LoaderCircle size={14} className="animate-spin"/>}</div>
   {(a||!readOnly)&&<Input aria-label={`Observação da pergunta ${q.position}`} disabled={readOnly} maxLength={1200} placeholder={needNote?'Observação obrigatória para esta resposta':'Observação (opcional)'} value={notes[q.id]??''} onChange={e=>setNotes(n=>({...n,[q.id]:e.target.value}))} onBlur={()=>{if(a&&(notes[q.id]||'')!==a.note)void answer(q,a.answer)}}/>}
   {needNote&&!a.note&&<small className="danger-text">Observação obrigatória para {a.answer==='NA'?'N/A':a.answer}.</small>}
  </li>})}</ol>
  {err&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{err}</div>}
  <div className="modal-footer"><Button variant="outline" onClick={onClose}>Fechar</Button>{!readOnly&&<Button className="primary-action" onClick={()=>void complete()}><CheckCircle2 size={16}/> Concluir checklist</Button>}</div>
 </DialogContent></Dialog>;
}
