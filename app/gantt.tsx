'use client';
// Gantt das OS: uma linha por OS (expansível para as etapas), com as MESMAS OS e a MESMA ordem da
// lista (grupos de lib/os-order). Barra planejada à frente e barra executada atrás, deslocada para
// baixo, cada uma nas próprias datas e na mesma escala. Roda do mouse aproxima/afasta mantendo a data
// sob o cursor; arrastar o fundo move o período.
import {Fragment,useCallback,useEffect,useMemo,useRef,useState,KeyboardEvent,PointerEvent as RPointerEvent} from 'react';
import {ZoomIn,ZoomOut,CalendarCheck,Maximize2,ChevronRight,Lock,AlertTriangle} from 'lucide-react';
import {Switch} from '@/components/ui/switch';
import {OrgTag,load,clip,type R} from './kit';
import {flatRows,type OsGroup,type OsItem} from '@/lib/os-order';

const H=3600000,D=24*H,TZ=-3*H; // horário de Brasília (UTC−3, sem horário de verão)
export const MIN_SPAN=2*H,MAX_SPAN=6*365*D;
const MONTHS=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const local=(ms:number)=>new Date(ms+TZ); // usar getUTC* para ler o horário de Brasília
const fromLocal=(y:number,m:number,d=1,h=0)=>Date.UTC(y,m,d,h)-TZ;
const STORE='nautilus.gantt';
export type View={start:number,span:number};
const statusText:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const stepText:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada',cancelada:'Cancelada'};
const hm=(ms:number)=>{const d=local(ms);return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`};
/** Período da barra: "07:00–17:00" no mesmo dia; com data nas pontas quando passa de um dia. */
const when=(a:number,b:number)=>{const x=local(a),y=local(b),d=(z:Date)=>`${String(z.getUTCDate()).padStart(2,'0')}/${String(z.getUTCMonth()+1).padStart(2,'0')}`;return d(x)===d(y)?`${hm(a)}–${hm(b)}`:`${d(x)} ${hm(a)} → ${d(y)} ${hm(b)}`};
const fmt=(ms:number)=>{const d=local(ms);return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`};

/** Marcas do cabeçalho conforme a escala: meses (ano), dias (mês) ou horas (dia). */
export function ticks(v:View,width:number){
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

const dur=(ms:number)=>{const m=Math.round(Math.abs(ms)/60000);const d=Math.floor(m/1440),h=Math.floor(m%1440/60),mi=m%60;return d?`${d}d ${String(h).padStart(2,'0')}h${String(mi).padStart(2,'0')}`:`${String(h).padStart(2,'0')}h${String(mi).padStart(2,'0')}`};
const num=(v?:string|null)=>{if(!v)return null;const t=Date.parse(v);return Number.isFinite(t)?t:null};
/** Barras de uma linha: planejado (frente) e executado (atrás, deslocado para baixo), cada um com as
 * próprias datas na mesma escala. Datas inconsistentes não viram barra (e são sinalizadas). */
export function barsOf(o:R,now:number){
 const ps=num(o.planned_start),pe=num(o.planned_end),as=num(o.actual_start),ae=num(o.actual_end);
 const plan=ps!=null&&pe!=null&&pe>ps?[ps,pe] as const:null;
 const real=as!=null&&(ae==null||ae>=as)&&as<=now+5*60000?[as,ae??Math.max(as,now)] as const:null;
 const lines=[plan?`Planejado: ${fmt(plan[0])} → ${fmt(plan[1])} (${dur(plan[1]-plan[0])})`:ps==null?'Sem início planejado':'Planejado: datas inconsistentes'];
 if(real){lines.push(`Real: ${fmt(real[0])} → ${ae!=null?fmt(ae):'em curso (agora '+fmt(now)+')'} (${dur(real[1]-real[0])})`);
  if(ps!=null)lines.push(real[0]===ps?'Início: no horário planejado':`Início: ${dur(real[0]-ps)} ${real[0]>ps?'depois':'antes'} do planejado`);
  if(pe!=null&&ae!=null)lines.push(ae===pe?'Término: no horário planejado':`Término: ${dur(ae-pe)} ${ae>pe?'depois':'antes'} do planejado`);
  else if(pe!=null&&ae==null)lines.push(now>pe?`Término planejado vencido há ${dur(now-pe)}`:`Faltam ${dur(pe-now)} para o término planejado`);
 }else if(as==null)lines.push('Sem execução registrada');
 return {plan,real,open:as!=null&&ae==null,lines};
}

export default function Gantt({groups,orgs,now,onOpen}:{groups:OsGroup<OsItem&R>[],orgs:R[],now:number,onOpen:(id:string)=>void}){
 // O Gantt só é montado no navegador (depois da consulta), então a sessão pode ser lida já no estado inicial.
 const [view,setView]=useState<View>(()=>(typeof window!=='undefined'&&readView())||{start:Date.now()-7*D,span:31*D});
 const [wheel,setWheel]=useState(()=>{try{return sessionStorage.getItem(STORE+'.wheel')!=='0'}catch{return true}}),[expanded,setExpanded]=useState<string[]>([]),[steps,setSteps]=useState<Record<string,R[]>>({}),[width,setWidth]=useState(800);
 const area=useRef<HTMLDivElement>(null),drag=useRef<{x:number,start:number}|null>(null);
 // Zoom e período continuam iguais ao trocar Lista/Gantt e ao voltar do detalhe.
 useEffect(()=>{try{sessionStorage.setItem(STORE,JSON.stringify(view))}catch{}},[view]);
 useEffect(()=>{const el=area.current;if(!el)return;const ro=new ResizeObserver(e=>setWidth(Math.max(200,e[0].contentRect.width)));ro.observe(el);return()=>ro.disconnect()},[]);
 useEffect(()=>{const ids=expanded.filter(id=>!steps[id]);if(!ids.length)return;load<R>('orders/steps?ids='+ids.join(',')).then(r=>setSteps(s=>{const n={...s};for(const id of ids)n[id]=(r.steps as R[]).filter(x=>x.work_order_id===id);return n})).catch(()=>{})},[expanded,steps]);

 const zoomAt=useCallback((factor:number,ratio=0.5)=>setView(v=>{const span=Math.min(MAX_SPAN,Math.max(MIN_SPAN,v.span*factor));const anchor=v.start+ratio*v.span;return {start:anchor-ratio*span,span}}),[]);
 // Roda sobre a área temporal: zoom ancorado no cursor. Fora dela, a página rola normalmente.
 useEffect(()=>{const el=area.current;if(!el||!wheel)return;const on=(e:WheelEvent)=>{if(e.ctrlKey)return;e.preventDefault();const r=el.getBoundingClientRect();zoomAt(e.deltaY<0?0.8:1.25,Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)))};el.addEventListener('wheel',on,{passive:false});return()=>el.removeEventListener('wheel',on)},[wheel,zoomAt]);
 const scale=useMemo(()=>ticks(view,width),[view,width]);
 const x=(t:number)=>((t-view.start)/view.span)*100;
 const bar=(a:number,b:number)=>{const l=Math.max(-1,x(a)),r=Math.min(101,x(b));return r<=l?null:{left:`${l}%`,width:`${Math.max(0.4,r-l)}%`}};
 const setScale=(level:'ano'|'mes'|'dia')=>setView(v=>{const span=level==='ano'?365*D:level==='mes'?31*D:D;const c=v.start+v.span/2;return {start:c-span/2,span}});
 const rows=flatRows(groups);
 // Ajusta ao período de todas as OS exibidas, considerando planejado E executado (antecipações,
 // prolongamentos e o "agora" das OS em curso).
 const fit=()=>{const ts=rows.flatMap(({item:o})=>{const b=barsOf(o,now);return [...(b.plan||[]),...(b.real||[])]});if(!ts.length)return;const a=Math.min(...ts),b=Math.max(...ts);const pad=(b-a)*0.05+H;setView({start:a-pad,span:Math.min(MAX_SPAN,Math.max(MIN_SPAN,b-a+2*pad))})};
 const center=(t:number)=>setView(v=>({...v,start:t-v.span/2}));
 const onKey=(e:KeyboardEvent)=>{if(e.key==='ArrowLeft'){e.preventDefault();setView(v=>({...v,start:v.start-v.span*0.1}))}else if(e.key==='ArrowRight'){e.preventDefault();setView(v=>({...v,start:v.start+v.span*0.1}))}else if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(0.8)}else if(e.key==='-'){e.preventDefault();zoomAt(1.25)}};
 const down=(e:RPointerEvent)=>{if((e.target as HTMLElement).closest('.g-bar,.g-off'))return;drag.current={x:e.clientX,start:view.start};(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)};
 const move=(e:RPointerEvent)=>{const d=drag.current;if(!d)return;setView(v=>({...v,start:d.start-(e.clientX-d.x)*v.span/width}))};
 const up=()=>{drag.current=null};
 const orgOf=(id:string)=>orgs.find(o=>o.id===id);
 const end=view.start+view.span;
 const inView=rows.filter(({item:o})=>{const b=barsOf(o,now);return [b.plan,b.real].some(s=>s&&s[0]<end&&s[1]>view.start)}).length;

 return <div className="gantt">
  <div className="g-tools">
   <div className="segmented" role="group" aria-label="Escala">{(['ano','mes','dia'] as const).map(l=><button key={l} type="button" aria-pressed={scale.level===l} onClick={()=>setScale(l)}>{l==='ano'?'Ano':l==='mes'?'Mês':'Dia'}</button>)}</div>
   <button type="button" className="icon-action" onClick={()=>zoomAt(1.25)} aria-label="Afastar"><ZoomOut size={16}/></button><button type="button" className="icon-action" onClick={()=>zoomAt(0.8)} aria-label="Aproximar"><ZoomIn size={16}/></button>
   <button type="button" className="chip" onClick={()=>center(Date.now())}><CalendarCheck size={13} className="inline"/> Hoje</button>
   <button type="button" className="chip" onClick={fit}><Maximize2 size={13} className="inline"/> Ajustar ao período</button>
   <label className="g-wheel" title="Desligado, a roda do mouse rola a lista de OS"><Switch checked={wheel} onCheckedChange={v=>{setWheel(v);try{sessionStorage.setItem(STORE+'.wheel',v?'1':'0')}catch{}}} aria-label="Roda do mouse controla o zoom"/>Roda do mouse controla o zoom</label>
   <span className="g-range">{fmt(view.start)} → {fmt(end)} · Horário de Brasília (UTC−3)</span>
  </div>
  <div className="g-scroll"><div className="g-grid">
   <div className="g-left"><div className="g-head-left"><b>{scale.context}</b><small>{rows.length} OS · {inView} no período visível</small></div>
    {groups.map(g=><Fragment key={g.key}>{g.label&&<div className="g-ghead"><b>{g.label}</b><span>{g.rows.length} OS</span></div>}
    {g.rows.map(({item:o,flags})=><div key={o.id} className="g-group"><div className="g-label"><button type="button" className="g-expand" aria-expanded={expanded.includes(o.id)} aria-label={`Etapas da ${o.number}`} onClick={()=>setExpanded(e=>e.includes(o.id)?e.filter(x=>x!==o.id):[...e,o.id])}><ChevronRight size={14}/></button><button type="button" className="g-name" onClick={()=>onOpen(o.id)} title={o.activity_name}><b>OS {String(o.number).padStart(6,'0')}{o.sector_code?` · ${o.sector_code}`:''}</b><small>{clip(o.activity_name,48)}</small></button><span className="g-flags">{flags.overdue&&<i className="late" title="Prazo planejado vencido">atrasada</i>}{flags.issues.length>0&&<i className="bad" title={flags.issues.join('\n')}><AlertTriangle size={11}/></i>}<OrgTag org={orgOf(o.org_id)}/></span></div>
     {expanded.includes(o.id)&&(steps[o.id]||[]).map(s=><div key={s.id} className="g-label g-step"><span>{s.name}</span><small>{stepText[s.status]}{(s.depends_on as string[]).length?` · após ${(s.depends_on as string[]).map(d=>(steps[o.id]||[]).find(x=>x.step_key===d)?.name).filter(Boolean).join(', ')}`:''}</small></div>)}</div>)}</Fragment>)}
   </div>
   <div className="g-right" ref={area} tabIndex={0} role="application" aria-label="Gantt: setas movem o período, + e − aproximam ou afastam" onKeyDown={onKey} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <div className="g-head">{scale.ticks.map(t=><span key={t.t} className={t.major?'major':''} style={{left:`${x(t.t)}%`}}>{t.label}</span>)}</div>
    <div className="g-body">
     {scale.ticks.map(t=><i key={t.t} className={`g-line ${t.major?'major':''}`} style={{left:`${x(t.t)}%`}}/>)}
     {now>view.start&&now<end&&<i className="g-now" style={{left:`${x(now)}%`}} title="Agora"/>}
     {groups.map(g=><Fragment key={g.key}>{g.label&&<div className="g-ghead" aria-hidden/>}
     {g.rows.map(({item:o,flags})=>{const b=barsOf(o,now);const p=b.plan&&bar(b.plan[0],b.plan[1]);const real=b.real&&bar(b.real[0],b.real[1]);
      const ref=b.plan?.[0]??b.real?.[0]??null,refEnd=b.plan?.[1]??b.real?.[1]??null;
      const off=!p&&!real&&ref!=null?(refEnd!<view.start?'left':ref>end?'right':null):null;
      const tip=`OS ${o.number} · ${o.activity_name}\n${statusText[o.status]||o.status}${o.late?' · início vencido':''}${flags.overdue?' · prazo vencido':''}\n${b.lines.join('\n')}${flags.issues.length?'\nAtenção: '+flags.issues.join('; '):''}`;
      return <div key={o.id} className="g-group"><div className="g-row">
       {real&&<i className={`g-real-bar ${o.status}${b.open?' open':''}`} style={real} title={tip}/>}
       {p&&b.plan&&(Math.min(101,x(b.plan[1]))-Math.max(-1,x(b.plan[0])))*width/100<96&&x(b.plan[1])<98&&<span className="g-out" style={{left:`calc(${Math.min(101,x(b.plan[1]))}% + 8px)`}} title={o.activity_name}><b>{clip(o.activity_name,42)}</b><small>{statusText[o.status]}{o.late?' · atrasada':''} · {when(b.plan[0],b.plan[1])}</small></span>}
       {p&&b.plan&&<button type="button" className={`g-bar ${o.status} ${o.late?'late':''}`} style={p} onClick={()=>onOpen(o.id)} title={tip}>
        <span className="g-t">{o.blocked_resources>0&&<Lock size={11}/>}{clip(o.activity_name,60)}</span><small>{statusText[o.status]}{o.late?' · atrasada':''} · {when(b.plan[0],b.plan[1])}{o.origin==='realizada'?' · realizada':''}</small></button>}
       {!b.plan&&<span className="g-noplan" title={tip}>{flags.noStart?'Sem início planejado':'Datas planejadas inconsistentes'}</span>}
       {off&&<button type="button" className={`g-off ${off}`} onClick={()=>center(ref!)} title={tip}>{off==='left'?`◂ ${fmt(ref!).slice(0,5)}`:`${fmt(ref!).slice(0,5)} ▸`}</button>}
      </div>
      {expanded.includes(o.id)&&(steps[o.id]||[]).map(s=>{const sb=barsOf(s,now);const sp=sb.plan&&bar(sb.plan[0],sb.plan[1]);const sr=sb.real&&bar(sb.real[0],sb.real[1]);const st=`${s.name} · ${stepText[s.status]}\n${sb.lines.join('\n')}`;return <div key={s.id} className="g-row g-step">
       {sr&&<i className={`g-real-bar ${s.status}${sb.open?' open':''}`} style={sr} title={st}/>}
       {sp&&<button type="button" className={`g-bar step ${s.status}`} style={sp} onClick={()=>onOpen(o.id)} title={st}><span className="g-t">{clip(s.name,60)}</span></button>}
      </div>})}</div>})}</Fragment>)}
     {!rows.length&&<p className="g-empty">Nenhuma OS com estes filtros.</p>}
    </div>
   </div>
  </div></div>
  <div className="g-legend"><span><i className="g-bar programada"/>Planejado (barra da frente)</span><span><i className="g-real-bar"/>Executado (barra de trás, deslocada para baixo: começa e termina nas datas reais)</span><span><i className="g-real-bar open"/>Em execução (até agora)</span><span><i className="g-bar late programada"/>Início vencido</span><span><i className="g-bar em_andamento"/>Em andamento</span><span><i className="g-bar concluida"/>Concluída</span><span><Lock size={12}/> Equipamento bloqueado</span><span><i className="g-now-key"/>Agora</span><span>◂ ▸ OS fora do período visível (clique para ir até ela)</span></div>
 </div>;
}
