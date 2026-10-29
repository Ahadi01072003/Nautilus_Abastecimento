// Relatório da OS para imprimir ou salvar em PDF (pelo navegador). Mesmo alcance da tela da OS:
// orderDetail confere a sessão, a capacidade e o escopo de organizações.
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {orderReport,ORDER_STATUS} from '@/lib/reports';
import {osNumber} from '@/lib/planning';
import {db,type Row} from '@/lib/db';
import {audit} from '@/lib/registry';
import {rateLimit} from '@/lib/security';
import {AppError} from '@/lib/domain';
import PrintButton from './print';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Relatório da OS · NAUTILUS',robots:{index:false,follow:false}};

const TZ='America/Sao_Paulo',H=3600_000,MIN=60000;
const f=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
const dm=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit'});
const dt=(v:unknown)=>v?f.format(new Date(String(v))).replace(',',''):'—';
const ms=(v:unknown)=>Date.parse(String(v));
const dur=(x:number)=>{const m=Math.max(0,Math.floor(x/MIN));return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};
const dev=(x:number|null)=>x===null?'—':Math.abs(x)<MIN?'no horário':`${x>0?'+':'−'}${dur(Math.abs(x))}`;
/** Início e fim, sempre com data e hora (em OS de vários dias o fim não pode virar só a hora). */
const range=(a:unknown,b:unknown)=>a?<><span className="nw">{dt(a)} →</span> <span className="nw">{b?dt(b):'em curso'}</span></>:'—';
const STEP:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada',cancelada:'Cancelada'};
const KIND:Record<string,string>={ocorrencia:'Ocorrência',impacto:'Impacto',bloqueio:'Bloqueio'};
const EVENT:Record<string,string>={inicio:'Início',bloqueio:'Bloqueio',pausa:'Pausa',retomada:'Retomada',termino:'Término',dispensa:'Dispensa',encerramento:'Encerramento',encerramento_pendente:'Encerramento pendente',nc_critica:'NC crítica',interrupcao_tecnica:'Interrupção técnica',cancelamento:'Cancelamento da OS'};
const MOMENT:Record<string,string>={pre_atividade:'Pré-atividade',pre_uso:'Pré-uso',durante:'Durante',pos_atividade:'Pós-atividade'};
const STOP_BLOCK=new Set(['bloqueio','nc_critica','interrupcao_tecnica']);

const css=`
html,body{background:#fff!important;color:#0b1d25}
body{font:13px/1.45 var(--f-body)}
.sheet{max-width:900px;margin:0 auto;padding:28px 28px 48px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rtop{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:3px solid #03161f;padding-bottom:14px}
.rtop img{width:132px;height:auto}
.rtop .id{text-align:right;font:600 11px/1.4 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#4b5f66}
.rtop .id b{display:block;font:800 26px/1 var(--f-display);letter-spacing:-.02em;color:#0b1d25;text-transform:none}
h1{font:850 30px/1.05 var(--f-display);font-variation-settings:"wdth" 112;letter-spacing:-.02em;margin:18px 0 4px}
h1 i{font-style:normal;color:#087f77}
.lead{color:#4b5f66;margin:0}
h2{font:700 11px/1.4 var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:#087f77;margin:22px 0 6px;break-after:avoid;break-inside:avoid}
.facts{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #c7d0ce;margin:14px 0 0}
.facts div{padding:8px 10px;border-right:1px solid #c7d0ce}.facts div:nth-child(4n){border-right:0}
.facts div:nth-child(n+5){border-top:1px solid #c7d0ce}
.facts dt{font:600 9.5px/1.2 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#6c7c82}.facts dd{margin:2px 0 0;font-weight:600}
.facts dd.big{font:800 20px/1.1 var(--f-mono);color:#087f77}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:6px 8px;border-bottom:1px solid #dde3e1;text-align:left;vertical-align:top}
tr{break-inside:avoid}
th{font:600 9.5px/1.2 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#4b5f66;background:#eef1f0}
td.n{text-align:right;font-family:var(--f-mono);white-space:nowrap}td small{display:block;color:#6c7c82}
td.late{color:#b42318}
.box{border:1px solid #c7d0ce;padding:10px 12px;white-space:pre-wrap;min-height:36px}
.ruler{border:1px solid #c7d0ce;padding:10px 12px 8px;break-inside:avoid}
.nw{white-space:nowrap}
.rg{display:grid;grid-template-columns:96px minmax(0,1fr)}
.rg .lab{display:grid;grid-template-rows:var(--sh) 26px 26px}
.rg .lab span{display:flex;align-items:center;font:600 10px/1 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#4b5f66;border-top:1px solid #dde3e1}
.rg .trk{position:relative;display:grid;grid-template-rows:var(--sh) 26px 26px;border-left:1px solid #c7d0ce}
.rg .band{position:absolute;top:0;bottom:0;background:#f1f4f3}
.rg .gl{position:absolute;top:var(--sh);bottom:0;width:1px;background:#e5eae8}
.rg .gl.day{top:0;width:0;background:none;border-left:1.5px solid #4b5f66;z-index:2}
.rscale{position:relative;font:500 9.5px/1 var(--f-mono);color:#4b5f66}
.rscale span{position:absolute;bottom:3px;translate:-50% 0;white-space:nowrap}
.rscale span.d{top:3px;bottom:auto;translate:0 0;padding-left:3px;font-weight:700;color:#0b1d25}
.rscale i{position:absolute;bottom:0;width:1px;height:4px;background:#9aa6aa}
.rlane{position:relative;border-top:1px solid #dde3e1}
.rlane b{position:absolute;top:6px;bottom:6px;border-radius:1px}
.rlane b.plan{top:4px;bottom:4px;box-sizing:border-box;border:1.5px solid #004a64;background:#e6eef1;border-radius:2px;display:flex;justify-content:space-between;align-items:center;overflow:hidden;z-index:1}
.rlane b.plan em{font:700 9px/1 var(--f-mono);font-style:normal;color:#004a64;padding:0 4px;white-space:nowrap}
.rlane b.work{background:#087f77}
.rlane b.pausa{background:repeating-linear-gradient(135deg,#9aa6aa 0 2px,#e5eae8 2px 5px);top:8px;bottom:8px}
.rlane b.bloqueio{background:repeating-linear-gradient(135deg,#d92d20 0 2px,#fde4e1 2px 5px);top:7px;bottom:7px}
.totals{display:flex;flex-wrap:wrap;gap:4px 22px;margin:8px 0 0;padding:7px 10px;border:1px solid #dde3e1;background:#f6f8f7}
.totals div{display:grid;gap:2px}
.totals dt{font:600 9px/1.2 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#6c7c82;display:flex;align-items:center;gap:5px}
.totals dt i{display:inline-block;width:14px;height:7px}
.totals dd{margin:0;font:700 12.5px/1.2 var(--f-mono)}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px;font-size:10.5px;color:#4b5f66}
.legend i{display:inline-block;width:16px;height:8px;margin-right:5px;vertical-align:middle}
.sign{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:52px;break-inside:avoid}.sign div{border-top:1px solid #0b1d25;padding-top:6px;font-size:11.5px;color:#4b5f66}
.foot{margin-top:28px;font:500 10px/1.4 var(--f-mono);letter-spacing:.08em;color:#6c7c82;display:flex;justify-content:space-between;gap:12px}
.noprint{position:fixed;right:20px;top:20px;background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(3,22,31,.18)}
@media (max-width:700px){.facts{grid-template-columns:1fr 1fr}.facts div:nth-child(2n){border-right:0}.facts div:nth-child(n+3){border-top:1px solid #c7d0ce}.rg{grid-template-columns:72px minmax(0,1fr)}.sign{grid-template-columns:1fr}.sheet{padding:20px 16px 40px}.tw{overflow-x:auto}}
@media print{.noprint{display:none}.sheet{padding:0;max-width:none}@page{margin:12mm}}
`;

export default async function Report({params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 let r:Awaited<ReturnType<typeof orderReport>>;
 // Mesmo limite das outras exportações; erros de negócio (404, 429) aparecem com a própria mensagem.
 try{await rateLimit(member.id,'export');r=await orderReport(member,id);}
 catch(e){if(!(e instanceof AppError))throw e;return <main className="sheet"><style>{css}</style><p>{e.message}</p></main>;}
 await db().tx(tx=>audit(tx,member,'Exportação: relatório da OS',r.order.id,{number:r.order.number}));
 const {data,order,plan,steps,org}=r,now=ms(r.now);
 const intervals=data.intervals as Row[],occurrences=(data.occurrences as Row[]).slice().reverse();
 const stepName=(sid:string|null)=>sid?steps.find(s=>s.id===sid)?.name||'—':'OS';
 const done=steps.filter(s=>['concluida','dispensada'].includes(s.status)).length;
 const stops=intervals.filter(i=>i.kind!=='ativo');

 // Régua impressa: mesma convenção da tela (planejado contornado em cima; trabalho sólido, pausa cinza
 // hachurada e bloqueio vermelho hachurado embaixo). Apontamentos ficam nos totais e na tabela, não na régua.
 // OS de vários dias: marcas de 6 em 6 horas, dias alternados sombreados e linha cheia na virada de dia.
 const starts=[ms(order.planned_start),...intervals.map(i=>ms(i.start_at)),...steps.filter(s=>s.planned_start).map(s=>ms(s.planned_start))];
 const ends=[ms(order.planned_end),...intervals.map(i=>i.end_at?ms(i.end_at):now),...steps.filter(s=>s.planned_end).map(s=>ms(s.planned_end))];
 const offset=3*H,TRACK=560;// largura aproximada da trilha na folha A4 (px)
 let ws=Math.min(...starts),we=Math.max(...ends);
 const multiDay=we-ws>20*H,pad=Math.max((we-ws)*.03,15*MIN);
 const step=multiDay?6*H:[.5,1,2,3,6].map(x=>x*H).find(x=>(we-ws+2*pad)/x<=9)||6*H;
 ws=Math.floor((ws-pad-offset)/step)*step+offset;we=Math.ceil((we+pad-offset)/step)*step+offset;
 const span=Math.max(H,we-ws),pct=(t:number)=>Math.max(0,Math.min(100,(t-ws)/span*100)),w=(a:number,b:number)=>Math.max(.4,pct(b)-pct(a));
 const px=TRACK/span,ticks:number[]=[];for(let t=ws;t<=we;t+=step)ticks.push(t);
 const days:number[]=[];for(let d=Math.floor((ws-offset)/(24*H))*24*H+offset;d<we;d+=24*H)days.push(d);
 const twoTier=multiDay||days.some(d=>d>ws);
 const dayEvery=Math.max(1,Math.ceil(44/(24*H*px)));
 const dayLabels=days.filter((d,i)=>i%dayEvery===0&&(i>0||d>=ws||days.length<=dayEvery||pct(days[dayEvery])*TRACK/100>=46));
 const hourLabels=step*px>=28;
 const label=(t:number)=>multiDay?`${String(new Date(t-offset).getUTCHours()).padStart(2,'0')}h`:hm.format(t);
 const ps=ms(order.planned_start),pe=ms(order.planned_end),planPx=w(ps,pe)*TRACK/100;
 const cross=dm.format(ps)!==dm.format(pe),at=(t:number)=>cross?`${dm.format(t)} ${hm.format(t)}`:hm.format(t);
 const stopKind=(i:Row)=>STOP_BLOCK.has(i.start_kind)?'bloqueio':'pausa';
 const spans=(list:Row[])=>list.map(i=>[ms(i.start_at),i.end_at?ms(i.end_at):now]);
 const union=(list:number[][])=>{let t=0,c:number[]|null=null;for(const x of list.filter(x=>x[1]>x[0]).sort((a,b)=>a[0]-b[0])){if(!c||x[0]>c[1]){if(c)t+=c[1]-c[0];c=[...x];}else c[1]=Math.max(c[1],x[1]);}return c?t+c[1]-c[0]:t;};
 const paused=union(spans(stops.filter(i=>stopKind(i)==='pausa'))),blocked=union(spans(stops.filter(i=>stopKind(i)==='bloqueio')));
 const impacted=union((data.occurrences as Row[]).filter(o=>o.kind==='impacto'&&o.impact_start).map(o=>[ms(o.impact_start),o.impact_end?ms(o.impact_end):now]));
 const sh=twoTier?30:20;

 return <main className="sheet"><style>{css}</style><PrintButton/>
  {/* eslint-disable-next-line @next/next/no-img-element -- Logo estático, mesmo arquivo na impressão. */}
  <div className="rtop"><img src="/logo-color.svg" alt="OceanPact LOG" width={240} height={118}/><div className="id">NAUTILUS · relatório de OS<b>{osNumber(order.number)}</b>{ORDER_STATUS[order.status]}</div></div>
  <h1>{order.activity_name}<i>.</i></h1>
  <p className="lead">{plan.free?`${order.activity_code?order.activity_code+' · ':''}OS sem fluxo`:`${order.activity_code} · fluxo v${plan.flow_version}`}{order.origin==='realizada'?' · realizada sem planejamento (registro posterior)':''} · lançada por {order.launched_by_name||'—'} em {dt(order.launched_at)}{order.revision?` · revisão ${order.revision}${plan.revision_reason?` (${plan.revision_reason})`:''}`:''}</p>
  <dl className="facts">
   <div><dt>Solicitante</dt><dd>{org?`${org.acronym} · ${org.name}`:'—'}</dd></div>
   <div><dt>Pessoa solicitante</dt><dd>{r.requester||'—'}</dd></div>
   <div><dt>Local</dt><dd>{r.location||'—'}</dd></div>
   <div><dt>Tempo efetivo</dt><dd className="big">{dur(r.effective)}</dd></div>
   <div><dt>Planejado</dt><dd>{range(order.planned_start,order.planned_end)}</dd></div>
   <div><dt>Real</dt><dd>{order.actual_start?range(order.actual_start,order.actual_end):'Não iniciada'}</dd></div>
   <div><dt>Etapas concluídas</dt><dd>{done} de {steps.length}</dd></div>
   <div><dt>Apontamentos</dt><dd>{occurrences.length} ({occurrences.filter(o=>o.blocking&&o.status==='aberto').length} bloqueios abertos)</dd></div>
  </dl>
  {plan.description&&<><h2>Descrição</h2><div className="box">{plan.description}</div></>}
  {order.cancel_reason&&<><h2>Cancelamento</h2><div className="box">{order.cancel_reason}</div></>}

  <h2>Régua da OS</h2>
  <div className="ruler">
   <div className="rg" style={{'--sh':sh+'px'} as React.CSSProperties}>
    <div className="lab"><i/><span>Planejado</span><span>Executado</span></div>
    <div className="trk">
     {multiDay&&days.map((d,i)=>i%2===1&&<span key={'b'+d} className="band" style={{left:pct(d)+'%',width:w(d,d+24*H)+'%'}}/>)}
     {ticks.filter(t=>!days.includes(t)).map(t=><span key={'g'+t} className="gl" style={{left:pct(t)+'%'}}/>)}
     {days.filter(d=>d>ws).map(d=><span key={'v'+d} className="gl day" style={{left:pct(d)+'%'}}/>)}
     <div className="rscale">{ticks.map(t=><i key={'i'+t} style={{left:pct(t)+'%'}}/>)}
      {twoTier&&dayLabels.map(d=><span key={'d'+d} className="d" style={{left:pct(d)+'%'}}>{dm.format(Math.max(d,ws)+H)}</span>)}
      {hourLabels&&ticks.filter((t,i)=>multiDay?i>0&&i<ticks.length-1&&!days.includes(t):i%Math.ceil(30/(step*px))===0&&i<ticks.length-1).map(t=><span key={'h'+t} style={{left:pct(t)+'%',translate:pct(t)===0?'0 0':undefined}}>{label(t)}</span>)}</div>
     <div className="rlane"><b className="plan" style={{left:pct(ps)+'%',width:w(ps,pe)+'%'}}>{planPx>=(cross?150:84)?<><em>{at(ps)}</em><em>{at(pe)}</em></>:planPx>=(cross?76:40)?<em>{at(ps)}</em>:null}</b></div>
     <div className="rlane">{intervals.map((i,n)=><b key={n} className={i.kind==='ativo'?'work':stopKind(i)} style={{left:pct(ms(i.start_at))+'%',width:w(ms(i.start_at),i.end_at?ms(i.end_at):now)+'%'}}/>)}</div>
    </div>
   </div>
   <dl className="totals">
    <div><dt>Planejado</dt><dd>{dm.format(ps)} {hm.format(ps)} → {dm.format(pe)} {hm.format(pe)}</dd></div>
    <div><dt>Executado</dt><dd>{order.actual_start?`${dm.format(ms(order.actual_start))} ${hm.format(ms(order.actual_start))} → ${order.actual_end?`${dm.format(ms(order.actual_end))} ${hm.format(ms(order.actual_end))}`:'em curso'}`:'Não iniciada'}</dd></div>
    <div><dt><i style={{background:'#087f77'}}/>Trabalho</dt><dd>{dur(r.effective)}</dd></div>
    <div><dt><i style={{background:'repeating-linear-gradient(135deg,#9aa6aa 0 2px,#e5eae8 2px 5px)'}}/>Pausa</dt><dd>{dur(paused)}</dd></div>
    <div><dt><i style={{background:'repeating-linear-gradient(135deg,#d92d20 0 2px,#fde4e1 2px 5px)'}}/>Bloqueio</dt><dd>{dur(blocked)}</dd></div>
    <div><dt><i style={{background:'repeating-linear-gradient(90deg,#f47a04 0 4px,transparent 4px 6px)'}}/>Impacto</dt><dd>{dur(impacted)}</dd></div>
    <div><dt>Apontamentos</dt><dd>{occurrences.length}</dd></div>
   </dl>
   <div className="legend"><span><i style={{background:'#e6eef1',border:'1.5px solid #004a64'}}/>Planejado (início e fim)</span><span><i style={{background:'#087f77'}}/>Trabalho</span><span><i style={{background:'repeating-linear-gradient(135deg,#9aa6aa 0 2px,#e5eae8 2px 5px)'}}/>Pausa</span><span><i style={{background:'repeating-linear-gradient(135deg,#d92d20 0 2px,#fde4e1 2px 5px)'}}/>Bloqueio</span>{twoTier&&<span><i style={{width:0,borderLeft:'1.5px solid #4b5f66',height:12}}/>Virada de dia</span>}</div>
  </div>

  <h2>Etapas</h2>
  <div className="tw"><table><thead><tr><th>#</th><th>Etapa</th><th>Situação</th><th>Planejado</th><th>Real</th><th className="n">Efetivo</th><th className="n">Parado</th><th className="n">Desvio início</th><th className="n">Desvio fim</th></tr></thead>
   <tbody>{steps.map(s=><tr key={s.id}><td>{s.position}</td><td>{s.name}<small>{[...s.equipment_ids.map(r.tag),...s.operator_ids.map(r.person)].join(' · ')||''}</small></td><td>{STEP[s.status]}</td><td>{range(s.planned_start,s.planned_end)}</td><td>{s.actual_start?range(s.actual_start,s.actual_end):'—'}</td>
    <td className="n">{dur(s.active)}</td><td className="n">{dur(s.stopped)}</td><td className={`n${(s.startDev||0)>=MIN?' late':''}`}>{dev(s.startDev)}</td><td className={`n${(s.endDev||0)>=MIN?' late':''}`}>{dev(s.endDev)}</td></tr>)}</tbody></table></div>

  <h2>Paradas</h2>
  <div className="tw"><table><thead><tr><th>Etapa</th><th>Motivo</th><th>Início</th><th>Fim</th><th className="n">Duração</th></tr></thead>
   <tbody>{stops.map((i,n)=><tr key={n}><td>{stepName(i.os_step_id)}</td><td>{EVENT[i.start_kind]||'Parada'}</td><td>{dt(i.start_at)}</td><td>{i.end_at?dt(i.end_at):'em aberto'}</td><td className="n">{dur((i.end_at?ms(i.end_at):now)-ms(i.start_at))}</td></tr>)}
   {!stops.length&&<tr><td colSpan={5}>Nenhuma parada registrada.</td></tr>}</tbody></table></div>

  <h2>Ocorrências, impactos e bloqueios</h2>
  <div className="tw"><table><thead><tr><th>Quando</th><th>Etapa</th><th>Tipo</th><th>Descrição</th><th>Situação</th></tr></thead>
   <tbody>{occurrences.map(o=><tr key={o.id}><td>{dt(o.occurred_at)}<small>{o.author_name}</small></td><td>{stepName(o.os_step_id)}</td><td>{KIND[o.kind]}{o.blocking?' · bloqueia':''}<small>{o.category_name||''}{o.severity?` · ${o.severity}`:''}</small></td>
    <td>{o.description}{o.impact_start&&<small>Impacto {dt(o.impact_start)} → {o.impact_end?dt(o.impact_end):'em aberto'}</small>}</td><td>{o.status==='resolvido'?'Resolvido':'Aberto'}{o.resolution&&<small>{o.resolution} · {o.resolved_by_name}</small>}</td></tr>)}
   {!occurrences.length&&<tr><td colSpan={5}>Nenhum apontamento.</td></tr>}</tbody></table></div>

  <h2>Checklists</h2>
  <div className="tw"><table><thead><tr><th>Checklist</th><th>Momento</th><th>Equipamento</th><th>Situação</th><th className="n">Respostas</th><th className="n">NC</th><th>Concluído</th></tr></thead>
   <tbody>{(data.instances as Row[]).map(i=><tr key={i.id}><td>{i.code} · {i.title}<small>v{i.version}</small></td><td>{MOMENT[i.moment]}</td><td>{i.equipment_id?r.tag(i.equipment_id):'—'}</td><td>{i.status==='concluido'?'Concluído':'Em preenchimento'}</td><td className="n">{i.answers.length}</td><td className={`n${i.answers.some((a:Row)=>a.answer==='NC')?' late':''}`}>{i.answers.filter((a:Row)=>a.answer==='NC').length}</td><td>{i.completed_at?<>{dt(i.completed_at)}<small>{i.completed_by_name}</small></>:'—'}</td></tr>)}
   {!(data.instances as Row[]).length&&<tr><td colSpan={7}>Nenhum checklist preenchido.</td></tr>}</tbody></table></div>

  <h2>Histórico da execução</h2>
  <div className="tw"><table><thead><tr><th>Quando</th><th>Evento</th><th>Etapa</th><th>Autor</th><th>Detalhe</th></tr></thead>
   <tbody>{(data.events as Row[]).slice().reverse().map(e=><tr key={e.id}><td>{dt(e.occurred_at)}</td><td>{EVENT[e.kind]||e.kind}</td><td>{stepName(e.os_step_id)}</td><td>{e.author_name}</td><td>{e.detail?.reason||e.detail?.resolution||''}</td></tr>)}
   {!(data.events as Row[]).length&&<tr><td colSpan={5}>Sem eventos.</td></tr>}</tbody></table></div>

  <div className="sign"><div>Responsável pela execução</div><div>Planejamento · {order.launched_by_name||''}</div><div>Solicitante · {r.requester||org?.acronym||''}</div></div>
  <div className="foot"><span>Emitido em {dt(r.now)} por {member.name}</span><span>Horários de Brasília · NAUTILUS</span></div>
 </main>;
}
