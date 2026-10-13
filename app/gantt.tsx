'use client';
// Gantt das OS: uma linha por OS (expansível para as etapas), programação vigente e execução
// real. Roda do mouse aproxima/afasta mantendo a data sob o cursor; arrastar o fundo move o
// período. Consulta só o intervalo visível, com os mesmos filtros da lista.
import {useCallback,useEffect,useMemo,useRef,useState,KeyboardEvent,PointerEvent as RPointerEvent} from 'react';
import {ZoomIn,ZoomOut,CalendarCheck,Maximize2,ChevronRight,Lock,AlertTriangle} from 'lucide-react';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {OrgTag,load,type R} from './kit';

const H=3600000,D=24*H,TZ=-3*H; // horário de Brasília (UTC−3, sem horário de verão)
const MIN_SPAN=2*H,MAX_SPAN=6*365*D;
const MONTHS=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const local=(ms:number)=>new Date(ms+TZ); // usar getUTC* para ler o horário de Brasília
const fromLocal=(y:number,m:number,d=1,h=0)=>Date.UTC(y,m,d,h)-TZ;
const STORE='nautilus.gantt';
type View={start:number,span:number};
const statusText:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const stepText:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada'};
const fmt=(ms:number)=>{const d=local(ms);return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`};

/** Marcas do cabeçalho conforme a escala: meses (ano), dias (mês) ou horas (dia). */
function ticks(v:View,width:number){
 const end=v.start+v.span,out:{t:number,label:string,major:boolean}[]=[];let level:'ano'|'mes'|'dia';let context='';
 const s=local(v.start);
 if(v.span>=90*D){level='ano';
  for(let y=s.getUTCFullYear(),m=s.getUTCMonth();;m++){if(m>11){m=0;y++}const t=fromLocal(y,m);if(t>end)break;if(t>=v.start)out.push({t,label:m===0?`${MONTHS[m]} ${y}`:MONTHS[m],major:m===0});}
  context=`${s.getUTCFullYear()}${local(end).getUTCFullYear()!==s.getUTCFullYear()?' – '+local(end).getUTCFullYear():''}`;
 }else if(v.span>=2*D){level='mes';
  const days=Math.ceil(v.span/D),step=[1,2,5,7,14].find(n=>width/(days/n)>=34)||14;
  for(let t=fromLocal(s.getUTCFullYear(),s.getUTCMonth(),s.getUTCDate());t<=end;t+=D){const d=local(t);if(t>=v.start&&(d.getUTCDate()===1||(d.getUTCDate()-1)%step===0))out.push({t,label:d.getUTCDate()===1?`1 ${MONTHS[d.getUTCMonth()]}`:String(d.getUTCDate()),major:d.getUTCDate()===1});}
  context=`${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()}`;
 }else{level='dia';
  const hours=v.span/H,step=[1,2,3,6].find(n=>width/(hours/n)>=40)||6;
  for(let t=Math.floor((v.start-TZ)/H)*H+TZ;t<=end;t+=H){const d=local(t);if(t>=v.start&&d.getUTCHours()%step===0)out.push({t,label:d.getUTCHours()===0?`${d.getUTCDate()}/${d.getUTCMonth()+1}`:`${String(d.getUTCHours()).padStart(2,'0')}h`,major:d.getUTCHours()===0});}
  context=`${String(s.getUTCDate()).padStart(2,'0')}/${String(s.getUTCMonth()+1).padStart(2,'0')}/${s.getUTCFullYear()}`;
 }
 return {level,ticks:out,context};
}

function readView():View|null{try{const v=JSON.parse(sessionStorage.getItem(STORE)||'null');return v&&Number.isFinite(v.start)&&Number.isFinite(v.span)?v:null}catch{return null}}

export default function Gantt({query,orgs,onOpen}:{query:string,orgs:R[],onOpen:(id:string)=>void}){
 // O Gantt só é montado no navegador (depois da consulta), então a sessão pode ser lida já no estado inicial.
 const [view,setView]=useState<View>(()=>(typeof window!=='undefined'&&readView())||{start:Date.now()-7*D,span:31*D});
 const [wheel,setWheel]=useState(()=>{try{return sessionStorage.getItem(STORE+'.wheel')!=='0'}catch{return true}}),[rows,setRows]=useState<R[]|null>(null),[error,setError]=useState(''),[expanded,setExpanded]=useState<string[]>([]),[steps,setSteps]=useState<Record<string,R[]>>({}),[width,setWidth]=useState(800),[now,setNow]=useState(()=>Date.now());
 const area=useRef<HTMLDivElement>(null),drag=useRef<{x:number,start:number}|null>(null);
 // Zoom e período continuam iguais ao trocar Lista/Gantt e ao voltar do detalhe.
 useEffect(()=>{try{sessionStorage.setItem(STORE,JSON.stringify(view))}catch{}},[view]);
 useEffect(()=>{const el=area.current;if(!el)return;const ro=new ResizeObserver(e=>setWidth(Math.max(200,e[0].contentRect.width)));ro.observe(el);return()=>ro.disconnect()},[rows===null]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(t)},[]);
 // Consulta o intervalo visível (com folga) usando os filtros da lista.
 const from=view.start-view.span*0.25,to=view.start+view.span*1.25;
 const key=`${query}&from=${new Date(Math.round(from/H)*H).toISOString()}&to=${new Date(Math.round(to/H)*H).toISOString()}`;
 useEffect(()=>{const t=setTimeout(async()=>{try{const r=await load<R>('orders?'+key.replace(/^&/,''));setRows(r.orders);setError('')}catch(e){setError((e as Error).message)}},250);return()=>clearTimeout(t)},[key]);
 useEffect(()=>{const ids=expanded.filter(id=>!steps[id]);if(!ids.length)return;load<R>('orders/steps?ids='+ids.join(',')).then(r=>setSteps(s=>{const n={...s};for(const id of ids)n[id]=(r.steps as R[]).filter(x=>x.work_order_id===id);return n})).catch(()=>{})},[expanded,steps]);

 const zoomAt=useCallback((factor:number,ratio=0.5)=>setView(v=>{const span=Math.min(MAX_SPAN,Math.max(MIN_SPAN,v.span*factor));const anchor=v.start+ratio*v.span;return {start:anchor-ratio*span,span}}),[]);
 // Roda sobre a área temporal: zoom ancorado no cursor. Fora dela, a página rola normalmente.
 useEffect(()=>{const el=area.current;if(!el||!wheel)return;const on=(e:WheelEvent)=>{if(e.ctrlKey)return;e.preventDefault();const r=el.getBoundingClientRect();zoomAt(e.deltaY<0?0.8:1.25,Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)))};el.addEventListener('wheel',on,{passive:false});return()=>el.removeEventListener('wheel',on)},[wheel,zoomAt,rows===null]); // eslint-disable-line react-hooks/exhaustive-deps
 const scale=useMemo(()=>ticks(view,width),[view,width]);
 const x=(t:number)=>((t-view.start)/view.span)*100;
 const bar=(a:number,b:number)=>{const l=Math.max(-1,x(a)),r=Math.min(101,x(b));return r<=l?null:{left:`${l}%`,width:`${Math.max(0.4,r-l)}%`}};
 const setScale=(level:'ano'|'mes'|'dia')=>setView(v=>{const span=level==='ano'?365*D:level==='mes'?31*D:D;const c=v.start+v.span/2;return {start:c-span/2,span}});
 // Ajusta ao período de todas as OS dos filtros (não só das já carregadas na janela).
 const fit=async()=>{try{const r=await load<R>('orders?'+query);const all=r.orders as R[];if(!all.length)return;const a=Math.min(...all.map(o=>Date.parse(o.planned_start))),b=Math.max(...all.map(o=>Date.parse(o.actual_end||o.planned_end)));const pad=(b-a)*0.05+H;setView({start:a-pad,span:Math.min(MAX_SPAN,Math.max(MIN_SPAN,b-a+2*pad))})}catch{/* mantém a janela */}};
 const onKey=(e:KeyboardEvent)=>{if(e.key==='ArrowLeft'){e.preventDefault();setView(v=>({...v,start:v.start-v.span*0.1}))}else if(e.key==='ArrowRight'){e.preventDefault();setView(v=>({...v,start:v.start+v.span*0.1}))}else if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(0.8)}else if(e.key==='-'){e.preventDefault();zoomAt(1.25)}};
 const down=(e:RPointerEvent)=>{if((e.target as HTMLElement).closest('.g-bar'))return;drag.current={x:e.clientX,start:view.start};(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)};
 const move=(e:RPointerEvent)=>{const d=drag.current;if(!d)return;setView(v=>({...v,start:d.start-(e.clientX-d.x)*v.span/width}))};
 const up=()=>{drag.current=null};
 const orgOf=(id:string)=>orgs.find(o=>o.id===id);
 const visible=(rows||[]).filter(r=>Date.parse(r.planned_start)<view.start+view.span&&Date.parse(r.actual_end||r.planned_end)>view.start||r.status==='em_andamento');

 if(error)return <div className="form-error"><AlertTriangle size={17}/>{error}</div>;
 if(!rows)return <Skeleton className="h-72 rounded-xl"/>;
 return <div className="gantt">
  <div className="g-tools">
   <div className="segmented" role="group" aria-label="Escala">{(['ano','mes','dia'] as const).map(l=><button key={l} type="button" aria-pressed={scale.level===l} onClick={()=>setScale(l)}>{l==='ano'?'Ano':l==='mes'?'Mês':'Dia'}</button>)}</div>
   <button type="button" className="icon-action" onClick={()=>zoomAt(1.25)} aria-label="Afastar"><ZoomOut size={16}/></button><button type="button" className="icon-action" onClick={()=>zoomAt(0.8)} aria-label="Aproximar"><ZoomIn size={16}/></button>
   <button type="button" className="chip" onClick={()=>setView(v=>({...v,start:Date.now()-v.span/2}))}><CalendarCheck size={13} className="inline"/> Hoje</button>
   <button type="button" className="chip" onClick={()=>void fit()}><Maximize2 size={13} className="inline"/> Ajustar ao período</button>
   <label className="g-wheel"><Switch checked={wheel} onCheckedChange={v=>{setWheel(v);try{sessionStorage.setItem(STORE+'.wheel',v?'1':'0')}catch{}}} aria-label="Roda do mouse controla o zoom"/>Roda do mouse controla o zoom</label>
   <span className="g-range">{fmt(view.start)} → {fmt(view.start+view.span)} · Horário de Brasília (UTC−3)</span>
  </div>
  <div className="g-grid">
   <div className="g-left"><div className="g-head-left"><b>{scale.context}</b><small>{visible.length} OS no período</small></div>
    {visible.map(o=><div key={o.id} className="g-group"><div className="g-label"><button type="button" className="g-expand" aria-expanded={expanded.includes(o.id)} aria-label={`Etapas da ${o.number}`} onClick={()=>setExpanded(e=>e.includes(o.id)?e.filter(x=>x!==o.id):[...e,o.id])}><ChevronRight size={14}/></button><button type="button" className="g-name" onClick={()=>onOpen(o.id)}><b>OS {String(o.number).padStart(6,'0')}</b><small>{o.activity_name}</small></button><OrgTag org={orgOf(o.org_id)}/></div>
     {expanded.includes(o.id)&&(steps[o.id]||[]).map(s=><div key={s.id} className="g-label g-step"><span>{s.name}</span><small>{stepText[s.status]}{(s.depends_on as string[]).length?` · após ${(s.depends_on as string[]).map(d=>(steps[o.id]||[]).find(x=>x.step_key===d)?.name).filter(Boolean).join(', ')}`:''}</small></div>)}</div>)}
   </div>
   <div className="g-right" ref={area} tabIndex={0} role="application" aria-label="Gantt: setas movem o período, + e − aproximam ou afastam" onKeyDown={onKey} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <div className="g-head">{scale.ticks.map(t=><span key={t.t} className={t.major?'major':''} style={{left:`${x(t.t)}%`}}>{t.label}</span>)}</div>
    <div className="g-body">
     {scale.ticks.map(t=><i key={t.t} className={`g-line ${t.major?'major':''}`} style={{left:`${x(t.t)}%`}}/>)}
     {now>view.start&&now<view.start+view.span&&<i className="g-now" style={{left:`${x(now)}%`}} title="Agora"/>}
     {visible.map(o=>{const ps=Date.parse(o.planned_start),pe=Date.parse(o.planned_end);const p=bar(ps,pe);const real=o.actual_start?bar(Date.parse(o.actual_start),o.actual_end?Date.parse(o.actual_end):now):null;
      return <div key={o.id} className="g-group"><div className="g-row">
       {p&&<button type="button" className={`g-bar ${o.status} ${o.late?'late':''}`} style={p} onClick={()=>onOpen(o.id)} title={`OS ${o.number} · ${statusText[o.status]}${o.late?' · início vencido':''}\nPlanejado: ${fmt(ps)} → ${fmt(pe)}${o.actual_start?`\nReal: ${fmt(Date.parse(o.actual_start))} → ${o.actual_end?fmt(Date.parse(o.actual_end)):'em curso'}`:''}`}>{o.blocked_resources>0&&<Lock size={11}/>}<span>{statusText[o.status]}{o.late?' · atrasada':''}</span></button>}
       {real&&<i className="g-real" style={real}/>}
      </div>
      {expanded.includes(o.id)&&(steps[o.id]||[]).map(s=>{const sp=bar(Date.parse(s.planned_start),Date.parse(s.planned_end));const sr=s.actual_start?bar(Date.parse(s.actual_start),s.actual_end?Date.parse(s.actual_end):now):null;return <div key={s.id} className="g-row g-step">
       {sp&&<button type="button" className={`g-bar step ${s.status}`} style={sp} onClick={()=>onOpen(o.id)} title={`${s.name} · ${stepText[s.status]}\nPlanejado: ${fmt(Date.parse(s.planned_start))} → ${fmt(Date.parse(s.planned_end))}`}><span>{s.name}</span></button>}
       {sr&&<i className={`g-real ${s.status}`} style={sr}/>}
      </div>})}</div>})}
     {!visible.length&&<p className="g-empty">Nenhuma OS no período visível. Use “Ajustar ao período”, “Hoje” ou afaste o zoom.</p>}
    </div>
   </div>
  </div>
  <div className="g-legend"><span><i className="g-bar programada"/>Programada</span><span><i className="g-bar em_andamento"/>Em andamento</span><span><i className="g-bar late programada"/>Início vencido</span><span><i className="g-bar encerramento_pendente"/>Encerramento pendente</span><span><i className="g-bar concluida"/>Concluída</span><span><i className="g-real"/>Execução real</span><span><Lock size={12}/> Equipamento bloqueado</span><span><i className="g-now-key"/>Agora</span></div>
 </div>;
}
