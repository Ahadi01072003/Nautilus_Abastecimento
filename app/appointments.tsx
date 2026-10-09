'use client';
import {useMemo,useState} from 'react';
import {CalendarDays,ClipboardList,Clock,CheckCircle2,Search,ArrowRight,Fuel,UserRound} from 'lucide-react';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import {Table,TableHeader,TableRow,TableHead,TableBody,TableCell} from '@/components/ui/table';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Projeção das colunas retornadas pelo serviço, sem permissões decididas no cliente.
type Row=Record<string,any>;
type Props={rows:Row[];actor:Row;now:number;onOpen:(kind:string,item:Row)=>void;onExecute:(item:Row)=>void;onViewSupply:(item:Row)=>void};
const labels:Record<string,string>={requested:'Solicitada',scheduled:'Agendada',completed:'Realizada',cancelled:'Cancelada'};
const tone:Record<string,string>={requested:'warning',scheduled:'info',completed:'success',cancelled:'muted'};
const date=(value:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const number=(value:number)=>new Intl.NumberFormat('pt-BR',{maximumFractionDigits:3}).format(value);
export default function Appointments({rows,actor,now,onOpen,onExecute,onViewSupply}:Props){
 const [tab,setTab]=useState(actor.role==='fueler'?'schedule':'requests'),[query,setQuery]=useState(''),[status,setStatus]=useState('all');
 const filtered=useMemo(()=>rows.filter(row=>(status==='all'||row.status===status)&&(!query||[row.equipment_tag,row.equipment_name,row.fuel_name,row.requester_name,row.assigned_name,row.id].join(' ').toLowerCase().includes(query.toLowerCase()))),[rows,query,status]);
 const scheduled=useMemo(()=>rows.filter(row=>row.status==='scheduled').sort((a,b)=>a.scheduled_at.localeCompare(b.scheduled_at)),[rows]);
 const canExecute=()=>actor.canFuel;
 return <>
  <div className="appointment-flow" aria-label="Etapas do abastecimento">
   <span><ClipboardList size={18}/><b>1. Solicitar</b>Equipamento e necessidade</span><ArrowRight size={18}/>
   <span><CalendarDays size={18}/><b>2. Agendar</b>Horário e equipe</span><ArrowRight size={18}/>
   <span><Fuel size={18}/><b>3. Realizar</b>Registro em Abastecimentos</span>
  </div>
  <div className="alert-summary appointment-summary">
   <div><ClipboardList size={22}/><strong>{rows.filter(r=>r.status==='requested').length}</strong><span>Aguardando agendamento</span></div>
   <div><CalendarDays size={22}/><strong>{scheduled.length}</strong><span>Agendadas</span></div>
   <div><CheckCircle2 size={22}/><strong>{rows.filter(r=>r.status==='completed').length}</strong><span>Realizadas</span></div>
  </div>
  {actor.role==='requester'&&<div className="notice appointment-notice"><UserRound size={18}/><span>Solicite o abastecimento e acompanhe o andamento. O planejador define o horário; a equipe de abastecimento realiza o registro.</span></div>}
  <Tabs value={tab} onValueChange={setTab}>
   <TabsList className="n-tabs">{actor.role!=='fueler'&&<TabsTrigger value="requests">{actor.role==='requester'?'Minhas solicitações':'Solicitações'}</TabsTrigger>}{actor.role!=='requester'&&<TabsTrigger value="schedule">Agenda de abastecimentos</TabsTrigger>}</TabsList>
   {actor.role!=='fueler'&&<TabsContent value="requests">
    <section className="n-panel">
     <div className="panel-heading"><div><h2>Solicitações de abastecimento</h2><p>Do pedido até o registro realizado, com cada etapa e autor identificados.</p></div><span className="count-label">{filtered.length} solicitações</span></div>
     <div className="filters appointment-filters"><div className="search-field"><Search size={17}/><Input aria-label="Buscar solicitações" placeholder="TAG, equipamento, solicitante ou responsável" value={query} onChange={e=>setQuery(e.target.value)}/></div><select className="appointment-status-select" aria-label="Filtrar situação da solicitação" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">Todas as situações</option>{Object.entries(labels).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></div>
     {filtered.length?<div className="table-scroll"><Table><TableHeader><TableRow><TableHead>Equipamento / TAG</TableHead><TableHead>Solicitante</TableHead><TableHead>Horímetro atual</TableHead><TableHead>Tipo de abastecimento</TableHead><TableHead>Agendamento</TableHead><TableHead>Situação</TableHead><TableHead>Ações</TableHead></TableRow></TableHeader><TableBody>
      {filtered.map(row=><TableRow key={row.id}><TableCell><b>{row.equipment_tag}</b><small>{row.equipment_name}</small></TableCell><TableCell>{row.requester_name}<small>{date(row.created_at)}</small></TableCell><TableCell className="numeric">{number(row.hourmeter_milli/1000)} h</TableCell><TableCell>{row.fuel_name}</TableCell><TableCell>{row.scheduled_at?<><b>{date(row.scheduled_at)}</b><small>{row.assigned_name||'Equipe de abastecimento'}</small></>:<span className="pending-text">A definir</span>}</TableCell><TableCell><span className={`n-badge ${tone[row.status]}`}>{labels[row.status]}</span>{row.status==='cancelled'&&<small className="appointment-cancel-reason">{row.cancel_reason}</small>}</TableCell><TableCell><div className="appointment-row-actions">
       {['requested','scheduled'].includes(row.status)&&actor.canPlan&&<button className="text-action" onClick={()=>onOpen('schedule',row)}>{row.status==='scheduled'?'Reagendar':'Agendar'}</button>}
       {row.status==='scheduled'&&actor.role!=='requester'&&<button className="text-action" onClick={()=>setTab('schedule')}>Ver agenda</button>}
       {row.status==='completed'&&row.supply_id&&actor.canFuel&&<button className="text-action" onClick={()=>onViewSupply(row)}>Ver registro</button>}
       {['requested','scheduled'].includes(row.status)&&(actor.canPlan||row.status==='requested'&&row.requester_id===actor.id)&&<button className="text-action danger-text" onClick={()=>onOpen('appointmentCancel',row)}>Cancelar</button>}
      </div></TableCell></TableRow>)}
     </TableBody></Table></div>:<div className="n-empty"><span><ClipboardList size={26}/></span><h3>{rows.length?'Nenhuma solicitação neste filtro':'A primeira solicitação começa aqui'}</h3><p>{rows.length?'Ajuste a busca ou a situação selecionada.':'Use Solicitar abastecimento no topo para informar o equipamento, a TAG, o horímetro e o combustível.'}</p></div>}
    </section>
   </TabsContent>}
   {actor.role!=='requester'&&<TabsContent value="schedule">
    <section className="n-panel"><div className="panel-heading"><div><h2>Agenda da equipe</h2><p>Horários de Brasília · somente solicitações agendadas e ainda não realizadas.</p></div><CalendarDays size={21}/></div>
     {scheduled.length?<div className="appointment-agenda">{scheduled.map(row=>{
      const overdue=new Date(row.scheduled_at).valueOf()<now;
      return <article className={`appointment-agenda-card ${overdue?'overdue':''}`} key={row.id}>
       <div className="appointment-agenda-time"><CalendarDays size={21}/><b>{date(row.scheduled_at)}</b>{overdue&&<span className="n-badge warning">Horário ultrapassado</span>}</div>
       <div className="appointment-agenda-body"><h3>{row.equipment_tag} <span>· {row.equipment_name}</span></h3><p>{row.fuel_name} · horímetro informado: {number(row.hourmeter_milli/1000)} h</p><div><span><UserRound size={16}/>Responsável previsto: <b>{row.assigned_name||'Equipe de abastecimento'}</b></span><small>Solicitado por {row.requester_name}</small></div></div>
       <div className="appointment-agenda-actions">{actor.canPlan&&<Button variant="outline" onClick={()=>onOpen('schedule',row)}>Reagendar</Button>}{canExecute()?<Button className="primary-action" onClick={()=>onExecute(row)}>Ir para abastecimento <ArrowRight size={16}/></Button>:<span className="appointment-assigned-note">Aguardando a equipe de abastecimento</span>}</div>
      </article>;
     })}</div>:<div className="n-empty"><span><Clock size={26}/></span><h3>Nenhum abastecimento agendado</h3><p>Os pedidos aparecem aqui depois que a equipe define a data e a hora para a equipe.</p></div>}
    </section>
   </TabsContent>}
  </Tabs>
 </>;
}
