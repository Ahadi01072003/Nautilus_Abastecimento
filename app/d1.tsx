'use client';
// Planejamento › D+1, na forma simples: para cada barra (OCP ou Equinor) e dia, o HH das OS (funcionários ×
// horas por dia) contra o HH disponível (funcionários do dia × horas trabalhadas): “96 de 120 HH”, vermelho
// quando passa. O planejador corrige o efetivo do dia, ordena a pilha (arrastar ou setas), adia com prévia e
// publica com um clique. Azul-marinho e vermelho identificam a barra.
import {useCallback,useEffect,useRef,useState,type DragEvent} from 'react';
import {ChevronLeft,ChevronRight,GripVertical,ArrowUp,ArrowDown,CalendarClock,TriangleAlert,CheckCircle2,LoaderCircle,Truck,Users,RefreshCw,Send,Tv,ClipboardList,Settings2} from 'lucide-react';
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
const funcionarios=(n:number)=>`${n} funcionário${n===1?'':'s'}`;
const h=(n:number)=>Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const hNum=(v:string)=>Number(v.replace(',','.'));
const at=(iso:string)=>new Date(iso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

export default function D1View({manager=false}:{manager?:boolean}){
 const [today]=useState(()=>dayOf(Date.now()));
 const [bar,setBar]=useState<'equinor'|'ocp'>('equinor'),[day,setDay]=useState(()=>plus(today,1));
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [postpone,setPostpone]=useState<R|null>(null),[standard,setStandard]=useState(false);
 const [dragging,setDragging]=useState<string|null>(null),[over,setOver]=useState<string|null>(null);
 const refresh=useCallback(async()=>{try{setData(await load<R>(`planning/d1?bar=${bar}&day=${day}`));setError('')}catch(e){setError((e as Error).message)}},[bar,day]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega o dia ao trocar barra ou dia.
 useEffect(()=>{void refresh()},[refresh]);
 const cards=(data?.cards||[]) as R[];
 async function saveOrder(ids:string[]){
  setBusy(true);
  try{await post('planning/d1/order',{bar,day,order:ids});await refresh();}catch(e){toast.error((e as Error).message);await refresh();}finally{setBusy(false)}
 }
 const move=(i:number,d:number)=>{const ids=cards.map(c=>c.planId);const j=i+d;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];void saveOrder(ids);};
 function drop(e:DragEvent,target:string){
  e.preventDefault();setOver(null);
  if(!dragging||dragging===target){setDragging(null);return;}
  const ids=cards.map(c=>c.planId).filter(x=>x!==dragging),idx=ids.indexOf(target);ids.splice(idx,0,dragging);setDragging(null);void saveOrder(ids);
 }
 const b=data?.bar as R|undefined;
 const firstOver=cards.findIndex(c=>c.exceeds);
 const quick=[{d:plus(today,1),l:'Amanhã'},...(wd(today)===5?[{d:plus(today,2),l:'Sábado'},{d:plus(today,3),l:'Domingo'}]:[]),...(wd(today)===6?[{d:plus(today,2),l:'Segunda'}]:[])];
 return <div className={`d1-screen bar-${bar}`}>
  <section className="n-panel d1-head">
   <div className="segmented" role="group" aria-label="Barra">{(['equinor','ocp'] as const).map(x=><button key={x} type="button" className={bar===x?'active':''} aria-pressed={bar===x} onClick={()=>setBar(x)}><span className={`d1-dot ${x}`}/>{x==='ocp'?'OCP':'Equinor'}</button>)}</div>
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
   <section className={`n-panel d1-summary ${data.over?'is-over':''}`}>
    <div className="d1-title"><h2>{WEEK[data.weekday]}, {dayText(data.day)}</h2><p>Barra {b!.name}</p></div>
    <div className="d1-meter">
     <div className="d1-count"><b>{h(data.demand)}</b><span>de {h(data.staff.hh)} HH</span></div>
     <div className="d1-track" role="img" aria-label={`${h(data.demand)} de ${h(data.staff.hh)} HH`}><span style={{width:`${data.staff.hh?Math.min(100,data.demand*100/data.staff.hh):(data.demand?100:0)}%`}}/></div>
     {data.over?<p className="d1-over"><TriangleAlert size={16}/> Passou {h(data.missing)} HH do disponível. Adie ou reordene, ou corrija o efetivo do dia.</p>
      :<p className="d1-fine"><CheckCircle2 size={16}/> {data.staff.hh-data.demand===0?'HH do dia todo ocupado.':`Sobram ${h(data.staff.hh-data.demand)} HH.`}</p>}
    </div>
    <StaffEditor key={`${bar}-${day}-${data.staff.people}-${data.staff.hours}-${data.staff.source}`} bar={bar} day={day} staff={data.staff} manager={manager} onStandard={()=>setStandard(true)} onDone={()=>void refresh()}/>
   </section>
   <PublishBar data={data} bar={bar} day={day} onDone={()=>void refresh()}/>
   <section className="n-panel d1-stack-panel">
    <div className="panel-heading"><div><h2>OS do dia</h2><p>Arraste (ou use as setas) para mudar a ordem: as mais importantes no topo. A ordem vale para todos os dias da OS.</p></div>{busy&&<LoaderCircle className="spin" size={18}/>}</div>
    {cards.length?<ol className="d1-stack">{cards.map((c,i)=><li key={c.planId}>
     {i===firstOver&&<div className="d1-line" role="separator"><TriangleAlert size={14}/> Daqui para baixo passa do HH disponível</div>}
     <article className={`d1-card ${c.exceeds?'exceeds':''} ${over===c.planId?'drop':''} ${c.status}`} draggable={!busy}
      onDragStart={e=>{setDragging(c.planId);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>{setDragging(null);setOver(null);}}
      onDragOver={e=>{if(dragging){e.preventDefault();setOver(c.planId);}}} onDrop={e=>drop(e,c.planId)}>
      <div className="d1-handle"><GripVertical size={16} aria-hidden/><b>{i+1}</b>
       <button type="button" aria-label={`Subir ${c.label}`} disabled={busy||i===0} onClick={()=>move(i,-1)}><ArrowUp size={14}/></button>
       <button type="button" aria-label={`Descer ${c.label}`} disabled={busy||i===cards.length-1} onClick={()=>move(i,1)}><ArrowDown size={14}/></button></div>
      <div className="d1-body">
       <div className="d1-card-top"><span className="d1-os">{c.number!=null?c.label:'Rascunho'}</span>{c.status==='rascunho'&&c.number!=null&&<Badge>Revisão em rascunho</Badge>}{c.org?.acronym&&<span className="d1-org" style={{borderColor:c.org.color||undefined}}>{c.org.acronym}</span>}
        <span className="d1-days">{c.firstDay===c.lastDay?dayText(c.firstDay):`${dayText(c.firstDay)} a ${dayText(c.lastDay)}`}{c.skipSunday?' · sem domingo':''}</span></div>
       <h3>{c.title}</h3>
       {(c.steps as string[]).length>1&&<p className="d1-steps">{(c.steps as string[]).join(' · ')}</p>}
       <div className="d1-needs">{(c.byFunction as R[]).map(f=><span key={f.functionId}><Users size={12}/> {f.people}× {f.name} · {h(f.hh)} HH</span>)}
        {(c.equipment as R[]).map((e,k)=><span key={k}><Truck size={12}/> {e.tag}</span>)}
        {!(c.byFunction as R[]).length&&<small className="pending-text">Sem funcionários informados no planejamento: não ocupa HH.</small>}</div>
      </div>
      <div className="d1-side"><b>{h(c.hh)} HH</b><small>{funcionarios(c.people)}</small>
       {c.status==='rascunho'&&c.number==null&&<Badge tone="warning">Rascunho: não é publicado</Badge>}
       <Button size="sm" variant="ghost" disabled={c.started} title={c.started?'OS já iniciada: ajuste pela revisão da OS.':undefined} onClick={()=>setPostpone(c)}><CalendarClock size={14}/> Adiar</Button></div>
     </article>
    </li>)}</ol>
    :<Empty icon={CalendarClock} title="Nenhuma OS neste dia" description={`Nada planejado para a barra ${b!.name} em ${dayText(data.day)}.`}/>}
   </section>
  </>}
  {postpone&&<PostponeDialog card={postpone} onClose={()=>setPostpone(null)} onDone={()=>{setPostpone(null);void refresh();}}/>}
  {standard&&b&&<StandardDialog bar={b} onClose={()=>setStandard(false)} onDone={()=>{setStandard(false);void refresh();}}/>}
 </div>;
}

/** Efetivo do dia: funcionários × horas trabalhadas = HH disponível, para o planejador corrigir ou voltar ao padrão. */
function StaffEditor({bar,day,staff,manager,onStandard,onDone}:{bar:string,day:string,staff:R,manager:boolean,onStandard:()=>void,onDone:()=>void}){
 const [people,setPeople]=useState(String(staff.people)),[hours,setHours]=useState(h(staff.hours)),[busy,setBusy]=useState(false);
 async function save(p:string,hr:string){
  setBusy(true);
  try{const r=await post('planning/d1/staff',{bar,day,people:p,hours:hr});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 const changed=people!==String(staff.people)||hNum(hours)!==Number(staff.hours),valid=people!==''&&hours!==''&&hNum(hours)>0;
 const preview=valid?Number(people)*hNum(hours):null;
 const kind=wd(day)===0||wd(day)===6?'fim de semana':'dia útil';
 const enter=(e:React.KeyboardEvent)=>{if(e.key==='Enter'&&changed&&valid)void save(people,hours);};
 return <div className="d1-staff">
  <label htmlFor="d1-staff">Efetivo do dia</label>
  <div className="d1-staff-row">
   <Input id="d1-staff" aria-label="Funcionários do dia" inputMode="numeric" value={people} onChange={e=>setPeople(e.target.value.replace(/\D/g,''))} onKeyDown={enter}/>
   <span>func. ×</span>
   <Input aria-label="Horas trabalhadas no dia" inputMode="decimal" className="d1-hours" value={hours} onChange={e=>setHours(e.target.value.replace(/[^\d,.]/g,''))} onKeyDown={enter}/>
   <span>h = <b>{preview==null?'—':h(preview)}</b> HH</span>
   <Button variant="outline" disabled={busy||!changed||!valid} onClick={()=>void save(people,hours)}>{busy&&<LoaderCircle className="spin" size={14}/>} Salvar</Button>
  </div>
  <small>{staff.source==='dia'?<>Corrigido por {staff.byName} (padrão de {kind}: {staff.standard.people} func. × {h(staff.standard.hours)} h). <button type="button" className="text-action" disabled={busy} onClick={()=>void save('','')}>Voltar ao padrão</button></>
   :staff.standard.people===0?<b className="d1-unset">Funcionários padrão ainda não definidos{manager?'.':': peça à Gestão.'}</b>
   :<>Padrão da barra para {kind}. Mude só se o dia for diferente (falta, férias, reforço, jornada menor).</>}
   {manager&&<> <button type="button" className="text-action" onClick={onStandard}><Settings2 size={12}/> Padrão da barra</button></>}</small>
 </div>;
}

/** Padrão da barra (só a Gestão): funcionários em dia útil e no fim de semana e horas trabalhadas por dia. */
function StandardDialog({bar,onClose,onDone}:{bar:R,onClose:()=>void,onDone:()=>void}){
 const [w,setW]=useState(String(bar.staffWeekday)),[e,setE]=useState(String(bar.staffWeekend)),[hr,setHr]=useState(h(bar.hours)),[busy,setBusy]=useState(false);
 async function go(){setBusy(true);try{const r=await post('planning/bars/save',{id:bar.id,staffWeekday:w,staffWeekend:e,hours:hr});toast.success(r.message);onDone();}catch(x){toast.error((x as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Padrão da barra {bar.name}</DialogTitle>
  <DialogDescription>Quantos funcionários a barra tem normalmente e quantas horas cada um trabalha por dia. HH disponível = funcionários × horas. O planejador corrige um dia específico na tela do D+1.</DialogDescription></DialogHeader>
  <div className="form-grid">
   <Field label="Funcionários em dia útil (segunda a sexta)"><Input inputMode="numeric" value={w} onChange={x=>setW(x.target.value.replace(/\D/g,''))}/></Field>
   <Field label="Funcionários no fim de semana (sábado e domingo)"><Input inputMode="numeric" value={e} onChange={x=>setE(x.target.value.replace(/\D/g,''))}/></Field>
   <Field label="Horas trabalhadas por dia" hint="Também vale para a função da OS sem horas informadas."><Input inputMode="decimal" value={hr} onChange={x=>setHr(x.target.value.replace(/[^\d,.]/g,''))}/></Field>
  </div>
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy||w===''||e===''||hr===''} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Salvar</Button></div>
 </DialogContent></Dialog>;
}

/** Publicar: um clique grava o que a TV, o celular e a lista de separação mostram; de novo, cria a versão seguinte. */
function PublishBar({data,bar,day,onDone}:{data:R,bar:string,day:string,onDone:()=>void}){
 const pub=data.publication as R|null,[busy,setBusy]=useState(false);
 async function go(){setBusy(true);try{const r=await post('planning/d1/publish',{bar,day});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 const state=!pub?{tone:'muted',text:'Não publicado'}:pub.changed?{tone:'warning',text:'Mudou depois de publicar'}:{tone:'success',text:'Publicado'};
 return <section className={`n-panel d1-publish ${pub&&!pub.changed?'done':''}`}>
  <div className="d1-publish-info"><Badge tone={state.tone}>{state.text}</Badge>
   <p>{pub?`Publicado em ${at(pub.publishedAt)} por ${pub.by}${pub.version>1?` (versão ${pub.version})`:''}.${pub.changed?' Publique de novo para a TV mostrar o que mudou.':''}`:'A TV, o celular do líder e a lista de separação mostram o que for publicado.'}
    {data.drafts>0&&` ${data.drafts} rascunho${data.drafts>1?'s':''} não entra${data.drafts>1?'m':''} na publicação.`}</p></div>
  <div className="d1-publish-actions">
   <a href={`/programacao?bar=${bar}&day=${day}`} target="_blank" rel="noopener"><Tv size={14}/> TV e celular</a>
   <a href={`/separacao?bar=${bar}&day=${day}`} target="_blank" rel="noopener"><ClipboardList size={14}/> Lista de separação</a>
   {(!pub||pub.changed)&&<Button disabled={busy} onClick={()=>void go()}>{busy?<LoaderCircle className="spin" size={15}/>:<Send size={15}/>} {pub?'Publicar de novo':'Publicar'}</Button>}
  </div>
 </section>;
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
  <DialogDescription>{card.title}. {launched?'OS lançada: o adiamento gera a revisão da OS com as novas datas e o motivo.':'Rascunho: as datas mudam direto.'}</DialogDescription></DialogHeader>
  <div className="d1-postpone">
   <div className="segmented" role="group" aria-label="Dias">{[1,2,3,7].map(n=><button key={n} type="button" className={days===n?'active':''} aria-pressed={days===n} onClick={()=>setDays(n)}>+{n} dia{n>1?'s':''}</button>)}</div>
   {error?<p className="form-error">{error}</p>:!p?<Skeleton className="h-24 rounded-lg"/>:<>
    <p><b>{p.from.first===p.from.last?dayText(p.from.first):`${dayText(p.from.first)} a ${dayText(p.from.last)}`}</b> → <b>{p.to.first===p.to.last?dayText(p.to.first):`${dayText(p.to.first)} a ${dayText(p.to.last)}`}</b></p>
    {p.blocked&&<p className="form-error">{p.blocked}</p>}
    <ul className="d1-preview">{(p.days as R[]).map(d=><li key={d.day} className={d.over?'bad':''}><span>{WEEK[wd(d.day)]}, {dayText(d.day)}</span>
     <span>{h(d.before)} → <b>{h(d.after)}</b> de {h(d.staff)} HH</span>{d.over?<Badge tone="danger">passa do disponível</Badge>:<Badge tone="success">cabe</Badge>}</li>)}</ul>
   </>}
   {launched&&<Field label="Motivo do adiamento *" wide><Textarea maxLength={1200} rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Ex.: equipe deslocada para atendimento no navio"/></Field>}
  </div>
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button>
   <Button disabled={busy||!p||!!p?.blocked||(launched&&reason.trim().length<3)} onClick={()=>void go()}>{busy&&<LoaderCircle className="spin" size={15}/>} Adiar {days} dia{days>1?'s':''}</Button></div>
 </DialogContent></Dialog>;
}
