// Agenda de recursos para imprimir ou salvar em PDF (A4 paisagem). Uma linha por recurso
// (equipamento, função ou material) e as datas do período no eixo horizontal; cada alocação com a
// OS, o horário e a quantidade. Mesma regra da tela (lib/resource-agenda): tipos e recursos
// escolhidos, barra no período exato com o texto ao lado quando não cabe e faixas pelo que é desenhado (nada se sobrepõe). Depois do
// cronograma, o detalhe de cada alocação em tabela (no papel não há "passar o mouse").
import type {Metadata} from 'next';
import {Fragment,type CSSProperties} from 'react';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {resourceAgendaData} from '@/lib/agenda';
import {db} from '@/lib/db';
import {audit} from '@/lib/registry';
import {rateLimit} from '@/lib/security';
import {AppError} from '@/lib/domain';
import {RES_KINDS,ALL_KINDS,packLanes,resourceRows,type ResRow,type ResItem} from '@/lib/resource-agenda';
import AgendaPrint from '../print';
export const dynamic='force-dynamic';

type Search=Promise<Record<string,string|string[]|undefined>>;
const one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
const br=(iso:string)=>iso.split('-').reverse().join('/');
export async function generateMetadata({searchParams}:{searchParams:Search}):Promise<Metadata>{
 const s=await searchParams,a=one(s.inicio),b=one(s.fim);
 return {title:`Agenda de recursos ${a?br(a):''}${b&&b!==a?' a '+br(b):''} · NAUTILUS`,robots:{index:false,follow:false}};
}

const TZ='America/Sao_Paulo',H=3600_000,DAY=24*H,OFF=3*H;
// Medidas em mm (A4 paisagem, 277 × 195 úteis). Coluna do recurso + área das datas.
const LABEL_W=58,TIME_W=277-LABEL_W;
const LANE=7.4,ROW_PAD=2.4,ROW_MIN=11,GROUP_H=5.6,MIN_W=26,GAP=1.2;
// Altura útil para as linhas: 1ª folha com o resumo; as demais com cabeçalho curto.
const AVAIL_FIRST=118,AVAIL_NEXT=152;
const DETAIL_ROWS=22;
const f=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const dmy=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric'});
const wd=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'short'});
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const num=(n:number,d=1)=>n.toLocaleString('pt-BR',{maximumFractionDigits:d});
const os=(n:number)=>String(n).padStart(6,'0');
const when=(a:number,b:number)=>dm.format(a)===dm.format(b)?`${dm.format(a)} ${hm.format(a)}–${hm.format(b)}`:`${dm.format(a)} ${hm.format(a)} → ${dm.format(b)} ${hm.format(b)}`;
const dur=(a:number,b:number)=>{const m=Math.round((b-a)/60000);return m<60?`${m} min`:`${num(m/60)} h`;};
const what=(r:ResRow,i:ResItem)=>r.kind==='equipamento'?'':r.kind==='funcao'?`${num(i.quantity,0)}×`:`${num(i.quantity,3)} ${i.unit||''}`;
const COLOR:Record<string,string>={equipamento:'#087f77',funcao:'#4f5fe0',material:'#c25e00'};

const css=`
html,body{background:#dfe5e3!important;color:#0b1d25}
body{font:9pt/1.35 var(--f-body);margin:0}
.noprint{position:fixed;right:18px;top:18px;display:grid;gap:6px;justify-items:end;z-index:5}
.noprint button{background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(3,22,31,.18)}
.noprint small{font-size:11px;color:#4b5f66;background:#fff;padding:3px 6px;border-radius:3px}
.err{max-width:640px;margin:60px auto;background:#fff;padding:24px;border-radius:6px}
.page{width:297mm;height:210mm;box-sizing:border-box;padding:8mm 10mm 7mm;margin:10mm auto;background:#fff;box-shadow:0 6px 28px rgba(3,22,31,.16);display:flex;flex-direction:column;gap:3mm;overflow:hidden;position:relative;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top{display:grid;grid-template-columns:38mm 1fr auto;align-items:end;gap:6mm;border-bottom:.9mm solid #03161f;padding-bottom:2mm}
.top img{width:30mm;height:auto}
.top .eye{font:600 6.8pt/1.2 var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:#087f77}
.top h1{margin:.4mm 0 0;font:850 17pt/1 var(--f-display);font-variation-settings:"wdth" 112;letter-spacing:-.02em}
.top h1 i{font-style:normal;color:#087f77}
.top .sec{margin-top:.8mm;font-size:8.6pt;color:#4b5f66}.top .sec b{color:#0b1d25}
.top .meta{text-align:right;font:500 7pt/1.5 var(--f-mono);color:#4b5f66}
.mini{display:flex;justify-content:space-between;align-items:baseline;border-bottom:.6mm solid #03161f;padding-bottom:1.6mm;font:600 7.4pt/1.2 var(--f-mono);letter-spacing:.08em;text-transform:uppercase;color:#4b5f66}
.mini b{font:800 11pt/1 var(--f-display);letter-spacing:-.01em;text-transform:none;color:#0b1d25;margin-right:3mm}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);border:.3mm solid #c7d0ce}
.kpis div{padding:1.3mm 2.4mm;border-right:.3mm solid #c7d0ce}.kpis div:last-child{border-right:0}
.kpis dt{font:600 6.2pt/1.2 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#6c7c82}
.kpis dd{margin:.4mm 0 0;font:800 13pt/1 var(--f-mono);color:#0b1d25}.kpis dd small{font:500 7pt/1.3 var(--f-body);color:#4b5f66;display:block;margin-top:.6mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sel{font-size:7.4pt;color:#33474e;line-height:1.4}.sel b{color:#0b1d25}
.chart{flex:1;min-height:0;display:flex;flex-direction:column;border:.3mm solid #9fb0ad;position:relative;overflow:hidden}
.gh{display:grid;grid-template-columns:${LABEL_W}mm 1fr;border-bottom:.4mm solid #9fb0ad;background:#eef1f0;flex:none}
.gh .lbl{font:700 6.4pt/1 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#4b5f66;padding:0 2.4mm;display:flex;align-items:center;border-right:.3mm solid #9fb0ad}
.days{position:relative;height:8.4mm}
.days span{position:absolute;top:0;bottom:0;display:flex;flex-direction:column;align-items:center;border-left:.2mm solid #c7d0ce;font:600 5.8pt/1.15 var(--f-mono);color:#4b5f66;text-transform:uppercase;overflow:hidden;padding-top:.8mm;box-sizing:border-box}
.days span b{font:800 7.4pt/1.1 var(--f-mono);color:#0b1d25;text-transform:none}
.days span.we{background:#e2e8e6}
.hours{position:absolute;left:0;right:0;bottom:0;height:2.8mm}
.hours i{position:absolute;bottom:.2mm;font:500 5.2pt/1 var(--f-mono);font-style:normal;color:#6c7c82;translate:-50% 0}
.rrow{display:grid;grid-template-columns:${LABEL_W}mm 1fr;border-bottom:.3mm solid #c7d0ce;flex:none;overflow:hidden}
.rrow:nth-child(even){background:#f7f9f8}
.rinfo{display:flex;flex-direction:column;justify-content:center;gap:.3mm;padding:1mm 2.4mm 1mm 3mm;border-right:.3mm solid #9fb0ad;border-left:1.4mm solid var(--c);min-width:0}
.rinfo b{font:700 7.6pt/1.15 var(--f-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rinfo span{font-size:6.3pt;color:#33474e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rinfo small{font:600 6pt/1.2 var(--f-mono);color:#6c7c82}
.rtime{position:relative;background-image:var(--grid)}
.rtime .we{position:absolute;top:0;bottom:0;background:rgba(75,95,102,.07)}
.grp{display:flex;align-items:center;gap:2mm;padding:0 3mm;background:#e8eeec;border-bottom:.3mm solid #c7d0ce;font:800 7.4pt/1 var(--f-body);flex:none}
.grp small{font:600 6.2pt/1 var(--f-mono);color:#087f77}
.bar{position:absolute;height:${LANE-1.2}mm;box-sizing:border-box;border:.3mm solid var(--c);border-left:1.2mm solid var(--c);border-radius:.8mm;padding:.5mm 1.2mm;overflow:hidden;z-index:2;display:flex;flex-direction:column;justify-content:center;gap:.2mm;white-space:nowrap;
 background:color-mix(in srgb,var(--c) 24%,#fff)}
.bar.thin{border:0;border-radius:.3mm;background:var(--c);padding:0}
.tag{position:absolute;height:${LANE-1.2}mm;box-sizing:border-box;padding:0 1mm;overflow:hidden;z-index:2;display:flex;flex-direction:column;justify-content:center;gap:.2mm;white-space:nowrap}
.tag.right{border-left:.4mm dotted var(--c)}.tag.left{border-right:.4mm dotted var(--c);align-items:flex-end;text-align:right}
.tag b{font:700 6.2pt/1 var(--f-mono);color:#0b1d25}.tag b em{font-style:normal;font-weight:600;margin-left:1mm;color:#33474e}
.tag i{font:500 5.6pt/1 var(--f-mono);font-style:normal;color:#33474e;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.bar b{font:700 6.2pt/1 var(--f-mono);color:#0b1d25}.bar b em{font-style:normal;font-weight:600;margin-left:1mm;color:#33474e}
.bar i{font:500 5.6pt/1 var(--f-mono);font-style:normal;color:#33474e;overflow:hidden;text-overflow:ellipsis}
.empty{margin:auto;color:#4b5f66;font-size:10pt}
.legend{display:flex;flex-wrap:wrap;gap:4mm;font-size:6.8pt;color:#4b5f66;align-items:center}
.legend i{display:inline-block;width:6mm;height:2.6mm;margin-right:1.2mm;vertical-align:-.4mm;border:.3mm solid #087f77;border-left:1.2mm solid #087f77;background:color-mix(in srgb,#087f77 22%,#fff)}
.legend i.m{width:3mm;border:0;border-right:.4mm dotted #087f77;background:linear-gradient(90deg,#087f77 0 1mm,transparent 1mm)}
.legend i.f{border-color:#4f5fe0;background:color-mix(in srgb,#4f5fe0 22%,#fff)}.legend i.t{border-color:#c25e00;background:color-mix(in srgb,#c25e00 22%,#fff)}
.foot{display:flex;justify-content:space-between;gap:4mm;font:500 6.6pt/1.2 var(--f-mono);letter-spacing:.06em;color:#6c7c82;margin-top:auto}
.dtab{border:.3mm solid #9fb0ad;display:flex;flex-direction:column}
.dtab .dh,.dtab .dr{display:grid;grid-template-columns:52mm 70mm 1fr 52mm 18mm 24mm}
.dtab .dh{background:#eef1f0;border-bottom:.4mm solid #9fb0ad}
.dtab .dh span{font:700 6.2pt/1 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#4b5f66;padding:2mm 2.4mm;border-right:.3mm solid #c7d0ce}
.dtab .dr{height:6.6mm;border-bottom:.3mm solid #dde3e1}
.dtab .dr:nth-of-type(even){background:#f7f9f8}
.dtab .dr>span{padding:0 2.4mm;display:flex;align-items:center;gap:1.4mm;border-right:.3mm solid #e4e9e7;font-size:7pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dtab .dr>span:first-child{border-left:1.2mm solid var(--c)}
.dtab .dr b{font:700 7pt var(--f-mono)}.dtab .dr .mut{color:#6c7c82}
.dtab .dr.g{background:#e8eeec!important;font-weight:800}.dtab .dr.g>span{grid-column:1/-1;border-left:0;font:800 7.2pt/1 var(--f-body)}
@media print{html,body{background:#fff!important}.noprint{display:none}.page{margin:0;box-shadow:none;break-after:page}.page:last-child{break-after:auto}@page{size:A4 landscape;margin:0}}
`;

/** Pedaço de linha numa folha: o recurso inteiro ou parte das faixas (quando não cabe numa folha). */
type Piece={kind:'grp',label:string,count:number,cont:boolean}|{kind:'row',row:ResRow,lanes:[number,number],cont:boolean};
const pieceH=(p:Piece)=>p.kind==='grp'?GROUP_H:Math.max(ROW_MIN,(p.lanes[1]-p.lanes[0])*LANE+ROW_PAD);

export default async function ResourceAgendaPdf({searchParams}:{searchParams:Search}){
 const s=await searchParams;
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 const params=new URLSearchParams(Object.entries(s).map(([k,v])=>[k,one(v)]));
 let r:Awaited<ReturnType<typeof resourceAgendaData>>;
 try{await rateLimit(member.id,'export');r=await resourceAgendaData(member,params);}
 catch(e){if(!(e instanceof AppError))throw e;return <main><style>{css}</style><div className="err"><h1>Agenda de recursos indisponível</h1><p>{e.message}</p></div></main>;}
 const rows=resourceRows(r.allocations,r.kinds,r.picked);
 const allocCount=rows.reduce((n,x)=>n+x.items.length,0);
 await db().tx(tx=>audit(tx,member,'Exportação: agenda de recursos',`agenda-recursos:${one(s.inicio)}:${one(s.fim)}`,{from:one(s.inicio),to:one(s.fim),kinds:r.kinds,resources:r.picked.length,allocations:allocCount}));
 const t0=Date.parse(r.period.from),t1=Date.parse(r.period.to),days=r.period.days,span=t1-t0;
 const mm=(t:number)=>(t-t0)/span*TIME_W;
 // Faixas em milímetros: barra no período exato (recortada ao período) e texto ao lado quando não cabe.
 for(const x of rows)x.lanes=packLanes(x.items,t=>mm(Math.max(t0,Math.min(t1,t))),MIN_W,GAP,TIME_W,0);

 // Paginação pela altura real de cada linha; recurso com muitas faixas continua na folha seguinte.
 const pages:Piece[][]=[];let cur:Piece[]=[],used=0;
 const room=()=>pages.length===0?AVAIL_FIRST:AVAIL_NEXT;
 const push=(p:Piece)=>{cur.push(p);used+=pieceH(p);};
 const newPage=()=>{pages.push(cur);cur=[];used=0;};
 rows.forEach((x,i)=>{
  const first=i===0||rows[i-1].kind!==x.kind;
  const label=RES_KINDS.find(k=>k.id===x.kind)!.label,count=rows.filter(y=>y.kind===x.kind).length;
  const need=GROUP_H*(first?1:0)+Math.max(ROW_MIN,LANE+ROW_PAD);
  if(used+need>room()&&cur.length)newPage();
  if(first)push({kind:'grp',label,count,cont:false});
  else if(!cur.length)push({kind:'grp',label,count,cont:true});
  let lane=0;
  while(lane<x.lanes){
   const fit=Math.max(1,Math.floor((room()-used-ROW_PAD)/LANE));
   const take=Math.min(x.lanes-lane,fit);
   push({kind:'row',row:x,lanes:[lane,lane+take],cont:lane>0});lane+=take;
   if(lane<x.lanes){newPage();push({kind:'grp',label,count,cont:true});}
  }
 });
 if(cur.length||!pages.length)pages.push(cur);

 // Detalhe: uma linha por alocação, na ordem dos recursos; cabeçalho do recurso entre os blocos.
 type DRow={g:true,row:ResRow,cont:boolean}|{g:false,row:ResRow,it:ResItem};
 const detail:DRow[][]=[];let dc:DRow[]=[];
 for(const x of rows){x.items.forEach((it,j)=>{
  if(dc.length>=DETAIL_ROWS-1&&j===0){detail.push(dc);dc=[];}
  if(dc.length>=DETAIL_ROWS){detail.push(dc);dc=[];}
  if(j===0||!dc.length)dc.push({g:true,row:x,cont:j>0});
  dc.push({g:false,row:x,it});});}
 if(dc.length)detail.push(dc);
 const sheets=pages.length+detail.length;

 const range=`${dmy.format(t0)}${days>1?' a '+dmy.format(t1-1):''}`;
 const kindsLabel=r.kinds.length===ALL_KINDS.length?'Equipamentos, funções e materiais':RES_KINDS.filter(k=>r.kinds.includes(k.id)).map(k=>k.label).join(' e ');
 const issued=`Emitida em ${f.format(new Date(r.generatedAt)).replace(',','')} por ${member.name}`;
 const byKind=(k:string)=>rows.filter(x=>x.kind===k);
 const eqHours=byKind('equipamento').reduce((n,x)=>n+x.hours,0);
 const orders=new Set(rows.flatMap(x=>x.items.map(i=>i.orderId))).size;
 const busiest=[...rows].sort((a,b)=>b.items.length-a.items.length)[0];
 const picked=r.picked.length?rows.map(x=>x.label).join(', '):'';
 const filters=r.filterLabels.join(' · ');
 const hourStep=days<=1?2:days<=3?6:days<=7?12:0;
 const dayList=Array.from({length:days},(_,i)=>t0+i*DAY);
 const colW=TIME_W/days;
 const grid=`repeating-linear-gradient(90deg,#d3dbd9 0 .2mm,transparent .2mm ${100/days}%)`;
 const weekend=dayList.filter(d=>{const w=new Date(d).getUTCDay();return w===0||w===6;});

 const header=<>
  <div className="top">
   {/* eslint-disable-next-line @next/next/no-img-element -- Logo estático, mesmo arquivo na impressão. */}
   <img src="/logo-color.svg" alt="OceanPact LOG" width={240} height={118}/>
   <div><div className="eye">NAUTILUS · agenda de recursos</div><h1>{range}<i>.</i></h1><div className="sec"><b>{kindsLabel}</b> · {days} dia(s) · horários de Brasília</div></div>
   <div className="meta">{issued}<br/>Somente OS lançadas (sem canceladas){r.more?' · lista limitada às 1.000 primeiras OS':''}</div>
  </div>
  <dl className="kpis">
   <div><dt>Recursos</dt><dd>{rows.length}<small>{RES_KINDS.map(k=>`${byKind(k.id).length} ${k.label.toLowerCase()}`).join(' · ')}</small></dd></div>
   <div><dt>Alocações</dt><dd>{allocCount}<small>em {orders} OS</small></dd></div>
   <div><dt>Horas de equipamento</dt><dd>{num(eqHours)} h<small>reservadas no período</small></dd></div>
   <div><dt>Mais alocado</dt><dd>{busiest?busiest.items.length:'—'}<small>{busiest?busiest.label:'sem alocações'}</small></dd></div>
   <div><dt>Período</dt><dd>{days} d<small>{range}</small></dd></div>
  </dl>
  <div className="sel"><b>Seleção:</b> {r.picked.length?`${r.picked.length} recurso(s) escolhido(s): ${picked}`:'todos os recursos dos tipos marcados'}{filters?` · ${filters}`:''}</div>
 </>;

 const axis=<div className="gh"><div className="lbl">Recurso</div>
  <div className="days">{dayList.map(d=>{const w=new Date(d).getUTCDay();return <span key={d} className={w===0||w===6?'we':''} style={{left:`${(d-t0)/span*100}%`,width:`${100/days}%`}}>{colW>=7?wd.format(d+OFF).replace('.',''):wd.format(d+OFF).slice(0,1)}<b>{colW>=9?dm.format(d+OFF):new Date(d+OFF).getUTCDate()}</b></span>;})}
   {hourStep>0&&<div className="hours">{dayList.flatMap(d=>Array.from({length:24/hourStep-1},(_,k)=>d+(k+1)*hourStep*H)).map(t=><i key={t} style={{left:`${(t-t0)/span*100}%`}}>{String(new Date(t-OFF).getUTCHours()).padStart(2,'0')}h</i>)}</div>}</div></div>;

 return <main><style>{css}</style><AgendaPrint auto={one(s.imprimir)==='1'}/>
  {pages.map((list,p)=><section key={p} className="page">
   {p===0?header:<div className="mini"><span><b>Agenda de recursos · {range}</b>{kindsLabel}</span><span>Folha {p+1} de {sheets}</span></div>}
   <div className="chart">{axis}
    {list.map((x,i)=>x.kind==='grp'?<div key={'g'+i} className="grp" style={{height:`${GROUP_H}mm`}}>{x.label}{x.cont?' (continuação)':''}<small>{x.count}</small></div>:(()=>{
     const g=x.row,items=g.items.filter(it=>it.lane>=x.lanes[0]&&it.lane<x.lanes[1]);
     return <div key={g.id+':'+x.lanes[0]} className="rrow" style={{height:`${pieceH(x)}mm`,['--c' as string]:COLOR[g.kind]} as CSSProperties}>
      <div className="rinfo"><b>{g.label}{x.cont?' (cont.)':''}</b><span>{g.sub}</span><small>{g.orders} OS · {g.kind==='material'?`${num(g.total||0,3)} ${g.unit}`:`${num(g.hours)} h`}</small></div>
      <div className="rtime" style={{['--grid' as string]:grid} as CSSProperties}>
       {weekend.map(d=><i key={d} className="we" style={{left:`${(d-t0)/span*100}%`,width:`${100/days}%`}}/>)}
       {items.map((it,j)=>{const a=Math.max(t0,it.a),b=Math.min(t1,it.b),l=mm(a),r=mm(b),w=Math.max(.6,r-l),top=`${(it.lane-x.lanes[0])*LANE+ROW_PAD/2+.6}mm`;
        const text=<><b>{it.a<t0?'◂ ':''}OS {os(it.number)}{what(g,it)&&<em>{what(g,it)}</em>}</b><i>{when(it.a,it.b)}{it.b>t1?' ▸':''}</i></>;
        return <Fragment key={j}><div className={`bar${w<2.4?' thin':''}`} style={{left:`${l}mm`,width:`${w}mm`,top}}>{it.side==='in'&&text}</div>
         {it.side!=='in'&&<div className={`tag ${it.side}`} style={{left:`${it.side==='right'?r+GAP:l-GAP-MIN_W}mm`,width:`${MIN_W}mm`,top}}>{text}</div>}</Fragment>;})}
      </div>
     </div>;})())}
    {!rows.length&&<p className="empty">Nenhuma alocação dos recursos escolhidos entre {range}.</p>}
   </div>
   <div className="legend"><span><i/>Período exato, reservado ou da etapa</span><span><i className="m"/>Alocação curta: texto ao lado da barra</span><span><i/>Equipamento</span><span><i className="f"/>Função (pessoas)</span><span><i className="t"/>Material</span><span>◂ ▸ começa ou termina fora do período · detalhe na folha {pages.length+1}</span></div>
   <div className="foot"><span>Folha {p+1} de {sheets} · {rows.length} recurso(s) · {allocCount} alocação(ões)</span><span>Horários de Brasília · NAUTILUS</span></div>
  </section>)}
  {detail.map((list,q)=><section key={'d'+q} className="page">
   <div className="mini"><span><b>Detalhe das alocações · {range}</b>{kindsLabel}</span><span>Folha {pages.length+q+1} de {sheets}</span></div>
   <div className="dtab">
    <div className="dh"><span>Recurso</span><span>OS · atividade</span><span>Etapa</span><span>Período</span><span>Duração</span><span>Quantidade</span></div>
    {list.map((x,i)=>x.g?<div key={'g'+i} className="dr g"><span>{RES_KINDS.find(k=>k.id===x.row.kind)!.one}: {x.row.label}{x.cont?' (continuação)':''} · {x.row.items.length} alocação(ões)</span></div>
     :<div key={i} className="dr" style={{['--c' as string]:COLOR[x.row.kind]} as CSSProperties}>
      <span><b>{x.row.label}</b></span><span><b>OS {os(x.it.number)}</b><span className="mut">{x.it.activity}</span></span><span>{x.it.step||<span className="mut">—</span>}</span>
      <span>{when(x.it.a,x.it.b)}</span><span>{dur(x.it.a,x.it.b)}</span><span>{what(x.row,x.it)||<span className="mut">1 equipamento</span>}</span></div>)}
   </div>
   <div className="foot"><span>Folha {pages.length+q+1} de {sheets}</span><span>Horários de Brasília · NAUTILUS</span></div>
  </section>)}
 </main>;
}
