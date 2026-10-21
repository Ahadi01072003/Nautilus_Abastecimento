'use client';
// Planejamento de atividade (rascunho com salvamento automático, reservas, documentos,
// revisão e lançamento), Rascunhos e Lista de OS (também usada na Operação).
import {useCallback,useEffect,useMemo,useRef,useState,FormEvent,ReactNode} from 'react';
import {History,Package,PackagePlus,Shapes,ClipboardCheck,Plus,AlertTriangle,LoaderCircle,CheckCircle2,CircleDashed,CloudOff,Rocket,Trash2,X,Wand2,ClipboardList,CalendarRange,Lock,Info,Unlock,Filter,Clock,Users,Truck,MapPin} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Table,TableHeader,TableRow,TableHead,TableBody,TableCell} from '@/components/ui/table';
import {Checkbox} from '@/components/ui/checkbox';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,Toggle,OrgTag,UNITS,fmt,post,load,type R} from './kit';
import {layers,hhmm} from './flows';
import Gantt from './gantt';

/** Horário de Brasília para o campo datetime-local e de volta (com fuso explícito). */
const toLocal=(iso?:string|null)=>iso?new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso)).replace(' ','T'):'';
const toISO=(local:string)=>local?new Date(local+':00-03:00').toISOString():null;
const minutesBetween=(a?:string|null,b?:string|null)=>a&&b?Math.round((Date.parse(b)-Date.parse(a))/60000):null;
export const osLabel=(n:number)=>'OS '+String(n).padStart(6,'0');
const statusNames:Record<string,[string,string]>={programada:['Programada','info'],em_andamento:['Em andamento','success'],encerramento_pendente:['Encerramento pendente','warning'],concluida:['Concluída','muted'],cancelada:['Cancelada','danger']};
const range=(a?:string|null,b?:string|null)=>a&&b?`${fmt(a)} → ${fmt(b)}`:'—';

type Need={equipmentTypeId:string|null,functionId:string|null,materialId:string|null,quantity:number|null,amount:number|null,unit:string|null};
type Step={key:string,id:string,name:string,description:string,required:boolean,included:boolean,dependsOn:string[],defaultMinutes:number|null,start:string,end:string,locationId:string,needs:Need[],equipmentIds:string[],operatorIds:string[]};
type Form={title:string,code:string,description:string,orgId:string,personId:string,locationId:string,start:string,end:string,steps:Step[]};
const fromPlan=(p:R):Form=>({title:p.title||'',code:p.code||'',description:p.description||'',orgId:p.org_id||'',personId:p.requester_person_id||'',locationId:p.location_id||'',start:toLocal(p.planned_start),end:toLocal(p.planned_end),steps:p.steps.map((s:R)=>({key:s.step_key,id:s.id,name:s.name,description:s.description,required:!!s.required,included:!!s.included,dependsOn:s.depends_on,defaultMinutes:s.default_minutes,start:toLocal(s.planned_start),end:toLocal(s.planned_end),locationId:s.location_id||'',needs:s.needs.map((n:R)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,materialId:n.material_id,quantity:n.quantity,amount:n.amount,unit:n.unit})),equipmentIds:s.equipment_ids,operatorIds:s.operator_ids}))});
const toBody=(f:Form)=>({title:f.title,code:f.code,description:f.description,orgId:f.orgId||null,requesterPersonId:f.personId||null,locationId:f.locationId||null,plannedStart:toISO(f.start),plannedEnd:toISO(f.end),steps:f.steps.map(s=>({key:s.key,included:s.included,plannedStart:toISO(s.start),plannedEnd:toISO(s.end),locationId:s.locationId||null,needs:s.needs,equipmentIds:s.included?s.equipmentIds:[],operatorIds:s.included?s.operatorIds:[]}))});

/** Abre a revisão da OS (ou reabre a que já está em rascunho) e leva ao editor. */
export async function startRevision(workOrderId:string,open:(planId:string)=>void){
 try{const r=await post('planning/revision/start',{workOrderId});toast.success(r.message);open(r.id)}catch(e){toast.error((e as Error).message)}
}
const draftLabel=(d:R)=><>{d.work_order_id?<Badge tone="info">Revisão {d.revision} · {osLabel(d.os_number)}</Badge>:<Badge tone="warning">Rascunho</Badge>}{d.free?<Badge>Sem fluxo</Badge>:null}</>;
const osStepNames:Record<string,string>={concluida:'Concluída',dispensada:'Dispensada',em_execucao:'Em execução',pausada:'Pausada',bloqueada:'Bloqueada'};

export function locationPaths(locations:R[]){const out=new Map<string,string>();const path=(l:R,d=0):string=>{if(out.has(l.id))return out.get(l.id)!;const p=l.parent_id&&d<5?locations.find(x=>x.id===l.parent_id):null;const v=p?path(p,d+1)+' › '+l.name:l.name;out.set(l.id,v);return v};locations.forEach(l=>path(l));return out}

/* ───────────────────────── Planejamento (rascunhos e editor) ───────────────────────── */

export default function Planning({view,planId,openPlan,navigate,openOrder,refreshKey}:{view:string,planId:string|null,openPlan:(id:string|null)=>void,navigate:(v:string)=>void,openOrder:(id:string)=>void,refreshKey:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[creating,setCreating]=useState(false),[typeId,setTypeId]=useState(''),[releaseFor,setReleaseFor]=useState<R|null>(null),[reason,setReason]=useState('');
 const refresh=useCallback(async()=>{try{setData(await load<R>('planning'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos de uma consulta assíncrona ao servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey,view]);
 async function createFree(){try{const r=await post('planning/create-free',{});openPlan(r.id);navigate('plan-atividade');await refresh()}catch(err){toast.error((err as Error).message)}}
 async function create(e:FormEvent){e.preventDefault();try{const r=await post('planning/create',{activityTypeId:typeId});setCreating(false);openPlan(r.id);navigate('plan-atividade');await refresh()}catch(err){toast.error((err as Error).message)}}
 async function release(e:FormEvent){e.preventDefault();if(!releaseFor)return;try{const r=await post('planning/release',{id:releaseFor.id,reason});toast.success(r.message);setReleaseFor(null);setReason('');await refresh()}catch(err){toast.error((err as Error).message)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Não foi possível abrir o planejamento</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <div className="loading-grid"><Skeleton className="h-64 rounded-xl"/><Skeleton className="h-64 rounded-xl"/></div>;
 const types=data.activityTypes.filter((t:R)=>t.active&&!t.system);
 const newButton=<div className="access-actions"><Button variant="outline" onClick={()=>void createFree()} title="Título próprio, início e fim pelas datas da OS e recursos livres"><Shapes size={16}/> OS sem fluxo</Button><Button onClick={()=>{setTypeId(types[0]?.id||'');setCreating(true)}} disabled={!types.length}><Plus size={16}/> Novo planejamento</Button></div>;
 const orgs=data.orgs as R[];
 return <>
  {view==='plan-atividade'&&(planId?<PlanEditor key={planId} planId={planId} refs={data} onRefs={refresh} onClose={()=>{openPlan(null);void refresh()}} onReplaced={id=>openPlan(id)} onLaunched={()=>{openPlan(null);navigate('plan-os')}}/>:
   <section className="n-panel"><div className="panel-heading"><div><h2>Planejar uma atividade</h2><p>Escolha o tipo de atividade (as etapas, dependências e necessidades do fluxo vigente são carregadas no rascunho) ou planeje uma OS sem fluxo, só com título, início, fim e recursos.</p></div>{newButton}</div>
    {data.drafts.length?<div className="draft-quick">{data.drafts.slice(0,6).map((d:R)=><button key={d.id} type="button" onClick={()=>openPlan(d.id)}>{draftLabel(d)}<b>{d.activity_name}</b><span>{d.description||'Sem descrição'}</span><small>Salvo em {fmt(d.updated_at)}</small></button>)}</div>:<Empty icon={ClipboardList} title="Nenhum rascunho em andamento" description={types.length?'Comece um planejamento novo. Ele fica salvo como rascunho até você revisar e lançar a OS.':'Sem fluxo cadastrado ainda: planeje uma OS sem fluxo ou cadastre um fluxo em Planejamento › Cadastro de fluxo.'} action={newButton}/>}
   </section>)}
  {view==='plan-rascunhos'&&<section className="n-panel"><div className="panel-heading"><div><h2>Rascunhos</h2><p>{data.actor.manager?'Todos os rascunhos. Rascunhos com reservas seguram equipamentos: libere os esquecidos.':'Seus planejamentos ainda não lançados. Só você e o gestor os veem.'}</p></div>{newButton}</div>
   {data.drafts.length?<div className="table-scroll"><Table><TableHeader><TableRow><TableHead>Atividade</TableHead><TableHead>Solicitante</TableHead><TableHead>Período previsto</TableHead><TableHead>Reservas provisórias</TableHead><TableHead>Última gravação</TableHead>{data.actor.manager&&<TableHead>Responsável</TableHead>}<TableHead/></TableRow></TableHeader><TableBody>{data.drafts.map((d:R)=><TableRow key={d.id}><TableCell>{draftLabel(d)} <b>{d.activity_name}</b><small>{d.description||'Sem descrição'}</small></TableCell><TableCell><OrgTag org={orgs.find(o=>o.id===d.org_id)}/></TableCell><TableCell>{range(d.planned_start,d.planned_end)}</TableCell><TableCell>{d.reservations?<Badge tone="info">{d.reservations} equipamento(s)</Badge>:'—'}</TableCell><TableCell>{fmt(d.updated_at)}</TableCell>{data.actor.manager&&<TableCell>{d.author_name}</TableCell>}<TableCell><div className="access-actions"><Button size="sm" variant="outline" onClick={()=>{openPlan(d.id);navigate('plan-atividade')}}>Abrir</Button>{data.actor.manager&&d.author_id!==data.actor.id&&d.reservations>0&&<button className="icon-action" title="Liberar reservas" aria-label={`Liberar reservas do rascunho de ${d.author_name}`} onClick={()=>setReleaseFor(d)}><Unlock size={16}/></button>}</div></TableCell></TableRow>)}</TableBody></Table></div>:<Empty icon={ClipboardList} title="Nenhum rascunho" description="Rascunhos aparecem aqui até serem lançados ou descartados." action={newButton}/>}
  </section>}
  {view==='plan-os'&&<Orders refreshKey={refreshKey} onExec={openOrder} onRevise={id=>{openPlan(id);navigate('plan-atividade')}}/>}

  <Dialog open={creating} onOpenChange={setCreating}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><CalendarRange size={16}/> PLANEJAMENTO</div><DialogTitle>Novo planejamento</DialogTitle><DialogDescription>As etapas do fluxo vigente do tipo escolhido são copiadas para o rascunho. Mudanças futuras no fluxo não alteram este planejamento.</DialogDescription></DialogHeader>
   <form onSubmit={create}><div className="form-grid"><Field label="Tipo de atividade *" wide><Choice value={typeId} onChange={setTypeId} options={types.map((t:R)=>({value:t.id,label:`${t.code} · ${t.name} (v${t.current_version})`}))}/></Field></div><div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setCreating(false)}>Voltar</Button><Button type="submit" className="primary-action" disabled={!typeId}>Criar rascunho</Button></div></form>
  </DialogContent></Dialog>
  <Dialog open={!!releaseFor} onOpenChange={v=>{if(!v)setReleaseFor(null)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Unlock size={16}/> RESERVAS PROVISÓRIAS</div><DialogTitle>Liberar reservas do rascunho</DialogTitle><DialogDescription>Os equipamentos saem do rascunho de {releaseFor?.author_name} e voltam a ficar disponíveis. O rascunho continua existindo e a ação fica registrada.</DialogDescription></DialogHeader>
   <form onSubmit={release}><div className="form-grid"><Field label="Motivo *" wide><Textarea required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></Field></div><div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setReleaseFor(null)}>Voltar</Button><Button type="submit" className="primary-action">Liberar reservas</Button></div></form>
  </DialogContent></Dialog>
 </>;
}

type SaveState='saved'|'dirty'|'saving'|'error';
function SaveBadge({state,at,message}:{state:SaveState,at:string|null,message:string}){
 if(state==='saving')return <span className="save-state saving" role="status"><LoaderCircle size={15} className="animate-spin"/> Salvando…</span>;
 if(state==='dirty')return <span className="save-state dirty" role="status"><CircleDashed size={15}/> Alterações não salvas</span>;
 if(state==='error')return <span className="save-state error" role="status" title={message}><CloudOff size={15}/> Não salvo</span>;
 return <span className="save-state saved" role="status"><CheckCircle2 size={15}/> Salvo{at?` às ${new Date(at).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'})}`:''}</span>;
}

function PlanEditor({planId,refs,onRefs,onClose,onReplaced,onLaunched}:{planId:string,refs:R,onRefs:()=>Promise<void>,onClose:()=>void,onReplaced:(id:string)=>void,onLaunched:(workOrderId?:string)=>void}){
 const [plan,setPlan]=useState<R|null>(null),[form,setForm]=useState<Form|null>(null),[editable,setEditable]=useState(false),[loadError,setLoadError]=useState('');
 const [saveState,setSaveState]=useState<SaveState>('saved'),[savedAt,setSavedAt]=useState<string|null>(null),[saveError,setSaveError]=useState('');
 const [osSteps,setOsSteps]=useState<R[]|null>(null),[revisionReason,setRevisionReason]=useState(''),[nowMax]=useState(()=>toLocal(new Date(Date.now()+60000).toISOString()));
 const [review,setReview]=useState<R|null>(null),[launching,setLaunching]=useState(false),[changeType,setChangeType]=useState(''),[suggest,setSuggest]=useState<Step[]|null>(null),[confirmDiscard,setConfirmDiscard]=useState(false);
 const version=useRef(0),dirtyTick=useRef(0),launchKey=useRef('');
 const paths=useMemo(()=>locationPaths(refs.locations),[refs.locations]);
 const reload=useCallback(async()=>{try{const r=await load<R>('planning/plan?id='+encodeURIComponent(planId));setPlan(r.plan);setForm(fromPlan(r.plan));setEditable(r.editable);setOsSteps(r.osSteps);version.current=r.plan.version;setSavedAt(r.plan.updated_at);setSaveState('saved');setSaveError('');setLoadError('')}catch(e){setLoadError((e as Error).message)}},[planId]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega o rascunho do servidor.
 useEffect(()=>{void reload()},[reload]);
 const save=useCallback(async(f:Form)=>{
  const tick=dirtyTick.current;setSaveState('saving');
  try{const r=await post('planning/save',{id:planId,version:version.current,...toBody(f)});version.current=r.version;setSavedAt(r.savedAt);setSaveError('');setSaveState(dirtyTick.current===tick?'saved':'dirty');return true}
  catch(e){setSaveError((e as Error).message);setSaveState('error');return false}
 },[planId]);
 // Salvamento automático 2,5 s depois da última alteração; "Salvo" só após confirmação do servidor.
 useEffect(()=>{if(saveState!=='dirty'||!form||!editable)return;const t=setTimeout(()=>void save(form),2500);return()=>clearTimeout(t)},[form,saveState,save,editable]);
 useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(saveState==='dirty'||saveState==='saving'){e.preventDefault()}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[saveState]);
 const update=(fn:(f:Form)=>Form)=>{setForm(f=>f&&fn(f));dirtyTick.current++;setSaveState('dirty')};
 const setStep=(key:string,patch:Partial<Step>)=>update(f=>({...f,steps:f.steps.map(s=>s.key===key?{...s,...patch}:s)}));

 if(loadError)return <div className="error-panel"><AlertTriangle/><h2>Rascunho indisponível</h2><p>{loadError}</p><Button onClick={onClose}>Voltar</Button></div>;
 if(!plan||!form)return <Skeleton className="h-96 rounded-xl"/>;
 const free=!!plan.free;
 // OS sem fluxo: a etapa única acompanha as datas macro (início e fim) da OS.
 const steps=free?form.steps.map(s=>({...s,start:form.start,end:form.end})):form.steps;
 const org=refs.orgs.find((o:R)=>o.id===form.orgId);
 const people=refs.people.filter((p:R)=>p.org_id===form.orgId&&(p.active||p.id===form.personId));
 const order=layers(steps.filter(s=>s.included).map(s=>({key:s.key,dependsOn:s.dependsOn.filter(d=>form.steps.find(x=>x.key===d)?.included)})));
 const reserved=steps.reduce((n,s)=>n+(s.included?s.equipmentIds.length:0),0);

 async function openReview(){if(!form)return;if(saveState!=='saved'&&!(await save(form)))return;try{const v=await load<R>('planning/validate?id='+encodeURIComponent(planId));launchKey.current=crypto.randomUUID();setReview(v)}catch(e){toast.error((e as Error).message)}}
 const revision=!!plan?.work_order_id&&plan.status==='draft';
 // Atividade realizada (Operação): mesmo formulário, registrada depois de feita.
 const realized=plan?.mode==='realizada';
 async function launch(){setLaunching(true);try{const body={id:planId,version:version.current,launchKey:launchKey.current};const r=realized?await post('planning/realize',body):revision?await post('planning/revision/launch',{...body,reason:revisionReason}):await post('planning/launch',body);toast.success(r.message);setReview(null);onLaunched(r.workOrderId)}catch(e){toast.error((e as Error).message);setReview(null);await reload()}finally{setLaunching(false)}}
 async function discard(){try{const r=await post('planning/discard',{id:planId,version:version.current});toast.success(r.message);onClose()}catch(e){toast.error((e as Error).message)}}
 async function doChangeType(){try{if(saveState!=='saved'&&form)await save(form);const r=await post('planning/change-type',{id:planId,version:version.current,activityTypeId:changeType});toast.success(r.message);setChangeType('');onReplaced(r.id)}catch(e){toast.error((e as Error).message);setChangeType('')}}
 function proposeTimes(){
  if(!form?.start){toast.error('Informe o início previsto da atividade para sugerir os horários.');return}
  const end=new Map<string,number>();const out=form.steps.map(s=>({...s}));
  const sorted=[...out].filter(s=>s.included).sort((a,b)=>(order.level.get(a.key)??0)-(order.level.get(b.key)??0));
  for(const s of sorted){const deps=s.dependsOn.map(d=>end.get(d)).filter((x):x is number=>x!=null);const st=Math.max(Date.parse(toISO(form.start)!),...deps);const en=st+(s.defaultMinutes||60)*60000;end.set(s.key,en);s.start=toLocal(new Date(st).toISOString());s.end=toLocal(new Date(en).toISOString())}
  setSuggest(out);
 }

 return <div className="plan-editor"><datalist id="units">{UNITS.map(u=><option key={u} value={u}/>)}</datalist><datalist id="activity-codes">{(refs.codes as string[]||[]).map(c=><option key={c} value={c}/>)}</datalist>
  <div className="plan-bar"><div><Badge tone={plan.status==='draft'&&!revision?'warning':'info'}>{revision?`Revisão ${plan.revision} · ${osLabel(plan.os_number)}`:realized&&plan.status==='draft'?'Atividade realizada':plan.status==='draft'?'Rascunho':plan.os_number?osLabel(plan.os_number):plan.status}</Badge><b>{free?(form.title||'Atividade sem título'):`${plan.activity_code} · ${plan.activity_name}`}</b><small>{realized?'Registro sem planejamento prévio':free?'OS sem fluxo':`Fluxo v${plan.flow_version}`}{form.code?` · ${form.code}`:''} · responsável {plan.author_name}</small></div>
   <div className="plan-bar-actions">{editable&&<SaveBadge state={saveState} at={savedAt} message={saveError}/>}<Button variant="outline" onClick={onClose}>Fechar</Button>{editable&&<Button className="primary-action" onClick={()=>void openReview()} disabled={saveState==='saving'}>{realized?<ClipboardCheck size={16}/>:<Rocket size={16}/>} {realized?'Conferir e registrar':revision?'Conferir e lançar revisão':'Revisar e lançar OS'}</Button>}</div></div>
  {realized&&editable&&<div className="notice"><Info size={17}/><span>Registro de atividade feita sem planejamento (ex.: urgência). Informe o início e o fim reais: ao registrar, a OS é criada já executada, com os recursos usados, e fica marcada como “realizada sem planejamento”. Se houver checklist obrigatório, ela fica em encerramento pendente até o preenchimento em Apontamentos.</span></div>}
  {revision&&editable&&<div className="notice"><Info size={17}/><span>Revisão da {osLabel(plan.os_number)}: a OS segue valendo como está até você lançar a revisão, e as reservas atuais continuam garantidas. Etapas concluídas ou dispensadas não mudam; etapas iniciadas mantêm o início previsto e não saem da OS; etapas não iniciadas retiradas ficam registradas como dispensadas.</span></div>}
  {saveState==='error'&&<div className="form-error" role="alert"><AlertTriangle size={17}/><span>{saveError} <button className="text-action" onClick={()=>form&&void save(form)}>Tentar de novo</button> · <button className="text-action" onClick={()=>void reload()}>Recarregar o rascunho salvo</button></span></div>}
  {!editable&&<div className="notice"><Lock size={17}/><span>Somente leitura: {revision?'esta revisão é de outra pessoa.':'este planejamento não é um rascunho seu.'}</span></div>}
  <fieldset disabled={!editable} className="plan-fieldset">
  <section className="n-panel plan-section"><div className="panel-heading"><div><h2>Dados da atividade</h2><p>O rascunho pode ficar incompleto; só o lançamento exige tudo preenchido.</p></div></div>
   <div className="form-grid plan-grid">
    {free&&<Field label="Código da atividade" hint="Vincula a atividade ao setor. Letras, números, ponto, barra, hífen ou sublinhado."><Input maxLength={30} list="activity-codes" value={form.code} onChange={e=>update(f=>({...f,code:e.target.value.toUpperCase().replace(/\s+/g,'')}))} placeholder="Ex.: MNT-01"/></Field>}
    {free?<Field label="Título da atividade *" wide hint="Aparece na lista de OS, na Operação, no relatório e na planilha."><Input maxLength={160} value={form.title} onChange={e=>update(f=>({...f,title:e.target.value}))} placeholder={realized?'Ex.: Contenção de vazamento no pátio 2':'Ex.: Remoção de sucata do pátio 3'}/></Field>:<Field label="Tipo de atividade" hint={revision?'Não muda na revisão: o fluxo da OS é mantido.':'Trocar o tipo substitui etapas, horários e alocações.'}><Choice disabled={revision} value={plan.activity_type_id} onChange={v=>{if(v!==plan.activity_type_id)setChangeType(v)}} options={refs.activityTypes.filter((t:R)=>(t.active&&!t.system)||t.id===plan.activity_type_id).map((t:R)=>({value:t.id,label:`${t.code} · ${t.name}`}))}/></Field>}
    <Field label="Organização solicitante *" hint={revision?'A organização da OS não muda na revisão.':undefined}><Choice disabled={revision} value={form.orgId} onChange={v=>update(f=>({...f,orgId:v,personId:''}))} options={refs.orgs.filter((o:R)=>o.active||o.id===form.orgId).map((o:R)=>({value:o.id,label:`${o.acronym} · ${o.name}`}))}/></Field>
    <Field label="Pessoa solicitante"><Choice disabled={!form.orgId} value={form.personId||'none'} onChange={v=>update(f=>({...f,personId:v==='none'?'':v}))} options={[{value:'none',label:'Não informada'},...people.map((p:R)=>({value:p.id,label:p.name}))]}/></Field>
    <Field label="Local *"><Choice value={form.locationId} onChange={v=>update(f=>({...f,locationId:v}))} options={refs.locations.filter((l:R)=>l.active||l.id===form.locationId).map((l:R)=>({value:l.id,label:paths.get(l.id)!}))}/></Field>
    <Field label={realized?'Início real (Brasília) *':free?'Início (Brasília) *':'Início previsto (Brasília) *'} hint={realized?'Quando a atividade começou.':free?'Marco de início da OS.':undefined}><Input type="datetime-local" max={realized?nowMax:undefined} value={form.start} onChange={e=>update(f=>({...f,start:e.target.value}))}/></Field>
    <Field label={realized?'Fim real (Brasília) *':free?'Fim (Brasília) *':'Fim previsto (Brasília) *'} hint={form.start&&form.end?`${realized?'Duração':free?'Marco de fim · duração':'Janela de'} ${hhmm(minutesBetween(toISO(form.start),toISO(form.end)))}`:undefined}><Input type="datetime-local" value={form.end} onChange={e=>update(f=>({...f,end:e.target.value}))}/></Field>
    <Field label="Descrição" wide><Textarea maxLength={2000} value={form.description} onChange={e=>update(f=>({...f,description:e.target.value}))} placeholder="O que será feito, observações para a operação"/></Field>
    {org&&<div className="n-field"><label>Etiqueta</label><OrgTag org={org}/></div>}
   </div>
  </section>
  <section className="n-panel plan-section"><div className="panel-heading"><div><h2>{realized?'Recursos usados':free?'Recursos':'Etapas, horários e recursos'}</h2><p>{realized?`Equipamentos, colaboradores e materiais usados entre o início e o fim reais. ${reserved} equipamento(s) no período.`:free?`A OS sem fluxo tem os marcos Início e Fim, iguais às datas acima; na Operação, registra-se o início e o fim da execução. ${reserved} equipamento(s) reservado(s) provisoriamente.`:<>{order.cyclic.length?'':`${steps.filter(s=>s.included).length} etapa(s) incluída(s) · ${reserved} equipamento(s) reservado(s) provisoriamente.`} Etapas sem dependência podem ocorrer em paralelo.</>}</p></div>{editable&&!free&&<Button variant="outline" onClick={proposeTimes}><Wand2 size={16}/> Sugerir horários</Button>}</div>
   <div className="plan-steps">{steps.map(s=><StepCard key={s.key} free={free} onRefs={onRefs} step={s} steps={steps} refs={refs} paths={paths} planId={planId} serverStep={plan.steps.find((x:R)=>x.step_key===s.key)} osStatus={osSteps?.find(o=>o.step_key===s.key)?.status} editable={editable} onChange={patch=>setStep(s.key,patch)}/>)}</div>
  </section>
  </fieldset>
  {editable&&<div className="plan-footer"><button className="text-action danger-text" onClick={()=>setConfirmDiscard(true)}><Trash2 size={14} className="inline"/> {revision?'Descartar revisão':'Descartar rascunho'}</button><Button variant="outline" onClick={()=>void save(form)} disabled={saveState==='saving'}>Salvar agora</Button></div>}

  <Dialog open={!!changeType} onOpenChange={v=>{if(!v)setChangeType('')}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><AlertTriangle size={16}/> TROCAR TIPO DE ATIVIDADE</div><DialogTitle>Substituir as etapas?</DialogTitle><DialogDescription>Serão substituídos: etapas, horários das etapas, equipamentos reservados, colaboradores e documentos de etapa. Serão mantidos: organização, pessoa, local, janela prevista, descrição e documentos gerais.</DialogDescription></DialogHeader><div className="modal-footer"><Button variant="outline" onClick={()=>setChangeType('')}>Cancelar</Button><Button className="primary-action" onClick={()=>void doChangeType()}>Trocar tipo</Button></div></DialogContent></Dialog>
  <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Trash2 size={16}/> DESCARTAR</div><DialogTitle>{revision?'Descartar esta revisão?':'Descartar este rascunho?'}</DialogTitle><DialogDescription>{revision?`A ${osLabel(plan.os_number)} continua exatamente como está, com as reservas atuais. As reservas novas desta revisão são liberadas.`:'As reservas provisórias de equipamentos são liberadas. O rascunho deixa de aparecer nas listas.'}</DialogDescription></DialogHeader><div className="modal-footer"><Button variant="outline" onClick={()=>setConfirmDiscard(false)}>Cancelar</Button><Button className="primary-action" onClick={()=>void discard()}>Descartar</Button></div></DialogContent></Dialog>
  <Dialog open={!!suggest} onOpenChange={v=>{if(!v)setSuggest(null)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Wand2 size={16}/> SUGESTÃO</div><DialogTitle>Horários pelas durações padrão</DialogTitle><DialogDescription>A partir do início previsto, respeitando as dependências (etapas sem dependência começam juntas). Etapas sem duração padrão usam 01:00. Nada é aplicado sem sua confirmação.</DialogDescription></DialogHeader>
   <ul className="suggest-list">{suggest?.filter(s=>s.included).map(s=><li key={s.key}><b>{s.name}</b><span>{s.start.replace('T',' ')} → {s.end.replace('T',' ')}</span></li>)}</ul>
   <div className="modal-footer"><Button variant="outline" onClick={()=>setSuggest(null)}>Cancelar</Button><Button className="primary-action" onClick={()=>{const s=suggest!;update(f=>({...f,steps:f.steps.map(x=>{const n=s.find(y=>y.key===x.key)!;return x.included?{...x,start:n.start,end:n.end}:x})}));setSuggest(null)}}>Aplicar horários</Button></div>
  </DialogContent></Dialog>
  <Dialog open={!!review} onOpenChange={v=>{if(!launching&&!v)setReview(null)}}><DialogContent className="n-dialog n-dialog-wide"><DialogHeader><div className="modal-eyebrow"><Rocket size={16}/> {realized?'REGISTRAR ATIVIDADE REALIZADA':revision?`REVISÃO ${plan.revision} · ${osLabel(plan.os_number)}`:'REVISAR E LANÇAR'}</div><DialogTitle>{free?(form.title||'Atividade sem título'):plan.activity_name}{org?` · ${org.acronym}`:''}</DialogTitle><DialogDescription>{realized?'O registro cria a OS já executada, com o início e o fim informados, confirma os equipamentos usados no período e registra a execução como lançamento posterior. Confira antes de registrar.':revision?'O lançamento troca, de uma vez, o planejamento e as reservas da OS pelos desta revisão. O número da OS, a execução registrada e os apontamentos são mantidos; a versão anterior fica no histórico.':'Você mesmo revisa e lança; não há aprovação de terceiro. O lançamento cria o número da OS, congela este planejamento, confirma as reservas e publica a OS na Operação.'}</DialogDescription></DialogHeader>
   {review&&<div className="review">
    <div className="review-grid"><div><small>Solicitante</small><OrgTag org={org}/></div><div><small>Local</small><b>{paths.get(form.locationId)||'—'}</b></div><div><small>{realized?'Execução':'Janela prevista'}</small><b>{range(toISO(form.start),toISO(form.end))}</b></div>{form.code&&<div><small>Código</small><b>{form.code}</b></div>}</div>
    <ol className="review-steps">{steps.filter(s=>s.included).map(s=><li key={s.key}><b>{free?'Início → Fim':s.name}</b><span>{range(toISO(s.start),toISO(s.end))}</span><small>{[...s.equipmentIds.map(e=>refs.equipment.find((x:R)=>x.id===e)?.tag),...s.operatorIds.map(o=>refs.operators.find((x:R)=>x.id===o)?.name)].filter(Boolean).join(' · ')||'Sem recursos identificados'}</small>{s.needs.length>0&&<small>Necessidades: {s.needs.map(n=>needLabel(n,refs)).join(' · ')}</small>}</li>)}</ol>
    {revision&&<div className="revision-changes"><b>O que muda</b>{review.changes?.length?<ul>{review.changes.map((c:string,i:number)=><li key={i}>{c}</li>)}</ul>:<p>Nenhuma diferença em relação à versão vigente.</p>}</div>}
    {review.errors.length?<div className="form-error"><AlertTriangle size={17}/><div><b>{review.errors.length} pendência(s) impedem {realized?'o registro':'o lançamento'}</b><ul>{review.errors.map((e:R,i:number)=><li key={i}>{e.message}</li>)}</ul></div></div>:<div className="notice"><CheckCircle2 size={17}/><span>Sem pendências. Pronto para {realized?'registrar':'lançar'}.</span></div>}
    {review.warnings.length>0&&<div className="notice warn"><Info size={17}/><div><b>Avisos</b><ul>{review.warnings.map((e:R,i:number)=><li key={i}>{e.message}</li>)}</ul></div></div>}
    {revision&&<div className="form-grid"><Field label="Motivo da revisão *" wide hint="Fica no histórico da OS e na auditoria. Etapas retiradas são dispensadas com este motivo."><Textarea required maxLength={1200} value={revisionReason} onChange={e=>setRevisionReason(e.target.value)}/></Field></div>}
   </div>}
   <div className="modal-footer"><Button variant="outline" onClick={()=>setReview(null)} disabled={launching}>Voltar e corrigir</Button><Button className="primary-action" onClick={()=>void launch()} disabled={launching||!!review?.errors.length||(revision&&(!revisionReason.trim()||!review?.changes?.length))}>{launching?<><LoaderCircle className="animate-spin" size={16}/> {realized?'Registrando…':'Lançando…'}</>:<>{realized?<ClipboardCheck size={16}/>:<Rocket size={16}/>} {realized?'Registrar atividade':revision?'Lançar revisão':'Lançar OS'}</>}</Button></div>
  </DialogContent></Dialog>
 </div>;
}

/** Necessidade legível: “2× Empilhadeira”, “3× Operador”, “12,5 L Óleo hidráulico”. */
export function needLabel(n:R,refs:R){
 const name=(list:string,id:string|null)=>(refs[list] as R[]|undefined)?.find(x=>x.id===id)?.name||'—';
 const material=n.materialId??n.material_id,type=n.equipmentTypeId??n.equipment_type_id,fn=n.functionId??n.function_id;
 if(material)return `${Number(n.amount).toLocaleString('pt-BR',{maximumFractionDigits:3})} ${n.unit} ${name('materials',material)}`;
 return `${n.quantity}× ${type?name('equipmentTypes',type):name('functions',fn)}`;
}

function StepCard({step:s,steps,refs,paths,planId,serverStep,osStatus,free=false,onRefs,editable:canEdit,onChange}:{step:Step,steps:Step[],refs:R,paths:Map<string,string>,planId:string,serverStep:R,osStatus?:string,free?:boolean,onRefs:()=>Promise<void>,editable:boolean,onChange:(p:Partial<Step>)=>void}){
 // Revisão de OS: etapa concluída/dispensada não muda; etapa iniciada mantém início e não sai da OS.
 const frozen=osStatus==='concluida'||osStatus==='dispensada',started=!!osStatus&&osStatus!=='nao_iniciada'&&!frozen;
 const editable=canEdit&&!frozen;
 const [avail,setAvail]=useState<Record<string,R>>({}),[showAll,setShowAll]=useState(false);
 const startISO=toISO(s.start),endISO=toISO(s.end),valid=!!startISO&&!!endISO&&Date.parse(endISO)>Date.parse(startISO);
 // Consulta a agenda do intervalo da etapa (o servidor revalida ao gravar).
 useEffect(()=>{if(!valid||!s.included||!editable)return;const t=setTimeout(async()=>{try{const r=await load<R>(`planning/availability?start=${encodeURIComponent(startISO!)}&end=${encodeURIComponent(endISO!)}&planId=${planId}&stepId=${serverStep?.id||''}`);setAvail(Object.fromEntries(r.equipment.map((e:R)=>[e.id,e])))}catch{/* sem prévia: a gravação confere */}},400);return()=>clearTimeout(t)},[valid,startISO,endISO,s.included,editable,planId,serverStep?.id]);
 const deps=s.dependsOn.map(d=>steps.find(x=>x.key===d)).filter(Boolean) as Step[];
 const typeNeeds=s.needs.filter(n=>n.equipmentTypeId),fnNeeds=s.needs.filter(n=>n.functionId);
 const neededTypes=typeNeeds.map(n=>n.equipmentTypeId);
 const equipment=(refs.equipment as R[]).filter(e=>(e.active||s.equipmentIds.includes(e.id))&&(showAll||!neededTypes.length||neededTypes.includes(e.type_id)||s.equipmentIds.includes(e.id)));
 const operators=(refs.operators as R[]).filter(o=>o.active||s.operatorIds.includes(o.id));
 const name=(list:string,id:string|null)=>(refs[list] as R[]).find(x=>x.id===id)?.name||'—';
 const dur=minutesBetween(startISO,endISO);
 return <article className={`step-card ${s.included?'':'excluded'}`}>
  <header><div><b>{free?'Início → Fim da OS':s.name}</b>{!s.required&&<Badge>Opcional</Badge>}{osStatus&&osStatus!=='nao_iniciada'&&<Badge tone={frozen?'muted':'success'}>{osStepNames[osStatus]}{frozen?' · não muda':''}</Badge>}{deps.length>0&&<small>Após: {deps.map(d=>d.name+(d.included?'':' (não incluída — ignorada)')).join(', ')}</small>}{s.defaultMinutes!=null&&<small><Clock size={12} className="inline"/> Duração padrão {hhmm(s.defaultMinutes)}</small>}</div>
   {!s.required&&!frozen&&!started&&<Toggle title="Incluir etapa" checked={s.included} onChange={v=>onChange({included:v})}/>}</header>
  {s.included&&<fieldset disabled={frozen} className="plan-fieldset"><div className="form-grid">
   {free?<div className="n-field wide"><label>Marcos</label><small>Início {s.start?s.start.replace('T',' '):'—'} · Fim {s.end?s.end.replace('T',' '):'—'}{dur!=null&&dur>0?` · duração ${hhmm(dur)}`:''}. Ajuste nas datas da atividade, acima.</small></div>:<>
   <Field label="Início (Brasília)" hint={started?'Etapa iniciada: o início previsto é a referência do desvio e não muda.':undefined}><Input type="datetime-local" disabled={started} value={s.start} onChange={e=>onChange({start:e.target.value})}/></Field>
   <Field label="Fim (Brasília)" hint={dur!=null?(dur>0?`Duração ${hhmm(dur)}`:'O fim deve ser depois do início'):undefined}><Input type="datetime-local" value={s.end} onChange={e=>onChange({end:e.target.value})}/></Field></>}
   <Field label="Local específico da etapa"><Choice value={s.locationId||'none'} onChange={v=>onChange({locationId:v==='none'?'':v})} options={[{value:'none',label:'Mesmo local da atividade'},...(refs.locations as R[]).filter(l=>l.active||l.id===s.locationId).map(l=>({value:l.id,label:paths.get(l.id)!}))]}/></Field>
   <div className="n-field wide"><label>Necessidades de recursos</label><div className="need-chips">{s.needs.length?s.needs.map((n,i)=><span key={i} className="need-chip">{n.materialId?<Package size={13}/>:n.equipmentTypeId?<Truck size={13}/>:<Users size={13}/>}{n.materialId?<><input type="number" min={0.001} step="any" aria-label="Quantidade" className="amount" value={n.amount??''} onChange={e=>onChange({needs:s.needs.map((x,j)=>j===i?{...x,amount:Number(e.target.value)||0}:x)})}/><input aria-label="Unidade de medida" className="unit" maxLength={12} list="units" value={n.unit??''} onChange={e=>onChange({needs:s.needs.map((x,j)=>j===i?{...x,unit:e.target.value}:x)})}/>{name('materials',n.materialId)}</>:<><input type="number" min={1} max={99} aria-label="Quantidade" value={n.quantity??1} onChange={e=>onChange({needs:s.needs.map((x,j)=>j===i?{...x,quantity:Math.min(99,Math.max(1,Number(e.target.value)||1))}:x)})}/>× {n.equipmentTypeId?name('equipmentTypes',n.equipmentTypeId):name('functions',n.functionId)}</>}<button type="button" aria-label="Remover necessidade" onClick={()=>onChange({needs:s.needs.filter((_,j)=>j!==i)})}><X size={12}/></button></span>):<small>Nenhuma necessidade informada.</small>}</div>
    {editable&&<NeedAdder refs={refs} needs={s.needs} onRefs={onRefs} onAdd={n=>onChange({needs:[...s.needs,n]})}/>}</div>
   <fieldset className="n-field wide"><legend>Equipamentos identificados {typeNeeds.length>0&&<small>({typeNeeds.map(n=>`${n.quantity}× ${name('equipmentTypes',n.equipmentTypeId)}`).join(', ')})</small>}</legend>
    {!valid?<small className="pending-text">Informe início e fim da etapa para consultar a agenda e reservar equipamentos.</small>:<div className="resource-list">{equipment.map(e=>{const a=avail[e.id];const chosen=s.equipmentIds.includes(e.id);const blocked=a&&a.status!=='livre'&&!chosen;return <label key={e.id} className={`resource ${a?.status||''} ${chosen?'chosen':''}`}><Checkbox checked={chosen} disabled={!!blocked} onCheckedChange={v=>onChange({equipmentIds:v?[...s.equipmentIds,e.id]:s.equipmentIds.filter(x=>x!==e.id)})}/><span><b>{e.tag}</b><small>{name('equipmentTypes',e.type_id)}{e.capacity?` · ${e.capacity}`:''}</small>{a&&a.status!=='livre'&&<em>{a.detail}</em>}</span><Badge tone={!a?'muted':a.status==='livre'?'success':a.status==='bloqueado'?'danger':'warning'}>{!a?(editable?'Consultando…':chosen?'Reservado aqui':'—'):a.status==='livre'?'Livre':a.status==='bloqueado'?'Bloqueado':chosen?'Reservado aqui':'Reservado'}</Badge></label>})}{neededTypes.length>0&&<button type="button" className="text-action" onClick={()=>setShowAll(v=>!v)}>{showAll?'Mostrar só os tipos necessários':'Mostrar todos os equipamentos'}</button>}</div>}
    {valid&&<small>A reserva provisória começa quando o rascunho é salvo; antes disso, a seleção não garante exclusividade.</small>}
   </fieldset>
   <fieldset className="n-field wide"><legend>Colaboradores {fnNeeds.length>0&&<small>({fnNeeds.map(n=>`${n.quantity}× ${name('functions',n.functionId)}`).join(', ')})</small>}</legend>
    <div className="resource-list people">{operators.map(o=>{const fits=fnNeeds.some(n=>o.function_ids.includes(n.functionId));return <label key={o.id} className={`resource ${s.operatorIds.includes(o.id)?'chosen':''}`}><Checkbox checked={s.operatorIds.includes(o.id)} onCheckedChange={v=>onChange({operatorIds:v?[...s.operatorIds,o.id]:s.operatorIds.filter(x=>x!==o.id)})}/><span><b>{o.name}</b><small>{o.function_ids.map((f:string)=>name('functions',f)).join(', ')||'Sem função'}</small></span>{fits&&<Badge tone="info">Função exigida</Badge>}</label>})}</div>
   </fieldset>
  </div></fieldset>}
 </article>;
}

const KINDS:[string,string,string][]=[['equipment_type','Equipamento (tipo)','equipmentTypes'],['function','Função','functions'],['material','Material','materials']];
/** Adiciona uma necessidade (tipo de equipamento, função ou material). Se o recurso não existe,
 * é cadastrado na hora (o servidor devolve o cadastro existente quando o nome já existe). */
function NeedAdder({refs,needs,onRefs,onAdd}:{refs:R,needs:Need[],onRefs:()=>Promise<void>,onAdd:(n:Need)=>void}){
 const [open,setOpen]=useState(false),[kind,setKind]=useState('equipment_type'),[item,setItem]=useState(''),[qty,setQty]=useState('1'),[unit,setUnit]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false);
 const list=KINDS.find(k=>k[0]===kind)![2];
 const taken=(id:string)=>needs.some(n=>(kind==='material'?n.materialId:kind==='function'?n.functionId:n.equipmentTypeId)===id);
 const options=(refs[list] as R[]||[]).filter(x=>x.active&&!taken(x.id));
 const creating=item==='__new';
 const reset=()=>{setItem('');setQty('1');setUnit('');setName('')};
 async function add(){
  setBusy(true);
  try{
   let id=item,u=unit;
   if(creating){const r=await post('planning/resource',{kind,name,unit:kind==='material'?unit:undefined});toast.success(r.message);await onRefs();id=r.id;u=unit||r.unit||'';}
   if(!id)return;
   if(kind==='material'){const amount=Number(String(qty).replace(',','.'));if(!(amount>0)){toast.error('Informe a quantidade do material.');return}if(!u.trim()){toast.error('Informe a unidade de medida.');return}onAdd({equipmentTypeId:null,functionId:null,materialId:id,quantity:null,amount,unit:u.trim()})}
   else{const q=Math.min(99,Math.max(1,Math.round(Number(qty))||1));onAdd({equipmentTypeId:kind==='equipment_type'?id:null,functionId:kind==='function'?id:null,materialId:null,quantity:q,amount:null,unit:null})}
   reset();setOpen(false);
  }catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 if(!open)return <button type="button" className="text-action" onClick={()=>setOpen(true)}><PackagePlus size={14} className="inline"/> Adicionar recurso</button>;
 return <div className="need-adder">
  <Choice label="Tipo de recurso" value={kind} onChange={v=>{setKind(v);reset()}} options={KINDS.map(([value,label])=>({value,label}))}/>
  <Choice label="Recurso" value={item} onChange={v=>{setItem(v);if(kind==='material'&&v!=='__new')setUnit((refs.materials as R[]).find(m=>m.id===v)?.unit||'')}} placeholder="Escolha" options={[...options.map(x=>({value:x.id,label:kind==='material'?`${x.name} (${x.unit})`:x.name})),{value:'__new',label:'+ Cadastrar novo…'}]}/>
  {creating&&<Input aria-label="Nome do novo recurso" maxLength={100} placeholder={kind==='material'?'Nome do material':kind==='function'?'Nome da função':'Nome do tipo de equipamento'} value={name} onChange={e=>setName(e.target.value)}/>}
  <Input aria-label="Quantidade" className="qty" inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)}/>
  {kind==='material'?<Input aria-label="Unidade de medida" className="unit" list="units" maxLength={12} placeholder="un" value={unit} onChange={e=>setUnit(e.target.value)}/>:<span className="unit-fixed">{kind==='function'?'pessoa(s)':'equipamento(s)'}</span>}
  <Button type="button" size="sm" disabled={busy||!item||(creating&&!name.trim())} onClick={()=>void add()}>{busy?<LoaderCircle size={14} className="animate-spin"/>:<Plus size={14}/>} {creating?'Cadastrar e adicionar':'Adicionar'}</Button>
  <button type="button" className="text-action" onClick={()=>{reset();setOpen(false)}}>Cancelar</button>
 </div>;
}

/* ───────────────────────── Lista de OS (Planejamento) ───────────────────────── */

// A execução da OS fica em Operação › Apontamentos; daqui ela é aberta por onExec.
export function Orders({refreshKey,onExec,onRevise}:{refreshKey:number,onExec:(id:string)=>void,onRevise:(planId:string)=>void}){
 const [refs,setRefs]=useState<R|null>(null),[rows,setRows]=useState<R|null>(null),[error,setError]=useState(''),[filters,setFilters]=useState<R>({from:'',to:'',org:'',type:'',location:'',status:'',number:'',code:''}),[detail,setDetail]=useState<R|null>(null),[cancel,setCancel]=useState(''),[busy,setBusy]=useState(false);
 const query=useMemo(()=>new URLSearchParams(Object.entries({...filters,from:filters.from?toISO(filters.from):'',to:filters.to?toISO(filters.to):''}).filter(([,v])=>v) as [string,string][]).toString(),[filters]);
 const refresh=useCallback(async()=>{try{const [r,o]=await Promise.all([load<R>('orders/refs'),load<R>('orders?'+query)]);setRefs(r);setRows(o);setError('')}catch(e){setError((e as Error).message)}},[query]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Lista vinda do servidor (mesma fonte para lista e contagens).
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 // Atualização periódica para refletir lançamentos e bloqueios de outras pessoas.
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh()},45000);return()=>clearInterval(t)},[refresh]);
 const paths=useMemo(()=>refs?locationPaths(refs.locations):new Map(),[refs]);
 // Lista ou Gantt: a escolha fica na sessão (mesma fonte e mesmos filtros nos dois).
 const [display,setDisplay]=useState<'lista'|'gantt'>('lista');
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Preferência da sessão lida após montar.
 useEffect(()=>{try{if(sessionStorage.getItem('nautilus.orders.display')==='gantt')setDisplay('gantt')}catch{}},[]);
 const showAs=(d:'lista'|'gantt')=>{setDisplay(d);try{sessionStorage.setItem('nautilus.orders.display',d)}catch{}};
 const ganttQuery=useMemo(()=>new URLSearchParams(Object.entries(filters).filter(([k,v])=>v&&k!=='from'&&k!=='to') as [string,string][]).toString(),[filters]);
 async function openDetail(o:R){try{const r=await load<R>('planning/plan?id='+encodeURIComponent(o.current_plan_id));setDetail({order:o,...r})}catch(e){toast.error((e as Error).message)}}
 async function doCancel(e:FormEvent){e.preventDefault();if(!detail)return;setBusy(true);try{const r=await post('planning/cancel',{id:detail.plan.id,version:detail.order.version,reason:cancel});toast.success(r.message);setDetail(null);setCancel('');await refresh()}catch(err){toast.error((err as Error).message)}finally{setBusy(false)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Não foi possível carregar as OS</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!refs||!rows)return <Skeleton className="h-96 rounded-xl"/>;
 const f=(k:string,v:string)=>setFilters(x=>({...x,[k]:v}));
 const orgOf=(id:string)=>refs.orgs.find((o:R)=>o.id===id);
 const status=(o:R)=><span className="status-cell"><Badge tone={statusNames[o.status]?.[1]}>{statusNames[o.status]?.[0]}</Badge>{o.origin==='realizada'&&<Badge>Realizada sem planejamento</Badge>}{o.late&&<Badge tone="danger">Início vencido</Badge>}{o.blocked_resources>0&&<Badge tone="danger"><Lock size={11}/> Equipamento bloqueado</Badge>}</span>;
 return <div className="orders">
  <section className="n-panel"><div className="filters order-filters"><Filter size={16} aria-hidden/>
   <label className="date-filter"><span>De</span><input type="datetime-local" aria-label="Período: de" value={filters.from} onChange={e=>f('from',e.target.value)}/></label>
   <label className="date-filter"><span>Até</span><input type="datetime-local" aria-label="Período: até" value={filters.to} onChange={e=>f('to',e.target.value)}/></label>
   <Choice label="Organização" value={filters.org||'all'} onChange={v=>f('org',v==='all'?'':v)} options={[{value:'all',label:'Todas as organizações'},...refs.orgs.map((o:R)=>({value:o.id,label:o.acronym+' · '+o.name}))]}/>
   <Choice label="Tipo de atividade" value={filters.type||'all'} onChange={v=>f('type',v==='all'?'':v)} options={[{value:'all',label:'Todos os tipos'},...refs.activityTypes.map((t:R)=>({value:t.id,label:t.code+' · '+t.name}))]}/>
   <Choice label="Local" value={filters.location||'all'} onChange={v=>f('location',v==='all'?'':v)} options={[{value:'all',label:'Todos os locais'},...refs.locations.map((l:R)=>({value:l.id,label:paths.get(l.id)||l.name}))]}/>
   <Choice label="Situação" value={filters.status||'padrao'} onChange={v=>f('status',v==='padrao'?'':v)} options={[{value:'padrao',label:'Sem canceladas'},{value:'todas',label:'Todas, inclusive canceladas'},...Object.entries(statusNames).map(([value,[label]])=>({value,label}))]}/>
   <Input className="number-filter" aria-label="Número da OS" placeholder="Nº da OS" inputMode="numeric" value={filters.number} onChange={e=>f('number',e.target.value)}/>
   <Input className="number-filter" aria-label="Código da atividade" placeholder="Código" value={filters.code} onChange={e=>f('code',e.target.value.toUpperCase())}/>
   {Object.values(filters).some(Boolean)&&<button className="text-action" onClick={()=>setFilters({from:'',to:'',org:'',type:'',location:'',status:'',number:'',code:''})}>Limpar</button>}
  </div>
  <div className="display-toggle"><div className="segmented" role="group" aria-label="Exibição"><button type="button" aria-pressed={display==='lista'} onClick={()=>showAs('lista')}>Lista</button><button type="button" aria-pressed={display==='gantt'} onClick={()=>showAs('gantt')}>Gantt</button></div>{display==='gantt'&&<small>O Gantt usa os mesmos filtros; o período é o intervalo visível.</small>}</div>
  {display==='gantt'?<Gantt query={ganttQuery} orgs={refs.orgs} onOpen={onExec}/>:<>
  <div className="org-counts" aria-label="OS por organização solicitante">{Object.entries(rows.counts as Record<string,number>).sort((a,b)=>b[1]-a[1]).map(([org,n])=><span key={org}><OrgTag org={orgOf(org)}/><b>{n}</b><small>{Math.round(100*n/Math.max(1,rows.total))}%</small></span>)}<span className="org-total">{rows.total} OS{rows.scoped?' no seu escopo':''}{filters.from||filters.to?' com programação no período':''}</span></div>
  {rows.orders.length?<>
   <div className="table-scroll orders-table"><Table><TableHeader><TableRow><TableHead>OS</TableHead><TableHead>Atividade</TableHead><TableHead>Solicitante</TableHead><TableHead>Local</TableHead><TableHead>Período planejado</TableHead><TableHead>Real</TableHead><TableHead>Situação</TableHead><TableHead>Etapas</TableHead></TableRow></TableHeader><TableBody>{rows.orders.map((o:R)=><TableRow key={o.id} className="clickable" onClick={()=>void openDetail(o)}><TableCell><button className="tag-label" onClick={e=>{e.stopPropagation();void openDetail(o)}}>{osLabel(o.number)}</button></TableCell><TableCell><b>{o.activity_name}</b><small>{[o.activity_code,o.description].filter(Boolean).join(' · ')||'—'}</small></TableCell><TableCell><OrgTag org={orgOf(o.org_id)}/></TableCell><TableCell>{paths.get(o.location_id)||'—'}</TableCell><TableCell>{range(o.planned_start,o.planned_end)}</TableCell><TableCell>{o.actual_start?range(o.actual_start,o.actual_end||new Date().toISOString()):'—'}</TableCell><TableCell>{status(o)}</TableCell><TableCell>{o.steps_done}/{o.steps_total}</TableCell></TableRow>)}</TableBody></Table></div>
   <ul className="order-cards">{rows.orders.map((o:R)=><li key={o.id}><button type="button" onClick={()=>void openDetail(o)}><div><b>{osLabel(o.number)}</b><OrgTag org={orgOf(o.org_id)}/></div><span>{o.activity_name}</span><small><CalendarRange size={12} className="inline"/> {range(o.planned_start,o.planned_end)}</small><small><MapPin size={12} className="inline"/> {paths.get(o.location_id)||'—'}</small>{status(o)}</button></li>)}</ul>
  </>:<Empty icon={ClipboardList} title="Nenhuma OS encontrada" description="OS lançadas aparecem aqui. Rascunhos ficam em Planejamento › Rascunhos."/>}
  </>}
  </section>

  <Dialog open={!!detail} onOpenChange={v=>{if(!busy&&!v){setDetail(null);setCancel('')}}}><DialogContent className="n-dialog n-dialog-wide">{detail&&<><DialogHeader><div className="modal-eyebrow"><ClipboardList size={16}/> {osLabel(detail.order.number)} · PLANEJAMENTO</div><DialogTitle>{detail.plan.activity_name}</DialogTitle><DialogDescription>Lançada por {detail.order.launched_by_name} em {fmt(detail.order.launched_at)} · {detail.plan.free?'OS sem fluxo':`fluxo ${detail.plan.activity_code} v${detail.plan.flow_version}`}{detail.order.revision?` · revisão ${detail.order.revision}`:''}</DialogDescription></DialogHeader>
   <OrderSummary detail={detail} refs={refs} paths={paths} status={status}/>
   <div className="access-actions"><Button variant="outline" onClick={()=>{const id=detail.order.id;setDetail(null);onExec(id)}}>Abrir em Apontamentos</Button>{refs.canPlan&&['programada','em_andamento'].includes(detail.order.status)&&<Button variant="outline" onClick={()=>{const id=detail.order.id;setDetail(null);void startRevision(id,onRevise)}}><History size={15}/> Revisar OS</Button>}</div>
   {refs.canPlan&&detail.order.status==='programada'&&<form onSubmit={doCancel} className="cancel-box"><Field label="Cancelar OS · motivo" wide hint="Libera as reservas. A OS continua consultável como cancelada."><Textarea required maxLength={1200} value={cancel} onChange={e=>setCancel(e.target.value)}/></Field><Button type="submit" variant="outline" disabled={busy||!cancel.trim()}>Cancelar OS</Button></form>}
  </>}</DialogContent></Dialog>
 </div>;
}

function OrderSummary({detail,refs,paths,status}:{detail:R,refs:R,paths:Map<string,string>,status:(o:R)=>ReactNode}){
 const {plan,order,impediments}=detail;
 const name=(list:string,id:string)=>(refs[list] as R[]).find(x=>x.id===id);
 const person=refs.people.find((p:R)=>p.id===plan.requester_person_id);
 return <div className="review">
  <div className="review-grid"><div><small>Situação</small>{status(order)}</div><div><small>Solicitante</small><OrgTag org={name('orgs',order.org_id)}/>{person&&<small>{person.name}</small>}</div><div><small>Local</small><b>{paths.get(order.location_id)||'—'}</b></div><div><small>Período planejado</small><b>{range(order.planned_start,order.planned_end)}</b></div></div>
  {plan.description&&<p className="flow-description">{plan.description}</p>}
  {order.cancel_reason&&<div className="notice warn"><Info size={17}/><span>Cancelada: {order.cancel_reason}</span></div>}
  {detail.revisions?.length>1&&<div className="revision-history"><b>Histórico de versões</b><ol>{(detail.revisions as R[]).map(r=><li key={r.id}><Badge tone={r.status==='launched'?'info':'muted'}>{r.revision?`Revisão ${r.revision}`:'Original'}</Badge><span>{fmt(r.launched_at)}{r.launched_by_name?` · ${r.launched_by_name}`:''}</span>{r.revision_reason&&<small>{r.revision_reason}</small>}</li>)}</ol></div>}
  <ol className="review-steps">{plan.steps.filter((s:R)=>s.included).map((s:R)=><li key={s.id}><b>{s.name}</b><span>{range(s.planned_start,s.planned_end)}{s.location_id?` · ${paths.get(s.location_id)}`:''}</span><small>{s.equipment_ids.map((e:string)=>{const blocked=impediments.find((i:R)=>i.equipment_id===e);return (name('equipment',e)?.tag||'')+(blocked?` (bloqueado: ${blocked.reason})`:'')}).join(' · ')}{s.equipment_ids.length&&s.operator_ids.length?' · ':''}{s.operator_ids.map((o:string)=>name('operators',o)?.name).join(' · ')}</small>{s.needs.length>0&&<small>Necessidades: {s.needs.map((n:R)=>needLabel(n,refs)).join(' · ')}</small>}</li>)}</ol>
 </div>;
}

/* ───────────────────────── Operação › Registrar atividade realizada ───────────────────────── */

/** Atividade feita sem planejamento (urgência): mesmo formulário da OS sem fluxo, com início e fim
 * reais; ao registrar, a OS nasce executada e marcada como realizada sem planejamento. */
export function RealizedActivities({refreshKey,openOrder}:{refreshKey:number,openOrder:(id:string)=>void}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[planId,setPlanId]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const refresh=useCallback(async()=>{try{setData(await load<R>('planning?mode=realizada'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Rascunhos e cadastros vindos do servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 async function create(){setBusy(true);try{const r=await post('planning/create-free',{mode:'realizada'});setPlanId(r.id);await refresh()}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Não foi possível abrir o registro</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 if(planId)return <PlanEditor key={planId} planId={planId} refs={data} onRefs={refresh} onClose={()=>{setPlanId(null);void refresh()}} onReplaced={setPlanId} onLaunched={id=>{setPlanId(null);void refresh();if(id)openOrder(id)}}/>;
 const orgs=data.orgs as R[];
 const button=<Button className="primary-action" onClick={()=>void create()} disabled={busy}>{busy?<LoaderCircle size={16} className="animate-spin"/>:<ClipboardCheck size={16}/>} Registrar atividade realizada</Button>;
 return <section className="n-panel">
  <div className="panel-heading"><div><h2>Atividades realizadas sem planejamento</h2><p>Para o que foi feito na urgência: mesmo formulário da OS sem fluxo (título, código, solicitante, local, início e fim reais, recursos, equipamentos e colaboradores). A OS é criada já executada.</p></div>{button}</div>
  {(data.drafts as R[]).length?<div className="table-scroll"><Table><TableHeader><TableRow><TableHead>Atividade</TableHead><TableHead>Código</TableHead><TableHead>Solicitante</TableHead><TableHead>Execução</TableHead><TableHead>Última gravação</TableHead>{data.actor.manager&&<TableHead>Responsável</TableHead>}<TableHead/></TableRow></TableHeader>
   <TableBody>{(data.drafts as R[]).map(d=><TableRow key={d.id}><TableCell><Badge tone="warning">Em preenchimento</Badge> <b>{d.activity_name||'Sem título'}</b></TableCell><TableCell>{d.activity_code||'—'}</TableCell><TableCell><OrgTag org={orgs.find(o=>o.id===d.org_id)}/></TableCell><TableCell>{range(d.planned_start,d.planned_end)}</TableCell><TableCell>{fmt(d.updated_at)}</TableCell>{data.actor.manager&&<TableCell>{d.author_name}</TableCell>}<TableCell><Button size="sm" variant="outline" onClick={()=>setPlanId(d.id)}>Continuar</Button></TableCell></TableRow>)}</TableBody></Table></div>
   :<Empty icon={ClipboardCheck} title="Nenhum registro em preenchimento" description="Registros concluídos aparecem em Operação › Apontamentos e na Lista de OS, marcados como “realizada sem planejamento”." action={button}/>}
 </section>;
}
