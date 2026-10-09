'use client';
import {useEffect,useMemo,useRef,useState,useCallback} from 'react';
import {Fuel,ZoomIn,ZoomOut,Table2,ChevronRight} from 'lucide-react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Linhas agregadas vindas do servidor.
type R=Record<string,any>;
type Level='year'|'month'|'day';
type Range={start:string,end:string};
type Preset='7d'|'30d'|'90d'|'month'|'12m'|'year'|'all'|'custom';
type Bucket={key:string,start:string,end:string,short:string,long:string,value:number,count:number};

const MONTHS=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const MONTHS_LONG=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const WEEKDAYS=['dom','seg','ter','qua','qui','sex','sáb'];
const LEVEL_NAMES:Record<Level,string>={year:'Ano',month:'Mês',day:'Dia'};
const PRESETS:{value:Preset,label:string}[]=[{value:'7d',label:'Últimos 7 dias'},{value:'30d',label:'Últimos 30 dias'},{value:'90d',label:'Últimos 90 dias'},{value:'month',label:'Este mês'},{value:'12m',label:'Últimos 12 meses'},{value:'year',label:'Este ano'},{value:'all',label:'Todo o período'},{value:'custom',label:'Personalizado'}];

const number=(n:number)=>new Intl.NumberFormat('pt-BR',{maximumFractionDigits:3}).format(n);
const todayKey=(at:number)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const toDate=(key:string)=>{const [y,m,d]=key.split('-').map(Number);return new Date(Date.UTC(y,m-1,d));};
const toKey=(date:Date)=>date.toISOString().slice(0,10);
const addDays=(key:string,days:number)=>{const d=toDate(key);d.setUTCDate(d.getUTCDate()+days);return toKey(d);};
const addMonths=(key:string,months:number)=>{const d=toDate(key);d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);return toKey(d);};
const lastOfMonth=(key:string)=>{const d=toDate(key);return toKey(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)));};
const span=(r:Range)=>Math.round((toDate(r.end).valueOf()-toDate(r.start).valueOf())/86400000)+1;
const min=(a:string,b:string)=>a<b?a:b,max=(a:string,b:string)=>a>b?a:b;
const pretty=(key:string)=>key.split('-').reverse().join('/');

function bucketsFor(level:Level,range:Range):Omit<Bucket,'value'|'count'>[]{
 const out:Omit<Bucket,'value'|'count'>[]=[];
 const multiYear=range.start.slice(0,4)!==range.end.slice(0,4);
 if(level==='year'){
  for(let y=+range.start.slice(0,4);y<=+range.end.slice(0,4);y++)out.push({key:String(y),start:max(range.start,`${y}-01-01`),end:min(range.end,`${y}-12-31`),short:String(y),long:String(y)});
 }else if(level==='month'){
  for(let m=range.start.slice(0,7)+'-01';m<=range.end;m=addMonths(m,1)){
   const [y,mm]=m.split('-').map(Number);
   out.push({key:m.slice(0,7),start:max(range.start,m),end:min(range.end,lastOfMonth(m)),short:MONTHS[mm-1]+(multiYear?`/${String(y).slice(2)}`:''),long:`${MONTHS_LONG[mm-1]} de ${y}`});
  }
 }else{
  for(let d=range.start;d<=range.end;d=addDays(d,1)){
   const date=toDate(d);
   out.push({key:d,start:d,end:d,short:`${d.slice(8)}/${d.slice(5,7)}`,long:`${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} de ${MONTHS_LONG[date.getUTCMonth()]} de ${date.getUTCFullYear()}`});
  }
 }
 return out;
}
const autoLevel=(r:Range):Level=>span(r)<=62?'day':span(r)<=366*3?'month':'year';
const niceMax=(v:number)=>{if(v<=0)return 1;const p=10**Math.floor(Math.log10(v)),n=v/p;return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p;};

export default function ConsumptionChart({daily,fuels,now}:{daily:R[],fuels:R[],now:number}){
 const today=todayKey(now);
 const activeFuels=useMemo(()=>fuels.filter(f=>f.active),[fuels]);
 const [fuelId,setFuelId]=useState('');
 const fuel=activeFuels.find(f=>f.id===fuelId)||activeFuels[0];
 const rows=useMemo(()=>daily.filter(x=>x.fuel_id===fuel?.id),[daily,fuel]);
 const firstDay=useMemo(()=>daily.reduce((m:string,x:R)=>x.day<m?x.day:m,today),[daily,today]);
 const presetRange=useCallback((p:Preset):{range:Range,level:Level}=>{
  const year=today.slice(0,4);
  if(p==='7d')return {range:{start:addDays(today,-6),end:today},level:'day'};
  if(p==='30d')return {range:{start:addDays(today,-29),end:today},level:'day'};
  if(p==='90d')return {range:{start:addDays(today,-89),end:today},level:'day'};
  if(p==='month')return {range:{start:today.slice(0,8)+'01',end:today},level:'day'};
  if(p==='12m')return {range:{start:addMonths(today,-11),end:today},level:'month'};
  if(p==='year')return {range:{start:`${year}-01-01`,end:today},level:'month'};
  const start=`${firstDay.slice(0,4)}-01-01`;
  return {range:{start,end:today},level:start.slice(0,4)===year?'month':'year'};
 },[today,firstDay]);
 const [view,setView]=useState<{preset:Preset,range:Range,level:Level}>(()=>({preset:'year',...presetRange('year')}));
 const [hover,setHover]=useState<number|null>(null),[table,setTable]=useState(false),[width,setWidth]=useState(640),[pulse,setPulse]=useState('');
 const plotRef=useRef<HTMLDivElement>(null);

 const buckets:Bucket[]=useMemo(()=>{
  const list=bucketsFor(view.level,view.range).map(b=>({...b,value:0,count:0}));
  const index=new Map(list.map((b,i)=>[b.key,i]));
  for(const x of rows){
   if(x.day<view.range.start||x.day>view.range.end)continue;
   const key=view.level==='year'?x.day.slice(0,4):view.level==='month'?x.day.slice(0,7):x.day;
   const i=index.get(key);if(i===undefined)continue;
   list[i].value+=Number(x.quantity_milli)/1000;list[i].count+=Number(x.count||0);
  }
  return list;
 },[rows,view]);
 const total=buckets.reduce((s,b)=>s+b.value,0),count=buckets.reduce((s,b)=>s+b.count,0);
 const peak=buckets.reduce<Bucket|null>((p,b)=>!p||b.value>p.value?b:p,null);
 const top=niceMax(peak?.value||0);
 const step=Math.max(1,Math.ceil(buckets.length/Math.max(3,Math.floor(width/58))));
 const unit=fuel?.unit||'';
 // "1 cilindro" no singular; unidades abreviadas (L, kg) não mudam.
 const qty=(v:number)=>`${number(v)} ${v===1&&/s$/.test(unit)&&unit.length>3?unit.slice(0,-1):unit}`;

 const zoomIn=useCallback((i:number)=>{
  setView(v=>{
   if(v.level==='day')return v;
   const b=bucketsFor(v.level,v.range)[i];if(!b)return v;
   return {preset:'custom',level:v.level==='year'?'month':'day',range:{start:b.start,end:min(b.end,today)}};
  });
  setHover(null);
 },[today]);
 const zoomOut=useCallback(()=>{
  setView(v=>{
   if(v.level==='day'){const y=v.range.start.slice(0,4);return {preset:'custom',level:'month',range:{start:`${y}-01-01`,end:min(`${y}-12-31`,today)}};}
   if(v.level==='month'){const all=presetRange('all');return {preset:'all',level:'year',range:{start:min(all.range.start,`${v.range.start.slice(0,4)}-01-01`),end:today}};}
   return v;
  });
  setHover(null);
 },[presetRange,today]);

 // Roda do mouse: para cima aproxima (ano › mês › dia) no ponto do cursor; para baixo afasta.
 const stateRef=useRef({level:view.level,n:buckets.length,zoomIn,zoomOut,acc:0,last:0});
 useEffect(()=>{Object.assign(stateRef.current,{level:view.level,n:buckets.length,zoomIn,zoomOut});},[view.level,buckets.length,zoomIn,zoomOut]);
 useEffect(()=>{
  const el=plotRef.current;if(!el)return;
  const onWheel=(e:WheelEvent)=>{
   const s=stateRef.current,inward=e.deltaY<0;
   if(e.deltaY===0||(inward&&s.level==='day')||(!inward&&s.level==='year'))return;
   e.preventDefault();
   const t=Date.now();if(t-s.last<380)return;
   s.acc+=e.deltaY;if(Math.abs(s.acc)<40)return;
   s.acc=0;s.last=t;
   if(inward){const rect=el.getBoundingClientRect();s.zoomIn(Math.min(s.n-1,Math.max(0,Math.floor((e.clientX-rect.left)/rect.width*s.n))));setPulse('in');}
   else{s.zoomOut();setPulse('out');}
  };
  el.addEventListener('wheel',onWheel,{passive:false});
  const ro=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));ro.observe(el);
  return()=>{el.removeEventListener('wheel',onWheel);ro.disconnect();};
 },[]);
 useEffect(()=>{if(!pulse)return;const id=setTimeout(()=>setPulse(''),350);return()=>clearTimeout(id);},[pulse]);

 const choosePreset=(p:Preset)=>{if(p==='custom'){setView(v=>({...v,preset:'custom'}));return;}setView({preset:p,...presetRange(p)});setHover(null);};
 const chooseLevel=(level:Level)=>setView(v=>{
  let range=v.range;
  if(level==='day'&&span(range)>366)range={start:addDays(range.end,-365),end:range.end};
  return {preset:range===v.range?v.preset:'custom',level,range};
 });
 const setDate=(field:'start'|'end',value:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return;
  setView(v=>{
   const range={...v.range,[field]:value>today?today:value};
   if(range.start>range.end)return v;
   return {preset:'custom',range,level:autoLevel(range)};
  });
 };

 // Trilha: Todo o período › 2026 › março
 const crumbs:{label:string,action?:()=>void}[]=[{label:'Todo o período',action:()=>choosePreset('all')}];
 const sameYear=view.range.start.slice(0,4)===view.range.end.slice(0,4),sameMonth=view.range.start.slice(0,7)===view.range.end.slice(0,7);
 if(view.level!=='year'&&sameYear){const y=view.range.start.slice(0,4);crumbs.push({label:y,action:()=>{setView({preset:'custom',level:'month',range:{start:`${y}-01-01`,end:min(`${y}-12-31`,today)}});setHover(null);}});}
 if(view.level==='day'&&sameMonth)crumbs.push({label:MONTHS_LONG[+view.range.start.slice(5,7)-1]});
 const hovered=hover===null?null:buckets[hover];

 return <section className="n-panel consumption zc">
  <div className="panel-heading"><div><h2>Ritmo de abastecimento</h2><p>{fuel?`${unit} de ${fuel.name}`:'Sem combustível ativo'} · {pretty(view.range.start)} a {pretty(view.range.end)} · por {LEVEL_NAMES[view.level].toLowerCase()}</p></div>
   <div className="zc-zoom"><button type="button" onClick={zoomOut} disabled={view.level==='year'} aria-label="Afastar (menos detalhe)" title="Afastar"><ZoomOut size={16}/></button><button type="button" onClick={()=>zoomIn(peak&&peak.value>0?buckets.indexOf(peak):buckets.length-1)} disabled={view.level==='day'} aria-label="Aproximar no período de maior consumo" title="Aproximar"><ZoomIn size={16}/></button></div>
  </div>
  <div className="zc-filters" role="group" aria-label="Filtros do gráfico">
   {activeFuels.length>1&&<label className="zc-field"><span>Combustível</span><select value={fuel?.id||''} onChange={e=>setFuelId(e.target.value)}>{activeFuels.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
   <label className="zc-field"><span>Período</span><select value={view.preset} onChange={e=>choosePreset(e.target.value as Preset)}>{PRESETS.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
   <label className="zc-field"><span>De</span><input type="date" value={view.range.start} max={view.range.end} onChange={e=>setDate('start',e.target.value)}/></label>
   <label className="zc-field"><span>Até</span><input type="date" value={view.range.end} min={view.range.start} max={today} onChange={e=>setDate('end',e.target.value)}/></label>
   <div className="zc-field"><span>Agrupar por</span><div className="zc-segment">{(['year','month','day'] as Level[]).map(l=><button type="button" key={l} className={view.level===l?'active':''} aria-pressed={view.level===l} onClick={()=>chooseLevel(l)}>{LEVEL_NAMES[l]}</button>)}</div></div>
  </div>
  <div className="zc-crumbs"><nav aria-label="Nível do gráfico">{crumbs.map((c,i)=><span key={c.label}>{i>0&&<ChevronRight size={13}/>}{c.action&&i<crumbs.length-1?<button type="button" onClick={c.action}>{c.label}</button>:<b>{c.label}</b>}</span>)}</nav><small>Role o mouse sobre o gráfico para aproximar (ano › mês › dia) ou afastar. Clique numa barra para detalhar.</small></div>
  <div className="zc-summary"><span><b>{number(total)}</b> {unit} no período</span><span><b>{count}</b> {count===1?'abastecimento':'abastecimentos'}</span>{peak&&peak.value>0&&<span>Maior consumo: <b>{peak.long}</b> ({qty(peak.value)})</span>}</div>
  <div className="zc-chart">
   <div className="zc-y" aria-hidden="true"><span>{number(top)}</span><span>{fuel?.integral&&top%2?'':number(top/2)}</span><span>0</span></div>
   <div className={`zc-plot ${pulse?'zc-pulse-'+pulse:''}`} ref={plotRef} onMouseLeave={()=>setHover(null)} style={{gridTemplateColumns:`repeat(${buckets.length},minmax(0,1fr))`}}>
    {buckets.map((b,i)=><button type="button" key={b.key} className={`zc-bar ${hover===i?'hover':''}`} onMouseEnter={()=>setHover(i)} onFocus={()=>setHover(i)} onBlur={()=>setHover(null)} onClick={()=>zoomIn(i)} aria-label={`${b.long}: ${qty(b.value)} em ${b.count} ${b.count===1?'abastecimento':'abastecimentos'}${view.level!=='day'?'. Clique para detalhar.':''}`} style={{cursor:view.level==='day'?'default':'zoom-in'}}>
     <span style={{height:`${b.value/top*100}%`}} className={b.value>0?'has':''}/>
     {i%step===0&&<small>{b.short}</small>}
    </button>)}
    {hovered&&<div className="zc-tip" style={{left:`${Math.min(88,Math.max(12,(hover!+0.5)/buckets.length*100))}%`}} role="status"><b>{qty(hovered.value)}</b><span>{hovered.long}</span><small>{hovered.count} {hovered.count===1?'abastecimento':'abastecimentos'}</small></div>}
    {!count&&<div className="chart-empty"><Fuel size={22}/><span>Sem abastecimentos {fuel?`de ${fuel.name} `:''}neste período</span></div>}
   </div>
  </div>
  <div className="zc-footer"><button type="button" className="text-action" onClick={()=>setTable(t=>!t)} aria-expanded={table}><Table2 size={14}/> {table?'Ocultar tabela':'Ver em tabela'}</button></div>
  {table&&<div className="table-scroll zc-table"><table><thead><tr><th>{LEVEL_NAMES[view.level]}</th><th className="text-right">Quantidade ({unit})</th><th className="text-right">Abastecimentos</th></tr></thead><tbody>{buckets.filter(b=>b.count>0).map(b=><tr key={b.key}><td>{b.long}</td><td className="text-right numeric">{number(b.value)}</td><td className="text-right numeric">{b.count}</td></tr>)}{!count&&<tr><td colSpan={3}>Nenhum abastecimento no período.</td></tr>}</tbody></table></div>}
 </section>;
}
