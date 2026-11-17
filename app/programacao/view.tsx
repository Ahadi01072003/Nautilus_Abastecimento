'use client';
// Programação consolidada do dia: as duas barras lado a lado (TV) ou uma embaixo da outra (celular), na ordem da
// reunião, com HH e as OS emergenciais marcadas. Mostra só o que foi consolidado. Atualiza a cada minuto.
import {useCallback,useEffect,useState} from 'react';
import {Users,Truck,Package,MapPin,RefreshCw,Siren} from 'lucide-react';
import {dayOf,dayText} from '@/lib/days';
import './programacao.css';

type R=Record<string,any>;// eslint-disable-line @typescript-eslint/no-explicit-any -- retrato consolidado (JSON)
const WEEK=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const plus=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86_400_000).toISOString().slice(0,10);
const h=(n:number)=>Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const at=(iso:string)=>new Date(iso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).replace(',','');

export default function ProgramView({bar,day:initial}:{bar:string,day:string}){
 const [today]=useState(()=>dayOf(Date.now()));
 const [day,setDay]=useState(initial||today),[data,setData]=useState<Record<string,R>|null>(null),[error,setError]=useState(''),[stamp,setStamp]=useState('');
 const bars=bar?[bar]:['equinor','ocp'];
 const refresh=useCallback(async()=>{
  try{
   const out:Record<string,R>={};
   for(const b of bars){const r=await fetch(`/api/planning/d1/consolidated?bar=${b}&day=${day}`,{cache:'no-store'});const j=await r.json();
    if(r.status===401){window.location.reload();return;}if(!r.ok)throw new Error(j.error||'Não foi possível carregar.');out[b]=j;}
   setData(out);setError('');setStamp(new Date().toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}));
  }catch(e){setError((e as Error).message)}
 // eslint-disable-next-line react-hooks/exhaustive-deps -- bars deriva de bar
 },[day,bar]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega e atualiza a cada minuto.
 useEffect(()=>{void refresh();const t=setInterval(()=>void refresh(),60_000);return ()=>clearInterval(t);},[refresh]);
 return <main className="pg">
  <header className="pg-top">
   <div><span className="pg-kicker">Programação do dia{bar?` · ${bar==='ocp'?'OCP':'Equinor'}`:''}</span><h1>{WEEK[new Date(day+'T12:00:00Z').getUTCDay()]}, {dayText(day)}</h1></div>
   <nav aria-label="Dia">{[[today,'Hoje'],[plus(today,1),'Amanhã']].map(([d,l])=><button key={d} type="button" className={day===d?'on':''} onClick={()=>setDay(d)}>{l}</button>)}
    <button type="button" aria-label="Atualizar" onClick={()=>void refresh()}><RefreshCw size={16}/></button>{stamp&&<small>atualizado {stamp}</small>}</nav>
  </header>
  {error&&<p className="pg-error">{error}</p>}
  {data&&<div className={`pg-bars n${bars.length}`}>{bars.map(b=>{const c=data[b],s=c?.snapshot as R|null;
   if(!s)return <section key={b} className={`pg-bar bar-${b}`}><header><h2>{b==='ocp'?'OCP':'Equinor'}</h2><p>Ainda não consolidado para este dia.</p></header></section>;
   return <section key={b} className={`pg-bar bar-${b}`}>
    <header><h2>{b==='ocp'?'OCP':'Equinor'}</h2><p>{h(s.demandHh)} de {h(s.staff.hh)} HH{s.extraHh>0?` · ${h(s.extraHh)} HH além do limite`:''} · {s.cards.length} OS · consolidado {at(c.consolidatedAt)}{c.version>1?` (v${c.version})`:''}</p></header>
    <ol className="pg-cards">{(s.cards as R[]).map(c=><li key={c.planId} className={c.emergency?'em':''}>
     <span className="pg-pos">{c.position}</span>
     <div><div className="pg-head"><b className="pg-os">{c.label}</b>{c.emergency&&<span className="pg-em"><Siren size={13}/> Emergencial</span>}{c.org?.acronym&&<span className="pg-org">{c.org.acronym}</span>}{c.location&&<span><MapPin size={13}/> {c.location}</span>}</div>
      <h3>{c.title}</h3>
      <div className="pg-chips">{(c.byFunction as R[]).map(f=><span key={f.functionId}><Users size={13}/> {f.people}× {f.name}</span>)}
       {(c.equipment as R[]).map((e,i)=><span key={i}><Truck size={13}/> {e.tag}</span>)}
       {(c.materials as R[]).map((m,i)=><span key={'m'+i}><Package size={13}/> {h(m.amount)} {m.unit} {m.name}</span>)}</div></div>
     <b className="pg-hh">{h(c.hours)} h · {h(c.hh)} HH</b>
    </li>)}</ol>
    {!(s.cards as R[]).length&&<p className="pg-empty">Nenhuma OS consolidada para esta barra.</p>}
   </section>;})}</div>}
 </main>;
}
