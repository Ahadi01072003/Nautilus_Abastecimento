'use client';
// Manutenção: Painel de preventivas (linha do tempo por equipamento/critério com os marcos do
// ciclo), Critérios de manutenção, Corretivas e Leituras de horímetro/odômetro.
// Situação e marcos vêm calculados do servidor; a tela só desenha e envia os registros.
import {useCallback,useEffect,useMemo,useRef,useState,FormEvent,ReactNode} from 'react';
import {Plus,Wrench,Gauge,ClipboardCheck,AlertTriangle,LoaderCircle,CheckCircle2,X,Clock,History,Lock,Search,Pencil,Timer,Ban} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Table,TableHeader,TableRow,TableHead,TableBody,TableCell} from '@/components/ui/table';
import {Checkbox} from '@/components/ui/checkbox';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,Toggle,fmt,post,load,type R} from './kit';

/* ───────────── utilitários ───────────── */

const toLocal=(iso?:string|null)=>iso?new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso)).replace(' ','T'):'';
const toISO=(local:string)=>local?new Date(local+':00-03:00').toISOString():null;
const nowLocal=()=>toLocal(new Date().toISOString());
const dayBR=(d?:string|null)=>d?d.split('-').reverse().join('/'):'—';
const num=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:1});
const amount=(n:number,unit:string)=>unit==='dias'?`${num(n)} ${Math.abs(n)===1?'dia':'dias'}`:`${num(n)} ${unit}`;
const hours=(h:number|null|undefined)=>h==null?'—':`${Math.floor(h)}h${String(Math.round((h%1)*60)).padStart(2,'0')}`;
export const MSTATUS:Record<string,[string,string,string]>={em_dia:['Em dia','var(--ok)','success'],pendente:['Pendente','var(--mwarn)','warning'],atrasada:['Atrasada','var(--occ)','danger'],sem_leitura:['Sem leitura','var(--muted-c)','muted']};
const METHOD:Record<string,string>={dias:'Tempo corrido',horimetro:'Horímetro',odometro:'Odômetro'};
const UNIT:Record<string,string>={dias:'dias',horimetro:'h',odometro:'km'};
const MARK:Record<string,string>={feita:'Feita',perdida:'Perdida',em_andamento:'Em andamento',vencida:'Vencida',proxima:'Próxima',futura:'Futura'};
const RECORD:Record<string,[string,string]>={em_andamento:['Em andamento','info'],concluida:['Concluída','success'],anulada:['Anulada','muted']};
const key=()=>crypto.randomUUID();
const PERIODS=[['7','7 dias'],['30','30 dias'],['90','90 dias'],['365','12 meses'],['todos','Tudo']];

/** Quanto falta (ou há quanto venceu) o primeiro marco em aberto. */
export function remainingText(r:R){
 if(r.status==='sem_leitura')return 'Sem leitura';
 if(r.remaining>0)return `Faltam ${amount(r.remaining,r.unit)}`;
 if(r.remaining===0)return r.method==='dias'?'Vence hoje':'No marco';
 return `Vencida há ${amount(-r.remaining,r.unit)}`;
}

/** Lista de textos editável (itens do plano, pontos manutenidos etc.). */
function ListEditor({label,items,onChange,placeholder,hint,max=60}:{label:string,items:string[],onChange:(v:string[])=>void,placeholder:string,hint?:string,max?:number}){
 const [draft,setDraft]=useState('');
 const add=()=>{const v=draft.trim();if(!v)return;if(items.some(x=>x.toLocaleLowerCase('pt-BR')===v.toLocaleLowerCase('pt-BR'))){toast.error('Item repetido.');return}onChange([...items,v]);setDraft('')};
 return <fieldset className="n-field wide"><legend>{label}</legend>
  {items.length>0&&<ol className="mt-list">{items.map((x,i)=><li key={i}><span>{x}</span><button type="button" aria-label={`Remover ${x}`} onClick={()=>onChange(items.filter((_,j)=>j!==i))}><X size={13}/></button></li>)}</ol>}
  {items.length<max&&<div className="mt-add"><Input value={draft} maxLength={300} placeholder={placeholder} aria-label={placeholder} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();add()}}}/><Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}><Plus size={14}/> Incluir</Button></div>}
  {hint&&<small>{hint}</small>}
 </fieldset>;
}

/** Responsável: colaborador cadastrado ou nome digitado (ex.: terceiro). */
type Resp={id:string,name:string,other?:boolean};
function Responsible({operators,value,onChange}:{operators:R[],value:Resp,onChange:(v:Resp)=>void}){
 return <><Field label="Responsável *"><Choice value={value.id||(value.other?'__other':'')} placeholder="Escolha o responsável" onChange={v=>onChange(v==='__other'?{id:'',name:'',other:true}:{id:v,name:''})} options={[...operators.filter(o=>o.active!==0).map(o=>({value:o.id,label:o.name})),{value:'__other',label:'Outro (digitar o nome)'}]}/></Field>
  {value.other&&<Field label="Nome do responsável *"><Input required maxLength={120} value={value.name} onChange={e=>onChange({id:'',name:e.target.value,other:true})} placeholder="Ex.: Oficina terceirizada"/></Field>}</>;
}
function Team({operators,value,onChange,exclude}:{operators:R[],value:string[],onChange:(v:string[])=>void,exclude?:string}){
 const list=operators.filter(o=>o.active!==0&&o.id!==exclude);
 if(!list.length)return null;
 return <fieldset className="n-field wide"><legend>Equipe (opcional, para homem-hora)</legend><div className="checkbox-options">{list.map(o=><label key={o.id}><Checkbox checked={value.includes(o.id)} onCheckedChange={c=>onChange(c?[...value,o.id]:value.filter(x=>x!==o.id))}/>{o.name}</label>)}</div></fieldset>;
}
const respBody=(r:Resp)=>r.id?{responsibleId:r.id}:{responsibleName:r.name};

function Kpis({items}:{items:{label:string,value:ReactNode,hint:string,color:string,active?:boolean,onClick?:()=>void}[]}){
 return <div className="sn-kpis mt-kpis">{items.map(k=>{const body=<><span className="k"><i style={{background:k.color}}/>{k.label}</span><span className="v">{k.value}</span><span className="d">{k.hint}</span></>;
  return k.onClick?<button key={k.label} type="button" className="sn-kpi mt-kpi" aria-pressed={!!k.active} onClick={k.onClick}>{body}</button>:<div key={k.label} className="sn-kpi">{body}</div>})}</div>;
}

/* ───────────── Painel de preventivas ───────────── */

export function PreventivePanel({refreshKey}:{refreshKey:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[period,setPeriod]=useState('30');
 const [filters,setFilters]=useState({type:'',tag:'',status:''}),[mark,setMark]=useState<{row:R,mark:R}|null>(null),[recordId,setRecordId]=useState<string|null>(null),[reading,setReading]=useState<R|null>(null);
 const refresh=useCallback(async()=>{try{setData(await load<R>('maint/panel?periodo='+period));setError('')}catch(e){setError((e as Error).message)}},[period]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Situação calculada no servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh()},60000);return()=>clearInterval(t)},[refresh]);
 const rows=useMemo(()=>(data?.rows as R[]||[]).filter(r=>(!filters.type||r.typeId===filters.type)&&(!filters.status||r.status===filters.status)&&(!filters.tag||`${r.tag} ${r.name} ${r.equipmentDescription}`.toLocaleLowerCase('pt-BR').includes(filters.tag.toLocaleLowerCase('pt-BR')))),[data,filters]);
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Painel de preventivas indisponível</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <Skeleton className="h-96 rounded-xl"/>;
 const c=data.cards,f=(k:string,v:string)=>setFilters(x=>({...x,[k]:v}));
 const byStatus=(s:string)=>()=>f('status',filters.status===s?'':s);
 return <div className="mt">
  <Kpis items={[
   {label:'Equipamentos',value:c.equipment,hint:c.semLeitura?`${c.semLeitura} sem leitura`:'com critério ativo',color:'var(--ink)',active:!filters.status,onClick:()=>f('status','')},
   {label:'Em dia',value:c.emDia,hint:'antes do próximo marco',color:'var(--ok)',active:filters.status==='em_dia',onClick:byStatus('em_dia')},
   {label:'Pendentes',value:c.pendentes,hint:'passaram do marco, na abrangência',color:'var(--mwarn)',active:filters.status==='pendente',onClick:byStatus('pendente')},
   {label:'Atrasados',value:c.atrasados,hint:'além da abrangência',color:'var(--occ)',active:filters.status==='atrasada',onClick:byStatus('atrasada')},
   {label:'Horas de manutenção',value:hours(c.hours.hours),hint:`${c.hours.count} preventiva(s) · ${hours(c.hours.manHours)} homem-hora`,color:'var(--brand)'},
  ]}/>
  <section className="n-panel">
   <div className="filters mt-filters">
    <Choice label="Tipo de equipamento" value={filters.type||'all'} onChange={v=>f('type',v==='all'?'':v)} options={[{value:'all',label:'Todos os tipos'},...(data.types as R[]).map(t=>({value:t.id,label:t.name}))]}/>
    <label className="mt-search"><Search size={15} aria-hidden/><input type="search" aria-label="TAG ou critério" placeholder="TAG ou critério" value={filters.tag} onChange={e=>f('tag',e.target.value)}/></label>
    <Choice label="Situação" value={filters.status||'all'} onChange={v=>f('status',v==='all'?'':v)} options={[{value:'all',label:'Todas as situações'},...Object.entries(MSTATUS).map(([value,[label]])=>({value,label}))]}/>
    <Choice label="Período das horas" value={period} onChange={setPeriod} options={PERIODS.map(([value,label])=>({value,label:`Horas: ${label}`}))}/>
    {Object.values(filters).some(Boolean)&&<button className="text-action" onClick={()=>setFilters({type:'',tag:'',status:''})}>Limpar</button>}
   </div>
   <div className="mt-legend" aria-hidden><span><i className="m feita"/>Feita</span><span><i className="m proxima"/>Próxima</span><span><i className="m vencida pendente"/>Pendente</span><span><i className="m vencida atrasada"/>Atrasada</span><span><i className="m em_andamento"/>Em andamento</span><span><i className="m perdida"/>Perdida</span><span><i className="now"/>Hoje / leitura atual</span></div>
   {rows.length?<ul className="mt-rows">{rows.map(r=><li key={r.planId} className={`mt-row ${r.status}`} style={{['--s' as string]:MSTATUS[r.status][1]}}>
    <div className="mt-who"><b className="tag-label">{r.tag}</b><span>{r.name}</span><small>{r.typeName||'Sem tipo'} · {METHOD[r.method]} · a cada {amount(r.interval,r.unit)}{r.cycleMode==='execucao'?' após a execução':''}</small>
     {r.openRecord&&<button type="button" className="mt-open" onClick={()=>setRecordId(r.openRecord.id)}><Wrench size={12}/> Em manutenção desde {fmt(r.openRecord.startedAt,true)}</button>}
     {r.method!=='dias'&&<small className={r.stale?'warn-text':''}>{r.current==null?'Nenhuma leitura registrada':`Leitura ${r.currentLabel} em ${fmt(r.readingAt,true)}`}{r.stale&&r.current!=null?' · desatualizada':''}</small>}</div>
    <Track row={r} onMark={m=>setMark({row:r,mark:m})}/>
    <div className="mt-box" role="status"><span className="mt-badge"><i/>{MSTATUS[r.status][0]}</span><b>{remainingText(r)}</b>
     <small>{r.status==='em_dia'?`Próximo marco ${r.firstOpenLabel}`:r.status==='sem_leitura'?`1º marco em aberto ${r.firstOpenLabel}`:`Marco ${r.firstOpenLabel} · abrangência ${amount(r.tolerance,r.unit)}`}</small>
     <small>Marco total: {amount(r.interval,r.unit)}{r.method!=='dias'&&r.projectedDate?` · previsão ${dayBR(r.projectedDate)}`:''}</small>
     {r.status==='sem_leitura'||r.stale?<button type="button" className="text-action" onClick={()=>setReading({equipmentId:r.equipmentId,kind:r.method,tag:r.tag})}>Registrar leitura</button>:null}</div>
   </li>)}</ul>:<Empty icon={Gauge} title={(data.rows as R[]).length?'Nenhum critério com estes filtros':'Nenhum critério de manutenção cadastrado'} description={(data.rows as R[]).length?'Ajuste os filtros acima.':'Cadastre os critérios em Manutenção › Critérios de manutenção: o painel calcula os ciclos sozinho.'}/>}
  </section>
  {mark&&<MarkDialog row={mark.row} mark={mark.mark} operators={data.operators} canEdit={data.canEdit} onClose={()=>setMark(null)} onRecord={id=>{setMark(null);setRecordId(id)}} onChanged={refresh}/>}
  {recordId&&<RecordDialog id={recordId} onClose={()=>setRecordId(null)} onChanged={refresh}/>}
  {reading&&<ReadingDialog initial={reading} equipment={[{id:reading.equipmentId,tag:reading.tag}]} onClose={()=>setReading(null)} onSaved={refresh}/>}
 </div>;
}

/** Linha do tempo de um critério: marcos do ciclo, trecho atual e o ponto “hoje/leitura atual”. */
function Track({row:r,onMark}:{row:R,onMark:(m:R)=>void}){
 const marks=r.marks as R[];
 const cur=r.current as number|null;
 const values=[...marks.map(m=>m.due as number),r.segment.from,...(cur!=null?[cur]:[])];
 const lo=Math.min(...values),hi=Math.max(...values),span=Math.max(1e-6,hi-lo);
 const pos=(v:number)=>4+((v-lo)/span)*92;
 const label=(v:number)=>r.method==='dias'?'hoje':`${num(v)} ${r.unit}`;
 const tone=(m:R)=>m.state==='vencida'?(cur!=null&&cur>m.due+r.tolerance?'atrasada':'pendente'):'';
 // Rótulos sem sobreposição: o de "hoje/leitura" fica na linha de cima; cada marco tenta embaixo e
 // depois em cima; se não couber em nenhuma, o texto some (continua na dica e no leitor de tela).
 const box=useRef<HTMLDivElement>(null),[width,setWidth]=useState(560);
 useEffect(()=>{const el=box.current;if(!el||typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(([e])=>setWidth(e.contentRect.width||560));ro.observe(el);return()=>ro.disconnect();},[]);
 const px=(v:number)=>pos(v)/100*width,textW=(t:string)=>t.length*6.6+6;
 const rows:{up:number[][],down:number[][]}={up:[],down:[]},free=(row:number[][],a:number,b:number)=>row.every(([x,y])=>b+4<x||a>y+4);
 const nowText=cur!=null?label(cur):'',nowFlip=cur!=null&&px(cur)+8+textW(nowText)>width;
 if(cur!=null){const a=nowFlip?px(cur)-8-textW(nowText):px(cur)+6;rows.up.push([a,a+textW(nowText)]);}
 // Perto das bordas o rótulo desliza para dentro da linha (não sai do quadro).
 const shift:number[]=[];
 const place=marks.map((m,i)=>{const t=r.method==='dias'?String(m.label).slice(0,5):String(m.label),c=px(m.due),tw=textW(t);
  const dx=c-tw/2<0?tw/2-c:c+tw/2>width?width-(c+tw/2):0;shift[i]=dx;const a=c-tw/2+dx,b=c+tw/2+dx;
  if(free(rows.down,a,b)){rows.down.push([a,b]);return 'down';}
  if(free(rows.up,a,b)){rows.up.push([a,b]);return 'up';}
  return 'hide';});
 return <div className="mt-track" ref={box} role="group" aria-label={`Linha do tempo de ${r.tag} · ${r.name}`}>
  <div className="mt-axis"/>
  {cur!=null&&<div className="mt-fill" style={{left:`${pos(Math.min(r.segment.from,cur))}%`,width:`${Math.max(0,pos(cur)-pos(Math.min(r.segment.from,cur)))}%`}}/>}
  {marks.map((m,i)=><button key={m.cycle} type="button" className={`m ${m.state} ${tone(m)} ${m.cycle===r.target?'target':''}`} style={{left:`${pos(m.due)}%`}} onClick={()=>onMark(m)}
   aria-label={`Marco ${m.cycle}: ${m.label} · ${MARK[m.state]}${m.cycle===r.target&&!r.openRecord&&m.state!=='feita'?' · registrar preventiva':''}`} title={`Marco ${m.cycle} · ${m.label} · ${MARK[m.state]}`}>
   {m.state==='feita'?<CheckCircle2 size={12}/>:m.state==='perdida'?<X size={11}/>:m.state==='em_andamento'?<Wrench size={11}/>:null}
   {place[i]!=='hide'&&<span className={`ml ${place[i]==='up'?'alt':''}`} style={shift[i]?{transform:`translateX(calc(-50% + ${Math.round(shift[i])}px))`}:undefined}>{r.method==='dias'?m.label.slice(0,5):m.label}</span>}</button>)}
  {cur!=null&&<span className={`now${nowFlip?' flip':''}`} style={{left:`${pos(cur)}%`}}><em>{nowText}</em></span>}
 </div>;
}

function Specs({tasks,attention,nonconformities,estimated}:{tasks:string[],attention:string[],nonconformities:string[],estimated?:number|null}){
 return <div className="mt-specs">
  <div><b>Itens do plano</b>{tasks.length?<ol>{tasks.map(t=><li key={t}>{t}</li>)}</ol>:<small>—</small>}</div>
  <div><b>Pontos de atenção</b>{attention.length?<ul>{attention.map(t=><li key={t}>{t}</li>)}</ul>:<small>Nenhum informado.</small>}</div>
  <div><b>Principais inconformidades</b>{nonconformities.length?<ul>{nonconformities.map(t=><li key={t}>{t}</li>)}</ul>:<small>Nenhuma informada.</small>}{estimated?<small><Clock size={12} className="inline"/> Duração estimada {hours(estimated/60)}</small>:null}</div>
 </div>;
}

function MarkDialog({row:r,mark:m,operators,canEdit,onClose,onRecord,onChanged}:{row:R,mark:R,operators:R[],canEdit:boolean,onClose:()=>void,onRecord:(id:string)=>void,onChanged:()=>Promise<void>}){
 const [start,setStart]=useState(nowLocal()),[resp,setResp]=useState<Resp>({id:'',name:''}),[team,setTeam]=useState<string[]>([]),[stopped,setStopped]=useState(false),[busy,setBusy]=useState(false);
 const canStart=canEdit&&m.cycle===r.target&&!r.openRecord&&m.state!=='feita';
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);try{const x=await post('maint/start',{operationKey:key(),planId:r.planId,cycle:m.cycle,startedAt:toISO(start),...respBody(resp),teamIds:team,stopped});toast.success(x.message);await onChanged();onRecord(x.id)}catch(err){toast.error((err as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog n-dialog-wide"><DialogHeader><div className="modal-eyebrow"><Gauge size={16}/> {r.tag} · {r.name.toUpperCase()}</div>
  <DialogTitle>Marco {m.cycle} · {m.label}</DialogTitle><DialogDescription>{METHOD[r.method]} · a cada {amount(r.interval,r.unit)} · abrangência {amount(r.tolerance,r.unit)} · ciclo {r.cycleMode==='execucao'?'pela execução':'fixo'}</DialogDescription></DialogHeader>
  <div className="review">
   <div className="review-grid"><div><small>Situação do marco</small><b>{MARK[m.state]}</b></div><div><small>Situação do equipamento</small><b style={{color:MSTATUS[r.status][1]}}>{MSTATUS[r.status][0]} · {remainingText(r)}</b></div><div><small>{r.method==='dias'?'Hoje':'Leitura atual'}</small><b>{r.method==='dias'?fmt(new Date().toISOString(),true):r.currentLabel||'—'}</b></div><div><small>Última preventiva</small><b>{r.lastDone?`Marco ${r.lastDone.cycle} · ${fmt(r.lastDone.endedAt,true)}`:'Nenhuma'}</b></div></div>
   <Specs tasks={r.tasks} attention={r.attention} nonconformities={r.nonconformities} estimated={r.estimatedMinutes}/>
   {m.recordId&&<Button variant="outline" onClick={()=>onRecord(m.recordId)}><History size={15}/> Abrir o registro deste marco</Button>}
   {r.openRecord&&!m.recordId&&<div className="notice"><Wrench size={17}/><span>Há uma preventiva em andamento neste critério (marco {r.openRecord.cycle}). <button className="text-action" onClick={()=>onRecord(r.openRecord.id)}>Abrir</button></span></div>}
   {!m.recordId&&m.cycle!==r.target&&m.state!=='feita'&&<div className="notice"><ClipboardCheck size={17}/><span>{m.state==='perdida'?'Marco não atendido: a manutenção seguinte foi registrada para um marco posterior.':m.state==='vencida'?`Este marco venceu; a próxima preventiva registrada atende o marco ${r.target} (o mais recente vencido) e regulariza o critério.`:'Marco futuro: ainda não pode ser registrado.'}</span></div>}
   {canStart&&<form onSubmit={submit} className="mt-start"><h3>Registrar preventiva deste marco</h3><div className="form-grid">
    <Field label="Início (Brasília) *"><Input type="datetime-local" required value={start} max={nowLocal()} onChange={e=>setStart(e.target.value)}/></Field>
    <Responsible operators={operators} value={resp} onChange={setResp}/>
    <Team operators={operators} value={team} onChange={setTeam} exclude={resp.id}/>
    <Toggle title="Equipamento parado durante a manutenção" description="Bloqueia novas reservas e o início de etapas com este equipamento até a conclusão." checked={stopped} onChange={setStopped}/>
   </div><div className="modal-footer"><Button type="button" variant="outline" onClick={onClose}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy||(!resp.id&&!resp.name.trim())}>{busy?<LoaderCircle size={16} className="animate-spin"/>:<Wrench size={16}/>} Iniciar preventiva</Button></div></form>}
   {!canEdit&&m.cycle===r.target&&!r.openRecord&&<small className="pending-text">Registrar manutenção exige o acesso “Manutenção”.</small>}
  </div>
 </DialogContent></Dialog>;
}

/* ───────────── Registro (preventiva ou corretiva) ───────────── */

export function RecordDialog({id,onClose,onChanged}:{id:string,onClose:()=>void,onChanged:()=>Promise<void>}){
 const [d,setD]=useState<R|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [items,setItems]=useState<R[]>([]),[ncs,setNcs]=useState<string[]>([]),[points,setPoints]=useState<string[]>([]),[notes,setNotes]=useState(''),[failure,setFailure]=useState('');
 const [end,setEnd]=useState(nowLocal()),[reading,setReading]=useState(''),[readingKind,setReadingKind]=useState(''),[release,setRelease]=useState<string[]>([]),[releaseReason,setReleaseReason]=useState(''),[note,setNote]=useState(''),[voidReason,setVoidReason]=useState(''),[otherNc,setOtherNc]=useState('');
 // reset=false mantém o que está sendo editado (ex.: depois de um apontamento).
 const reload=useCallback(async(reset=true)=>{try{const x=await load<R>('maint/record?id='+encodeURIComponent(id));setD(x);if(reset){const r=x.record;setItems(r.items);setNcs(r.nonconformities);setPoints((r.items as R[]).map(i=>i.text));setNotes(r.notes||'');setFailure(r.failure||'')}setError('')}catch(e){setError((e as Error).message)}},[id]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Registro vindo do servidor.
 useEffect(()=>{void reload()},[reload]);
 const r=d?.record;
 const open=r?.status==='em_andamento'&&d?.canEdit;
 const meter=r?.kind==='preventiva'&&r.method!=='dias';
 async function run(path:string,body:R,after?:()=>void,reset=true){setBusy(true);try{const x=await post(path,body);if(x.message)toast.success(x.message);after?.();await reload(reset);await onChanged()}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 const progress=()=>({id,items:r?.kind==='preventiva'?items:points,nonconformities:ncs,notes,failure});
 function finish(e:FormEvent){e.preventDefault();void run('maint/finish',{...progress(),endedAt:toISO(end),...(meter?{reading}:reading?{reading,readingKind}:{}),...(release.length?{releaseImpedimentIds:release,releaseReason}:{})})}
 const planNcs:string[]=r?.plan_nonconformities||[];
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog n-dialog-wide">
  {error?<div className="error-panel"><AlertTriangle/><p>{error}</p></div>:!r?<Skeleton className="h-64"/>:<>
  <DialogHeader><div className="modal-eyebrow"><Wrench size={16}/> {r.kind==='preventiva'?'PREVENTIVA':'CORRETIVA'} · {r.tag}</div>
   <DialogTitle>{r.kind==='preventiva'?`${r.plan_name} · marco ${r.cycle} (${r.due_label})`:r.failure||'Manutenção corretiva'}</DialogTitle>
   <DialogDescription>{r.equipment_description}{r.type_name?` · ${r.type_name}`:''} · registrado por {r.created_by_name} em {fmt(r.created_at)}</DialogDescription></DialogHeader>
  <div className="review">
   <div className="badge-group"><Badge tone={RECORD[r.status][1]}>{RECORD[r.status][0]}</Badge>{r.late?<Badge tone="warning">Registro tardio</Badge>:null}{r.stopped?<Badge tone="danger"><Lock size={11}/> Equipamento parado</Badge>:null}</div>
   <div className="review-grid"><div><small>Início</small><b>{fmt(r.started_at)}</b></div><div><small>Fim</small><b>{r.ended_at?fmt(r.ended_at):'Em andamento'}</b></div><div><small>Horas dedicadas</small><b>{hours(r.hours)}{r.manHours!=null&&r.manHours!==r.hours?` · ${hours(r.manHours)} homem-hora`:''}</b></div><div><small>Responsável</small><b>{r.responsible_name}</b>{d.team.length>0&&<small>Equipe: {(d.team as R[]).map(t=>t.name).join(', ')}</small>}</div></div>
   {r.reading!=null&&<p className="flow-description">Leitura no fim: {num(r.reading)} {r.reading_kind==='horimetro'?'h':'km'}</p>}
   {r.status==='anulada'&&<div className="notice warn"><Ban size={17}/><span>Anulado por {r.voided_by_name} em {fmt(r.voided_at)}: {r.void_reason}</span></div>}
   {r.kind==='preventiva'?<>
    {open?<fieldset className="n-field wide"><legend>Itens do plano <small>(marque o que foi executado)</small></legend><div className="mt-checks">{items.map((it,i)=><label key={i} className={it.done?'done':''}><Checkbox checked={!!it.done} onCheckedChange={c=>setItems(items.map((x,j)=>j===i?{...x,done:!!c}:x))}/>{it.text}</label>)}</div></fieldset>
     :<div><b>Itens do plano · {items.filter(i=>i.done).length} de {items.length} executados</b><ul className="mt-done">{items.map((it,i)=><li key={i} className={it.done?'done':'skip'}>{it.done?<CheckCircle2 size={14}/>:<X size={14}/>}{it.text}</li>)}</ul></div>}
    {(r.attention||[]).length>0&&<div className="notice warn"><AlertTriangle size={17}/><div><b>Pontos de atenção</b><ul>{(r.attention as string[]).map(a=><li key={a}>{a}</li>)}</ul></div></div>}
    {open?<fieldset className="n-field wide"><legend>Inconformidades encontradas</legend><div className="mt-checks">{[...new Set([...planNcs,...ncs])].map(n=><label key={n}><Checkbox checked={ncs.includes(n)} onCheckedChange={c=>setNcs(c?[...ncs,n]:ncs.filter(x=>x!==n))}/>{n}</label>)}</div>
     <div className="mt-add"><Input value={otherNc} maxLength={300} placeholder="Outra inconformidade" aria-label="Outra inconformidade" onChange={e=>setOtherNc(e.target.value)}/><Button type="button" size="sm" variant="outline" disabled={!otherNc.trim()} onClick={()=>{const v=otherNc.trim();if(!ncs.includes(v))setNcs([...ncs,v]);setOtherNc('')}}><Plus size={14}/> Incluir</Button></div></fieldset>
     :<div><b>Inconformidades encontradas</b>{ncs.length?<ul className="mt-done">{ncs.map(n=><li key={n} className="nc"><AlertTriangle size={14}/>{n}</li>)}</ul>:<small> Nenhuma.</small>}</div>}
   </>:<>
    {open?<Field label="Falha ou defeito" wide><Input maxLength={1000} value={failure} onChange={e=>setFailure(e.target.value)}/></Field>:null}
    {open?<ListEditor label="Pontos manutenidos *" items={points} onChange={setPoints} placeholder="Ex.: Troca da mangueira hidráulica" max={80}/>:<div><b>Pontos manutenidos</b><ol className="mt-plain">{points.map(p=><li key={p}>{p}</li>)}</ol></div>}
   </>}
   {open?<Field label="Observações" wide><Textarea maxLength={4000} value={notes} onChange={e=>setNotes(e.target.value)}/></Field>:r.notes?<p className="flow-description">{r.notes}</p>:null}
   {open&&<div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void run('maint/update',progress(),undefined,false)}>Salvar andamento</Button></div>}
   <div className="mt-notes"><b>Apontamentos e problemas</b>{(d.notes as R[]).length?<ul>{(d.notes as R[]).map(n=><li key={n.id}><span>{n.text}</span><small>{fmt(n.noted_at)} · {n.author_name}</small></li>)}</ul>:<small>Nenhum apontamento.</small>}
    {d.canEdit&&r.status!=='anulada'&&<form className="mt-add" onSubmit={e=>{e.preventDefault();void run('maint/note',{id,text:note},()=>setNote(''),false)}}><Input value={note} maxLength={2000} placeholder="Registrar apontamento ou problema" aria-label="Novo apontamento" onChange={e=>setNote(e.target.value)}/><Button type="submit" size="sm" variant="outline" disabled={busy||!note.trim()}><Plus size={14}/> Apontar</Button></form>}</div>
   {open&&<form className="mt-finish" onSubmit={finish}><h3>Concluir manutenção</h3><div className="form-grid">
    <Field label="Fim (Brasília) *" hint={`Início ${fmt(r.started_at)}`}><Input type="datetime-local" required value={end} max={nowLocal()} onChange={e=>setEnd(e.target.value)}/></Field>
    {meter?<Field label={`Leitura do ${r.method==='horimetro'?'horímetro (h)':'odômetro (km)'} no fim *`} hint="Base dos próximos marcos."><Input required inputMode="decimal" value={reading} onChange={e=>setReading(e.target.value)}/></Field>
     :<><Field label="Leitura (opcional)"><Choice value={readingKind||'none'} onChange={v=>setReadingKind(v==='none'?'':v)} options={[{value:'none',label:'Sem leitura'},{value:'horimetro',label:'Horímetro (h)'},{value:'odometro',label:'Odômetro (km)'}]}/></Field>{readingKind&&<Field label="Valor *"><Input required inputMode="decimal" value={reading} onChange={e=>setReading(e.target.value)}/></Field>}</>}
    {(d.impediments as R[]).length>0&&<fieldset className="n-field wide"><legend>Liberação técnica de outros bloqueios deste equipamento</legend><div className="checkbox-options">{(d.impediments as R[]).map(i=><label key={i.id}><Checkbox checked={release.includes(i.id)} onCheckedChange={c=>setRelease(c?[...release,i.id]:release.filter(x=>x!==i.id))}/>{i.kind==='nc_critica'?'NC crítica':i.kind==='manutencao'?'Em manutenção':'Impedimento'}: {i.reason}</label>)}</div>
     {release.length>0&&<Field label="Justificativa da liberação *" wide><Textarea required maxLength={500} value={releaseReason} onChange={e=>setReleaseReason(e.target.value)}/></Field>}</fieldset>}
   </div>{r.stopped?<small>O bloqueio “equipamento parado” desta manutenção é liberado ao concluir.</small>:null}
    <div className="modal-footer"><Button type="button" variant="outline" onClick={onClose}>Fechar</Button><Button type="submit" className="primary-action" disabled={busy}>{busy?<LoaderCircle size={16} className="animate-spin"/>:<CheckCircle2 size={16}/>} Concluir manutenção</Button></div></form>}
   {d.canVoid&&r.status!=='anulada'&&<form className="cancel-box" onSubmit={e=>{e.preventDefault();void run('maint/void',{id,reason:voidReason},()=>setVoidReason(''))}}><Field label="Anular registro (gestor) · motivo" wide hint={r.kind==='preventiva'?'O marco volta a ficar em aberto. O registro continua consultável.':'O registro continua consultável como anulado.'}><Textarea required maxLength={500} value={voidReason} onChange={e=>setVoidReason(e.target.value)}/></Field><Button type="submit" variant="outline" disabled={busy||!voidReason.trim()}>Anular</Button></form>}
  </div></>}
 </DialogContent></Dialog>;
}

/* ───────────── Critérios de manutenção ───────────── */

type PlanForm={id?:string,version?:number,equipmentId:string,name:string,method:string,interval:string,tolerance:string,anchorDate:string,anchorReading:string,cycleMode:string,tasks:string[],attention:string[],nonconformities:string[],estimatedMinutes:string,active:boolean,reason:string};
const DAY=86400000;
function preview(f:PlanForm){
 const iv=Number(String(f.interval).replace(',','.'));if(!(iv>0))return [];
 if(f.method==='dias'){if(!/^\d{4}-\d{2}-\d{2}$/.test(f.anchorDate))return [];const base=Date.parse(f.anchorDate+'T00:00:00Z');return [1,2,3].map(k=>dayBR(new Date(base+k*iv*DAY).toISOString().slice(0,10)));}
 const a=Number(String(f.anchorReading).replace(',','.'));if(!Number.isFinite(a)||f.anchorReading==='')return [];return [1,2,3].map(k=>`${num(a+k*iv)} ${UNIT[f.method]}`);
}

export function MaintenanceCriteria({refreshKey}:{refreshKey:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[q,setQ]=useState(''),[type,setType]=useState(''),[selected,setSelected]=useState<string|null>(null),[form,setForm]=useState<PlanForm|null>(null),[original,setOriginal]=useState<R|null>(null),[busy,setBusy]=useState(false);
 const refresh=useCallback(async()=>{try{setData(await load<R>('maint/criteria'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Cadastro vindo do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Critérios indisponíveis</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <Skeleton className="h-96 rounded-xl"/>;
 const plans=data.plans as R[];
 const equipment=(data.equipment as R[]).filter(e=>(e.active||plans.some(p=>p.equipment_id===e.id))&&(!type||e.type_id===type)&&(!q||`${e.tag} ${e.description}`.toLocaleLowerCase('pt-BR').includes(q.toLocaleLowerCase('pt-BR'))));
 const current=(data.equipment as R[]).find(e=>e.id===(selected||equipment[0]?.id));
 const mine=current?plans.filter(p=>p.equipment_id===current.id):[];
 const set=(k:keyof PlanForm,v:unknown)=>setForm(f=>f&&({...f,[k]:v}));
 const blank=(e:R):PlanForm=>({equipmentId:e.id,name:'',method:'dias',interval:'30',tolerance:'5',anchorDate:new Date().toISOString().slice(0,10),anchorReading:e.horimetro?String(e.horimetro.value):'',cycleMode:'fixo',tasks:[],attention:[],nonconformities:[],estimatedMinutes:'',active:true,reason:''});
 const edit=(p:R)=>{setOriginal(p);setForm({id:p.id,version:p.version,equipmentId:p.equipment_id,name:p.name,method:p.method,interval:String(p.interval_value),tolerance:String(p.tolerance_value),anchorDate:p.anchor_date||'',anchorReading:p.anchor_reading==null?'':String(p.anchor_reading),cycleMode:p.cycle_mode,tasks:p.tasks,attention:p.attention,nonconformities:p.nonconformities,estimatedMinutes:p.estimated_minutes?String(p.estimated_minutes):'',active:!!p.active,reason:''})};
 const ruleChanged=!!(form&&original&&(original.method!==form.method||Number(original.interval_value)!==Number(form.interval.replace(',','.'))||Number(original.tolerance_value)!==Number(form.tolerance.replace(',','.'))||(original.anchor_date||'')!==(form.method==='dias'?form.anchorDate:'')||(original.anchor_reading==null?'':String(original.anchor_reading))!==(form.method==='dias'?'':form.anchorReading)||original.cycle_mode!==form.cycleMode));
 async function save(e:FormEvent){e.preventDefault();if(!form)return;setBusy(true);
  try{const x=await post('maint/plan',{...form,interval:form.interval,tolerance:form.tolerance||0,anchorDate:form.method==='dias'?form.anchorDate:null,anchorReading:form.method==='dias'?null:form.anchorReading,estimatedMinutes:form.estimatedMinutes||null});toast.success(x.message);setForm(null);setOriginal(null);await refresh()}
  catch(err){toast.error((err as Error).message)}finally{setBusy(false)}}
 const meter=(e:R,k:string)=>e[k]?`${num(e[k].value)} ${UNIT[k]} · ${fmt(e[k].read_at,true)}`:'—';
 return <div className="mt-criteria">
  <aside className="n-panel mt-eqlist"><div className="filters"><label className="mt-search"><Search size={15} aria-hidden/><input type="search" placeholder="TAG ou descrição" aria-label="Buscar equipamento" value={q} onChange={e=>setQ(e.target.value)}/></label>
   <Choice label="Tipo" value={type||'all'} onChange={v=>setType(v==='all'?'':v)} options={[{value:'all',label:'Todos os tipos'},...(data.types as R[]).map(t=>({value:t.id,label:t.name}))]}/></div>
   {equipment.length?<ul>{equipment.map(e=>{const n=plans.filter(p=>p.equipment_id===e.id&&p.active).length;return <li key={e.id}><button type="button" aria-current={current?.id===e.id} onClick={()=>setSelected(e.id)}><b className="tag-label">{e.tag}</b><span>{e.description}</span><small>{e.type_name||'Sem tipo'} · {n?`${n} critério(s)`:'sem critério'}</small></button></li>})}</ul>:<p className="sn-empty">Nenhum equipamento encontrado.</p>}
  </aside>
  <section className="n-panel">{current?<>
   <div className="panel-heading"><div><h2>{current.tag} · {current.description}</h2><p>{current.type_name||'Sem tipo'} · horímetro {meter(current,'horimetro')} · odômetro {meter(current,'odometro')}</p></div>{data.canEdit&&current.active?<Button onClick={()=>{setOriginal(null);setForm(blank(current))}}><Plus size={16}/> Novo critério</Button>:null}</div>
   {mine.length?<div className="mt-plans">{mine.map(p=><article key={p.id} className={`mt-plan ${p.active?'':'inactive'}`}>
    <header><div><b>{p.name}</b><small>{METHOD[p.method]} · a cada {amount(p.interval_value,UNIT[p.method])} · abrangência {amount(p.tolerance_value,UNIT[p.method])} · ciclo {p.cycle_mode==='execucao'?'pela execução':'fixo'}</small></div>{!p.active&&<Badge>Inativo</Badge>}{data.canEdit&&<button className="icon-action" aria-label={`Editar ${p.name}`} onClick={()=>edit(p)}><Pencil size={16}/></button>}</header>
    <p className="mt-anchor">Marco zero: {p.method==='dias'?dayBR(p.anchor_date):`${num(p.anchor_reading)} ${UNIT[p.method]}`} · próximos marcos {p.preview.join(' · ')} · {p.records} manutenção(ões) registrada(s)</p>
    <Specs tasks={p.tasks} attention={p.attention} nonconformities={p.nonconformities} estimated={p.estimated_minutes}/>
   </article>)}</div>:<Empty icon={ClipboardCheck} title="Sem critério de manutenção" description="Defina o plano, o método (dias, horímetro ou odômetro), o intervalo, a abrangência e o marco zero: o sistema calcula o ciclo." action={data.canEdit&&current.active?<Button onClick={()=>{setOriginal(null);setForm(blank(current))}}><Plus size={16}/> Cadastrar critério</Button>:undefined}/>}
  </>:<Empty icon={ClipboardCheck} title="Nenhum equipamento" description="Cadastre equipamentos em Cadastros gerais › Tipos e equipamentos."/>}</section>

  <Dialog open={!!form} onOpenChange={v=>{if(!v&&!busy){setForm(null);setOriginal(null)}}}><DialogContent className="n-dialog n-dialog-wide">{form&&<><DialogHeader><div className="modal-eyebrow"><ClipboardCheck size={16}/> CRITÉRIO DE MANUTENÇÃO · {(data.equipment as R[]).find(e=>e.id===form.equipmentId)?.tag}</div><DialogTitle>{form.id?'Editar critério':'Novo critério'}</DialogTitle><DialogDescription>O sistema calcula os marcos a partir do marco zero e do intervalo; a abrangência define quando o pendente vira atrasado.</DialogDescription></DialogHeader>
   <form onSubmit={save}><div className="form-grid">
    <Field label="Nome do plano *" wide><Input required maxLength={120} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Ex.: Preventiva mensal, Revisão 250 h"/></Field>
    <fieldset className="n-field wide"><legend>Método de análise *</legend><div className="segmented" role="group" aria-label="Método de análise">{Object.entries(METHOD).map(([v,l])=><button key={v} type="button" aria-pressed={form.method===v} disabled={!!original&&original.records>0&&original.method!==v} onClick={()=>set('method',v)}>{l} ({UNIT[v]})</button>)}</div>{!!original&&original.records>0&&<small>Já há manutenções registradas: o método não muda (inative e crie outro critério).</small>}</fieldset>
    <Field label={`Intervalo (${UNIT[form.method]}) *`} hint={form.method==='dias'?'Ex.: 30 = de 30 em 30 dias.':'Ex.: 250 = a cada 250 '+UNIT[form.method]+'.'}><Input required inputMode="decimal" value={form.interval} onChange={e=>set('interval',e.target.value)}/></Field>
    <Field label={`Abrangência (${UNIT[form.method]})`} hint="Tolerância depois do marco: dentro dela fica pendente (amarelo); além, atrasado (vermelho)."><Input inputMode="decimal" value={form.tolerance} onChange={e=>set('tolerance',e.target.value)}/></Field>
    {form.method==='dias'?<Field label="Marco zero: contar a partir de *" hint="A 1ª preventiva vence um intervalo depois desta data."><Input type="date" required value={form.anchorDate} onChange={e=>set('anchorDate',e.target.value)}/></Field>
     :<Field label={`Marco zero: leitura inicial (${UNIT[form.method]}) *`} hint="A 1ª preventiva vence um intervalo depois desta leitura."><Input required inputMode="decimal" value={form.anchorReading} onChange={e=>set('anchorReading',e.target.value)}/></Field>}
    <Field label="Duração estimada (min)"><Input inputMode="numeric" value={form.estimatedMinutes} onChange={e=>set('estimatedMinutes',e.target.value.replace(/\D/g,''))}/></Field>
    <fieldset className="n-field wide"><legend>Contagem do ciclo</legend><div className="segmented" role="group" aria-label="Contagem do ciclo"><button type="button" aria-pressed={form.cycleMode==='fixo'} onClick={()=>set('cycleMode','fixo')}>Fixa (a partir do marco zero)</button><button type="button" aria-pressed={form.cycleMode==='execucao'} onClick={()=>set('cycleMode','execucao')}>Pela última execução</button></div><small>{form.cycleMode==='fixo'?'Os marcos não se deslocam: 30, 60, 90… a partir do marco zero, mesmo se uma preventiva atrasar.':'Cada marco conta a partir do término (ou da leitura) da preventiva anterior.'}</small></fieldset>
    {preview(form).length>0&&<div className="notice wide"><Timer size={17}/><span>Próximos marcos: {preview(form).map((p,i)=>`${i+1}º ${p}`).join(' · ')}</span></div>}
    <ListEditor label="Plano de manutenção: itens *" items={form.tasks} onChange={v=>set('tasks',v)} placeholder="Ex.: Trocar óleo do motor" hint="Viram a lista de verificação ao registrar a preventiva."/>
    <ListEditor label="Pontos de atenção" items={form.attention} onChange={v=>set('attention',v)} placeholder="Ex.: Vazamento no cilindro de elevação"/>
    <ListEditor label="Principais inconformidades" items={form.nonconformities} onChange={v=>set('nonconformities',v)} placeholder="Ex.: Freio com folga"/>
    {form.id&&<Toggle title="Critério ativo" description="Inativo sai do painel e não gera avisos; o histórico continua." checked={form.active} onChange={v=>set('active',v)}/>}
    {ruleChanged&&<Field label="Motivo da mudança da regra do ciclo *" wide hint="Intervalo, abrangência, marco zero ou contagem mudaram: os marcos são recalculados. Fica na auditoria."><Textarea required maxLength={500} value={form.reason} onChange={e=>set('reason',e.target.value)}/></Field>}
   </div><div className="modal-footer"><Button type="button" variant="outline" onClick={()=>{setForm(null);setOriginal(null)}}>Cancelar</Button><Button type="submit" className="primary-action" disabled={busy||!form.tasks.length}>{busy?<LoaderCircle size={16} className="animate-spin"/>:null} Salvar critério</Button></div></form>
  </>}</DialogContent></Dialog>
 </div>;
}

/* ───────────── Corretivas ───────────── */

export function Correctives({refreshKey}:{refreshKey:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[filters,setFilters]=useState({periodo:'30',type:'',equipment:'',status:''}),[creating,setCreating]=useState(false),[recordId,setRecordId]=useState<string|null>(null);
 const query=useMemo(()=>new URLSearchParams(Object.entries({kind:'corretiva',...filters}).filter(([,v])=>v) as [string,string][]).toString(),[filters]);
 const refresh=useCallback(async()=>{try{setData(await load<R>('maint/records?'+query));setError('')}catch(e){setError((e as Error).message)}},[query]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Lista vinda do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Corretivas indisponíveis</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <Skeleton className="h-96 rounded-xl"/>;
 const c=data.cards,f=(k:string,v:string)=>setFilters(x=>({...x,[k]:v}));
 const topId=c.top?(data.equipment as R[]).find(e=>e.tag===c.top.tag)?.id:'';
 return <div className="mt">
  <div className="panel-heading mt-head"><div><h2>Manutenções corretivas</h2><p>Registro de cada intervenção não programada: pontos manutenidos, horas e observações.</p></div>{data.canEdit&&<Button className="primary-action" onClick={()=>setCreating(true)}><Plus size={16}/> Registrar manutenção</Button>}</div>
  <Kpis items={[
   {label:'Corretivas',value:c.total,hint:filters.periodo==='todos'?'todo o histórico':`últimos ${PERIODS.find(p=>p[0]===filters.periodo)?.[1]}`,color:'var(--ink)',active:!filters.status&&!filters.equipment,onClick:()=>setFilters(x=>({...x,status:'',equipment:''}))},
   {label:'Em andamento',value:c.open,hint:c.stopped?`${c.stopped} com equipamento parado`:'nenhum equipamento parado',color:'var(--evt)',active:filters.status==='em_andamento',onClick:()=>f('status',filters.status==='em_andamento'?'':'em_andamento')},
   {label:'Horas de manutenção',value:hours(c.hours),hint:'corretivas concluídas',color:'var(--brand)'},
   {label:'Tempo médio de reparo',value:hours(c.mttr),hint:'MTTR das concluídas',color:'var(--imp)'},
   {label:'Mais corretivas',value:c.top?c.top.tag:'—',hint:c.top?`${c.top.n} no período`:'sem registros',color:'var(--occ)',active:!!topId&&filters.equipment===topId,onClick:topId?()=>f('equipment',filters.equipment===topId?'':topId):undefined},
  ]}/>
  <section className="n-panel">
   <div className="filters mt-filters">
    <Choice label="Período" value={filters.periodo} onChange={v=>f('periodo',v)} options={PERIODS.map(([value,label])=>({value,label}))}/>
    <Choice label="Tipo de equipamento" value={filters.type||'all'} onChange={v=>f('type',v==='all'?'':v)} options={[{value:'all',label:'Todos os tipos'},...(data.types as R[]).map(t=>({value:t.id,label:t.name}))]}/>
    <Choice label="Equipamento" value={filters.equipment||'all'} onChange={v=>f('equipment',v==='all'?'':v)} options={[{value:'all',label:'Todas as TAGs'},...(data.equipment as R[]).map(e=>({value:e.id,label:e.tag}))]}/>
    <Choice label="Situação" value={filters.status||'all'} onChange={v=>f('status',v==='all'?'':v)} options={[{value:'all',label:'Sem anuladas'},...Object.entries(RECORD).map(([value,[label]])=>({value,label}))]}/>
   </div>
   {(data.records as R[]).length?<><div className="table-scroll orders-table"><Table><TableHeader><TableRow><TableHead>Início</TableHead><TableHead>Equipamento</TableHead><TableHead>Falha / pontos</TableHead><TableHead>Responsável</TableHead><TableHead>Duração</TableHead><TableHead>Situação</TableHead></TableRow></TableHeader>
    <TableBody>{(data.records as R[]).map(r=><TableRow key={r.id} className="clickable" onClick={()=>setRecordId(r.id)}><TableCell>{fmt(r.started_at)}</TableCell><TableCell><button className="tag-label" onClick={e=>{e.stopPropagation();setRecordId(r.id)}}>{r.tag}</button><small>{r.type_name||''}</small></TableCell><TableCell><b>{r.failure||'—'}</b><small>{(r.items as R[]).map(i=>i.text).join(' · ')||'Sem pontos registrados'}</small></TableCell><TableCell>{r.responsible_name}</TableCell><TableCell>{hours(r.hours)}</TableCell><TableCell><span className="status-cell"><Badge tone={RECORD[r.status][1]}>{RECORD[r.status][0]}</Badge>{r.stopped&&r.status==='em_andamento'?<Badge tone="danger"><Lock size={11}/> Parado</Badge>:null}{r.late?<Badge tone="warning">Tardio</Badge>:null}</span></TableCell></TableRow>)}</TableBody></Table></div>
    <ul className="order-cards">{(data.records as R[]).map(r=><li key={r.id}><button type="button" onClick={()=>setRecordId(r.id)}><div><b>{r.tag}</b><Badge tone={RECORD[r.status][1]}>{RECORD[r.status][0]}</Badge></div><span>{r.failure||(r.items as R[]).map(i=>i.text).join(' · ')||'Corretiva'}</span><small>{fmt(r.started_at)} · {hours(r.hours)} · {r.responsible_name}</small></button></li>)}</ul></>
   :<Empty icon={Wrench} title="Nenhuma corretiva no filtro" description="Registre cada manutenção corretiva com os pontos manutenidos, para ter horas, tempo médio de reparo e histórico por equipamento." action={data.canEdit?<Button onClick={()=>setCreating(true)}><Plus size={16}/> Registrar manutenção</Button>:undefined}/>}
  </section>
  {creating&&<CorrectiveDialog data={data} onClose={()=>setCreating(false)} onSaved={async(id,open)=>{setCreating(false);await refresh();if(open)setRecordId(id)}}/>}
  {recordId&&<RecordDialog id={recordId} onClose={()=>setRecordId(null)} onChanged={refresh}/>}
 </div>;
}

function CorrectiveDialog({data,onClose,onSaved}:{data:R,onClose:()=>void,onSaved:(id:string,open:boolean)=>Promise<void>}){
 const [eq,setEq]=useState(''),[start,setStart]=useState(nowLocal()),[end,setEnd]=useState(nowLocal()),[ongoing,setOngoing]=useState(false),[resp,setResp]=useState<Resp>({id:'',name:''}),[team,setTeam]=useState<string[]>([]);
 const [failure,setFailure]=useState(''),[points,setPoints]=useState<string[]>([]),[notes,setNotes]=useState(''),[stopped,setStopped]=useState(true),[readingKind,setReadingKind]=useState(''),[reading,setReading]=useState('');
 const [blocks,setBlocks]=useState<R[]>([]),[release,setRelease]=useState<string[]>([]),[releaseReason,setReleaseReason]=useState(''),[busy,setBusy]=useState(false),[opKey]=useState(key);
 // Bloqueios abertos do equipamento (ex.: NC crítica) que a corretiva pode liberar ao concluir.
 useEffect(()=>{if(!eq)return;let alive=true;load<R>('condition').then(c=>{if(alive){setBlocks((c.open as R[]).filter(i=>i.equipment_id===eq));setRelease([])}}).catch(()=>{});return()=>{alive=false}},[eq]);
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);
  try{const x=await post('maint/corrective',{operationKey:opKey,equipmentId:eq,startedAt:toISO(start),endedAt:ongoing?null:toISO(end),...respBody(resp),teamIds:team,failure,points,notes,stopped:ongoing&&stopped,...(readingKind&&reading&&!ongoing?{readingKind,reading}:{}),...(!ongoing&&release.length?{releaseImpedimentIds:release,releaseReason}:{})});toast.success(x.message);await onSaved(x.id,ongoing)}
  catch(err){toast.error((err as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog n-dialog-wide"><DialogHeader><div className="modal-eyebrow"><Wrench size={16}/> MANUTENÇÃO CORRETIVA</div><DialogTitle>Registrar manutenção</DialogTitle><DialogDescription>Registre a corretiva já concluída ou abra uma em andamento para concluir depois. Horas são calculadas pelo início e fim.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Equipamento manutenido *" wide><Choice value={eq} onChange={setEq} placeholder="Escolha a TAG" options={(data.equipment as R[]).filter(e=>e.active).map(e=>({value:e.id,label:`${e.tag} · ${e.description}`}))}/></Field>
   <Field label="Início (Brasília) *"><Input type="datetime-local" required value={start} max={nowLocal()} onChange={e=>setStart(e.target.value)}/></Field>
   {!ongoing&&<Field label="Fim (Brasília) *"><Input type="datetime-local" required value={end} max={nowLocal()} onChange={e=>setEnd(e.target.value)}/></Field>}
   <Toggle title="Ainda em andamento" description="Abre o registro para concluir depois (com apontamentos no caminho)." checked={ongoing} onChange={setOngoing}/>
   {ongoing&&<Toggle title="Equipamento parado" description="Bloqueia novas reservas e o início de etapas com este equipamento até a conclusão." checked={stopped} onChange={setStopped}/>}
   <Responsible operators={data.operators} value={resp} onChange={setResp}/>
   <Team operators={data.operators} value={team} onChange={setTeam} exclude={resp.id}/>
   <Field label="Falha ou defeito" wide><Input maxLength={1000} value={failure} onChange={e=>setFailure(e.target.value)} placeholder="Ex.: Vazamento no cilindro de elevação"/></Field>
   <ListEditor label={ongoing?'Pontos manutenidos':'Pontos manutenidos *'} items={points} onChange={setPoints} placeholder="Ex.: Troca do retentor do cilindro" max={80}/>
   <Field label="Observações" wide><Textarea maxLength={4000} value={notes} onChange={e=>setNotes(e.target.value)}/></Field>
   {!ongoing&&<><Field label="Leitura no fim (opcional)"><Choice value={readingKind||'none'} onChange={v=>setReadingKind(v==='none'?'':v)} options={[{value:'none',label:'Sem leitura'},{value:'horimetro',label:'Horímetro (h)'},{value:'odometro',label:'Odômetro (km)'}]}/></Field>{readingKind&&<Field label="Valor *"><Input required inputMode="decimal" value={reading} onChange={e=>setReading(e.target.value)}/></Field>}</>}
   {!ongoing&&blocks.length>0&&<fieldset className="n-field wide"><legend>Liberação técnica de bloqueios deste equipamento</legend><div className="checkbox-options">{blocks.map(i=><label key={i.id}><Checkbox checked={release.includes(i.id)} onCheckedChange={c=>setRelease(c?[...release,i.id]:release.filter(x=>x!==i.id))}/>{i.kind==='nc_critica'?'NC crítica':i.kind==='manutencao'?'Em manutenção':'Impedimento'}: {i.reason}</label>)}</div>
    {release.length>0&&<Field label="Justificativa da liberação *" wide><Textarea required maxLength={500} value={releaseReason} onChange={e=>setReleaseReason(e.target.value)}/></Field>}</fieldset>}
  </div><div className="modal-footer"><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" className="primary-action" disabled={busy||!eq||(!resp.id&&!resp.name.trim())||(!ongoing&&!points.length)}>{busy?<LoaderCircle size={16} className="animate-spin"/>:<Wrench size={16}/>} {ongoing?'Abrir corretiva':'Registrar corretiva'}</Button></div></form>
 </DialogContent></Dialog>;
}

/* ───────────── Leituras ───────────── */

function ReadingDialog({initial,equipment,onClose,onSaved}:{initial:R,equipment:R[],onClose:()=>void,onSaved:()=>Promise<void>}){
 const [f,setF]=useState({equipmentId:initial.equipmentId||'',kind:initial.kind==='odometro'?'odometro':'horimetro',value:'',readAt:nowLocal(),note:''}),[busy,setBusy]=useState(false);
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);try{const x=await post('maint/reading',{...f,readAt:toISO(f.readAt)});toast.success(x.message);onClose();await onSaved()}catch(err){toast.error((err as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Gauge size={16}/> LEITURA</div><DialogTitle>Registrar leitura</DialogTitle><DialogDescription>Leituras não voltam e o horímetro não pode avançar mais horas do que se passaram. As de horímetro dos abastecimentos já entram sozinhas.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Equipamento *" wide><Choice value={f.equipmentId} onChange={v=>setF({...f,equipmentId:v})} placeholder="Escolha a TAG" options={equipment.map(e=>({value:e.id,label:e.description?`${e.tag} · ${e.description}`:e.tag}))}/></Field>
   <fieldset className="n-field wide"><legend>Medidor *</legend><div className="segmented" role="group" aria-label="Medidor"><button type="button" aria-pressed={f.kind==='horimetro'} onClick={()=>setF({...f,kind:'horimetro'})}>Horímetro (h)</button><button type="button" aria-pressed={f.kind==='odometro'} onClick={()=>setF({...f,kind:'odometro'})}>Odômetro (km)</button></div></fieldset>
   <Field label={`Leitura (${f.kind==='horimetro'?'h':'km'}) *`}><Input required inputMode="decimal" value={f.value} onChange={e=>setF({...f,value:e.target.value})}/></Field>
   <Field label="Data e hora da leitura *"><Input type="datetime-local" required value={f.readAt} max={nowLocal()} onChange={e=>setF({...f,readAt:e.target.value})}/></Field>
   <Field label="Observação" wide><Input maxLength={300} value={f.note} onChange={e=>setF({...f,note:e.target.value})}/></Field>
  </div><div className="modal-footer"><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" className="primary-action" disabled={busy||!f.equipmentId||!f.value}>{busy?<LoaderCircle size={16} className="animate-spin"/>:null} Registrar leitura</Button></div></form>
 </DialogContent></Dialog>;
}

export function Readings({refreshKey}:{refreshKey:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[q,setQ]=useState(''),[dialog,setDialog]=useState<R|null>(null),[history,setHistory]=useState<R|null>(null),[voiding,setVoiding]=useState<R|null>(null),[reason,setReason]=useState('');
 const refresh=useCallback(async()=>{try{setData(await load<R>('maint/readings'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Leituras vindas do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 async function openHistory(e:R){try{const x=await load<R>('maint/readings?equipment='+encodeURIComponent(e.id));setHistory({equipment:e,rows:x.history})}catch(err){toast.error((err as Error).message)}}
 async function doVoid(ev:FormEvent){ev.preventDefault();if(!voiding)return;try{const x=await post('maint/reading/void',{id:voiding.id,reason});toast.success(x.message);setVoiding(null);setReason('');await refresh();if(history)await openHistory(history.equipment)}catch(err){toast.error((err as Error).message)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Leituras indisponíveis</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <Skeleton className="h-96 rounded-xl"/>;
 const list=(data.equipment as R[]).filter(e=>!q||`${e.tag} ${e.description} ${e.type_name||''}`.toLocaleLowerCase('pt-BR').includes(q.toLocaleLowerCase('pt-BR')));
 const cell=(e:R,k:string)=>{const m=e[k];if(!m)return e.meters.includes(k)?<span className="warn-text">Sem leitura (critério ativo)</span>:'—';const old=Date.parse(data.generatedAt)-Date.parse(m.read_at)>15*DAY&&e.meters.includes(k);
  return <><b className="mono">{num(m.value)} {UNIT[k]}</b><small className={old?'warn-text':''}>{fmt(m.read_at)} · {m.source==='abastecimento'?'abastecimento':m.source==='manutencao'?'manutenção':'digitada'}{old?' · desatualizada':''}</small>{e.rate[k]?<small>~{num(e.rate[k])} {UNIT[k]}/dia</small>:null}</>};
 return <div className="mt">
  <section className="n-panel">
   <div className="panel-heading"><div><h2>Leituras de horímetro e odômetro</h2><p>Base dos critérios por leitura. As de horímetro dos abastecimentos entram sozinhas; registre aqui as demais.</p></div><Button className="primary-action" onClick={()=>setDialog({})}><Plus size={16}/> Registrar leitura</Button></div>
   <div className="filters"><label className="mt-search"><Search size={15} aria-hidden/><input type="search" placeholder="TAG, descrição ou tipo" aria-label="Buscar equipamento" value={q} onChange={e=>setQ(e.target.value)}/></label></div>
   {list.length?<div className="table-scroll"><Table><TableHeader><TableRow><TableHead>Equipamento</TableHead><TableHead>Horímetro</TableHead><TableHead>Odômetro</TableHead><TableHead/></TableRow></TableHeader><TableBody>{list.map(e=><TableRow key={e.id}><TableCell><b className="tag-label">{e.tag}</b><small>{e.description}{e.type_name?` · ${e.type_name}`:''}</small></TableCell><TableCell>{cell(e,'horimetro')}</TableCell><TableCell>{cell(e,'odometro')}</TableCell>
    <TableCell><div className="access-actions"><Button size="sm" variant="outline" onClick={()=>setDialog({equipmentId:e.id,kind:e.meters.includes('odometro')&&!e.meters.includes('horimetro')?'odometro':'horimetro'})}>Registrar</Button><button className="icon-action" aria-label={`Histórico de leituras de ${e.tag}`} onClick={()=>void openHistory(e)}><History size={16}/></button></div></TableCell></TableRow>)}</TableBody></Table></div>:<Empty icon={Gauge} title="Nenhum equipamento" description="Ajuste a busca."/>}
  </section>
  {dialog&&<ReadingDialog initial={dialog} equipment={data.equipment} onClose={()=>setDialog(null)} onSaved={refresh}/>}
  <Dialog open={!!history} onOpenChange={v=>{if(!v)setHistory(null)}}><DialogContent className="n-dialog n-dialog-wide">{history&&<><DialogHeader><div className="modal-eyebrow"><History size={16}/> LEITURAS</div><DialogTitle>{history.equipment.tag} · {history.equipment.description}</DialogTitle><DialogDescription>Últimas 200 leituras (digitadas, da manutenção e dos abastecimentos).</DialogDescription></DialogHeader>
   {(history.rows as R[]).length?<ul className="mt-history">{(history.rows as R[]).map(h=><li key={h.id+h.source} className={h.voided_at?'voided':''}><b className="mono">{num(Number(h.value))} {UNIT[h.kind]}</b><span>{fmt(h.read_at)} · {h.source==='abastecimento'?'abastecimento':h.source==='manutencao'?'manutenção':'digitada'} · {h.author_name}{h.note?` · ${h.note}`:''}</span>{h.voided_at?<small>Anulada: {h.void_reason}</small>:h.manual&&data.canVoid?<button className="text-action" onClick={()=>setVoiding(h)}>Anular</button>:null}</li>)}</ul>:<Empty icon={Gauge} title="Nenhuma leitura" description="Registre a primeira leitura deste equipamento."/>}
  </>}</DialogContent></Dialog>
  <Dialog open={!!voiding} onOpenChange={v=>{if(!v)setVoiding(null)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Ban size={16}/> ANULAR LEITURA</div><DialogTitle>{voiding?`${num(Number(voiding.value))} ${UNIT[voiding.kind]} em ${fmt(voiding.read_at)}`:''}</DialogTitle><DialogDescription>A leitura deixa de valer para os ciclos, mas continua no histórico. Somente o gestor anula.</DialogDescription></DialogHeader>
   <form onSubmit={doVoid}><div className="form-grid"><Field label="Motivo *" wide><Textarea required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></Field></div><div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setVoiding(null)}>Voltar</Button><Button type="submit" className="primary-action" disabled={!reason.trim()}>Anular leitura</Button></div></form>
  </DialogContent></Dialog>
 </div>;
}
