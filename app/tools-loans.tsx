'use client';
// Ferramentaria · empréstimos para terceirizadas: lista, assistente de 4 passos (terceirizada → itens →
// revisão → assinatura), detalhe com devolução, assinatura na tela, termo escaneado e impressão; cadastro
// de terceirizadas. Assinatura com o dedo no tablet ou celular.
import {useCallback,useEffect,useRef,useState,FormEvent} from 'react';
import {Plus,Search,Printer,PenLine,Undo2,Ban,Paperclip,LoaderCircle,TriangleAlert,Handshake,Pencil,Trash2,Eraser,Download,CheckCircle2,UserPlus} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,Toggle,fmt,load,type R} from './kit';
import {KIND_NAMES,qtyText,num,useKey,tpost} from './tools-kit';

export const NEW_LOAN_KEY='nautilus.tools.newloan';
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(Date.now());
const day=(d:string)=>d?d.split('-').reverse().join('/'):'—';
const STATUS:Record<string,[string,string]>={emitido:['Emitido','info'],parcial:['Devolução parcial','warning'],encerrado:['Encerrado','success'],cancelado:['Cancelado','muted']};
const printUrl=(loanId:string,returnId?:string)=>`/ferramentaria/emprestimo/${loanId}${returnId?`?devolucao=${returnId}`:''}`;
const openPrint=(loanId:string,returnId?:string)=>window.open(printUrl(loanId,returnId),'_blank','noopener');

function LoanBadges({loan}:{loan:R}){
 const s=STATUS[loan.status];
 return <span className="tl-badges"><Badge tone={s[1]}>{s[0]}</Badge>{loan.late&&<Badge tone="danger">Atrasado</Badge>}
  {['emitido','parcial'].includes(loan.status)&&!loan.signed&&<Badge tone="warning">Sem assinatura</Badge>}</span>;
}

/** Quadro de assinatura: dedo, caneta ou mouse. Exporta PNG pequeno (600 px de largura) para caber no termo. */
export function SignaturePad({label,name,onChange}:{label:string,name?:string,onChange:(dataUrl:string|null)=>void}){
 const ref=useRef<HTMLCanvasElement>(null),drawing=useRef(false),dirty=useRef(false),last=useRef<{x:number,y:number}|null>(null);
 const ctx=()=>ref.current?.getContext('2d')||null;
 useEffect(()=>{
  const c=ref.current;if(!c)return;
  const fit=()=>{const r=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1;c.width=Math.round(r.width*dpr);c.height=Math.round(r.height*dpr);
   const g=c.getContext('2d');if(g){g.setTransform(dpr,0,0,dpr,0,0);g.lineWidth=2.4;g.lineCap='round';g.lineJoin='round';g.strokeStyle='#0b1d25';}dirty.current=false;onChange(null);};
  fit();window.addEventListener('resize',fit);return()=>window.removeEventListener('resize',fit);
 // eslint-disable-next-line react-hooks/exhaustive-deps -- Ajusta o quadro ao tamanho da tela só ao montar e ao redimensionar.
 },[]);
 const point=(e:React.PointerEvent)=>{const r=ref.current!.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
 const down=(e:React.PointerEvent)=>{e.preventDefault();ref.current!.setPointerCapture(e.pointerId);drawing.current=true;last.current=point(e);const g=ctx(),p=last.current;if(g){g.beginPath();g.arc(p.x,p.y,1.1,0,Math.PI*2);g.fillStyle='#0b1d25';g.fill();}dirty.current=true;};
 const move=(e:React.PointerEvent)=>{if(!drawing.current)return;const g=ctx(),p=point(e),l=last.current;if(g&&l){g.beginPath();g.moveTo(l.x,l.y);g.lineTo(p.x,p.y);g.stroke();}last.current=p;};
 const up=()=>{if(!drawing.current)return;drawing.current=false;last.current=null;
  // Salva com 600 px de largura, mantendo a proporção do quadro (sem esticar a assinatura).
  const c=ref.current!,out=document.createElement('canvas'),h=Math.min(400,Math.max(120,Math.round(600*c.height/Math.max(1,c.width))));out.width=600;out.height=h;
  const g=out.getContext('2d')!;g.fillStyle='#fff';g.fillRect(0,0,600,h);g.drawImage(c,0,0,600,h);onChange(out.toDataURL('image/png'));};
 const clear=()=>{const c=ref.current,g=ctx();if(c&&g){g.save();g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,c.width,c.height);g.restore();}dirty.current=false;onChange(null);};
 return <div className="tl-sign"><div className="tl-sign-head"><b>{label}</b>{name&&<span>{name}</span>}<button type="button" className="tl-link" onClick={clear}><Eraser size={14}/> Limpar</button></div>
  <canvas ref={ref} className="tl-sign-canvas" aria-label={`Quadro de assinatura: ${label}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}/>
  <small>Assine com o dedo ou a caneta dentro do quadro.</small></div>;
}

function SignBoth({ocpName,person,value,onChange}:{ocpName:string,person:string,value:{ocp:string|null,contractor:string|null},onChange:(v:{ocp:string|null,contractor:string|null})=>void}){
 return <div className="tl-sign-grid">
  <SignaturePad label="Responsável OCP" name={ocpName} onChange={d=>onChange({...value,ocp:d})}/>
  <SignaturePad label="Responsável da terceirizada" name={person} onChange={d=>onChange({...value,contractor:d})}/>
 </div>;
}

type Line={item:R,qty:string};
/** Assistente: 1 terceirizada e responsáveis → 2 itens → 3 revisão → 4 assinatura e emissão. */
function NewLoan({userName,onClose,onDone}:{userName:string,onClose:()=>void,onDone:(r:R)=>void}){
 const [step,setStep]=useState(1),[contractors,setContractors]=useState<R[]|null>(null);
 const [f,setF]=useState<R>({contractorId:'',person:'',ocpName:userName,purpose:'',expected:today()});
 const [q,setQ]=useState(''),[found,setFound]=useState<R[]>([]),[lines,setLines]=useState<Line[]>([]);
 const [signNow,setSignNow]=useState(true),[sig,setSig]=useState<{ocp:string|null,contractor:string|null}>({ocp:null,contractor:null});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState<R|null>(null),k=useKey();
 useEffect(()=>{load<R>('tools/contractors').then(d=>setContractors((d.rows as R[]).filter(c=>c.active)),()=>setContractors([]))},[]);
 useEffect(()=>{
  if(!q.trim())return;let stale=false;
  const t=setTimeout(()=>{load<R>('tools/items?q='+encodeURIComponent(q.trim())).then(d=>{if(!stale)setFound((d.rows as R[]).filter(i=>i.balance>0).slice(0,8))},()=>{if(!stale)setFound([])})},220);
  return()=>{stale=true;clearTimeout(t)};
 },[q]);
 const shown=q.trim()?found:[];
 const contractor=contractors?.find(c=>c.id===f.contractorId);
 const add=(item:R)=>{setLines(ls=>ls.some(l=>l.item.id===item.id)?ls:[...ls,{item,qty:'1'}]);setQ('');setFound([]);};
 const onEnter=()=>{const exact=shown.find(i=>i.code&&i.code.toLowerCase()===q.trim().toLowerCase());if(exact)add(exact);else if(shown.length===1)add(shown[0]);};
 const step1=!!(f.contractorId&&f.person.trim()&&f.ocpName.trim()&&f.purpose.trim()&&f.expected&&f.expected>=today());
 const bad=(l:Line)=>{const n=num(l.qty);return !Number.isFinite(n)||n<=0||n>l.item.balance;};
 const step2=lines.length>0&&!lines.some(bad);
 async function emit(){
  setBusy(true);setError('');
  try{
   const body:R={contractorId:f.contractorId,contractorPerson:f.person.trim(),ocpName:f.ocpName.trim(),purpose:f.purpose.trim(),expectedReturn:f.expected,lines:lines.map(l=>({itemId:l.item.id,qty:num(l.qty)}))};
   if(signNow){if(!sig.ocp||!sig.contractor)throw new Error('Peça as duas assinaturas nos quadros, ou escolha assinar depois.');body.ocpSignature=sig.ocp;body.contractorSignature=sig.contractor;}
   const r=await tpost('tools/loans/issue',body,k);k.renew();toast.success(r.message);setDone(r);onDone(r);
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 const titles=['Terceirizada e responsáveis','Itens','Revisão','Assinatura'];
 return <Dialog open onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog tl-wizard"><DialogHeader><DialogTitle>{done?`${done.code} emitido`:'Novo empréstimo'}</DialogTitle>
  <DialogDescription>{done?'O estoque já foi abatido. Imprima o termo para guardar ou entregar.':`Passo ${step} de 4 · ${titles[step-1]}`}</DialogDescription></DialogHeader>
  {!done&&<ol className="tl-steps" aria-label="Passos">{titles.map((t,i)=><li key={t} className={i+1===step?'on':i+1<step?'ok':''}><span>{i+1}</span>{t}</li>)}</ol>}
  {done?<div className="tl-done"><CheckCircle2/><p>{done.message}</p><div className="step-actions"><Button variant="outline" onClick={onClose}>Fechar</Button><Button onClick={()=>openPrint(done.id)}><Printer size={15}/> Imprimir termo</Button></div></div>:<>
  {step===1&&(!contractors?<Skeleton className="h-40 rounded-xl"/>:contractors.length?<div className="form-grid">
   <Field label="Terceirizada *" wide><Choice value={f.contractorId} onChange={v=>setF(x=>({...x,contractorId:v,person:''}))} options={contractors.map(c=>({value:c.id,label:c.name}))}/></Field>
   <Field label="Responsável da terceirizada *" hint="Escolha ou digite um nome novo: ele entra no cadastro da terceirizada."><Input list="tl-people" maxLength={120} value={f.person} onChange={e=>setF(x=>({...x,person:e.target.value}))} disabled={!contractor}/></Field>
   <datalist id="tl-people">{((contractor?.people||[]) as R[]).filter(p=>p.active).map(p=><option key={p.id} value={p.name}/>)}</datalist>
   <Field label="Responsável OCP *"><Input maxLength={120} value={f.ocpName} onChange={e=>setF(x=>({...x,ocpName:e.target.value}))}/></Field>
   <Field label="Finalidade *" wide><Textarea maxLength={300} rows={2} value={f.purpose} onChange={e=>setF(x=>({...x,purpose:e.target.value}))} placeholder="Ex.: manutenção do guindaste no cais 2"/></Field>
   <Field label="Devolução prevista *"><Input type="date" min={today()} value={f.expected} onChange={e=>setF(x=>({...x,expected:e.target.value}))}/></Field>
  </div>:<Empty icon={Handshake} title="Nenhuma terceirizada ativa" description="Cadastre a terceirizada em Ferramentaria › Cadastros › Terceirizadas."/>)}
  {step===2&&<div className="tl-wiz-items">
   <div className="tl-search"><Search size={16} aria-hidden/><Input autoFocus value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();onEnter()}}} placeholder="Buscar item ou ler o código de barras" aria-label="Adicionar item"/></div>
   {shown.length>0&&<ul className="tl-found tl-found-in" role="listbox">{shown.map(i=><li key={i.id}><button type="button" role="option" aria-selected={false} onClick={()=>add(i)}><b>{i.name}</b><small>{KIND_NAMES[i.kind]} · disponível {qtyText(i.balance)} {i.unitAbbr}</small></button></li>)}</ul>}
   {lines.length?<ul className="tl-lines tl-lines-in">{lines.map(l=><li key={l.item.id}><div className="tl-line-name"><b>{l.item.name}</b><small>{KIND_NAMES[l.item.kind]} · disponível {qtyText(l.item.balance)} {l.item.unitAbbr}</small>{bad(l)&&l.qty&&<small className="tl-bad">Quantidade inválida ou acima do disponível</small>}</div>
    <Input inputMode="decimal" aria-label={`Quantidade de ${l.item.name}`} value={l.qty} aria-invalid={bad(l)} onChange={e=>setLines(ls=>ls.map(x=>x.item.id===l.item.id?{...x,qty:e.target.value}:x))}/><span className="tl-unit">{l.item.unitAbbr}</span>
    <button type="button" className="icon-action" aria-label={`Tirar ${l.item.name}`} onClick={()=>setLines(ls=>ls.filter(x=>x.item.id!==l.item.id))}><Trash2 size={16}/></button></li>)}</ul>
    :<p className="muted-text">Busque e toque nos itens para incluir. Só aparecem itens com saldo.</p>}
  </div>}
  {step===3&&<div className="tl-review">
   <dl><div><dt>Terceirizada</dt><dd>{contractor?.name}</dd></div><div><dt>Responsável</dt><dd>{f.person}</dd></div><div><dt>Responsável OCP</dt><dd>{f.ocpName}</dd></div><div><dt>Devolução prevista</dt><dd>{day(f.expected)}</dd></div><div className="wide"><dt>Finalidade</dt><dd>{f.purpose}</dd></div></dl>
   <ul className="tl-list tl-list-in">{lines.map(l=><li key={l.item.id}><div><b>{l.item.name}</b><small>{KIND_NAMES[l.item.kind]}{l.item.kind==='material'?' · consumível: só a sobra volta':' · deve voltar'}</small></div><span className="tl-qty">{qtyText(num(l.qty))} <small>{l.item.unitAbbr}</small></span></li>)}</ul>
   <p className="muted-text">Ao emitir, o estoque é abatido na hora.</p>
  </div>}
  {step===4&&<div>
   <Toggle title="Assinar agora na tela" description="Desligado: emite agora e assina depois, na tela ou com o termo impresso e escaneado." checked={signNow} onChange={setSignNow}/>
   {signNow&&<SignBoth ocpName={f.ocpName} person={f.person} value={sig} onChange={setSig}/>}
  </div>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions tl-wiz-actions">
   <Button type="button" variant="outline" disabled={busy} onClick={()=>step===1?onClose():setStep(s=>s-1)}>{step===1?'Cancelar':'Voltar'}</Button>
   {step<4?<Button type="button" disabled={(step===1&&!step1)||(step===2&&!step2)} onClick={()=>{setError('');setStep(s=>s+1)}}>Continuar</Button>
    :<Button type="button" disabled={busy||(signNow&&(!sig.ocp||!sig.contractor))} onClick={()=>void emit()}>{busy&&<LoaderCircle className="spin" size={16}/>} Emitir empréstimo</Button>}
  </div></>}
 </DialogContent></Dialog>;
}

function SignLater({loan,returnId,onClose,onDone}:{loan:R,returnId?:string,onClose:()=>void,onDone:()=>void}){
 const [sig,setSig]=useState<{ocp:string|null,contractor:string|null}>({ocp:null,contractor:null}),[busy,setBusy]=useState(false),[error,setError]=useState(''),k=useKey();
 async function submit(){setBusy(true);setError('');
  try{const r=await tpost('tools/loans/sign',{loanId:loan.id,returnId,ocpSignature:sig.ocp,contractorSignature:sig.contractor},k);k.renew();toast.success(r.message);onDone();}
  catch(err){setError((err as Error).message)}finally{setBusy(false)}}
 return <Dialog open onOpenChange={v=>{if(!busy&&!v)onClose()}}><DialogContent className="n-dialog tl-wizard"><DialogHeader><DialogTitle>Assinar {returnId?'devolução':'termo'} · {loan.code}</DialogTitle><DialogDescription>A assinatura fica gravada no termo e não pode ser trocada depois.</DialogDescription></DialogHeader>
  <SignBoth ocpName={loan.ocpName} person={loan.contractorPerson} value={sig} onChange={setSig}/>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy||!sig.ocp||!sig.contractor} onClick={()=>void submit()}>{busy&&<LoaderCircle className="spin" size={16}/>} Confirmar assinaturas</Button></div>
 </DialogContent></Dialog>;
}

/** Devolução: para ferramenta, devolvida / danificada / perdida; para material, a sobra. */
function ReturnForm({detail,onClose,onDone}:{detail:R,onClose:()=>void,onDone:()=>void}){
 const loan=detail.loan as R,pending=(detail.lines as R[]).filter(l=>l.pending>0);
 const [v,setV]=useState<Record<string,R>>(()=>Object.fromEntries(pending.map(l=>[l.id,{returned:'',damaged:'',lost:''}])));
 const [close,setClose]=useState(false),[note,setNote]=useState(''),[signNow,setSignNow]=useState(false),[sig,setSig]=useState<{ocp:string|null,contractor:string|null}>({ocp:null,contractor:null});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),k=useKey();
 const val=(s:string)=>s.trim()===''?0:num(s);
 const all=()=>setV(Object.fromEntries(pending.map(l=>[l.id,{returned:qtyText(l.pending),damaged:'',lost:''}])));
 const left=(l:R)=>l.pending-val(v[l.id].returned)-val(v[l.id].damaged)-val(v[l.id].lost);
 const toolsLeft=pending.filter(l=>l.kind==='ferramenta'&&left(l)>0);
 async function submit(){
  setBusy(true);setError('');
  try{
   const lines=pending.map(l=>({lineId:l.id,returned:val(v[l.id].returned),damaged:val(v[l.id].damaged),lost:val(v[l.id].lost)})).filter(x=>x.returned||x.damaged||x.lost);
   const body:R={loanId:loan.id,lines,close,note:note||undefined};
   if(signNow){if(!sig.ocp||!sig.contractor)throw new Error('Peça as duas assinaturas ou desligue "Assinar agora".');body.ocpSignature=sig.ocp;body.contractorSignature=sig.contractor;}
   const r=await tpost('tools/loans/return',body,k);k.renew();toast.success(r.message);onDone();
  }catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open onOpenChange={x=>{if(!busy&&!x)onClose()}}><DialogContent className="n-dialog tl-wizard"><DialogHeader><DialogTitle>Devolução · {loan.code}</DialogTitle>
  <DialogDescription>O que volta em bom estado entra de novo no estoque. Ferramenta danificada ou perdida não volta.</DialogDescription></DialogHeader>
  <div className="step-actions tl-left"><Button variant="outline" size="sm" onClick={all}>Tudo devolvido em bom estado</Button></div>
  <ul className="tl-return">{pending.map(l=><li key={l.id}><div className="tl-line-name"><b>{l.itemName}</b><small>Pendente {qtyText(l.pending)} {l.unitAbbr}{left(l)<0?'':` · faltará ${qtyText(Math.max(0,left(l)))}`}</small>{left(l)<0&&<small className="tl-bad">Acima do pendente</small>}</div>
   <div className="tl-return-in">{(l.kind==='ferramenta'?[['returned','Devolvida'],['damaged','Danificada'],['lost','Perdida']]:[['returned','Sobra devolvida']]).map(([fk,label])=>
    <label key={fk}><span>{label}</span><Input inputMode="decimal" value={v[l.id][fk]} onChange={e=>setV(x=>({...x,[l.id]:{...x[l.id],[fk]:e.target.value}}))} aria-label={`${label}: ${l.itemName}`}/></label>)}</div></li>)}</ul>
  <Toggle title="Encerrar o empréstimo" description={toolsLeft.length?`Antes, informe o destino de: ${toolsLeft.map(l=>l.itemName).join(', ')}.`:'O material que não voltou é dado como consumido.'} checked={close} onChange={setClose}/>
  <Field label="Observação" wide><Textarea maxLength={500} rows={2} value={note} onChange={e=>setNote(e.target.value)}/></Field>
  <Toggle title="Assinar a devolução agora na tela" checked={signNow} onChange={setSignNow}/>
  {signNow&&<SignBoth ocpName={loan.ocpName} person={loan.contractorPerson} value={sig} onChange={setSig}/>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="step-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={busy||pending.some(l=>left(l)<0)||(close&&toolsLeft.length>0)} onClick={()=>void submit()}>{busy&&<LoaderCircle className="spin" size={16}/>} Registrar devolução</Button></div>
 </DialogContent></Dialog>;
}

function LoanDetail({loanId,onClose,onChanged}:{loanId:string,onClose:()=>void,onChanged:()=>void}){
 const [d,setD]=useState<R|null>(null),[error,setError]=useState(''),[mode,setMode]=useState<''|'sign'|'return'|'cancel'>(''),[signReturn,setSignReturn]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),k=useKey(),file=useRef<HTMLInputElement>(null);
 const refresh=useCallback(()=>load<R>('tools/loan?id='+loanId).then(x=>{setD(x);setError('')},e=>setError((e as Error).message)),[loanId]);
 useEffect(()=>{void refresh()},[refresh]);
 const changed=()=>{setMode('');setSignReturn('');void refresh();onChanged();};
 async function cancel(){setBusy(true);try{const r=await tpost('tools/loans/cancel',{loanId,reason},k);k.renew();toast.success(r.message);changed();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 async function upload(f:File|undefined,returnId?:string){
  if(!f)return;setBusy(true);
  try{const q=new URLSearchParams({loan:loanId,name:f.name});if(returnId)q.set('return',returnId);
   const r=await fetch('/api/tools/loan-file?'+q,{method:'POST',body:f});const j=await r.json().catch(()=>({}));
   if(!r.ok)throw new Error(j.error||'Não foi possível anexar.');toast.success(j.message);changed();}
  catch(e){toast.error((e as Error).message)}finally{setBusy(false);if(file.current)file.current.value='';}
 }
 const loan=d?.loan as R|undefined,open=loan&&['emitido','parcial'].includes(loan.status);
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose()}}><DialogContent className="n-dialog tl-dialog tl-loan"><DialogHeader><DialogTitle>{loan?loan.code:'Empréstimo'}</DialogTitle>
  <DialogDescription>{loan?`${loan.contractorName} · ${loan.contractorPerson}`:'Carregando…'}</DialogDescription></DialogHeader>
  {error&&<p className="form-error" role="alert">{error}</p>}{!d&&!error&&<Skeleton className="h-40 rounded-xl"/>}
  {loan&&<>
   <LoanBadges loan={loan}/>
   <dl className="tl-facts"><div><dt>Finalidade</dt><dd>{loan.purpose}</dd></div><div><dt>Responsável OCP</dt><dd>{loan.ocpName}</dd></div>
    <div><dt>Emitido</dt><dd>{fmt(loan.issuedAt)} por {loan.issuedByName}</dd></div><div><dt>Devolução prevista</dt><dd>{day(loan.expectedReturn)}</dd></div>
    <div><dt>Assinatura</dt><dd>{loan.signedOnScreen?`Na tela, ${fmt(loan.signedAt)}`:loan.signed?'Termo escaneado anexado':'Pendente'}</dd></div>
    {loan.cancelReason&&<div><dt>Cancelado</dt><dd>{loan.cancelReason}</dd></div>}</dl>
   <div className="step-actions tl-left">
    <Button variant="outline" onClick={()=>openPrint(loan.id)}><Printer size={15}/> Imprimir termo</Button>
    {open&&!loan.signed&&<Button variant="outline" onClick={()=>setMode('sign')}><PenLine size={15}/> Assinar na tela</Button>}
    {open&&<Button variant="outline" disabled={busy} onClick={()=>file.current?.click()}><Paperclip size={15}/> Anexar termo assinado</Button>}
    {open&&<Button onClick={()=>setMode('return')}><Undo2 size={15}/> Registrar devolução</Button>}
    {loan.status==='emitido'&&!(d!.returns as R[]).length&&<Button variant="ghost" onClick={()=>setMode(mode==='cancel'?'':'cancel')}><Ban size={15}/> Cancelar</Button>}
    <input ref={file} type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={e=>void upload(e.target.files?.[0])}/>
   </div>
   {mode==='cancel'&&<div className="tl-cancel"><Field label="Motivo do cancelamento *" wide><Input maxLength={300} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Ex.: emitido por engano"/></Field>
    <Button disabled={busy||!reason.trim()} onClick={()=>void cancel()}>{busy&&<LoaderCircle className="spin" size={16}/>} Confirmar cancelamento</Button><small className="muted-text">Tudo volta ao estoque.</small></div>}
   <h4 className="tl-h">Itens</h4>
   <div className="table-scroll"><table className="eu-table tl-mini"><thead><tr><th>Item</th><th className="num">Saiu</th><th className="num">Voltou</th><th className="num">Danif.</th><th className="num">Perdido</th><th className="num">Consum.</th><th className="num">Pendente</th></tr></thead><tbody>
    {(d!.lines as R[]).map(l=><tr key={l.id}><td><b>{l.itemName}</b><small className="muted-text"> {KIND_NAMES[l.kind]}</small></td><td className="num">{qtyText(l.out)}</td><td className="num">{qtyText(l.returned)}</td><td className="num">{qtyText(l.damaged)}</td><td className="num">{qtyText(l.lost)}</td><td className="num">{qtyText(l.consumed)}</td><td className="num"><b>{qtyText(l.pending)}</b> <small>{l.unitAbbr}</small></td></tr>)}</tbody></table></div>
   {(d!.returns as R[]).length>0&&<><h4 className="tl-h">Devoluções</h4><ul className="tl-list tl-list-in">{(d!.returns as R[]).map(r=><li key={r.id}><div><b>Devolução {r.number}{r.closesLoan?' · encerrou':''}</b><small>{fmt(r.createdAt)} por {r.createdByName}{r.note?` · ${r.note}`:''}</small></div>
    <span className="tl-row-actions">{!r.signed&&<Button size="sm" variant="outline" onClick={()=>{setSignReturn(r.id);setMode('sign')}}><PenLine size={14}/> Assinar</Button>}<Button size="sm" variant="outline" onClick={()=>openPrint(loan.id,r.id)}><Printer size={14}/> Comprovante</Button></span></li>)}</ul></>}
   {(d!.files as R[]).length>0&&<><h4 className="tl-h">Termos anexados</h4><ul className="tl-list tl-list-in">{(d!.files as R[]).map(f=><li key={f.id}><div><b>{f.name}</b><small>{fmt(f.createdAt)} por {f.createdByName}{f.returnId?' · devolução':''}</small></div><a className="tl-link" href={`/api/tools/loan-file?id=${f.id}`}><Download size={14}/> Baixar</a></li>)}</ul></>}
  </>}
  {mode==='sign'&&loan&&<SignLater loan={loan} returnId={signReturn||undefined} onClose={()=>{setMode('');setSignReturn('')}} onDone={changed}/>}
  {mode==='return'&&d&&<ReturnForm detail={d} onClose={()=>setMode('')} onDone={changed}/>}
 </DialogContent></Dialog>;
}

export function ToolsLoans({refreshKey,userName}:{refreshKey?:number,userName:string}){
 const [f,setF]=useState<R>({status:'open',q:'',contractor:'all'}),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[tick,setTick]=useState(0),[contractors,setContractors]=useState<R[]>([]),[position,setPosition]=useState<R|null>(null);
 const [creating,setCreating]=useState(()=>{try{const v=sessionStorage.getItem(NEW_LOAN_KEY)==='1';sessionStorage.removeItem(NEW_LOAN_KEY);return v}catch{return false}});
 const [open,setOpen]=useState('');
 useEffect(()=>{load<R>('tools/contractors').then(d=>setContractors(d.rows as R[]),()=>{})},[refreshKey,tick]);
 useEffect(()=>{
  let stale=false;const q=new URLSearchParams({status:f.status});if(f.q.trim())q.set('q',f.q.trim());if(f.contractor!=='all')q.set('contractor',f.contractor);
  const t=setTimeout(()=>{load<R>('tools/loans?'+q).then(d=>{if(!stale){setData(d);setError('')}},e=>{if(!stale)setError((e as Error).message)})},f.q?220:0);
  return()=>{stale=true;clearTimeout(t)};
 },[f,refreshKey,tick]);
 useEffect(()=>{
  if(f.contractor==='all'){return;}let stale=false;
  load<R>('tools/contractor-position?id='+f.contractor).then(d=>{if(!stale)setPosition(d)},()=>{if(!stale)setPosition(null)});
  return()=>{stale=true};
 },[f.contractor,tick,refreshKey]);
 if(error&&!data)return <div className="error-panel"><TriangleAlert/><h2>Empréstimos indisponíveis</h2><p>{error}</p></div>;
 const rows=(data?.rows||[]) as R[],pos=f.contractor!=='all'&&position?.contractor?.id===f.contractor?position:null;
 return <div className="tl-screen">
  <section className="n-panel tl-filters">
   <div className="tl-filter-top"><div className="tl-search"><Search size={16} aria-hidden/><Input value={f.q} onChange={e=>setF(x=>({...x,q:e.target.value}))} placeholder="Buscar por código, terceirizada ou responsável" aria-label="Buscar empréstimo"/></div>
    <Button onClick={()=>setCreating(true)}><Plus size={16}/> Novo empréstimo</Button></div>
   <div className="tl-chips" role="group" aria-label="Situação">{[['open','Abertos'],['late','Atrasados'],['unsigned','Sem assinatura'],['closed','Encerrados'],['cancelled','Cancelados'],['all','Todos']].map(([v,l])=><button key={v} type="button" className={f.status===v?'active':''} aria-pressed={f.status===v} onClick={()=>setF(x=>({...x,status:v}))}>{l}</button>)}</div>
   <div className="tl-selects"><Choice value={f.contractor} onChange={v=>setF(x=>({...x,contractor:v}))} options={[{value:'all',label:'Todas as terceirizadas'},...contractors.map(c=>({value:c.id,label:c.name}))]}/></div>
  </section>
  {pos&&<section className="n-panel"><div className="panel-heading"><div><h2>Em mãos de {pos.contractor.name}</h2><p>Tudo que ainda não voltou dos empréstimos abertos.</p></div></div>
   {(pos.rows as R[]).length?<ul className="tl-list">{(pos.rows as R[]).map(r=><li key={r.id}><div><b>{r.itemName}</b><small>{r.loanCode} · {r.person} · devolver até {day(r.expectedReturn)}{r.late?' · atrasado':''}</small></div><span className={`tl-qty ${r.late?'warn':''}`}>{qtyText(r.pending)} <small>{r.unitAbbr}</small></span></li>)}</ul>
    :<Empty icon={Handshake} title="Nada em mãos" description="Esta terceirizada não tem itens pendentes."/>}
  </section>}
  <section className="n-panel"><div className="panel-heading"><div><h2>Empréstimos</h2><p>Toque num empréstimo para assinar, anexar o termo, registrar a devolução ou imprimir.</p></div></div>
   {!data?<Skeleton className="h-48 rounded-xl m-4"/>:rows.length?<>
    <div className="table-scroll tl-table"><table className="eu-table"><thead><tr><th>Código</th><th>Terceirizada</th><th>Finalidade</th><th>Devolver até</th><th>Itens</th><th>Situação</th></tr></thead><tbody>
     {rows.map(l=><tr key={l.id} className="clickable" onClick={()=>setOpen(l.id)}><td><button type="button" className="tl-link" onClick={e=>{e.stopPropagation();setOpen(l.id)}}><b>{l.code}</b></button></td><td>{l.contractorName}<small className="muted-text"> · {l.contractorPerson}</small></td><td>{l.purpose}</td><td>{day(l.expectedReturn)}</td><td>{l.pendingLines}/{l.lines} pendente(s)</td><td><LoanBadges loan={l}/></td></tr>)}</tbody></table></div>
    <ul className="tl-cards">{rows.map(l=><li key={l.id}><button type="button" onClick={()=>setOpen(l.id)}><div><b>{l.code} · {l.contractorName}</b><small>{l.contractorPerson} · devolver até {day(l.expectedReturn)}</small><LoanBadges loan={l}/></div><div className="tl-card-qty"><b>{l.pendingLines}</b><small>pendente(s)</small></div></button></li>)}</ul>
   </>:<Empty icon={Handshake} title="Nenhum empréstimo" description={f.status==='open'?'Use “Novo empréstimo” para emprestar itens a uma terceirizada.':'Nada com estes filtros.'}/>}
  </section>
  {creating&&<NewLoan userName={userName} onClose={()=>setCreating(false)} onDone={()=>setTick(t=>t+1)}/>}
  {open&&<LoanDetail loanId={open} onClose={()=>setOpen('')} onChanged={()=>setTick(t=>t+1)}/>}
 </div>;
}

/** Cadastros › Terceirizadas: nome e responsáveis. */
export function ContractorsTable(){
 const [rows,setRows]=useState<R[]|null>(null),[edit,setEdit]=useState<R|null>(null),[person,setPerson]=useState<R|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),k=useKey();
 const refresh=useCallback(()=>load<R>('tools/contractors').then(d=>setRows(d.rows as R[]),()=>setRows([])),[]);
 useEffect(()=>{void refresh()},[refresh]);
 async function save(e:FormEvent,path:string,body:R,close:()=>void){
  e.preventDefault();setBusy(true);setError('');
  try{const r=await tpost(path,body,k);k.renew();toast.success(r.message);close();await refresh();}catch(err){setError((err as Error).message)}finally{setBusy(false)}
 }
 if(!rows)return <Skeleton className="h-48 rounded-xl"/>;
 return <section className="n-panel"><div className="panel-heading"><div><h2>Terceirizadas</h2><p>Empresas que recebem empréstimos e seus responsáveis. Responsável digitado no empréstimo entra aqui sozinho.</p></div><Button onClick={()=>{setError('');setEdit({name:'',active:true})}}><Plus size={16}/> Nova</Button></div>
  {rows.length?<ul className="tl-list">{rows.map(c=><li key={c.id} className="tl-contractor"><div><b>{c.name}</b>{!c.active&&<Badge>Inativa</Badge>}{c.openLoans>0&&<Badge tone="info">{c.openLoans} empréstimo(s) aberto(s)</Badge>}
   <small>{(c.people as R[]).length?(c.people as R[]).map(p=>p.active?p.name:`${p.name} (inativo)`).join(' · '):'Sem responsáveis'}</small></div>
   <span className="tl-row-actions"><Button size="sm" variant="outline" onClick={()=>{setError('');setPerson({contractorId:c.id,contractorName:c.name,name:'',active:true})}}><UserPlus size={14}/> Responsável</Button>
    <button className="icon-action" aria-label={`Editar ${c.name}`} onClick={()=>{setError('');setEdit({...c})}}><Pencil size={16}/></button></span></li>)}</ul>
   :<Empty icon={Handshake} title="Nenhuma terceirizada" description="Cadastre a primeira para poder emprestar."/>}
  {edit&&<Dialog open onOpenChange={v=>{if(!busy&&!v)setEdit(null)}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>{edit.id?'Editar terceirizada':'Nova terceirizada'}</DialogTitle><DialogDescription>Empréstimos antigos guardam o nome da época.</DialogDescription></DialogHeader>
   <form onSubmit={e=>void save(e,'tools/contractors/save',{id:edit.id,name:edit.name,active:edit.active},()=>setEdit(null))}><div className="form-grid">
    <Field label="Nome *" wide><Input required maxLength={120} value={edit.name} onChange={e=>setEdit(x=>({...x!,name:e.target.value}))}/></Field>
    <Toggle title="Ativa" checked={!!edit.active} onChange={v=>setEdit(x=>({...x!,active:v}))}/>
    {edit.id&&<div className="wide">{((edit.people||[]) as R[]).map(p=><div key={p.id} className="tl-person"><span>{p.name}</span><Toggle title="Ativo" checked={!!p.active} onChange={async v=>{try{await tpost('tools/contractor-people/save',{id:p.id,name:p.name,active:v},k);k.renew();await refresh();setEdit(x=>({...x!,people:(x!.people as R[]).map(y=>y.id===p.id?{...y,active:v}:y)}));}catch(err){toast.error((err as Error).message)}}}/></div>)}</div>}
   </div>{error&&<p className="form-error" role="alert">{error}</p>}
   <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>setEdit(null)}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Salvar</Button></div></form></DialogContent></Dialog>}
  {person&&<Dialog open onOpenChange={v=>{if(!busy&&!v)setPerson(null)}}><DialogContent className="n-dialog"><DialogHeader><DialogTitle>Novo responsável · {person.contractorName}</DialogTitle><DialogDescription>Quem assina pela terceirizada nos empréstimos.</DialogDescription></DialogHeader>
   <form onSubmit={e=>void save(e,'tools/contractor-people/save',{contractorId:person.contractorId,name:person.name,active:true},()=>setPerson(null))}><div className="form-grid">
    <Field label="Nome *" wide><Input required maxLength={120} value={person.name} onChange={e=>setPerson(x=>({...x!,name:e.target.value}))}/></Field>
   </div>{error&&<p className="form-error" role="alert">{error}</p>}
   <div className="step-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>setPerson(null)}>Cancelar</Button><Button type="submit" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} Salvar</Button></div></form></DialogContent></Dialog>}
 </section>;
}
