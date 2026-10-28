'use client';
// Lista de OS programadas › Agenda de recursos: uso dos recursos das OS da lista (mesmos filtros e
// organização). Uma linha por recurso (equipamento, função ou material) e, no eixo das datas, cada
// alocação com a OS, o horário e a quantidade. Navegação igual à do Gantt de atividades: roda do
// mouse aproxima/afasta mantendo a data sob o cursor, arrastar o fundo move o período, setas e + −
// no teclado, Ano/Mês/Dia, Hoje e Ajustar ao período. O período escolhido fica guardado na sessão
// (nada puxa a tela de volta para hoje). Barra com largura mínima e faixas pela extensão visível:
// alocações curtas e próximas continuam legíveis e nunca se sobrepõem (lib/resource-agenda).
import {Fragment,useCallback,useEffect,useMemo,useRef,useState,type KeyboardEvent,type PointerEvent as RPointerEvent} from 'react';
import {Truck,Users,Package,AlertTriangle,FileDown,ZoomIn,ZoomOut,CalendarCheck,Maximize2} from 'lucide-react';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {Empty,load,fmt,type R} from './kit';
import {MultiPick,useNow} from './os-arrange';
import {ticks,MIN_SPAN,MAX_SPAN,type View} from './gantt';
import {ALL_KINDS,RES_KINDS,packLanes,resourceOptions,resourceRows,type Alloc,type ResKind} from '@/lib/resource-agenda';
import ResourceExportDialog from './resource-export';

const ICON:Record<ResKind,typeof Truck>={equipamento:Truck,funcao:Users,material:Package};
const H=3600_000,DAY=24*H,OFF=3*H;
const TZ='America/Sao_Paulo';
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const os=(n:number)=>String(n).padStart(6,'0');
const qty=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:3});
const STORE='nautilus.orders.resources',VIEW='nautilus.resources.view',WHEEL='nautilus.gantt.wheel';
/** Barra nunca menor que MIN px; as faixas usam essa largura. Alturas fixas para alinhar as colunas. */
const MIN=140,GAP=8,LANE=62,GROUP_H=30;
const rowH=(lanes:number)=>Math.max(64,lanes*LANE+12);
const when=(a:number,b:number)=>dm.format(a)===dm.format(b)?`${dm.format(a)} ${hm.format(a)}–${hm.format(b)}`:`${dm.format(a)} ${hm.format(a)} → ${dm.format(b)} ${hm.format(b)}`;
const dur=(a:number,b:number)=>{const m=Math.round((b-a)/60000);return m<60?`${m} min`:`${qty(Math.round(m/6)/10)} h`;};
const range=(t:number)=>{const d=new Date(t-OFF);return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;};
const isoDay=(t:number)=>new Date(t-OFF).toISOString().slice(0,10);

type Stored={kinds:ResKind[],picked:string[]};
function readStored():Stored{
 try{const v=JSON.parse(sessionStorage.getItem(STORE)||'null');
  const kinds=Array.isArray(v?.kinds)?v.kinds.filter((k:string)=>ALL_KINDS.includes(k as ResKind)):[];
  return {kinds:kinds.length?kinds:ALL_KINDS,picked:Array.isArray(v?.picked)?v.picked.filter((x:unknown)=>typeof x==='string'):[]};
 }catch{return {kinds:ALL_KINDS,picked:[]};}
}
/** Período visível guardado na sessão; na primeira vez, de ontem a seis dias à frente. */
function readView():View{
 try{const v=JSON.parse(sessionStorage.getItem(VIEW)||'null');if(v&&Number.isFinite(v.start)&&Number.isFinite(v.span))return v;}catch{}
 const today=Math.floor((Date.now()-OFF)/DAY)*DAY+OFF;return {start:today-DAY,span:8*DAY};
}

/** Tipos (separados ou juntos) e recursos específicos: o mesmo seletor na tela e na exportação. */
export function ResourcePick({allocs,kinds,picked,onKinds,onPicked}:{allocs:Alloc[],kinds:ResKind[],picked:string[],onKinds:(k:ResKind[])=>void,onPicked:(p:string[])=>void}){
 const options=useMemo(()=>resourceOptions(allocs,kinds),[allocs,kinds]);
 const toggle=(k:ResKind)=>onKinds(kinds.includes(k)?(kinds.length>1?kinds.filter(x=>x!==k):kinds):ALL_KINDS.filter(x=>x===k||kinds.includes(x)));
 return <>
  <div className="ra-kinds" role="group" aria-label="Tipos de recurso">{RES_KINDS.map(k=>{const I=ICON[k.id];return <label key={k.id} className={kinds.includes(k.id)?'on':''}><input type="checkbox" checked={kinds.includes(k.id)} onChange={()=>toggle(k.id)}/><I size={14}/>{k.label}</label>;})}</div>
  <MultiPick label="Recursos" all="Todos dos tipos marcados" options={options.map(o=>({value:o.value,label:o.label}))} value={picked.filter(p=>options.some(o=>o.value===p))} onChange={onPicked}/>
 </>;
}

export default function ResourceAgenda({query,orderIds,exportParams,period}:{query:string,orderIds:string[],exportParams:URLSearchParams,period:{from:string,to:string}}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[exporting,setExporting]=useState(false);
 const [stored,setStored]=useState<Stored>(readStored);
 const [view,setView]=useState<View>(readView),[width,setWidth]=useState(800);
 const [wheel,setWheel]=useState(()=>{try{return sessionStorage.getItem(WHEEL)!=='0'}catch{return true}});
 const now=useNow();
 const {kinds,picked}=stored;
 const save=(p:Partial<Stored>)=>setStored(s=>{const n={...s,...p};try{sessionStorage.setItem(STORE,JSON.stringify(n))}catch{}return n;});
 useEffect(()=>{try{sessionStorage.setItem(VIEW,JSON.stringify(view))}catch{}},[view]);
 useEffect(()=>{let live=true;load<R>('orders/resources?'+query).then(r=>{if(live){setData(r);setError('')}}).catch(e=>{if(live)setError((e as Error).message)});return()=>{live=false}},[query]);
 // Só as OS que estão na lista (os filtros de solicitante e setor são da tela).
 const idKey=orderIds.join(',');
 const all=useMemo(()=>{const shown=new Set(idKey.split(','));return ((data?.allocations||[]) as Alloc[]).filter(a=>shown.has(a.orderId));},[data,idKey]);
 const chosen=useMemo(()=>{const ok=new Set(resourceOptions(all,kinds).map(o=>o.value));return picked.filter(p=>ok.has(p));},[all,kinds,picked]);
 const x=useCallback((t:number)=>(t-view.start)/view.span*width,[view,width]);
 const rows=useMemo(()=>{const r=resourceRows(all,kinds,chosen);for(const g of r)g.lanes=packLanes(g.items,x,MIN,GAP);return r;},[all,kinds,chosen,x]);

 // Navegação igual à do Gantt.
 const area=useRef<HTMLDivElement>(null),drag=useRef<{x:number,start:number}|null>(null);
 const ready=!!data&&rows.length>0;
 useEffect(()=>{const el=area.current;if(!el)return;const ro=new ResizeObserver(e=>setWidth(Math.max(200,e[0].contentRect.width)));ro.observe(el);return()=>ro.disconnect()},[ready]);
 const zoomAt=useCallback((factor:number,ratio=0.5)=>setView(v=>{const span=Math.min(MAX_SPAN,Math.max(MIN_SPAN,v.span*factor));const anchor=v.start+ratio*v.span;return {start:anchor-ratio*span,span}}),[]);
 useEffect(()=>{const el=area.current;if(!el||!wheel)return;const on=(e:WheelEvent)=>{if(e.ctrlKey)return;e.preventDefault();const r=el.getBoundingClientRect();zoomAt(e.deltaY<0?0.8:1.25,Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)))};el.addEventListener('wheel',on,{passive:false});return()=>el.removeEventListener('wheel',on)},[wheel,zoomAt,ready]);
 const scale=useMemo(()=>ticks(view,width),[view,width]);
 const setScale=(level:'ano'|'mes'|'dia')=>setView(v=>{const span=level==='ano'?365*DAY:level==='mes'?31*DAY:DAY;const c=v.start+v.span/2;return {start:c-span/2,span}});
 const center=(t:number)=>setView(v=>({...v,start:t-v.span/2}));
 const fit=()=>{const items=rows.flatMap(r=>r.items);if(!items.length)return;const a=Math.min(...items.map(i=>i.a)),b=Math.max(...items.map(i=>i.b));const pad=(b-a)*0.04+2*H;setView({start:a-pad,span:Math.min(MAX_SPAN,Math.max(MIN_SPAN,b-a+2*pad))})};
 const onKey=(e:KeyboardEvent)=>{if(e.key==='ArrowLeft'){e.preventDefault();setView(v=>({...v,start:v.start-v.span*0.1}))}else if(e.key==='ArrowRight'){e.preventDefault();setView(v=>({...v,start:v.start+v.span*0.1}))}else if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(0.8)}else if(e.key==='-'){e.preventDefault();zoomAt(1.25)}};
 const down=(e:RPointerEvent)=>{if((e.target as HTMLElement).closest('.ra-off'))return;drag.current={x:e.clientX,start:view.start};(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)};
 const move=(e:RPointerEvent)=>{const d=drag.current;if(!d)return;setView(v=>({...v,start:d.start-(e.clientX-d.x)*v.span/width}))};
 const up=()=>{drag.current=null};

 if(error)return <div className="form-error"><AlertTriangle size={17}/>{error}</div>;
 if(!data)return <Skeleton className="h-72 rounded-xl"/>;
 const end=view.start+view.span;
 const allocations=rows.reduce((n,r)=>n+r.items.length,0);
 const visible=rows.reduce((n,r)=>n+r.items.filter(i=>i.a<end&&i.b>view.start).length,0);
 const group=(g:typeof rows[number],i:number)=>i===0||rows[i-1].kind!==g.kind;
 return <div className="ragenda">
  <div className="ra-tools">
   <ResourcePick allocs={all} kinds={kinds} picked={chosen} onKinds={k=>save({kinds:k})} onPicked={p=>save({picked:p})}/>
   <button type="button" className="sn-btn" onClick={()=>setExporting(true)} disabled={!all.length}><FileDown size={15}/> Exportar PDF</button>
   <small>{rows.length} recurso(s) · {allocations} alocação(ões) · {visible} no período visível · OS da lista atual{data.more?' (lista limitada às 1.000 primeiras)':''}</small>
  </div>
  {!rows.length?<Empty icon={Package} title="Nenhum recurso alocado" description="As OS da lista, com estes filtros, não têm recursos dos tipos escolhidos."/>:<>
  <div className="g-tools">
   <div className="segmented" role="group" aria-label="Escala">{(['ano','mes','dia'] as const).map(l=><button key={l} type="button" aria-pressed={scale.level===l} onClick={()=>setScale(l)}>{l==='ano'?'Ano':l==='mes'?'Mês':'Dia'}</button>)}</div>
   <button type="button" className="icon-action" onClick={()=>zoomAt(1.25)} aria-label="Afastar"><ZoomOut size={16}/></button><button type="button" className="icon-action" onClick={()=>zoomAt(0.8)} aria-label="Aproximar"><ZoomIn size={16}/></button>
   <button type="button" className="chip" onClick={()=>center(Date.now())}><CalendarCheck size={13} className="inline"/> Hoje</button>
   <button type="button" className="chip" onClick={fit}><Maximize2 size={13} className="inline"/> Ajustar ao período</button>
   <label className="g-wheel" title="Desligado, a roda do mouse rola a lista de recursos"><Switch checked={wheel} onCheckedChange={v=>{setWheel(v);try{sessionStorage.setItem(WHEEL,v?'1':'0')}catch{}}} aria-label="Roda do mouse controla o zoom"/>Roda do mouse controla o zoom</label>
   <span className="g-range">{range(view.start)} → {range(end)} · Horário de Brasília (UTC−3)</span>
  </div>
  <div className="ra-scroll"><div className="ra-grid">
   <div className="ra-left">
    <div className="ra-head-left"><b>{scale.context}</b><small>arraste para mover · roda para aproximar</small></div>
    {rows.map((g,i)=><Fragment key={g.id}>{group(g,i)&&<div className="ra-group" style={{height:GROUP_H}}>{RES_KINDS.find(k=>k.id===g.kind)!.label}<small>{rows.filter(r=>r.kind===g.kind).length}</small></div>}
     <div className={`ra-lbl k-${g.kind}`} style={{height:rowH(g.lanes)}}><b title={g.label}>{g.label}</b><small>{g.sub}</small><small>{g.orders} OS · {g.kind==='material'?`${qty(g.total||0)} ${g.unit}`:`${qty(Math.round(g.hours*10)/10)} h`}</small></div></Fragment>)}
   </div>
   <div className="ra-right" ref={area} tabIndex={0} role="application" aria-label="Agenda de recursos: setas movem o período, + e − aproximam ou afastam" onKeyDown={onKey} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <div className="g-head">{scale.ticks.map(t=><span key={t.t} className={t.major?'major':''} style={{left:x(t.t)}}>{t.label}</span>)}</div>
    <div className="ra-body">
     {scale.ticks.map(t=><i key={t.t} className={`g-line ${t.major?'major':''}`} style={{left:x(t.t)}}/>)}
     {now>view.start&&now<end&&<i className="g-now" style={{left:x(now)}} title="Agora"/>}
     {rows.map((g,i)=>{
      const shown=g.items.filter(it=>{const l=x(it.a);return l<width&&Math.max(l+MIN,x(it.b))>0;});
      const before=g.items.filter(it=>it.b<=view.start).at(-1),after=g.items.find(it=>it.a>=end);
      return <Fragment key={g.id}>{group(g,i)&&<div className="ra-gspace" style={{height:GROUP_H}} aria-hidden/>}
      <div className={`ra-track k-${g.kind}`} style={{height:rowH(g.lanes)}}>
       {shown.map((it,j)=>{const l=x(it.a),real=Math.max(2,x(it.b)-l),w=Math.max(real,MIN);
        const what=g.kind==='equipamento'?'':g.kind==='funcao'?`${qty(it.quantity)}×`:`${qty(it.quantity)} ${it.unit}`;
        const tip=`OS ${os(it.number)} · ${it.activity}${it.step?`\nEtapa: ${it.step}`:''}\n${fmt(it.start)} → ${fmt(it.end)} (${dur(it.a,it.b)})${what?`\nQuantidade: ${what}`:''}`;
        // Barra que começa antes do período visível: recortada na borda esquerda, com o texto à vista.
        const cut=l<0,left=cut?0:l,vis=cut?w+l:w;
        return <span key={j} className={`ra-bar${cut?' cut':''}`} title={tip} style={{left,width:vis,top:it.lane*LANE+6,['--real' as string]:`${Math.max(0,cut?real+l:real)}px`}}>
         <b>OS {os(it.number)}{what&&<em>{what}</em>}</b><i>{when(it.a,it.b)}</i>{it.step&&<small>{it.step}</small>}</span>;})}
       {!shown.length&&before&&<button type="button" className="ra-off left" onClick={()=>center(before.a)} title="Ir para a alocação anterior">◂ {dm.format(before.a)}</button>}
       {!shown.length&&after&&<button type="button" className="ra-off right" onClick={()=>center(after.a)} title="Ir para a próxima alocação">{dm.format(after.a)} ▸</button>}
      </div></Fragment>;})}
    </div>
   </div>
  </div></div></>}
  <div className="ra-legend"><span><i className="lg-real"/>Período real da alocação</span><span><i className="lg-min"/>Extensão mínima para leitura (alocação curta)</span><span><i className="lg-now"/>Agora</span><span>Equipamentos: período reservado. Funções e materiais: período da etapa que os pede. Alocações que se encostam ficam em faixas separadas. Passe o mouse numa barra para ver todos os detalhes.</span></div>
  {exporting&&<ResourceExportDialog allocs={all} initial={{kinds,picked:chosen,period:period.from||period.to?period:{from:isoDay(view.start),to:isoDay(end-1)}}} base={exportParams} onClose={()=>setExporting(false)}/>}
 </div>;
}
