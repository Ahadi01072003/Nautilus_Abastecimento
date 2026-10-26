'use client';
// Régua da OS: compacta em repouso (OS inteira); ao passar o mouse, focar ou fixar, abre uma faixa
// por etapa. Cada faixa compara duas trilhas: em cima o PLANEJADO (barra contornada com as horas de
// início e fim escritas) e embaixo o EXECUTADO (trabalho sólido, pausa hachurada cinza, bloqueio
// hachurado vermelho). Apontamentos não viram marcas: abaixo da régua ficam os tempos de trabalho,
// pausa, bloqueio e impacto. OS de vários dias: marcas de 6 em 6 horas e virada de dia destacada.
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
 return <div className={className}><span><span className="sw plan"/>Planejado (início e fim)</span><span><span className="sw trabalho"/>Executado: trabalho</span><span><span className="sw pausa"/>Pausa</span><span><span className="sw bloqueio"/>Bloqueio</span><span><span className="sw dayline"/>Virada de dia</span><span><span className="sw now"/>Agora</span></div>;
}
/** Soma de períodos sem contar sobreposição (etapas em paralelo não contam em dobro). */
export function union(spans:number[][]){
 let total=0,cur:number[]|null=null;
 for(const s of [...spans].filter(x=>x[1]>x[0]).sort((a,b)=>a[0]-b[0])){if(!cur||s[0]>cur[1]){if(cur)total+=cur[1]-cur[0];cur=[...s];}else cur[1]=Math.max(cur[1],s[1]);}
 return cur?total+cur[1]-cur[0]:total;
}

type Props={order:R;steps:R[];intervals:R[];occurrences:R[];now:number;compact?:boolean;selected?:string|null;onSelect?:(id:string|null)=>void;title?:string};
export default function OsRuler({order,steps,intervals,occurrences,now,compact=false,selected,onSelect,title='Régua da OS'}:Props){
 const [pinned,setPinned]=useState(false),[cursor,setCursor]=useState<number|null>(null);
 const track=useRef<HTMLDivElement>(null);
 // Quantidade de marcas acompanha a largura da régua (rótulos nunca se sobrepõem).
 const [trackWidth,setTrackWidth]=useState(0);
 useEffect(()=>{const el=track.current;if(!el||typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(([e])=>setTrackWidth(e.contentRect.width));ro.observe(el);return()=>ro.disconnect()},[]);
 const running=['em_andamento','encerramento_pendente'].includes(order.status);
 // Programada (ainda sem execução): a régua fica no período planejado; se "agora" já passou dele,
 // um selo na borda direita mostra a hora atual em vez de esticar a escala.
 const starts=[ms(order.planned_start),...intervals.map(i=>ms(i.start_at)),...steps.filter(s=>s.planned_start).map(s=>ms(s.planned_start))];
 const ends=[ms(order.planned_end),...intervals.map(i=>i.end_at?ms(i.end_at):now),...steps.filter(s=>s.planned_end).map(s=>ms(s.planned_end)),...(running?[now]:[])];
 let ws=Math.min(...starts),we=Math.max(...ends);
 const offset=3*H;// relógio de Brasília (UTC−3) para alinhar marcas às horas cheias locais
 // Mais de ~20 h: escala fixa de 6 em 6 horas, com a virada de cada dia destacada.
 const multiDay=we-ws>20*H;
 const pad=Math.max((we-ws)*.03,15*60000);
 if(multiDay){const q=6*H;ws=Math.floor((ws-pad-offset)/q)*q+offset;we=Math.ceil((we+pad-offset)/q)*q+offset;}
 else{ws=Math.floor((ws-pad)/(H/2))*(H/2);we=Math.ceil((we+pad)/(H/2))*(H/2);}
 const span=Math.max(H,we-ws),pct=(t:number)=>Math.max(0,Math.min(100,(t-ws)/span*100)),width=(a:number,b:number)=>Math.max(.25,pct(b)-pct(a));
 const px=(trackWidth||(compact?520:760))/span; // pixels por milissegundo
 const ticks:{t:number;major:boolean}[]=[];
 if(multiDay){for(let t=ws;t<=we;t+=6*H)ticks.push({t,major:new Date(t-offset).getUTCHours()===0});}
 else{
  const maxTicks=Math.max(2,Math.floor((trackWidth||(compact?520:760))/64));
  const step=[.5,1,2,3,6,12].map(x=>x*H).find(x=>span/x<=maxTicks)||12*H;
  for(let t=Math.ceil((ws-offset)/(step/2))*(step/2)+offset;t<=we;t+=step/2)ticks.push({t,major:Math.round((t-offset)/(step/2))%2===0});
 }
 // Dias inteiros no período (para a faixa alternada e o rótulo da data no início de cada dia).
 const days:number[]=[];for(let d=Math.floor((ws-offset)/(24*H))*24*H+offset;d<we;d+=24*H)days.push(d);
 // Escala em duas linhas (data em cima) quando a janela passa de um dia para o outro.
 const twoTier=multiDay||days.some(d=>d>ws);
 const hourLabels=multiDay?6*H*px>=30:true;
 // Datas na linha de cima da escala; em períodos longos, uma a cada n dias para não encostar.
 const dayEvery=multiDay?Math.max(1,Math.ceil(40/(24*H*px))):1;
 const w=trackWidth||(compact?520:760);
 // O 1º dia pode começar antes da janela: o rótulo vai para a borda e some se encostar no próximo.
 const dayLabels=days.filter((d,i)=>i%dayEvery===0&&(i>0||d>=ws||days.length<=dayEvery||pct(days[dayEvery])*w/100>=44));
 const label=(t:number)=>multiDay?`${String(new Date(t-offset).getUTCHours()).padStart(2,'0')}h`:hm.format(t);
 // Selo do "agora" fora da régua: os rótulos da escala embaixo dele não aparecem.
 const edgeNow=!(now>=ws&&now<=we)&&now>we&&!order.actual_end&&order.status!=='cancelada';
 const freeR=(t:number)=>!edgeNow||pct(t)*w/100<w-132;
 const stopClass=(i:R)=>STOP_BLOCK.has(i.start_kind)?'bloqueio':'pausa';
 const move=(e:MouseEvent)=>{const r=track.current?.getBoundingClientRect();if(!r)return;const x=(e.clientX-r.left)/r.width;setCursor(x>=0&&x<=1?ws+x*span:null);};
 const nowIn=now>=ws&&now<=we;
 const ivs=(list:R[])=>list.map((i,n)=>i.kind==='ativo'
  ?<span key={n} className={`ritem trabalho${i.end_at?'':' open'}`} style={{left:pct(ms(i.start_at))+'%',width:width(ms(i.start_at),i.end_at?ms(i.end_at):now)+'%'}} title={`Trabalho ${hm.format(ms(i.start_at))}–${i.end_at?hm.format(ms(i.end_at)):'agora'} · ${dur((i.end_at?ms(i.end_at):now)-ms(i.start_at))}`}/>
  :<span key={n} className={`ritem ${stopClass(i)}`} style={{left:pct(ms(i.start_at))+'%',width:width(ms(i.start_at),i.end_at?ms(i.end_at):now)+'%'}} title={`${stopClass(i)==='bloqueio'?'Bloqueio':'Pausa'} ${hm.format(ms(i.start_at))}–${i.end_at?hm.format(ms(i.end_at)):'agora'}`}/>);
 // Trilha do planejado: barra contornada com as horas de início e fim (quando cabem).
 // Início e fim em dias diferentes levam a data (24/10 09:00), para não ler "09:00 … 09:00".
 const planned=(a?:string,b?:string,big=false)=>{if(!a||!b)return null;const px=width(ms(a),ms(b))*(trackWidth||600)/100;
  const cross=dm.format(ms(a))!==dm.format(ms(b)),at=(t:number)=>cross?`${dm.format(t)} ${hm.format(t)}`:hm.format(t);
  return <span className="rplan" style={{left:pct(ms(a))+'%',width:width(ms(a),ms(b))+'%'}} title={`Planejado ${dm.format(ms(a))} ${hm.format(ms(a))} → ${dm.format(ms(b))} ${hm.format(ms(b))}`}>
   {px>=(cross?150:big?84:72)?<><b>{at(ms(a))}</b><b>{at(ms(b))}</b></>:px>=(cross?76:big?44:40)?<b>{at(ms(a))}</b>:null}</span>;};
 const near=(t:number)=>nowIn&&Math.abs(pct(t)-pct(now))*(trackWidth||600)/100<48;
 const sorted=[...steps].sort((a,b)=>(a.position??0)-(b.position??0));
 const eff=effective(intervals,now);
 // Tempos executados (sem contar em dobro etapas em paralelo).
 const spansOf=(pred:(i:R)=>boolean)=>intervals.filter(pred).map(i=>[ms(i.start_at),i.end_at?ms(i.end_at):now]);
 const paused=union(spansOf(i=>i.kind!=='ativo'&&stopClass(i)==='pausa')),blocked=union(spansOf(i=>i.kind!=='ativo'&&stopClass(i)==='bloqueio'));
 const impacted=union(occurrences.filter(o=>o.kind==='impacto'&&o.impact_start).map(o=>[ms(o.impact_start),o.impact_end?ms(o.impact_end):running?now:ms(o.impact_start)]));
 const realStart=intervals.length?Math.min(...intervals.map(i=>ms(i.start_at))):null;
 const realEnd=order.actual_end?ms(order.actual_end):running?now:intervals.length?Math.max(...intervals.map(i=>i.end_at?ms(i.end_at):now)):null;
 const when=(t:number)=>`${dm.format(t)} ${hm.format(t)}`;

 return <div className={`os-ruler${compact?' compact':''}`}>
  {!compact&&<div className="rhead"><h2 className="rtitle">{title}</h2><span className="rsum">Planejado {when(ms(order.planned_start))} → {when(ms(order.planned_end))}</span></div>}
  <div className="rbox" tabIndex={0} data-pinned={pinned} aria-label={`Régua: ${dur(eff)} de tempo efetivo. Passe o mouse ou foque para ver as etapas.`}>
   <div className="rgrid">
    <div className="rlabels">
     <div className={`rl-scale${twoTier?' multi':''}`}/>
     <div className="rlabel primary"><b>OS</b><span className="tracks"><em>Plan.</em><em>Real</em></span></div>
     <div className="rextra"><div>{sorted.map(s=><button type="button" key={s.id} className={`rlabel step ${s.status}${selected===s.id?' sel':''}`} onClick={()=>onSelect?.(selected===s.id?null:s.id)} title={s.name}><i/>{s.name}</button>)}</div></div>
    </div>
    <div className={`rtrack${twoTier?' multi':''}`} ref={track} onMouseMove={move} onMouseLeave={()=>setCursor(null)}>
     {multiDay&&days.map((d,i)=>i%2===1&&<span key={'d'+d} className="rdayband" style={{left:pct(d)+'%',width:width(d,d+24*H)+'%'}}/>)}
     {ticks.filter(t=>!days.includes(t.t)).map(t=><span key={'g'+t.t} className={`gl${multiDay||!t.major?' half':''}`} style={{left:pct(t.t)+'%'}}/>)}
     {days.filter(d=>d>ws).map(d=><span key={'v'+d} className="gl day" style={{left:pct(d)+'%'}}/>)}
     <div className={`rscale${twoTier?' multi':''}`}>{ticks.map(t=><i key={'i'+t.t} className={t.major?'major':''} style={{left:pct(t.t)+'%'}}/>)}
      {twoTier&&dayLabels.filter(d=>!near(Math.max(d,ws))&&freeR(Math.max(d,ws))).map(d=><span key={'dl'+d} className="rdaylabel" style={{left:pct(d)+'%'}}>{dm.format(Math.max(d,ws)+H)}</span>)}
      {multiDay?hourLabels&&ticks.filter(t=>!days.includes(t.t)&&pct(t.t)>0&&pct(t.t)<100&&freeR(t.t)).map(t=><span key={'s'+t.t} style={{left:pct(t.t)+'%'}}>{label(t.t)}</span>)
      :ticks.filter(t=>t.major&&(twoTier||!near(t.t))&&pct(t.t)>2&&pct(t.t)<97&&freeR(t.t)).map(t=><span key={'s'+t.t} style={{left:pct(t.t)+'%'}}>{label(t.t)}</span>)}</div>
     <div className="rlane primary">{planned(order.planned_start,order.planned_end,true)}{ivs(intervals.filter(i=>i.kind!=='ativo'))}{ivs(intervals.filter(i=>i.kind==='ativo'))}</div>
     <div className="rextra"><div>{sorted.map(s=><div key={s.id} className={`rlane${selected===s.id?' sel':''}`} onClick={()=>onSelect?.(selected===s.id?null:s.id)}>
      {planned(s.planned_start,s.planned_end)}{ivs(intervals.filter(i=>i.os_step_id===s.id))}
     </div>)}</div></div>
     {nowIn&&<span className="rnow" style={{left:pct(now)+'%'}}/>}
     {edgeNow&&<span className="rnow-edge" title="O momento atual está depois do fim desta régua">agora {dm.format(now)} {hm.format(now)} ▸</span>}
     {cursor!==null&&<span className={`rcursor${pct(cursor)>82?' flip':''}`} style={{left:pct(cursor)+'%'}}><span>{multiDay?`${dm.format(cursor)} `:''}{hm.format(cursor)}</span></span>}
    </div>
   </div>
  </div>
  {!compact&&<dl className="rtotals">
   <div><dt>Executado</dt><dd>{realStart?`${when(realStart)} → ${realEnd&&order.actual_end?when(realEnd):running?'em curso':realEnd?when(realEnd):'—'}`:'Não iniciada'}</dd></div>
   <div className="t-work"><dt>Trabalho</dt><dd>{dur(eff)}</dd></div>
   <div className="t-pause"><dt>Pausa</dt><dd>{dur(paused)}</dd></div>
   <div className="t-block"><dt>Bloqueio</dt><dd>{dur(blocked)}</dd></div>
   <div className="t-imp"><dt>Impacto</dt><dd>{dur(impacted)}</dd></div>
   <div><dt>Apontamentos</dt><dd>{occurrences.length}</dd></div>
  </dl>}
  {!compact&&<div className="rfoot">
   <RulerLegend/>
   <button type="button" className="pin" onClick={()=>setPinned(p=>!p)} aria-pressed={pinned}>{pinned?'Recolher etapas':'Manter etapas abertas'}</button>
  </div>}
 </div>;
}
