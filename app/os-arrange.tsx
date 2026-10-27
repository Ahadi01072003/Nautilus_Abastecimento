'use client';
// Controles de organização das OS (Lista, Gantt e Apresentação): modo, sentido, filtros de solicitante
// e setor. A configuração fica no navegador e acompanha a pessoa entre as telas; a regra de ordenação
// é única e fica em lib/os-order.ts.
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowDownWideNarrow,ArrowUpNarrowWide,ChevronDown,X} from 'lucide-react';
import './os-arrange.css';
import {DEFAULT_ARRANGE,EMPTY_FILTER,NO_SECTOR,STATUS_GROUPS,type Arrange,type OsFilter} from '@/lib/os-order';

export type OsView={arrange:Arrange,filter:OsFilter,display:'lista'|'gantt'};
const KEY='nautilus.os.view';
export const DEFAULT_VIEW:OsView={arrange:DEFAULT_ARRANGE,filter:EMPTY_FILTER,display:'lista'};

export function readView():OsView{
 try{const v=JSON.parse(localStorage.getItem(KEY)||'null');if(!v)return DEFAULT_VIEW;
  const a=v.arrange||{},f=v.filter||{};const dir=(d:unknown)=>d==='desc'?'desc' as const:'asc' as const;
  return {arrange:{mode:['execucao','setor','status'].includes(a.mode)?a.mode:'execucao',dir:dir(a.dir),sectorDir:dir(a.sectorDir)},
   filter:{orgs:Array.isArray(f.orgs)?f.orgs.filter((x:unknown)=>typeof x==='string'):[],sectors:Array.isArray(f.sectors)?f.sectors.filter((x:unknown)=>typeof x==='string'):[]},
   display:v.display==='gantt'?'gantt':'lista'};
 }catch{return DEFAULT_VIEW;}
}
export function writeView(v:OsView){try{localStorage.setItem(KEY,JSON.stringify(v))}catch{/* sem armazenamento: vale só nesta tela */}}

/** Organização das OS guardada no navegador (a mesma na Lista, no Gantt e na Apresentação). */
export function useOsView(initial?:Partial<OsView>){
 const [view,setView]=useState<OsView>({...DEFAULT_VIEW,...initial});
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Preferência guardada no navegador, lida após montar.
 useEffect(()=>{if(!initial)setView(readView());},[]); // eslint-disable-line react-hooks/exhaustive-deps
 const update=useCallback((patch:Partial<OsView>)=>setView(v=>{const n={...v,...patch};writeView(n);return n;}),[]);
 return [view,update] as const;
}

/** Instante de referência compartilhado (um relógio só para lista, Gantt e flags). */
export function useNow(every=60000){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),every);return()=>clearInterval(t)},[every]);
 return now;
}

type Opt={value:string,label:string,hint?:string};
/** Seleção múltipla compacta (lista com caixas de seleção), com limpar. */
export function MultiPick({label,options,value,onChange,all}:{label:string,options:Opt[],value:string[],onChange:(v:string[])=>void,all:string}){
 const ref=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{const close=(e:Event)=>{const el=ref.current;if(el?.open&&!el.contains(e.target as Node))el.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close)},[]);
 const names=value.map(v=>options.find(o=>o.value===v)?.label||v);
 return <details className="mpick" ref={ref} onKeyDown={e=>{if(e.key==='Escape'&&ref.current){ref.current.open=false;(ref.current.querySelector('summary') as HTMLElement|null)?.focus();}}}>
  <summary aria-label={`${label}: ${value.length?names.join(', '):all}`}><span className="mpick-k">{label}</span><span className={`mpick-v${value.length?' on':''}`}>{value.length?(value.length===1?names[0]:`${value.length} selecionados`):all}</span><ChevronDown size={14} aria-hidden/></summary>
  <div className="mpick-menu" role="group" aria-label={label}>
   {options.length?options.map(o=><label key={o.value}><input type="checkbox" checked={value.includes(o.value)} onChange={e=>onChange(e.target.checked?[...value,o.value]:value.filter(x=>x!==o.value))}/><span>{o.label}</span>{o.hint&&<small>{o.hint}</small>}</label>):<p>Nenhuma opção.</p>}
   {value.length>0&&<button type="button" className="text-action" onClick={()=>onChange([])}>Limpar seleção</button>}
  </div>
 </details>;
}

const MODES:[Arrange['mode'],string][]=[['execucao','Ordem de execução'],['setor','Por setor'],['status','Por status']];
/** Barra de organização: modo, sentido e filtros (solicitante e setor), com os filtros ativos à vista. */
export function ArrangeControls({view,onChange,orgs,sectors,dark=false}:{view:OsView,onChange:(p:Partial<OsView>)=>void,orgs:{id:string,acronym:string,name:string}[],sectors:{code:string,name?:string|null}[],dark?:boolean}){
 const a=view.arrange,f=view.filter;
 const set=(p:Partial<Arrange>)=>onChange({arrange:{...a,...p}});
 const sectorOpts=[...sectors.map(s=>({value:s.code,label:s.name?`${s.code} · ${s.name}`:s.code})),{value:NO_SECTOR,label:'Sem setor'}];
 const orgName=(id:string)=>orgs.find(o=>o.id===id)?.acronym||'—',sectorName=(c:string)=>c===NO_SECTOR?'Sem setor':c;
 const dirButton=(value:Arrange['dir'],key:'dir'|'sectorDir',labels:[string,string])=><div className="segmented" role="group" aria-label={key==='dir'?'Sentido da ordenação das OS':'Ordem dos setores'}>
  <button type="button" aria-pressed={value==='asc'} onClick={()=>set({[key]:'asc'})} title={labels[0]}><ArrowUpNarrowWide size={14} aria-hidden/> {key==='dir'?'Crescente':'A → Z'}</button>
  <button type="button" aria-pressed={value==='desc'} onClick={()=>set({[key]:'desc'})} title={labels[1]}><ArrowDownWideNarrow size={14} aria-hidden/> {key==='dir'?'Decrescente':'Z → A'}</button></div>;
 return <div className={`arrange${dark?' dark':''}`}>
  <div className="arrange-row">
   <div className="arrange-field"><span>Organizar</span><div className="segmented" role="group" aria-label="Organização das OS">{MODES.map(([m,l])=><button key={m} type="button" aria-pressed={a.mode===m} onClick={()=>set({mode:m})}>{l}</button>)}</div></div>
   {a.mode==='execucao'&&<div className="arrange-field"><span>Início planejado</span>{dirButton(a.dir,'dir',['Do início planejado mais antigo para o mais distante','Do início planejado mais distante para o mais antigo'])}</div>}
   {a.mode==='setor'&&<><div className="arrange-field"><span>Setores</span>{dirButton(a.sectorDir,'sectorDir',['Setores em ordem alfabética','Setores em ordem alfabética inversa'])}</div>
    <div className="arrange-field"><span>OS em cada setor</span>{dirButton(a.dir,'dir',['Do início planejado mais antigo para o mais distante','Do início planejado mais distante para o mais antigo'])}</div></>}
   {a.mode==='status'&&<p className="arrange-note" title={STATUS_GROUPS.map(g=>`${g.label}: ${g.note}`).join('\n')}>Prioridade fixa: em andamento → em atraso → previstas → canceladas. O sentido não se aplica a este modo.</p>}
  </div>
  <div className="arrange-row">
   <MultiPick label="Solicitante" all="Todos" options={orgs.map(o=>({value:o.id,label:`${o.acronym} · ${o.name}`}))} value={f.orgs} onChange={orgs=>onChange({filter:{...f,orgs}})}/>
   <MultiPick label="Setor" all="Todos" options={sectorOpts} value={f.sectors} onChange={sectors=>onChange({filter:{...f,sectors}})}/>
   {(f.orgs.length>0||f.sectors.length>0)&&<div className="arrange-active" aria-label="Filtros ativos">
    {f.orgs.map(o=><button key={'o'+o} type="button" onClick={()=>onChange({filter:{...f,orgs:f.orgs.filter(x=>x!==o)}})} aria-label={`Remover solicitante ${orgName(o)}`}>{orgName(o)} <X size={12} aria-hidden/></button>)}
    {f.sectors.map(s=><button key={'s'+s} type="button" onClick={()=>onChange({filter:{...f,sectors:f.sectors.filter(x=>x!==s)}})} aria-label={`Remover setor ${sectorName(s)}`}>{sectorName(s)} <X size={12} aria-hidden/></button>)}
    <button type="button" className="text-action" onClick={()=>onChange({filter:EMPTY_FILTER})}>Limpar filtros</button></div>}
  </div>
 </div>;
}
