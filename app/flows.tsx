'use client';
// Planejamento › Cadastro de fluxo. Cada gravação publica uma versão imutável; planejamentos
// e OS futuros guardarão a versão usada, e nada é atualizado silenciosamente.
import {useCallback,useEffect,useMemo,useState,FormEvent} from 'react';
import {Plus,Pencil,Copy,Power,History,AlertTriangle,LoaderCircle,Workflow,ArrowUp,ArrowDown,Trash2,Info,ChevronRight,Clock,Users,Truck} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,MultiCheck,Toggle,fmt,post,load,type R} from './kit';

const newKey=()=>crypto.randomUUID().replaceAll('-','').slice(0,16);
/** Duração em HH:MM com horas acumuladas (27:35, 125:08). */
export const hhmm=(minutes:number|null|undefined)=>minutes==null?'—':`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const parseHHMM=(v:string)=>{if(!v.trim())return null;const m=/^(\d{1,4}):([0-5]\d)$/.exec(v.trim());if(!m)return NaN;return Number(m[1])*60+Number(m[2])};

/** Camadas de execução: etapas da mesma camada podem ocorrer em paralelo. */
export function layers(steps:{key:string,dependsOn:string[]}[]){
 const level=new Map<string,number>();const pending=new Map(steps.map(s=>[s.key,s.dependsOn.filter(d=>steps.some(x=>x.key===d))]));
 let guard=0;
 while(pending.size&&guard++<steps.length+1){for(const [k,deps] of [...pending]){if(deps.every(d=>level.has(d))){level.set(k,deps.length?Math.max(...deps.map(d=>level.get(d)!))+1:0);pending.delete(k)}}}
 return {level,cyclic:[...pending.keys()]};
}

type Step={key:string,name:string,description:string,duration:string,required:boolean,dependsOn:string[],needs:{kind:'type'|'function',ref:string,quantity:number}[]};

export default function Flows({refreshKey}:{refreshKey:number}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState<{item?:R}|null>(null),[form,setForm]=useState<R>({}),[saving,setSaving]=useState(false),[formError,setFormError]=useState(''),[dup,setDup]=useState<R|null>(null),[versions,setVersions]=useState<{type:R,selected?:R,steps?:R[]}|null>(null),[openId,setOpenId]=useState<string|null>(null);
 const refresh=useCallback(async()=>{try{setData(await load<R>('flows'));setError('')}catch(e){setError((e as Error).message)}},[]);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Dados recebidos de uma consulta assíncrona ao servidor.
 useEffect(()=>{void refresh()},[refresh,refreshKey]);
 const name=useCallback((list:string,id:string)=>(data?.[list] as R[]|undefined)?.find(x=>x.id===id)?.name||'—',[data]);

 const toForm=(steps:R[]):Step[]=>steps.map(s=>({key:s.step_key,name:s.name,description:s.description,duration:s.default_minutes?hhmm(s.default_minutes):'',required:!!s.required,dependsOn:s.depends_on,needs:s.needs.map((n:R)=>({kind:n.equipment_type_id?'type':'function',ref:n.equipment_type_id||n.function_id,quantity:n.quantity}))}));
 function edit(item?:R){setFormError('');setEditing({item});setForm(item?{id:item.id,code:item.code,name:item.name,description:item.description,expectedVersion:item.current_version,notes:'',steps:toForm(item.steps)}:{code:'',name:'',description:'',notes:'',steps:[{key:newKey(),name:'',description:'',duration:'',required:true,dependsOn:[],needs:[]}]})}
 const steps:Step[]=useMemo(()=>form.steps||[],[form.steps]);
 const check=useMemo(()=>layers(steps),[steps]);
 const setStep=(i:number,patch:Partial<Step>)=>setForm(f=>({...f,steps:f.steps.map((s:Step,j:number)=>j===i?{...s,...patch}:s)}));
 const move=(i:number,d:number)=>setForm(f=>{const s=[...f.steps];const [x]=s.splice(i,1);s.splice(i+d,0,x);return {...f,steps:s}});
 const remove=(i:number)=>setForm(f=>{const gone=f.steps[i].key;return {...f,steps:f.steps.filter((_:Step,j:number)=>j!==i).map((s:Step)=>({...s,dependsOn:s.dependsOn.filter(d=>d!==gone)}))}});

 async function submit(e:FormEvent){
  e.preventDefault();setFormError('');
  const bad=steps.find(s=>Number.isNaN(parseHHMM(s.duration)));if(bad){setFormError(`Duração de “${bad.name||'etapa sem nome'}” deve estar em HH:MM (ex.: 01:30 ou 27:35).`);return}
  if(check.cyclic.length){setFormError('Há dependência circular entre etapas. Revise as dependências destacadas.');return}
  setSaving(true);
  try{
   const r=await post('flows/save',{id:form.id,code:form.code,name:form.name,description:form.description,notes:form.notes,expectedVersion:form.expectedVersion,steps:steps.map(s=>({key:s.key,name:s.name,description:s.description,defaultMinutes:parseHHMM(s.duration),required:s.required,dependsOn:s.dependsOn,needs:s.needs.filter(n=>n.ref).map(n=>n.kind==='type'?{equipmentTypeId:n.ref,quantity:n.quantity}:{functionId:n.ref,quantity:n.quantity})}))});
   setEditing(null);toast.success(r.message||'Fluxo salvo.');await refresh();
  }catch(err){setFormError((err as Error).message)}finally{setSaving(false)}
 }
 async function duplicate(e:FormEvent){e.preventDefault();if(!dup)return;setSaving(true);try{const r=await post('flows/duplicate',{id:dup.id,code:dup.newCode,name:dup.newName});setDup(null);toast.success(r.message);await refresh()}catch(err){toast.error((err as Error).message)}finally{setSaving(false)}}
 async function toggle(t:R){try{await post('flows/status',{id:t.id,active:!t.active,updatedAt:t.updated_at});toast.success(t.active?'Tipo de atividade inativado: não poderá ser usado em novos planejamentos.':'Tipo de atividade reativado.');await refresh()}catch(e){toast.error((e as Error).message)}}
 async function pickVersion(type:R,v:R){setVersions({type,selected:v});try{const r=await load<R>('flows/version?id='+encodeURIComponent(v.id));setVersions({type,selected:v,steps:r.steps})}catch(e){toast.error((e as Error).message)}}

 if(error)return <div className="error-panel"><AlertTriangle/><h2>Não foi possível abrir os fluxos</h2><p>{error}</p><Button onClick={()=>void refresh()}>Tentar novamente</Button></div>;
 if(!data)return <div className="loading-grid"><Skeleton className="h-64 rounded-xl"/><Skeleton className="h-64 rounded-xl"/></div>;
 const types:R[]=data.activityTypes;
 const typeOptions=(keep:string)=>data.equipmentTypes.filter((t:R)=>t.active||t.id===keep).map((t:R)=>({value:t.id,label:t.name}));
 const functionOptions=(keep:string)=>data.functions.filter((t:R)=>t.active||t.id===keep).map((t:R)=>({value:t.id,label:t.name}));

 return <div className="flows">
  <section className="n-panel"><div className="panel-heading"><div><h2>Tipos de atividade</h2><p>Hierarquia: tipo de atividade → etapas. A OS será a execução concreta de uma versão.</p></div><Button onClick={()=>edit()}><Plus size={16}/> Novo fluxo</Button></div>
   {types.length?<ul className="flow-list">{types.map(t=>{const open=openId===t.id;const {level}=layers(t.steps.map((s:R)=>({key:s.step_key,dependsOn:s.depends_on})));const columns=Math.max(0,...level.values())+1;return <li key={t.id} className={t.active?'':'inactive'}>
    <div className="flow-row"><button type="button" className="flow-toggle" aria-expanded={open} onClick={()=>setOpenId(open?null:t.id)}><ChevronRight size={17} className={open?'rotated':''}/><span><b>{t.name}</b><small><span className="tag-label">{t.code}</span> v{t.current_version} · {t.steps.length} etapa{t.steps.length===1?'':'s'} · {columns} fase{columns===1?'':'s'}</small></span></button>
     <div className="access-actions">{!t.active&&<Badge>Inativo</Badge>}<button className="icon-action" onClick={()=>edit(t)} aria-label={`Editar ${t.code}`} title="Editar (nova versão)"><Pencil size={16}/></button><button className="icon-action" onClick={()=>setDup({...t,newCode:t.code+'-2',newName:t.name+' (cópia)'})} aria-label={`Duplicar ${t.code}`} title="Duplicar"><Copy size={16}/></button><button className="icon-action" onClick={()=>setVersions({type:t})} aria-label={`Versões de ${t.code}`} title="Versões"><History size={16}/></button><button className="icon-action" onClick={()=>void toggle(t)} aria-label={t.active?`Inativar ${t.code}`:`Reativar ${t.code}`} title={t.active?'Inativar':'Reativar'}><Power size={16}/></button></div></div>
    {open&&<div className="flow-detail">{t.description&&<p className="flow-description">{t.description}</p>}<FlowDiagram steps={t.steps} name={name}/></div>}
   </li>})}</ul>:<Empty icon={Workflow} title="Nenhum fluxo cadastrado" description="Cadastre um tipo de atividade, por exemplo “Movimentação de materiais”, com suas etapas, dependências e necessidades padrão." action={<Button onClick={()=>edit()}><Plus size={16}/> Cadastrar fluxo</Button>}/>}
  </section>
  <div className="notice inline"><Info size={17}/><span>Dependência é do tipo <b>término → início</b>: a etapa só começa quando todas as anteriores marcadas estiverem concluídas ou dispensadas. Etapas sem dependência podem ocorrer em paralelo. A posição na lista é só a ordem de exibição.</span></div>

  <Dialog open={!!editing} onOpenChange={v=>{if(!saving&&!v)setEditing(null)}}><DialogContent className="n-dialog n-dialog-wide"><DialogHeader><div className="modal-eyebrow"><Workflow size={16}/> PLANEJAMENTO · CADASTRO DE FLUXO</div><DialogTitle>{editing?.item?`${editing.item.code} · nova versão`:'Novo tipo de atividade'}</DialogTitle><DialogDescription>{editing?.item?`Salvar publica a versão ${editing.item.current_version+1}. A versão ${editing.item.current_version} continua consultável e não muda.`:'O fluxo nasce na versão 1.'}</DialogDescription></DialogHeader>
   <form onSubmit={submit}><div className="form-grid">
    {editing?.item?<div className="n-field"><label>Código</label><span className="tag-label">{form.code}</span></div>:<Field label="Código *" hint="Ex.: MOV-MAT. Não muda depois."><Input required maxLength={20} value={form.code||''} onChange={e=>setForm(f=>({...f,code:e.target.value.toUpperCase()}))}/></Field>}
    <Field label="Nome *"><Input required maxLength={120} value={form.name||''} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Ex.: Movimentação de materiais"/></Field>
    <Field label="Descrição" wide><Textarea maxLength={1000} value={form.description||''} onChange={e=>setForm(f=>({...f,description:e.target.value}))}/></Field>
    <fieldset className="n-field wide question-list"><legend>Etapas *</legend>
     {steps.map((s,i)=>{const cyclic=check.cyclic.includes(s.key);return <div className={`question-card ${cyclic?'invalid':''}`} key={s.key}>
      <div className="question-head"><b>{i+1}</b><Input required aria-label={`Nome da etapa ${i+1}`} maxLength={120} value={s.name} onChange={e=>setStep(i,{name:e.target.value})} placeholder="Ex.: Inspeção do equipamento"/><div className="question-tools"><button type="button" className="icon-action" disabled={i===0} onClick={()=>move(i,-1)} aria-label={`Subir etapa ${i+1}`}><ArrowUp size={15}/></button><button type="button" className="icon-action" disabled={i===steps.length-1} onClick={()=>move(i,1)} aria-label={`Descer etapa ${i+1}`}><ArrowDown size={15}/></button><button type="button" className="icon-action" disabled={steps.length===1} onClick={()=>remove(i)} aria-label={`Remover etapa ${i+1}`}><Trash2 size={15}/></button></div></div>
      <div className="form-grid">
       <Field label="Descrição" wide><Textarea maxLength={1000} value={s.description} onChange={e=>setStep(i,{description:e.target.value})}/></Field>
       <Field label="Duração padrão (HH:MM)" hint="Opcional. Pode passar de 24 h (ex.: 27:35)."><Input inputMode="numeric" maxLength={7} value={s.duration} onChange={e=>setStep(i,{duration:e.target.value})} placeholder="01:30"/></Field>
       <Toggle title={s.required?'Etapa obrigatória':'Etapa opcional'} description={s.required?'Sempre incluída no planejamento.':'O planejador decide se inclui.'} checked={s.required} onChange={v=>setStep(i,{required:v})}/>
       <MultiCheck label="Depende de (término → início)" options={steps.filter(x=>x.key!==s.key).map(x=>({value:x.key,label:x.name||`Etapa ${steps.indexOf(x)+1}`}))} value={s.dependsOn} onChange={v=>setStep(i,{dependsOn:v})} empty="Sem outras etapas." hint={cyclic?'Dependência circular: esta etapa depende, direta ou indiretamente, dela mesma.':s.dependsOn.length?undefined:'Sem dependência: pode começar em paralelo.'}/>
       <fieldset className="n-field wide"><legend>Necessidades padrão</legend>
        {s.needs.map((n,k)=><div className="need-row" key={k}><div className="segmented" role="group" aria-label="Tipo de necessidade">{[['type','Equipamento'],['function','Função']].map(([v,l])=><button type="button" key={v} aria-pressed={n.kind===v} onClick={()=>setStep(i,{needs:s.needs.map((x,j)=>j===k?{...x,kind:v as 'type'|'function',ref:''}:x)})}>{l}</button>)}</div><Choice label={n.kind==='type'?'Tipo de equipamento':'Função'} value={n.ref} onChange={v=>setStep(i,{needs:s.needs.map((x,j)=>j===k?{...x,ref:v}:x)})} options={n.kind==='type'?typeOptions(n.ref):functionOptions(n.ref)}/><Input type="number" min={1} max={99} aria-label="Quantidade" value={n.quantity} onChange={e=>setStep(i,{needs:s.needs.map((x,j)=>j===k?{...x,quantity:Number(e.target.value)}:x)})}/><button type="button" className="icon-action" onClick={()=>setStep(i,{needs:s.needs.filter((_,j)=>j!==k)})} aria-label="Remover necessidade"><Trash2 size={15}/></button></div>)}
        <button type="button" className="text-action" onClick={()=>setStep(i,{needs:[...s.needs,{kind:'type',ref:'',quantity:1}]})}><Plus size={14} className="inline"/> Adicionar necessidade</button>
        <small>Quantidade por tipo ou função. A identificação de cada equipamento acontece no planejamento da OS.</small>
       </fieldset>
      </div>
     </div>})}
     <Button type="button" variant="outline" onClick={()=>setForm(f=>({...f,steps:[...f.steps,{key:newKey(),name:'',description:'',duration:'',required:true,dependsOn:[],needs:[]}]}))} disabled={steps.length>=60}><Plus size={16}/> Adicionar etapa</Button>
    </fieldset>
    <div className="wide"><p className="field-title">Prévia da execução</p>{check.cyclic.length?<div className="form-error"><AlertTriangle size={17}/>Dependência circular entre: {steps.filter(s=>check.cyclic.includes(s.key)).map(s=>s.name||'etapa sem nome').join(', ')}.</div>:<FlowDiagram steps={steps.map(s=>({step_key:s.key,name:s.name||'Etapa sem nome',depends_on:s.dependsOn,required:s.required?1:0,default_minutes:Number.isNaN(parseHHMM(s.duration))?null:parseHHMM(s.duration),needs:s.needs.filter(n=>n.ref).map(n=>({equipment_type_id:n.kind==='type'?n.ref:null,function_id:n.kind==='function'?n.ref:null,quantity:n.quantity}))}))} name={name}/>}</div>
    {editing?.item&&<Field label="O que mudou nesta versão" wide><Input maxLength={500} value={form.notes||''} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Ex.: conferência passou a ser opcional"/></Field>}
   </div>{formError&&<div className="form-error" role="alert"><AlertTriangle size={17}/>{formError}</div>}<div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setEditing(null)} disabled={saving}>Voltar</Button><Button type="submit" className="primary-action" disabled={saving}>{saving?<><LoaderCircle className="animate-spin" size={16}/> Salvando…</>:editing?.item?'Publicar nova versão':'Cadastrar fluxo'}</Button></div></form>
  </DialogContent></Dialog>

  <Dialog open={!!dup} onOpenChange={v=>{if(!saving&&!v)setDup(null)}}><DialogContent className="n-dialog"><DialogHeader><div className="modal-eyebrow"><Copy size={16}/> DUPLICAR FLUXO</div><DialogTitle>Novo tipo a partir de {dup?.code}</DialogTitle><DialogDescription>Copia as etapas da versão vigente (v{dup?.current_version}) para um novo tipo de atividade, que nasce na versão 1.</DialogDescription></DialogHeader>
   <form onSubmit={duplicate}><div className="form-grid"><Field label="Código *"><Input required maxLength={20} value={dup?.newCode||''} onChange={e=>setDup(d=>d&&{...d,newCode:e.target.value.toUpperCase()})}/></Field><Field label="Nome *"><Input required maxLength={120} value={dup?.newName||''} onChange={e=>setDup(d=>d&&{...d,newName:e.target.value})}/></Field></div><div className="modal-footer"><Button type="button" variant="outline" onClick={()=>setDup(null)}>Voltar</Button><Button type="submit" className="primary-action" disabled={saving}>Duplicar</Button></div></form>
  </DialogContent></Dialog>

  <Dialog open={!!versions} onOpenChange={v=>{if(!v)setVersions(null)}}><DialogContent className="n-dialog n-dialog-wide"><DialogHeader><div className="modal-eyebrow"><History size={16}/> VERSÕES · {versions?.type.code}</div><DialogTitle>{versions?.type.name}</DialogTitle><DialogDescription>Versões publicadas não mudam. Selecione uma para consultar suas etapas.</DialogDescription></DialogHeader>
   <ol className="version-list">{versions?.type.versions.map((v:R)=><li key={v.id} className={versions.selected?.id===v.id?'selected':''}><button type="button" onClick={()=>void pickVersion(versions.type,v)}><b>v{v.version} · {v.name}{v.version===versions.type.current_version&&' (vigente)'}</b><small>{fmt(v.created_at)} · {v.created_by_name}</small>{v.notes&&<p>{v.notes}</p>}</button></li>)}</ol>
   {versions?.selected&&(versions.steps?<FlowDiagram steps={versions.steps} name={name}/>:<Skeleton className="h-24"/>)}
  </DialogContent></Dialog>
 </div>;
}

/** Fases (colunas) mostram o que pode ocorrer em paralelo; setas implícitas pelas dependências listadas. */
function FlowDiagram({steps,name}:{steps:R[],name:(list:string,id:string)=>string}){
 const {level}=layers(steps.map(s=>({key:s.step_key,dependsOn:s.depends_on})));
 const columns=Math.max(0,...level.values())+1;
 const label=(k:string)=>steps.find(s=>s.step_key===k)?.name||'?';
 if(!steps.length)return null;
 return <div className="flow-diagram" role="list" aria-label="Etapas por fase de execução">{Array.from({length:columns},(_,c)=><div className="flow-phase" key={c} role="listitem"><span className="flow-phase-label">Fase {c+1}{steps.filter(s=>level.get(s.step_key)===c).length>1&&' · em paralelo'}</span>{steps.filter(s=>level.get(s.step_key)===c).map(s=><article key={s.step_key} className={`flow-step ${s.required?'':'optional'}`}><b>{s.name}</b>{!s.required&&<Badge>Opcional</Badge>}{s.default_minutes!=null&&<small><Clock size={12}/> {hhmm(s.default_minutes)}</small>}{s.depends_on.length>0&&<small>Após: {s.depends_on.map(label).join(', ')}</small>}{s.needs.map((n:R,i:number)=><small key={i}>{n.equipment_type_id?<Truck size={12}/>:<Users size={12}/>} {n.quantity}× {n.equipment_type_id?name('equipmentTypes',n.equipment_type_id):name('functions',n.function_id)}</small>)}</article>)}</div>)}</div>;
}
