'use client';
// Lista de OS programadas › Recursos: agenda exclusiva de uso dos recursos das OS da lista (mesmos
// filtros e organização). Uma linha por recurso (equipamento, função ou material) e, no eixo das
// datas, cada alocação com a OS, a etapa e a quantidade. Os tipos e os recursos podem ser escolhidos
// separadamente ou em conjunto.
import {Fragment,useEffect,useMemo,useState} from 'react';
import {Truck,Users,Package,AlertTriangle} from 'lucide-react';
import {Skeleton} from '@/components/ui/skeleton';
import {Empty,load,fmt,type R} from './kit';
import {MultiPick} from './os-arrange';

type Kind='equipamento'|'funcao'|'material';
const KINDS:{id:Kind,label:string,icon:typeof Truck}[]=[{id:'equipamento',label:'Equipamentos',icon:Truck},{id:'funcao',label:'Funções',icon:Users},{id:'material',label:'Materiais',icon:Package}];
const H=3600_000,DAY=24*H,OFF=3*H;
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit'});
const wd=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'short'});
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
const os=(n:number)=>'OS '+String(n).padStart(6,'0');
const qty=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:3});
const STORE='nautilus.orders.resources';

export default function ResourceAgenda({query,orderIds}:{query:string,orderIds:string[]}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState('');
 const [kinds,setKinds]=useState<Kind[]>(()=>{try{const v=JSON.parse(sessionStorage.getItem(STORE)||'null');if(Array.isArray(v?.kinds)&&v.kinds.length)return v.kinds;}catch{}return ['equipamento','funcao','material'];});
 const [picked,setPicked]=useState<string[]>(()=>{try{const v=JSON.parse(sessionStorage.getItem(STORE)||'null');if(Array.isArray(v?.picked))return v.picked;}catch{}return [];});
 useEffect(()=>{try{sessionStorage.setItem(STORE,JSON.stringify({kinds,picked}))}catch{}},[kinds,picked]);
 useEffect(()=>{let live=true;load<R>('orders/resources?'+query).then(r=>{if(live){setData(r);setError('')}}).catch(e=>{if(live)setError((e as Error).message)});return()=>{live=false}},[query]);
 // Só as OS que estão na lista (os filtros de solicitante e setor são da tela).
 const shown=useMemo(()=>new Set(orderIds),[orderIds]);
 const all=useMemo(()=>((data?.allocations||[]) as R[]).filter(a=>shown.has(a.orderId)),[data,shown]);
 const options=useMemo(()=>{const m=new Map<string,R>();for(const a of all)if(kinds.includes(a.kind)&&!m.has(a.kind+':'+a.key))m.set(a.kind+':'+a.key,{value:a.kind+':'+a.key,label:`${KINDS.find(k=>k.id===a.kind)!.label.slice(0,-1)}: ${a.label}`,kind:a.kind});return [...m.values()].sort((x,y)=>x.label.localeCompare(y.label,'pt-BR'));},[all,kinds]);
 const chosen=picked.filter(p=>options.some(o=>o.value===p));
 const rows=useMemo(()=>{
  const list=all.filter(a=>kinds.includes(a.kind)&&(!chosen.length||chosen.includes(a.kind+':'+a.key))&&Number.isFinite(Date.parse(a.start))&&Number.isFinite(Date.parse(a.end)));
  const by=new Map<string,R>();
  for(const a of list){const k=a.kind+':'+a.key;const g=by.get(k)||{key:k,kind:a.kind,label:a.label,sub:a.sub,unit:a.unit,items:[] as R[]};g.items.push(a);by.set(k,g);}
  const out=[...by.values()];
  for(const g of out){g.items.sort((x:R,y:R)=>Date.parse(x.start)-Date.parse(y.start)||x.number-y.number);
   // Faixas: alocações que se sobrepõem no tempo vão para linhas diferentes dentro do recurso.
   const ends:number[]=[];for(const it of g.items){const s=Date.parse(it.start);let lane=ends.findIndex(e=>e<=s);if(lane<0){lane=ends.length;ends.push(0);}ends[lane]=Date.parse(it.end);it.lane=lane;}g.lanes=Math.max(1,ends.length);
   g.hours=g.items.reduce((n:number,it:R)=>n+(Date.parse(it.end)-Date.parse(it.start))/H,0);
   g.total=g.kind==='material'?g.items.reduce((n:number,it:R)=>n+Number(it.quantity),0):null;
   g.orders=new Set(g.items.map((it:R)=>it.orderId)).size;}
  return KINDS.flatMap(k=>out.filter(g=>g.kind===k.id).sort((a,b)=>String(a.label).localeCompare(String(b.label),'pt-BR')).map((g):R=>({...g,group:k.id})));
 },[all,kinds,chosen]);
 if(error)return <div className="form-error"><AlertTriangle size={17}/>{error}</div>;
 if(!data)return <Skeleton className="h-72 rounded-xl"/>;
 const items=rows.flatMap(g=>g.items as R[]);
 const t0=items.length?Math.floor((Math.min(...items.map(i=>Date.parse(i.start)))-OFF)/DAY)*DAY+OFF:0;
 const t1=items.length?Math.ceil((Math.max(...items.map(i=>Date.parse(i.end)))-OFF)/DAY)*DAY+OFF:0;
 const days=Math.max(1,Math.round((t1-t0)/DAY));
 const x=(t:number)=>(t-t0)/(t1-t0)*100;
 const toggle=(k:Kind)=>setKinds(v=>v.includes(k)?(v.length>1?v.filter(x=>x!==k):v):[...v,k]);
 return <div className="ragenda">
  <div className="ra-tools">
   <div className="ra-kinds" role="group" aria-label="Tipos de recurso">{KINDS.map(k=>{const I=k.icon;return <label key={k.id} className={kinds.includes(k.id)?'on':''}><input type="checkbox" checked={kinds.includes(k.id)} onChange={()=>toggle(k.id)}/><I size={14}/>{k.label}</label>;})}</div>
   <MultiPick label="Recursos" all="Todos dos tipos marcados" options={options.map(o=>({value:o.value,label:o.label}))} value={chosen} onChange={setPicked}/>
   <small>{rows.length} recurso(s) · {items.length} alocação(ões) · OS da lista atual{data.more?' (lista limitada às 1.000 primeiras)':''}</small>
  </div>
  {!rows.length?<Empty icon={Package} title="Nenhum recurso alocado" description="As OS da lista, com estes filtros, não têm recursos dos tipos escolhidos."/>:
  <div className="ra-scroll"><div className="ra-grid" style={{minWidth:`${260+days*34}px`}}>
   <div className="ra-head"><div className="ra-lbl">Recurso</div><div className="ra-days">{Array.from({length:days},(_,i)=>{const d=t0+i*DAY;const w=new Date(d).getUTCDay();return <span key={d} className={w===0||w===6?'we':''} style={{left:`${i/days*100}%`,width:`${100/days}%`}}><em>{wd.format(d+OFF).replace('.','')}</em><b>{dm.format(d+OFF)}</b></span>;})}</div></div>
   {rows.map((g,i)=><Fragment key={g.key}>{(i===0||rows[i-1].group!==g.group)&&<div className="ra-group">{KINDS.find(k=>k.id===g.group)!.label}<small>{rows.filter(r=>r.group===g.group).length}</small></div>}
    <div className={`ra-row k-${g.kind}`} style={{['--lanes' as string]:g.lanes}}>
     <div className="ra-lbl"><b>{g.label}</b><small>{g.sub||''}</small><small>{g.orders} OS · {g.kind==='material'?`${qty(g.total)} ${g.unit}`:`${qty(Math.round(g.hours*10)/10)} h`}</small></div>
     <div className="ra-track" style={{backgroundSize:`${100/days}% 100%`}}>
      {(g.items as R[]).map((it,j)=>{const a=Date.parse(it.start),b=Date.parse(it.end);
       const tip=`${os(it.number)} · ${it.activity}${it.step?`\nEtapa: ${it.step}`:''}\n${fmt(it.start)} → ${fmt(it.end)}${g.kind!=='equipamento'?`\n${qty(it.quantity)} ${it.unit}`:''}`;
       return <span key={j} className="ra-bar" title={tip} style={{left:`${x(a)}%`,width:`${Math.max(.4,x(b)-x(a))}%`,top:`calc(${it.lane} * var(--lane) + 6px)`}}>
        <b>{g.kind==='equipamento'?os(it.number).slice(3):`${qty(it.quantity)}${g.kind==='funcao'?'×':' '+it.unit} · ${os(it.number).slice(3)}`}</b><i>{dm.format(a)} {hm.format(a)}</i></span>;})}
     </div>
    </div></Fragment>)}
  </div></div>}
  <div className="ra-legend"><span>Equipamentos: período reservado. Funções e materiais: período da etapa que os pede (quantidade na barra). Alocações sobrepostas do mesmo recurso aparecem em faixas separadas. Passe o mouse numa barra para ver OS, etapa e horário.</span></div>
 </div>;
}
