'use client';
// Painel central: resumo de cada módulo e a lista de avisos (rolável, filtrável por gravidade e
// módulo). Cada cartão e cada aviso levam à tela de origem. O conteúdo segue o acesso de quem vê.
import {useCallback,useEffect,useMemo,useState,ReactNode} from 'react';
import {AlertTriangle,AlertOctagon,Info,ArrowRight,Droplets,HardHat,CalendarRange,Wrench,CalendarClock,CheckCircle2} from 'lucide-react';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Badge,fmt,load,type R} from './kit';

const SEV:Record<string,[string,string,typeof AlertOctagon]>={critico:['Crítico','var(--occ)',AlertOctagon],atencao:['Atenção','var(--mwarn)',AlertTriangle],info:['Informativo','var(--evt)',Info]};
const MOD:Record<string,[string,typeof Droplets]>={abastecimento:['Abastecimento',Droplets],operacao:['Operação',HardHat],planejamento:['Planejamento',CalendarRange],manutencao:['Manutenção',Wrench]};
const osLabel=(n:number)=>'OS '+String(n).padStart(6,'0');
const dayBR=(d:string)=>d.split('-').reverse().join('/');
const num=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:1});

function Stat({label,value,tone,onClick}:{label:string,value:ReactNode,tone?:string,onClick?:()=>void}){
 return <button type="button" className="ce-stat" style={tone?{['--t' as string]:tone}:undefined} onClick={onClick} disabled={!onClick}><b>{value}</b><span>{label}</span></button>;
}
function Card({mod,children,action}:{mod:string,children:ReactNode,action?:ReactNode}){
 const [label,Icon]=MOD[mod];
 return <section className="ce-card"><header><span><Icon size={16}/>{label}</span>{action}</header>{children}</section>;
}

export default function Central({refreshKey,onGo}:{refreshKey:number,onGo:(view:string,os?:string)=>void}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[sev,setSev]=useState(''),[mod,setMod]=useState('');
 const refresh=useCallback(async()=>{try{setData(await load<R>('central'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Resumo calculado no servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh()},60000);return()=>clearInterval(t)},[refresh]);
 const alerts=useMemo(()=>(data?.alerts as R[]||[]).filter(a=>(!sev||a.severity===sev)&&(!mod||a.module===mod)),[data,sev,mod]);
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Painel central indisponível</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <div className="loading-grid"><Skeleton className="h-64 rounded-xl"/><Skeleton className="h-64 rounded-xl"/></div>;
 const s=data.sections,modules=Object.keys(MOD).filter(m=>(data.alerts as R[]).some(a=>a.module===m));
 const go=(view:string)=>()=>onGo(view);
 return <div className="ce">
  <div className="ce-sev" role="group" aria-label="Gravidade dos avisos">
   {Object.entries(SEV).map(([k,[label,color,Icon]])=><button key={k} type="button" aria-pressed={sev===k} style={{['--t' as string]:color}} onClick={()=>setSev(sev===k?'':k)}><Icon size={16}/><b>{data.counts[k]}</b><span>{label}</span></button>)}
   <span className="ce-updated">Atualizado {fmt(data.generatedAt)}</span>
  </div>
  <div className="ce-grid">
   <div className="ce-cards">
    {s.operacao&&<Card mod="operacao" action={<button className="text-action" onClick={go('op-painel')}>Painel de OS <ArrowRight size={13} className="inline"/></button>}>
     <div className="ce-stats"><Stat label="Em andamento" value={s.operacao.running} tone="var(--live)" onClick={go('op-painel')}/><Stat label="Programadas hoje" value={s.operacao.today} onClick={go('op-os')}/><Stat label="Início vencido" value={s.operacao.late} tone={s.operacao.late?'var(--mwarn)':undefined} onClick={go('op-os')}/><Stat label="Fora do planejado" value={s.operacao.overdue} tone={s.operacao.overdue?'var(--occ)':undefined} onClick={go('op-os')}/><Stat label="Com bloqueio" value={s.operacao.blocked} tone={s.operacao.blocked?'var(--occ)':undefined} onClick={go('op-os')}/><Stat label="Encerramento pendente" value={s.operacao.pending} onClick={go('op-os')}/></div>
    </Card>}
    {s.manutencao&&<Card mod="manutencao" action={<button className="text-action" onClick={go('man-painel')}>Preventivas <ArrowRight size={13} className="inline"/></button>}>
     <div className="ce-stats"><Stat label="Equipamentos com critério" value={s.manutencao.equipment} onClick={go('man-painel')}/><Stat label="Em dia" value={s.manutencao.emDia} tone="var(--ok)" onClick={go('man-painel')}/><Stat label="Pendentes" value={s.manutencao.pendentes} tone={s.manutencao.pendentes?'var(--mwarn)':undefined} onClick={go('man-painel')}/><Stat label="Atrasados" value={s.manutencao.atrasados} tone={s.manutencao.atrasados?'var(--occ)':undefined} onClick={go('man-painel')}/><Stat label="Equipamentos bloqueados" value={s.manutencao.blocked} tone={s.manutencao.blocked?'var(--occ)':undefined}/>{s.manutencao.openCorrectives!=null&&<Stat label="Corretivas em aberto" value={s.manutencao.openCorrectives} onClick={go('man-corretivas')}/>}</div>
    </Card>}
    {s.abastecimento&&<Card mod="abastecimento" action={<button className="text-action" onClick={go('estoque')}>Estoque <ArrowRight size={13} className="inline"/></button>}>
     <ul className="ce-fuels">{(s.abastecimento.fuels as R[]).map(f=><li key={f.id} className={f.low?'low':''}><span>{f.name}</span><div className="ce-bar"><i style={{width:`${Math.min(100,100*f.stock/f.capacity)}%`}}/><em style={{left:`${100*f.minimum/f.capacity}%`}}/></div><b className="mono">{num(f.stock)} {f.unit}</b></li>)}</ul>
     <div className="ce-stats"><Stat label="Reposições em aberto" value={s.abastecimento.requests} tone={s.abastecimento.requests?'var(--mwarn)':undefined} onClick={go('alertas')}/>{s.solicitacoes&&<><Stat label="Aguardando agendamento" value={s.solicitacoes.requested} onClick={go('solicitacoes')}/><Stat label="Agendados" value={s.solicitacoes.scheduled} onClick={go('solicitacoes')}/></>}</div>
    </Card>}
    {!s.abastecimento&&s.solicitacoes&&<Card mod="abastecimento"><div className="ce-stats"><Stat label={s.solicitacoes.own?'Minhas solicitações aguardando':'Aguardando agendamento'} value={s.solicitacoes.requested} onClick={go('solicitacoes')}/><Stat label="Agendados" value={s.solicitacoes.scheduled} onClick={go('solicitacoes')}/>{s.solicitacoes.lateScheduled>0&&<Stat label="Agendados com horário vencido" value={s.solicitacoes.lateScheduled} tone="var(--mwarn)" onClick={go('solicitacoes')}/>}</div></Card>}
    {s.planejamento&&<Card mod="planejamento" action={<button className="text-action" onClick={go('plan-atividade')}>Planejar <ArrowRight size={13} className="inline"/></button>}>
     <div className="ce-stats"><Stat label="Rascunhos" value={s.planejamento.drafts} onClick={go('plan-rascunhos')}/><Stat label="Revisões em rascunho" value={s.planejamento.revisions} onClick={go('plan-rascunhos')}/><Stat label="Parados segurando equipamento" value={s.planejamento.stale} tone={s.planejamento.stale?'var(--mwarn)':undefined} onClick={go('plan-rascunhos')}/></div>
    </Card>}
    {(s.operacao?.agenda?.length>0||s.manutencao?.agenda?.length>0)&&<section className="ce-card"><header><span><CalendarClock size={16}/>Próximos 7 dias</span></header><ul className="ce-agenda">
     {(s.operacao?.agenda as R[]||[]).map(o=><li key={o.id}><button type="button" onClick={()=>onGo('op-os',o.id)}><b className="mono">{fmt(o.start)}</b><span>{osLabel(o.number)} · {o.title}</span><Badge tone="info">{o.org}</Badge></button></li>)}
     {(s.manutencao?.agenda as R[]||[]).map(p=><li key={p.planId}><button type="button" onClick={go('man-painel')}><b className="mono">{dayBR(p.date)}</b><span>Preventiva · {p.tag} · {p.name}</span><Badge tone="success">{p.unit==='dias'?`faltam ${p.remaining} dia(s)`:`faltam ${num(p.remaining)} ${p.unit}`}</Badge></button></li>)}
    </ul></section>}
   </div>
   <section className="ce-alerts" aria-label="Avisos">
    <header><h2>Avisos</h2><div className="ce-mods" role="group" aria-label="Módulo">{['',...modules].map(m=><button key={m||'all'} type="button" aria-pressed={mod===m} onClick={()=>setMod(m)}>{m?MOD[m][0]:'Todos'}</button>)}</div></header>
    {alerts.length?<ul>{alerts.map(a=>{const [label,color,Icon]=SEV[a.severity];return <li key={a.id}><button type="button" style={{['--t' as string]:color}} onClick={()=>onGo(a.link.view,a.link.os)}><Icon size={17} aria-label={label}/><div><b>{a.title}</b><span>{a.detail}</span><small>{MOD[a.module][0]}{a.at?` · ${fmt(a.at)}`:''}</small></div><ArrowRight size={15} className="go"/></button></li>})}</ul>
     :<div className="ce-clear"><CheckCircle2 size={26}/><b>{(data.alerts as R[]).length?'Nenhum aviso com estes filtros':'Tudo em dia'}</b><span>{(data.alerts as R[]).length?'Ajuste a gravidade ou o módulo.':'Nenhum aviso pendente no seu acesso.'}</span></div>}
   </section>
  </div>
 </div>;
}
