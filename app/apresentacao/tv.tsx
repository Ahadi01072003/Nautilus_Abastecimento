'use client';
// Apresentação para TV com duas telas: (1) Ordens de Serviço, em lista ou Gantt, e (2) Recursos
// alocados (equipamentos, materiais e colaboradores das OS exibidas). Abre em modo manual (rolagem
// por mouse, barra, teclado ou toque). "Iniciar apresentação" percorre as duas telas em ciclo:
// topo → rolagem completa → pausa de leitura → troca de tela. Filtros, organização e Lista/Gantt
// usam a mesma regra e a mesma configuração da Lista de OS (lib/os-order + app/os-arrange).
import {Fragment,useCallback,useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {Maximize,Minimize,Pause,Play,Square,ArrowLeft,Truck,Users,Package,AlertTriangle,Radio,WifiOff,SlidersHorizontal} from 'lucide-react';
import Link from 'next/link';
import type {R} from '../kit';
import {ArrangeControls,MultiPick,DEFAULT_VIEW,readView,writeView,type OsView} from '../os-arrange';
import {barsOf} from '../gantt';
import {arrangeOrders,flatRows,viewFromParams,viewToParams,EMPTY_FILTER,type Flags,type OsGroup,type OsItem} from '@/lib/os-order';
import './tv.css';

const H=3600_000,DAY=24*H,OFF=3*H;
const TZ='America/Sao_Paulo';
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const wd=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'short'});
const longDate=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'long',day:'2-digit',month:'long',year:'numeric'});
const os=(n:number)=>'OS '+String(n).padStart(6,'0');
const STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const PERIODS=[{d:1,l:'Hoje'},{d:3,l:'3 dias'},{d:7,l:'7 dias'},{d:14,l:'14 dias'}];
const SPEEDS=[{v:25,l:'Lenta'},{v:45,l:'Normal'},{v:80,l:'Rápida'}];
const READS=[{v:5,l:'5 s'},{v:8,l:'8 s'},{v:15,l:'15 s'}];
const DWELLS=[{v:10,l:'10 s'},{v:15,l:'15 s'},{v:30,l:'30 s'}];
const TOP_HOLD=2500,FADE=350;
const t=(v?:string|null)=>{if(!v)return null;const x=Date.parse(v);return Number.isFinite(x)?x:null;};
const period=(a?:string|null,b?:string|null)=>{const x=t(a),y=t(b);if(x==null)return '—';if(y==null)return `${dm.format(x)} ${hm.format(x)} →`;return dm.format(x)===dm.format(y)?`${dm.format(x)} ${hm.format(x)}–${hm.format(y)}`:`${dm.format(x)} ${hm.format(x)} → ${dm.format(y)} ${hm.format(y)}`;};
const qty=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:3});

type Screen='os'|'res';
/** Tela 2 · filtros de recurso: tipos (separados ou juntos) e recursos específicos. Ficam na URL
 * (a TV volta igual depois de recarregar) e no navegador. */
type ResKind='equipamento'|'material'|'colaborador';
type ResFilter={kinds:ResKind[],picked:string[]};
const RES_KINDS:{id:ResKind,label:string,one:string,icon:typeof Truck}[]=[{id:'equipamento',label:'Equipamentos',one:'Equipamento',icon:Truck},{id:'material',label:'Materiais',one:'Material',icon:Package},{id:'colaborador',label:'Colaboradores',one:'Colaborador',icon:Users}];
const ALL_RES:ResKind[]=RES_KINDS.map(k=>k.id);
const RES_KEY='nautilus.tv.res';
function resFromParams(q:URLSearchParams):ResFilter|null{
 if(!q.has('rtipos')&&!q.has('rrec'))return null;
 const kinds=(q.get('rtipos')||'').split(',').filter((k):k is ResKind=>ALL_RES.includes(k as ResKind));
 return {kinds:kinds.length?kinds:ALL_RES,picked:(q.get('rrec')||'').split(',').filter(x=>/^[emc]:/.test(x)).slice(0,300)};
}
function readRes():ResFilter{try{const v=JSON.parse(localStorage.getItem(RES_KEY)||'null');const kinds=Array.isArray(v?.kinds)?v.kinds.filter((k:string)=>ALL_RES.includes(k as ResKind)):[];
 return {kinds:kinds.length?kinds:ALL_RES,picked:Array.isArray(v?.picked)?v.picked.filter((x:unknown)=>typeof x==='string'):[]};}catch{return {kinds:ALL_RES,picked:[]};}}
/** Recursos das OS exibidas, para o seletor: "e:<id>" equipamento, "m:<id>|<unidade>" material, "c:<id>" colaborador. */
function resOptions(rows:R[],kinds:ResKind[]){
 const m=new Map<string,{value:string,label:string,k:number}>();
 const add=(kind:ResKind,value:string,label:string)=>{if(kinds.includes(kind)&&!m.has(value))m.set(value,{value,label:`${RES_KINDS.find(x=>x.id===kind)!.one}: ${label}`,k:ALL_RES.indexOf(kind)});};
 for(const o of rows){for(const e of o.equipment as R[])add('equipamento','e:'+e.id,e.tag);for(const x of o.materials as R[])add('material',`m:${x.id}|${x.unit}`,`${x.name} (${x.unit})`);for(const x of o.people as R[])add('colaborador','c:'+x.id,x.name);}
 return [...m.values()].sort((a,b)=>a.k-b.k||a.label.localeCompare(b.label,'pt-BR'));
}
type RunState='manual'|'running'|'paused';
type Phase='top'|'scroll'|'end'|'dwell'|'switch';
type Settings={speed:number,read:number,dwell:number};
const SETTINGS_KEY='nautilus.tv.auto';
const readSettings=():Settings=>{try{const s=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null');if(s&&SPEEDS.some(x=>x.v===s.speed)&&READS.some(x=>x.v===s.read)&&DWELLS.some(x=>x.v===s.dwell))return s;}catch{}return {speed:45,read:8,dwell:15};};

/** Apresentação automática: um ciclo só (nunca dois laços ao mesmo tempo). Pausa preserva tela e
 * posição; continuar retoma do mesmo ponto; encerrar devolve o controle manual. */
function usePresenter(stage:RefObject<HTMLElement|null>,setScreen:(f:(s:Screen)=>Screen)=>void,settings:Settings){
 const [state,setState]=useState<RunState>('manual'),[phase,setPhase]=useState<Phase>('top'),[fading,setFading]=useState(false);
 const e=useRef({raf:0,timer:0 as ReturnType<typeof setTimeout>|0,phase:'top' as Phase,deadline:0,next:null as null|(()=>void),remaining:0,pos:0,last:0});
 const cfg=useRef(settings);useEffect(()=>{cfg.current=settings;},[settings]);
 const halt=useCallback(()=>{const x=e.current;cancelAnimationFrame(x.raf);if(x.timer)clearTimeout(x.timer);x.raf=0;x.timer=0;},[]);
 const enter=useCallback(function enter(p:Phase){
  const x=e.current;halt();x.phase=p;setPhase(p);
  const el=stage.current;if(!el)return;
  const max=()=>el.scrollHeight-el.clientHeight;
  const wait=(ms:number,next:()=>void)=>{x.next=next;x.deadline=performance.now()+ms;x.timer=setTimeout(()=>{x.timer=0;x.next=null;next();},ms);};
  if(p==='top')wait(TOP_HOLD,()=>enter(max()>2?'scroll':'dwell'));
  else if(p==='end')wait(cfg.current.read*1000,()=>enter('switch'));
  else if(p==='dwell')wait(cfg.current.dwell*1000,()=>enter('switch'));
  else if(p==='switch'){setFading(true);wait(FADE,()=>{setScreen(s=>s==='os'?'res':'os');requestAnimationFrame(()=>requestAnimationFrame(()=>{el.scrollTop=0;setFading(false);enter('top');}));});}
  else{x.next=null;x.pos=el.scrollTop;x.last=performance.now();
   const step=(now:number)=>{const dt=Math.min(100,now-x.last);x.last=now;const m=max();
    if(m<=2){enter('dwell');return;}
    x.pos=Math.min(m,x.pos+cfg.current.speed*dt/1000);el.scrollTop=x.pos;
    if(x.pos>=m-0.5){enter('end');return;}
    x.raf=requestAnimationFrame(step);};
   x.raf=requestAnimationFrame(step);}
 },[halt,setScreen,stage]);
 const start=useCallback(()=>{halt();setFading(false);setScreen(()=>'os');setState('running');requestAnimationFrame(()=>requestAnimationFrame(()=>{if(stage.current)stage.current.scrollTop=0;enter('top');}));},[enter,halt,setScreen,stage]);
 const pause=useCallback(()=>{const x=e.current;if(x.next)x.remaining=Math.max(0,x.deadline-performance.now());halt();setFading(false);setState(s=>s==='running'?'paused':s);},[halt]);
 const resume=useCallback(()=>{const x=e.current;setState('running');
  if(x.phase==='scroll')enter('scroll');
  else if(x.next){const n=x.next;x.deadline=performance.now()+x.remaining;x.timer=setTimeout(()=>{x.timer=0;x.next=null;n();},x.remaining);}
  else enter(x.phase==='switch'?'top':x.phase);},[enter]);
 const stop=useCallback(()=>{halt();e.current.next=null;setFading(false);setState('manual');setPhase('top');},[halt]);
 useEffect(()=>()=>halt(),[halt]);
 return {state,phase,fading,start,pause,resume,stop};
}

export default function Tv({initialDays,query}:{initialDays:number,query:string}){
 const [days,setDays]=useState(initialDays),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[lost,setLost]=useState<number|null>(null);
 const [tick,setTick]=useState(()=>Date.now()),[offset,setOffset]=useState(0),[full,setFull]=useState(false),[idle,setIdle]=useState(false),[screen,setScreen]=useState<Screen>('os');
 // Configuração herdada da tela de origem (URL); sem ela, a última usada neste navegador.
 const [view,setViewState]=useState<OsView>(()=>{const p=viewFromParams(new URLSearchParams(query));return p.arrange?{arrange:p.arrange,filter:p.filter||EMPTY_FILTER,display:p.display==='gantt'?'gantt':'lista'}:DEFAULT_VIEW;});
 const fromUrl=useRef(new URLSearchParams(query).has('modo'));
 const [res,setResState]=useState<ResFilter>(()=>resFromParams(new URLSearchParams(query))||{kinds:ALL_RES,picked:[]});
 useEffect(()=>{if(!resFromParams(new URLSearchParams(query)))setResState(readRes());},[]); // eslint-disable-line react-hooks/exhaustive-deps
 const setRes=(p:Partial<ResFilter>)=>setResState(v=>{const n={...v,...p};try{localStorage.setItem(RES_KEY,JSON.stringify(n))}catch{}return n;});
 useEffect(()=>{if(!fromUrl.current)setViewState(readView());else writeView(view);},[]); // eslint-disable-line react-hooks/exhaustive-deps
 const [settings,setSettings]=useState<Settings>({speed:45,read:8,dwell:15});
 useEffect(()=>{setSettings(readSettings());},[]);
 const stage=useRef<HTMLElement>(null);
 const p=usePresenter(stage,setScreen,settings);
 const ctl=useRef(p);ctl.current=p;
 const setView=(patch:Partial<OsView>)=>setViewState(v=>{const n={...v,...patch};writeView(n);return n;});
 const saveSettings=(s:Partial<Settings>)=>setSettings(o=>{const n={...o,...s};try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(n))}catch{}return n;});

 const abort=useRef<AbortController|null>(null);
 const load=useCallback(async()=>{
  abort.current?.abort();const ac=new AbortController();abort.current=ac;
  try{const r=await fetch('/api/tv?dias='+days,{cache:'no-store',signal:ac.signal});const j=await r.json().catch(()=>({}));
   if(r.status===401){setError('Sua sessão expirou. Entre novamente no NAUTILUS e abra a apresentação outra vez.');return;}
   if(!r.ok)throw new Error(j.error||'Não foi possível carregar.');
   setOffset(Date.parse(j.serverNow)-Date.now());setData(j);setError('');setLost(null);}
  catch(e){if((e as Error).name==='AbortError')return;setLost(l=>l??Date.now());setError(x=>x||(e as Error).message);}
 },[days]);
 // Atualização a cada minuto; ao sair da tela, a consulta pendente e os temporizadores param.
 useEffect(()=>{void load();const i=setInterval(()=>void load(),60000);return()=>{clearInterval(i);abort.current?.abort();};},[load]);
 useEffect(()=>{const i=setInterval(()=>setTick(Date.now()),1000);return()=>clearInterval(i);},[]);
 // Configuração na URL (a TV volta igual depois de recarregar).
 useEffect(()=>{const q=viewToParams(view.arrange,view.filter,view.display);q.set('dias',String(days));
  if(res.kinds.length<ALL_RES.length)q.set('rtipos',res.kinds.join(','));if(res.picked.length)q.set('rrec',res.picked.join(','));
  history.replaceState(null,'','?'+q.toString());},[view,days,res]);
 // Mudou filtro, organização, Lista/Gantt ou período: pausa, recalcula e volta ao topo da tela atual.
 const first=useRef(true);
 useEffect(()=>{if(first.current){first.current=false;return;}ctl.current.pause();if(stage.current)stage.current.scrollTop=0;},[view,days,res]);
 // Rolagem manual durante a apresentação automática: pausa (sem disputa entre pessoa e sistema).
 // O palco só existe depois da primeira carga (ready).
 const ready=!!data;
 useEffect(()=>{const el=stage.current;if(!el)return;
  const grab=()=>{if(ctl.current.state==='running')ctl.current.pause();};
  const key=(e:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)&&!(e.target as HTMLElement).closest('input,select,textarea,button,summary'))grab();};
  el.addEventListener('wheel',grab,{passive:true});el.addEventListener('touchstart',grab,{passive:true});el.addEventListener('pointerdown',grab);window.addEventListener('keydown',key);
  return()=>{el.removeEventListener('wheel',grab);el.removeEventListener('touchstart',grab);el.removeEventListener('pointerdown',grab);window.removeEventListener('keydown',key);};},[ready]);
 // Tela da TV não apaga enquanto a apresentação está aberta (quando o navegador permite).
 useEffect(()=>{let lock:{release:()=>Promise<void>}|null=null;const nav=navigator as unknown as {wakeLock?:{request:(t:string)=>Promise<{release:()=>Promise<void>}>}};
  const ask=()=>{nav.wakeLock?.request('screen').then(l=>{lock=l;}).catch(()=>{});};ask();
  const vis=()=>{if(!document.hidden)ask();};document.addEventListener('visibilitychange',vis);
  return()=>{document.removeEventListener('visibilitychange',vis);lock?.release().catch(()=>{});};},[]);
 // Durante a apresentação automática, os controles recolhem depois de 5 s sem mexer o mouse.
 useEffect(()=>{let to=setTimeout(()=>setIdle(true),5000);const wake=()=>{setIdle(false);clearTimeout(to);to=setTimeout(()=>setIdle(true),5000);};
  window.addEventListener('mousemove',wake);window.addEventListener('keydown',wake);window.addEventListener('touchstart',wake);
  const fs=()=>setFull(!!document.fullscreenElement);document.addEventListener('fullscreenchange',fs);
  return()=>{clearTimeout(to);window.removeEventListener('mousemove',wake);window.removeEventListener('keydown',wake);window.removeEventListener('touchstart',wake);document.removeEventListener('fullscreenchange',fs);};},[]);
 const now=tick+offset;
 // Instante de referência compartilhado pela organização e pelas barras (muda a cada minuto).
 const minute=Math.floor(now/60000)*60000;
 const groups=useMemo(()=>data?arrangeOrders(data.orders as (OsItem&R)[],view.arrange,view.filter,minute):[],[data,view.arrange,view.filter,minute]);
 const rows=useMemo(()=>flatRows(groups),[groups]);
 const resOpts=useMemo(()=>resOptions(rows.map(r=>r.item),res.kinds),[rows,res.kinds]);
 const resPicked=res.picked.filter(p=>resOpts.some(o=>o.value===p));
 const toggleFull=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen().catch(()=>{});};
 const goScreen=(s:Screen)=>{if(p.state==='running')p.pause();setScreen(s);requestAnimationFrame(()=>{if(stage.current)stage.current.scrollTop=0;});};

 if(error&&!data)return <main className="tv tv-msg"><AlertTriangle size={40}/><h1>Apresentação indisponível</h1><p>{error}</p><Link href="/">Voltar ao NAUTILUS</Link></main>;
 if(!data)return <main className="tv tv-msg"><Radio size={40}/><h1>Carregando a apresentação…</h1></main>;

 const counts={andamento:rows.filter(r=>r.item.status==='em_andamento').length,atraso:rows.filter(r=>r.flags.late||r.flags.overdue).length,previstas:rows.filter(r=>r.item.status==='programada'&&!r.flags.late).length,canceladas:rows.filter(r=>r.item.status==='cancelada').length};
 const collapsed=p.state==='running'&&idle;
 const stateLabel=p.state==='running'?`Apresentação automática · tela ${screen==='os'?1:2} de 2 · ${p.phase==='scroll'?'rolando':p.phase==='end'?'pausa de leitura':p.phase==='dwell'?'tela inteira à vista':p.phase==='switch'?'trocando de tela':'no topo'}`:p.state==='paused'?`Apresentação pausada na tela ${screen==='os'?1:2} de 2`:'Modo manual: role com o mouse, a barra, o teclado ou o toque';
 return <div className={`tv${collapsed?' idle':''}`} data-state={p.state}>
  <header className="tv-top">
   <div className="tv-title"><span><i className={p.state==='running'?'pulse':'dot'}/>{stateLabel}</span><h1>{screen==='os'?'Ordens de Serviço':'Recursos alocados'}<small>{rows.length} OS · {dm.format(Date.parse(data.window.from))} a {dm.format(Date.parse(data.window.to)-1)}</small></h1></div>
   <div className="tv-mini" aria-label="Resumo das OS exibidas"><span className="live"><b>{counts.andamento}</b>em andamento</span><span className="warn"><b>{counts.atraso}</b>com atraso</span><span><b>{counts.previstas}</b>previstas</span>{counts.canceladas>0&&<span className="dim"><b>{counts.canceladas}</b>canceladas</span>}</div>
   <div className="tv-clock"><b>{hm.format(now)}<em>:{String(new Date(now).getUTCSeconds()).padStart(2,'0')}</em></b><small>{longDate.format(now)}</small></div>
  </header>
  <nav className={`tv-controls${collapsed?' min':''}`} aria-label="Controles da apresentação">
   <div className="tv-crow">
    <div className="segmented tv-tabs" role="tablist" aria-label="Tela">{(['os','res'] as Screen[]).map((s,i)=><button key={s} role="tab" type="button" aria-selected={screen===s} onClick={()=>goScreen(s)}>{i+1} · {s==='os'?'Ordens de Serviço':'Recursos alocados'}</button>)}</div>
    <div className="segmented" role="group" aria-label="Visualização das OS"><button type="button" aria-pressed={view.display==='lista'} onClick={()=>setView({display:'lista'})}>Lista</button><button type="button" aria-pressed={view.display==='gantt'} onClick={()=>setView({display:'gantt'})}>Gantt</button></div>
    <div className="segmented" role="group" aria-label="Período">{PERIODS.map(x=><button key={x.d} type="button" aria-pressed={days===x.d} onClick={()=>setDays(x.d)}>{x.l}</button>)}</div>
    <div className="tv-run" role="group" aria-label="Apresentação automática">
     {p.state==='manual'&&<button type="button" className="go" onClick={p.start}><Play size={15}/> Iniciar apresentação</button>}
     {p.state==='running'&&<button type="button" onClick={p.pause}><Pause size={15}/> Pausar</button>}
     {p.state==='paused'&&<button type="button" className="go" onClick={p.resume}><Play size={15}/> Continuar</button>}
     {p.state!=='manual'&&<button type="button" onClick={p.stop}><Square size={13}/> Encerrar apresentação</button>}
    </div>
    <details className="tv-set"><summary><SlidersHorizontal size={15}/> Ritmo</summary><div>
     <label>Velocidade da rolagem<select value={settings.speed} onChange={e=>saveSettings({speed:Number(e.target.value)})}>{SPEEDS.map(x=><option key={x.v} value={x.v}>{x.l}</option>)}</select></label>
     <label>Pausa de leitura no fim<select value={settings.read} onChange={e=>saveSettings({read:Number(e.target.value)})}>{READS.map(x=><option key={x.v} value={x.v}>{x.l}</option>)}</select></label>
     <label>Tela que cabe inteira<select value={settings.dwell} onChange={e=>saveSettings({dwell:Number(e.target.value)})}>{DWELLS.map(x=><option key={x.v} value={x.v}>{x.l}</option>)}</select></label>
    </div></details>
    <span className="tv-sp"/>
    <button type="button" className="tv-ic" onClick={toggleFull}>{full?<Minimize size={15}/>:<Maximize size={15}/>} {full?'Sair da tela cheia':'Tela cheia'}</button>
    <Link className="tv-ic" href="/"><ArrowLeft size={15}/> Voltar</Link>
   </div>
   <ArrangeControls dark view={view} onChange={setView} orgs={data.orgs} sectors={data.sectors}/>
   {screen==='res'&&<div className="tv-crow tv-resf" aria-label="Filtros de recursos (tela 2)"><span className="tv-resk">Recursos</span>
    <div className="segmented" role="group" aria-label="Tipos de recurso">{RES_KINDS.map(k=>{const I=k.icon,on=res.kinds.includes(k.id);
     return <button key={k.id} type="button" aria-pressed={on} onClick={()=>setRes({kinds:on?(res.kinds.length>1?res.kinds.filter(x=>x!==k.id):res.kinds):ALL_RES.filter(x=>x===k.id||res.kinds.includes(x))})}><I size={14}/> {k.label}</button>;})}</div>
    <MultiPick label="Recurso" all="Todos dos tipos marcados" options={resOpts} value={resPicked} onChange={picked=>setRes({picked})}/>
    {(res.kinds.length<ALL_RES.length||resPicked.length>0)&&<button type="button" className="tv-ic" onClick={()=>setRes({kinds:ALL_RES,picked:[]})}>Limpar filtros de recursos</button>}
   </div>}
  </nav>
  <main ref={stage} className="tv-stage" tabIndex={0} aria-label={screen==='os'?'Ordens de Serviço':'Recursos alocados'}>
   <div className={`tv-screen${p.fading?' fade':''}`}>
    {screen==='os'?(rows.length?(view.display==='gantt'?<TvGantt groups={groups} now={minute} from={Date.parse(data.window.from)} to={Date.parse(data.window.to)}/>:<TvList groups={groups}/>)
     :<Empty title="Nenhuma OS com estes filtros" text="Ajuste o solicitante, o setor ou o período nos controles acima."/>)
     :<TvResources rows={rows.map(r=>r.item)} kinds={res.kinds} picked={resPicked}/>}
   </div>
  </main>
  <footer className="tv-foot">
   {lost&&<span className="lost"><WifiOff size={15}/> Sem conexão desde {hm.format(lost)} · mostrando os últimos dados</span>}
   {data.truncated&&<span className="lost">Mostrando as 400 primeiras OS do período.</span>}
   {screen==='os'&&view.display==='gantt'&&<span className="tv-key"><i className="k-plan"/>Planejado (frente) <i className="k-real"/>Executado (atrás, deslocado) <i className="k-open"/>Em execução <i className="k-now"/>Agora</span>}
   <span className="tv-sp"/><span>Atualizado às {hm.format(Date.parse(data.serverNow))}</span>
  </footer>
 </div>;
}

function Empty({title,text}:{title:string,text:string}){return <div className="tv-empty"><b>{title}</b><p>{text}</p></div>;}

function FlagChips({o,flags}:{o:R,flags:Flags}){
 return <>{flags.late&&<em className="warn">Início vencido</em>}{flags.overdue&&<em className="occ">Prazo vencido</em>}{flags.noStart&&<em className="warn">Sem início planejado</em>}{flags.issues.length>0&&<em className="occ" title={flags.issues.join('\n')}><AlertTriangle size={12}/> Datas inconsistentes</em>}{o.origin==='realizada'&&<em>Realizada sem planejamento</em>}</>;
}
const groupHead=(g:OsGroup<OsItem&R>)=>g.label?<div className="tv-ghead"><b>{g.label}</b><span>{g.rows.length} OS</span>{g.note&&<small>{g.note}</small>}</div>:null;

/** Tela 1 · lista: uma linha por OS, na ordem e nos grupos da organização escolhida. */
function TvList({groups}:{groups:OsGroup<OsItem&R>[]}){
 return <div className="tvl" role="table" aria-label="Ordens de Serviço">
  <div className="tvl-row tvl-h" role="row"><span>OS</span><span>Situação</span><span>Atividade</span><span>Solicitante</span><span>Planejado</span><span>Real</span><span>Recursos</span></div>
  {groups.map(g=><Fragment key={g.key}>{groupHead(g)}{g.rows.map(({item:o,flags})=><div key={o.id} className={`tvl-row s-${o.status}`} role="row" style={{['--org' as string]:o.org_color}}>
   <span className="tvl-os"><b>{os(o.number)}</b>{o.sector_code?<small>{o.sector_code}</small>:<small className="dim">Sem setor</small>}</span>
   <span className="tvl-st"><i className={`st ${o.status}`}>{STATUS[o.status]||o.status}</i><FlagChips o={o} flags={flags}/></span>
   <span className="tvl-act"><b>{o.activity_name}</b><small>{o.location_name||'—'}</small></span>
   <span className="tvl-org"><i/><b>{o.org_acronym}</b><small>{o.requester_name||o.org_name}</small></span>
   <span>{o.planned_start?period(o.planned_start,o.planned_end):<em className="warn">Sem início planejado</em>}</span>
   <span>{o.actual_start?period(o.actual_start,o.actual_end)+(o.actual_end?'':' em curso'):'—'}</span>
   <span className="tvl-res"><span title="Equipamentos"><Truck size={14}/>{(o.equipment as R[]).length}</span><span title="Colaboradores"><Users size={14}/>{new Set((o.people as R[]).map(x=>x.id)).size}</span><span title="Materiais"><Package size={14}/>{(o.materials as R[]).length}</span></span>
  </div>)}</Fragment>)}
 </div>;
}

/** Tela 1 · Gantt: mesmas linhas da lista; barra planejada à frente e executada atrás, deslocada. */
function TvGantt({groups,now,from,to}:{groups:OsGroup<OsItem&R>[],now:number,from:number,to:number}){
 const rows=flatRows(groups);
 // Eixo: o período escolhido, alargado para caber antecipações, prolongamentos e OS em curso (até 30 dias).
 const ts=rows.flatMap(({item})=>{const b=barsOf(item,now);return [...(b.plan||[]),...(b.real||[])];});
 const a=Math.max(Math.min(from,...ts),to-30*DAY),b=Math.min(Math.max(to,...ts),a+30*DAY);
 const start=Math.floor((a-OFF)/DAY)*DAY+OFF,end=Math.ceil((b-OFF)/DAY)*DAY+OFF,span=end-start;
 const x=(v:number)=>(v-start)/span*100;
 const box=(p:readonly [number,number])=>{const l=Math.max(-0.5,x(p[0])),r=Math.min(100.5,x(p[1]));return r<=l?null:{left:`${l}%`,width:`${Math.max(.35,r-l)}%`};};
 const days=Array.from({length:Math.round(span/DAY)},(_,i)=>start+i*DAY);
 const hourStep=days.length<=2?3:days.length<=4?6:0;
 return <div className="tvg">
  <div className="tvg-head"><span className="tvg-lbl">OS · {rows.length}</span><div className="tvg-axis">{days.map(d=><span key={d} className={Math.floor((now-OFF)/DAY)*DAY+OFF===d?'today':''} style={{left:`${x(d)}%`,width:`${100/days.length}%`}}><em>{wd.format(d).replace('.','')}</em><b>{dm.format(d)}</b></span>)}</div></div>
  <div className="tvg-body">
   <div className="tvg-grid" aria-hidden>{days.map(d=><i key={d} style={{left:`${x(d)}%`}}/>)}{hourStep>0&&days.flatMap(d=>Array.from({length:24/hourStep-1},(_,k)=>d+(k+1)*hourStep*H)).map(h=><i key={h} className="h" style={{left:`${x(h)}%`}}/>)}{now>start&&now<end&&<i className="now" style={{left:`${x(now)}%`}}/>}</div>
   {groups.map(g=><Fragment key={g.key}>{groupHead(g)}{g.rows.map(({item:o,flags})=>{const bb=barsOf(o,now);const pb=bb.plan&&box(bb.plan),rb=bb.real&&box(bb.real);
    const ref=bb.plan?.[0]??bb.real?.[0]??null,refEnd=bb.plan?.[1]??bb.real?.[1]??null;const off=!pb&&!rb&&ref!=null?(refEnd!<start?'left':'right'):null;
    return <div key={o.id} className={`tvg-row s-${o.status}`} style={{['--org' as string]:o.org_color}}>
     <div className="tvg-lbl"><b>{os(o.number)}{o.sector_code?` · ${o.sector_code}`:''}</b><span>{o.activity_name}</span><small><i className={`st ${o.status}`}>{STATUS[o.status]||o.status}</i><FlagChips o={o} flags={flags}/></small></div>
     <div className="tvg-track" title={bb.lines.join('\n')}>
      {rb&&<i className={`tvg-real${bb.open?' open':''}`} style={rb}/>}
      {pb&&<span className="tvg-plan" style={pb}><b>{o.org_acronym}</b></span>}
      {!bb.plan&&<span className="tvg-note">{flags.noStart?'Sem início planejado':'Datas planejadas inconsistentes'}</span>}
      {off&&<span className={`tvg-off ${off}`}>{off==='left'?`◂ ${dm.format(ref!)}`:`${dm.format(ref!)} ▸`}</span>}
     </div>
    </div>;})}</Fragment>)}
  </div>
 </div>;
}

/** Tela 2 · recursos alocados às OS exibidas: equipamentos e colaboradores por alocação (um recurso
 * em várias OS aparece em cada uma, mas conta uma vez no total de distintos) e materiais por
 * material + unidade (unidades diferentes nunca se somam). */
function TvResources({rows,kinds,picked}:{rows:R[],kinds:ResKind[],picked:string[]}){
 const keep=(k:ResKind,id:string)=>kinds.includes(k)&&(!picked.length||picked.includes(id));
 const tag=(o:R)=>`${os(o.number)}${o.sector_code?` · ${o.sector_code}`:' · sem setor'}`;
 const eq=new Map<string,R>();for(const o of rows)for(const e of o.equipment as R[]){if(!keep('equipamento','e:'+e.id))continue;const g=eq.get(e.id)||{tag:e.tag,desc:[e.type,e.description].filter(Boolean).join(' · '),uses:[] as R[]};g.uses.push({o,start:e.start,end:e.end,step:e.step});eq.set(e.id,g);}
 const ppl=new Map<string,R>();for(const o of rows)for(const x of o.people as R[]){if(!keep('colaborador','c:'+x.id))continue;const g=ppl.get(x.id)||{name:x.name,fn:x.functions,uses:[] as R[]};g.uses.push({o,start:x.start,end:x.end,step:x.step});ppl.set(x.id,g);}
 const mat=new Map<string,R>();for(const o of rows)for(const m of o.materials as R[]){if(!keep('material',`m:${m.id}|${m.unit}`))continue;const k=m.id+'|'+m.unit;const g=mat.get(k)||{name:m.name,unit:m.unit,total:0,uses:[] as R[]};g.total+=m.amount;g.uses.push({o,amount:m.amount});mat.set(k,g);}
 const sortUses=(u:R[])=>u.sort((a,b)=>(t(a.start)??Infinity)-(t(b.start)??Infinity)||a.o.number-b.o.number);
 const eqList=[...eq.values()].sort((a,b)=>String(a.tag).localeCompare(String(b.tag),'pt-BR'));
 const pplList=[...ppl.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt-BR'));
 const matList=[...mat.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt-BR')||String(a.unit).localeCompare(String(b.unit)));
 const allocE=eqList.reduce((n,g)=>n+g.uses.length,0),allocP=pplList.reduce((n,g)=>n+g.uses.length,0);
 if(!rows.length)return <Empty title="Nenhuma OS com estes filtros" text="Os recursos aparecem para as OS exibidas na tela 1."/>;
 return <div className="tvr">
  {kinds.includes('equipamento')&&<section><h2><Truck size={20}/> Equipamentos<small>{eqList.length} distinto(s) · {allocE} alocação(ões)</small></h2>
   {eqList.length?<div className="tvr-grid">{eqList.map(g=><article key={g.tag}><header><b>{g.tag}</b><span>{g.desc||'—'}</span><em>{g.uses.length}× alocado</em></header>
    <ul>{sortUses(g.uses).map((u:R,i:number)=><li key={i}><b>{tag(u.o)}</b><span>{period(u.start,u.end)}</span>{u.step&&<small>{u.step}</small>}</li>)}</ul></article>)}</div>
   :<p className="tvr-none">{picked.length?'Nenhum dos equipamentos escolhidos está alocado nas OS exibidas.':'Nenhum equipamento alocado nas OS exibidas.'}</p>}</section>}
  {kinds.includes('material')&&<section><h2><Package size={20}/> Materiais<small>{matList.length} item(ns) por material e unidade</small></h2>
   {matList.length?<div className="tvr-grid">{matList.map(g=><article key={g.name+g.unit}><header><b>{g.name}</b><span>Total {qty(g.total)} {g.unit}</span><em>{g.uses.length} OS</em></header>
    <ul>{g.uses.sort((a:R,b:R)=>a.o.number-b.o.number).map((u:R,i:number)=><li key={i}><b>{tag(u.o)}</b><span>{qty(u.amount)} {g.unit}</span></li>)}</ul></article>)}</div>
   :<p className="tvr-none">{picked.length?'Nenhum dos materiais escolhidos está previsto nas OS exibidas.':'Nenhum material previsto nas OS exibidas.'}</p>}</section>}
  {kinds.includes('colaborador')&&<section><h2><Users size={20}/> Colaboradores<small>{pplList.length} distinto(s) · {allocP} alocação(ões)</small></h2>
   {pplList.length?<div className="tvr-grid">{pplList.map(g=><article key={g.name}><header><b>{g.name}</b><span>{g.fn||'Sem função cadastrada'}</span><em>{g.uses.length}× alocado</em></header>
    <ul>{sortUses(g.uses).map((u:R,i:number)=><li key={i}><b>{tag(u.o)}</b><span>{period(u.start,u.end)}</span>{u.step&&<small>{u.step}</small>}</li>)}</ul></article>)}</div>
   :<p className="tvr-none">{picked.length?'Nenhum dos colaboradores escolhidos está alocado nas OS exibidas.':'Nenhum colaborador alocado nas OS exibidas.'}</p>}</section>}
 </div>;
}
