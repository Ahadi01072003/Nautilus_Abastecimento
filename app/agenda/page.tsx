// Agenda de OS para imprimir ou salvar em PDF (A4 paisagem). Cabeçalho com o resumo para o gestor
// (quantidades, solicitantes, horas, recursos e alertas) e um Gantt por data: cada linha é um dia e
// cada bloco uma OS no seu horário. Sempre a mesma quantidade de OS por folha.
import type {Metadata} from 'next';
import type {CSSProperties} from 'react';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {agendaData} from '@/lib/agenda';
import {osNumber} from '@/lib/planning';
import {db,type Row} from '@/lib/db';
import {audit} from '@/lib/registry';
import {rateLimit} from '@/lib/security';
import {AppError} from '@/lib/domain';
import AgendaPrint from './print';
export const dynamic='force-dynamic';

type Search=Promise<Record<string,string|string[]|undefined>>;
const one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
const br=(iso:string)=>iso.split('-').reverse().join('/');
export async function generateMetadata({searchParams}:{searchParams:Search}):Promise<Metadata>{
 const s=await searchParams,a=one(s.inicio),b=one(s.fim),c=one(s.setor);
 // O título vira o nome sugerido do arquivo ao salvar como PDF.
 return {title:`Agenda de OS ${a?br(a):''}${b&&b!==a?' a '+br(b):''}${c?' · '+c:''} · NAUTILUS`,robots:{index:false,follow:false}};
}

const TZ='America/Sao_Paulo',H=3600_000,DAY=24*H,OFF=3*H;
const PER_PAGE=10;
// Espaço útil do Gantt (mm): 1ª folha com o resumo completo; as demais com cabeçalho curto.
const AVAIL_FIRST=84,AVAIL_NEXT=150,LANE_MIN=6,LANE_MAX=15;
const f=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const dmy=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric'});
const wd=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'short'});
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const num=(n:number,d=0)=>n.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d});
const hours=(h:number)=>h>=10?`${num(h)} h`:`${num(h,1)} h`;
const STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída'};
const dayOf=(t:number)=>Math.floor((t-OFF)/DAY)*DAY+OFF; // 00:00 de Brasília

type Seg={o:Row,day:number,s:number,e:number,contL:boolean,contR:boolean,lane:number};

const css=`
html,body{background:#dfe5e3!important;color:#0b1d25}
body{font:9pt/1.35 var(--f-body);margin:0}
.noprint{position:fixed;right:18px;top:18px;display:grid;gap:6px;justify-items:end;z-index:5}
.noprint button{background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(3,22,31,.18)}
.noprint small{font-size:11px;color:#4b5f66;background:#fff;padding:3px 6px;border-radius:3px}
.err{max-width:640px;margin:60px auto;background:#fff;padding:24px;border-radius:6px}
.page{width:297mm;height:210mm;box-sizing:border-box;padding:8mm 10mm 7mm;margin:10mm auto;background:#fff;box-shadow:0 6px 28px rgba(3,22,31,.16);display:flex;flex-direction:column;gap:3.2mm;overflow:hidden;position:relative;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top{display:grid;grid-template-columns:38mm 1fr auto;align-items:end;gap:6mm;border-bottom:.9mm solid #03161f;padding-bottom:2mm}
.top img{width:38mm;height:auto}
.top .eye{font:600 6.8pt/1.2 var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:#087f77}
.top h1{margin:.4mm 0 0;font:850 17pt/1 var(--f-display);font-variation-settings:"wdth" 112;letter-spacing:-.02em}
.top h1 i{font-style:normal;color:#087f77}
.top .sec{margin-top:.8mm;font-size:9pt;color:#4b5f66}.top .sec b{color:#0b1d25}
.top .meta{text-align:right;font:500 7pt/1.5 var(--f-mono);color:#4b5f66}
.mini{display:flex;justify-content:space-between;align-items:baseline;border-bottom:.6mm solid #03161f;padding-bottom:1.6mm;font:600 7.4pt/1.2 var(--f-mono);letter-spacing:.08em;text-transform:uppercase;color:#4b5f66}
.mini b{font:800 11pt/1 var(--f-display);letter-spacing:-.01em;text-transform:none;color:#0b1d25;margin-right:3mm}
.kpis{display:grid;grid-template-columns:1.25fr repeat(5,1fr);border:.3mm solid #c7d0ce}
.kpis div{padding:1.3mm 2.4mm;border-right:.3mm solid #c7d0ce}.kpis div:last-child{border-right:0}
.kpis dt{font:600 6.2pt/1.2 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#6c7c82}
.kpis dd{margin:.4mm 0 0;font:800 13pt/1 var(--f-mono);color:#0b1d25}.kpis dd small{font:500 7pt/1.3 var(--f-body);color:#4b5f66;display:block;margin-top:.6mm}
.kpis .lead dd{font-size:18pt;color:#087f77}
.cols{display:grid;grid-template-columns:1.15fr 1.25fr 1fr;gap:4mm;min-height:0}
.card{border:.3mm solid #c7d0ce;padding:1.6mm 2.4mm;min-width:0;overflow:hidden}
.card h2{margin:0 0 1.4mm;font:700 6.6pt/1.2 var(--f-mono);letter-spacing:.14em;text-transform:uppercase;color:#087f77}
.stack{display:flex;height:3.2mm;border-radius:.6mm;overflow:hidden;margin-bottom:1.6mm;border:.2mm solid #c7d0ce}
.stack i{display:block;height:100%}
.rows{display:grid;gap:.7mm;margin:0;padding:0;list-style:none}
.rows li{display:grid;grid-template-columns:auto 1fr auto;gap:2mm;align-items:center;font-size:7.2pt;line-height:1.25;min-width:0}
.rows li span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rows li b{font:700 7.6pt var(--f-mono)}
.sw{width:2.6mm;height:2.6mm;border-radius:.4mm;border:.2mm solid rgba(0,0,0,.25)}
.tag{font:700 6.8pt/1 var(--f-mono);padding:.6mm 1mm;border-radius:.5mm;background:#eef1f0;border:.2mm solid #c7d0ce;white-space:nowrap}
.res{display:grid;grid-template-columns:1fr 1fr;gap:3mm}
.alert li{grid-template-columns:auto 1fr;color:#7a2a12;align-items:start}.alert li span:last-child{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}.ok{font-size:7.6pt;color:#3f7d0e}
.muted{color:#6c7c82;font-size:7.4pt}
.gantt{flex:1;min-height:0;display:flex;flex-direction:column;border:.3mm solid #9fb0ad}
.gh{display:grid;grid-template-columns:24mm 1fr;border-bottom:.3mm solid #9fb0ad;background:#eef1f0}
.gh .lbl{font:700 6.4pt/1 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#4b5f66;padding:1.6mm 2mm}
.scale{position:relative;height:6mm}
.scale span{position:absolute;top:1.6mm;translate:-50% 0;font:600 6.6pt/1 var(--f-mono);color:#4b5f66}
.scale span.first{translate:0 0}.scale span.last{translate:-100% 0}
.drow{display:grid;grid-template-columns:24mm 1fr;border-bottom:.3mm solid #c7d0ce;break-inside:avoid;overflow:hidden}
.drow:last-child{border-bottom:0}
.drow:nth-child(even) .day,.drow:nth-child(even) .lanes{background:#f7f9f8}
.day{padding:0 2mm;border-right:.3mm solid #9fb0ad;display:flex;flex-direction:column;justify-content:center;overflow:hidden}
.day b{font:800 10pt/1 var(--f-display);letter-spacing:-.01em}.day span{font:600 5.8pt/1.25 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#6c7c82}
.day.tight{flex-direction:row;align-items:center;gap:1.5mm}.day.tight b{font-size:8.5pt}
.day em{font:italic 500 6pt/1.2 var(--f-body);color:#6c7c82;margin-top:.4mm}
.lanes{position:relative;background-image:var(--grid)}
.blk{position:absolute;box-sizing:border-box;padding:.7mm 1.3mm .7mm 1.9mm;border:.3mm solid var(--line);border-left:1.6mm solid var(--c);background:var(--bg);border-radius:.7mm;overflow:hidden;display:flex;flex-direction:column;gap:.25mm;min-width:0}
.blk.one{flex-direction:row;align-items:center;gap:1.5mm;padding-top:0;padding-bottom:0}.blk.one .bt{flex:none}.blk.one .bn{-webkit-line-clamp:1;font-size:7pt}
.blk .bt{display:flex;justify-content:space-between;gap:1.5mm;font:700 6.2pt/1.15 var(--f-mono);color:#0b1d25;white-space:nowrap;min-width:0}
.blk .bt span{font-weight:500;color:#33474e;overflow:hidden;text-overflow:ellipsis}
.blk .bn{font:700 7.6pt/1.15 var(--f-body);color:#0b1d25;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--lines);overflow:hidden;overflow-wrap:anywhere}
.blk .bm{font:500 6.3pt/1.2 var(--f-body);color:#33474e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blk.narrow .bt span,.blk.narrow .bm{display:none}.blk.narrow .bn{font-size:6.8pt}
.blk.done{background:repeating-linear-gradient(135deg,#fff 0 1.2mm,#f1f3f2 1.2mm 2.4mm);border-left-style:double}
.blk.live{border-style:solid;box-shadow:inset 0 0 0 .35mm var(--c)}
.blk.contl{border-top-left-radius:0;border-bottom-left-radius:0}
.blk.contr{border-top-right-radius:0;border-bottom-right-radius:0;border-right:.6mm dashed var(--c)}
.empty{padding:10mm;text-align:center;color:#4b5f66;font-size:10pt}
.legend{display:flex;flex-wrap:wrap;gap:4mm;font-size:6.8pt;color:#4b5f66;align-items:center}
.legend i{display:inline-block;width:6mm;height:2.6mm;margin-right:1.2mm;vertical-align:-.4mm;border:.3mm solid #6c7c82;border-left:1.2mm solid #0b1d25;background:#fff}
.legend i.d{background:repeating-linear-gradient(135deg,#fff 0 1mm,#e5eae8 1mm 2mm);border-left-style:double}
.legend i.l{box-shadow:inset 0 0 0 .3mm #0b1d25}
.legend i.c{border-right:.6mm dashed #0b1d25}
.foot{display:flex;justify-content:space-between;gap:4mm;font:500 6.6pt/1.2 var(--f-mono);letter-spacing:.06em;color:#6c7c82}
@media print{html,body{background:#fff!important}.noprint{display:none}.page{margin:0;box-shadow:none;break-after:page}.page:last-child{break-after:auto}@page{size:A4 landscape;margin:0}}
`;

/** Faixa de horas comum a todas as folhas (mínimo de 8 h, alinhada a horas cheias). */
function window_(segs:Seg[]){
 if(!segs.length)return {h0:6,h1:18};
 let h0=24,h1=0;
 for(const g of segs){h0=Math.min(h0,Math.floor((g.s-g.day)/H));h1=Math.max(h1,Math.ceil((g.e-g.day)/H));}
 h0=Math.max(0,h0);h1=Math.min(24,Math.max(h1,h0+1));
 while(h1-h0<8){if(h0>0)h0--;if(h1-h0<8&&h1<24)h1++;}
 return {h0,h1};
}
/** Uma OS vira um trecho por dia dentro do período (OS de vários dias aparecem em cada dia). */
function segments(o:Row,t0:number,t1:number){
 const s=Math.max(Date.parse(o.planned_start),t0),e=Math.min(Date.parse(o.planned_end),t1),out:Seg[]=[];
 for(let d=dayOf(s);d<e;d+=DAY){const a=Math.max(s,d),b=Math.min(e,d+DAY);if(b>a)out.push({o,day:d,s:a,e:b,contL:Date.parse(o.planned_start)<d,contR:Date.parse(o.planned_end)>d+DAY,lane:0});}
 return out;
}
/** Faixas por dia: cada OS na primeira faixa livre (sem sobrepor blocos). */
function lanes(segs:Seg[]){
 const days=new Map<number,Seg[]>();
 for(const g of segs.sort((x,y)=>x.s-y.s||y.e-x.e||x.o.number-y.o.number)){const l=days.get(g.day)||[];l.push(g);days.set(g.day,l);}
 const rows:{day:number,segs:Seg[],lanes:number}[]=[];
 for(const [day,list] of [...days.entries()].sort((x,y)=>x[0]-y[0])){
  const ends:number[]=[];
  for(const g of list){let i=ends.findIndex(e=>e<=g.s);if(i<0){i=ends.length;ends.push(0);}ends[i]=g.e;g.lane=i;}
  rows.push({day,segs:list,lanes:Math.max(1,ends.length)});
 }
 return rows;
}

export default async function Agenda({searchParams}:{searchParams:Search}){
 const s=await searchParams;
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 let r:Awaited<ReturnType<typeof agendaData>>;
 try{await rateLimit(member.id,'export');r=await agendaData(member,{from:one(s.inicio),to:one(s.fim),sector:one(s.setor)});}
 catch(e){if(!(e instanceof AppError))throw e;return <main><style>{css}</style><div className="err"><h1>Agenda indisponível</h1><p>{e.message}</p></div></main>;}
 await db().tx(tx=>audit(tx,member,'Exportação: agenda de OS',`agenda:${one(s.inicio)}:${one(s.fim)}:${one(s.setor)||'todos'}`,{from:one(s.inicio),to:one(s.fim),sector:one(s.setor)||null,orders:r.orders.length}));
 const t0=Date.parse(r.period.from),t1=Date.parse(r.period.to),sum=r.summary;
 const pages:Row[][]=[];for(let i=0;i<r.orders.length;i+=PER_PAGE)pages.push(r.orders.slice(i,i+PER_PAGE));
 if(!pages.length)pages.push([]);
 const all=r.orders.flatMap(o=>segments(o,t0,t1));
 const {h0,h1}=window_(all),span=(h1-h0)*H;
 const step=h1-h0<=14?1:2;
 const ticks:number[]=[];for(let h=h0;h<=h1;h+=step)ticks.push(h);
 const pct=(day:number,t:number)=>Math.max(0,Math.min(100,(t-day-h0*H)/span*100));
 const grid=`repeating-linear-gradient(90deg,transparent 0 calc(${100/((h1-h0)/step)}% - .3mm),#e3e8e6 calc(${100/((h1-h0)/step)}% - .3mm) ${100/((h1-h0)/step)}%)`;
 const range=`${dmy.format(t0)}${r.period.days>1?' a '+dmy.format(t1-1):''}`;
 const sectorLabel=r.sector?<><b>Setor {r.sector.code}</b> · {r.sector.name}</>:<b>Todos os setores</b>;
 const issued=`Emitida em ${f.format(new Date(r.generatedAt)).replace(',','')} por ${member.name}`;
 const totalLabel=(n:number)=>`${n} OS`;
 const st=sum.byStatus as Record<string,number>;
 const orgTotal=Math.max(1,sum.total);

 const header=<>
  <div className="top">
   {/* eslint-disable-next-line @next/next/no-img-element -- Logo estático, mesmo arquivo na impressão. */}
   <img src="/logo-color.png" alt="OceanPact | CBO" width={285} height={79}/>
   <div><div className="eye">NAUTILUS · agenda de OS programadas</div><h1>{range}<i>.</i></h1><div className="sec">{sectorLabel} · {r.period.days} dia(s) · horários de Brasília</div></div>
   <div className="meta">{issued}<br/>{sum.realized?`${sum.realized} realizada(s) sem planejamento incluída(s)`:'Somente OS lançadas (sem canceladas)'}</div>
  </div>
  <dl className="kpis">
   <div className="lead"><dt>Total de OS</dt><dd>{sum.total}<small>{st.programada||0} programada(s) · {(st.em_andamento||0)+(st.encerramento_pendente||0)} em andamento · {st.concluida||0} concluída(s)</small></dd></div>
   <div><dt>Horas planejadas</dt><dd>{hours(sum.hours)}<small>no período da agenda</small></dd></div>
   <div><dt>Solicitantes</dt><dd>{sum.orgs.length}<small>{sum.orgs[0]?`maior: ${sum.orgs[0].acronym} (${sum.orgs[0].count})`:'—'}</small></dd></div>
   <div><dt>Equipamentos</dt><dd>{sum.equipment.length}<small>reservados nas OS</small></dd></div>
   <div><dt>Pessoas alocadas</dt><dd>{sum.people}<small>colaboradores distintos</small></dd></div>
   <div><dt>Dia mais cheio</dt><dd>{sum.busiest?br(sum.busiest.day).slice(0,5):'—'}<small>{sum.busiest?`${sum.busiest.count} OS · ${sum.days} dia(s) com OS`:'sem OS'}</small></dd></div>
  </dl>
  <div className="cols">
   <section className="card"><h2>OS por solicitante</h2>
    <div className="stack">{sum.orgs.map((o:Row)=><i key={o.acronym} style={{width:`${o.count/orgTotal*100}%`,background:o.color}}/>)}</div>
    <ul className="rows">{sum.orgs.slice(0,5).map((o:Row)=><li key={o.acronym}><i className="sw" style={{background:o.color}}/><span><b>{o.acronym}</b> · {o.name}</span><b>{o.count} · {num(o.count/orgTotal*100)}% · {hours(o.hours)}</b></li>)}
     {sum.orgs.length>5&&<li><i/><span className="muted">+ {sum.orgs.length-5} solicitante(s)</span><i/></li>}{!sum.orgs.length&&<li><i/><span className="muted">Nenhuma OS no período.</span><i/></li>}</ul>
   </section>
   <section className="card"><h2>Recursos</h2>
    <div className="res">
     <ul className="rows">{sum.equipment.slice(0,6).map((e:Row)=><li key={e.tag} title={e.type||''}><span className="tag">{e.tag}</span><span/><b>{e.count} OS · {hours(e.hours)}</b></li>)}
      {sum.equipment.length>6&&<li><i/><span className="muted">+ {sum.equipment.length-6} equipamento(s)</span><i/></li>}{!sum.equipment.length&&<li><i/><span className="muted">Nenhum equipamento reservado.</span><i/></li>}</ul>
     <ul className="rows">{sum.materials.slice(0,6).map((m:Row)=><li key={m.name+m.unit}><i/><span>{m.name}</span><b>{num(m.amount,m.amount%1?1:0)} {m.unit}</b></li>)}
      {sum.materials.length>6&&<li><i/><span className="muted">+ {sum.materials.length-6} material(is)</span><i/></li>}{!sum.materials.length&&<li><i/><span className="muted">Nenhum material previsto.</span><i/></li>}</ul>
    </div>
   </section>
   <section className="card"><h2>Atenção</h2>
    {sum.alerts.length?<ul className="rows alert">{sum.alerts.slice(0,4).map((a:Row,i:number)=><li key={i}><span className="tag">{a.tag}</span><span>{a.text}</span></li>)}{sum.alerts.length>4&&<li><i/><span className="muted">+ {sum.alerts.length-4} alerta(s)</span></li>}</ul>
     :<p className="ok">Nenhum equipamento da agenda bloqueado ou com preventiva vencida.</p>}
    {r.truncated&&<p className="muted">A agenda foi limitada a 600 OS: reduza o período.</p>}
   </section>
  </div>
 </>;

 return <main><style>{css}</style><AgendaPrint auto={one(s.imprimir)==='1'}/>
  {pages.map((list,p)=>{
   const rows=lanes(list.flatMap(o=>segments(o,t0,t1)));
   const totalLanes=rows.reduce((n,x)=>n+x.lanes,0)||1;
   // Altura da faixa conforme o espaço da folha (a 1ª tem o cabeçalho completo).
   const lane=Math.max(LANE_MIN,Math.min(LANE_MAX,(p===0?AVAIL_FIRST:AVAIL_NEXT)/totalLanes));
   // Linhas que cabem no bloco (mm): cabeçalho 2,5; cada linha de título 3,1; local e recursos 2,7.
   // Pouco espaço: uma linha só (número e título); depois título em 1 ou 2 linhas e, sobrando, os recursos.
   const inner=lane-2.1,one=inner<5.8,lines=inner>=8.4?2:1,meta=!one&&inner>=2.5+3.1*lines+2.7;
   const first=p*PER_PAGE+1,last=p*PER_PAGE+list.length;
   return <section key={p} className="page">
    {p===0?header:<div className="mini"><span><b>Agenda de OS · {range}</b>{r.sector?`Setor ${r.sector.code}`:'Todos os setores'}</span><span>Folha {p+1} de {pages.length}</span></div>}
    <div className="gantt">
     <div className="gh"><div className="lbl">Data</div><div className="scale">{ticks.map((h,i)=><span key={h} className={i===0?'first':i===ticks.length-1?'last':''} style={{left:`${(h-h0)/(h1-h0)*100}%`}}>{String(h).padStart(2,'0')}h</span>)}</div></div>
     {rows.map(row=><div key={row.day} className="drow">
      <div className={`day${row.lanes*lane<10?' tight':''}`}><span>{wd.format(row.day+OFF).replace('.','')}</span><b>{dm.format(row.day+OFF)}</b>{p>0&&pages[p-1].some(o=>segments(o,t0,t1).some(g=>g.day===row.day))&&<em>continuação</em>}</div>
      <div className="lanes" style={{height:`${row.lanes*lane}mm`,['--grid' as string]:grid} as CSSProperties}>
       {row.segs.map(g=>{const o=g.o,l=pct(g.day,g.s),w=Math.max(1.2,pct(g.day,g.e)-l),narrow=w<11;
        const cls=['blk',one?'one':'',o.status==='concluida'?'done':'',['em_andamento','encerramento_pendente'].includes(o.status)?'live':'',g.contL?'contl':'',g.contR?'contr':'',narrow?'narrow':''].filter(Boolean).join(' ');
        const eq=(o.equipment as Row[]).map(e=>e.tag).join(', ');
        const info=[o.org_acronym,o.location_name,eq,(o.people as string[]).length?`${(o.people as string[]).length} pessoa(s)`:''].filter(Boolean).join(' · ');
        return <div key={o.id+':'+g.day} className={cls} title={`${osNumber(o.number)} · ${o.activity_name} · ${STATUS[o.status]||o.status}`}
         style={{left:`${l}%`,width:`calc(${w}% - .6mm)`,top:`${g.lane*lane+.35}mm`,height:`${lane-.7}mm`,['--c' as string]:o.org_color,['--bg' as string]:`color-mix(in srgb,${o.org_color} 13%,#fff)`,['--line' as string]:`color-mix(in srgb,${o.org_color} 45%,#fff)`,['--lines' as string]:lines} as CSSProperties}>
         <div className="bt"><b>{g.contL?'◂ ':''}{osNumber(o.number).replace('OS ','')}{o.origin==='realizada'?' · R':''}{o.status==='concluida'?' ✓':['em_andamento','encerramento_pendente'].includes(o.status)?' ●':''}</b><span>{hm.format(Date.parse(o.planned_start))}–{hm.format(Date.parse(o.planned_end))}{g.contR?' ▸':''}{o.sector_code?` · ${o.sector_code}`:''}</span></div>
         <div className="bn">{o.activity_name}</div>
         {meta&&<div className="bm">{info}</div>}
        </div>;})}
      </div>
     </div>)}
     {!rows.length&&<p className="empty">Nenhuma OS programada {r.sector?`para o setor ${r.sector.code} `:''}entre {range}.</p>}
    </div>
    <div className="legend"><span>Cor do bloco = solicitante</span><span><i/>Programada</span><span><i className="l"/>● Em andamento</span><span><i className="d"/>✓ Concluída</span><span><i className="c"/>◂ ▸ Continua em outro dia</span><span>R = realizada sem planejamento</span></div>
    <div className="foot"><span>Folha {p+1} de {pages.length} · {list.length?`OS ${first}–${last} de ${totalLabel(sum.total)}`:'sem OS'} · {PER_PAGE} OS por folha</span><span>Horários de Brasília · NAUTILUS</span></div>
   </section>;})}
 </main>;
}
