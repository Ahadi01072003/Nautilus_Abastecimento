// Agenda de OS para imprimir ou salvar em PDF (A4 paisagem). Cabeçalho com o resumo para o gestor
// (quantidades, solicitantes, horas, recursos e alertas) e o cronograma: cada linha é uma OS inteira
// (eixo vertical) e as datas do período ficam no eixo horizontal. Sempre a mesma quantidade de OS por folha.
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
// Espaço útil das linhas (mm): 1ª folha com o resumo completo; as demais com cabeçalho curto.
const AVAIL_FIRST=82,AVAIL_NEXT=146,ROW_MIN=7,ROW_MAX=14;
// Largura da coluna de identificação da OS e da área de datas (A4 paisagem, 277 mm úteis).
const LABEL_W=74,TIME_W=277-LABEL_W;
const f=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const dmy=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric'});
const wd=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,weekday:'short'});
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const num=(n:number,d=0)=>n.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d});
const hours=(h:number)=>h>=10?`${num(h)} h`:`${num(h,1)} h`;
const STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída'};

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
.gantt{flex:1;min-height:0;display:flex;flex-direction:column;border:.3mm solid #9fb0ad;position:relative}
.gh{display:grid;grid-template-columns:${LABEL_W}mm 1fr;border-bottom:.4mm solid #9fb0ad;background:#eef1f0}
.gh .lbl{font:700 6.4pt/1 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#4b5f66;padding:0 2.4mm;display:flex;align-items:center;border-right:.3mm solid #9fb0ad}
.days{position:relative;height:8.4mm}
.days span{position:absolute;top:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;border-left:.2mm solid #d3dbd9;font:600 5.8pt/1.15 var(--f-mono);color:#4b5f66;text-transform:uppercase;overflow:hidden}
.days span b{font:800 7.6pt/1.1 var(--f-mono);color:#0b1d25;text-transform:none}
.days span.we{background:#e2e8e6}.days span.mo{border-left:.5mm solid #4b5f66}.days span.today{background:#0b1d25;color:#fff}.days span.today b{color:#c8f25a}.days span.todayh b{box-shadow:inset 0 -.6mm 0 #d92d20}
.hours{position:absolute;left:0;right:0;bottom:0;height:3mm}
.hours i{position:absolute;bottom:0;font:500 5.4pt/1 var(--f-mono);font-style:normal;color:#6c7c82;translate:-50% 0}
/* Sempre ${PER_PAGE} linhas por folha, dividindo a altura toda: a moldura do cronograma vai até o rodapé mesmo com poucas OS. */
.orow{display:grid;grid-template-columns:${LABEL_W}mm 1fr;border-bottom:.3mm solid #c7d0ce;overflow:hidden;flex:1 1 0;min-height:0}
.orow.blank .oinfo{border-left:0;padding:0}
.orow:last-of-type{border-bottom:0}
.orow:nth-child(even){background:#f7f9f8}
.oinfo{display:flex;flex-direction:column;justify-content:center;gap:.3mm;padding:0 2.4mm 0 3mm;border-right:.3mm solid #9fb0ad;border-left:1.4mm solid var(--c);overflow:hidden;min-width:0}
.oinfo .l1{display:flex;justify-content:space-between;gap:2mm;font:700 6.4pt/1.15 var(--f-mono);color:#0b1d25;white-space:nowrap}
.oinfo .l1 span{font-weight:500;color:#33474e;overflow:hidden;text-overflow:ellipsis}
.oinfo .l1 b{flex:none}.oinfo .l1 .sc{display:inline-block;margin-left:1mm;padding:.2mm .8mm;border:.2mm solid #9fb0ad;border-radius:.5mm;background:#fff;font:700 6pt/1 var(--f-mono);color:#0b1d25}
.oinfo .l1 .sc.none{font-weight:500;color:#6c7c82;border-style:dashed}
.oinfo .l2{font:700 7.8pt/1.15 var(--f-body);color:#0b1d25;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--lines);overflow:hidden;overflow-wrap:anywhere}
.oinfo .l3{font:500 6.3pt/1.2 var(--f-body);color:#33474e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.otime{position:relative;background-image:var(--grid)}
.otime .we{position:absolute;top:0;bottom:0;background:rgba(75,95,102,.07)}
.otime .now{position:absolute;top:0;bottom:0;width:.5mm;background:#d92d20;translate:-50% 0;z-index:3}
.bar{position:absolute;top:22%;bottom:22%;box-sizing:border-box;border:.3mm solid var(--line);border-left:1.2mm solid var(--c);background:var(--bg);border-radius:.8mm;display:flex;align-items:center;padding:0 1.2mm;overflow:hidden;z-index:2;font:600 6.2pt/1 var(--f-mono);color:#0b1d25;white-space:nowrap}
.bar.done{background:repeating-linear-gradient(135deg,#fff 0 1.2mm,#eef1f0 1.2mm 2.4mm);border-left-style:double}
.bar.live{box-shadow:inset 0 0 0 .35mm var(--c)}
.bar.contl{border-top-left-radius:0;border-bottom-left-radius:0;border-left-style:dashed}
.bar.contr{border-top-right-radius:0;border-bottom-right-radius:0;border-right:.6mm dashed var(--c)}
.empty{position:absolute;left:${LABEL_W}mm;right:0;top:45%;margin:0;text-align:center;color:#4b5f66;font-size:10pt;z-index:4}
.legend{display:flex;flex-wrap:wrap;gap:4mm;font-size:6.8pt;color:#4b5f66;align-items:center}
.legend i{display:inline-block;width:6mm;height:2.6mm;margin-right:1.2mm;vertical-align:-.4mm;border:.3mm solid #6c7c82;border-left:1.2mm solid #0b1d25;background:#fff}
.legend i.t{width:.5mm;border:0;background:#d92d20}
.legend i.d{background:repeating-linear-gradient(135deg,#fff 0 1mm,#e5eae8 1mm 2mm);border-left-style:double}
.legend i.l{box-shadow:inset 0 0 0 .3mm #0b1d25}
.legend i.c{border-right:.6mm dashed #0b1d25;border-left-style:dashed}
.foot{display:flex;justify-content:space-between;gap:4mm;font:500 6.6pt/1.2 var(--f-mono);letter-spacing:.06em;color:#6c7c82}
@media print{html,body{background:#fff!important}.noprint{display:none}.page{margin:0;box-shadow:none;break-after:page}.page:last-child{break-after:auto}@page{size:A4 landscape;margin:0}}
`;

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
 // Eixo horizontal: os dias do período (com horas quando o período é curto).
 const days=r.period.days,span=t1-t0,colW=TIME_W/days;
 const pct=(t:number)=>Math.max(0,Math.min(100,(t-t0)/span*100));
 const dayList=Array.from({length:days},(_,i)=>t0+i*DAY);
 const wdNum=(t:number)=>new Date(t).getUTCDay(); // t0 é 00:00 de Brasília (03:00 UTC): mesmo dia
 const hourStep=days<=1?2:days<=3?6:days<=7?12:0;
 const hourTicks=hourStep?dayList.flatMap(d=>Array.from({length:24/hourStep-1},(_,k)=>d+(k+1)*hourStep*H)):[];
 const now=Date.parse(r.generatedAt),nowIn=now>=t0&&now<t1; // momento da emissão (gerado no servidor)
 const grid=`repeating-linear-gradient(90deg,#d8dfdd 0 .2mm,transparent .2mm ${100/days}%)`;
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
   // Altura estimada da linha (a 1ª folha tem o resumo completo): decide quanto texto cabe no bloco.
   const row=Math.max(ROW_MIN,Math.min(ROW_MAX,(p===0?AVAIL_FIRST:AVAIL_NEXT)/PER_PAGE));
   const lines=row>=10?2:1,meta=row>=(lines===2?13.5:10.5);
   const first=p*PER_PAGE+1,last=p*PER_PAGE+list.length;
   return <section key={p} className="page">
    {p===0?header:<div className="mini"><span><b>Agenda de OS · {range}</b>{r.sector?`Setor ${r.sector.code}`:'Todos os setores'}</span><span>Folha {p+1} de {pages.length}</span></div>}
    <div className="gantt">
     <div className="gh"><div className="lbl">OS · atividade</div>
      <div className="days">{dayList.map((d,i)=>{const w=wdNum(d),m=new Date(d+OFF).getUTCDate()===1;
       return <span key={d} className={[w===0||w===6?'we':'',m&&i>0?'mo':'',nowIn&&now>=d&&now<d+DAY?(hourStep?'todayh':'today'):''].filter(Boolean).join(' ')} style={{left:`${i/days*100}%`,width:`${100/days}%`,justifyContent:hourStep?'flex-start':'center',paddingTop:hourStep?'.8mm':0}}>
        {colW>=7?wd.format(d+OFF).replace('.',''):wd.format(d+OFF).slice(0,1)}<b>{colW>=9?dm.format(d+OFF):new Date(d+OFF).getUTCDate()}</b></span>;})}
       {hourStep>0&&<div className="hours">{hourTicks.map(t=><i key={t} style={{left:`${pct(t)}%`}}>{String(new Date(t-OFF).getUTCHours()).padStart(2,'0')}h</i>)}</div>}</div></div>
     {list.map(o=>{const s0=Date.parse(o.planned_start),e0=Date.parse(o.planned_end),l=pct(s0),wPct=Math.max(.6,pct(e0)-l),wMm=wPct*TIME_W/100;
      const contL=s0<t0,contR=e0>t1,live=['em_andamento','encerramento_pendente'].includes(o.status);
      const sameDay=dm.format(s0)===dm.format(e0);
      const when=sameDay?`${dm.format(s0)} ${hm.format(s0)}–${hm.format(e0)}`:`${dm.format(s0)} ${hm.format(s0)} → ${dm.format(e0)} ${hm.format(e0)}`;
      // Texto da barra: OS de vários dias leva a data no início e no fim (nunca "09:00–09:00").
      const barText=(mm:number)=>{const a=contL?'◂ ':'',b=contR?' ▸':'';
       if(sameDay)return mm>=17?`${a}${hm.format(s0)}–${hm.format(e0)}${b}`:mm>=9?hm.format(s0):'';
       return mm>=36?`${a}${dm.format(s0)} ${hm.format(s0)} → ${dm.format(e0)} ${hm.format(e0)}${b}`:mm>=26?`${a}${hm.format(s0)} → ${dm.format(e0)} ${hm.format(e0)}${b}`:mm>=14?`${a}${dm.format(s0)} ${hm.format(s0)}`:'';};
      const eq=(o.equipment as Row[]).map(e=>e.tag).join(', ');
      const info=[o.org_acronym,o.location_name,eq,(o.people as string[]).length?`${(o.people as string[]).length} pessoa(s)`:''].filter(Boolean).join(' · ');
      const cls=['bar',o.status==='concluida'?'done':'',live?'live':'',contL?'contl':'',contR?'contr':''].filter(Boolean).join(' ');
      const vars={['--c' as string]:o.org_color,['--bg' as string]:`color-mix(in srgb,${o.org_color} 16%,#fff)`,['--line' as string]:`color-mix(in srgb,${o.org_color} 50%,#fff)`,['--lines' as string]:lines} as CSSProperties;
      return <div key={o.id} className="orow" style={vars}>
       <div className="oinfo" title={`${osNumber(o.number)} · ${o.activity_name} · ${STATUS[o.status]||o.status}`}>
        <div className="l1"><b>{osNumber(o.number)}{o.sector_code?<span className="sc" title={o.sector_name||undefined}>{o.sector_code}</span>:<span className="sc none">sem setor</span>}{o.origin==='realizada'?' · R':''}{o.status==='concluida'?' ✓':live?' ●':''}</b><span>{when}</span></div>
        <div className="l2">{o.activity_name}</div>
        {meta&&<div className="l3">{info}</div>}
       </div>
       <div className="otime" style={{['--grid' as string]:grid} as CSSProperties}>
        {dayList.filter(d=>{const w=wdNum(d);return w===0||w===6;}).map(d=><i key={d} className="we" style={{left:`${pct(d)}%`,width:`${100/days}%`}}/>)}
        <div className={cls} style={{left:`${l}%`,width:`${wPct}%`}}>{barText(wMm)}</div>
        {nowIn&&<i className="now" style={{left:`${pct(now)}%`}}/>}
       </div>
      </div>;})}
     {Array.from({length:PER_PAGE-list.length},(_,i)=><div key={'blank'+i} className="orow blank" aria-hidden="true">
      <div className="oinfo"/>
      <div className="otime" style={{['--grid' as string]:grid} as CSSProperties}>
       {dayList.filter(d=>{const w=wdNum(d);return w===0||w===6;}).map(d=><i key={d} className="we" style={{left:`${pct(d)}%`,width:`${100/days}%`}}/>)}
       {nowIn&&<i className="now" style={{left:`${pct(now)}%`}}/>}
      </div>
     </div>)}
     {!list.length&&<p className="empty">Nenhuma OS programada {r.sector?`para o setor ${r.sector.code} `:''}entre {range}.</p>}
    </div>
    <div className="legend"><span>Cor = solicitante · barra = período planejado da OS inteira</span><span><i/>Programada</span><span><i className="l"/>● Em andamento</span><span><i className="d"/>✓ Concluída</span><span><i className="c"/>◂ ▸ Começa ou termina fora do período</span><span><i className="t"/>Hoje</span><span>R = realizada sem planejamento</span></div>
    <div className="foot"><span>Folha {p+1} de {pages.length} · {list.length?`OS ${first}–${last} de ${totalLabel(sum.total)}`:'sem OS'} · {PER_PAGE} OS por folha</span><span>Horários de Brasília · NAUTILUS</span></div>
   </section>;})}
 </main>;
}
