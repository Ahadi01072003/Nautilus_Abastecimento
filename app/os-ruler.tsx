'use client';
// Régua da OS: compacta em repouso (OS inteira); ao passar o mouse, focar ou fixar, abre uma faixa
// por etapa. Tipos se distinguem por cor e padrão (legíveis também em preto e branco): trabalho
// sólido, pausa hachurada cinza, bloqueio hachurado vermelho, janela planejada pontilhada com o
// início previsto em linha dupla e bandeira, fim previsto tracejado, ocorrências e impactos como marcas.
import {useEffect,useRef,useState,type MouseEvent} from 'react';
import type {R} from './kit';

const H=3600_000;
const STOP_BLOCK=new Set(['bloqueio','nc_critica','interrupcao_tecnica']);
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit'});
const ms=(v:string)=>Date.parse(v);
export const dur=(x:number)=>{const m=Math.max(0,Math.floor(x/60000));return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};
/** Tempo efetivo da OS: união dos intervalos ativos (etapas em paralelo não contam em dobro). */
export function effective(intervals:R[],now:number){
 const spans=intervals.filter(i=>i.kind==='ativo').map(i=>[ms(i.start_at),i.end_at?ms(i.end_at):now]).sort((a,b)=>a[0]-b[0]);
 let total=0,cur:number[]|null=null;
 for(const s of spans){if(!cur||s[0]>cur[1]){if(cur)total+=cur[1]-cur[0];cur=[...s];}else cur[1]=Math.max(cur[1],s[1]);}
 return cur?total+cur[1]-cur[0]:total;
}

/** Legenda da régua (também usada no Painel de OS, onde as réguas são compactas). */
export function RulerLegend({className='legend'}:{className?:string}){
 return <div className={className}><span><span className="sw trabalho"/>Trabalho</span><span><span className="sw pausa"/>Pausa</span><span><span className="sw bloqueio"/>Bloqueio</span><span><span className="sw plan"/>Janela planejada</span><span><span className="sw pstart"/>Início previsto</span><span><span className="sw pend"/>Fim previsto</span><span><span className="sw ocorrencia"/>Ocorrência</span><span><span className="sw impacto"/>Impacto</span><span><span className="sw now"/>Agora</span></div>;
}

type Props={order:R;steps:R[];intervals:R[];occurrences:R[];now:number;compact?:boolean;selected?:string|null;onSelect?:(id:string|null)=>void;title?:string};
export default function OsRuler({order,steps,intervals,occurrences,now,compact=false,selected,onSelect,title='Régua da OS'}:Props){
 const [pinned,setPinned]=useState(false),[cursor,setCursor]=useState<number|null>(null);
 const track=useRef<HTMLDivElement>(null);
 // Quantidade de marcas acompanha a largura da régua (rótulos nunca se sobrepõem).
 const [trackWidth,setTrackWidth]=useState(0);
 useEffect(()=>{const el=track.current;if(!el||typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(([e])=>setTrackWidth(e.contentRect.width));ro.observe(el);return()=>ro.disconnect()},[]);
 const running=['em_andamento','encerramento_pendente'].includes(order.status);
 const starts=[ms(order.planned_start),...intervals.map(i=>ms(i.start_at)),...steps.filter(s=>s.planned_start).map(s=>ms(s.planned_start))];
 const ends=[ms(order.planned_end),...intervals.map(i=>i.end_at?ms(i.end_at):now),...steps.filter(s=>s.planned_end).map(s=>ms(s.planned_end)),...(running?[now]:[])];
 let ws=Math.min(...starts),we=Math.max(...ends);
 const pad=Math.max((we-ws)*.04,15*60000);
 ws=Math.floor((ws-pad)/(H/2))*(H/2);we=Math.ceil((we+pad)/(H/2))*(H/2);
 const span=Math.max(H,we-ws),pct=(t:number)=>Math.max(0,Math.min(100,(t-ws)/span*100)),width=(a:number,b:number)=>Math.max(.25,pct(b)-pct(a));
 const maxTicks=trackWidth?Math.max(2,Math.floor(trackWidth/(span>20*H?92:64))):compact?6:9;
 const step=[.5,1,2,3,6,12,24,48,96].map(x=>x*H).find(x=>span/x<=maxTicks)||192*H;
 const ticks:{t:number;major:boolean}[]=[];
 const offset=3*H;// relógio de Brasília (UTC−3) para alinhar marcas às horas cheias locais
 for(let t=Math.ceil((ws-offset)/(step/2))*(step/2)+offset;t<=we;t+=step/2)ticks.push({t,major:Math.round((t-offset)/(step/2))%2===0});
 const multiDay=span>20*H;
 const label=(t:number)=>multiDay&&new Date(t-offset).getUTCHours()===0?dm.format(t):hm.format(t);
 const stopClass=(i:R)=>STOP_BLOCK.has(i.start_kind)?'bloqueio':'pausa';
 const occ=(o:R)=>{const b=!!o.blocking||o.kind==='bloqueio';return b?'bloqueio':o.kind;};
 const tip=(o:R)=>`${hm.format(ms(o.occurred_at))} · ${o.kind==='bloqueio'?'Bloqueio':o.kind==='impacto'?'Impacto':'Ocorrência'}${o.category_name?` · ${o.category_name}`:''}: ${o.description}${o.status==='resolvido'?' (resolvido)':''}`;
 const move=(e:MouseEvent)=>{const r=track.current?.getBoundingClientRect();if(!r)return;const x=(e.clientX-r.left)/r.width;setCursor(x>=0&&x<=1?ws+x*span:null);};
 const nowIn=now>=ws&&now<=we;
 const marks=(list:R[])=>list.map(o=>{const c=occ(o),t=ms(o.occurred_at);
  return o.kind==='impacto'&&o.impact_start?<span key={'i'+o.id} className="rmark impacto" style={{left:pct(ms(o.impact_start))+'%',width:width(ms(o.impact_start),o.impact_end?ms(o.impact_end):Math.max(ms(o.impact_start)+15*60000,t))+'%'}} title={tip(o)}/>
  :<span key={'o'+o.id} className={`rmark ${c}`} style={{left:pct(t)+'%'}} title={tip(o)}/>;});
 const ivs=(list:R[])=>list.map((i,n)=>i.kind==='ativo'
  ?<span key={n} className={`ritem trabalho${i.end_at?'':' open'}`} style={{left:pct(ms(i.start_at))+'%',width:width(ms(i.start_at),i.end_at?ms(i.end_at):now)+'%'}} title={`Trabalho ${hm.format(ms(i.start_at))}–${i.end_at?hm.format(ms(i.end_at)):'agora'} · ${dur((i.end_at?ms(i.end_at):now)-ms(i.start_at))}`}/>
  :<span key={n} className={`ritem ${stopClass(i)}`} style={{left:pct(ms(i.start_at))+'%',width:width(ms(i.start_at),i.end_at?ms(i.end_at):now)+'%'}} title={`${stopClass(i)==='bloqueio'?'Bloqueio':'Pausa'} ${hm.format(ms(i.start_at))}–${i.end_at?hm.format(ms(i.end_at)):'agora'}`}/>);
 const planned=(a?:string,b?:string)=>a&&b?<span className="rplan" style={{left:pct(ms(a))+'%',width:width(ms(a),ms(b))+'%'}} title={`Planejado ${dm.format(ms(a))} ${hm.format(ms(a))} – ${hm.format(ms(b))}`}/>:null;
 // Marcos do planejado da OS: início (linha dupla + bandeira cheia) e fim (tracejado + bandeira vazada).
 const ps=ms(order.planned_start),pe=ms(order.planned_end);
 const flagGap=Math.abs(pct(pe)-pct(ps))*(trackWidth||600)/100;
 const near=(t:number)=>[ps,pe].some(x=>Math.abs(pct(t)-pct(x))*(trackWidth||600)/100<(compact?62:96))||(nowIn&&Math.abs(pct(t)-pct(now))*(trackWidth||600)/100<48);
 const sorted=[...steps].sort((a,b)=>(a.position??0)-(b.position??0));
 const eff=effective(intervals,now);

 return <div className={`os-ruler${compact?' compact':''}`}>
  {!compact&&<div className="rhead"><h2 className="rtitle">{title}</h2><span className="rsum">{dur(eff)} efetivas · {intervals.filter(i=>i.kind!=='ativo').length} paradas · {occurrences.length} apontamentos</span></div>}
  <div className="rbox" tabIndex={0} data-pinned={pinned} aria-label={`Régua: ${dur(eff)} de tempo efetivo. Passe o mouse ou foque para ver as etapas.`}>
   <div className="rgrid">
    <div className="rlabels">
     <div className="rl-scale"/>
     <div className="rlabel primary"><span className="sw trabalho"/>OS</div>
     <div className="rextra"><div>{sorted.map(s=><button type="button" key={s.id} className={`rlabel step ${s.status}${selected===s.id?' sel':''}`} onClick={()=>onSelect?.(selected===s.id?null:s.id)} title={s.name}><i/>{s.name}</button>)}</div></div>
    </div>
    <div className="rtrack" ref={track} onMouseMove={move} onMouseLeave={()=>setCursor(null)}>
     {ticks.map(t=><span key={'g'+t.t} className={`gl${t.major?'':' half'}`} style={{left:pct(t.t)+'%'}}/>)}
     <div className="rscale">{ticks.map(t=><i key={'i'+t.t} className={t.major?'major':''} style={{left:pct(t.t)+'%'}}/>)}{ticks.filter(t=>t.major&&!near(t.t)).map(t=><span key={'s'+t.t} style={{left:pct(t.t)+'%'}}>{label(t.t)}</span>)}
      <b className={`rflag start${pct(ps)>70?' flip':''}`} style={{left:pct(ps)+'%'}} title={`Início previsto ${dm.format(ps)} ${hm.format(ps)}`}>▶ {compact?'':'Início prev. '}{hm.format(ps)}</b>
      {flagGap>(compact?70:120)&&<b className={`rflag end${pct(pe)<30?'':' flip'}`} style={{left:pct(pe)+'%'}} title={`Fim previsto ${dm.format(pe)} ${hm.format(pe)}`}>{compact?'':'Fim prev. '}{hm.format(pe)} ◁</b>}</div>
     <div className="rlane primary">{planned(order.planned_start,order.planned_end)}{ivs(intervals.filter(i=>i.kind!=='ativo'))}{ivs(intervals.filter(i=>i.kind==='ativo'))}{marks(occurrences)}</div>
     <div className="rextra"><div>{sorted.map(s=><div key={s.id} className={`rlane${selected===s.id?' sel':''}`} onClick={()=>onSelect?.(selected===s.id?null:s.id)}>
      {planned(s.planned_start,s.planned_end)}{ivs(intervals.filter(i=>i.os_step_id===s.id))}{marks(occurrences.filter(o=>o.os_step_id===s.id))}
     </div>)}</div></div>
     <span className="rpline start" style={{left:pct(ps)+'%'}}/><span className="rpline end" style={{left:pct(pe)+'%'}}/>
     {nowIn&&<span className={`rnow${[ps,pe].some(x=>Math.abs(pct(now)-pct(x))*(trackWidth||600)/100<110)?' low':''}`} style={{left:pct(now)+'%'}}/>}
     {cursor!==null&&<span className={`rcursor${pct(cursor)>82?' flip':''}`} style={{left:pct(cursor)+'%'}}><span>{multiDay?`${dm.format(cursor)} `:''}{hm.format(cursor)}</span></span>}
    </div>
   </div>
  </div>
  {!compact&&<div className="rfoot">
   <RulerLegend/>
   <button type="button" className="pin" onClick={()=>setPinned(p=>!p)} aria-pressed={pinned}>{pinned?'Recolher etapas':'Manter etapas abertas'}</button>
  </div>}
 </div>;
}
