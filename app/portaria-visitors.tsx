'use client';
// Cadastros › Colaboradores › Visitantes: pessoas e empresas da Portaria (cadastradas na hora ou pela gestão).
// Ficam separadas dos colaboradores do Planejamento e do cadastro de Solicitantes e clientes.
import {useCallback,useEffect,useState,FormEvent} from 'react';
import {Plus,Pencil,Search,LoaderCircle,CheckCheck,Users,Building2} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Badge,Empty,Field,Toggle,Choice,type R} from './kit';
import {pget,ppost,query,useIntent,dmyhm,DOC_TYPES,CompanyPicker,LoadError} from './portaria-kit';

export default function PortariaVisitors({refreshKey}:{refreshKey?:number}){
 const [q,setQ]=useState(''),[data,setData]=useState<R|null>(null),[pending,setPending]=useState<R[]>([]),[error,setError]=useState('');
 const [person,setPerson]=useState<R|null>(null),[company,setCompany]=useState<R|null>(null);
 const refresh=useCallback(async()=>{
  try{const [d,p]=await Promise.all([pget<R>('registry?'+query({q,limit:50})),pget<R>('pending-review')]);setData(d);setPending(p.rows);setError('')}catch(e){setError((e as Error).message)}
 },[q]);
 useEffect(()=>{const t=setTimeout(()=>void refresh(),q?250:0);return()=>clearTimeout(t)},[refresh,refreshKey,q]);
 const intent=useIntent();
 async function mark(id:string){try{await ppost('review/mark',{id},intent.key());intent.renew();toast.success('Cadastro marcado como revisado.');await refresh()}catch(e){toast.error((e as Error).message)}}
 async function edit(p:R){
  try{const d=await pget<R>('person?id='+p.id);setPerson({id:d.id,name:d.name,documentType:d.documentType,documentNumber:d.documentNumber,active:d.active,companyId:d.companyId,companyName:d.companyName})}
  catch(e){toast.error((e as Error).message)}
 }
 if(error&&!data)return <LoadError title="Visitantes indisponíveis" message={error}/>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 const rows=data.rows as R[],companies=data.companies as R[];
 return <div className="por-screen">
  {pending.length>0&&<section className="n-panel"><div className="panel-heading"><div><h2>Aguardam revisão da gestão</h2><p>Cadastrados na hora pela Portaria. Confira nome, documento e empresa; ajuste se preciso e marque como revisado.</p></div></div>
   <div className="table-scroll"><table className="eu-table"><thead><tr><th>Tipo</th><th>Cadastro</th><th>Empresa</th><th>Criado por</th><th/></tr></thead><tbody>
    {pending.map(r=><tr key={r.id}><td><Badge tone={r.kind==='pessoa'?'info':'warning'}>{r.kind==='pessoa'?'Visitante':'Empresa'}</Badge></td><td><b>{r.name}</b>{r.documentType&&<small className="muted-text"> {r.documentType}</small>}</td><td>{r.companyName||'—'}</td><td>{r.createdByName}<small className="muted-text"> {dmyhm(r.createdAt)}</small></td>
     <td><Button size="sm" variant="outline" onClick={()=>void mark(r.id)}><CheckCheck size={14}/> Revisado</Button></td></tr>)}</tbody></table></div></section>}
  <section className="n-panel"><div className="panel-heading"><div><h2>Visitantes</h2><p>Pessoas que entram na Base Açu. Separados dos colaboradores do Planejamento. O documento aparece mascarado; só o número completo encontra a pessoa na busca.</p></div>
   <Button onClick={()=>{setCompany(null);setPerson({name:'',documentType:'CPF',documentNumber:'',active:true})}}><Plus size={16}/> Novo visitante</Button></div>
   <div className="search-box"><Search size={16} aria-hidden/><Input value={q} onChange={e=>setQ(e.target.value)} placeholder="Nome, empresa ou documento completo" aria-label="Buscar visitantes"/></div>
   {rows.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th>Nome</th><th>Empresa</th><th>Documento</th><th>Situação</th><th/></tr></thead><tbody>
    {rows.map(p=><tr key={p.id}><td><b>{p.name}</b></td><td>{p.companyName}</td><td>{p.documentType} {p.documentMasked}</td>
     <td>{p.active?<Badge tone="success">Ativo</Badge>:<Badge>Inativo</Badge>}{p.pending&&<Badge tone="warning">Aguarda revisão</Badge>}{p.present&&<Badge tone="info">Na base</Badge>}</td>
     <td><button className="icon-action" aria-label={`Editar ${p.name}`} onClick={()=>void edit(p)}><Pencil size={16}/></button></td></tr>)}</tbody></table></div>
    :<Empty icon={Users} title="Nenhum visitante" description="Os visitantes cadastrados na hora pela Portaria ou aqui aparecem nesta lista."/>}
   {data.hasMore&&<p className="muted-text">Mostrando os primeiros 50. Refine a busca para ver os demais.</p>}
  </section>
  <CompaniesBlock companies={companies} onChanged={()=>void refresh()}/>
  {person&&<PersonDialog person={person} company={company} setCompany={setCompany} onClose={()=>setPerson(null)} onDone={()=>{setPerson(null);void refresh()}}/>}
 </div>;
}

function PersonDialog({person,company,setCompany,onClose,onDone}:{person:R,company:R|null,setCompany:(c:R|null)=>void,onClose:()=>void,onDone:()=>void}){
 const [form,setForm]=useState<R>(person),[busy,setBusy]=useState(false),[error,setError]=useState(''),intent=useIntent();
 const current=company||(person.id?{id:person.companyId,name:person.companyName}:null);
 async function submit(e:FormEvent){
  e.preventDefault();setBusy(true);setError('');
  try{
   if(!current)throw new Error('Escolha a empresa do visitante.');
   const r=await ppost('person/save',{id:person.id,name:form.name,documentType:form.documentType,documentNumber:form.documentNumber,companyId:current.id,active:form.active},intent.key());
   intent.renew();toast.success(r.message);onDone();
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>{person.id?'Editar visitante':'Novo visitante'}</DialogTitle>
  <DialogDescription>Mudanças no cadastro não alteram as visitas já registradas: cada visita guarda os dados da época.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Nome completo *" wide><Input required maxLength={180} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></Field>
   <Field label="Tipo de documento *"><Choice value={form.documentType} onChange={v=>setForm(f=>({...f,documentType:v}))} options={DOC_TYPES.map(t=>({value:t,label:t}))}/></Field>
   <Field label="Número do documento *"><Input required maxLength={40} value={form.documentNumber} onChange={e=>setForm(f=>({...f,documentNumber:e.target.value}))}/></Field>
   <Field label="Empresa *" wide><CompanyPicker value={current} onChange={setCompany}/></Field>
   <Toggle title="Cadastro ativo" description="Inativo não aparece na busca da Portaria, mas o histórico continua." checked={!!form.active} onChange={v=>setForm(f=>({...f,active:v}))}/>
  </div>{error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Salvar</Button></div></form>
 </DialogContent></Dialog>;
}

/** Empresas criadas na Portaria (as de Solicitantes e clientes são editadas lá e entram só leitura). */
function CompaniesBlock({companies,onChanged}:{companies:R[],onChanged:()=>void}){
 const [edit,setEdit]=useState<R|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),intent=useIntent();
 async function submit(e:FormEvent){
  e.preventDefault();setBusy(true);setError('');
  try{const r=await ppost('company/save',{id:edit!.id,name:edit!.name,active:edit!.active},intent.key());intent.renew();toast.success(r.message);setEdit(null);onChanged()}
  catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <section className="n-panel"><div className="panel-heading"><div><h2>Empresas dos visitantes</h2><p>Criadas na Portaria ou aqui. As empresas de Solicitantes e clientes são usadas só para leitura e se editam em Cadastros › Solicitantes e clientes.</p></div>
  <Button variant="outline" onClick={()=>{setError('');setEdit({name:'',active:true})}}><Plus size={16}/> Nova empresa</Button></div>
  {companies.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th>Empresa</th><th>Visitantes</th><th>Situação</th><th/></tr></thead><tbody>
   {companies.map(c=><tr key={c.id}><td><b>{c.name}</b></td><td>{c.people}</td><td>{c.active?<Badge tone="success">Ativa</Badge>:<Badge>Inativa</Badge>}{c.pending&&<Badge tone="warning">Aguarda revisão</Badge>}</td>
    <td><button className="icon-action" aria-label={`Editar ${c.name}`} onClick={()=>{setError('');setEdit({...c})}}><Pencil size={16}/></button></td></tr>)}</tbody></table></div>
   :<Empty icon={Building2} title="Nenhuma empresa criada na Portaria" description="As empresas novas cadastradas na hora aparecem aqui para revisão."/>}
  <Dialog open={!!edit} onOpenChange={v=>{if(!busy&&!v)setEdit(null)}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>{edit?.id?'Editar empresa':'Nova empresa'}</DialogTitle><DialogDescription>Visitas antigas mantêm o nome da época.</DialogDescription></DialogHeader>
   {edit&&<form onSubmit={submit}><div className="form-grid"><Field label="Nome *" wide><Input required maxLength={120} value={edit.name} onChange={e=>setEdit(x=>({...x!,name:e.target.value}))}/></Field>
    <Toggle title="Empresa ativa" checked={!!edit.active} onChange={v=>setEdit(x=>({...x!,active:v}))}/></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>setEdit(null)}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Salvar</Button></div></form>}
  </DialogContent></Dialog>
 </section>;
}
