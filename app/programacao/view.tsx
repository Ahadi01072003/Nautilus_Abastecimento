'use client';
// Programação publicada: as duas barras lado a lado (TV) ou uma embaixo da outra (celular). Atualiza a cada minuto.
import {useCallback,useEffect,useState} from 'react';
import {Users,Truck,Package,MapPin,RefreshCw} from 'lucide-react';
import {dayOf,dayText} from '@/lib/days';
import './programacao.css';

type R=Record<string,any>;// eslint-disable-line @typescript-eslint/no-explicit-any -- retrato publicado (JSON)
const WEEK=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const plus=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86_400_000).toISOString().slice(0,10);
const h=(n:number)=>Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const cardHh=(c:R)=>c.hh??(c.byFunction as R[]).reduce((n,f)=>n+Number(f.hh||0),0);
const dayHh=(snap:R)=>snap.hh??(snap.cards as R[]).reduce((n,c)=>n+cardHh(c),0);
const at=(iso:string)=>new Date(iso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).replace(',','');

export default function ProgramView({bar,day:initial}:{bar:string,day:string}){
 const [today]=useState(()=>dayOf(Date.now()));
 const [day,setDay]=useState(initial||today),[data,setData]=useState<Record<string,R|null>>({}),[error,setError]=useState(''),[stamp,setStamp]=useState('');
 const bars=bar?[bar]:['equinor','ocp'];
 const refresh=useCallback(async()=>{
  try{
   const out:Record<string,R|null>={};
   for(const b of bars){const r=await fetch(`/api/planning/d1/published?bar=${b}&day=${day}`,{cache:'no-store'});const j=await r.json();if(r.status===401){window.location.reload();return;}if(!r.ok)throw new Error(j.error||'Não foi possível carregar.');out[b]=j;}
   setData(out);setError('');setStamp(new Date().toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}));
  }catch(e){setError((e as Error).message)}
 // eslint-disable-next-line react-hooks/exhaustive-deps -- bars deriva de bar
 },[bar,day]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega e atualiza a cada minuto.
 useEffect(()=>{void refresh();const t=setInterval(()=>void refresh(),60_000);return ()=>clearInterval(t);},[refresh]);
 return <main className="pg">
  <header className="pg-top">
   <div><span className="pg-kicker">Programação publicada</span><h1>{WEEK[new Date(day+'T12:00:00Z').getUTCDay()]}, {dayText(day)}</h1></div>
   <nav aria-label="Dia">{[[today,'Hoje'],[plus(today,1),'Amanhã']].map(([d,l])=><button key={d} type="button" className={day===d?'on':''} onClick={()=>setDay(d)}>{l}</button>)}
    <button type="button" aria-label="Atualizar" onClick={()=>void refresh()}><RefreshCw size={16}/></button>{stamp&&<small>atualizado {stamp}</small>}</nav>
  </header>
  {error&&<p className="pg-error">{error}</p>}
  <div className={`pg-bars n${bars.length}`}>{bars.map(b=>{const p=data[b],snap=p?.snapshot as R|undefined;
   return <section key={b} className={`pg-bar bar-${b}`}>
    <header><h2>{b==='ocp'?'OCP':'Equinor'}</h2>{p?.version?<p>Publicado {at(p.publishedAt)} · {p.publishedBy}{snap?.staff?.hh!=null?` · ${h(dayHh(snap))} de ${h(snap.staff.hh)} HH`:''}</p>:<p>{p?'Ainda não publicado para este dia.':'Carregando…'}</p>}</header>
    {snap&&<>
     <ol className="pg-cards">{(snap.cards as R[]).map(c=><li key={c.planId}>
      <span className="pg-pos">{c.position}</span>
      <div><div className="pg-head"><b className="pg-os">{c.label}</b>{c.org?.acronym&&<span className="pg-org">{c.org.acronym}</span>}{c.location&&<span><MapPin size={13}/> {c.location}</span>}</div>
       <h3>{c.title}</h3><p className="pg-steps">{(c.steps as string[]).join(' · ')}</p>
       <div className="pg-chips">{(c.byFunction as R[]).map(f=><span key={f.functionId}><Users size={13}/> {f.people}× {f.name}</span>)}
        {(c.equipment as R[]).map((e,i)=><span key={i}><Truck size={13}/> {e.tag}</span>)}
        {(c.materials as R[]).map((m,i)=><span key={'m'+i}><Package size={13}/> {h(m.amount)} {m.unit} {m.name}</span>)}</div>
</div>
      <b className="pg-hh">{h(cardHh(c))} HH</b>
     </li>)}</ol>
     {!(snap.cards as R[]).length&&<p className="pg-empty">Nenhuma OS publicada para este dia.</p>}
    </>}
   </section>;})}</div>
 </main>;
}
