'use client';
// Operação › Painel de OS: indicadores do turno e cada OS em andamento com a sua régua e o
// seu cronômetro (tempo efetivo). Pausar e retomar direto do cartão; o resto nos Apontamentos.
import {useCallback,useEffect,useState,type FormEvent} from 'react';
import {Pause,Play,ArrowRight,LoaderCircle} from 'lucide-react';
import {toast} from 'sonner';
import {OrgTag,post,load,type R} from './kit';
import {osLabel} from './planning';
import OsRuler,{effective,dur} from './os-ruler';

const hm=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
const dmhm=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const STEP:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada'};
const COLOR:Record<string,string>={em_andamento:'var(--live)',encerramento_pendente:'var(--imp)',programada:'var(--line)',concluida:'var(--ok)',cancelada:'var(--occ)'};
export const hms=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
/** Cada dígito que muda é remontado (chave nova) e roda a animação de entrada. */
export function Digits({value}:{value:string}){return <>{[...value].map((ch,i)=>ch===':'?<span key={i} className="sep">:</span>:<span key={i+'-'+ch} className="roll">{ch}</span>)}</>;}
export function Status({s}:{s:string}){return <span className={`st ${s}`}><i/>{STATUS[s]||STEP[s]||s}</span>;}

type Board={orders:R[];counts:Record<string,number>;canExecute:boolean;serverNow:string};
type Dash={kpis:R;byOrg:R[];byActivity:R[];serverNow:string};

export default function OpsBoard({onOpen,refreshKey}:{onOpen:(id:string)=>void;refreshKey:number}){
 const [dash,setDash]=useState<Dash|null>(null),[running,setRunning]=useState<Board|null>(null),[next,setNext]=useState<Board|null>(null),[error,setError]=useState('');
 const [offset,setOffset]=useState(0),[tick,setTick]=useState(()=>Date.now());
 const refresh=useCallback(async()=>{
  try{
   const [d,r,n]=await Promise.all([load<Dash>('ops/dashboard'),load<Board>('ops/board?group=andamento'),load<Board>('ops/board?group=programadas')]);
   setOffset(Date.parse(r.serverNow)-Date.now());setDash(d);setRunning(r);setNext(n);setError('');
  }catch(e){setError((e as Error).message);}
 },[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados vindos do servidor.
 useEffect(()=>{void refresh();},[refresh,refreshKey]);
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh();},30000);const c=setInterval(()=>setTick(Date.now()),1000);return ()=>{clearInterval(t);clearInterval(c);};},[refresh]);
 const now=tick+offset;
 if(error)return <div className="error-panel"><h2>Painel indisponível</h2><p>{error}</p></div>;
 if(!dash||!running||!next)return <div className="sn-empty">Carregando o painel…</div>;
 const k=dash.kpis;
 const kpis:[string,string|number,string,string][]=[
  ['Em andamento',k.running,'var(--live)',`${k.pending} em encerramento pendente`],
  ['Etapas em execução',k.active,'var(--accent-ink)','tempo efetivo correndo'],
  ['Etapas paradas',k.stopped,'var(--imp)','pausadas ou bloqueadas'],
  ['Bloqueios abertos',k.blocks,'var(--occ)','aguardando resolução'],
  ['Programadas hoje',k.today,'var(--muted-c)',k.late?`${k.late} com início atrasado`:'nenhum início atrasado'],
  ['Horas efetivas hoje',dur(k.hoursToday*1000),'var(--brand)',`${k.closed_today} OS concluída(s) hoje`],
 ];
 const upcoming=next.orders.slice(0,6);
 return <>
  <div className="sn-kpis">{kpis.map(([l,v,c,d])=><div key={l} className="sn-kpi"><span className="k"><i style={{background:c}}/>{l}</span><span className="v">{v}</span><span className="d">{d}</span></div>)}</div>
  <div className="sn-sechead"><h2>OS em andamento</h2><span className="eyebrow">régua e cronômetro de cada OS · passe o mouse na régua para ver as etapas</span></div>
  <div className="sn-board">
   {running.orders.map(o=><OrderCard key={o.id} o={o} now={now} canExecute={running.canExecute} onOpen={onOpen} onChanged={refresh}/>)}
   {!running.orders.length&&<p className="sn-empty">Nenhuma OS em andamento no seu alcance.</p>}
  </div>
  <div className="sn-sechead"><h2>Próximas programadas</h2><span className="eyebrow">{next.counts.programadas} programada(s)</span></div>
  <div className="sn-board">
   {upcoming.map(o=><OrderCard key={o.id} o={o} now={now} canExecute={false} onOpen={onOpen} onChanged={refresh}/>)}
   {!upcoming.length&&<p className="sn-empty">Nenhuma OS programada.</p>}
  </div>
  <div className="sn-cols">
   <div><div className="sn-sechead"><h2>OS por solicitante</h2><span className="eyebrow">início planejado nos últimos 30 dias</span></div><ByOrg rows={dash.byOrg}/></div>
   <div><div className="sn-sechead"><h2>Horas efetivas por atividade</h2><span className="eyebrow">últimos 7 dias</span></div><ByActivity rows={dash.byActivity}/></div>
  </div>
 </>;
}

function OrderCard({o,now,canExecute,onOpen,onChanged}:{o:R;now:number;canExecute:boolean;onOpen:(id:string)=>void;onChanged:()=>Promise<void>}){
 const [pausing,setPausing]=useState<R|null>(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const steps=o.steps as R[],eff=effective(o.intervals,now);
 const active=steps.filter(s=>s.status==='em_execucao'),paused=steps.filter(s=>s.status==='pausada'),blocked=steps.filter(s=>s.status==='bloqueada');
 const pe=Date.parse(o.planned_end),ps=Date.parse(o.planned_start);
 const live=o.status==='em_andamento';
 async function run(path:string,body:R,msg:string){setBusy(true);try{const r=await post(path,{operationKey:crypto.randomUUID(),...body});toast.success(r.message||msg);setPausing(null);setReason('');await onChanged();}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 function submit(e:FormEvent){e.preventDefault();if(pausing)void run('ops/pause',{stepId:pausing.id,reason},'Etapa pausada.');}
 const current=[...active,...blocked,...paused].map(s=>`${s.name} (${STEP[s.status].toLowerCase()})`).join(' · ');
 return <article className="sn-card" style={{['--c' as string]:COLOR[o.status]}}>
  <div className="head">
   <span className="num">{osLabel(o.number)} · {o.activity_code}</span>
   <h3>{o.activity_name}</h3>
   <div className="meta"><OrgTag org={{name:o.org_name,acronym:o.org_acronym,color:o.org_color}}/>{o.location_name&&<span>{o.location_name}</span>}<Status s={o.status}/>{blocked.length>0&&<span className="st bloqueada"><i/>{blocked.length} bloqueada(s)</span>}</div>
   {current&&<span className="meta">Agora: {current}</span>}
  </div>
  <div className="timer">
   <span className="sn-clock clock-roll" aria-label={`Tempo efetivo ${hms(eff)}`}><Digits value={hms(eff)}/></span>
   <small>{o.status==='programada'?(ps>now?`início em ${dur(ps-now)} · ${dmhm.format(ps)}`:`início atrasado ${dur(now-ps)}`):live?(pe>=now?`faltam ${dur(pe-now)} · fim ${hm.format(pe)}`:`prazo vencido há ${dur(now-pe)}`):'aguarda checklist para encerrar'}</small>
   <div className="acts">
    {canExecute&&active.length===1&&<button type="button" disabled={busy} onClick={()=>setPausing(active[0])}><Pause size={14}/>Pausar</button>}
    {canExecute&&!active.length&&paused.length===1&&<button type="button" className="go" disabled={busy} onClick={()=>void run('ops/resume',{stepId:paused[0].id},'Etapa retomada.')}>{busy?<LoaderCircle size={14} className="animate-spin"/>:<Play size={14}/>}Retomar</button>}
    <button type="button" onClick={()=>onOpen(o.id)}>Apontamentos<ArrowRight size={14}/></button>
   </div>
  </div>
  {pausing&&<form className="reason" onSubmit={submit}><span className="mono" style={{fontSize:12}}>Pausar “{pausing.name}”:</span><input autoFocus required maxLength={1200} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Motivo da pausa" aria-label="Motivo da pausa"/>
   <button type="submit" className="sn-btn go" disabled={busy||!reason.trim()}>Confirmar</button><button type="button" className="sn-btn" onClick={()=>setPausing(null)}>Voltar</button></form>}
  <div className="ruler-slot"><OsRuler compact order={o} steps={steps} intervals={o.intervals} occurrences={o.occurrences} now={now}/></div>
 </article>;
}

function ByOrg({rows}:{rows:R[]}){
 if(!rows.length)return <p className="sn-empty">Nenhuma OS nos últimos 30 dias.</p>;
 const parts=[['andamento','Em andamento','b-run','var(--live)'],['programadas','Programadas','b-open','var(--muted-c)'],['concluidas','Concluídas','b-done','var(--brand)'],['canceladas','Canceladas','b-cancel','var(--line)']] as const;
 const max=Math.max(...rows.map(r=>r.total)),W=640,L=120,R=36,row=30,T=6,H=T+rows.length*row+24,x=(v:number)=>L+v/max*(W-L-R);
 return <div style={{display:'grid',gap:10}}><div className="sn-chart"><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'OS por solicitante: '+rows.map(r=>`${r.acronym} ${r.total}`).join(', ')}>
  {[...new Set([0,Math.round(max/2),max])].map(t=><g key={t}><line className="grid" x1={x(t)} x2={x(t)} y1={T} y2={H-20}/><text x={x(t)} y={H-6} textAnchor="middle">{t}</text></g>)}
  {rows.map((r,i)=>{const y=T+i*row+6;let acc=0;return <g key={r.acronym}><title>{`${r.acronym} · ${r.name}: ${r.total} OS`}</title><text className="lbl" x={L-10} y={y+13} textAnchor="end">{r.acronym}</text>
   {parts.map(([k,,c])=>{const v=r[k];if(!v)return null;const x0=x(acc);acc+=v;return <rect key={k} className={c} x={x0} y={y} width={Math.max(1.5,x(acc)-x0-1)} height={18} rx={2}/>;})}
   <text className="val" x={x(r.total)+6} y={y+13}>{r.total}</text></g>;})}
 </svg></div><div className="legend">{parts.map(([k,l,,c])=><span key={k}><i style={{background:c}}/>{l}</span>)}</div></div>;
}
function ByActivity({rows}:{rows:R[]}){
 if(!rows.length)return <p className="sn-empty">Nenhum tempo efetivo nos últimos 7 dias.</p>;
 const max=Math.max(.5,...rows.map(r=>r.s/3600)),st=[.5,1,2,5,10,20,50,100].find(s=>max/s<=5)||200,top=Math.ceil(max/st)*st;
 const W=560,L=150,R=50,row=30,T=6,H=T+rows.length*row+24,x=(v:number)=>L+v/top*(W-L-R);
 return <div className="sn-chart"><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'Horas efetivas por atividade: '+rows.map(r=>`${r.label} ${(r.s/3600).toFixed(1)} h`).join(', ')}>
  {Array.from({length:Math.round(top/st)+1},(_,i)=>i*st).map(t=><g key={t}><line className="grid" x1={x(t)} x2={x(t)} y1={T} y2={H-20}/><text x={x(t)} y={H-6} textAnchor="middle">{String(t).replace('.',',')}h</text></g>)}
  {rows.map((r,i)=>{const y=T+i*row+6,v=r.s/3600;return <g key={r.label}><title>{`${r.label}: ${dur(r.s*1000)}`}</title><text className="lbl" x={L-10} y={y+13} textAnchor="end">{String(r.label).length>20?String(r.label).slice(0,19)+'…':r.label}</text>
   <rect className={i===0?'b-hot':'b-main'} x={L} y={y} width={Math.max(2,x(v)-L)} height={18} rx={2}/><text className="val" x={x(v)+6} y={y+13}>{v.toFixed(1).replace('.',',')}</text></g>;})}
 </svg></div>;
}
