'use client';
// Ferramentaria e Inventário · fase A: painel, inventário, movimentação em carrinho e cadastros.
// Lista vira cartões no celular, a ação principal fica ao alcance do polegar e a busca aceita leitor de código.
import {useCallback,useEffect,useRef,useState,FormEvent} from 'react';
import {Plus,Search,ArrowDownToLine,ArrowUpFromLine,TriangleAlert,Pencil,LoaderCircle,Trash2,Boxes,PackageX,Handshake,Hammer,Package} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Choice,Badge,Empty,Field,Toggle,fmt,load,type R} from './kit';
import {KIND_NAMES,MOVE_NAMES,REASONS,PRESET_KEY,qtyText,pl,num,useKey,tpost} from './tools-kit';
import {ContractorsTable,NEW_LOAN_KEY} from './tools-loans';
import './tools.css';

function useRefs(refreshKey?:number){
 const [refs,setRefs]=useState<R|null>(null);
 useEffect(()=>{load<R>('tools/refs').then(setRefs,()=>setRefs(null))},[refreshKey]);
 return refs;
}
const opts=(rows:R[]|undefined,none?:string)=>[...(none?[{value:'none',label:none}]:[]),...((rows||[]).filter(r=>r.active).map(r=>({value:r.id,label:r.abbr?`${r.name} (${r.abbr})`:r.name})))];

function BalanceBadge({item}:{item:R}){
 if(!item.active)return <Badge>Inativo</Badge>;
 if(item.balance===0)return <Badge tone="danger">Zerado</Badge>;
 if(item.low)return <Badge tone="warning">Abaixo do mínimo</Badge>;
 return <Badge tone="success">Em estoque</Badge>;
}

export function ToolsDashboard({refreshKey,onGo}:{refreshKey?:number,onGo:(v:string)=>void}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState('');
 useEffect(()=>{load<R>('tools/dashboard').then(d=>{setData(d);setError('')},e=>setError((e as Error).message))},[refreshKey]);
 const go=(kind:string)=>{try{sessionStorage.setItem(PRESET_KEY,kind)}catch{/* segue sem lembrar */}onGo('fer-movimentar')};
 if(error)return <div className="error-panel"><TriangleAlert/><h2>Painel indisponível</h2><p>{error}</p></div>;
 if(!data)return <Skeleton className="h-64 rounded-xl"/>;
 const t=data.totals as R,loans=(data.loans||{open:0,late:0,unsigned:0}) as R,today=data.today as R,low=data.low as R[],recent=data.recent as R[];
 return <div className="tl-screen">
  <div className="tl-actions" role="group" aria-label="Ações rápidas">
   <button type="button" onClick={()=>go('saida')}><ArrowUpFromLine/><b>Saída</b><small>Consumo e descarte</small></button>
   <button type="button" onClick={()=>go('entrada')}><ArrowDownToLine/><b>Receber</b><small>Compra e devolução</small></button>
   <button type="button" onClick={()=>go('perda')}><PackageX/><b>Perda</b><small>Extravio e quebra</small></button>
   <button type="button" onClick={()=>{try{sessionStorage.setItem(NEW_LOAN_KEY,'1')}catch{/* segue */}onGo('fer-emprestimos')}}><Handshake/><b>Empréstimo</b><small>Para terceirizada</small></button>
  </div>
  <div className="tl-kpis">
   <div><span>Itens ativos</span><b>{t.items}</b><small>{pl(t.ferramentas,'ferramenta','ferramentas')} · {pl(t.materiais,'material','materiais')}</small></div>
   <button type="button" className={`tl-kpi-link ${loans.late||loans.unsigned?'warn':''}`} onClick={()=>onGo('fer-emprestimos')}><span>Empréstimos abertos</span><b>{loans.open}</b><small>{pl(loans.late,'atrasado','atrasados')} · {loans.unsigned} sem assinatura há mais de 24 h</small></button>
  <div className={low.length?'warn':''}><span>Abaixo do mínimo</span><b>{low.length}</b><small>precisam de reposição</small></div>
   <div><span>Movimentos hoje</span><b>{Object.values(today).reduce((s:number,v)=>s+Number(v),0)}</b><small>{pl(today.entrada||0,'entrada','entradas')} · {pl(today.saida||0,'saída','saídas')} · {pl(today.perda||0,'perda','perdas')}</small></div>
  </div>
  <section className="n-panel"><div className="panel-heading"><div><h2>Abaixo do mínimo</h2><p>Itens com saldo igual ou menor que o mínimo cadastrado.</p></div></div>
   {low.length?<ul className="tl-list">{low.map(i=><li key={i.id}><div><b>{i.name}</b><small>{i.locationName||'Sem local'}</small></div><span className="tl-qty warn">{qtyText(i.balance)} <small>/ mín. {qtyText(i.min)} {i.unitAbbr}</small></span></li>)}</ul>
    :<Empty icon={Boxes} title="Nada abaixo do mínimo" description="Quando um item chegar ao mínimo, ele aparece aqui."/>}
  </section>
  <section className="n-panel"><div className="panel-heading"><div><h2>Últimos movimentos</h2></div></div>
   {recent.length?<ul className="tl-list">{recent.map(m=><li key={m.id}><div><b>{m.itemName}</b><small>{MOVE_NAMES[m.kind]} · {m.reason} · {m.authorName} · {fmt(m.occurredAt)}</small></div>
    <span className={`tl-qty ${m.delta<0?'out':'in'}`}>{m.delta>0?'+':''}{qtyText(m.delta)} <small>{m.unitAbbr}</small></span></li>)}</ul>
    :<Empty icon={Package} title="Nenhum movimento ainda" description="Cadastre itens e registre a primeira entrada."/>}
  </section>
 </div>;
}

function ItemForm({item,refs,onClose,onDone}:{item:R|null,refs:R,onClose:()=>void,onDone:()=>void}){
 const editing=!!item?.id;
 const [f,setF]=useState<R>(()=>item?{kind:item.kind,name:item.name,code:item.code||'',categoryId:item.categoryId||'none',locationId:item.locationId||'none',unitId:item.unitId,min:String(item.min||''),active:item.active}:{kind:'material',name:'',code:'',categoryId:'none',locationId:'none',unitId:'un',min:'',initialQty:'',active:true});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),k=useKey();
 async function submit(e:FormEvent){
  e.preventDefault();setBusy(true);setError('');
  try{
   const body:R={id:item?.id,kind:f.kind,name:f.name,code:f.code||undefined,categoryId:f.categoryId==='none'?'':f.categoryId,locationId:f.locationId==='none'?'':f.locationId,unitId:f.unitId,min:f.min===''?0:num(f.min),active:f.active};
   if(!editing&&f.initialQty!=='')body.initialQty=num(f.initialQty);
   const r=await tpost('tools/items/save',body,k);k.renew();toast.success(r.message);onDone();
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>{editing?'Editar item':'Novo item'}</DialogTitle>
  <DialogDescription>{editing?'O saldo não se edita aqui: ele muda só por movimentação.':'O saldo inicial entra como a primeira movimentação do item.'}</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Tipo *"><div className="segmented" role="group" aria-label="Tipo do item">{Object.entries(KIND_NAMES).map(([v,l])=><button key={v} type="button" className={f.kind===v?'active':''} aria-pressed={f.kind===v} onClick={()=>setF(x=>({...x,kind:v}))}>{l}</button>)}</div></Field>
   <Field label="Nome *" wide><Input required maxLength={120} value={f.name} onChange={e=>setF(x=>({...x,name:e.target.value}))}/></Field>
   <Field label="Código" hint="Opcional. Serve para o leitor de código de barras."><Input maxLength={40} value={f.code} onChange={e=>setF(x=>({...x,code:e.target.value}))}/></Field>
   <Field label="Unidade *"><Choice value={f.unitId} onChange={v=>setF(x=>({...x,unitId:v}))} options={opts(refs.units)}/></Field>
   <Field label="Categoria"><Choice value={f.categoryId} onChange={v=>setF(x=>({...x,categoryId:v}))} options={opts(refs.categories,'Sem categoria')}/></Field>
   <Field label="Local"><Choice value={f.locationId} onChange={v=>setF(x=>({...x,locationId:v}))} options={opts(refs.locations,'Sem local')}/></Field>
   <Field label="Estoque mínimo" hint="Abaixo ou igual a este valor o item entra nos alertas."><Input inputMode="decimal" value={f.min} onChange={e=>setF(x=>({...x,min:e.target.value}))} placeholder="0"/></Field>
   {!editing&&<Field label="Saldo inicial"><Input inputMode="decimal" value={f.initialQty} onChange={e=>setF(x=>({...x,initialQty:e.target.value}))} placeholder="0"/></Field>}
   {editing&&<Toggle title="Item ativo" description="Inativo não aparece para movimentar, mas o histórico continua." checked={!!f.active} onChange={v=>setF(x=>({...x,active:v}))}/>}
  </div>{error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Salvar</Button></div></form>
 </DialogContent></Dialog>;
}

/** Item aberto: saldo, extrato e movimentação rápida sem sair da tela. */
function ItemDialog({itemId,refs,onClose,onChanged}:{itemId:string,refs:R,onClose:()=>void,onChanged:()=>void}){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState(''),[edit,setEdit]=useState(false),[kind,setKind]=useState('saida'),[qty,setQty]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),k=useKey();
 const refresh=useCallback(()=>load<R>('tools/item?id='+itemId).then(d=>{setData(d);setError('')},e=>setError((e as Error).message)),[itemId]);
 useEffect(()=>{void refresh()},[refresh]);
 const item=data?.item as R|undefined;
 async function quick(e:FormEvent){
  e.preventDefault();if(!item)return;setBusy(true);
  try{const r=await tpost('tools/move',{kind,reason:reason||REASONS[kind][0],lines:[{itemId:item.id,qty:num(qty)}]},k);k.renew();toast.success(r.message);setQty('');setReason('');await refresh();onChanged();}
  catch(err){toast.error((err as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="n-dialog tl-dialog"><DialogHeader><DialogTitle>{item?.name||'Item'}</DialogTitle>
  <DialogDescription>{item?`${KIND_NAMES[item.kind]}${item.code?` · ${item.code}`:''} · ${item.categoryName||'Sem categoria'} · ${item.locationName||'Sem local'}`:'Carregando…'}</DialogDescription></DialogHeader>
  {error&&<p className="form-error" role="alert">{error}</p>}{!data&&!error&&<Skeleton className="h-32 rounded-xl"/>}
  {item&&<>
   <div className="tl-balance"><div><span>Saldo</span><b>{qtyText(item.balance)} <small>{item.unitAbbr}</small></b></div><div><span>Mínimo</span><b>{qtyText(item.min)} <small>{item.unitAbbr}</small></b></div><BalanceBadge item={item}/></div>
   {item.active&&<form className="tl-quick" onSubmit={quick}>
    <div className="segmented" role="group" aria-label="Tipo de movimento">{['saida','entrada','perda'].map(v=><button key={v} type="button" className={kind===v?'active':''} aria-pressed={kind===v} onClick={()=>setKind(v)}>{MOVE_NAMES[v]}</button>)}</div>
    <Input required inputMode="decimal" aria-label="Quantidade" placeholder={`Quantidade (${item.unitAbbr})`} value={qty} onChange={e=>setQty(e.target.value)}/>
    <Choice value={reason||REASONS[kind][0]} onChange={setReason} options={REASONS[kind].map(r=>({value:r,label:r}))}/>
    <Button type="submit" disabled={busy||!qty}>{busy&&<LoaderCircle className="spin" size={16}/>} Registrar</Button></form>}
   <div className="step-actions"><Button variant="outline" onClick={()=>setEdit(true)}><Pencil size={15}/> Editar cadastro</Button></div>
   <h4 className="tl-h">Extrato</h4>
   {(data!.movements as R[]).length?<ul className="tl-list">{(data!.movements as R[]).map(m=><li key={m.id}><div><b>{MOVE_NAMES[m.kind]}</b><small>{m.reason} · {m.authorName} · {fmt(m.occurredAt)}</small></div>
    <span className={`tl-qty ${m.delta<0?'out':'in'}`}>{m.delta>0?'+':''}{qtyText(m.delta)} <small>saldo {qtyText(m.balanceAfter)}</small></span></li>)}</ul>:<p className="muted-text">Sem movimentos.</p>}
  </>}
  {edit&&item&&<ItemForm item={item} refs={refs} onClose={()=>setEdit(false)} onDone={()=>{setEdit(false);void refresh();onChanged();}}/>}
 </DialogContent></Dialog>;
}

export function ToolsInventory({refreshKey}:{refreshKey?:number}){
 const refs=useRefs(refreshKey);
 const [f,setF]=useState<R>({q:'',kind:'all',status:'active',category:'all',location:'all'}),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(''),[creating,setCreating]=useState(false),[tick,setTick]=useState(0),[pageN,setPageN]=useState(1);
 useEffect(()=>{
  let stale=false;
  const q=new URLSearchParams({page:String(pageN),status:f.status});
  if(f.q.trim())q.set('q',f.q.trim());if(f.kind!=='all')q.set('kind',f.kind);if(f.category!=='all')q.set('category',f.category);if(f.location!=='all')q.set('location',f.location);
  const t=setTimeout(()=>{load<R>('tools/items?'+q).then(d=>{if(!stale){setData(d);setError('')}},e=>{if(!stale)setError((e as Error).message)})},f.q?220:0);
  return()=>{stale=true;clearTimeout(t)};
 },[f,pageN,refreshKey,tick]);
 const set=(patch:R)=>{setPageN(1);setF(x=>({...x,...patch}))};
 if(error&&!data)return <div className="error-panel"><TriangleAlert/><h2>Inventário indisponível</h2><p>{error}</p></div>;
 const rows=(data?.rows||[]) as R[];
 return <div className="tl-screen">
  <section className="n-panel tl-filters">
   <div className="tl-search"><Search size={16} aria-hidden/><Input value={f.q} onChange={e=>set({q:e.target.value})} placeholder="Buscar por nome ou código" aria-label="Buscar item"/></div>
   <div className="tl-chips" role="group" aria-label="Tipo">{[['all','Todos'],['ferramenta','Ferramentas'],['material','Materiais']].map(([v,l])=><button key={v} type="button" className={f.kind===v?'active':''} aria-pressed={f.kind===v} onClick={()=>set({kind:v})}>{l}</button>)}</div>
   <div className="tl-chips" role="group" aria-label="Situação">{[['active','Ativos'],['low','Abaixo do mínimo'],['zero','Zerados'],['inactive','Inativos']].map(([v,l])=><button key={v} type="button" className={f.status===v?'active':''} aria-pressed={f.status===v} onClick={()=>set({status:v})}>{l}</button>)}</div>
   <div className="tl-selects"><Choice value={f.category} onChange={v=>set({category:v})} options={[{value:'all',label:'Todas as categorias'},...opts(refs?.categories)]}/><Choice value={f.location} onChange={v=>set({location:v})} options={[{value:'all',label:'Todos os locais'},...opts(refs?.locations)]}/></div>
  </section>
  <section className="n-panel"><div className="panel-heading"><div><h2>Inventário</h2><p>Toque num item para ver o extrato e movimentar.</p></div><Button onClick={()=>setCreating(true)} disabled={!refs}><Plus size={16}/> Novo item</Button></div>
   {!data?<Skeleton className="h-48 rounded-xl m-4"/>:rows.length?<>
    <div className="table-scroll tl-table"><table className="eu-table"><thead><tr><th>Item</th><th>Tipo</th><th>Categoria</th><th>Local</th><th className="num">Saldo</th><th className="num">Mínimo</th><th>Situação</th></tr></thead><tbody>
     {rows.map(i=><tr key={i.id} className="clickable" onClick={()=>setOpen(i.id)}><td><button type="button" className="tl-link" onClick={e=>{e.stopPropagation();setOpen(i.id)}}><b>{i.name}</b></button>{i.code&&<small className="muted-text"> {i.code}</small>}</td><td>{KIND_NAMES[i.kind]}</td><td>{i.categoryName||'—'}</td><td>{i.locationName||'—'}</td>
      <td className="num"><b>{qtyText(i.balance)}</b> <small>{i.unitAbbr}</small></td><td className="num">{qtyText(i.min)} <small>{i.unitAbbr}</small></td><td><BalanceBadge item={i}/></td></tr>)}</tbody></table></div>
    <ul className="tl-cards">{rows.map(i=><li key={i.id}><button type="button" onClick={()=>setOpen(i.id)}><div><b>{i.name}</b><small>{KIND_NAMES[i.kind]} · {i.locationName||'Sem local'}</small></div><div className="tl-card-qty"><b>{qtyText(i.balance)}</b><small>{i.unitAbbr}</small><BalanceBadge item={i}/></div></button></li>)}</ul>
    {(pageN>1||data.hasMore)&&<div className="tl-pager"><Button variant="outline" disabled={pageN<=1} onClick={()=>setPageN(p=>p-1)}>Anterior</Button><span>Página {pageN}</span><Button variant="outline" disabled={!data.hasMore} onClick={()=>setPageN(p=>p+1)}>Próxima</Button></div>}
   </>:<Empty icon={Boxes} title="Nenhum item encontrado" description={f.q||f.kind!=='all'||f.status!=='active'?'Tente outros filtros.':'Cadastre o primeiro item do estoque.'}/>}
  </section>
  {open&&refs&&<ItemDialog itemId={open} refs={refs} onClose={()=>setOpen('')} onChanged={()=>setTick(t=>t+1)}/>}
  {creating&&refs&&<ItemForm item={null} refs={refs} onClose={()=>setCreating(false)} onDone={()=>{setCreating(false);setTick(t=>t+1)}}/>}
 </div>;
}

type Line={item:R,qty:string};
/** Movimentação em carrinho: vários itens num envio só, tudo ou nada. */
export function ToolsMove({refreshKey,manager}:{refreshKey?:number,manager:boolean}){
 const [kind,setKind]=useState(()=>{try{const k=sessionStorage.getItem(PRESET_KEY)||'';sessionStorage.removeItem(PRESET_KEY);return REASONS[k]&&(k!=='ajuste')?k:'saida'}catch{return 'saida'}});
 const [q,setQ]=useState(''),[found,setFound]=useState<R[]>([]),[lines,setLines]=useState<Line[]>([]),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState<R|null>(null),k=useKey(),searchRef=useRef<HTMLInputElement>(null);
 const adjust=kind==='ajuste';
 useEffect(()=>{
  if(!q.trim()){return;}
  let stale=false;
  const t=setTimeout(()=>{load<R>('tools/items?limit=8&q='+encodeURIComponent(q.trim())).then(d=>{if(!stale)setFound((d.rows as R[]).slice(0,8))},()=>{if(!stale)setFound([])})},220);
  return()=>{stale=true;clearTimeout(t)};
 },[q,refreshKey]);
 const shown=q.trim()?found:[];
 const add=(item:R)=>{setLines(ls=>ls.some(l=>l.item.id===item.id)?ls:[...ls,{item,qty:''}]);setQ('');setFound([]);setDone(null);searchRef.current?.focus();};
 function onEnter(){const exact=shown.find(i=>i.code&&i.code.toLowerCase()===q.trim().toLowerCase());if(exact)add(exact);else if(shown.length===1)add(shown[0]);}
 async function submit(){
  setBusy(true);setError('');
  try{
   const body={kind,reason:reason||REASONS[kind][0],lines:lines.map(l=>adjust?{itemId:l.item.id,counted:num(l.qty)}:{itemId:l.item.id,qty:num(l.qty)})};
   const r=await tpost('tools/move',body,k);k.renew();toast.success(r.message);setDone(r);setLines([]);setReason('');
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 const ready=lines.length>0&&lines.every(l=>l.qty.trim()!==''&&Number.isFinite(num(l.qty)));
 return <div className="tl-screen tl-move">
  <section className="n-panel">
   <div className="segmented tl-kinds" role="group" aria-label="Tipo de movimentação">{['saida','entrada','perda',...(manager?['ajuste']:[])].map(v=><button key={v} type="button" className={kind===v?'active':''} aria-pressed={kind===v} onClick={()=>{setKind(v);setReason('');setLines(ls=>ls.map(l=>({...l,qty:''})))}}>{MOVE_NAMES[v]}</button>)}</div>
   <div className="tl-search tl-add"><Search size={16} aria-hidden/><Input ref={searchRef} value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();onEnter()}}} placeholder="Buscar item ou ler o código de barras" aria-label="Adicionar item" autoComplete="off"/></div>
   {shown.length>0&&<ul className="tl-found" role="listbox">{shown.map(i=><li key={i.id}><button type="button" role="option" aria-selected={false} onClick={()=>add(i)}><b>{i.name}</b><small>{KIND_NAMES[i.kind]} · saldo {qtyText(i.balance)} {i.unitAbbr}{i.locationName?` · ${i.locationName}`:''}</small></button></li>)}</ul>}
   {q.trim()&&!shown.length&&<p className="muted-text tl-none">Nenhum item para “{q}”.</p>}
  </section>
  <section className="n-panel"><div className="panel-heading"><div><h2>{adjust?'Contagem a ajustar':'Itens da movimentação'}</h2><p>{adjust?'Informe a quantidade contada: o saldo passa a ser esse valor.':'Informe a quantidade de cada item. Tudo é registrado junto, ou nada.'}</p></div></div>
   {lines.length?<ul className="tl-lines">{lines.map(l=>{const n=num(l.qty),after=adjust?n:l.item.balance+(kind==='entrada'?n:-n),bad=!adjust&&kind!=='entrada'&&Number.isFinite(n)&&after<0;
    return <li key={l.item.id}><div className="tl-line-name"><b>{l.item.name}</b><small>Saldo {qtyText(l.item.balance)} {l.item.unitAbbr}{Number.isFinite(n)&&l.qty?` → ${qtyText(after)}`:''}</small>{bad&&<small className="tl-bad">Saldo insuficiente</small>}</div>
     <Input inputMode="decimal" aria-label={`Quantidade de ${l.item.name}`} placeholder={adjust?'Contado':'Qtd.'} value={l.qty} aria-invalid={bad} onChange={e=>setLines(ls=>ls.map(x=>x.item.id===l.item.id?{...x,qty:e.target.value}:x))}/>
     <span className="tl-unit">{l.item.unitAbbr}</span><button type="button" className="icon-action" aria-label={`Tirar ${l.item.name}`} onClick={()=>setLines(ls=>ls.filter(x=>x.item.id!==l.item.id))}><Trash2 size={16}/></button></li>;})}</ul>
    :<Empty icon={Package} title="Nenhum item ainda" description="Busque pelo nome ou leia o código de barras para adicionar."/>}
   {done&&!lines.length&&<p className="tl-ok" role="status">{done.message}</p>}
  </section>
  <div className="tl-sticky"><div className="tl-reason"><Choice value={reason||REASONS[kind][0]} onChange={setReason} options={REASONS[kind].map(r=>({value:r,label:r}))}/></div>
   {error&&<p className="form-error" role="alert">{error}</p>}
   <Button className="tl-submit" disabled={!ready||busy} onClick={()=>void submit()}>{busy&&<LoaderCircle className="spin" size={16}/>} Registrar {MOVE_NAMES[kind].toLowerCase()}{lines.length?` (${lines.length})`:''}</Button></div>
 </div>;
}

function NamedTable({title,hint,path,rows,fields,onChanged}:{title:string,hint:string,path:string,rows:R[],fields:'name'|'unit',onChanged:()=>void}){
 const [edit,setEdit]=useState<R|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),k=useKey();
 async function submit(e:FormEvent){
  e.preventDefault();setBusy(true);setError('');
  try{const r=await tpost(path,{id:edit!.id,name:edit!.name,abbr:edit!.abbr,integral:edit!.integral,active:edit!.active},k);k.renew();toast.success(r.message);setEdit(null);onChanged();}
  catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 const blank=fields==='unit'?{name:'',abbr:'',integral:true,active:true}:{name:'',active:true};
 return <section className="n-panel"><div className="panel-heading"><div><h2>{title}</h2><p>{hint}</p></div><Button onClick={()=>{setError('');setEdit({...blank})}}><Plus size={16}/> Novo</Button></div>
  {rows.length?<div className="table-scroll"><table className="eu-table"><thead><tr><th>Nome</th>{fields==='unit'&&<><th>Sigla</th><th>Aceita fração</th></>}<th>Situação</th><th/></tr></thead><tbody>
   {rows.map(r=><tr key={r.id}><td><b>{r.name}</b></td>{fields==='unit'&&<><td>{r.abbr}</td><td>{r.integral?'Não, só inteiros':'Sim'}</td></>}<td>{r.active?<Badge tone="success">Ativo</Badge>:<Badge>Inativo</Badge>}</td>
    <td><button className="icon-action" aria-label={`Editar ${r.name}`} onClick={()=>{setError('');setEdit({...r})}}><Pencil size={16}/></button></td></tr>)}</tbody></table></div>
   :<Empty icon={Hammer} title="Nada cadastrado" description="Use o botão Novo."/>}
  {edit&&<Dialog open onOpenChange={v=>{if(!busy&&!v)setEdit(null)}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>{edit.id?'Editar':'Novo'}: {title.toLowerCase()}</DialogTitle><DialogDescription>Itens antigos continuam como estão; inativar só tira das listas de escolha.</DialogDescription></DialogHeader>
   <form onSubmit={submit}><div className="form-grid">
    <Field label="Nome *" wide><Input required maxLength={80} value={edit.name} onChange={e=>setEdit(x=>({...x!,name:e.target.value}))}/></Field>
    {fields==='unit'&&<><Field label="Sigla *" hint="Aparece ao lado das quantidades (ex.: un, kg, m)."><Input required maxLength={8} value={edit.abbr} onChange={e=>setEdit(x=>({...x!,abbr:e.target.value}))}/></Field>
     <Toggle title="Aceita fração" description="Ligado para kg, metro e litro; desligado para peças e unidades." checked={!edit.integral} onChange={v=>setEdit(x=>({...x!,integral:!v}))}/></>}
    <Toggle title="Ativo" checked={!!edit.active} onChange={v=>setEdit(x=>({...x!,active:v}))}/>
   </div>{error&&<p className="form-error" role="alert">{error}</p>}
   <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>setEdit(null)}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Salvar</Button></div></form></DialogContent></Dialog>}
 </section>;
}

export function ToolsRegistry({refreshKey}:{refreshKey?:number}){
 const [tick,setTick]=useState(0),refs=useRefs((refreshKey||0)*1000+tick);
 if(!refs)return <Skeleton className="h-48 rounded-xl"/>;
 const changed=()=>setTick(t=>t+1);
 return <Tabs defaultValue="units"><TabsList className="n-tabs"><TabsTrigger value="units">Unidades</TabsTrigger><TabsTrigger value="categories">Categorias</TabsTrigger><TabsTrigger value="locations">Locais</TabsTrigger><TabsTrigger value="contractors">Terceirizadas</TabsTrigger></TabsList>
  <TabsContent value="units"><NamedTable title="Unidades de medida" hint="Como cada item é contado: un, caixa, kg, metro…" path="tools/units/save" rows={refs.units} fields="unit" onChanged={changed}/></TabsContent>
  <TabsContent value="categories"><NamedTable title="Categorias" hint="Agrupam os itens no inventário (ex.: Elétrica, Solda, EPI)." path="tools/categories/save" rows={refs.categories} fields="name" onChanged={changed}/></TabsContent>
  <TabsContent value="locations"><NamedTable title="Locais" hint="Onde o item fica guardado (ex.: Prateleira 1, Container A)." path="tools/locations/save" rows={refs.locations} fields="name" onChanged={changed}/></TabsContent>
  <TabsContent value="contractors"><ContractorsTable/></TabsContent></Tabs>;
}
