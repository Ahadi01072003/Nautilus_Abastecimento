'use client';
// Lista de OS programadas › Agenda de recursos: uso dos recursos das OS da lista (mesmos filtros e
// organização). Uma linha por recurso (equipamento, função ou material) e, no eixo das datas, cada
// alocação com a OS, o horário e a quantidade. Escala em horas (compacta, normal ou detalhada) e
// largura mínima de barra: alocações curtas e próximas continuam legíveis e nunca se sobrepõem
// (faixas calculadas pela extensão visível). Regra das linhas e filtros: lib/resource-agenda.
import {Fragment,useEffect,useMemo,useRef,useState} from 'react';
import {Truck,Users,Package,AlertTriangle,FileDown} from 'lucide-react';
import {Skeleton} from '@/components/ui/skeleton';
import {Empty,load,fmt,type R} from './kit';
import {MultiPick,useNow} from './os-arrange';
import {ALL_KINDS,RES_KINDS,packLanes,resourceOptions,resourceRows,type Alloc,type ResKind} from '@/lib/resource-agenda';
import ResourceExportDialog from './resource-export';

const ICON:Record<ResKind,typeof Truck>={equipamento:Truck,funcao:Users,material:Package};
const H=3600_000,DAY=24*H,OFF=3*H;
const TZ='America/Sao_Paulo';
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const wd=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'short'});
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const os=(n:number)=>String(n).padStart(6,'0');
const qty=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:3});
const STORE='nautilus.orders.resources';
/** Escala: pixels por hora. A barra nunca fica menor que MIN (px); as faixas usam essa largura. */
const SCALES=[{id:'compacta',label:'Compacta',px:12},{id:'normal',label:'Normal',px:24},{id:'detalhada',label:'Detalhada',px:48}] as const;
type Scale=typeof SCALES[number]['id'];
const MIN=140,GAP=8,LABEL=260;
const when=(a:number,b:number)=>dm.format(a)===dm.format(b)?`${dm.format(a)} ${hm.format(a)}–${hm.format(b)}`:`${dm.format(a)} ${hm.format(a)} → ${dm.format(b)} ${hm.format(b)}`;
const dur=(a:number,b:number)=>{const m=Math.round((b-a)/60000);return m<60?`${m} min`:`${qty(Math.round(m/6)/10)} h`;};

type Stored={kinds:ResKind[],picked:string[],scale:Scale};
function readStored():Stored{
 try{const v=JSON.parse(sessionStorage.getItem(STORE)||'null');
  const kinds=Array.isArray(v?.kinds)?v.kinds.filter((k:string)=>ALL_KINDS.includes(k as ResKind)):[];
  return {kinds:kinds.length?kinds:ALL_KINDS,picked:Array.isArray(v?.picked)?v.picked.filter((x:unknown)=>typeof x==='string'):[],scale:SCALES.some(s=>s.id===v?.scale)?v.scale:'normal'};
 }catch{return {kinds:ALL_KINDS,picked:[],scale:'normal'};}
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
 const now=useNow();
 const {kinds,picked,scale}=stored;
 const save=(p:Partial<Stored>)=>setStored(s=>{const n={...s,...p};try{sessionStorage.setItem(STORE,JSON.stringify(n))}catch{}return n;});
 useEffect(()=>{let live=true;load<R>('orders/resources?'+query).then(r=>{if(live){setData(r);setError('')}}).catch(e=>{if(live)setError((e as Error).message)});return()=>{live=false}},[query]);
 // Só as OS que estão na lista (os filtros de solicitante e setor são da tela).
 const shown=useMemo(()=>new Set(orderIds),[orderIds]);
 const all=useMemo(()=>((data?.allocations||[]) as Alloc[]).filter(a=>shown.has(a.orderId)),[data,shown]);
 const chosen=useMemo(()=>{const ok=new Set(resourceOptions(all,kinds).map(o=>o.value));return picked.filter(p=>ok.has(p));},[all,kinds,picked]);
 const px=SCALES.find(s=>s.id===scale)!.px;
 const layout=useMemo(()=>{
  const rows=resourceRows(all,kinds,chosen);
  const items=rows.flatMap(r=>r.items);
  if(!items.length)return {rows,t0:0,days:1,x:(t:number)=>t};
  const t0=Math.floor((Math.min(...items.map(i=>i.a))-OFF)/DAY)*DAY+OFF;
  // O fim do eixo cobre também a largura mínima da última barra.
  const t1=Math.ceil((Math.max(...items.map(i=>Math.max(i.b,i.a+MIN/px*H)))-OFF)/DAY)*DAY+OFF;
  const x=(t:number)=>(t-t0)/H*px;
  for(const r of rows)r.lanes=packLanes(r.items,x,MIN,GAP);
  return {rows,t0,days:Math.max(1,Math.round((t1-t0)/DAY)),x};
 },[all,kinds,chosen,px]);
 // Ao abrir ou mudar a escala, a rolagem horizontal começa perto de agora (quando está no eixo).
 const scroller=useRef<HTMLDivElement>(null);
 useEffect(()=>{const el=scroller.current;if(!el||!layout.rows.length)return;const n=Date.now();const w=layout.days*DAY;
  el.scrollLeft=n>layout.t0&&n<layout.t0+w?Math.max(0,layout.x(n)-3*px):0;},[layout,px]);
 if(error)return <div className="form-error"><AlertTriangle size={17}/>{error}</div>;
 if(!data)return <Skeleton className="h-72 rounded-xl"/>;
 const {rows,t0,days,x}=layout;
 const dayW=24*px,step=px>=48?3:px>=24?6:12;
 const allocations=rows.reduce((n,r)=>n+r.items.length,0);
 const nowX=now>t0&&now<t0+days*DAY?x(now):null;
 return <div className="ragenda">
  <div className="ra-tools">
   <ResourcePick allocs={all} kinds={kinds} picked={chosen} onKinds={k=>save({kinds:k})} onPicked={p=>save({picked:p})}/>
   <div className="segmented" role="group" aria-label="Escala da agenda">{SCALES.map(s=><button key={s.id} type="button" aria-pressed={scale===s.id} onClick={()=>save({scale:s.id})}>{s.label}</button>)}</div>
   <button type="button" className="sn-btn" onClick={()=>setExporting(true)} disabled={!all.length}><FileDown size={15}/> Exportar PDF</button>
   <small>{rows.length} recurso(s) · {allocations} alocação(ões) · OS da lista atual{data.more?' (lista limitada às 1.000 primeiras)':''}</small>
  </div>
  {!rows.length?<Empty icon={Package} title="Nenhum recurso alocado" description="As OS da lista, com estes filtros, não têm recursos dos tipos escolhidos."/>:
  <div className="ra-scroll" ref={scroller}><div className="ra-grid" style={{width:`${LABEL+days*dayW}px`,['--lane' as string]:'62px'}}>
   <div className="ra-head"><div className="ra-lbl">Recurso</div><div className="ra-days">{Array.from({length:days},(_,i)=>{const d=t0+i*DAY;const w=new Date(d).getUTCDay();
    return <span key={d} className={w===0||w===6?'we':''} style={{left:i*dayW,width:dayW}}><b>{wd.format(d+OFF).replace('.','')} {dm.format(d+OFF)}</b>
     <span className="ra-hours">{Array.from({length:24/step-1},(_,k)=><i key={k} style={{left:(k+1)*step*px}}>{String((k+1)*step).padStart(2,'0')}h</i>)}</span></span>;})}</div></div>
   {rows.map((g,i)=><Fragment key={g.id}>{(i===0||rows[i-1].kind!==g.kind)&&<div className="ra-group"><span>{RES_KINDS.find(k=>k.id===g.kind)!.label}<small>{rows.filter(r=>r.kind===g.kind).length}</small></span></div>}
    <div className={`ra-row k-${g.kind}`} style={{['--lanes' as string]:g.lanes}}>
     <div className="ra-lbl"><b title={g.label}>{g.label}</b><small>{g.sub}</small><small>{g.orders} OS · {g.kind==='material'?`${qty(g.total||0)} ${g.unit}`:`${qty(Math.round(g.hours*10)/10)} h`}</small></div>
     <div className="ra-track" style={{['--day' as string]:`${dayW}px`,['--hour' as string]:`${step*px}px`}}>
      {nowX!=null&&<i className="ra-now" style={{left:nowX}} aria-hidden/>}
      {g.items.map((it,j)=>{const l=x(it.a),real=Math.max(2,x(it.b)-l),w=Math.max(real,MIN);
       const what=g.kind==='equipamento'?'':g.kind==='funcao'?`${qty(it.quantity)}×`:`${qty(it.quantity)} ${it.unit}`;
       const tip=`OS ${os(it.number)} · ${it.activity}${it.step?`\nEtapa: ${it.step}`:''}\n${fmt(it.start)} → ${fmt(it.end)} (${dur(it.a,it.b)})${what?`\nQuantidade: ${what}`:''}`;
       return <span key={j} className={`ra-bar${real<w?' short':''}`} title={tip} style={{left:l,width:w,top:`calc(${it.lane} * var(--lane) + 6px)`,['--real' as string]:`${real}px`}}>
        <b>OS {os(it.number)}{what&&<em>{what}</em>}</b><i>{when(it.a,it.b)}</i>{it.step&&<small>{it.step}</small>}</span>;})}
     </div>
    </div></Fragment>)}
  </div></div>}
  <div className="ra-legend"><span><i className="lg-real"/>Período real da alocação</span><span><i className="lg-min"/>Extensão mínima para leitura (alocação curta)</span><span><i className="lg-now"/>Agora</span><span>Equipamentos: período reservado. Funções e materiais: período da etapa que os pede. Alocações que se encostam ficam em faixas separadas. Passe o mouse numa barra para ver todos os detalhes.</span></div>
  {exporting&&<ResourceExportDialog allocs={all} initial={{kinds,picked:chosen,period:period.from||period.to?period:spanOf(all)}} base={exportParams} onClose={()=>setExporting(false)}/>}
 </div>;
}

/** Período sugerido para exportar: do primeiro ao último dia com alocação (datas de Brasília). */
function spanOf(all:Alloc[]){
 const ts=all.flatMap(a=>[Date.parse(a.start),Date.parse(a.end)]).filter(Number.isFinite);
 if(!ts.length)return {from:'',to:''};
 const day=(t:number)=>new Date(t-OFF).toISOString().slice(0,10);
 return {from:day(Math.min(...ts)),to:day(Math.max(...ts))};
}
