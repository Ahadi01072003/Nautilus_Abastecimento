'use client';
// Planejamento › D+1 (P2): para cada barra (OCP ou Equinor) e dia, a capacidade em HH por função, a pilha
// de OS por prioridade com a linha de corte (a primeira que não cabe até o teto; dali para baixo, nada
// entra), as zonas (meta, 100%, esticado com validação, acima do teto) e as ações: arrastar para mudar a
// ordem, adiar com prévia (rascunho muda direto; OS lançada vira revisão com motivo) e validar a zona esticada.
// Azul-marinho e vermelho identificam a barra; o estado usa preenchimento, listras, borda e ícone.
import {useCallback,useEffect,useRef,useState,type DragEvent} from 'react';
import {ChevronLeft,ChevronRight,GripVertical,ArrowUp,ArrowDown,CalendarClock,Lock,TriangleAlert,CheckCircle2,LoaderCircle,ShieldCheck,Scissors,Truck,Users,RefreshCw,Send,Tv,ClipboardList,X,Pencil} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Badge,Empty,Field,post,load,type R} from './kit';
import {dayOf,dayText} from '@/lib/days';
import './d1.css';

const WEEK=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const plus=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86_400_000).toISOString().slice(0,10);
const wd=(d:string)=>new Date(Date.parse(d+'T12:00:00Z')).getUTCDay();
const h=(n:number)=>Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const ZONE:Record<string,{label:string,tone:string}>={meta:{label:'Na meta',tone:'success'},cheio:{label:'Até 100%',tone:'info'},esticado:{label:'Esticado',tone:'warning'},acima:{label:'Acima do teto',tone:'danger'}};

function ZoneIcon({zone}:{zone:string}){return zone==='acima'?<Lock size={14} aria-hidden/>:zone==='esticado'?<TriangleAlert size={14} aria-hidden/>:<CheckCircle2 size={14} aria-hidden/>;}

/** Barra de carga: preenchimento até 100%, listras na faixa esticada, marcas na meta, em 100% e no teto. */
function Gauge({pct,zones,label}:{pct:number|null,zones:number[],label:string}){
 const scale=zones[2]+15,clamp=(x:number)=>Math.max(0,Math.min(100,x*100/scale));
 const p=pct==null?scale:pct,solid=clamp(Math.min(p,100)),stretch=p>100?clamp(Math.min(p,zones[2]))-solid:0,over=p>zones[2]?clamp(p)-clamp(zones[2]):0;
 return <div className="d1-gauge" role="img" aria-label={label}>
  <span className="fill" style={{width:`${solid}%`}}/>
  {stretch>0&&<span className="stretch" style={{left:`${solid}%`,width:`${stretch}%`}}/>}
  {over>0&&<span className="over" style={{left:`${clamp(zones[2])}%`,width:`${over}%`}}/>}
  {zones.map((z,i)=><i key={i} className={`mark m${i}`} style={{left:`${clamp(z)}%`}} title={`${z}%`}/>)}
 </div>;
}

export default function D1View(){
 const [today]=useState(()=>dayOf(Date.now()));
 const [bar,setBar]=useState<'equinor'|'ocp'>('equinor'),[day,setDay]=useState(()=>plus(today,1));
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [postpone,setPostpone]=useState<R|null>(null),[stretch,setStretch]=useState<R|null>(null);
 const [dragging,setDragging]=useState<string|null>(null),[over,setOver]=useState<string|null>(null);
 const refresh=useCallback(async()=>{try{setData(await load<R>(`planning/d1?bar=${bar}&day=${day}`));setError('')}catch(e){setError((e as Error).message)}},[bar,day]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega o dia ao trocar barra ou dia.
 useEffect(()=>{void refresh()},[refresh]);
 const cards=(data?.cards||[]) as R[];
 async function saveOrder(ids:string[]){
  setBusy(true);
  try{await post('planning/d1/order',{bar,day,order:ids});await refresh();}catch(e){toast.error((e as Error).message);await refresh();}finally{setBusy(false)}
 }
 async function setMark(c:R,mark:string|null,note=''){
  setBusy(true);
  try{await post('planning/d1/mark',{bar,day,plan:c.planId,mark,note});await refresh();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 const move=(i:number,d:number)=>{const ids=cards.map(c=>c.planId);const j=i+d;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];void saveOrder(ids);};
 function drop(e:DragEvent,target:string){
  e.preventDefault();setOver(null);
  if(!dragging||dragging===target){setDragging(null);return;}
  const ids=cards.map(c=>c.planId).filter(x=>x!==dragging),at=ids.indexOf(target);ids.splice(at,0,dragging);setDragging(null);void saveOrder(ids);
 }
 const b=data?.bar as R|undefined,zones=(b?.zones||[85,100,115]) as number[];
 const quick=[{d:plus(today,1),l:'Amanhã'},...(wd(today)===5?[{d:plus(today,2),l:'Sábado'},{d:plus(today,3),l:'Domingo'}]:[]),...(wd(today)===6?[{d:plus(today,2),l:'Segunda'}]:[])];
 return <div className={`d1-screen bar-${bar}`}>
  <section className="n-panel d1-head">
   <div className="segmented" role="group" aria-label="Barra">{(['equinor','ocp'] as const).map(x=><button key={x} type="button" className={bar===x?'active':''} aria-pressed={bar===x} onClick={()=>setBar(x)}><span className={`cap-dot ${x}`}/>{x==='ocp'?'OCP':'Equinor'}</button>)}</div>
   <div className="d1-day">
    <Button variant="outline" size="icon" aria-label="Dia anterior" onClick={()=>setDay(plus(day,-1))}><ChevronLeft size={16}/></Button>
    <Input type="date" aria-label="Dia" value={day} onChange={e=>e.target.value&&setDay(e.target.value)}/>
    <Button variant="outline" size="icon" aria-label="Próximo dia" onClick={()=>setDay(plus(day,1))}><ChevronRight size={16}/></Button>
    {quick.map(q=><button key={q.d} type="button" className={`d1-chip ${day===q.d?'on':''}`} onClick={()=>setDay(q.d)}>{q.l}</button>)}
    <Button variant="ghost" size="icon" aria-label="Atualizar" onClick={()=>void refresh()}><RefreshCw size={16}/></Button>
   </div>
  </section>
  {error&&!data?<div className="error-panel"><TriangleAlert/><h2>D+1 indisponível</h2><p>{error}</p></div>
  :!data?<Skeleton className="h-72 rounded-xl"/>
  :<>
   <section className="n-panel d1-summary">
    <div className="d1-title"><h2>{WEEK[data.weekday]}, {dayText(data.day)}</h2><p>Barra {b!.name} · {data.people} pessoa{data.people!==1?'s':''} no HH{data.absent?` · ${data.absent} ausente${data.absent>1?'s':''}`:''}{data.bar&&` · zonas ${zones[0]}% / ${zones[1]}% / ${zones[2]}%`}</p></div>
    <div className="d1-kpis">
     <div><span>Capacidade</span><b>{h(data.capacityTotal)}</b><small>HH</small></div>
     <div><span>Demanda</span><b>{h(data.demandTotal)}</b><small>HH de {cards.length} OS</small></div>
     <div className={data.cutAt!=null?'warn':''}><span>Cabem no dia</span><b>{h(data.acceptedTotal)}</b><small>{data.cutAt!=null?`${cards.length-data.cutAt} OS abaixo da linha`:'tudo cabe'}</small></div>
    </div>
    {data.pendingStretch?.length>0&&<p className="d1-alert"><TriangleAlert size={16}/> Zona esticada sem validação: {data.pendingStretch.join(', ')}. Registre quem validou.</p>}
    <ul className="d1-functions">{(data.functions as R[]).map(f=><li key={f.functionId||f.name} className={`z-${f.zone}`}>
     <div className="d1-fn-name"><b>{f.name}</b><small>{h(f.accepted)} de {h(f.capacity)} HH{f.demand>f.accepted?` · ${h(f.demand-f.accepted)} HH abaixo da linha`:''}</small></div>
     <Gauge pct={f.pct} zones={zones} label={`${f.name}: ${f.pct==null?'sem capacidade':f.pct+'%'}`}/>
     <div className="d1-fn-state"><Badge tone={ZONE[f.zone].tone}><ZoneIcon zone={f.zone}/> {f.pct==null?'Sem equipe':`${h(f.pct)}%`}</Badge>
      {f.zone==='esticado'&&(f.stretch?<small className="d1-ok" title={f.stretch.note||undefined}><ShieldCheck size={13}/> Validado por {f.stretch.validatedBy}</small>
       :<Button size="sm" variant="outline" onClick={()=>setStretch(f)}>Registrar validação</Button>)}</div>
    </li>)}</ul>
   </section>
   <PublishPanel data={data} bar={bar} day={day} onDone={()=>void refresh()}/>
   <section className="n-panel d1-stack-panel">
    <div className="panel-heading"><div><h2>Pilha do dia</h2><p>Arraste (ou use as setas) para mudar a prioridade. A ordem vale para todos os dias da OS. A linha de corte cai na primeira OS que não cabe até o teto.</p></div>{busy&&<LoaderCircle className="spin" size={18}/>}</div>
    {cards.length?<ol className="d1-stack">{cards.map((c,i)=><li key={c.planId} className="d1-slot">
     {data.cutAt===i&&<div className="d1-cut" role="separator"><Scissors size={14}/> Linha de corte · daqui para baixo não cabe no dia</div>}
     <article className={`d1-card z-${c.zone} ${c.fits?'':'below'} ${over===c.planId?'drop':''} ${c.status}`} draggable={!busy}
      onDragStart={e=>{setDragging(c.planId);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>{setDragging(null);setOver(null);}}
      onDragOver={e=>{if(dragging){e.preventDefault();setOver(c.planId);}}} onDrop={e=>drop(e,c.planId)}>
      <div className="d1-handle"><GripVertical size={16} aria-hidden/><b>{i+1}</b>
       <button type="button" aria-label={`Subir ${c.label}`} disabled={busy||i===0} onClick={()=>move(i,-1)}><ArrowUp size={14}/></button>
       <button type="button" aria-label={`Descer ${c.label}`} disabled={busy||i===cards.length-1} onClick={()=>move(i,1)}><ArrowDown size={14}/></button></div>
      <div className="d1-body">
       <div className="d1-card-top"><span className="d1-os">{c.number!=null?c.label:'Rascunho'}</span>{c.status==='rascunho'&&c.number!=null&&<Badge>Revisão em rascunho</Badge>}{c.org?.acronym&&<span className="d1-org" style={{borderColor:c.org.color||undefined}}>{c.org.acronym}</span>}
        <span className="d1-days">{c.firstDay===c.lastDay?dayText(c.firstDay):`${dayText(c.firstDay)} a ${dayText(c.lastDay)}`}{c.skipSunday?' · sem domingo':''}</span></div>
       <h3>{c.title}</h3>
       <p className="d1-steps">{(c.steps as string[]).join(' · ')}</p>
       <div className="d1-needs">{(c.byFunction as R[]).map(f=><span key={f.functionId}><Users size={12}/> {f.people}× {f.name} · {h(f.hh)} HH</span>)}
        {(c.equipment as R[]).map((e,k)=><span key={k}><Truck size={12}/> {e.tag} · {h(e.hours)} h</span>)}
        {!(c.byFunction as R[]).length&&<small className="pending-text">Sem funções informadas: não ocupa HH.</small>}</div>
      </div>
      <div className="d1-side"><b>{h(c.hh)} HH</b><Badge tone={ZONE[c.zone].tone}><ZoneIcon zone={c.zone}/> {c.fits?ZONE[c.zone].label:'Não cabe'}</Badge>
       {c.status==='lancada'&&c.fits&&<div className="d1-mark" role="group" aria-label={`Reunião: ${c.label}`}>
        <button type="button" className={c.mark?.mark==='confirmado'?'on ok':''} aria-pressed={c.mark?.mark==='confirmado'} disabled={busy} onClick={()=>void setMark(c,c.mark?.mark==='confirmado'?null:'confirmado')}><CheckCircle2 size={14}/> Confirmado</button>
        <button type="button" className={c.mark?.mark==='ajustar'?'on adj':''} aria-pressed={c.mark?.mark==='ajustar'} disabled={busy} onClick={()=>{if(c.mark?.mark==='ajustar'){void setMark(c,null);return;}const note=window.prompt(`O que ajustar em ${c.label}?`,'');if(note!==null)void setMark(c,'ajustar',note);}}><Pencil size={14}/> Ajustar</button>
       </div>}
       {c.mark?.mark==='ajustar'&&c.mark.note&&<small className="d1-adj-note">{c.mark.note}</small>}
       <Button size="sm" variant={c.fits?'ghost':'outline'} disabled={c.started} title={c.started?'OS já iniciada: ajuste pela revisão da OS.':undefined} onClick={()=>setPostpone(c)}><CalendarClock size={14}/> Adiar</Button></div>
     </article>
    </li>)}</ol>
    :<Empty icon={CalendarClock} title="Nenhuma OS neste dia" description={`Nada planejado para a barra ${b!.name} em ${dayText(data.day)}.`}/>}
   </section>
  </>}
  {postpone&&<PostponeDialog card={postpone} onClose={()=>setPostpone(null)} onDone={()=>{setPostpone(null);void refresh();}}/>}
  {stretch&&<StretchDialog fn={stretch} bar={bar} day={day} onClose={()=>setStretch(null)} onDone={()=>{setStretch(null);void refresh();}}/>}
 </div>;
}

function PostponeDialog({card,onClose,onDone}:{card:R,onClose:()=>void,onDone:()=>void}){
 const [days,setDays]=useState(1),[preview,setPreview]=useState<R|null>(null),[error,setError]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const seq=useRef(0);
 useEffect(()=>{const n=++seq.current;load<R>(`planning/d1/preview?plan=${encodeURIComponent(card.planId)}&days=${days}`).then(p=>{if(n===seq.current){setPreview(p);setError('')}},e=>{if(n===seq.current)setError((e as Error).message)});},[card.planId,days]);
 const launched=card.status==='lancada';
 async function go(){
  setBusy(true);
  try{const r=await post('planning/d1/postpone',{plan:card.planId,days,reason});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 const p=preview;
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog d1-dialog"><DialogHeader><DialogTitle>Adiar {card.label}</DialogTitle>
  <DialogDescription>{card.title}. {launched?'OS lançada: o adiamento gera e lança a revisão da OS com as novas datas e o motivo.':'Rascunho: as datas mudam direto.'}</DialogDescription></DialogHeader>
  <div className="d1-postpone">
   <div className="segmented" role="group" aria-label="Dias">{[1,2,3,7].map(n=><button key={n} type="button" className={days===n?'active':''} aria-pressed={days===n} onClick={()=>setDays(n)}>+{n} dia{n>1?'s':''}</button>)}</div>
   {error?<p className="form-error">{error}</p>:!p?<Skeleton className="h-32 rounded-lg"/>:<>
    <p><b>{p.from.first===p.from.last?dayText(p.from.first):`${dayText(p.from.first)} a ${dayText(p.from.last)}`}</b> → <b>{p.to.first===p.to.last?dayText(p.to.first):`${dayText(p.to.first)} a ${dayText(p.to.last)}`}</b></p>
    {p.blocked&&<p className="form-error">{p.blocked}</p>}
    <div className="d1-preview">{(p.days as R[]).map(d=><div key={d.day} className={d.fits?'':'bad'}><b>{WEEK[wd(d.day)]}, {dayText(d.day)}{!d.fits&&<> · <Lock size={13}/> não cabe</>}</b>
     <ul>{(d.functions as R[]).map(f=><li key={f.functionId} className={`z-${f.zoneAfter}`}><span>{f.name}</span><span>{h(f.before)} → <b>{h(f.after)}</b> de {h(f.capacity)} HH</span><Badge tone={ZONE[f.zoneAfter].tone}>{f.pctAfter==null?'sem equipe':`${h(f.pctAfter)}%`}</Badge></li>)}
      {(d.equipment as R[]).map(e=><li key={e.tag} className={e.over?'z-acima':''}><span><Truck size={12}/> {e.tag}</span><span>{h(e.others)} h de outras OS + {h(e.hours)} h</span>{e.over?<Badge tone="danger">passa de 12 h</Badge>:<Badge tone="success">ok</Badge>}</li>)}
      {!(d.functions as R[]).length&&!(d.equipment as R[]).length&&<li><span className="pending-text">Não ocupa equipe nem equipamento neste dia.</span></li>}</ul></div>)}</div>
   </>}
   {launched&&<Field label="Motivo do adiamento *" wide><Textarea maxLength={1200} rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Ex.: equipe deslocada para atendimento no navio"/></Field>}
  </div>
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button>
   <Button disabled={busy||!p||!!p?.blocked||(launched&&reason.trim().length<3)} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Adiar {days} dia{days>1?'s':''}</Button></div>
 </DialogContent></Dialog>;
}

function StretchDialog({fn,bar,day,onClose,onDone}:{fn:R,bar:string,day:string,onClose:()=>void,onDone:()=>void}){
 const [by,setBy]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
 async function go(){setBusy(true);try{const r=await post('planning/d1/stretch',{bar,day,functionId:fn.functionId,validatedBy:by,note});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Validar zona esticada</DialogTitle>
  <DialogDescription>{fn.name} em {h(fn.pct)}% ({h(fn.accepted)} de {h(fn.capacity)} HH) em {dayText(day)}. Registre a liderança que validou passar de 100%.</DialogDescription></DialogHeader>
  <div className="form-grid">
   <Field label="Quem validou *" wide><Input maxLength={120} value={by} onChange={e=>setBy(e.target.value)} placeholder="Nome do líder"/></Field>
   <Field label="Observação" wide><Input maxLength={300} value={note} onChange={e=>setNote(e.target.value)} placeholder="Ex.: reforço com hora extra da equipe ADM"/></Field>
  </div>
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy||by.trim().length<2} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Registrar</Button></div>
 </DialogContent></Dialog>;
}

/** Reunião das 16:00: situação da publicação, pendências, lideranças presentes e publicar (nova versão pede justificativa). */
function PublishPanel({data,bar,day,onDone}:{data:R,bar:string,day:string,onDone:()=>void}){
 const pub=data.publication as R|null,pending=(data.checks?.pending||[]) as string[];
 const [leaders,setLeaders]=useState<string[]>([]),[name,setName]=useState(''),[why,setWhy]=useState(''),[busy,setBusy]=useState(false);
 const next=pub?pub.version+1:1,needsWhy=!!pub;
 const add=()=>{const n=name.trim().replace(/\s+/g,' ');if(n.length>=2&&!leaders.includes(n))setLeaders(l=>[...l,n]);setName('');};
 async function go(){setBusy(true);try{const r=await post('planning/d1/publish',{bar,day,leaders,justification:why});toast.success(r.message);setWhy('');onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 const state=!pub?{tone:'muted',text:'Não publicado'}:pub.changed?{tone:'warning',text:`Alterado após a versão ${pub.version}`}:{tone:'success',text:`Publicado · versão ${pub.version}`};
 return <section className={`n-panel d1-publish ${pub&&!pub.changed?'done':''}`}>
  <div className="d1-publish-head"><div><h2>Reunião das 16:00 · publicação</h2>
   <p>{pub?`Versão ${pub.version} publicada em ${new Date(pub.publishedAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} por ${pub.by} · lideranças: ${(pub.leaders as string[]).join(', ')}.`:'A TV, o celular do líder e a lista de separação mostram só o que for publicado.'}</p></div>
   <Badge tone={state.tone}>{state.text}</Badge></div>
  <div className="d1-publish-links"><a href={`/programacao?bar=${bar}&day=${day}`} target="_blank" rel="noopener"><Tv size={14}/> Programação publicada (TV e celular)</a><a href={`/separacao?bar=${bar}&day=${day}`} target="_blank" rel="noopener"><ClipboardList size={14}/> Lista de separação</a></div>
  {(!pub||pub.changed)&&<>
   {pending.length?<div className="d1-pending"><b><TriangleAlert size={15}/> {pending.length} pendência{pending.length>1?'s':''} para publicar</b><ul>{pending.map((p,i)=><li key={i}>{p}</li>)}</ul></div>
    :<p className="d1-ready"><CheckCircle2 size={15}/> Conferência sem pendências: pode publicar.</p>}
   <div className="d1-leaders"><label htmlFor="d1-leader">Lideranças presentes *</label>
    <div className="d1-leader-row"><Input id="d1-leader" maxLength={120} value={name} placeholder="Nome e Enter" onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();add();}}}/><Button type="button" variant="outline" onClick={add}>Incluir</Button></div>
    {leaders.length>0&&<div className="d1-leader-chips">{leaders.map(l=><span key={l}>{l}<button type="button" aria-label={`Remover ${l}`} onClick={()=>setLeaders(x=>x.filter(y=>y!==l))}><X size={12}/></button></span>)}</div>}</div>
   {needsWhy&&<Field label={`Justificativa da versão ${next} *`} wide><Textarea maxLength={1200} rows={2} value={why} onChange={e=>setWhy(e.target.value)} placeholder="O que mudou depois da publicação e por quê"/></Field>}
   <div className="step-actions"><Button disabled={busy||pending.length>0||!leaders.length||(needsWhy&&why.trim().length<3)} onClick={()=>void go()}>{busy?<LoaderCircle className="spin" size={15}/>:<Send size={15}/>} Publicar {needsWhy?`versão ${next}`:'D+1'}</Button></div>
  </>}
 </section>;
}
