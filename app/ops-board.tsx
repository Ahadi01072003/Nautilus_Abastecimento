'use client';
// Operação › Painel de OS: indicadores do turno e cada OS com a sua régua e o seu cronômetro
// (tempo efetivo). Filtros de período, situação, código do setor e solicitante; exportação da
// agenda em PDF. Pausar e retomar direto do cartão; o resto nos Apontamentos.
import {Fragment,useCallback,useEffect,useState,type FormEvent,type MouseEvent} from 'react';
import {Pause,Play,ArrowRight,LoaderCircle,CalendarRange,FileDown,FilterX,ClipboardCheck} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Choice,Field,OrgTag,post,load,type R} from './kit';
import {osLabel} from './planning';
import OsRuler,{effective,dur,RulerLegend} from './os-ruler';
import {ArrangeControls,DEFAULT_VIEW,readView,type OsView} from './os-arrange';
import {viewToParams,EMPTY_FILTER} from '@/lib/os-order';
import {ALL_KINDS,type Alloc,type ResKind} from '@/lib/resource-agenda';
import {ResourcePick} from './resource-agenda';
import {keepOpenForPick,openPdf,pickSummary,resourcePdfUrl} from './resource-export';

const dmhmFmt=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const dmhm={format:(t:number)=>dmhmFmt.format(t).replace(',','')};
/** Duração longa legível: "2 d 01:02" a partir de 24 h (o HH:MM puro passa de 48:00 e confunde). */
const span=(x:number)=>x>=86400000?`${Math.floor(x/86400000)} d ${dur(x%86400000)}`:dur(x);
/** Período planejado: no mesmo dia "26/10 07:00–17:00"; em dias diferentes, data nas duas pontas. */
const period=(a:number,b:number)=>{const x=dmhm.format(a),y=dmhm.format(b);return x.slice(0,5)===y.slice(0,5)?`${x}–${y.slice(6)}`:`${x} → ${y}`;};
const STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const STEP:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada',cancelada:'Cancelada'};
const COLOR:Record<string,string>={em_andamento:'var(--live)',encerramento_pendente:'var(--imp)',programada:'var(--line)',concluida:'var(--ok)',cancelada:'var(--occ)'};
export const hms=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
/** Cada dígito que muda é remontado (chave nova) e roda a animação de entrada. */
export function Digits({value}:{value:string}){return <>{[...value].map((ch,i)=>ch===':'?<span key={i} className="sep">:</span>:<span key={i+'-'+ch} className="roll">{ch}</span>)}</>;}
export function Status({s}:{s:string}){return <span className={`st ${s}`}><i/>{STATUS[s]||STEP[s]||s}</span>;}

type Board={orders:R[];counts:Record<string,number>;canExecute:boolean;serverNow:string;more?:boolean};
type Dash={kpis:R;byOrg:R[];byActivity:R[];sectors:R[];orgs:R[];serverNow:string};
type Filters={from:string,to:string,group:string,sector:string,org:string};
const GROUPS=[{value:'andamento',label:'Em andamento'},{value:'programadas',label:'Programadas'},{value:'concluidas',label:'Concluídas (inclui realizadas)'},{value:'canceladas',label:'Canceladas'},{value:'todas',label:'Todas'}];
const TITLES:Record<string,string>={andamento:'OS em andamento',programadas:'OS programadas',concluidas:'OS concluídas',canceladas:'OS canceladas',todas:'Todas as OS'};
const EMPTY:Filters={from:'',to:'',group:'andamento',sector:'',org:''};
const STORE='nautilus.ops-board.filters';
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
const plusDays=(iso:string,n:number)=>new Date(Date.parse(iso+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const qs=(f:Partial<Filters>)=>new URLSearchParams(Object.entries(f).filter(([,v])=>v) as [string,string][]).toString();

export default function OpsBoard({onOpen,refreshKey}:{onOpen:(id:string)=>void;refreshKey:number}){
 const [dash,setDash]=useState<Dash|null>(null),[main,setMain]=useState<Board|null>(null),[next,setNext]=useState<Board|null>(null),[error,setError]=useState('');
 const [offset,setOffset]=useState(0),[tick,setTick]=useState(()=>Date.now()),[agenda,setAgenda]=useState(false);
 // Filtros da sessão: continuam iguais ao voltar dos Apontamentos.
 const [filters,setFilters]=useState<Filters>(()=>{try{return {...EMPTY,...JSON.parse(sessionStorage.getItem(STORE)||'{}')}}catch{return EMPTY}});
 useEffect(()=>{try{sessionStorage.setItem(STORE,JSON.stringify(filters))}catch{}},[filters]);
 const invalid=!!(filters.from&&filters.to&&filters.to<filters.from);
 const refresh=useCallback(async()=>{
  if(invalid)return;
  try{
   const common={sector:filters.sector,org:filters.org};
   const [d,r,n]=await Promise.all([load<Dash>('ops/dashboard?'+qs(common)),load<Board>('ops/board?'+qs({...common,group:filters.group,from:filters.from,to:filters.to})),filters.group==='andamento'&&!filters.from&&!filters.to?load<Board>('ops/board?'+qs({...common,group:'programadas'})):Promise.resolve(null)]);
   setOffset(Date.parse(r.serverNow)-Date.now());setDash(d);setMain(r);setNext(n);setError('');
  }catch(e){setError((e as Error).message);}
 },[filters,invalid]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados vindos do servidor.
 useEffect(()=>{void refresh();},[refresh,refreshKey]);
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh();},30000);const c=setInterval(()=>setTick(Date.now()),1000);return ()=>{clearInterval(t);clearInterval(c);};},[refresh]);
 const now=tick+offset;
 if(error)return <div className="error-panel"><h2>Painel indisponível</h2><p>{error}</p><Button variant="outline" onClick={()=>setFilters(EMPTY)}>Limpar filtros</Button></div>;
 if(!dash||!main)return <div className="sn-empty">Carregando o painel…</div>;
 const k=dash.kpis;
 const kpis:[string,string|number,string,string][]=[
  ['Em andamento',k.running,'var(--live)',`${k.pending} em encerramento pendente`],
  ['Etapas em execução',k.active,'var(--accent-ink)','tempo efetivo correndo'],
  ['Etapas paradas',k.stopped,'var(--imp)','pausadas ou bloqueadas'],
  ['Bloqueios abertos',k.blocks,'var(--occ)','aguardando resolução'],
  ['Programadas hoje',k.today,'var(--muted-c)',k.late?`${k.late} com início atrasado`:'nenhum início atrasado'],
  ['Horas efetivas hoje',dur(k.hoursToday*1000),'var(--brand)',`${k.closed_today} OS concluída(s) hoje`],
 ];
 const set=(p:Partial<Filters>)=>setFilters(f=>({...f,...p}));
 const filtered=filters.from||filters.to||filters.sector||filters.org||filters.group!=='andamento';
 const sectorOptions=[{value:'all',label:'Todos os setores'},...dash.sectors.map(s=>({value:s.code,label:`${s.code} · ${s.name}${s.active?'':' (inativo)'}`}))];
 const orgOptions=[{value:'all',label:'Todos os solicitantes'},...dash.orgs.map(o=>({value:o.id,label:`${o.acronym} · ${o.name}`}))];
 const upcoming=(next?.orders||[]).slice(0,6);
 return <>
  <div className="sn-kpis">{kpis.map(([l,v,c,d])=><div key={l} className="sn-kpi"><span className="k"><i style={{background:c}}/>{l}</span><span className="v">{v}</span><span className="d">{d}</span></div>)}</div>
  <div className="sn-filters" role="search" aria-label="Filtros do painel">
   <label className="date-filter"><CalendarRange size={15}/><span>De</span><input type="date" value={filters.from} max={filters.to||undefined} onChange={e=>set({from:e.target.value})} aria-label="Data inicial"/><span>até</span><input type="date" value={filters.to} min={filters.from||undefined} onChange={e=>set({to:e.target.value})} aria-label="Data final"/></label>
   <Choice label="Situação" value={filters.group} onChange={v=>set({group:v})} options={GROUPS}/>
   <Choice label="Código do setor" value={filters.sector||'all'} onChange={v=>set({sector:v==='all'?'':v})} options={sectorOptions}/>
   <Choice label="Solicitante" value={filters.org||'all'} onChange={v=>set({org:v==='all'?'':v})} options={orgOptions}/>
   {filtered&&<button type="button" className="chip" onClick={()=>setFilters(EMPTY)}><FilterX size={13} className="inline"/> Limpar filtros</button>}
   <Button className="primary-action sn-export" onClick={()=>setAgenda(true)}><FileDown size={16}/> Exportar agenda</Button>
  </div>
  {invalid&&<p className="form-error" role="alert">A data final deve ser igual ou posterior à inicial.</p>}
  <div className="sn-sechead"><h2>{TITLES[filters.group]}</h2><span className="eyebrow">{main.orders.length}{main.more?'+':''} OS{filters.from||filters.to?` · ${filters.from?filters.from.split('-').reverse().join('/'):'…'} a ${filters.to?filters.to.split('-').reverse().join('/'):'…'}`:''} · passe o mouse ou toque na régua para ver as etapas</span></div>
  <RulerLegend className="sn-legend"/>
  <div className="sn-board">
   {main.orders.map(o=><OrderCard key={o.id} o={o} now={now} canExecute={main.canExecute} onOpen={onOpen} onChanged={refresh}/>)}
   {!main.orders.length&&<p className="sn-empty">{filtered?'Nenhuma OS com estes filtros.':'Nenhuma OS em andamento no seu alcance.'}</p>}
   {main.more&&<p className="sn-empty">Mostrando as 100 primeiras. Use o período ou os filtros para refinar.</p>}
  </div>
  {next&&<><div className="sn-sechead"><h2>Próximas programadas</h2><span className="eyebrow">{next.counts.programadas} programada(s)</span></div>
  <div className="sn-board">
   {upcoming.map(o=><OrderCard key={o.id} o={o} now={now} canExecute={false} onOpen={onOpen} onChanged={refresh}/>)}
   {!upcoming.length&&<p className="sn-empty">Nenhuma OS programada.</p>}
  </div></>}
  <div className="sn-cols">
   <div><div className="sn-sechead"><h2>OS por solicitante</h2><span className="eyebrow">início planejado nos últimos 30 dias (até hoje)</span></div><ByOrg rows={dash.byOrg}/></div>
   <div><div className="sn-sechead"><h2>Horas efetivas por atividade</h2><span className="eyebrow">últimos 7 dias</span></div><ByActivity rows={dash.byActivity}/></div>
  </div>
  {agenda&&<AgendaDialog sectors={dash.sectors} initial={{from:filters.from,to:filters.to,sector:filters.sector}} onClose={()=>setAgenda(false)}/>}
 </>;
}

/** Exportar agenda: datas de início e fim (sem horas) e, opcionalmente, o código do setor. Gantt e
 * Lista mostram as OS; Recursos gera a agenda de recursos com os tipos e recursos escolhidos. */
function AgendaDialog({sectors,initial,onClose}:{sectors:R[],initial:{from:string,to:string,sector:string},onClose:()=>void}){
 const [from,setFrom]=useState(initial.from||today()),[to,setTo]=useState(initial.to||plusDays(initial.from||today(),6)),[sector,setSector]=useState(initial.sector);
 // Visualização e organização: as mesmas da Lista de OS e da Apresentação (começa pela última usada).
 const [view,setView]=useState<OsView>(()=>typeof window==='undefined'?DEFAULT_VIEW:readView());
 const [resMode,setResMode]=useState(false),[kinds,setKinds]=useState<ResKind[]>(ALL_KINDS),[picked,setPicked]=useState<string[]>([]),[loaded,setLoaded]=useState<{key:string,allocs:Alloc[]}|null>(null);
 const days=from&&to?Math.round((Date.parse(to)-Date.parse(from))/86400000)+1:0;
 const error=!from||!to?'':to<from?'A data de fim deve ser igual ou posterior à de início.':days>92?'Escolha um período de até 92 dias.':'';
 const ready=!!from&&!!to&&!error;
 const chosen=sectors.find(s=>s.code===sector);
 // Recursos do período (e do setor) para o seletor de recursos específicos.
 const resKey=resMode&&ready?new URLSearchParams({from:new Date(from+'T00:00:00-03:00').toISOString(),to:new Date(Date.parse(to+'T00:00:00-03:00')+86400000).toISOString(),...(sector?{sector}:{})}).toString():'';
 useEffect(()=>{if(!resKey)return;let live=true;
  load<R>('orders/resources?'+resKey).then(r=>{if(live)setLoaded({key:resKey,allocs:r.allocations as Alloc[]})}).catch(()=>{if(live)setLoaded({key:resKey,allocs:[]})});return()=>{live=false};},[resKey]);
 const allocs=loaded&&loaded.key===resKey?loaded.allocs:null;
 function submit(e:FormEvent){e.preventDefault();if(!ready)return;
  if(resMode){openPdf(resourcePdfUrl(new URLSearchParams(sector?{setor:sector}:{}),from,to,kinds,picked));onClose();return;}
  const q=viewToParams(view.arrange,EMPTY_FILTER,view.display);
  const url='/agenda?'+new URLSearchParams({inicio:from,fim:to,...(sector?{setor:sector}:{}),...Object.fromEntries(q),imprimir:'1'}).toString();
  // Nova aba para a agenda; se o navegador bloquear a aba, abre na mesma.
  const w=window.open(url,'_blank');if(w)w.opener=null;else window.open(url,'_self');onClose();}
 return <Dialog open onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="n-dialog" onEscapeKeyDown={keepOpenForPick}><DialogHeader><div className="modal-eyebrow"><FileDown size={16}/> Operação · Painel de OS</div><DialogTitle>Exportar agenda</DialogTitle>
  <DialogDescription>Agenda em PDF (A4 paisagem) com o resumo do período, os recursos e as OS em Gantt ou em lista, na organização escolhida; ou a agenda de recursos, com os tipos e recursos escolhidos. Sem código de setor, entram todas as OS programadas no período.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Data de início *"><Input type="date" required value={from} max={to||undefined} onChange={e=>setFrom(e.target.value)}/></Field>
   <Field label="Data de fim *"><Input type="date" required value={to} min={from||undefined} onChange={e=>setTo(e.target.value)}/></Field>
   <Field label="Código do setor" wide hint={chosen?chosen.name:'Opcional. Lista dos setores cadastrados em Cadastros gerais › Setores.'}><Choice value={sector||'all'} onChange={v=>setSector(v==='all'?'':v)} options={[{value:'all',label:'Todos os setores (sem distinção)'},...sectors.map(s=>({value:s.code,label:`${s.code} · ${s.name}${s.active?'':' (inativo)'}`}))]}/></Field>
   <div className="n-field wide"><label>Visualização</label><div className="segmented" role="group" aria-label="Visualização da agenda"><button type="button" aria-pressed={!resMode&&view.display==='gantt'} onClick={()=>{setResMode(false);setView(v=>({...v,display:'gantt'}))}}>Gantt</button><button type="button" aria-pressed={!resMode&&view.display==='lista'} onClick={()=>{setResMode(false);setView(v=>({...v,display:'lista'}))}}>Lista</button><button type="button" aria-pressed={resMode} onClick={()=>setResMode(true)}>Agenda de recursos</button></div></div>
   {resMode?<div className="n-field wide"><label>Recursos</label><div className="ra-pick">{allocs?<ResourcePick allocs={allocs} kinds={kinds} picked={picked} onKinds={setKinds} onPicked={setPicked}/>:<small>{ready?'Carregando os recursos do período…':'Escolha o período para listar os recursos.'}</small>}</div></div>
   :<div className="n-field wide agenda-arrange"><label>Organização</label><ArrangeControls view={{...view,filter:EMPTY_FILTER}} onChange={p=>setView(v=>({...v,...(p.arrange?{arrange:p.arrange}:{})}))} orgs={[]} sectors={[]} noFilters/></div>}
   {ready&&<p className="wide notice"><ClipboardCheck size={16}/> {days} dia(s) · {sector?`setor ${sector}`:'todos os setores'} · {resMode?`agenda de recursos (${pickSummary(kinds,picked)})`:view.display==='gantt'?'Gantt':'lista'}. A janela de impressão abre em seguida: escolha “Salvar como PDF”.</p>}
  </div>{error&&<div className="form-error" role="alert">{error}</div>}
  <div className="modal-footer"><Button type="button" variant="outline" onClick={onClose}>Voltar</Button><Button type="submit" className="primary-action" disabled={!ready}><FileDown size={16}/> Exportar agenda em PDF</Button></div></form>
 </DialogContent></Dialog>;
}

function OrderCard({o,now,canExecute,onOpen,onChanged}:{o:R;now:number;canExecute:boolean;onOpen:(id:string)=>void;onChanged:()=>Promise<void>}){
 const [pausing,setPausing]=useState<R|null>(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const steps=o.steps as R[],eff=effective(o.intervals,now);
 const active=steps.filter(s=>s.status==='em_execucao'),paused=steps.filter(s=>s.status==='pausada'),blocked=steps.filter(s=>s.status==='bloqueada');
 const pe=Date.parse(o.planned_end),ps=Date.parse(o.planned_start);
 const live=o.status==='em_andamento';
 async function run(path:string,body:R,msg:string){setBusy(true);try{const r=await post(path,{operationKey:crypto.randomUUID(),...body});toast.success(r.message||msg);setPausing(null);setReason('');await onChanged();}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 function submit(e:FormEvent){e.preventDefault();if(pausing)void run('ops/pause',{stepId:pausing.id,reason},'Etapa pausada.');}
 const current=[...active,...blocked,...paused].map(s=>`${s.name} (${STEP[s.status].toLowerCase()})`).join(' · ');
 const timing=o.status==='programada'?(ps>now?`início em ${span(ps-now)} · ${period(ps,pe)}`:`início atrasado ${span(now-ps)} · ${period(ps,pe)}`)
  :live?(pe>=now?`faltam ${span(pe-now)} · fim ${dmhm.format(pe)}`:`prazo vencido há ${span(now-pe)}`)
  :o.status==='encerramento_pendente'?'aguarda checklist para encerrar'
  :o.status==='concluida'?`concluída ${o.actual_end?dmhm.format(Date.parse(o.actual_end)):''}`:`cancelada${o.closed_at?' '+dmhm.format(Date.parse(o.closed_at)):''}`;
 return <article className="sn-card" style={{['--c' as string]:COLOR[o.status]}}>
  <div className="head">
   <span className="num">{osLabel(o.number)}{o.activity_code?` · ${o.activity_code}`:''}</span>
   <h3>{o.activity_name}</h3>
   <div className="meta"><OrgTag org={{name:o.org_name,acronym:o.org_acronym,color:o.org_color}}/>{o.location_name&&<span>{o.location_name}</span>}<Status s={o.status}/>{o.origin==='realizada'&&<span className="flag-realized" title="Registrada pela Operação depois de feita (urgência)">Realizada sem planejamento</span>}{blocked.length>0&&<span className="st bloqueada"><i/>{blocked.length} bloqueada(s)</span>}</div>
   {current&&<span className="meta">Agora: {current}</span>}
  </div>
  <div className="timer">
   {o.status==='programada'&&!eff?<span className="sn-clock sn-idle" aria-label={`Início planejado ${dmhm.format(ps)}`}><em>Início planejado</em>{dmhm.format(ps)}</span>
    :<span className="sn-clock clock-roll" aria-label={`Tempo efetivo ${hms(eff)}`}><Digits value={hms(eff)}/></span>}
   <small>{timing.split(' · ').map((part,i)=><Fragment key={i}>{i?' · ':''}<span className="nw">{part}</span></Fragment>)}</small>
   <div className="acts">
    {canExecute&&active.length===1&&<button type="button" disabled={busy} onClick={()=>setPausing(active[0])}><Pause size={14}/>Pausar</button>}
    {canExecute&&!active.length&&paused.length===1&&<button type="button" className="go" disabled={busy} onClick={()=>void run('ops/resume',{stepId:paused[0].id},'Etapa retomada.')}>{busy?<LoaderCircle size={14} className="animate-spin"/>:<Play size={14}/>}Retomar</button>}
    <button type="button" onClick={()=>onOpen(o.id)}>Apontamentos<ArrowRight size={14}/></button>
   </div>
  </div>
  {pausing&&<form className="reason" onSubmit={submit}><span className="mono" style={{fontSize:12}}>Pausar “{pausing.name}”:</span><input autoFocus required maxLength={1200} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Justificativa da pausa (obrigatória)" aria-label="Justificativa da pausa"/>
   <button type="submit" className="sn-btn go" disabled={busy||!reason.trim()}>Confirmar</button><button type="button" className="sn-btn" onClick={()=>setPausing(null)}>Voltar</button></form>}
  <div className="ruler-slot"><OsRuler compact order={o} steps={steps} intervals={o.intervals} occurrences={o.occurrences} now={now}/></div>
 </article>;
}

// Paleta do gráfico: cores distantes em tom e em claridade (legíveis lado a lado e para daltonismo).
const PARTS=[['andamento','Em andamento','#1864ab'],['programadas','Programadas','#f59f00'],['concluidas','Concluídas','#2b8a3e'],['canceladas','Canceladas','#adb5bd']] as const;
function ByOrg({rows}:{rows:R[]}){
 const [tip,setTip]=useState<{x:number,y:number,text:string}|null>(null);
 if(!rows.length)return <p className="sn-empty">Nenhuma OS nos últimos 30 dias.</p>;
 // Escala com passo inteiro (0, 1, 2… ou 0, 2, 4…), sem marcas irregulares como 0 · 3 · 5.
 const most=Math.max(...rows.map(r=>r.total)),stepN=[1,2,5,10,20,50,100].find(s=>most/s<=6)||200,max=Math.ceil(most/stepN)*stepN;
 const ticks=Array.from({length:max/stepN+1},(_,i)=>i*stepN);
 const W=640,L=120,R=36,row=30,T=6,H=T+rows.length*row+24,x=(v:number)=>L+v/max*(W-L-R);
 const show=(e:MouseEvent,text:string)=>{const box=(e.currentTarget as SVGElement).ownerSVGElement!.parentElement!.getBoundingClientRect();setTip({x:e.clientX-box.left,y:e.clientY-box.top,text});};
 return <div style={{display:'grid',gap:10}}><div className="sn-chart sn-tipbox" onMouseLeave={()=>setTip(null)}><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'OS por solicitante: '+rows.map(r=>`${r.acronym} ${r.total}`).join(', ')}>
  {ticks.map(t=><g key={t}><line className="grid" x1={x(t)} x2={x(t)} y1={T} y2={H-20}/><text x={x(t)} y={H-6} textAnchor="middle">{t}</text></g>)}
  {rows.map((r,i)=>{const y=T+i*row+6;let acc=0;return <g key={r.acronym}><text className="lbl" x={L-10} y={y+13} textAnchor="end">{r.acronym}</text>
   {PARTS.map(([k,l,c])=>{const v=r[k];if(!v)return null;const x0=x(acc);acc+=v;const text=`${r.acronym} · ${l}: ${v} OS (${Math.round(v/r.total*100)}%)`;
    return <rect key={k} x={x0} y={y} width={Math.max(1.5,x(acc)-x0-1)} height={18} rx={2} fill={c} stroke={k==='canceladas'?'#6c7c82':'none'} strokeDasharray={k==='canceladas'?'2 2':undefined} tabIndex={0} aria-label={text}
     onMouseMove={e=>show(e,text)} onFocus={e=>{const b=e.currentTarget.getBoundingClientRect(),box=e.currentTarget.ownerSVGElement!.parentElement!.getBoundingClientRect();setTip({x:b.left-box.left+b.width/2,y:b.top-box.top,text});}} onBlur={()=>setTip(null)} className="seg"/>;})}
   <text className="val" x={x(r.total)+6} y={y+13} onMouseMove={e=>show(e,`${r.acronym} · ${r.name}: ${r.total} OS no total`)}>{r.total}</text></g>;})}
 </svg>{tip&&<span className="sn-tip" style={{left:tip.x,top:tip.y}} role="status">{tip.text}</span>}</div>
 <div className="legend">{PARTS.map(([k,l,c])=><span key={k}><i style={{background:c,outline:k==='canceladas'?'1px dashed #6c7c82':undefined}}/>{l}</span>)}</div></div>;
}
function ByActivity({rows}:{rows:R[]}){
 if(!rows.length)return <p className="sn-empty">Nenhum tempo efetivo nos últimos 7 dias.</p>;
 const max=Math.max(.5,...rows.map(r=>r.s/3600)),st=[.5,1,2,5,10,20,50,100].find(s=>max/s<=5)||200,top=Math.ceil(max/st)*st;
 const W=560,L=176,R=50,row=34,T=6,H=T+rows.length*row+24,x=(v:number)=>L+v/top*(W-L-R);
 // Nome da atividade em até duas linhas (sem cortar no meio da palavra).
 const lines=(label:string)=>{const out:string[]=[''];for(const w of label.split(/\s+/)){const cur=out[out.length-1];if(!cur||(cur+' '+w).length<=24)out[out.length-1]=cur?cur+' '+w:w;else if(out.length<2)out.push(w);else{out[1]=(out[1]+' '+w).slice(0,23)+'…';break;}}return out.map(l=>l.length>24?l.slice(0,23)+'…':l);};
 return <div className="sn-chart"><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'Horas efetivas por atividade: '+rows.map(r=>`${r.label} ${(r.s/3600).toFixed(1)} h`).join(', ')}>
  {Array.from({length:Math.round(top/st)+1},(_,i)=>i*st).map(t=><g key={t}><line className="grid" x1={x(t)} x2={x(t)} y1={T} y2={H-20}/><text x={x(t)} y={H-6} textAnchor="middle">{String(t).replace('.',',')}h</text></g>)}
  {rows.map((r,i)=>{const y=T+i*row+6,v=r.s/3600;return <g key={r.label}><title>{`${r.label}: ${dur(r.s*1000)}`}</title>{lines(String(r.label)).map((l,j,a)=><text key={j} className="lbl" x={L-10} y={y+13+(j-(a.length-1)/2)*12} textAnchor="end">{l}</text>)}
   <rect className={i===0?'b-hot':'b-main'} x={L} y={y} width={Math.max(2,x(v)-L)} height={18} rx={2}/><text className="val" x={x(v)+6} y={y+13}>{v.toFixed(1).replace('.',',')}</text></g>;})}
 </svg></div>;
}
