'use client';
// Operação › Apontamentos: lista das OS (Em andamento, Programadas, Concluídas, Todas) ao lado da
// execução da OS escolhida. A OS aberta fica na URL (?os=) para recarregar e voltar sem perder a tela.
import {useCallback,useEffect,useState} from 'react';
import {Search,ClipboardList} from 'lucide-react';
import {Skeleton} from '@/components/ui/skeleton';
import {Empty,load,type R} from './kit';
import {osLabel} from './planning';
import {Status} from './ops-board';
import OrderExecution from './execution';

const TILES=[['andamento','Em andamento','iniciadas','var(--live)'],['programadas','Programadas','ainda não iniciadas','var(--brand)'],['concluidas','Concluídas','encerradas','var(--ok)'],['todas','Todas','inclui canceladas','var(--ink)']] as const;
type Group=typeof TILES[number][0];
const readOs=()=>new URLSearchParams(location.search).get('os');

export default function Apontamentos({refreshKey}:{refreshKey:number}){
 const [group,setGroup]=useState<Group>('andamento'),[q,setQ]=useState(''),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[osId,setOsId]=useState<string|null>(null);
 const refresh=useCallback(async()=>{try{setData(await load<R>(`ops/board?group=${group}${q.trim()?'&q='+encodeURIComponent(q.trim()):''}`));setError('')}catch(e){setError((e as Error).message)}},[group,q]);
 // Lista vinda do servidor, com busca adiada para não consultar a cada tecla.
 useEffect(()=>{const t=setTimeout(()=>void refresh(),q?250:0);return()=>clearTimeout(t)},[refresh,refreshKey,q]);
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh()},45000);return()=>clearInterval(t)},[refresh]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- OS aberta lida da URL depois de montar.
 useEffect(()=>{setOsId(readOs());const back=()=>setOsId(readOs());window.addEventListener('popstate',back);return()=>window.removeEventListener('popstate',back)},[]);
 const open=(id:string)=>{if(id===osId)return;setOsId(id);const u=new URLSearchParams(location.search);u.set('os',id);history.pushState(null,'','/?'+u.toString());if(window.innerWidth<1080)window.scrollTo({top:0})};
 // Sem OS escolhida: abre a primeira da lista (a de maior prioridade no grupo).
 const current=osId||data?.orders[0]?.id||null;
 return <div className="ap">
  <aside className="ap-list" aria-label="OS">
   <div className="stack"><h2>Atendimentos</h2>
   <div className="tiles" role="group" aria-label="Situação das OS">{TILES.map(([k,label,hint,c])=><button key={k} type="button" className="tile" aria-pressed={group===k} style={{'--c':c} as React.CSSProperties} onClick={()=>setGroup(k)}><b>{data?.counts[k]??'–'}</b><span>{label}</span><small>{hint}</small></button>)}</div>
   <label className="ap-search"><Search size={15} aria-hidden/><input type="search" placeholder="Nº, atividade ou solicitante" aria-label="Buscar OS" value={q} maxLength={60} onChange={e=>setQ(e.target.value)}/></label></div>
   {error?<p className="sn-empty" role="alert">{error}</p>:!data?<Skeleton className="h-64 rounded"/>:data.orders.length?<div className="mlist">
    {data.orders.map((o:R)=><button key={o.id} type="button" className="mitem" aria-current={o.id===current} onClick={()=>open(o.id)}><span className="id">{osLabel(o.number)} · {o.org_acronym}</span><span className="t">{o.activity_name}</span><span className="e">{[o.activity_code,o.location_name].filter(Boolean).join(' · ')||'—'}</span><Status s={o.status}/></button>)}
    {data.more&&<p className="sn-empty">Mostrando as 100 primeiras. Use a busca para encontrar outras.</p>}
   </div>:<p className="sn-empty">{q?'Nenhuma OS encontrada para a busca.':'Nenhuma OS neste grupo.'}</p>}
  </aside>
  {current?<OrderExecution key={current} orderId={current} onChanged={()=>void refresh()}/>:data&&<div className="ap-center"><Empty icon={ClipboardList} title="Escolha uma OS" description="As OS lançadas pelo Planejamento aparecem na lista. Selecione uma para registrar o andamento."/></div>}
 </div>;
}
