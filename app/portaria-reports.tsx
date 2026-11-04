'use client';
// Portaria · histórico de relatórios e revisões, e o painel de indicadores.
import {Fragment,useCallback,useEffect,useState} from 'react';
import {Printer,LockOpen,FileClock,AlertTriangle,ChevronDown,ChevronRight} from 'lucide-react';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Choice,Badge,Empty,Field,fromLocalInput,type R} from './kit';
import {pget,query,day,dmyhm,todayLocal,KIND_NAMES,printUrl,DAY_KEY,ReopenDialog,LoadError} from './portaria-kit';

function Revisions({reportId,status,onReopen}:{reportId:string,status:string,onReopen:()=>void}){
 const [rows,setRows]=useState<R[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{pget<R>('report/versions?reportId='+reportId).then(r=>setRows(r.versions),e=>setError((e as Error).message))},[reportId,status]);
 if(error)return <p className="form-error" role="alert">{error}</p>;
 if(!rows)return <Skeleton className="h-16 rounded-lg"/>;
 return <div className="por-revs">
  {rows.length?<ul className="por-list">{rows.map((v,i)=><li key={v.id}><b>Revisão {v.number}</b><Badge tone={v.kind==='original'?'success':'info'}>{KIND_NAMES[v.kind]}</Badge>
   <span>emitida {dmyhm(v.issuedAt)} por {v.issuedByName}{v.closedWithPresent?` · fechada com ${v.closedWithPresent} na base`:''}{v.reason?` · motivo: ${v.reason}`:''}</span>
   <Button size="sm" variant="outline" onClick={()=>window.open(printUrl({id:v.id}),'_blank','noopener')}><Printer size={14}/> Imprimir{i===0?' (mais recente)':''}</Button></li>)}</ul>
   :<p className="muted-text">Nenhuma revisão emitida ainda: o relatório continua aberto.</p>}
  <div className="step-actions">
   {status==='aberto'&&<Button size="sm" variant="outline" onClick={()=>window.open(printUrl({reportId}),'_blank','noopener')}><Printer size={14}/> Imprimir parcial</Button>}
   {status==='fechado'&&<Button size="sm" onClick={onReopen}><LockOpen size={14}/> Reabrir</Button>}
  </div></div>;
}

export function PortariaRelatorios({refreshKey,manager,onOpenDay}:{refreshKey?:number,manager:boolean,onOpenDay:()=>void}){
 const [filters,setFilters]=useState<R>({from:'',to:'',status:'',pending:false}),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(''),[reopen,setReopen]=useState<R|null>(null);
 const refresh=useCallback(async()=>{try{setData(await pget<R>('reports?'+query({...filters,limit:60})));setError('')}catch(e){setError((e as Error).message)}},[filters]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 if(error&&!data)return <LoadError title="Relatórios indisponíveis" message={error}/>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 const rows=data.rows as R[];
 const goto=(d:string)=>{try{sessionStorage.setItem(DAY_KEY,d)}catch{/* segue sem lembrar a data */}onOpenDay()};
 return <div className="por-screen">
  <section className="n-panel por-filters"><div className="form-grid">
   <Field label="De"><Input type="date" value={filters.from} onChange={e=>setFilters(f=>({...f,from:e.target.value}))}/></Field>
   <Field label="Até"><Input type="date" value={filters.to} onChange={e=>setFilters(f=>({...f,to:e.target.value}))}/></Field>
   <Field label="Situação"><Choice value={filters.status||'all'} onChange={v=>setFilters(f=>({...f,status:v==='all'?'':v}))} options={[{value:'all',label:'Todas'},{value:'aberto',label:'Abertos'},{value:'fechado',label:'Fechados'}]}/></Field>
   <Field label="Pendências"><label className="inline-check"><input type="checkbox" checked={filters.pending} onChange={e=>setFilters(f=>({...f,pending:e.target.checked}))}/> Só com movimento posterior ou aberto de dia anterior</label></Field>
  </div></section>
  <section className="n-panel"><div className="panel-heading"><div><h2>Relatórios diários</h2><p>Um relatório por dia. Cada fechamento gera uma revisão que não muda; reabrir e fechar de novo gera a revisão seguinte. {manager?'':'Documentos completos aparecem na impressão.'}</p></div></div>
   {rows.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th/><th>Data</th><th>Situação</th><th>Entradas</th><th>Saídas</th><th>Revisões</th><th>Alertas</th><th/></tr></thead><tbody>
    {rows.map(r=><Fragment key={r.id}>
     <tr className={`clickable${open===r.id?' current':''}`} onClick={()=>setOpen(open===r.id?'':r.id)}><td><button type="button" className="por-link" aria-expanded={open===r.id} aria-label={`Revisões do relatório de ${day(r.date)}`} onClick={e=>{e.stopPropagation();setOpen(open===r.id?'':r.id)}}>{open===r.id?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</button></td><td><b>{day(r.date)}</b></td>
      <td>{r.status==='fechado'?<Badge tone="success">Fechado{r.closedAt?` · ${dmyhm(r.closedAt)}`:''}</Badge>:<Badge tone="info">Aberto{r.reopenKind?' (reaberto)':''}</Badge>}</td><td>{r.entradas}</td><td>{r.saidas}</td><td>{r.revisions||'—'}</td>
      <td>{r.pendingAfterClose>0&&<Badge tone="warning">{r.pendingAfterClose} movimento(s) após o fechamento</Badge>}{r.staleOpen&&<Badge tone="warning">Aberto de dia anterior</Badge>}</td>
      <td><Button size="sm" variant="ghost" onClick={e=>{e.stopPropagation();goto(r.date)}}>Abrir o dia</Button></td></tr>
     {open===r.id&&<tr className="fin-detail"><td/><td colSpan={7}><Revisions reportId={r.id} status={r.status} onReopen={()=>setReopen({id:r.id,date:r.date})}/></td></tr>}
    </Fragment>)}
   </tbody></table></div>:<Empty icon={FileClock} title="Nenhum relatório" description="O relatório do dia nasce na primeira movimentação ou ao abrir o dia."/>}
   {data.hasMore&&<p className="muted-text">Mostrando os 60 mais recentes. Use o período para ver os mais antigos.</p>}
  </section>
  <ReopenDialog report={reopen as {id:string,date:string}|null} onClose={()=>setReopen(null)} onDone={()=>{setReopen(null);void refresh()}}/>
 </div>;
}

const GRANULARITY=[{value:'day',label:'Por dia'},{value:'month',label:'Por mês'},{value:'year',label:'Por ano'}];
const bucketLabel=(b:string,g:string)=>g==='year'?b.slice(0,4):g==='month'?b.slice(5,7)+'/'+b.slice(0,4):b.slice(8,10)+'/'+b.slice(5,7);

/** Indicadores: entradas × saídas × pessoas únicas, calculados dos registros válidos (anuladas ficam de fora). */
export function PortariaPainel({refreshKey}:{refreshKey?:number}){
 const [f,setF]=useState<R>({from:'',to:'',granularity:'day',company:'',at:''}),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[companies,setCompanies]=useState<R[]>([]);
 const refresh=useCallback(async()=>{
  try{setData(await pget<R>('dashboard?'+query({from:f.from,to:f.to,granularity:f.granularity,company:f.company,at:f.at?fromLocalInput(f.at)||'':''})));setError('')}catch(e){setError((e as Error).message)}
 },[f]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 useEffect(()=>{pget<R>('companies?all=1').then(r=>setCompanies((r.rows as R[]).filter(c=>!String(c.id).startsWith('org:'))),()=>{})},[]);
 if(error&&!data)return <LoadError title="Indicadores indisponíveis" message={error}/>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 const t=data.totals as R,series=data.series as R[],max=Math.max(1,...series.flatMap(s=>[s.entries,s.exits])),g=data.granularity as string;
 const by=data.byCompany as R[],maxBy=Math.max(1,...by.map(c=>c.entries));
 return <div className="por-screen">
  <section className="n-panel por-filters"><div className="form-grid">
   <Field label="De"><Input type="date" max={todayLocal()} value={f.from||data.period.from} onChange={e=>setF(x=>({...x,from:e.target.value}))}/></Field>
   <Field label="Até"><Input type="date" max={todayLocal()} value={f.to||data.period.to} onChange={e=>setF(x=>({...x,to:e.target.value}))}/></Field>
   <Field label="Agrupar"><Choice value={f.granularity} onChange={v=>setF(x=>({...x,granularity:v}))} options={GRANULARITY}/></Field>
   <Field label="Empresa"><Choice value={f.company||'all'} onChange={v=>setF(x=>({...x,company:v==='all'?'':v}))} options={[{value:'all',label:'Todas'},...companies.map(c=>({value:c.id,label:c.name}))]}/></Field>
  </div>{error&&<p className="form-error" role="alert"><AlertTriangle size={14}/> {error}</p>}</section>
  <div className="por-kpis"><div><span>Entradas</span><b>{t.entries}</b></div><div><span>Saídas</span><b>{t.exits}</b></div><div><span>Pessoas únicas</span><b>{t.uniquePeople}</b><small>no período todo</small></div><div className={t.presentNow?'warn':''}><span>Na base agora</span><b>{t.presentNow}</b></div></div>
  <section className="n-panel"><div className="panel-heading"><div><h2>Movimento por {g==='day'?'dia':g==='month'?'mês':'ano'}</h2><p>{day(data.period.from)} a {day(data.period.to)} · fuso {data.timezone}. Entradas contam por data de entrada; saídas, por data de saída.</p></div></div>
   {series.length?<><div className="por-legend"><span><i/>Entradas</span><span><i className="out"/>Saídas</span></div>
    <div className="por-chart" role="img" aria-label="Entradas e saídas por período">{series.map(s=><div key={s.bucket} title={`${bucketLabel(s.bucket,g)}: ${s.entries} entrada(s), ${s.exits} saída(s), ${s.people} pessoa(s) única(s)`}>
     <i style={{height:`${(s.entries/max)*100}%`}}/><i className="out" style={{height:`${(s.exits/max)*100}%`}}/></div>)}</div>
    <div className="table-scroll"><table className="eu-table"><thead><tr><th>Período</th><th>Entradas</th><th>Saídas</th><th>Pessoas únicas</th></tr></thead><tbody>
     {series.slice().reverse().map(s=><tr key={s.bucket}><td>{bucketLabel(s.bucket,g)}</td><td>{s.entries}</td><td>{s.exits}</td><td>{s.people}</td></tr>)}</tbody></table></div></>
    :<Empty icon={FileClock} title="Sem movimento no período" description="Nenhuma entrada ou saída válida nas datas escolhidas."/>}
  </section>
  <section className="n-panel"><div className="panel-heading"><div><h2>Por empresa</h2><p>Empresa registrada na própria visita (mudar o cadastro depois não reescreve o passado). {data.notes.uniquePeople}</p></div></div>
   {by.length?<div className="por-bars">{by.map(c=><div className="por-bar" key={c.companyId||c.name}><span title={c.name}>{c.name}</span><i style={{width:`${(c.entries/maxBy)*100}%`}}/><b>{c.entries} entr. · {c.uniquePeople} pess.</b></div>)}</div>
    :<p className="muted-text">Sem entradas no período.</p>}
  </section>
  <section className="n-panel"><div className="panel-heading"><div><h2>Presença em um instante</h2><p>Quantas pessoas estavam na base num momento do passado (inclui visitas iniciadas antes do período).</p></div></div>
   <div className="form-grid"><Field label="Data e hora"><Input type="datetime-local" value={f.at} onChange={e=>setF(x=>({...x,at:e.target.value}))}/></Field>
    <Field label="Resultado">{data.presentAt?<b className="por-big">{data.presentAt.count} pessoa(s) na base</b>:<span className="muted-text">Escolha um horário.</span>}</Field></div></section>
  <p className="muted-text">Atualizado {dmyhm(data.generatedAt)}. {data.notes.source}</p>
 </div>;
}
