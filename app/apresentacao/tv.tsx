'use client';
// Apresentação para TV: cabeçalho com relógio, indicadores do turno, cronograma de todas as OS do
// período (OS no eixo vertical, datas no horizontal, planejado × executado) e, ao lado, o que está
// em execução agora, as próximas, os recursos em uso e os pontos de atenção. Atualiza a cada minuto;
// listas maiores que a tela rolam sozinhas (de cima para baixo, com pausa nas pontas).
import {useCallback,useEffect,useMemo,useRef,useState,type CSSProperties,type RefObject} from 'react';
import {Maximize,Minimize,Pause,Play,ArrowLeft,Truck,Users,Package,AlertTriangle,Clock,Radio,WifiOff} from 'lucide-react';
import Link from 'next/link';
import {effective} from '../os-ruler';
import {hms} from '../ops-board';
import type {R} from '../kit';
import './tv.css';

const H=3600_000,DAY=24*H,OFF=3*H;
const TZ='America/Sao_Paulo';
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const wd=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'short'});
const longDate=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'long',day:'2-digit',month:'long',year:'numeric'});
const os=(n:number)=>'OS '+String(n).padStart(6,'0');
const STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída'};
const STEP:Record<string,string>={em_execucao:'em execução',pausada:'pausada',bloqueada:'bloqueada'};
const PERIODS=[{d:1,l:'Hoje'},{d:3,l:'3 dias'},{d:7,l:'7 dias'},{d:14,l:'14 dias'}];
/** Duração legível: 2 d 01:05, 03:20. */
const span=(x:number)=>{const m=Math.max(0,Math.floor(x/60000)),d=Math.floor(m/1440),h=Math.floor(m%1440/60),mm=m%60;return `${d?d+' d ':''}${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;};
/** Horas acumuladas (podem passar de 24 com etapas em paralelo): 33h05. */
const hrs=(x:number)=>{const m=Math.max(0,Math.floor(x/60000));return `${Math.floor(m/60)}h${String(m%60).padStart(2,'0')}`;};
const when=(t:number,now:number)=>{const day=Math.floor((t-OFF)/DAY)-Math.floor((now-OFF)/DAY);return `${day===0?'hoje':day===1?'amanhã':day===-1?'ontem':dm.format(t)} ${hm.format(t)}`;};
const period=(a:number,b:number)=>dm.format(a)===dm.format(b)?`${dm.format(a)} ${hm.format(a)}–${hm.format(b)}`:`${dm.format(a)} ${hm.format(a)} → ${dm.format(b)} ${hm.format(b)}`;

/** Rolagem automática: pausa no topo, desce devagar, pausa no fim e volta ao topo. */
function useAutoScroll(ref:RefObject<HTMLDivElement|null>,on:boolean,speed=24){
 useEffect(()=>{const el=ref.current;if(!el)return;if(!on){return;}
  let raf=0,phase:'hold'|'down'|'end'='hold',mark=performance.now(),last=mark,pos=el.scrollTop;
  const step=(t:number)=>{const dt=t-last;last=t;const max=el.scrollHeight-el.clientHeight;
   if(max<=2){pos=0;el.scrollTop=0;phase='hold';mark=t;}
   else if(phase==='hold'){if(t-mark>6000)phase='down';}
   else if(phase==='down'){pos=Math.min(max,pos+speed*dt/1000);el.scrollTop=pos;if(pos>=max-0.5){phase='end';mark=t;}}
   else if(t-mark>6000){pos=0;el.scrollTo({top:0,behavior:'smooth'});phase='hold';mark=t+1200;}
   raf=requestAnimationFrame(step);};
  raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf);},[ref,on,speed]);
}

export default function Tv({initialDays}:{initialDays:number}){
 const [days,setDays]=useState(initialDays),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[lost,setLost]=useState<number|null>(null);
 const [tick,setTick]=useState(()=>Date.now()),[offset,setOffset]=useState(0),[auto,setAuto]=useState(true),[full,setFull]=useState(false),[idle,setIdle]=useState(false);
 const rows=useRef<HTMLDivElement>(null),side=useRef<HTMLDivElement>(null),[trackW,setTrackW]=useState(1000);
 // Largura da trilha de datas: decide se o horário cabe dentro da barra ou vai ao lado dela.
 useEffect(()=>{const el=rows.current;if(!el||typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(()=>{const t=el.querySelector('.tv-track');if(t)setTrackW(t.getBoundingClientRect().width);});ro.observe(el);return()=>ro.disconnect();},[data]);
 const load=useCallback(async()=>{
  try{const r=await fetch('/api/tv?dias='+days,{cache:'no-store'});const j=await r.json().catch(()=>({}));
   if(r.status===401){setError('Sua sessão expirou. Entre novamente no NAUTILUS e abra a apresentação outra vez.');return;}
   if(!r.ok)throw new Error(j.error||'Não foi possível carregar.');
   setOffset(Date.parse(j.serverNow)-Date.now());setData(j);setError('');setLost(null);}
  catch(e){setLost(l=>l??Date.now());if(!data)setError((e as Error).message);}
 // eslint-disable-next-line react-hooks/exhaustive-deps -- "data" só decide se o erro substitui a tela.
 },[days]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados vindos do servidor.
 useEffect(()=>{void load();const t=setInterval(()=>void load(),60000);return()=>clearInterval(t);},[load]);
 useEffect(()=>{const t=setInterval(()=>setTick(Date.now()),1000);return()=>clearInterval(t);},[]);
 // Período na URL (a TV volta igual depois de recarregar).
 useEffect(()=>{const q=new URLSearchParams(location.search);q.set('dias',String(days));history.replaceState(null,'','?'+q.toString());},[days]);
 // Tela da TV não apaga enquanto a apresentação está aberta (quando o navegador permite).
 useEffect(()=>{let lock:{release:()=>Promise<void>}|null=null;const nav=navigator as unknown as {wakeLock?:{request:(t:string)=>Promise<{release:()=>Promise<void>}>}};
  const ask=()=>{nav.wakeLock?.request('screen').then(l=>{lock=l;}).catch(()=>{});};ask();
  const vis=()=>{if(!document.hidden)ask();};document.addEventListener('visibilitychange',vis);
  return()=>{document.removeEventListener('visibilitychange',vis);lock?.release().catch(()=>{});};},[]);
 // Controles aparecem ao mexer o mouse e somem sozinhos (o cursor também).
 useEffect(()=>{let t=setTimeout(()=>setIdle(true),4000);const wake=()=>{setIdle(false);clearTimeout(t);t=setTimeout(()=>setIdle(true),4000);};
  window.addEventListener('mousemove',wake);window.addEventListener('keydown',wake);window.addEventListener('touchstart',wake);
  const fs=()=>setFull(!!document.fullscreenElement);document.addEventListener('fullscreenchange',fs);
  return()=>{clearTimeout(t);window.removeEventListener('mousemove',wake);window.removeEventListener('keydown',wake);window.removeEventListener('touchstart',wake);document.removeEventListener('fullscreenchange',fs);};},[]);
 useAutoScroll(rows,auto);useAutoScroll(side,auto,18);
 const now=tick+offset;
 const toggleFull=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen().catch(()=>{});};

 const view=useMemo(()=>{
  if(!data)return null;
  const today=Date.parse(data.window.today),start=days>=7?today-DAY:today,end=today+days*DAY;
  const list=(data.orders as R[]).filter(o=>Date.parse(o.planned_start)<end&&(Date.parse(o.actual_end||o.planned_end)>start||['em_andamento','encerramento_pendente'].includes(o.status)))
   .sort((a,b)=>Date.parse(a.planned_start)-Date.parse(b.planned_start)||a.number-b.number);
  return {start,end,list};
 },[data,days]);

 if(error&&!data)return <main className="tv tv-msg"><AlertTriangle size={40}/><h1>Apresentação indisponível</h1><p>{error}</p><Link href="/">Voltar ao NAUTILUS</Link></main>;
 if(!data||!view)return <main className="tv tv-msg"><Radio size={40}/><h1>Carregando a apresentação…</h1></main>;

 const {start,end,list}=view,spanMs=end-start;
 const fontPx=Math.min(26,Math.max(10,(typeof window==='undefined'?1920:window.innerWidth)*.0062))*.95;
 const pct=(t:number)=>Math.max(0,Math.min(100,(t-start)/spanMs*100));
 const dayList=Array.from({length:Math.round(spanMs/DAY)},(_,i)=>start+i*DAY);
 const hourStep=days===1?2:days===3?6:0;
 const hourTicks=hourStep?dayList.flatMap(d=>Array.from({length:24/hourStep-1},(_,k)=>d+(k+1)*hourStep*H)):[];
 const nowIn=now>=start&&now<end;
 const running=list.filter(o=>['em_andamento','encerramento_pendente'].includes(o.status));
 const upcoming=list.filter(o=>o.status==='programada'&&Date.parse(o.planned_end)>now).slice(0,8);
 const late=list.filter(o=>o.status==='programada'&&Date.parse(o.planned_start)<now);
 const overdue=running.filter(o=>o.status==='em_andamento'&&Date.parse(o.planned_end)<now);
 // Recursos em uso agora: reservas que cobrem este momento em OS não encerradas.
 const inUse=list.filter(o=>o.status!=='concluida').flatMap(o=>(o.equipment as R[]).filter(e=>Date.parse(e.start)<=now&&Date.parse(e.end)>now).map((e:R):R=>({...e,number:o.number,color:o.org.color})));
 const crew=[...new Set(running.flatMap(o=>o.people as string[]))];
 const k=data.kpis,scheduled=list.filter(o=>o.status==='programada').length;
 const blocks=running.flatMap(o=>(o.occurrences as R[]||[]).map((x:R):R=>({...x,number:o.number})));
 const attention=[
  ...late.map(o=>({key:'l'+o.id,tone:'warn',text:`${os(o.number)} · início atrasado há ${span(now-Date.parse(o.planned_start))}`,sub:o.title})),
  ...overdue.map(o=>({key:'o'+o.id,tone:'occ',text:`${os(o.number)} · fim previsto vencido há ${span(now-Date.parse(o.planned_end))}`,sub:o.title})),
  ...blocks.map(b=>({key:'b'+b.id,tone:'occ',text:`${os(b.number)} · bloqueio aberto${b.category_name?` (${b.category_name})`:''}`,sub:b.description})),
  ...(data.summary.alerts as R[]).map((a,i)=>({key:'a'+i,tone:'warn',text:`${a.tag} · ${a.text}`,sub:''})),
 ];
 const kpis:[string,string|number,string][]=[
  ['Em andamento',k.running,'live'],['Etapas em execução',k.active,'live'],[`Programadas · ${PERIODS.find(p=>p.d===days)?.l.toLowerCase()}`,scheduled,'muted'],
  ['Início atrasado',late.length,late.length?'warn':'muted'],['Bloqueios abertos',k.blocks,k.blocks?'occ':'muted'],['Horas efetivas hoje',hrs(k.hoursToday*1000),'signal'],['Equipamentos em uso agora',new Set(inUse.map(e=>e.id)).size,'muted'],
 ];

 return <main className={`tv${idle?' idle':''}`}>
  <header className="tv-top">
   {/* eslint-disable-next-line @next/next/no-img-element -- Logo estático. */}
   <img src="/logo-white.png" alt="OceanPact | CBO" width={190} height={53}/>
   <div className="tv-title"><span><i className="pulse"/>NAUTILUS · Operação ao vivo</span><h1>{dm.format(start+OFF)} a {dm.format(end-DAY+OFF)} <small>{list.length} OS no período</small></h1></div>
   <div className="tv-clock"><b>{hm.format(now)}<em>:{String(new Date(now).getUTCSeconds()).padStart(2,'0')}</em></b><small>{longDate.format(now)}</small></div>
  </header>
  <section className="tv-kpis">{kpis.map(([l,v,t])=><div key={l} className={`tv-kpi ${t}`}><b>{v}</b><span>{l}</span></div>)}</section>
  <div className="tv-body">
   <section className="tv-gantt" aria-label="Cronograma das OS">
    <div className="tv-gh"><div className="lbl">OS · atividade · recursos</div>
     <div className="tv-days">{dayList.map(d=>{const w=new Date(d+OFF).getUTCDay(),isToday=now>=d&&now<d+DAY;
      return <span key={d} className={`${w===0||w===6?'we':''}${isToday?' today':''}${hourStep?' top':''}`} style={{left:pct(d)+'%',width:100/dayList.length+'%'}}><em>{wd.format(d+OFF).replace('.','')}</em><b>{dm.format(d+OFF)}</b></span>;})}
      {hourTicks.map(t=><i key={t} className="hr" style={{left:pct(t)+'%'}}>{String(new Date(t-OFF).getUTCHours()).padStart(2,'0')}h</i>)}
     </div></div>
    <div className="tv-rows" ref={rows}>
     {list.map(o=>{const ps=Date.parse(o.planned_start),pe=Date.parse(o.planned_end),as=o.actual_start?Date.parse(o.actual_start):null,ae=o.actual_end?Date.parse(o.actual_end):null;
      const live=['em_andamento','encerramento_pendente'].includes(o.status),isLate=o.status==='programada'&&ps<now;
      const l=pct(ps),w=Math.max(.5,pct(pe)-l),ex=as!==null?{left:pct(as)+'%',width:Math.max(.4,pct(ae??now)-pct(as))+'%'}:null;
      const eq=(o.equipment as R[]),people=o.people as string[];
      return <div key={o.id} className={`tv-row ${o.status}${isLate?' late':''}`} style={{['--c' as string]:o.org.color} as CSSProperties}>
       <div className="tv-info">
        <div className="l1"><b>{os(o.number)}</b>{o.sector?<span className="chip">{o.sector}</span>:<span className="chip none">sem setor</span>}<span className={`st ${o.status}${isLate?' late':''}`}>{isLate?'Atrasada':STATUS[o.status]||o.status}</span></div>
        <div className="l2" title={o.title}>{o.title}</div>
        <div className="l3"><span className="org">{o.org.acronym}</span>{o.location&&<span>{o.location}</span>}{eq.length>0&&<span><Truck size={14}/>{eq.map(e=>e.tag).join(', ')}</span>}{people.length>0&&<span><Users size={14}/>{people.length}</span>}</div>
       </div>
       <div className="tv-track">
        {dayList.map(d=>{const wk=new Date(d+OFF).getUTCDay();return wk===0||wk===6?<i key={d} className="we" style={{left:pct(d)+'%',width:100/dayList.length+'%'}}/>:null;})}
        {dayList.slice(1).map(d=><i key={'d'+d} className="dl" style={{left:pct(d)+'%'}}/>)}
        {(()=>{const label=`${ps<start?'◂ ':''}${period(ps,pe)}${pe>end?' ▸':''}`,need=label.length*fontPx*.62+18,inside=w/100*trackW>=need,right=(l+w)/100*trackW+need<=trackW;
         return <><div className={`bar${ps<start?' cl':''}${pe>end?' cr':''}`} style={{left:l+'%',width:w+'%'}}>{inside&&<span>{label}</span>}</div>
          {!inside&&<span className={`blabel${right?'':' left'}`} style={right?{left:`calc(${l+w}% + 8px)`}:{right:`calc(${100-l}% + 8px)`}}>{label}</span>}</>;})()}
        {ex&&<div className={`exec${live?' live':''}`} style={ex}/>}
        {nowIn&&<i className="now" style={{left:pct(now)+'%'}}/>}
       </div>
      </div>;})}
     {!list.length&&<p className="tv-empty">Nenhuma OS no período.</p>}
    </div>
    <div className="tv-legend"><span><i className="lg plan"/>Planejado</span><span><i className="lg exec"/>Executado</span><span><i className="lg now"/>Agora</span><span><i className="lg late"/>Início atrasado</span><span>Cor = solicitante</span></div>
   </section>
   <aside className="tv-side" ref={side}>
    <section><h2><i className="pulse"/>Em execução agora <small>{running.length}</small></h2>
     {running.length?running.map(o=>{const eff=effective(o.intervals||[],now),ps=Date.parse(o.planned_start),pe=Date.parse(o.planned_end),prog=Math.max(0,Math.min(100,(now-ps)/Math.max(1,pe-ps)*100));
      const cur=(o.steps as R[]||[]).filter(s=>STEP[s.status]).map(s=>`${s.name} (${STEP[s.status]})`).join(' · ');
      return <article key={o.id} className="tv-run" style={{['--c' as string]:o.org.color} as CSSProperties}>
       <div className="h"><b>{os(o.number)}</b><span className="org">{o.org.acronym}</span>{o.sector&&<span className="chip">{o.sector}</span>}</div>
       <h3>{o.title}</h3>
       {cur&&<p className="cur">Agora: {cur}</p>}
       {o.status==='encerramento_pendente'&&<p className="cur warn">Aguardando checklist para encerrar</p>}
       <div className="clock"><b>{hms(eff)}</b><span>tempo efetivo</span></div>
       <div className="prog"><i style={{width:prog+'%'}} className={now>pe?'over':''}/></div>
       <p className="meta">{now<pe?`fim previsto ${when(pe,now)} · faltam ${span(pe-now)}`:`fim previsto vencido há ${span(now-pe)}`}</p>
       {(o.equipment as R[]).length>0&&<p className="res"><Truck size={14}/>{(o.equipment as R[]).map(e=>e.tag).join(', ')}</p>}
       {(o.people as string[]).length>0&&<p className="res"><Users size={14}/>{(o.people as string[]).join(', ')}</p>}
      </article>;}):<p className="tv-none">Nenhuma OS em execução neste momento.</p>}
    </section>
    <section><h2><Clock size={18}/>Próximas</h2>
     {upcoming.length?<ul className="tv-next">{upcoming.map(o=>{const ps=Date.parse(o.planned_start);return <li key={o.id} style={{['--c' as string]:o.org.color} as CSSProperties}>
      <span className="t"><b>{when(ps,now)}</b><small>{ps>now?`em ${span(ps-now)}`:`atrasada ${span(now-ps)}`}</small></span>
      <span className="d"><b>{os(o.number)} · {o.title}</b><small>{o.org.acronym}{o.location?` · ${o.location}`:''}{(o.equipment as R[]).length?` · ${(o.equipment as R[]).map(e=>e.tag).join(', ')}`:''}{(o.people as string[]).length?` · ${(o.people as string[]).length} pessoa(s)`:''}</small></span></li>;})}</ul>
      :<p className="tv-none">Nenhuma OS programada no período.</p>}
    </section>
    <section><h2><Truck size={18}/>Recursos em uso agora</h2>
     {inUse.length?<div className="tv-chips">{inUse.map((e,i)=><span key={i} style={{['--c' as string]:e.color} as CSSProperties}><b>{e.tag}</b>{os(e.number).replace('OS ','OS ')}<small>até {when(Date.parse(e.end),now)}</small></span>)}</div>:<p className="tv-none">Nenhum equipamento reservado para este momento.</p>}
     {crew.length>0&&<p className="tv-crew"><Users size={16}/>{crew.join(' · ')}</p>}
     {running.some(o=>(o.materials as R[]).length)&&<p className="tv-crew"><Package size={16}/>{running.flatMap(o=>(o.materials as R[]).map(m=>`${Number(m.amount).toLocaleString('pt-BR')} ${m.unit} ${m.name} (${os(o.number).slice(-6)})`)).join(' · ')}</p>}
    </section>
    <section><h2><AlertTriangle size={18}/>Atenção <small>{attention.length}</small></h2>
     {attention.length?<ul className="tv-att">{attention.slice(0,12).map(a=><li key={a.key} className={a.tone}><b>{a.text}</b>{a.sub&&<small>{a.sub}</small>}</li>)}</ul>:<p className="tv-none ok">Sem atrasos, bloqueios ou alertas de equipamento.</p>}
    </section>
   </aside>
  </div>
  <footer className="tv-foot">
   <span>Atualizado às {hm.format(Date.parse(data.serverNow))}{lost&&<em className="lost"><WifiOff size={14}/> sem conexão desde {hm.format(lost)}; mostrando os últimos dados</em>}</span>
   <div className="tv-ctl" aria-label="Controles da apresentação">
    {PERIODS.map(p=><button key={p.d} type="button" aria-pressed={days===p.d} onClick={()=>setDays(p.d)}>{p.l}</button>)}
    <button type="button" onClick={()=>setAuto(a=>!a)}>{auto?<><Pause size={15}/>Pausar rolagem</>:<><Play size={15}/>Rolar sozinho</>}</button>
    <button type="button" onClick={toggleFull}>{full?<><Minimize size={15}/>Sair da tela cheia</>:<><Maximize size={15}/>Tela cheia</>}</button>
    <Link href="/"><ArrowLeft size={15}/>Voltar</Link>
   </div>
  </footer>
 </main>;
}
