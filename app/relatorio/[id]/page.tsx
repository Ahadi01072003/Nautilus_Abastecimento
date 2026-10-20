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
const range=(a:unknown,b:unknown)=>a?`${dt(a)} → ${b?dt(b).slice(-5):'…'}`:'—';
const STEP:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada'};
const KIND:Record<string,string>={ocorrencia:'Ocorrência',impacto:'Impacto',bloqueio:'Bloqueio'};
const EVENT:Record<string,string>={inicio:'Início',bloqueio:'Bloqueio',pausa:'Pausa',retomada:'Retomada',termino:'Término',dispensa:'Dispensa',encerramento:'Encerramento',encerramento_pendente:'Encerramento pendente',nc_critica:'NC crítica',interrupcao_tecnica:'Interrupção técnica'};
const MOMENT:Record<string,string>={pre_atividade:'Pré-atividade',pre_uso:'Pré-uso',durante:'Durante',pos_atividade:'Pós-atividade'};
const STOP_BLOCK=new Set(['bloqueio','nc_critica','interrupcao_tecnica']);

const css=`
html,body{background:#fff!important;color:#0b1d25}
body{font:13px/1.45 var(--f-body)}
.sheet{max-width:900px;margin:0 auto;padding:28px 28px 48px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rtop{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:3px solid #03161f;padding-bottom:14px}
.rtop img{width:170px;height:auto}
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
.rrow{display:grid;grid-template-columns:150px 1fr;align-items:center;min-height:22px}
.rrow>span{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:8px}
.rrow.os>span{font-family:var(--f-mono);letter-spacing:.08em}
.rlane{position:relative;height:14px;background:repeating-linear-gradient(90deg,transparent 0 calc(var(--t) - 1px),#e5eae8 calc(var(--t) - 1px) var(--t))}
.rrow.os .rlane{height:18px}
.rlane b{position:absolute;top:2px;bottom:2px;border-radius:1px}
.rlane b.plan{top:0;bottom:0;border:1.5px dashed #6c7c82;background:transparent}
.rlane b.work{background:#087f77}
.rlane b.pausa{background:repeating-linear-gradient(135deg,#9aa6aa 0 2px,#e5eae8 2px 5px)}
.rlane b.bloqueio{background:repeating-linear-gradient(135deg,#d92d20 0 2px,#fde4e1 2px 5px)}
.rlane b.occ{width:2px;top:-2px;bottom:-2px;background:#d92d20}
.rlane b.imp{top:auto;bottom:0;height:3px;background:repeating-linear-gradient(90deg,#f47a04 0 4px,transparent 4px 6px)}
.rscale{position:relative;height:16px;margin-left:150px;font:500 9.5px/16px var(--f-mono);color:#6c7c82}
.rscale span{position:absolute;translate:-50% 0;white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px;font-size:10.5px;color:#4b5f66}
.legend i{display:inline-block;width:16px;height:8px;margin-right:5px;vertical-align:middle}
.sign{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:52px;break-inside:avoid}.sign div{border-top:1px solid #0b1d25;padding-top:6px;font-size:11.5px;color:#4b5f66}
.foot{margin-top:28px;font:500 10px/1.4 var(--f-mono);letter-spacing:.08em;color:#6c7c82;display:flex;justify-content:space-between;gap:12px}
.noprint{position:fixed;right:20px;top:20px;background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(3,22,31,.18)}
@media (max-width:700px){.facts{grid-template-columns:1fr 1fr}.facts div:nth-child(2n){border-right:0}.facts div:nth-child(n+3){border-top:1px solid #c7d0ce}.rrow{grid-template-columns:96px 1fr}.rscale{margin-left:96px}.sign{grid-template-columns:1fr}.sheet{padding:20px 16px 40px}.tw{overflow-x:auto}}
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

 // Régua impressa: mesma convenção da tela (trabalho sólido, pausa cinza hachurada, bloqueio vermelho hachurado, planejado tracejado).
 const starts=[ms(order.planned_start),...intervals.map(i=>ms(i.start_at)),...steps.filter(s=>s.planned_start).map(s=>ms(s.planned_start))];
 const ends=[ms(order.planned_end),...intervals.map(i=>i.end_at?ms(i.end_at):now),...steps.filter(s=>s.planned_end).map(s=>ms(s.planned_end))];
 const step=[1,2,3,6,12,24,48,96,192].map(x=>x*H).find(x=>(Math.max(...ends)-Math.min(...starts))/x<=8)||384*H;
 const offset=3*H,ws=Math.floor((Math.min(...starts)-offset)/step)*step+offset,we=Math.ceil((Math.max(...ends)-offset)/step)*step+offset,span=Math.max(H,we-ws);
 const pct=(t:number)=>Math.max(0,Math.min(100,(t-ws)/span*100)),w=(a:number,b:number)=>Math.max(.4,pct(b)-pct(a));
 const ticks:number[]=[];for(let t=ws;t<=we;t+=step)ticks.push(t);
 const label=(t:number)=>step>=24*H?dm.format(t):new Date(t-offset).getUTCHours()===0||t===ws?`${dm.format(t)} ${hm.format(t)}`:hm.format(t);
 const bars=(iv:Row[],oc:Row[],a?:unknown,b?:unknown)=><>
  {a&&b?<b className="plan" style={{left:pct(ms(a))+'%',width:w(ms(a),ms(b))+'%'}}/>:null}
  {iv.map((i,n)=><b key={n} className={i.kind==='ativo'?'work':STOP_BLOCK.has(i.start_kind)?'bloqueio':'pausa'} style={{left:pct(ms(i.start_at))+'%',width:w(ms(i.start_at),i.end_at?ms(i.end_at):now)+'%'}}/>)}
  {oc.map(o=>o.kind==='impacto'&&o.impact_start?<b key={o.id} className="imp" style={{left:pct(ms(o.impact_start))+'%',width:w(ms(o.impact_start),o.impact_end?ms(o.impact_end):ms(o.impact_start)+15*MIN)+'%'}}/>:<b key={o.id} className="occ" style={{left:pct(ms(o.occurred_at))+'%'}}/>)}
 </>;

 return <main className="sheet"><style>{css}</style><PrintButton/>
  {/* eslint-disable-next-line @next/next/no-img-element -- Logo estático, mesmo arquivo na impressão. */}
  <div className="rtop"><img src="/logo-color.png" alt="OceanPact | CBO" width={285} height={79}/><div className="id">NAUTILUS · relatório de OS<b>{osNumber(order.number)}</b>{ORDER_STATUS[order.status]}</div></div>
  <h1>{order.activity_name}<i>.</i></h1>
  <p className="lead">{order.activity_code} · fluxo v{plan.flow_version} · lançada por {order.launched_by_name||'—'} em {dt(order.launched_at)}</p>
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
  <div className="ruler" style={{'--t':`${100/Math.max(1,ticks.length-1)}%`} as React.CSSProperties}>
   <div className="rscale">{ticks.map((t,i)=><span key={t} style={{left:pct(t)+'%',translate:i===0?'0 0':i===ticks.length-1?'-100% 0':undefined}}>{label(t)}</span>)}</div>
   <div className="rrow os"><span>OS</span><div className="rlane">{bars(intervals,occurrences,order.planned_start,order.planned_end)}</div></div>
   {steps.map(s=><div key={s.id} className="rrow"><span title={s.name}>{s.position}. {s.name}</span><div className="rlane">{bars(intervals.filter(i=>i.os_step_id===s.id),occurrences.filter(o=>o.os_step_id===s.id),s.planned_start,s.planned_end)}</div></div>)}
   <div className="legend"><span><i style={{background:'#087f77'}}/>Trabalho</span><span><i style={{background:'repeating-linear-gradient(135deg,#9aa6aa 0 2px,#e5eae8 2px 5px)'}}/>Pausa</span><span><i style={{background:'repeating-linear-gradient(135deg,#d92d20 0 2px,#fde4e1 2px 5px)'}}/>Bloqueio</span><span><i style={{border:'1.5px dashed #6c7c82'}}/>Planejado</span><span><i style={{width:2,background:'#d92d20'}}/>Ocorrência</span><span><i style={{height:3,background:'#f47a04'}}/>Impacto</span></div>
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
    <td>{o.description}{o.impact_start&&<small>Impacto {dt(o.impact_start)} → {o.impact_end?dt(o.impact_end).slice(-5):'em aberto'}</small>}</td><td>{o.status==='resolvido'?'Resolvido':'Aberto'}{o.resolution&&<small>{o.resolution} · {o.resolved_by_name}</small>}</td></tr>)}
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
