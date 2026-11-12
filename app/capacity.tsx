'use client';
// Planejamento › Capacidade (P1): HH por dia e por função de cada barra (OCP e Equinor), calculado do
// cadastro dos colaboradores (barra, equipe ADM/Turno A/Turno B, função atuante, entra no HH), da escala
// 2x2 e das ausências. A Gestão configura as barras (jornada ADM, turno, âncora e zonas).
import {useCallback,useEffect,useMemo,useState} from 'react';
import {ChevronLeft,ChevronRight,CalendarCheck,LoaderCircle,AlertTriangle,Users,Settings2,Plus,X} from 'lucide-react';
import {toast} from 'sonner';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Choice,Badge,Empty,Field,post,load,type R} from './kit';
import {dayOf,dayText} from '@/lib/days';
import './capacity.css';

const WEEK=['dom','seg','ter','qua','qui','sex','sáb'];
const WEEK_FULL=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const TEAM:Record<string,string>={adm:'ADM',turno_a:'Turno A',turno_b:'Turno B'};
const ABS:Record<string,string>={ferias:'Férias',afastamento:'Afastamento',folga:'Folga',falta:'Falta'};
const plus=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86_400_000).toISOString().slice(0,10);
const h=(n:number)=>`${Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2})}`;

export default function CapacityView({manager}:{manager:boolean}){
 const [bar,setBar]=useState<'equinor'|'ocp'>('equinor'),[from,setFrom]=useState(()=>dayOf(Date.now())),[span,setSpan]=useState(14);
 const [today]=useState(()=>dayOf(Date.now()));
 const [data,setData]=useState<R|null>(null),[config,setConfig]=useState<R|null>(null),[error,setError]=useState(''),[open,setOpen]=useState<string|null>(null),[editing,setEditing]=useState(false);
 const to=plus(from,span-1);
 const refresh=useCallback(async()=>{try{const [c,b]=await Promise.all([load<R>(`planning/capacity?bar=${bar}&from=${from}&to=${to}`),load<R>('planning/bars')]);setData(c);setConfig(b);setError('')}catch(e){setError((e as Error).message)}},[bar,from,to]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega a capacidade do período.
 useEffect(()=>{void refresh()},[refresh]);
 const days=useMemo(()=>(data?.days||[]) as R[],[data]);
 const fns=useMemo(()=>{const m=new Map<string,number>();for(const d of days)for(const f of d.byFunction as R[])m.set(f.name,(m.get(f.name)||0)+f.hours);return [...m.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);},[days]);
 const b=data?.bar as R|undefined;
 const people=((config?.people||[]) as R[]).filter(p=>p.active);
 const loose=people.filter(p=>!p.bar||!p.team);
 const mine=people.filter(p=>p.bar===bar);
 const detail=days.find(d=>d.day===open);
 if(error&&!data)return <div className="error-panel"><AlertTriangle/><h2>Capacidade indisponível</h2><p>{error}</p></div>;
 return <div className={`cap-screen bar-${bar}`}>
  <section className="n-panel cap-head">
   <div className="segmented cap-bars" role="group" aria-label="Barra">{(['equinor','ocp'] as const).map(x=><button key={x} type="button" className={bar===x?'active':''} aria-pressed={bar===x} onClick={()=>{setBar(x);setOpen(null)}}><i className={`cap-dot ${x}`}/>{x==='ocp'?'OCP':'Equinor'}</button>)}</div>
   <div className="cap-period"><Button variant="outline" size="icon" aria-label="Período anterior" onClick={()=>setFrom(plus(from,-span))}><ChevronLeft size={16}/></Button>
    <Input type="date" aria-label="Primeiro dia" value={from} onChange={e=>e.target.value&&setFrom(e.target.value)}/>
    <Button variant="outline" size="icon" aria-label="Próximo período" onClick={()=>setFrom(plus(from,span))}><ChevronRight size={16}/></Button>
    <Button variant="outline" onClick={()=>setFrom(today)}><CalendarCheck size={15}/> Hoje</Button>
    <Choice value={String(span)} onChange={v=>setSpan(Number(v))} options={[{value:'7',label:'7 dias'},{value:'14',label:'14 dias'},{value:'31',label:'31 dias'}]}/></div>
  </section>
  {loose.length>0&&<div className="notice"><Users size={17}/><span><b>{loose.length} colaborador(es) ativo(s) sem barra ou sem equipe</b> não entram em nenhuma capacidade: {loose.slice(0,8).map(p=>p.name).join(', ')}{loose.length>8?'…':''}. Configure em Cadastros gerais › Colaboradores.</span></div>}
  <section className="n-panel"><div className="panel-heading"><div><h2>Capacidade em HH · {bar==='ocp'?'OCP':'Equinor'}</h2><p>Horas por dia de quem está na barra, presente e entra no HH, por função atuante. {mine.length} colaborador(es) na barra.</p></div>
   {b&&<div className="cap-zones" title="Zonas da barra"><Badge>Meta {b.zones[0]}%</Badge><Badge>100% = capacidade</Badge><Badge tone="warning">Teto {b.zones[2]}%</Badge></div>}</div>
   {!data?<Skeleton className="h-48 rounded-xl m-4"/>:!mine.length?<Empty icon={Users} title="Nenhum colaborador nesta barra" description="Marque a barra e a equipe de cada colaborador em Cadastros gerais › Colaboradores."/>:
   <div className="table-scroll"><table className="eu-table cap-table"><thead><tr><th>Função</th>{days.map(d=><th key={d.day} className={`num ${d.weekday===0||d.weekday===6?'we':''} ${d.day===today?'today':''}`}><button type="button" className="cap-day" onClick={()=>setOpen(open===d.day?null:d.day)} aria-pressed={open===d.day}><b>{dayText(d.day).slice(0,5)}</b><small>{WEEK[d.weekday]} · {d.shift==='turno_a'?'A':'B'}</small></button></th>)}</tr></thead>
    <tbody>{fns.map(f=><tr key={f}><td>{f}</td>{days.map(d=>{const x=(d.byFunction as R[]).find(y=>y.name===f);return <td key={d.day} className="num">{x?<>{h(x.hours)}<small> · {x.people}</small></>:<span className="muted-text">—</span>}</td>})}</tr>)}
     <tr className="cap-total"><td><b>Total (HH)</b></td>{days.map(d=><td key={d.day} className="num"><b>{h(d.total)}</b>{(d.absent as R[]).length>0&&<small className="cap-abs" title={(d.absent as R[]).map(a=>`${a.name}: ${ABS[a.kind]}`).join('\n')}> · {(d.absent as R[]).length} aus.</small>}</td>)}</tr></tbody></table></div>}
   <p className="muted-text cap-legend">Cada célula: HH · pessoas. A letra indica o turno que trabalha no dia (escala 2x2). Toque num dia para ver quem está e quem falta.</p>
  </section>
  {detail&&<section className="n-panel"><div className="panel-heading"><div><h2>{WEEK_FULL[detail.weekday]}, {dayText(detail.day)} · {h(detail.total)} HH</h2><p>Turno do dia: {TEAM[detail.shift]}. ADM conforme a jornada da barra.</p></div><Button variant="outline" size="sm" onClick={()=>setOpen(null)}><X size={14}/> Fechar</Button></div>
   <div className="cap-detail"><div><h4>Presentes no HH ({(detail.people as R[]).length})</h4><ul>{(detail.people as R[]).map(p=><li key={p.id}><b>{p.name}</b><small>{TEAM[p.team]} · {p.functionName} · {h(p.hours)} h</small></li>)}</ul></div>
    <div><h4>Ausentes ({(detail.absent as R[]).length})</h4>{(detail.absent as R[]).length?<ul>{(detail.absent as R[]).map(p=><li key={p.id}><b>{p.name}</b><small>{TEAM[p.team]} · {ABS[p.kind]}{p.countsHh?'':' · fora do HH'}</small></li>)}</ul>:<p className="muted-text">Ninguém.</p>}</div></div>
  </section>}
  {b&&<section className="n-panel"><div className="panel-heading"><div><h2>Configuração da barra {b.name}</h2><p>{manager?'Jornada, escala e zonas usadas no cálculo. Só a Gestão altera.':'Jornada, escala e zonas usadas no cálculo (só a Gestão altera).'}{b.updatedByName?` Última alteração: ${b.updatedByName}.`:''}</p></div>{manager&&!editing&&<Button variant="outline" onClick={()=>setEditing(true)}><Settings2 size={15}/> Editar</Button>}</div>
   {editing?<BarForm bar={b} onClose={()=>setEditing(false)} onSaved={()=>{setEditing(false);void refresh()}}/>:
   <dl className="cap-config"><div><dt>ADM por dia</dt><dd>{(b.admHours as number[]).map((x,i)=>`${WEEK[i]} ${h(x)} h`).join(' · ')}</dd></div><div><dt>Turno 2x2</dt><dd>{h(b.shiftHours)} h · Turno A começa em {dayText(b.shiftAnchor)} (trabalha 2 dias, folga 2)</dd></div><div><dt>Zonas</dt><dd>meta {b.zones[0]}% · 100% · teto {b.zones[2]}%</dd></div></dl>}
  </section>}
 </div>;
}

function BarForm({bar,onClose,onSaved}:{bar:R,onClose:()=>void,onSaved:()=>void}){
 const [f,setF]=useState<R>({adm:(bar.admHours as number[]).map(String),shift:String(bar.shiftHours),anchor:bar.shiftAnchor,zt:String(bar.zones[0]),zf:String(bar.zones[1]),zc:String(bar.zones[2])}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const num=(v:string)=>Number(String(v).replace(',','.'));
 async function save(){setBusy(true);setError('');
  try{const r=await post('planning/bars/save',{id:bar.id,admHours:(f.adm as string[]).map(num),shiftHours:num(f.shift),shiftAnchor:f.anchor,zoneTarget:num(f.zt),zoneFull:num(f.zf),zoneCeiling:num(f.zc)});toast.success(r.message);onSaved()}
  catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <div className="cap-form"><div className="cap-week">{WEEK.map((w,i)=><label key={w}><span>ADM · {w}</span><Input inputMode="decimal" value={f.adm[i]} onChange={e=>setF(x=>({...x,adm:(x.adm as string[]).map((y,j)=>j===i?e.target.value:y)}))}/></label>)}</div>
  <div className="form-grid"><Field label="Horas do turno 2x2"><Input inputMode="decimal" value={f.shift} onChange={e=>setF(x=>({...x,shift:e.target.value}))}/></Field>
   <Field label="Primeiro dia do Turno A" hint="Âncora da escala: A trabalha esse dia e o seguinte; B os dois seguintes."><Input type="date" value={f.anchor} onChange={e=>setF(x=>({...x,anchor:e.target.value}))}/></Field>
   <Field label="Meta (%)"><Input inputMode="numeric" value={f.zt} onChange={e=>setF(x=>({...x,zt:e.target.value}))}/></Field>
   <Field label="Capacidade (%)"><Input inputMode="numeric" value={f.zf} onChange={e=>setF(x=>({...x,zf:e.target.value}))}/></Field>
   <Field label="Teto de ultrapassagem (%)"><Input inputMode="numeric" value={f.zc} onChange={e=>setF(x=>({...x,zc:e.target.value}))}/></Field></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions cap-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button className="primary-action" disabled={busy} onClick={()=>void save()}>{busy&&<LoaderCircle className="animate-spin" size={16}/>} Salvar</Button></div>
 </div>;
}

/** Ausências do colaborador (Gestão): férias, afastamento, folga ou falta, com período. Fica dentro do
 *  formulário do colaborador; os botões não enviam o formulário. */
export function AbsenceList({operatorId,name}:{operatorId:string,name:string}){
 const [rows,setRows]=useState<R[]|null>(null),[f,setF]=useState<R>({kind:'ferias',start:'',end:'',note:''}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const refresh=useCallback(()=>load<R>('planning/absences?operator='+encodeURIComponent(operatorId)).then(d=>setRows(d.rows as R[]),()=>setRows([])),[operatorId]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega as ausências do colaborador.
 useEffect(()=>{void refresh()},[refresh]);
 async function add(){setBusy(true);setError('');
  try{const r=await post('registry/absences',{operatorId,kind:f.kind,startDay:f.start,endDay:f.end||f.start,note:f.note});toast.success(r.message);setF({kind:'ferias',start:'',end:'',note:''});await refresh()}
  catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function cancel(id:string){try{const r=await post('registry/absences/cancel',{id});toast.success(r.message);await refresh()}catch(e){toast.error((e as Error).message)}}
 return <div className="n-field wide cap-absences"><label>Férias, afastamentos e folgas de {name}</label>
  {rows===null?<Skeleton className="h-10"/>:rows.length?<ul>{rows.map(a=><li key={a.id}><span><b>{ABS[a.kind]}</b> · {a.startDay===a.endDay?dayText(a.startDay):`${dayText(a.startDay)} a ${dayText(a.endDay)}`}{a.note?` · ${a.note}`:''}</span><button type="button" className="text-action danger-text" onClick={()=>void cancel(a.id)}>Cancelar</button></li>)}</ul>:<small className="muted-text">Nenhuma ausência lançada.</small>}
  <div className="cap-abs-add"><Choice value={f.kind} onChange={v=>setF(x=>({...x,kind:v}))} options={Object.entries(ABS).map(([value,label])=>({value,label}))}/>
   <Input type="date" aria-label="Primeiro dia" value={f.start} onChange={e=>setF(x=>({...x,start:e.target.value,end:x.end&&x.end<e.target.value?e.target.value:x.end}))}/>
   <Input type="date" aria-label="Último dia" min={f.start||undefined} value={f.end} onChange={e=>setF(x=>({...x,end:e.target.value}))}/>
   <Input maxLength={300} placeholder="Observação" aria-label="Observação" value={f.note} onChange={e=>setF(x=>({...x,note:e.target.value}))}/>
   <Button type="button" variant="outline" disabled={busy||!f.start} onClick={()=>void add()}>{busy?<LoaderCircle className="animate-spin" size={15}/>:<Plus size={15}/>} Lançar</Button></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
 </div>;
}
