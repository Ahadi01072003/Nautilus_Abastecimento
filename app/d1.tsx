'use client';
// Planejamento › Programação do dia. Aba Dia: as duas barras (Equinor e OCP) lado a lado, cada uma com a barra de HH
// (janelas do dia, limite, trecho Extra), a duração programada, a lista ordenável das OS (Emergencial, Rascunho, Sem
// duração), o ajuste do HH do dia, os recursos e o adiar com prévia. Consolidação da reunião das 16h (participantes,
// observações, versões) e modo reunião em tela cheia. Aba Indicadores: cumprimento, ocupação, precisão e emergenciais,
// do dia e do mês, com Excel. Azul-marinho e vermelho identificam a barra; o estado também tem ícone e texto.
import {useCallback,useEffect,useRef,useState,type DragEvent} from 'react';
import {ChevronLeft,ChevronRight,GripVertical,ArrowUp,ArrowDown,CalendarClock,TriangleAlert,CheckCircle2,LoaderCircle,Truck,Users,RefreshCw,Tv,ClipboardList,Settings2,Maximize2,Minimize2,FileText,Siren,X,Download,Clock,Package} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Badge,Empty,Field,post,load,type R} from './kit';
import {dayOf,dayText} from '@/lib/days';
import './d1.css';

const BARS=['equinor','ocp'] as const;
const WEEK=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const plus=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86_400_000).toISOString().slice(0,10);
const wd=(d:string)=>new Date(Date.parse(d+'T12:00:00Z')).getUTCDay();
const h=(n:number|null|undefined)=>n==null?'—':Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const at=(iso:string)=>new Date(iso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

export default function D1View({manager=false}:{manager?:boolean}){
 const [today]=useState(()=>dayOf(Date.now()));
 const [tab,setTab]=useState<'dia'|'indicadores'>('dia');
 const [day,setDay]=useState(()=>plus(today,1));
 const [data,setData]=useState<Record<string,R>|null>(null),[error,setError]=useState('');
 const [meeting,setMeeting]=useState(false),[journeys,setJourneys]=useState(false);
 const [view,setView]=useState<string|null>(null);
 const root=useRef<HTMLDivElement>(null);
 const refresh=useCallback(async()=>{
  try{const [e,o]=await Promise.all(BARS.map(b=>load<R>(`planning/d1?bar=${b}&day=${day}`)));setData({equinor:e,ocp:o});setError('')}
  catch(e){setError((e as Error).message)}
 },[day]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega o dia ao trocar de dia.
 useEffect(()=>{if(tab==='dia')void refresh()},[refresh,tab]);
 // Barra que a tela mostra: a escolhida (lembrada) ou, na primeira vez, a do planejador; a Gestão vê as duas.
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Lê a escolha lembrada.
 useEffect(()=>{try{const v=localStorage.getItem('nautilus.pd.view');if(v==='equinor'||v==='ocp'||v==='ambas')setView(v);}catch{}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Primeira vez: a barra do planejador.
 useEffect(()=>{if(view||!data)return;const mine=(data.equinor.myBars||[]) as string[];setView(mine.length===1?mine[0]:'ambas');},[view,data]);
 const choose=(v:string)=>{setView(v);try{localStorage.setItem('nautilus.pd.view',v)}catch{}};
 const shown=(view==='equinor'||view==='ocp'?[view]:BARS) as readonly string[];
 useEffect(()=>{const f=()=>setMeeting(!!document.fullscreenElement);document.addEventListener('fullscreenchange',f);return()=>document.removeEventListener('fullscreenchange',f);},[]);
 const toggleMeeting=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await root.current?.requestFullscreen();}catch{setMeeting(m=>!m);}};
 const quick=[{d:today,l:'Hoje'},{d:plus(today,1),l:'Amanhã'},...(wd(today)===5?[{d:plus(today,2),l:'Sábado'},{d:plus(today,3),l:'Domingo'},{d:plus(today,4),l:'Segunda'}]:[]),...(wd(today)===6?[{d:plus(today,2),l:'Segunda'}]:[])];
 return <div ref={root} className={`pd-screen ${meeting?'meeting':''}`}>
  <section className="n-panel pd-head">
   <div className="segmented pd-tabs" role="group" aria-label="Visão">
    <button type="button" aria-pressed={tab==='dia'} className={tab==='dia'?'active':''} onClick={()=>setTab('dia')}>Dia</button>
    <button type="button" aria-pressed={tab==='indicadores'} className={tab==='indicadores'?'active':''} onClick={()=>setTab('indicadores')}>Indicadores</button>
   </div>
   <div className="segmented pd-tabs" role="group" aria-label="Barra">{[['equinor','Equinor'],['ocp','OCP'],['ambas','Ambas']].map(([k,l])=><button key={k} type="button" aria-pressed={(view||'ambas')===k} className={(view||'ambas')===k?'active':''} onClick={()=>choose(k)}>{k!=='ambas'&&<span className={`pd-dot ${k}`}/>}{l}</button>)}</div>
   {tab==='dia'&&<div className="pd-day">
    <Button variant="outline" size="icon" aria-label="Dia anterior" onClick={()=>setDay(plus(day,-1))}><ChevronLeft size={16}/></Button>
    <Input type="date" aria-label="Dia" value={day} onChange={e=>e.target.value&&setDay(e.target.value)}/>
    <Button variant="outline" size="icon" aria-label="Próximo dia" onClick={()=>setDay(plus(day,1))}><ChevronRight size={16}/></Button>
    {quick.map(q=><button key={q.d} type="button" className={`pd-chip ${day===q.d?'on':''}`} onClick={()=>setDay(q.d)}>{q.l}</button>)}
    <Button variant="ghost" size="icon" aria-label="Atualizar" onClick={()=>void refresh()}><RefreshCw size={16}/></Button>
    <Button variant="outline" onClick={()=>void toggleMeeting()}>{meeting?<Minimize2 size={15}/>:<Maximize2 size={15}/>} {meeting?'Sair do modo reunião':'Modo reunião'}</Button>
    {manager&&<Button variant="ghost" onClick={()=>setJourneys(true)}><Settings2 size={15}/> Jornadas</Button>}
   </div>}
  </section>
  {tab==='indicadores'?<IndicatorsTab key={view||'x'} today={today} initialBar={view==='ocp'?'ocp':'equinor'}/>
  :error&&!data?<div className="error-panel"><TriangleAlert/><h2>Programação indisponível</h2><p>{error}</p></div>
  :!data?<Skeleton className="h-72 rounded-xl"/>
  :<>
   <h2 className="pd-title">{WEEK[wd(day)]}, {dayText(day)}</h2>
   <div className={`pd-bars n${shown.length}`}>{shown.map(b=><BarColumn key={b} bar={b} day={day} data={data[b]} onRefresh={()=>void refresh()}/>)}</div>
  </>}
  {journeys&&<JourneysDialog onClose={()=>setJourneys(false)} onDone={()=>{setJourneys(false);void refresh();}}/>}
 </div>;
}

/** Barra de HH: trechos das janelas do dia como régua, preenchimento até o limite e trecho Extra além dele. */
function HhBar({staff,demand}:{staff:R,demand:number}){
 const cap=Number(staff.hh),scale=Math.max(cap,demand)||1,fill=Math.min(demand,cap),extra=Math.max(0,demand-cap);
 const pct=cap>0?Math.round(demand/cap*100):null;
 const wins=staff.windows as R[],cuts=wins.slice(0,-1).map((_,i)=>wins.slice(0,i+1).reduce((t,w)=>t+Number(w.hh),0));
 const cutAt=(x:number)=>(staff.source==='dia'?x/Number(staff.computedHh||1)*cap:x)/scale*100;
 return <div className="pd-hh">
  <div className="pd-hh-top"><b>{h(demand)}</b><span>de {h(cap)} HH{pct!=null?` · ${pct}%`:''}</span>{extra>0&&<em><TriangleAlert size={14}/> + {h(extra)} HH extra</em>}</div>
  <div className="pd-track" role="img" aria-label={`${h(demand)} de ${h(cap)} HH${extra>0?`, ${h(extra)} HH além do limite`:''}`}>
   <span className="fill" style={{width:`${fill/scale*100}%`}}/>
   {extra>0&&<span className="extra" style={{left:`${cap/scale*100}%`,width:`${extra/scale*100}%`}}/>}
   {cuts.map((x,i)=><i key={i} className="cut" style={{left:`${cutAt(x)}%`}}/>)}
  </div>
  <div className="pd-windows">{(staff.windows as R[]).map(w=><span key={w.label}>{w.label} · {(w.groups as string[]).join(' + ')} · <b>{h(w.hh)} HH</b></span>)}
   {!(staff.windows as R[]).length&&<span className="pending-text">Sem expediente neste dia (ou sem equipe com escala no cadastro).</span>}</div>
 </div>;
}

function BarColumn({bar,day,data,onRefresh}:{bar:string,day:string,data:R,onRefresh:()=>void}){
 const [busy,setBusy]=useState(false),[postpone,setPostpone]=useState<R|null>(null),[adjust,setAdjust]=useState(false),[consolidating,setConsolidating]=useState(false);
 const cons=data.consolidation as R|null;
 const [dragging,setDragging]=useState<string|null>(null),[over,setOver]=useState<string|null>(null);
 const cards=(data.cards||[]) as R[],staff=data.staff as R,firstOver=cards.findIndex(c=>c.exceeds);
 async function saveOrder(ids:string[]){setBusy(true);try{await post('planning/d1/order',{bar,day,order:ids});onRefresh();}catch(e){toast.error((e as Error).message);onRefresh();}finally{setBusy(false)}}
 const move=(i:number,d:number)=>{const ids=cards.map(c=>c.planId);const j=i+d;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];void saveOrder(ids);};
 function drop(e:DragEvent,target:string){
  e.preventDefault();setOver(null);
  if(!dragging||dragging===target){setDragging(null);return;}
  const ids=cards.map(c=>c.planId).filter(x=>x!==dragging),idx=ids.indexOf(target);ids.splice(idx,0,dragging);setDragging(null);void saveOrder(ids);
 }
 const r=data.resources as R;
 return <section className={`n-panel pd-bar bar-${bar} ${data.over?'is-over':''}`}>
  <header className="pd-bar-head"><h3><span className={`pd-dot ${bar}`}/>{data.bar.name}</h3><span className="pd-count">{cards.length} OS{data.drafts?` · ${data.drafts} rascunho${data.drafts>1?'s':''}`:''}</span></header>
  <div className={`pd-cons ${cons&&!cons.changed?'done':''}`}>
   {!cons?<p><Badge tone="muted">Não consolidado</Badge> Na reunião das 16h, ordene, ajuste e consolide.</p>
    :<p><Badge tone={cons.changed?'warning':'success'}>{cons.changed?'Mudou depois da consolidação':'Consolidado'}</Badge> Versão {cons.version} · {at(cons.at)} · {cons.by} · {(cons.participants as string[]).join(', ')}</p>}
   <div className="pd-cons-actions">
    {cons&&<a href={`/programacao/relatorio?bar=${bar}&day=${day}`} target="_blank" rel="noopener"><FileText size={14}/> Relatório (PDF)</a>}
    <a href={`/programacao?bar=${bar}&day=${day}`} target="_blank" rel="noopener"><Tv size={14}/> TV e celular</a>
    {(!cons||cons.changed)&&<Button size="sm" onClick={()=>setConsolidating(true)}><CheckCircle2 size={15}/> {cons?`Consolidar de novo (v${cons.version+1})`:'Consolidar'}</Button>}
   </div>
  </div>
  <HhBar staff={staff} demand={Number(data.demandHh)}/>
  <div className="pd-meta">
   <span><Clock size={14}/> Duração programada: <b>{h(data.durationTotal)} h</b></span>
   {data.longest&&<span className="pd-warn"><TriangleAlert size={14}/> {data.longest.title}: {h(data.longest.hours)} h passa da jornada do dia ({h(data.longest.limit)} h)</span>}
  </div>
  <div className="pd-adjust">
   {staff.source==='dia'?<small>HH ajustado por {staff.byName}: <b>{h(staff.hh)} HH</b> (calculado {h(staff.computedHh)}){staff.note?` · ${staff.note}`:''} · <button type="button" className="text-action" onClick={()=>void post('planning/d1/staff',{bar,day,hh:''}).then(x=>{toast.success(x.message);onRefresh();},e=>toast.error((e as Error).message))}>Voltar ao calculado</button></small>
    :<small>HH calculado pelo cadastro e pela escala ({staff.people.adm} ADM{staff.turnoOfDay?` · ${staff.people.turno} do ${staff.turnoOfDay==='turno_a'?'Turno A':'Turno B'}`:''}). <button type="button" className="text-action" onClick={()=>setAdjust(true)}>Ajustar HH do dia</button></small>}
  </div>
  {busy&&<LoaderCircle className="spin pd-busy" size={18}/>}
  {cards.length?<ol className="pd-list">{cards.map((c,i)=><li key={c.planId}>
   {i===firstOver&&<div className="pd-line" role="separator"><TriangleAlert size={14}/> Daqui para baixo passa do HH disponível</div>}
   <article className={`pd-card ${c.exceeds?'exceeds':''} ${c.emergency?'emergency':''} ${over===c.planId?'drop':''} ${c.status}`} draggable={!busy}
    onDragStart={e=>{setDragging(c.planId);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>{setDragging(null);setOver(null);}}
    onDragOver={e=>{if(dragging){e.preventDefault();setOver(c.planId);}}} onDrop={e=>drop(e,c.planId)}>
    <div className="pd-handle"><GripVertical size={16} aria-hidden/><b>{i+1}</b>
     <button type="button" aria-label={`Subir ${c.label}`} disabled={busy||i===0} onClick={()=>move(i,-1)}><ArrowUp size={14}/></button>
     <button type="button" aria-label={`Descer ${c.label}`} disabled={busy||i===cards.length-1} onClick={()=>move(i,1)}><ArrowDown size={14}/></button></div>
    <div className="pd-body">
     <div className="pd-card-top"><span className="pd-os">{c.label}</span>
      {c.emergency&&<Badge tone="danger"><Siren size={11}/> Emergencial</Badge>}
      {c.status==='rascunho'&&<Badge tone="warning">{c.number!=null?'Revisão em rascunho':'Não entra na consolidação'}</Badge>}
      {c.noDuration&&<Badge tone="warning">Sem duração</Badge>}
      {c.org?.acronym&&<span className="pd-org" style={{borderColor:c.org.color||undefined}}>{c.org.acronym}</span>}
      <span className="pd-days">{c.firstDay===c.lastDay?dayText(c.firstDay):`${dayText(c.firstDay)} a ${dayText(c.lastDay)}`}{c.skipSunday?' · sem domingo':''}</span></div>
     <h4>{c.title}</h4>
     <div className="pd-needs">{(c.byFunction as R[]).map(f=><span key={f.functionId}><Users size={12}/> {f.people}× {f.name}</span>)}
      {(c.equipment as R[]).map(e=><span key={e.id}><Truck size={12}/> {e.tag}</span>)}</div>
    </div>
    <div className="pd-side"><b>{h(c.hh)} HH</b><small>{h(c.hours)} h × {c.people} pessoa{c.people===1?'':'s'}</small>
     <Button size="sm" variant="ghost" disabled={c.started} title={c.started?'OS já iniciada: ajuste pela revisão da OS.':undefined} onClick={()=>setPostpone(c)}><CalendarClock size={14}/> Adiar</Button></div>
   </article></li>)}</ol>
  :<Empty icon={CalendarClock} title="Nenhuma OS neste dia" description={`Nada planejado para a barra ${data.bar.name} em ${dayText(day)}.`}/>}
  <details className="pd-res"><summary><Package size={14}/> Recursos do dia</summary>
   <div className="pd-res-grid">
    <div><b>Funções</b><ul>{(r.functions as R[]).map(f=><li key={f.name}>{f.name} · {f.activities} atividade{f.activities>1?'s':''} · até {f.maxPeople} por vez</li>)}{!(r.functions as R[]).length&&<li className="muted-text">—</li>}</ul></div>
    <div><b>Equipamentos</b><ul>{(r.equipment as R[]).map(e=><li key={e.tag} className={e.over||e.impeded?'warn':''}>{e.tag} · {e.activities} atividade{e.activities>1?'s':''} · {h(e.hours)} h{e.over?' · passa da jornada':''}{e.impeded?' · impedimento técnico':''}</li>)}{!(r.equipment as R[]).length&&<li className="muted-text">—</li>}</ul></div>
    <div><b>Materiais</b><ul>{(r.materials as R[]).map(m=><li key={m.name+m.unit}>{m.name} · {h(m.amount)} {m.unit}</li>)}{!(r.materials as R[]).length&&<li className="muted-text">—</li>}</ul>
     <a href={`/separacao?bar=${bar}&day=${day}`} target="_blank" rel="noopener"><ClipboardList size={13}/> Lista de separação</a></div>
   </div>
  </details>
  {postpone&&<PostponeDialog card={postpone} onClose={()=>setPostpone(null)} onDone={()=>{setPostpone(null);onRefresh();}}/>}
  {consolidating&&<ConsolidateDialog bar={bar} barName={data.bar.name} day={day} version={cons?Number(cons.version)+1:1} onClose={()=>setConsolidating(false)} onDone={()=>{setConsolidating(false);onRefresh();}}/>}
  {adjust&&<AdjustDialog bar={bar} day={day} staff={staff} onClose={()=>setAdjust(false)} onDone={()=>{setAdjust(false);onRefresh();}}/>}
 </section>;
}

function AdjustDialog({bar,day,staff,onClose,onDone}:{bar:string,day:string,staff:R,onClose:()=>void,onDone:()=>void}){
 const [hh,setHh]=useState(String(staff.hh).replace('.',',')),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
 async function go(){setBusy(true);try{const r=await post('planning/d1/staff',{bar,day,hh,note});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Ajustar HH de {dayText(day)}</DialogTitle>
  <DialogDescription>Calculado pelo cadastro e pela escala: {h(staff.computedHh)} HH. Use quando o dia for diferente (falta, férias, reforço).</DialogDescription></DialogHeader>
  <div className="form-grid">
   <Field label="HH disponível do dia *"><Input inputMode="decimal" value={hh} onChange={e=>setHh(e.target.value.replace(/[^\d,.]/g,''))}/></Field>
   <Field label="Motivo" wide><Input maxLength={300} value={note} onChange={e=>setNote(e.target.value)} placeholder="Ex.: 2 de férias no Turno B"/></Field>
  </div>
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy||hh===''} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Salvar</Button></div>
 </DialogContent></Dialog>;
}

function ConsolidateDialog({bar,barName,day,version,onClose,onDone}:{bar:string,barName:string,day:string,version:number,onClose:()=>void,onDone:()=>void}){
 const [people,setPeople]=useState<string[]>([]),[name,setName]=useState(''),[notes,setNotes]=useState(''),[busy,setBusy]=useState(false);
 const add=()=>{const n=name.trim().replace(/\s+/g,' ');if(n.length>=2&&!people.includes(n))setPeople(p=>[...p,n]);setName('');};
 async function go(){setBusy(true);try{const r=await post('planning/d1/consolidate',{bar,day,participants:people,notes});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Consolidar {barName} · {dayText(day)}{version>1?` · versão ${version}`:''}</DialogTitle>
  <DialogDescription>Grava a barra {barName} como está agora (lista, ordem, HH e recursos) e gera o relatório. OS que entrar neste dia depois disso fica marcada como Emergencial.</DialogDescription></DialogHeader>
  <div className="pd-consolidate">
   <label htmlFor="pd-person">Participantes da reunião *</label>
   <div className="pd-person-row"><Input id="pd-person" maxLength={120} value={name} placeholder="Nome e Enter" onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();add();}}}/><Button type="button" variant="outline" onClick={add}>Incluir</Button></div>
   {people.length>0&&<div className="pd-people">{people.map(p=><span key={p}>{p}<button type="button" aria-label={`Remover ${p}`} onClick={()=>setPeople(x=>x.filter(y=>y!==p))}><X size={12}/></button></span>)}</div>}
   <Field label="Observações da reunião" wide><Textarea maxLength={2000} rows={3} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Ex.: priorizar a carga do PSV; aguardar liberação do cliente para a OS 000124"/></Field>
  </div>
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy||!people.length} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Consolidar</Button></div>
 </DialogContent></Dialog>;
}

function PostponeDialog({card,onClose,onDone}:{card:R,onClose:()=>void,onDone:()=>void}){
 const [days,setDays]=useState(1),[preview,setPreview]=useState<R|null>(null),[error,setError]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const seq=useRef(0);
 useEffect(()=>{const n=++seq.current;load<R>(`planning/d1/preview?plan=${encodeURIComponent(card.planId)}&days=${days}`).then(p=>{if(n===seq.current){setPreview(p);setError('')}},e=>{if(n===seq.current)setError((e as Error).message)});},[card.planId,days]);
 const launched=card.status==='lancada';
 async function go(){setBusy(true);try{const r=await post('planning/d1/postpone',{plan:card.planId,days,reason});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 const p=preview;
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog pd-dialog"><DialogHeader><DialogTitle>Adiar {card.label}</DialogTitle>
  <DialogDescription>{card.title}. {launched?'OS lançada: o adiamento gera a revisão da OS com as novas datas e o motivo.':'Rascunho: as datas mudam direto.'}</DialogDescription></DialogHeader>
  <div className="pd-postpone">
   <div className="segmented" role="group" aria-label="Dias">{[1,2,3,7].map(n=><button key={n} type="button" className={days===n?'active':''} aria-pressed={days===n} onClick={()=>setDays(n)}>+{n} dia{n>1?'s':''}</button>)}</div>
   {error?<p className="form-error">{error}</p>:!p?<Skeleton className="h-24 rounded-lg"/>:<>
    <p><b>{p.from.first===p.from.last?dayText(p.from.first):`${dayText(p.from.first)} a ${dayText(p.from.last)}`}</b> → <b>{p.to.first===p.to.last?dayText(p.to.first):`${dayText(p.to.first)} a ${dayText(p.to.last)}`}</b></p>
    {p.blocked&&<p className="form-error">{p.blocked}</p>}
    <ul className="pd-preview">{(p.days as R[]).map(d=><li key={d.day} className={d.over?'bad':''}><span>{WEEK[wd(d.day)]}, {dayText(d.day)}</span>
     <span>{h(d.before)} → <b>{h(d.after)}</b> de {h(d.staff)} HH</span>{d.over?<Badge tone="danger">passa do disponível</Badge>:<Badge tone="success">cabe</Badge>}</li>)}</ul>
   </>}
   {launched&&<Field label="Motivo do adiamento *" wide><Textarea maxLength={1200} rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Ex.: equipe deslocada para atendimento no navio"/></Field>}
  </div>
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button>
   <Button disabled={busy||!p||!!p?.blocked||(launched&&reason.trim().length<3)} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Adiar {days} dia{days>1?'s':''}</Button></div>
 </DialogContent></Dialog>;
}

const KINDS=[['weekday','Segunda a sexta'],['saturday','Sábado'],['sunday','Domingo']] as const;
/** Jornadas das barras (só a Gestão): início, fim e almoço por escala e tipo de dia; primeiro dia do Turno A. */
function JourneysDialog({onClose,onDone}:{onClose:()=>void,onDone:()=>void}){
 const [bars,setBars]=useState<R[]|null>(null),[bar,setBar]=useState<'equinor'|'ocp'>('equinor'),[busy,setBusy]=useState(false);
 useEffect(()=>{load<R>('planning/bars').then(r=>setBars(r.bars as R[]),e=>toast.error((e as Error).message))},[]);
 const b=bars?.find(x=>x.id===bar);
 const setSched=(fn:(s:R)=>void)=>setBars(list=>list!.map(x=>{if(x.id!==bar)return x;const s=structuredClone(x.schedule);fn(s);return {...x,schedule:s};}));
 async function go(){setBusy(true);try{const r=await post('planning/bars/save',{id:bar,schedule:b!.schedule});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 const row=(group:'adm'|'turno',kind:string,label:string)=>{const g=b!.schedule[group];const sp=g?.[kind] as R|null;
  return <tr key={group+kind}><td>{label}</td>
   <td><input type="checkbox" aria-label={`${group==='adm'?'ADM':'Turno'} trabalha (${label})`} checked={!!sp} onChange={e=>setSched(s=>{s[group]=s[group]||{weekday:null,saturday:null,sunday:null};s[group][kind]=e.target.checked?{start:'08:00',end:'17:00',lunch:true}:null;})}/></td>
   <td><Input type="time" aria-label="Início" disabled={!sp} value={sp?.start||''} onChange={e=>setSched(s=>{s[group][kind].start=e.target.value})}/></td>
   <td><Input type="time" aria-label="Fim" disabled={!sp} value={sp?.end||''} onChange={e=>setSched(s=>{s[group][kind].end=e.target.value})}/></td>
   <td><input type="checkbox" aria-label="Almoço de 1 h (12–13)" disabled={!sp} checked={!!sp?.lunch} onChange={e=>setSched(s=>{s[group][kind].lunch=e.target.checked})}/></td></tr>;};
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog pd-dialog"><DialogHeader><DialogTitle>Jornadas das barras</DialogTitle>
  <DialogDescription>Horário de trabalho de cada escala. O HH do dia sai daqui e de quem tem barra e escala no cadastro de colaboradores. Almoço: 12h às 13h.</DialogDescription></DialogHeader>
  {!b?<Skeleton className="h-40 rounded-lg"/>:<div className="pd-journeys">
   <div className="segmented" role="group" aria-label="Barra">{(['equinor','ocp'] as const).map(x=><button key={x} type="button" className={bar===x?'active':''} aria-pressed={bar===x} onClick={()=>setBar(x)}>{x==='ocp'?'OCP':'Equinor'}</button>)}</div>
   <table><thead><tr><th>Escala e dia</th><th>Trabalha</th><th>Início</th><th>Fim</th><th>Almoço</th></tr></thead>
    <tbody>{KINDS.map(([k,l])=>row('adm',k,`ADM · ${l}`))}{KINDS.map(([k,l])=>row('turno',k,`Turno 2x2 · ${l}`))}</tbody></table>
   <Field label="Primeiro dia do Turno A" hint="O Turno A trabalha esse dia e o seguinte; o Turno B, os dois seguintes."><Input type="date" value={b.schedule.anchor} onChange={e=>setSched(s=>{s.anchor=e.target.value})}/></Field>
  </div>}
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy||!b} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Salvar</Button></div>
 </DialogContent></Dialog>;
}

/** Indicadores: cumprimento, ocupação, precisão e emergenciais (hoje e mês até hoje), tabela por dia e Excel. */
function IndicatorsTab({today,initialBar}:{today:string,initialBar:'equinor'|'ocp'}){
 const [bar,setBar]=useState<'equinor'|'ocp'>(initialBar),[month,setMonth]=useState(today.slice(0,7)),[data,setData]=useState<R|null>(null),[error,setError]=useState('');
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega os indicadores ao trocar barra ou mês.
 useEffect(()=>{setData(null);load<R>(`planning/indicators?bar=${bar}&month=${month}`).then(r=>{setData(r);setError('')},e=>setError((e as Error).message))},[bar,month]);
 const day=(data?.days as R[]|undefined)?.find(d=>d.day===today)||(data?.days as R[]|undefined)?.at(-1);
 const pct=(v:number|null|undefined)=>v==null?'—':`${h(v)}%`;
 const kpi=(title:string,hint:string,dayV:number|null|undefined,monthV:number|null|undefined)=><div className="pd-kpi"><span>{title}</span>
  <div><small>{day?.day===today?'Hoje':'Último dia'}</small><b>{pct(dayV)}</b></div><div><small>Mês</small><b>{pct(monthV)}</b></div><p>{hint}</p></div>;
 return <section className="n-panel pd-ind">
  <div className="pd-ind-head">
   <div className="segmented" role="group" aria-label="Barra">{(['equinor','ocp'] as const).map(x=><button key={x} type="button" className={bar===x?'active':''} aria-pressed={bar===x} onClick={()=>setBar(x)}><span className={`pd-dot ${x}`}/>{x==='ocp'?'OCP':'Equinor'}</button>)}</div>
   <Input type="month" aria-label="Mês" value={month} onChange={e=>e.target.value&&setMonth(e.target.value)}/>
   <a className="pd-export" href={`/api/planning/indicators/export?bar=${bar}&month=${month}`}><Download size={14}/> Exportar Excel</a>
  </div>
  {error?<p className="form-error">{error}</p>:!data?<Skeleton className="h-40 rounded-lg"/>:<>
   <div className="pd-kpis">
    {kpi('Cumprimento do plano','HH concluído ÷ HH consolidado na reunião',day?.compliance,data.month.compliance)}
    {kpi('Ocupação da equipe','HH programado ÷ HH disponível',day?.occupancy,data.month.occupancy)}
    {kpi('Precisão da estimativa','Tempo real × duração estimada das OS concluídas',day?.precision,data.month.precision)}
    <div className="pd-kpi em"><span><Siren size={13}/> Emergenciais</span><div><small>{day?.day===today?'Hoje':'Último dia'}</small><b>{day?.emergencyCount??0}</b></div><div><small>Mês</small><b>{data.month.emergencyCount}</b></div><p>{h(data.month.emergencyHh)} HH chegaram depois da consolidação no mês</p></div>
   </div>
   <div className="table-scroll"><table className="pd-ind-table"><thead><tr><th>Dia</th><th>Disponível</th><th>Programado</th><th>Consolidado</th><th>Concluído</th><th>Cumprimento</th><th>Ocupação</th><th>Precisão</th><th>Emergenciais</th></tr></thead>
    <tbody>{[...(data.days as R[])].reverse().map(d=><tr key={d.day}><td>{dayText(d.day)}{!d.consolidated&&<small> · não consolidado</small>}</td><td>{h(d.availableHh)}</td><td>{h(d.programmedHh)}</td><td>{h(d.plannedHh)}</td><td>{h(d.doneHh)}</td>
     <td>{pct(d.compliance)}</td><td>{pct(d.occupancy)}</td><td>{pct(d.precision)}</td><td>{d.emergencyCount?`${d.emergencyCount} · ${h(d.emergencyHh)} HH`:'—'}</td></tr>)}</tbody></table></div>
  </>}
 </section>;
}
