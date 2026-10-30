'use client';
// Planejamento de atividade (rascunho com salvamento automático, reservas, documentos,
// revisão e lançamento) com a lista de rascunhos, e Lista de OS (também usada na Operação).
import {Fragment,useCallback,useEffect,useMemo,useRef,useState,FormEvent} from 'react';
import {Package,PackagePlus,Shapes,ClipboardCheck,Plus,AlertTriangle,LoaderCircle,CheckCircle2,CircleDashed,CloudOff,Rocket,Trash2,X,Wand2,ClipboardList,CalendarRange,Lock,Info,Unlock,Filter,Clock,Users,Truck,MapPin,MonitorPlay,Ban,Pencil} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Table,TableHeader,TableRow,TableHead,TableBody,TableCell} from '@/components/ui/table';
import {Checkbox} from '@/components/ui/checkbox';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,Toggle,OrgTag,UNITS,fmt,post,load,clip,toLocalInput,fromLocalInput,localIssue,INPUT_MIN,INPUT_MAX,Period,type R} from './kit';
import {layers,hhmm} from './flows';
import Gantt from './gantt';
import ResourceAgenda from './resource-agenda';
import {ArrangeControls,useOsView,useNow} from './os-arrange';
import {arrangeOrders,flatRows,viewToParams,type Flags,type OsGroup,type OsItem} from '@/lib/os-order';

/** Horário de Brasília para o campo datetime-local e de volta (com fuso explícito). */
const toLocal=toLocalInput;
const toISO=fromLocalInput;
/** Primeiro problema de data do formulário (atividade, etapas e apontamentos), para não gravar lixo. */
const dateIssue=(f:Form,free=false)=>{for(const [label,v] of [['Início',f.start],['Fim',f.end],...f.steps.filter(s=>s.included&&!free).flatMap(s=>[[`${s.name} · início`,s.start],[`${s.name} · fim`,s.end]]),...f.notes.flatMap(n=>[['Apontamento',n.at],['Apontamento · até',n.until]])] as [string,string][]){const m=localIssue(v);if(m)return `${label}: ${m}`;}return '';};
const minutesBetween=(a?:string|null,b?:string|null)=>a&&b?Math.round((Date.parse(b)-Date.parse(a))/60000):null;
export const osLabel=(n:number)=>'OS '+String(n).padStart(6,'0');
const statusNames:Record<string,[string,string]>={programada:['Programada','info'],em_andamento:['Em andamento','success'],encerramento_pendente:['Encerramento pendente','warning'],concluida:['Concluída','muted'],cancelada:['Cancelada','danger']};
/** Período numa linha só (início e fim lado a lado). */
const range=(a?:string|null,b?:string|null)=><Period a={a} b={b}/>;

type Need={equipmentTypeId:string|null,functionId:string|null,materialId:string|null,quantity:number|null,amount:number|null,unit:string|null};
/** Período de uso de um equipamento (OS sem fluxo), em horário local; ausente = a OS inteira. */
type Use={start:string,end:string};
type Step={key:string,id:string,name:string,description:string,required:boolean,included:boolean,dependsOn:string[],defaultMinutes:number|null,start:string,end:string,locationId:string,needs:Need[],equipmentIds:string[],operatorIds:string[],uses:Record<string,Use>};
/** Apontamento informado no registro de atividade realizada (horários locais de Brasília). */
type Note={key:string,kind:string,categoryId:string,description:string,at:string,until:string};
type Form={title:string,code:string,description:string,orgId:string,personId:string,locationId:string,start:string,end:string,steps:Step[],notes:Note[]};
const fromPlan=(p:R):Form=>({notes:((p.realized_notes||[]) as R[]).map(n=>({key:n.key,kind:n.kind,categoryId:n.categoryId||'',description:n.description,at:toLocal(n.at),until:toLocal(n.until)})),title:p.title||'',code:p.code||'',description:p.description||'',orgId:p.org_id||'',personId:p.requester_person_id||'',locationId:p.location_id||'',start:toLocal(p.planned_start),end:toLocal(p.planned_end),steps:p.steps.map((s:R)=>({key:s.step_key,id:s.id,name:s.name,description:s.description,required:!!s.required,included:!!s.included,dependsOn:s.depends_on,defaultMinutes:s.default_minutes,start:toLocal(s.planned_start),end:toLocal(s.planned_end),locationId:s.location_id||'',needs:s.needs.map((n:R)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,materialId:n.material_id,quantity:n.quantity,amount:n.amount,unit:n.unit})),equipmentIds:s.equipment_ids,operatorIds:s.operator_ids,uses:Object.fromEntries(((s.reservations||[]) as R[]).filter(r=>r.start_at!==s.planned_start||r.end_at!==s.planned_end).map(r=>[r.equipment_id,{start:toLocal(r.start_at),end:toLocal(r.end_at)}]))}))});
const toBody=(f:Form,realized=false)=>({...(realized?{notes:f.notes.map(n=>({key:n.key,kind:n.kind,categoryId:n.categoryId||null,description:n.description,at:toISO(n.at),until:n.kind==='bloqueio'||(n.kind==='impacto'&&n.until)?toISO(n.until):null}))}:{}),title:f.title,code:f.code,description:f.description,orgId:f.orgId||null,requesterPersonId:f.personId||null,locationId:f.locationId||null,plannedStart:toISO(f.start),plannedEnd:toISO(f.end),steps:f.steps.map(s=>({key:s.key,included:s.included,plannedStart:toISO(s.start),plannedEnd:toISO(s.end),locationId:s.locationId||null,needs:s.needs,equipmentIds:s.included?s.equipmentIds:[],operatorIds:s.included?s.operatorIds:[],equipmentWindows:usesBody(s,f)}))});

/** Períodos de uso enviados ao servidor (só OS sem fluxo): recortados ao início e fim da OS; o que
 * ficou vazio, inválido ou fora da OS volta a ser a OS inteira (nada é gravado fora da janela). */
function usesBody(s:Step,f:Form){
 const a=toISO(f.start),b=toISO(f.end);if(!a||!b||!s.included)return undefined;
 const out:Record<string,{start:string,end:string}>={};
 for(const e of s.equipmentIds){const u=s.uses?.[e];if(!u)continue;const x=toISO(u.start),y=toISO(u.end);if(!x||!y)continue;
  const st=Math.max(Date.parse(x),Date.parse(a)),en=Math.min(Date.parse(y),Date.parse(b));if(en>st)out[e]={start:new Date(st).toISOString(),end:new Date(en).toISOString()};}
 return out;
}
/** Abre a revisão da OS (ou reabre a que já está em rascunho) e leva ao editor. */
export async function startRevision(workOrderId:string,open:(planId:string)=>void){
 try{const r=await post('planning/revision/start',{workOrderId});toast.success(r.message);open(r.id)}catch(e){toast.error((e as Error).message)}
}
const draftLabel=(d:R)=><>{d.work_order_id?<Badge tone="info">Revisão {d.revision} · {osLabel(d.os_number)}</Badge>:<Badge tone="warning">Rascunho</Badge>}{d.free?<Badge>Sem fluxo</Badge>:null}</>;
const osStepNames:Record<string,string>={concluida:'Concluída',dispensada:'Dispensada',em_execucao:'Em execução',pausada:'Pausada',bloqueada:'Bloqueada',cancelada:'Cancelada'};

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
    {data.drafts.length?<><p className="drafts-note">{data.actor.manager?'Rascunhos de todos os planejadores. Rascunhos com reservas seguram equipamentos: libere os esquecidos.':'Seus planejamentos ainda não lançados. Só você e o gestor os veem.'}</p>
     <div className="table-scroll drafts-table"><Table><TableHeader><TableRow><TableHead>Atividade</TableHead><TableHead>Solicitante</TableHead><TableHead>Período previsto</TableHead><TableHead>Reservas provisórias</TableHead><TableHead>Última gravação</TableHead>{data.actor.manager&&<TableHead>Responsável</TableHead>}<TableHead/></TableRow></TableHeader><TableBody>{data.drafts.map((d:R)=><TableRow key={d.id} className="clickable" onClick={()=>openPlan(d.id)}><TableCell><span className="draft-badges">{draftLabel(d)}</span><b>{d.activity_name}</b><small>{d.description||'Sem descrição'}</small></TableCell><TableCell><OrgTag org={orgs.find(o=>o.id===d.org_id)}/></TableCell><TableCell>{range(d.planned_start,d.planned_end)}</TableCell><TableCell>{d.reservations?<Badge tone="info">{d.reservations} equipamento(s)</Badge>:'—'}</TableCell><TableCell className="nw">{fmt(d.updated_at)}</TableCell>{data.actor.manager&&<TableCell>{d.author_name}</TableCell>}<TableCell><div className="access-actions"><Button size="sm" variant="outline" onClick={e=>{e.stopPropagation();openPlan(d.id)}}>Abrir</Button>{data.actor.manager&&d.author_id!==data.actor.id&&d.reservations>0&&<button className="icon-action" title="Liberar reservas" aria-label={`Liberar reservas do rascunho de ${d.author_name}`} onClick={e=>{e.stopPropagation();setReleaseFor(d)}}><Unlock size={16}/></button>}</div></TableCell></TableRow>)}</TableBody></Table></div></>
    :<Empty icon={ClipboardList} title="Nenhum rascunho em andamento" description={types.length?'Comece um planejamento novo. Ele fica salvo como rascunho até você revisar e lançar a OS.':'Sem fluxo cadastrado ainda: planeje uma OS sem fluxo ou cadastre um fluxo em Planejamento › Cadastro de fluxo.'} action={newButton}/>}
   </section>)}
  {view==='plan-os'&&<Orders refreshKey={refreshKey} planRefs={data} onPlanRefs={refresh} onExec={openOrder} onRevise={id=>{openPlan(id);navigate('plan-atividade')}}/>}

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

const REVISABLE_OS=['programada','em_andamento'];
/** Detalhes da OS lançada (Lista de OS e Gantt): o mesmo editor, só leitura, com as ações da OS. */
type Details={order:R,current:boolean,canPlan:boolean,canCancel:boolean,onExec:()=>void,onEdit:()=>void,onCancel:()=>void,onVersion:(planId:string)=>void};
function PlanEditor({planId,refs,onRefs,onClose,onReplaced,onLaunched,details}:{planId:string,refs:R,onRefs:()=>Promise<void>,onClose:()=>void,onReplaced:(id:string)=>void,onLaunched:(workOrderId?:string)=>void,details?:Details}){
 const [plan,setPlan]=useState<R|null>(null),[form,setForm]=useState<Form|null>(null),[editable,setEditable]=useState(false),[loadError,setLoadError]=useState('');
 const [saveState,setSaveState]=useState<SaveState>('saved'),[savedAt,setSavedAt]=useState<string|null>(null),[saveError,setSaveError]=useState('');
 const [revisions,setRevisions]=useState<R[]>([]);
 const [osSteps,setOsSteps]=useState<R[]|null>(null),[revisionReason,setRevisionReason]=useState(''),[nowMax]=useState(()=>toLocal(new Date(Date.now()+60000).toISOString()));
 const [review,setReview]=useState<R|null>(null),[launching,setLaunching]=useState(false),[changeType,setChangeType]=useState(''),[suggest,setSuggest]=useState<Step[]|null>(null),[confirmDiscard,setConfirmDiscard]=useState(false);
 const version=useRef(0),dirtyTick=useRef(0),launchKey=useRef(''),planMode=useRef(''),freeMode=useRef(false);
 const paths=useMemo(()=>locationPaths(refs.locations),[refs.locations]);
 const reload=useCallback(async()=>{try{const r=await load<R>('planning/plan?id='+encodeURIComponent(planId));setPlan(r.plan);planMode.current=r.plan.mode;freeMode.current=!!r.plan.free;setForm(fromPlan(r.plan));setEditable(r.editable);setOsSteps(r.osSteps);setRevisions(r.revisions||[]);version.current=r.plan.version;setSavedAt(r.plan.updated_at);setSaveState('saved');setSaveError('');setLoadError('')}catch(e){setLoadError((e as Error).message)}},[planId]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Carrega o rascunho do servidor.
 useEffect(()=>{void reload()},[reload]);
 const save=useCallback(async(f:Form)=>{
  // Data inválida ou fora da faixa não vai ao servidor: o campo mostra o problema e nada é perdido.
  const issue=dateIssue(f,freeMode.current);if(issue){setSaveError(issue);setSaveState('error');return false}
  const tick=dirtyTick.current;setSaveState('saving');
  try{const r=await post('planning/save',{id:planId,version:version.current,...toBody(f,planMode.current==='realizada')});version.current=r.version;setSavedAt(r.savedAt);setSaveError('');setSaveState(dirtyTick.current===tick?'saved':'dirty');return true}
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
  if(!form?.start||!toISO(form.start)||localIssue(form.start)){toast.error('Informe um início previsto válido da atividade para sugerir os horários.');return}
  const end=new Map<string,number>();const out=form.steps.map(s=>({...s}));
  const sorted=[...out].filter(s=>s.included).sort((a,b)=>(order.level.get(a.key)??0)-(order.level.get(b.key)??0));
  for(const s of sorted){const deps=s.dependsOn.map(d=>end.get(d)).filter((x):x is number=>x!=null);const st=Math.max(Date.parse(toISO(form.start)!),...deps);const en=st+(s.defaultMinutes||60)*60000;end.set(s.key,en);s.start=toLocal(new Date(st).toISOString());s.end=toLocal(new Date(en).toISOString())}
  setSuggest(out);
 }

 return <div className="plan-editor"><datalist id="units">{UNITS.map(u=><option key={u} value={u}/>)}</datalist>
  <div className="plan-bar"><div><Badge tone={plan.status==='draft'&&!revision?'warning':'info'}>{revision?`Revisão ${plan.revision} · ${osLabel(plan.os_number)}`:realized&&plan.status==='draft'?'Atividade realizada':plan.status==='draft'?'Rascunho':plan.os_number?osLabel(plan.os_number):plan.status}</Badge><b>{free?(form.title||'Atividade sem título'):`${plan.activity_code} · ${plan.activity_name}`}</b><small>{realized?'Registro sem planejamento prévio':free?'OS sem fluxo':`Fluxo v${plan.flow_version}`}{form.code?` · ${form.code}`:''} · responsável {plan.author_name}</small></div>
   <div className="plan-bar-actions">{editable&&<SaveBadge state={saveState} at={savedAt} message={saveError}/>}<Button variant="outline" onClick={onClose}>{details?'Voltar à lista':'Fechar'}</Button>
    {details&&<><Button variant="outline" onClick={details.onExec}><ClipboardCheck size={16}/> Abrir em Apontamentos</Button>
     {details.current&&details.canCancel&&REVISABLE_OS.includes(details.order.status)&&<Button variant="outline" onClick={details.onCancel}><Ban size={16}/> Cancelar OS</Button>}
     {details.current&&details.canPlan&&REVISABLE_OS.includes(details.order.status)&&<Button className="primary-action" onClick={details.onEdit}><Pencil size={16}/> Editar OS (nova versão)</Button>}</>}{editable&&<Button className="primary-action" onClick={()=>void openReview()} disabled={saveState==='saving'}>{realized?<ClipboardCheck size={16}/>:<Rocket size={16}/>} {realized?'Conferir e registrar':revision?'Conferir e lançar revisão':'Revisar e lançar OS'}</Button>}</div></div>
  {realized&&editable&&<div className="notice"><Info size={17}/><span>Registro de atividade feita sem planejamento (ex.: urgência). Informe o início e o fim reais: ao registrar, a OS é criada já executada, com os recursos usados, e fica marcada como “realizada sem planejamento”. Se houver checklist obrigatório, ela fica em encerramento pendente até o preenchimento em Apontamentos.</span></div>}
  {revision&&editable&&<div className="notice"><Info size={17}/><span>Revisão da {osLabel(plan.os_number)}: a OS segue valendo como está até você lançar a revisão, e as reservas atuais continuam garantidas. Etapas concluídas ou dispensadas não mudam; etapas iniciadas mantêm o início previsto e não saem da OS; etapas não iniciadas retiradas ficam registradas como dispensadas.</span></div>}
  {saveState==='error'&&<div className="form-error" role="alert"><AlertTriangle size={17}/><span>{saveError} <button className="text-action" onClick={()=>form&&void save(form)}>Tentar de novo</button> · <button className="text-action" onClick={()=>void reload()}>Recarregar o rascunho salvo</button></span></div>}
  {!editable&&(details?<div className="notice"><Lock size={17}/><span>{details.current?<><b>Detalhes da OS · somente leitura.</b> Consultar não abre revisão nem muda nada. {details.canPlan&&REVISABLE_OS.includes(details.order.status)?<>Para alterar, use <b>Editar OS (nova versão)</b>: a OS segue valendo como está até a nova versão ser lançada.</>:details.order.status==='cancelada'?'OS cancelada: não pode mais ser alterada.':details.order.status==='concluida'?'OS concluída: não pode mais ser alterada.':''}</>:<><b>Versão anterior (revisão {plan.revision||0}) · somente leitura.</b> Esta versão foi substituída; a vigente é a do topo do histórico.</>}</span></div>
   :<div className="notice"><Lock size={17}/><span>Somente leitura: {revision?'esta revisão é de outra pessoa.':'este planejamento não é um rascunho seu.'}</span></div>)}
  {details&&revisions.length>1&&<section className="n-panel revision-history"><b>Histórico de versões</b><ol>{revisions.map(r=><li key={r.id}><button type="button" className={`text-action${r.id===planId?' on':''}`} onClick={()=>details.onVersion(r.id)} aria-current={r.id===planId}>{r.revision?`Revisão ${r.revision}`:'Original'}{r.status==='launched'?' · vigente':''}</button><span>{fmt(r.launched_at)}{r.launched_by_name?` · ${r.launched_by_name}`:''}</span>{r.revision_unchanged?<Badge>Sem alterações</Badge>:null}{r.revision_reason&&<small>{r.revision_reason}</small>}</li>)}</ol></section>}
  <fieldset disabled={!editable} className="plan-fieldset">
  <section className="n-panel plan-section"><div className="panel-heading"><div><h2>Dados da atividade</h2><p>{editable?'O rascunho pode ficar incompleto; só o lançamento exige tudo preenchido.':'Dados da versão exibida.'}</p></div></div>
   <div className="form-grid plan-grid">
    <Field label="Código do setor" hint={(refs.sectors as R[]).find(s=>s.code===form.code)?.name||'Código da OS: escolha um setor cadastrado (Cadastros gerais › Setores).'}><SectorPicker value={form.code} sectors={refs.sectors} onRefs={onRefs} onChange={code=>update(f=>({...f,code}))}/></Field>
    {free?<Field label="Título da atividade *" wide hint="Aparece na lista de OS, na Operação, no relatório e na planilha."><Input maxLength={160} value={form.title} onChange={e=>update(f=>({...f,title:e.target.value}))} placeholder={realized?'Ex.: Contenção de vazamento no pátio 2':'Ex.: Remoção de sucata do pátio 3'}/></Field>:<Field label="Tipo de atividade" hint={!editable?undefined:revision?'Não muda na revisão: o fluxo da OS é mantido.':'Trocar o tipo substitui etapas, horários e alocações.'}><Choice disabled={revision} value={plan.activity_type_id} onChange={v=>{if(v!==plan.activity_type_id)setChangeType(v)}} options={refs.activityTypes.filter((t:R)=>(t.active&&!t.system)||t.id===plan.activity_type_id).map((t:R)=>({value:t.id,label:`${t.code} · ${t.name}`}))}/></Field>}
    <Field label="Organização solicitante *" hint={revision?'A organização da OS não muda na revisão.':undefined}><Choice disabled={revision} value={form.orgId} onChange={v=>update(f=>({...f,orgId:v,personId:''}))} options={refs.orgs.filter((o:R)=>o.active||o.id===form.orgId).map((o:R)=>({value:o.id,label:`${o.acronym} · ${o.name}`}))}/></Field>
    <Field label="Pessoa solicitante"><Choice disabled={!form.orgId} value={form.personId||'none'} onChange={v=>update(f=>({...f,personId:v==='none'?'':v}))} options={[{value:'none',label:'Não informada'},...people.map((p:R)=>({value:p.id,label:p.name}))]}/></Field>
    <Field label="Local *"><Choice value={form.locationId} onChange={v=>update(f=>({...f,locationId:v}))} options={refs.locations.filter((l:R)=>l.active||l.id===form.locationId).map((l:R)=>({value:l.id,label:paths.get(l.id)!}))}/></Field>
    <Field label={realized?'Início real (Brasília) *':free?'Início (Brasília) *':'Início previsto (Brasília) *'} hint={localIssue(form.start)||(realized?'Quando a atividade começou.':free?'Marco de início da OS.':undefined)}><Input type="datetime-local" min={INPUT_MIN} max={realized?nowMax:INPUT_MAX} aria-invalid={!!localIssue(form.start)} value={form.start} onChange={e=>update(f=>({...f,start:e.target.value}))}/></Field>
    <Field label={realized?'Fim real (Brasília) *':free?'Fim (Brasília) *':'Fim previsto (Brasília) *'} hint={localIssue(form.end)||(form.start&&form.end&&!localIssue(form.start)?`${realized?'Duração':free?'Marco de fim · duração':'Janela de'} ${hhmm(minutesBetween(toISO(form.start),toISO(form.end)))}`:undefined)}><Input type="datetime-local" min={INPUT_MIN} max={INPUT_MAX} aria-invalid={!!localIssue(form.end)} value={form.end} onChange={e=>update(f=>({...f,end:e.target.value}))}/></Field>
    <Field label="Descrição" wide><Textarea maxLength={2000} value={form.description} onChange={e=>update(f=>({...f,description:e.target.value}))} placeholder="O que será feito, observações para a operação"/></Field>
    {org&&<div className="n-field"><label>Etiqueta</label><OrgTag org={org}/></div>}
   </div>
  </section>
  <section className="n-panel plan-section"><div className="panel-heading"><div><h2>{realized?'Recursos usados':free?'Recursos':'Etapas, horários e recursos'}</h2><p>{realized?`Equipamentos, colaboradores e materiais usados entre o início e o fim reais. ${reserved} equipamento(s) no período.`:free?`A OS sem fluxo tem os marcos Início e Fim, iguais às datas acima; na Operação, registra-se o início e o fim da execução. ${reserved} equipamento(s) reservado(s) provisoriamente.`:<>{order.cyclic.length?'':`${steps.filter(s=>s.included).length} etapa(s) incluída(s) · ${reserved} equipamento(s) reservado(s) provisoriamente.`} Etapas sem dependência podem ocorrer em paralelo.</>}</p></div>{editable&&!free&&<Button variant="outline" onClick={proposeTimes}><Wand2 size={16}/> Sugerir horários</Button>}</div>
   <div className="plan-steps">{steps.map(s=><StepCard key={s.key} free={free} onRefs={onRefs} step={s} steps={steps} refs={refs} paths={paths} planId={planId} serverStep={plan.steps.find((x:R)=>x.step_key===s.key)} osStatus={osSteps?.find(o=>o.step_key===s.key)?.status} editable={editable} onChange={patch=>setStep(s.key,patch)}/>)}</div>
  </section>
  {realized&&<RealizedNotes notes={form.notes} start={form.start} end={form.end} categories={refs.categories||[]} onChange={notes=>update(f=>({...f,notes}))}/>}
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
    <ol className="review-steps">{steps.filter(s=>s.included).map(s=><li key={s.key}><b>{free?'Início → Fim':s.name}</b><span>{range(toISO(s.start),toISO(s.end))}</span><small>{[...s.equipmentIds.map(e=>{const t=refs.equipment.find((x:R)=>x.id===e)?.tag,u=free?s.uses?.[e]:null;return u?`${t} (uso ${u.start.slice(8,10)}/${u.start.slice(5,7)} ${u.start.slice(11)} → ${u.end.slice(8,10)}/${u.end.slice(5,7)} ${u.end.slice(11)})`:t}),...s.operatorIds.map(o=>refs.operators.find((x:R)=>x.id===o)?.name)].filter(Boolean).join(' · ')||'Sem recursos identificados'}</small>{s.needs.length>0&&<small>Necessidades: {s.needs.map(n=>needLabel(n,refs)).join(' · ')}</small>}</li>)}</ol>
    {revision&&<div className="revision-changes"><b>O que muda</b>{review.changes?.length?<ul>{review.changes.map((c:string,i:number)=><li key={i}>{c}</li>)}</ul>:<p className="notice"><Info size={16}/><span><b>Nenhuma alteração em relação à versão vigente.</b> Você pode relançar assim mesmo: a revisão {plan.revision} fica registrada no histórico como “sem alterações”, com o motivo informado.</span></p>}</div>}
    {review.errors.length?<ReviewErrors errors={review.errors} realized={realized}/>:<div className="notice"><CheckCircle2 size={17}/><span>Sem pendências. Pronto para {realized?'registrar':'lançar'}.</span></div>}
    {review.warnings.length>0&&<ReviewWarnings warnings={review.warnings}/>}
    {revision&&<div className="form-grid"><Field label="Motivo da revisão *" wide hint="Fica no histórico da OS e na auditoria. Etapas retiradas são dispensadas com este motivo."><Textarea required maxLength={1200} value={revisionReason} onChange={e=>setRevisionReason(e.target.value)}/></Field></div>}
   </div>}
   <div className="modal-footer"><Button variant="outline" onClick={()=>setReview(null)} disabled={launching}>Voltar e corrigir</Button><Button className="primary-action" onClick={()=>void launch()} disabled={launching||!!review?.errors.length||(revision&&!revisionReason.trim())}>{launching?<><LoaderCircle className="animate-spin" size={16}/> {realized?'Registrando…':'Lançando…'}</>:<>{realized?<ClipboardCheck size={16}/>:<Rocket size={16}/>} {realized?'Registrar atividade':revision?(review?.changes?.length?'Lançar revisão':'Relançar sem alterações'):'Lançar OS'}</>}</Button></div>
  </DialogContent></Dialog>
 </div>;
}

/** Avisos da revisão: não impedem o lançamento. Agrupados por tipo, com a etapa em destaque e o
 * texto em linhas próprias (paralelismo de pessoas e funções incompletas não bloqueiam; só equipamento bloqueia). */
const WARN_KINDS:Record<string,string>={paralelismo:'Colaborador em outra etapa no mesmo horário (paralelismo)',funcao:'Funções com menos colaboradores que o pedido',colaborador:'Equipe a revisar'};
function ReviewWarnings({warnings}:{warnings:R[]}){
 const groups=new Map<string,R[]>();for(const w of warnings){const k=w.kind||'outros';groups.set(k,[...(groups.get(k)||[]),w]);}
 const split=(m:string)=>{const x=/^(Etapa “[^”]+”): (.*)$/.exec(m);return x?[x[1],x[2]]:['',m];};
 return <div className="review-warnings" role="status"><div className="rw-head"><Info size={17}/><b>Avisos ({warnings.length})</b><span>Não impedem o lançamento: entre os recursos, só o equipamento bloqueia.</span></div>
  {[...groups.entries()].map(([k,list])=><section key={k}><h4>{WARN_KINDS[k]||'Outros avisos'}</h4><ul>{list.map((w,i)=>{const [step,text]=split(w.message);return <li key={i}>{step&&<b>{step.replace('Etapa ','')}</b>}<span>{text}</span></li>;})}</ul></section>)}
 </div>;
}

/** Pendências que impedem o lançamento, uma por linha, com a etapa em destaque. */
function ReviewErrors({errors,realized}:{errors:R[],realized:boolean}){
 const split=(m:string)=>{const x=/^(Etapa “[^”]+”): (.*)$/.exec(m);return x?[x[1],x[2]]:['',m];};
 return <div className="review-errors" role="alert"><div className="rw-head"><AlertTriangle size={17}/><b>{errors.length} pendência(s) impedem {realized?'o registro':'o lançamento'}</b><span>Corrija e confira de novo. Datas, dependências e equipamentos bloqueiam.</span></div>
  <ul>{errors.map((e,i)=>{const [step,text]=split(e.message);return <li key={i}>{step&&<b>{step.replace('Etapa ','')}</b>}<span>{text}</span></li>;})}</ul></div>;
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
 const [avail,setAvail]=useState<Record<string,R>>({}),[people,setPeople]=useState<Record<string,R>>({}),[showAll,setShowAll]=useState(false);
 const badDates=!!(localIssue(s.start)||localIssue(s.end));
 const startISO=toISO(s.start),endISO=toISO(s.end),valid=!badDates&&!!startISO&&!!endISO&&Date.parse(endISO)>Date.parse(startISO);
 // Consulta a agenda do intervalo da etapa (o servidor revalida ao gravar).
 useEffect(()=>{if(!valid||!s.included||!editable)return;const t=setTimeout(async()=>{try{const r=await load<R>(`planning/availability?start=${encodeURIComponent(startISO!)}&end=${encodeURIComponent(endISO!)}&planId=${planId}&stepId=${serverStep?.id||''}`);setAvail(Object.fromEntries(r.equipment.map((e:R)=>[e.id,e])));setPeople(Object.fromEntries((r.operators||[]).map((o:R)=>[o.id,o])))}catch{/* sem prévia: a gravação confere */}},400);return()=>clearTimeout(t)},[valid,startISO,endISO,s.included,editable,planId,serverStep?.id]);
 const deps=s.dependsOn.map(d=>steps.find(x=>x.key===d)).filter(Boolean) as Step[];
 const typeNeeds=s.needs.filter(n=>n.equipmentTypeId),fnNeeds=s.needs.filter(n=>n.functionId);
 const neededTypes=typeNeeds.map(n=>n.equipmentTypeId);
 const equipment=(refs.equipment as R[]).filter(e=>(e.active||s.equipmentIds.includes(e.id))&&(showAll||!neededTypes.length||neededTypes.includes(e.type_id)||s.equipmentIds.includes(e.id)));
 // Colaboradores: quem tem a função exigida primeiro; entre eles, os livres no horário da etapa.
 const fitsFn=(o:R)=>fnNeeds.some(n=>o.function_ids.includes(n.functionId));
 const operators=(refs.operators as R[]).filter(o=>o.active||s.operatorIds.includes(o.id))
  .map((o,i)=>({o,i,rank:(fitsFn(o)?0:2)+(people[o.id]?.status==='ocupado'?1:0)})).sort((x,y)=>x.rank-y.rank||x.i-y.i).map(x=>x.o);
 const freeFor=(fn:string)=>(refs.operators as R[]).filter(o=>o.active&&o.function_ids.includes(fn)&&people[o.id]?.status!=='ocupado').length;
 const name=(list:string,id:string|null)=>(refs[list] as R[]).find(x=>x.id===id)?.name||'—';
 const dur=badDates?null:minutesBetween(startISO,endISO);
 return <article className={`step-card ${s.included?'':'excluded'}`}>
  <header><div><b>{free?'Início → Fim da OS':s.name}</b>{!s.required&&<Badge>Opcional</Badge>}{osStatus&&osStatus!=='nao_iniciada'&&<Badge tone={frozen?'muted':'success'}>{osStepNames[osStatus]}{frozen?' · não muda':''}</Badge>}{deps.length>0&&<small>Após: {deps.map(d=>d.name+(d.included?'':' (não incluída — ignorada)')).join(', ')}</small>}{s.defaultMinutes!=null&&<small><Clock size={12} className="inline"/> Duração padrão {hhmm(s.defaultMinutes)}</small>}</div>
   {!s.required&&!frozen&&!started&&<Toggle title="Incluir etapa" checked={s.included} onChange={v=>onChange({included:v})}/>}</header>
  {s.included&&<fieldset disabled={frozen} className="plan-fieldset"><div className="form-grid">
   {free?<div className="n-field wide"><label>Marcos</label><small>Início {s.start?s.start.replace('T',' '):'—'} · Fim {s.end?s.end.replace('T',' '):'—'}{dur!=null&&dur>0?` · duração ${hhmm(dur)}`:''}. Ajuste nas datas da atividade, acima.</small></div>:<>
   <Field label="Início (Brasília)" hint={localIssue(s.start)||(started?'Etapa iniciada: o início previsto é a referência do desvio e não muda.':undefined)}><Input type="datetime-local" min={INPUT_MIN} max={INPUT_MAX} aria-invalid={!!localIssue(s.start)} disabled={started} value={s.start} onChange={e=>onChange({start:e.target.value})}/></Field>
   <Field label="Fim (Brasília)" hint={localIssue(s.end)||(dur!=null?(dur>0?`Duração ${hhmm(dur)}`:'O fim deve ser depois do início'):undefined)}><Input type="datetime-local" min={INPUT_MIN} max={INPUT_MAX} aria-invalid={!!localIssue(s.end)} value={s.end} onChange={e=>onChange({end:e.target.value})}/></Field></>}
   <Field label="Local específico da etapa"><Choice value={s.locationId||'none'} onChange={v=>onChange({locationId:v==='none'?'':v})} options={[{value:'none',label:'Mesmo local da atividade'},...(refs.locations as R[]).filter(l=>l.active||l.id===s.locationId).map(l=>({value:l.id,label:paths.get(l.id)!}))]}/></Field>
   <div className="n-field wide"><label>Necessidades de recursos</label><div className="need-chips">{s.needs.length?s.needs.map((n,i)=><span key={i} className="need-chip">{n.materialId?<Package size={13}/>:n.equipmentTypeId?<Truck size={13}/>:<Users size={13}/>}{n.materialId?<><input type="number" min={0.001} step="any" aria-label="Quantidade" className="amount" value={n.amount??''} onChange={e=>onChange({needs:s.needs.map((x,j)=>j===i?{...x,amount:Number(e.target.value)||0}:x)})}/><input aria-label="Unidade de medida" className="unit" maxLength={12} list="units" value={n.unit??''} onChange={e=>onChange({needs:s.needs.map((x,j)=>j===i?{...x,unit:e.target.value}:x)})}/>{name('materials',n.materialId)}</>:<><input type="number" min={1} max={99} aria-label="Quantidade" value={n.quantity??1} onChange={e=>onChange({needs:s.needs.map((x,j)=>j===i?{...x,quantity:Math.min(99,Math.max(1,Number(e.target.value)||1))}:x)})}/>× {n.equipmentTypeId?name('equipmentTypes',n.equipmentTypeId):name('functions',n.functionId)}</>}<button type="button" aria-label="Remover necessidade" onClick={()=>onChange({needs:s.needs.filter((_,j)=>j!==i)})}><X size={12}/></button></span>):<small>Nenhuma necessidade informada.</small>}</div>
    {editable&&<NeedAdder refs={refs} needs={s.needs} onRefs={onRefs} onAdd={n=>onChange({needs:[...s.needs,n]})}/>}</div>
   <fieldset className="n-field wide"><legend>Equipamentos identificados {typeNeeds.length>0&&<small>({typeNeeds.map(n=>`${n.quantity}× ${name('equipmentTypes',n.equipmentTypeId)}`).join(', ')})</small>}</legend>
    {!valid?<small className="pending-text">Informe início e fim da etapa para consultar a agenda e reservar equipamentos.</small>:<div className="resource-list">{equipment.map(e=>{const a=avail[e.id];const chosen=s.equipmentIds.includes(e.id);const blocked=a&&!chosen&&(free?a.status==='bloqueado':a.status!=='livre');return <label key={e.id} className={`resource ${a?.status||''} ${chosen?'chosen':''}`}><Checkbox checked={chosen} disabled={!!blocked} onCheckedChange={v=>onChange({equipmentIds:v?[...s.equipmentIds,e.id]:s.equipmentIds.filter(x=>x!==e.id)})}/><span><b>{e.tag}</b><small>{name('equipmentTypes',e.type_id)}{e.capacity?` · ${e.capacity}`:''}</small>{a&&a.status!=='livre'&&<em>{a.detail}</em>}</span><Badge tone={!a?'muted':a.status==='livre'?'success':a.status==='bloqueado'?'danger':'warning'}>{!a?(editable?'Consultando…':chosen?'Reservado aqui':'—'):a.status==='livre'?'Livre':a.status==='bloqueado'?'Bloqueado':chosen?'Reservado aqui':'Reservado'}</Badge></label>})}{neededTypes.length>0&&<button type="button" className="text-action" onClick={()=>setShowAll(v=>!v)}>{showAll?'Mostrar só os tipos necessários':'Mostrar todos os equipamentos'}</button>}</div>}
    {valid&&free&&s.equipmentIds.length>0&&<div className="equip-uses"><b>Período de uso de cada equipamento</b><small>Por padrão o equipamento fica reservado na OS inteira. Informe o início e as horas de uso para reservar só esse período e deixá-lo livre para outras OS no restante.</small>
     {s.equipmentIds.map(id=><EquipmentUse key={id} tag={(refs.equipment as R[]).find(x=>x.id===id)?.tag||'—'} equipmentId={id} step={s} planId={planId} stepId={serverStep?.id} editable={editable} onChange={u=>{const uses={...s.uses};if(u)uses[id]=u;else delete uses[id];onChange({uses})}}/>)}</div>}
    {valid&&<small>{free?'Equipamento já reservado em parte da OS pode ser escolhido: ajuste o período de uso para um horário livre. ':''}A reserva provisória começa quando o rascunho é salvo; antes disso, a seleção não garante exclusividade.</small>}
   </fieldset>
   <fieldset className="n-field wide"><legend>Colaboradores {fnNeeds.length>0&&<small>({fnNeeds.map(n=>`${n.quantity}× ${name('functions',n.functionId)}${valid&&Object.keys(people).length?` · ${freeFor(n.functionId||'')} livre(s)`:''}`).join(', ')})</small>}</legend>
    <div className="resource-list people">{operators.map(o=>{const fits=fitsFn(o),p=valid?people[o.id]:undefined,chosen=s.operatorIds.includes(o.id);
     return <label key={o.id} className={`resource ${p?.status==='ocupado'?'busy':''} ${chosen?'chosen':''}`}><Checkbox checked={chosen} onCheckedChange={v=>onChange({operatorIds:v?[...s.operatorIds,o.id]:s.operatorIds.filter(x=>x!==o.id)})}/><span><b>{o.name}</b><small>{o.function_ids.map((f:string)=>name('functions',f)).join(', ')||'Sem função'}{fits?' · função exigida':''}</small>{p?.status==='ocupado'&&<em>Também em: {p.detail}</em>}</span>
      <Badge tone={!p?'muted':p.status==='livre'?'success':'warning'}>{!p?(valid&&editable?'Consultando…':'—'):p.status==='livre'?'Livre':chosen?'Ocupado (escolhido)':'Ocupado'}</Badge></label>})}</div>
    {valid&&<small>Colaborador ocupado em outra etapa no mesmo horário é só um aviso: pode ser escolhido e não impede o lançamento.</small>}
   </fieldset>
  </div></fieldset>}
 </article>;
}

/** Uso de um equipamento na OS sem fluxo: início + horas (fim calculado), sempre dentro da OS, com a
 * agenda do equipamento consultada só para esse período. */
function EquipmentUse({tag,equipmentId,step:s,planId,stepId,editable,onChange}:{tag:string,equipmentId:string,step:Step,planId:string,stepId?:string,editable:boolean,onChange:(u:Use|null)=>void}){
 const os0=Date.parse(toISO(s.start)||''),os1=Date.parse(toISO(s.end)||'');
 const u=s.uses?.[equipmentId];
 const a0=u&&toISO(u.start)?Date.parse(toISO(u.start)!):os0,a1=u&&toISO(u.end)?Date.parse(toISO(u.end)!):os1;
 // Recorte à janela da OS (mesma regra do envio ao servidor).
 const st=Math.max(a0,os0),en=Math.min(a1,os1),ok=en>st,whole=!u||(st===os0&&en===os1);
 const hours=ok?Math.round((en-st)/36e5*100)/100:0;
 const [status,setStatus]=useState<R|null>(null);
 useEffect(()=>{if(!ok||!editable)return;const t=setTimeout(async()=>{try{const r=await load<R>(`planning/availability?start=${encodeURIComponent(new Date(st).toISOString())}&end=${encodeURIComponent(new Date(en).toISOString())}&planId=${planId}&stepId=${stepId||''}`);setStatus((r.equipment as R[]).find(x=>x.id===equipmentId)||null)}catch{setStatus(null)}},450);return()=>clearTimeout(t)},[ok,st,en,editable,planId,stepId,equipmentId]);
 const set=(a:number,b:number)=>{const x=Math.max(a,os0),y=Math.min(b,os1);if(!(y>x))return;onChange(x===os0&&y===os1?null:{start:toLocal(new Date(x).toISOString()),end:toLocal(new Date(y).toISOString())});};
 const startLocal=toLocal(new Date(ok?st:os0).toISOString());
 return <div className="equip-use"><b>{tag}</b>
  <label><span>Início do uso</span><Input type="datetime-local" min={s.start} max={s.end} value={startLocal} disabled={!editable} onChange={e=>{const x=toISO(e.target.value);if(x)set(Date.parse(x),Date.parse(x)+(en-st))}}/></label>
  <label><span>Horas de uso</span><Input type="number" min={0.25} step={0.25} inputMode="decimal" value={hours||''} disabled={!editable} onChange={e=>{const h=Number(e.target.value.replace(',','.'));if(h>0)set(st,st+h*36e5)}}/></label>
  <span className="equip-use-until">{ok?`${fmt(new Date(st).toISOString())} → ${fmt(new Date(en).toISOString())}`:'—'}{!whole&&<small>{hhmm(Math.round((en-st)/60000))} de {hhmm(Math.round((os1-os0)/60000))} da OS</small>}{whole&&<small>OS inteira</small>}</span>
  <Badge tone={!status?'muted':status.status==='livre'?'success':status.status==='bloqueado'?'danger':'warning'}>{!status?(editable?'Consultando…':'—'):status.status==='livre'?'Livre no período':status.status==='bloqueado'?'Bloqueado':'Conflito no período'}</Badge>
  {!whole&&editable&&<button type="button" className="text-action" onClick={()=>onChange(null)}>OS inteira</button>}
  {status&&status.status!=='livre'&&<em>{status.detail}</em>}
 </div>;
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
// Filtros da Lista de OS: ficam na sessão do navegador e voltam iguais ao retornar à tela.
const ORDER_FILTERS='nautilus.orders.filters';
const EMPTY_FILTERS={from:'',to:'',type:'',location:'',status:'',number:'',code:''};
function readOrderFilters():R{try{const v=JSON.parse(sessionStorage.getItem(ORDER_FILTERS)||'null');if(v&&typeof v==='object')return {...EMPTY_FILTERS,...Object.fromEntries(Object.entries(v).filter(([k,x])=>k in EMPTY_FILTERS&&typeof x==='string'))};}catch{}return EMPTY_FILTERS;}
export function Orders({refreshKey,planRefs,onPlanRefs,onExec,onRevise}:{refreshKey:number,planRefs:R,onPlanRefs:()=>Promise<void>,onExec:(id:string)=>void,onRevise:(planId:string)=>void}){
 const [refs,setRefs]=useState<R|null>(null),[rows,setRows]=useState<R|null>(null),[error,setError]=useState(''),[filters,setFilters]=useState<R>(readOrderFilters),[cancel,setCancel]=useState(''),[busy,setBusy]=useState(false);
 // Detalhes da OS (só leitura): a versão exibida e a OS; cancelar pede a justificativa num diálogo.
 const [viewing,setViewing]=useState<{order:R,planId:string}|null>(null),[cancelFor,setCancelFor]=useState<R|null>(null);
 const query=useMemo(()=>new URLSearchParams(Object.entries({...filters,from:filters.from?toISO(filters.from)||'':'',to:filters.to?toISO(filters.to)||'':''}).filter(([,v])=>v) as [string,string][]).toString(),[filters]);
 useEffect(()=>{try{sessionStorage.setItem(ORDER_FILTERS,JSON.stringify(filters))}catch{}},[filters]);
 const refresh=useCallback(async()=>{try{const [r,o]=await Promise.all([load<R>('orders/refs'),load<R>('orders?'+query)]);setRefs(r);setRows(o);setError('')}catch(e){setError((e as Error).message)}},[query]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Lista vinda do servidor (mesma fonte para lista e contagens).
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 // Atualização periódica para refletir lançamentos e bloqueios de outras pessoas.
 useEffect(()=>{const t=setInterval(()=>{if(!document.hidden)void refresh()},45000);return()=>clearInterval(t)},[refresh]);
 const paths=useMemo(()=>refs?locationPaths(refs.locations):new Map(),[refs]);
 // Organização (modo, sentido, solicitante e setor) e Lista/Gantt: guardadas no navegador e iguais
 // na Lista, no Gantt e na Apresentação. Uma coleção só, filtrada e ordenada por lib/os-order.
 const [view,setView]=useOsView();
 const now=useNow();
 // Agenda de recursos: terceira exibição da lista (fica na sessão, como os filtros).
 const [resources,setResources]=useState(false);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Preferência da sessão lida após montar.
 useEffect(()=>{try{if(sessionStorage.getItem('nautilus.orders.resview')==='1')setResources(true)}catch{}},[]);
 const showResources=(v:boolean)=>{setResources(v);try{sessionStorage.setItem('nautilus.orders.resview',v?'1':'0')}catch{}};
 const groups=useMemo(()=>rows?arrangeOrders(rows.orders as R[] as (OsItem&R)[],view.arrange,view.filter,now):[],[rows,view.arrange,view.filter,now]);
 const shown=useMemo(()=>flatRows(groups),[groups]);
 const openDetail=(o:R)=>setViewing({order:o,planId:o.current_plan_id});
 async function doCancel(e:FormEvent){e.preventDefault();if(!cancelFor)return;setBusy(true);try{const r=await post('planning/cancel',{id:cancelFor.current_plan_id,version:cancelFor.version,reason:cancel});toast.success(r.message);setCancelFor(null);setViewing(null);setCancel('');await refresh()}catch(err){toast.error((err as Error).message)}finally{setBusy(false)}}
 const cancelDialog=<Dialog open={!!cancelFor} onOpenChange={v=>{if(!busy&&!v){setCancelFor(null);setCancel('')}}}><DialogContent className="n-dialog">{cancelFor&&<><DialogHeader><div className="modal-eyebrow"><Ban size={16}/> {osLabel(cancelFor.number)} · CANCELAR</div><DialogTitle>Cancelar a OS?</DialogTitle><DialogDescription>{cancelFor.status==='em_andamento'?'A OS já começou: as etapas abertas são encerradas agora como canceladas, o que foi executado fica registrado e os equipamentos são liberados.':'Libera as reservas. A OS continua consultável como cancelada.'}</DialogDescription></DialogHeader>
  <form onSubmit={doCancel}><div className="form-grid"><Field label="Justificativa *" wide><Textarea required maxLength={1200} value={cancel} onChange={e=>setCancel(e.target.value)}/></Field></div><div className="modal-footer"><Button type="button" variant="outline" onClick={()=>{setCancelFor(null);setCancel('')}} disabled={busy}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy||!cancel.trim()}><Ban size={16}/> Cancelar OS</Button></div></form></>}</DialogContent></Dialog>;
 if(viewing&&refs){const o=viewing.order;
  return <><PlanEditor key={viewing.planId} planId={viewing.planId} refs={planRefs} onRefs={onPlanRefs} onClose={()=>setViewing(null)} onReplaced={()=>{}} onLaunched={()=>{}}
   details={{order:o,current:viewing.planId===o.current_plan_id,canPlan:!!refs.canPlan,canCancel:!!refs.canCancel,onExec:()=>onExec(o.id),onEdit:()=>void startRevision(o.id,onRevise),onCancel:()=>setCancelFor(o),onVersion:id=>setViewing({order:o,planId:id})}}/>{cancelDialog}</>;}
 if(error)return <div className="error-panel"><AlertTriangle/><h2>Não foi possível carregar as OS</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!refs||!rows)return <Skeleton className="h-96 rounded-xl"/>;
 const f=(k:string,v:string)=>setFilters(x=>({...x,[k]:v}));
 const orgOf=(id:string)=>refs.orgs.find((o:R)=>o.id===id);
 const counts=new Map<string,number>();for(const r of shown)counts.set(r.item.org_id,(counts.get(r.item.org_id)||0)+1);
 const flagBadges=(fl:Flags)=><>{fl.overdue&&<Badge tone="danger">Prazo vencido</Badge>}{fl.noStart&&<Badge tone="warning">Sem início planejado</Badge>}{fl.issues.length>0&&<Badge tone="danger"><AlertTriangle size={11}/> Datas inconsistentes</Badge>}</>;
 const status=(o:R,fl?:Flags)=><span className="status-cell"><Badge tone={statusNames[o.status]?.[1]}>{statusNames[o.status]?.[0]||o.status}</Badge>{o.origin==='realizada'&&<Badge>Realizada sem planejamento</Badge>}{o.late&&<Badge tone="danger">Início vencido</Badge>}{o.blocked_resources>0&&<Badge tone="danger"><Lock size={11}/> Equipamento bloqueado</Badge>}{fl&&flagBadges(fl)}</span>;
 const head=(g:OsGroup<OsItem&R>)=>g.label?<><b>{g.label}</b><span>{g.rows.length} OS</span>{g.note&&<small>{g.note}</small>}</>:null;
 const filtering=view.filter.orgs.length>0||view.filter.sectors.length>0;
 const presentation='/apresentacao?'+viewToParams(view.arrange,view.filter,view.display).toString();
 // PDF da agenda de recursos: filtros da lista (sem o período, escolhido ao exportar) + solicitante e setor.
 const resExport=new URLSearchParams(Object.entries({type:filters.type,location:filters.location,status:filters.status,number:filters.number,code:filters.code}).filter(([,v])=>v));
 for(const [k,v] of viewToParams(view.arrange,view.filter))if(k==='sol'||k==='setor')resExport.set(k,v);
 return <div className="orders">
  <section className="n-panel"><div className="filters order-filters"><Filter size={16} aria-hidden/>
   <label className="date-filter"><span>De</span><input type="datetime-local" aria-label="Período: de" value={filters.from} onChange={e=>f('from',e.target.value)}/></label>
   <label className="date-filter"><span>Até</span><input type="datetime-local" aria-label="Período: até" value={filters.to} onChange={e=>f('to',e.target.value)}/></label>
   <Choice label="Tipo de atividade" value={filters.type||'all'} onChange={v=>f('type',v==='all'?'':v)} options={[{value:'all',label:'Todos os tipos'},...refs.activityTypes.map((t:R)=>({value:t.id,label:t.code+' · '+t.name}))]}/>
   <Choice label="Local" value={filters.location||'all'} onChange={v=>f('location',v==='all'?'':v)} options={[{value:'all',label:'Todos os locais'},...refs.locations.map((l:R)=>({value:l.id,label:paths.get(l.id)||l.name}))]}/>
   <Choice label="Situação" value={filters.status||'padrao'} onChange={v=>f('status',v==='padrao'?'':v)} options={[{value:'padrao',label:'Sem canceladas'},{value:'todas',label:'Todas, inclusive canceladas'},...Object.entries(statusNames).map(([value,[label]])=>({value,label}))]}/>
   <Input className="number-filter" aria-label="Número da OS" placeholder="Nº da OS" inputMode="numeric" value={filters.number} onChange={e=>f('number',e.target.value)}/>
   <Input className="number-filter" aria-label="Código da atividade" placeholder="Código" value={filters.code} onChange={e=>f('code',e.target.value.toUpperCase())}/>
   {Object.values(filters).some(Boolean)&&<button className="text-action" onClick={()=>setFilters(EMPTY_FILTERS)}>Limpar</button>}
  </div>
  <ArrangeControls view={view} onChange={setView} orgs={refs.orgs} sectors={refs.sectors||[]}/>
  <div className="display-toggle"><div className="segmented" role="group" aria-label="Exibição"><button type="button" aria-pressed={!resources&&view.display==='lista'} onClick={()=>{showResources(false);setView({display:'lista'})}}>Lista</button><button type="button" aria-pressed={!resources&&view.display==='gantt'} onClick={()=>{showResources(false);setView({display:'gantt'})}}>Gantt</button><button type="button" aria-pressed={resources} onClick={()=>showResources(true)}>Agenda de recursos</button></div>
   <small>{resources?'Uso de equipamentos, funções e materiais das OS desta lista, por data.':view.display==='gantt'?'Mesmas OS e mesma ordem da lista; a posição das barras segue as datas.':'Mesmas OS e mesma ordem do Gantt.'}</small>
   <a className="chip present-link" href={presentation} target="_blank" rel="noopener" title="Abre a Apresentação (TV) com esta organização e estes filtros"><MonitorPlay size={14} className="inline"/> Apresentação</a></div>
  <div className="org-counts" aria-label="OS por organização solicitante">{[...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([org,n])=><span key={org}><OrgTag org={orgOf(org)}/><b>{n}</b><small>{Math.round(100*n/Math.max(1,shown.length))}%</small></span>)}<span className="org-total">{shown.length} OS{filtering?` de ${rows.total} (filtros de solicitante e setor)`:''}{rows.scoped?' no seu escopo':''}{filters.from||filters.to?' com programação no período':''}{rows.more?' · lista limitada às 1.000 primeiras':''}</span></div>
  {!shown.length?<Empty icon={ClipboardList} title="Nenhuma OS encontrada" description={filtering?'Nenhuma OS atende aos filtros de solicitante e setor. Limpe os filtros ou escolha outros valores.':'OS lançadas aparecem aqui. Rascunhos ficam no Planejamento de atividade.'}/>
  :resources?<ResourceAgenda query={query} orderIds={shown.map(r=>r.item.id)} period={{from:filters.from,to:filters.to}} exportParams={resExport}/>
  :view.display==='gantt'?<Gantt groups={groups} orgs={refs.orgs} now={now} onOpen={id=>{const o=(rows.orders as R[]).find(x=>x.id===id);if(o)openDetail(o)}}/>:<>
   <div className="table-scroll orders-table"><Table><TableHeader><TableRow><TableHead>OS</TableHead><TableHead>Atividade</TableHead><TableHead>Solicitante</TableHead><TableHead>Local</TableHead><TableHead>Período planejado</TableHead><TableHead>Real</TableHead><TableHead>Situação</TableHead><TableHead>Etapas</TableHead></TableRow></TableHeader><TableBody>{groups.map(g=><Fragment key={g.key}>{g.label&&<TableRow className="group-row"><TableCell colSpan={8}><div className="group-head">{head(g)}</div></TableCell></TableRow>}{g.rows.map(({item:o,flags:fl})=><TableRow key={o.id} className="clickable" onClick={()=>void openDetail(o)}><TableCell><button className="tag-label" onClick={e=>{e.stopPropagation();void openDetail(o)}}>{osLabel(o.number)}</button>{o.sector_code&&<small>{o.sector_code}</small>}</TableCell><TableCell><b>{o.activity_name}</b><small title={o.description||undefined}>{[o.activity_code,clip(o.description)].filter(Boolean).join(' · ')||'—'}</small></TableCell><TableCell><OrgTag org={orgOf(o.org_id)}/></TableCell><TableCell><span className="loc-cell" title={paths.get(o.location_id)||undefined}>{(()=>{const parts=(paths.get(o.location_id)||'—').split(' › ');return <><b>{parts[parts.length-1]}</b>{parts.length>1&&<small>{parts[parts.length-2]}</small>}</>;})()}</span></TableCell><TableCell>{o.planned_start?range(o.planned_start,o.planned_end):<span className="pending-text">Sem início planejado</span>}</TableCell><TableCell>{o.actual_start?range(o.actual_start,o.actual_end):'—'}</TableCell><TableCell>{status(o,fl)}</TableCell><TableCell>{o.steps_done}/{o.steps_total}</TableCell></TableRow>)}</Fragment>)}</TableBody></Table></div>
   <ul className="order-cards">{groups.map(g=><Fragment key={g.key}>{g.label&&<li className="group-head">{head(g)}</li>}{g.rows.map(({item:o,flags:fl})=><li key={o.id}><button type="button" onClick={()=>void openDetail(o)}><div><b>{osLabel(o.number)}{o.sector_code?` · ${o.sector_code}`:''}</b><OrgTag org={orgOf(o.org_id)}/></div><span>{o.activity_name}</span><small><CalendarRange size={12} className="inline"/> {o.planned_start?range(o.planned_start,o.planned_end):'Sem início planejado'}</small><small><MapPin size={12} className="inline"/> {paths.get(o.location_id)||'—'}</small>{status(o,fl)}</button></li>)}</Fragment>)}</ul>
  </>}
  </section>

  {cancelDialog}
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

/** Código da OS = setor cadastrado; cadastro na hora (código e nome) quando ainda não existe. */
function SectorPicker({value,sectors,onChange,onRefs}:{value:string,sectors:R[],onChange:(code:string)=>void,onRefs:()=>Promise<void>}){
 const [open,setOpen]=useState(false),[code,setCode]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const options=[{value:'none',label:'Sem código'},...(sectors||[]).filter(s=>s.active||s.code===value).map(s=>({value:s.code,label:`${s.code} · ${s.name}${s.active?'':' (inativo)'}`}))];
 async function create(e:FormEvent){e.preventDefault();e.stopPropagation();setBusy(true);setError('');try{const r=await post('planning/resource',{kind:'sector',code,name});toast.success(r.message);await onRefs();onChange(r.code);setOpen(false);setCode('');setName('')}catch(err){setError((err as Error).message)}finally{setBusy(false)}}
 return <div className="sector-picker"><Choice value={value||'none'} onChange={v=>onChange(v==='none'?'':v)} options={options}/><button type="button" className="text-action" onClick={()=>setOpen(true)}><Plus size={13} className="inline"/> Cadastrar setor</button>
  <Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Plus size={16}/> CADASTRO NA HORA</div><DialogTitle>Novo setor</DialogTitle><DialogDescription>O código identifica o setor nas OS e não muda depois. Ele também aparece em Cadastros gerais › Setores.</DialogDescription></DialogHeader>
   <form onSubmit={create}><div className="form-grid"><Field label="Código *" hint="Letras, números, ponto, barra, hífen ou sublinhado (até 30)."><Input required maxLength={30} value={code} onChange={e=>setCode(e.target.value.toUpperCase().replace(/\s+/g,''))} placeholder="Ex.: MNT-01"/></Field><Field label="Nome do setor *"><Input required maxLength={120} value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Manutenção"/></Field></div>
    {error&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
    <div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setOpen(false)} disabled={busy}>Voltar</Button><Button type="submit" className="primary-action" disabled={busy||!code||!name.trim()}>{busy?<LoaderCircle className="animate-spin" size={16}/>:null} Cadastrar e usar</Button></div></form>
  </DialogContent></Dialog></div>;
}

const NOTE_KIND:Record<string,string>={ocorrencia:'Ocorrência',impacto:'Impacto',bloqueio:'Bloqueio'};
/** Apontamentos no próprio registro da atividade realizada: ocorrência num momento; impacto com
 * início e fim opcional (sem fim, fica em aberto); bloqueio com início e fim (desconta do tempo
 * efetivo). Tudo começa dentro do período real. */
function RealizedNotes({notes,start,end,categories,onChange}:{notes:Note[],start:string,end:string,categories:R[],onChange:(n:Note[])=>void}){
 const blank=():Note=>({key:crypto.randomUUID(),kind:'ocorrencia',categoryId:'',description:'',at:start,until:''});
 const [draft,setDraft]=useState<Note>(blank),[error,setError]=useState('');
 const cats=(kind:string)=>categories.filter(c=>c.kind===kind&&c.active).map(c=>({value:c.id,label:c.name}));
 const catName=(id:string)=>categories.find(c=>c.id===id)?.name;
 function add(){
  const n=draft;setError('');
  if(!start||!end)return setError('Informe antes o início e o fim reais da atividade.');
  if(!n.description.trim())return setError('Descreva o apontamento.');
  if(!n.at)return setError('Informe quando ocorreu.');
  if(n.kind==='bloqueio'){
   if(!n.categoryId)return setError('Escolha a categoria do bloqueio.');
   if(!n.until)return setError('Informe até quando a atividade ficou parada.');
   if(!(n.at>start&&n.until>n.at&&n.until<end))return setError('O bloqueio deve começar depois do início real e terminar antes do fim real.');
   if(notes.some(x=>x.kind==='bloqueio'&&x.at<n.until&&x.until>n.at))return setError('Este bloqueio se sobrepõe a outro.');
  }else if(n.at<start||n.at>end)return setError('O momento deve estar entre o início e o fim reais.');
  else if(n.kind==='impacto'&&n.until&&n.until<n.at)return setError('O fim do impacto não pode ser antes do início (quando ocorreu).');
  onChange([...notes,{...n,description:n.description.trim()}].sort((a,b)=>a.at.localeCompare(b.at)));setDraft({...blank(),at:n.at});
 }
 const when=(v:string)=>v?v.slice(8,10)+'/'+v.slice(5,7)+' '+v.slice(11,16):'—';
 return <section className="n-panel plan-section"><div className="panel-heading"><div><h2>Apontamentos da atividade</h2><p>Opcional. Ocorrências, impactos e bloqueios que aconteceram durante a atividade. Bloqueios param o tempo efetivo entre o início e o fim informados. Tudo fica marcado como registro posterior.</p></div></div>
  <div className="rn-body">
   {notes.length?<ul className="occ-list">{notes.map(n=><li key={n.key}><div><Badge tone={n.kind==='bloqueio'?'danger':n.kind==='impacto'?'warning':'info'}>{NOTE_KIND[n.kind]}</Badge>{n.categoryId&&<Badge>{catName(n.categoryId)}</Badge>}<b>{n.description}</b><button type="button" className="icon-action" aria-label={`Remover apontamento: ${n.description}`} onClick={()=>onChange(notes.filter(x=>x.key!==n.key))}><X size={14}/></button></div>
    <small>{n.kind==='bloqueio'?`Parada de ${when(n.at)} até ${when(n.until)}`:n.kind==='impacto'?`Impacto de ${when(n.at)} ${n.until?`até ${when(n.until)}`:'· em aberto (registre a solução depois, nos Apontamentos)'}`:`Em ${when(n.at)}`}</small></li>)}</ul>:<p className="muted-text">Nenhum apontamento informado.</p>}
   <div className="form-grid rn-form">
    <Field label="Tipo"><Choice value={draft.kind} onChange={v=>setDraft(d=>({...d,kind:v,categoryId:''}))} options={[{value:'ocorrencia',label:'Ocorrência'},{value:'impacto',label:'Impacto'},{value:'bloqueio',label:'Bloqueio (parou a atividade)'}]}/></Field>
    <Field label={draft.kind==='bloqueio'?'Categoria *':'Categoria'}><Choice value={draft.categoryId||'none'} onChange={v=>setDraft(d=>({...d,categoryId:v==='none'?'':v}))} options={[...(draft.kind==='bloqueio'?[]:[{value:'none',label:'Sem categoria'}]),...cats(draft.kind)]} placeholder={cats(draft.kind).length?'Selecione':'Cadastre categorias em Cadastros gerais'}/></Field>
    <Field label={draft.kind==='bloqueio'?'Parou em (Brasília) *':'Quando ocorreu (Brasília) *'}><Input type="datetime-local" value={draft.at} min={start||undefined} max={end||undefined} onChange={e=>setDraft(d=>({...d,at:e.target.value}))}/></Field>
    {draft.kind==='bloqueio'?<Field label="Retomou em (Brasília) *"><Input type="datetime-local" value={draft.until} min={draft.at||start||undefined} max={end||undefined} onChange={e=>setDraft(d=>({...d,until:e.target.value}))}/></Field>
     :draft.kind==='impacto'?<Field label="Fim do impacto (Brasília)" hint="Opcional. Em branco, fica em aberto."><Input type="datetime-local" value={draft.until} min={draft.at||undefined} onChange={e=>setDraft(d=>({...d,until:e.target.value}))}/></Field>:<div/>}
    <Field label={draft.kind==='bloqueio'?'Justificativa do bloqueio *':'Descrição *'} wide><Textarea maxLength={2000} value={draft.description} onChange={e=>setDraft(d=>({...d,description:e.target.value}))} placeholder={draft.kind==='bloqueio'?'Ex.: Chuva forte; equipe abrigada até 10h40':'O que aconteceu'}/></Field>
   </div>
   {error&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
   <div className="rn-actions"><Button type="button" variant="outline" onClick={add}><Plus size={15}/> Incluir apontamento</Button></div>
  </div>
 </section>;
}
