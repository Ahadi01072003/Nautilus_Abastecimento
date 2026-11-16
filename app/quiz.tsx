'use client';
// Avaliações · telas internas (acesso Avaliações e Gestão): questionários (editor com versões, pré-visualização,
// QR code e situação) e respostas (filtros, detalhe com as respostas marcadas e histórico do CPF).
import {useCallback,useEffect,useMemo,useState} from 'react';
import {Plus,QrCode,Pencil,Pause,Play,Archive,Eye,Send,ArrowLeft,ArrowUp,ArrowDown,Trash2,Copy,Download,Printer,RefreshCw,LoaderCircle,TriangleAlert,ClipboardCheck,CheckCircle2,XCircle,Search,Save,FileText,FileSpreadsheet,FileArchive,UserX,ImageUp} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Skeleton} from '@/components/ui/skeleton';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Choice,Badge,Empty,Field,Toggle,fmt,load,post,type R} from './kit';
import {useKey} from './tools-kit';
import {qrSvg} from '@/lib/qr';
import {cpfDigits,formatCpf,typingCpf} from '@/lib/cpf';
import QuizRunner,{type RunnerQuestion} from './quiz-runner';
import './quiz.css';

const STATUS_TONE:Record<string,string>={rascunho:'muted',publicado:'success',pausado:'warning',encerrado:'muted'};
const TYPE_NAME:Record<string,string>={multipla:'Múltipla escolha',simnao:'Sim ou não',texto:'Texto livre (não vale nota)'};
const DETAIL_NAME:Record<string,string>={resultado:'Só aprovado ou reprovado',nota:'Resultado e nota',erradas:'Resultado, nota e perguntas erradas (sem a resposta certa)'};
const rid=()=>Math.random().toString(36).slice(2,10);
const dayText=(d?:string|null)=>d?`${d.slice(8,10)}/${d.slice(5,7)}/${d.slice(0,4)}`:'—';
const pct=(n:number)=>`${n.toLocaleString('pt-BR',{maximumFractionDigits:2})}%`;
const publicUrl=(path:string)=>(typeof window!=='undefined'?window.location.origin:'')+path;
const newQuestion=(type:string):R=>type==='multipla'?{id:rid(),type,text:'',required:true,options:[{id:rid(),text:''},{id:rid(),text:''}],correct:null}
 :type==='simnao'?{id:rid(),type,text:'',required:true,options:[{id:'sim',text:'Sim'},{id:'nao',text:'Não'}],correct:null}:{id:rid(),type,text:'',required:false,options:[],correct:null};
const DEFAULT_CONSENT='Ao continuar, autorizo o registro do meu nome, empresa, CPF e respostas desta avaliação, usados só para controlar o acesso e a segurança da base. Os dados ficam guardados enquanto forem necessários para essa finalidade e posso pedir a exclusão a qualquer momento na recepção.';
const DEFAULT_BODY='Certificamos que {nome}, da empresa {empresa}, realizou a avaliação "{questionario}" em {data}, com {nota} de acertos (mínimo {minimo}). Resultado: {resultado}.';
const EMPTY:R={title:'',intro:'',questions:[],validityAmount:12,validityUnit:'meses',minScore:70,dailyLimit:3,resultDetail:'erradas',shuffle:false,closedMessage:'',
 consentText:DEFAULT_CONSENT,retentionMonths:'none',pdfTitle:'Comprovante de avaliação',pdfBody:DEFAULT_BODY,pdfFooter:''};
const RETENTION=[{value:'none',label:'Não anonimizar automaticamente'},...[12,24,36,60].map(n=>({value:String(n),label:`Anonimizar após ${n} meses`}))];
/** Baixa um arquivo da API; erro do servidor vira aviso (sem sair da tela). */
async function download(path:string){
 const r=await fetch('/api/'+path,{cache:'no-store'});
 if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||'Não foi possível gerar o arquivo.');}
 const name=/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition')||'')?.[1]||'arquivo';
 const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}

function StatusBadge({status,name}:{status:string,name?:string}){return <Badge tone={STATUS_TONE[status]}>{name||status}</Badge>;}

// ───────────── Questionários ─────────────
export function QuizManager({refreshKey}:{refreshKey?:number}){
 const [list,setList]=useState<R[]|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState<string|null>(null),[qr,setQr]=useState<R|null>(null),[tick,setTick]=useState(0);
 const reload=useCallback(()=>setTick(t=>t+1),[]);
 useEffect(()=>{load<R>('quiz/list').then(d=>{setList(d.rows);setError('')},e=>setError((e as Error).message))},[refreshKey,tick]);
 if(editing!==null)return <QuizEditor id={editing||null} onBack={()=>{setEditing(null);reload();}} onQr={q=>setQr(q)} qr={qr} closeQr={()=>setQr(null)}/>;
 if(error)return <div className="error-panel"><TriangleAlert/><h2>Questionários indisponíveis</h2><p>{error}</p></div>;
 if(!list)return <Skeleton className="h-64 rounded-xl"/>;
 return <div className="qa-screen">
  <div className="qa-bar"><p>Crie o questionário, publique e divulgue o QR code. Qualquer número de visitantes usa o mesmo link, sem login.</p>
   <Button onClick={()=>setEditing('')}><Plus size={16}/> Novo questionário</Button></div>
  {list.length?<ul className="qa-cards">{list.map(q=><li key={q.id} className="n-panel qa-card">
   <div className="qa-card-head"><div><h3>{q.title}</h3><small>{q.questionCount} pergunta{q.questionCount!==1?'s':''} · {q.publishedVersion?`versão ${q.publishedVersion}`:'nunca publicado'} · nota mínima {q.minScore}% · validade {q.validityAmount} {q.validityUnit}</small></div><StatusBadge status={q.status} name={q.statusName}/></div>
   <div className="qa-stats"><div><span>Respostas</span><b>{q.attempts}</b></div><div><span>Aprovação</span><b>{q.attempts?pct(Math.round(q.passed*1000/q.attempts)/10):'—'}</b></div><div><span>Última</span><b className="qa-small">{q.lastAttemptAt?fmt(q.lastAttemptAt):'—'}</b></div></div>
   <div className="qa-actions">
    <Button variant="outline" onClick={()=>setEditing(q.id)}><Pencil size={15}/> {q.status==='encerrado'?'Ver':'Editar'}</Button>
    {q.publishedVersion>0&&q.status!=='encerrado'&&<Button variant="outline" onClick={()=>setQr(q)}><QrCode size={15}/> QR code</Button>}
    <StatusActions quiz={q} onDone={reload}/>
   </div>
  </li>)}</ul>
  :<section className="n-panel"><Empty icon={ClipboardCheck} title="Nenhum questionário ainda" description="Crie o primeiro: título, perguntas com a resposta certa, nota mínima e validade." action={<Button onClick={()=>setEditing('')}><Plus size={16}/> Novo questionário</Button>}/></section>}
  {qr&&<QrDialog quiz={qr} onClose={()=>setQr(null)} onChanged={reload}/>}
 </div>;
}

function StatusActions({quiz,onDone}:{quiz:R,onDone:()=>void}){
 const [busy,setBusy]=useState(false);
 async function go(status:string){
  if(status==='encerrado'&&!window.confirm(`Encerrar "${quiz.title}"? O link deixa de funcionar e o questionário não pode ser reaberto. As respostas continuam guardadas.`))return;
  setBusy(true);try{const r=await post('quiz/status',{id:quiz.id,status});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 if(quiz.status==='encerrado'||!quiz.publishedVersion)return null;
 return <>{quiz.status==='publicado'?<Button variant="outline" disabled={busy} onClick={()=>void go('pausado')}><Pause size={15}/> Pausar</Button>
  :<Button variant="outline" disabled={busy} onClick={()=>void go('publicado')}><Play size={15}/> Reabrir</Button>}
  <Button variant="ghost" disabled={busy} onClick={()=>void go('encerrado')}><Archive size={15}/> Encerrar</Button></>;
}

function QrDialog({quiz,onClose,onChanged}:{quiz:R,onClose:()=>void,onChanged:()=>void}){
 const [path,setPath]=useState<string>(quiz.path),[busy,setBusy]=useState(false);
 const url=publicUrl(path),svg=useMemo(()=>qrSvg(url),[url]);
 const name=(quiz.title as string).normalize('NFD').replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'-').toLowerCase()||'questionario';
 function save(blob:Blob,ext:string){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`qr-${name}.${ext}`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}
 function png(){
  const img=new Image(),size=1200;
  img.onload=()=>{const c=document.createElement('canvas');c.width=c.height=size;const g=c.getContext('2d')!;g.imageSmoothingEnabled=false;g.drawImage(img,0,0,size,size);c.toBlob(b=>b&&save(b,'png'),'image/png');};
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
 }
 async function regenerate(){
  if(!window.confirm('Gerar um link novo? O link e o QR code atuais param de funcionar na hora (inclusive os já impressos).'))return;
  setBusy(true);try{const r=await post('quiz/regenerate-token',{id:quiz.id});setPath(r.path);toast.success(r.message);onChanged();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 return <Dialog open onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="n-dialog qa-qr-dialog"><DialogHeader><DialogTitle>QR code · {quiz.title}</DialogTitle>
  <DialogDescription>O link não muda quando você publica uma nova versão: o QR impresso continua valendo.</DialogDescription></DialogHeader>
  <div className="qa-qr" dangerouslySetInnerHTML={{__html:svg}}/>
  <div className="qa-link"><code>{url}</code><Button variant="outline" size="sm" onClick={()=>{void navigator.clipboard?.writeText(url).then(()=>toast.success('Link copiado.'),()=>toast.error('Não foi possível copiar.'))}}><Copy size={14}/> Copiar</Button></div>
  {quiz.status==='pausado'&&<p className="qa-warn">O questionário está pausado: o link mostra “indisponível” até você reabrir.</p>}
  <div className="qa-actions">
   <Button variant="outline" onClick={png}><Download size={15}/> PNG</Button>
   <Button variant="outline" onClick={()=>save(new Blob([svg],{type:'image/svg+xml'}),'svg')}><Download size={15}/> SVG</Button>
   <Button variant="outline" onClick={()=>window.open(`/avaliacoes/qr/${quiz.id}`,'_blank','noopener')}><Printer size={15}/> Cartaz para imprimir</Button>
   <Button variant="ghost" disabled={busy} onClick={()=>void regenerate()}><RefreshCw size={15}/> Gerar link novo</Button>
  </div>
 </DialogContent></Dialog>;
}

function LogoField({quiz,disabled,onDone}:{quiz:R,disabled?:boolean,onDone:()=>void}){
 const [busy,setBusy]=useState(false);
 async function upload(file:File){
  if(file.size>524288){toast.error('Logotipo acima de 512 KB. Use uma imagem menor.');return;}
  setBusy(true);
  try{const r=await fetch('/api/quiz/logo?id='+encodeURIComponent(quiz.id),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Não foi possível enviar.');toast.success(j.message);onDone();}
  catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 async function remove(){setBusy(true);try{const r=await post('quiz/logo-remove',{id:quiz.id});toast.success(r.message);onDone();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}}
 return <div className="qa-logo wide">
  {/* eslint-disable-next-line @next/next/no-img-element -- imagem enviada pelo responsável, servida pela API */}
  <img src={`/api/quiz/logo?id=${encodeURIComponent(quiz.id)}&v=${quiz.rev}`} alt="Logotipo do comprovante"/>
  <div><b>{quiz.hasLogo?'Logotipo próprio':'Logotipo padrão (OceanPact LOG)'}</b><small>PNG ou JPG até 512 KB.</small>
   <div className="qa-actions">
    <label className={`qa-upload ${busy||disabled?'off':''}`}><ImageUp size={15}/> {quiz.hasLogo?'Trocar':'Enviar logotipo'}<input type="file" accept="image/png,image/jpeg" disabled={busy||disabled} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(file);}}/></label>
    {quiz.hasLogo&&<Button type="button" variant="ghost" disabled={busy||disabled} onClick={()=>void remove()}>Usar o padrão</Button>}
    <Button type="button" variant="outline" onClick={()=>window.open(`/api/quiz/pdf-sample?id=${encodeURIComponent(quiz.id)}`,'_blank','noopener')}><FileText size={15}/> Ver exemplo do PDF</Button>
   </div></div>
 </div>;
}

function QuizEditor({id,onBack,onQr,qr,closeQr}:{id:string|null,onBack:()=>void,onQr:(q:R)=>void,qr:R|null,closeQr:()=>void}){
 const [quizId,setQuizId]=useState(id),[meta,setMeta]=useState<R|null>(null),[versions,setVersions]=useState<R[]>([]);
 const [f,setF]=useState<R>(EMPTY),[changed,setChanged]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[preview,setPreview]=useState(false),[loadError,setLoadError]=useState('');
 const k=useKey();
 const readOnly=meta?.status==='encerrado';
 const apply=useCallback((d:R)=>{
  const q=d.quiz as R;
  setMeta(q);setVersions(d.versions);setF({title:q.title,intro:q.intro,questions:q.questions,validityAmount:q.validityAmount,validityUnit:q.validityUnit,minScore:q.minScore,dailyLimit:q.dailyLimit,resultDetail:q.resultDetail,shuffle:q.shuffle,closedMessage:q.closedMessage,
   consentText:q.consentText,retentionMonths:q.retentionMonths==null?'none':String(q.retentionMonths),pdfTitle:q.pdfTitle,pdfBody:q.pdfBody,pdfFooter:q.pdfFooter});setChanged(false);
 },[]);
 const fetchDetail=useCallback(async(qid:string)=>apply(await load<R>('quiz/detail?id='+encodeURIComponent(qid))),[apply]);
 useEffect(()=>{if(id)load<R>('quiz/detail?id='+encodeURIComponent(id)).then(apply,e=>setLoadError((e as Error).message));},[id,apply]);
 const set=(patch:R)=>{setF(x=>({...x,...patch}));setChanged(true);};
 const setQ=(i:number,patch:R)=>set({questions:(f.questions as R[]).map((q,j)=>j===i?{...q,...patch}:q)});
 const move=(i:number,d:number)=>{const qs=[...f.questions as R[]];const j=i+d;if(j<0||j>=qs.length)return;[qs[i],qs[j]]=[qs[j],qs[i]];set({questions:qs});};
 const body=()=>({...f,validityAmount:Number(f.validityAmount),minScore:Number(f.minScore),dailyLimit:Number(f.dailyLimit),retentionMonths:f.retentionMonths==='none'?null:Number(f.retentionMonths)});
 async function save(silent=false){
  const payload=quizId?{id:quizId,rev:meta?.rev,...body()}:{...body(),idempotencyKey:k.for(body())};
  const r=await post('quiz/save',payload);if(!quizId){setQuizId(r.id);k.renew();}
  await fetchDetail(r.id);if(!silent)toast.success(r.message);return r.id as string;
 }
 async function run(kind:string,fn:()=>Promise<void>){setBusy(kind);setError('');try{await fn();}catch(e){setError((e as Error).message)}finally{setBusy('')}}
 const publish=()=>run('publish',async()=>{const qid=changed||!quizId?await save(true):quizId!;const d=await load<R>('quiz/detail?id='+encodeURIComponent(qid));const r=await post('quiz/publish',{id:qid,rev:d.quiz.rev});toast.success(r.message);await fetchDetail(qid);});
 const back=()=>{if(changed&&!window.confirm('Há alterações não salvas. Sair mesmo assim?'))return;onBack();};
 if(loadError)return <div className="error-panel"><TriangleAlert/><h2>Questionário indisponível</h2><p>{loadError}</p><Button variant="outline" onClick={onBack}>Voltar</Button></div>;
 if(id&&!meta)return <Skeleton className="h-64 rounded-xl"/>;
 const questions=f.questions as R[];
 const previewQuiz={title:f.title||'Sem título',intro:f.intro,version:1,questions:questions.map(q=>({...q,options:q.options||[]})) as RunnerQuestion[],minScore:Number(f.minScore)||70,validity:{amount:Number(f.validityAmount)||1,unit:f.validityUnit},companies:[],consent:{version:meta?.consentVersion||1,text:f.consentText||DEFAULT_CONSENT}};
 return <div className="qa-screen">
  <div className="qa-bar"><Button variant="ghost" onClick={back}><ArrowLeft size={16}/> Questionários</Button>
   {meta&&<div className="qa-meta"><StatusBadge status={meta.status} name={meta.statusName}/>{meta.publishedVersion>0&&<Badge tone="info">Versão {meta.publishedVersion} no ar</Badge>}{(changed||meta.dirty)&&meta.publishedVersion>0&&!readOnly&&<Badge tone="warning">Alterações não publicadas</Badge>}</div>}</div>
  {readOnly&&<p className="qa-warn">Questionário encerrado: só consulta.</p>}
  <fieldset disabled={readOnly} className="qa-fieldset">
  <section className="n-panel qa-section"><div className="panel-heading"><div><h2>Questionário</h2><p>Título e texto de abertura aparecem para o visitante.</p></div></div>
   <div className="form-grid">
    <Field label="Título *" wide><Input maxLength={120} value={f.title} onChange={e=>set({title:e.target.value})} placeholder="Ex.: Integração de segurança para visitantes"/></Field>
    <Field label="Texto de abertura" wide hint="Opcional. Instruções, regras de segurança, quem procurar em caso de dúvida."><Textarea maxLength={2000} rows={4} value={f.intro} onChange={e=>set({intro:e.target.value})}/></Field>
   </div></section>
  <section className="n-panel qa-section"><div className="panel-heading"><div><h2>Regras</h2><p>Valem para as próximas tentativas (as já feitas não mudam).</p></div></div>
   <div className="form-grid">
    <Field label="Validade após aprovação *"><div className="qa-inline"><Input inputMode="numeric" value={f.validityAmount} onChange={e=>set({validityAmount:e.target.value.replace(/\D/g,'')})}/><Choice value={f.validityUnit} onChange={v=>set({validityUnit:v})} options={[{value:'meses',label:'meses'},{value:'dias',label:'dias'}]} label="Unidade"/></div></Field>
    <Field label="Nota mínima (%) *" hint="Acertos sobre as perguntas que valem nota."><Input inputMode="numeric" value={f.minScore} onChange={e=>set({minScore:e.target.value.replace(/\D/g,'')})}/></Field>
    <Field label="Tentativas por dia *" hint="Por CPF. Reprovado tenta de novo até passar."><Input inputMode="numeric" value={f.dailyLimit} onChange={e=>set({dailyLimit:e.target.value.replace(/\D/g,'')})}/></Field>
    <Field label="O que o visitante vê no resultado" wide><Choice value={f.resultDetail} onChange={v=>set({resultDetail:v})} options={Object.entries(DETAIL_NAME).map(([value,label])=>({value,label}))}/></Field>
    <Toggle title="Embaralhar perguntas e alternativas" description="Cada visitante vê uma ordem diferente." checked={!!f.shuffle} onChange={v=>set({shuffle:v})}/>
    <Field label="Mensagem quando estiver pausado ou encerrado" wide hint="Opcional. Padrão: Questionário indisponível no momento."><Input maxLength={300} value={f.closedMessage} onChange={e=>set({closedMessage:e.target.value})}/></Field>
   </div></section>
  <section className="n-panel qa-section"><div className="panel-heading"><div><h2>Uso dos dados (LGPD)</h2><p>O visitante lê e aceita este termo antes das perguntas. {meta?`Versão ${meta.consentVersion} em vigor; ao mudar o texto nasce a versão ${meta.consentVersion+1}.`:'Cada resposta guarda a versão aceita.'}</p></div></div>
   <div className="form-grid">
    <Field label="Termo de uso dos dados *" wide><Textarea maxLength={4000} rows={4} value={f.consentText} onChange={e=>set({consentText:e.target.value})}/></Field>
    <Field label="Retenção" wide hint="Depois do prazo, nome, empresa, CPF e textos livres são apagados todo dia de madrugada; notas e datas ficam para estatística."><Choice value={f.retentionMonths} onChange={v=>set({retentionMonths:v})} options={RETENTION}/></Field>
   </div></section>
  <section className="n-panel qa-section"><div className="panel-heading"><div><h2>Comprovante em PDF</h2><p>Use {'{nome}'}, {'{empresa}'}, {'{cpf}'}, {'{questionario}'}, {'{data}'}, {'{nota}'}, {'{minimo}'}, {'{resultado}'}, {'{validade}'} e {'{codigo}'} nos textos.</p></div></div>
   <div className="form-grid">
    <Field label="Título *" wide><Input maxLength={120} value={f.pdfTitle} onChange={e=>set({pdfTitle:e.target.value})}/></Field>
    <Field label="Texto" wide><Textarea maxLength={2000} rows={3} value={f.pdfBody} onChange={e=>set({pdfBody:e.target.value})}/></Field>
    <Field label="Rodapé" wide hint="Opcional. Ex.: endereço da base, responsável, observações."><Input maxLength={300} value={f.pdfFooter} onChange={e=>set({pdfFooter:e.target.value})}/></Field>
    {meta?<LogoField quiz={meta} disabled={readOnly} onDone={()=>void fetchDetail(meta.id)}/>:<p className="qa-note wide">Salve o questionário para enviar um logotipo próprio. Sem logotipo, o comprovante usa o da OceanPact LOG.</p>}
   </div></section>
  <section className="n-panel qa-section"><div className="panel-heading"><div><h2>Perguntas ({questions.length})</h2><p>Marque a resposta certa de cada pergunta que vale nota. A resposta certa nunca vai para a página do visitante.</p></div></div>
   <ol className="qa-questions">{questions.map((q,i)=><li key={q.id} className="qa-question">
    <div className="qa-question-head"><b>{i+1}</b><Choice value={q.type} label={`Tipo da pergunta ${i+1}`} onChange={v=>{const n=newQuestion(v);setQ(i,{type:v,options:n.options,correct:null,required:n.required});}} options={Object.entries(TYPE_NAME).map(([value,label])=>({value,label}))}/>
     <div className="qa-icons"><button type="button" aria-label="Subir" disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp size={16}/></button><button type="button" aria-label="Descer" disabled={i===questions.length-1} onClick={()=>move(i,1)}><ArrowDown size={16}/></button><button type="button" aria-label={`Remover pergunta ${i+1}`} onClick={()=>set({questions:questions.filter((_,j)=>j!==i)})}><Trash2 size={16}/></button></div></div>
    <Textarea aria-label={`Enunciado da pergunta ${i+1}`} maxLength={500} rows={2} value={q.text} placeholder="Enunciado" onChange={e=>setQ(i,{text:e.target.value})}/>
    {q.type==='multipla'&&<div className="qa-options">{(q.options as R[]).map((o,j)=><div key={o.id} className={`qa-option ${q.correct===o.id?'right':''}`}>
      <label className="qa-right" title="Resposta certa"><input type="radio" name={'c-'+q.id} checked={q.correct===o.id} onChange={()=>setQ(i,{correct:o.id})}/><span>{q.correct===o.id?'Certa':'Marcar certa'}</span></label>
      <Input aria-label={`Alternativa ${j+1} da pergunta ${i+1}`} maxLength={200} value={o.text} placeholder={`Alternativa ${j+1}`} onChange={e=>setQ(i,{options:(q.options as R[]).map(x=>x.id===o.id?{...x,text:e.target.value}:x)})}/>
      <button type="button" className="qa-x" aria-label={`Remover alternativa ${j+1}`} disabled={(q.options as R[]).length<=2} onClick={()=>setQ(i,{options:(q.options as R[]).filter(x=>x.id!==o.id),correct:q.correct===o.id?null:q.correct})}><Trash2 size={15}/></button></div>)}
     {(q.options as R[]).length<10&&<Button type="button" variant="ghost" size="sm" onClick={()=>setQ(i,{options:[...q.options as R[],{id:rid(),text:''}]})}><Plus size={14}/> Alternativa</Button>}</div>}
    {q.type==='simnao'&&<div className="segmented qa-yesno" role="group" aria-label={`Resposta certa da pergunta ${i+1}`}>{[['sim','Certa: Sim'],['nao','Certa: Não']].map(([v,l])=><button key={v} type="button" className={q.correct===v?'active':''} aria-pressed={q.correct===v} onClick={()=>setQ(i,{correct:v})}>{l}</button>)}</div>}
    {q.type==='texto'&&<Toggle title="Resposta obrigatória" description="Texto livre fica guardado para leitura e não entra na nota." checked={!!q.required} onChange={v=>setQ(i,{required:v})}/>}
   </li>)}</ol>
   <div className="qa-add">{Object.entries(TYPE_NAME).map(([t,l])=><Button key={t} type="button" variant="outline" onClick={()=>set({questions:[...questions,newQuestion(t)]})}><Plus size={15}/> {l.replace(' (não vale nota)','')}</Button>)}</div>
  </section>
  </fieldset>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {!readOnly&&<div className="qa-footer">
   <Button variant="outline" disabled={!!busy} onClick={()=>setPreview(true)}><Eye size={15}/> Pré-visualizar</Button>
   <Button variant="outline" disabled={!!busy||(!changed&&!!quizId)} onClick={()=>void run('save',async()=>{await save();})}>{busy==='save'?<LoaderCircle className="spin" size={15}/>:<Save size={15}/>} Salvar rascunho</Button>
   <Button disabled={!!busy} onClick={()=>void publish()}>{busy==='publish'?<LoaderCircle className="spin" size={15}/>:<Send size={15}/>} {meta?.publishedVersion?'Publicar nova versão':'Publicar'}</Button>
   {meta&&meta.publishedVersion>0&&<Button variant="ghost" onClick={()=>onQr(meta)}><QrCode size={15}/> QR code</Button>}
   {meta&&<StatusActions quiz={meta} onDone={()=>void fetchDetail(meta.id)}/>}
  </div>}
  {versions.length>0&&<section className="n-panel qa-section"><div className="panel-heading"><div><h2>Versões publicadas</h2><p>Cada resposta guarda a versão que foi respondida.</p></div></div>
   <ul className="qa-versions">{versions.map(v=><li key={v.version}><b>v{v.version}</b><span>{v.title}</span><small>{fmt(v.publishedAt)} · {v.publishedBy} · {v.attempts} resposta{v.attempts!==1?'s':''}</small></li>)}</ul></section>}
  {preview&&<Dialog open onOpenChange={v=>{if(!v)setPreview(false)}}><DialogContent className="qa-preview"><DialogHeader className="sr-only"><DialogTitle>Pré-visualização</DialogTitle><DialogDescription>Como o visitante vê. Nada é gravado.</DialogDescription></DialogHeader>
   <QuizRunner quiz={previewQuiz} preview={{resultDetail:f.resultDetail,dailyLimit:Number(f.dailyLimit)||1}}/></DialogContent></Dialog>}
  {qr&&<QrDialog quiz={qr} onClose={closeQr} onChanged={()=>{if(quizId)void fetchDetail(quizId);}}/>}
 </div>;
}

// ───────────── Respostas ─────────────
function query(f:R){
 const p=new URLSearchParams();
 if(f.quiz!=='all')p.set('quiz',f.quiz);if(f.result!=='all')p.set('result',f.result);
 for(const k of ['company','from','to'])if(f[k])p.set(k,f[k]);
 if(f.cpf)p.set('cpf',cpfDigits(f.cpf));
 return p;
}
function ExportBar({query:q,total}:{query:URLSearchParams,total:number}){
 const [answers,setAnswers]=useState(false),[busy,setBusy]=useState('');
 async function go(kind:string,path:string){setBusy(kind);try{await download(path);}catch(e){toast.error((e as Error).message)}finally{setBusy('')}}
 const with_=(extra:Record<string,string>)=>{const p=new URLSearchParams(q);for(const [k,v] of Object.entries(extra))p.set(k,v);return p.toString();};
 return <div className="qa-export"><span>Com os filtros aplicados:</span>
  <Button variant="outline" size="sm" disabled={!!busy||!total} onClick={()=>void go('x','quiz/export?'+with_({format:'xlsx',...(answers?{answers:'1'}:{})}))}>{busy==='x'?<LoaderCircle className="spin" size={14}/>:<FileSpreadsheet size={14}/>} Excel</Button>
  <Button variant="outline" size="sm" disabled={!!busy||!total} onClick={()=>void go('c','quiz/export?'+with_({format:'csv',...(answers?{answers:'1'}:{})}))}>{busy==='c'?<LoaderCircle className="spin" size={14}/>:<Download size={14}/>} CSV</Button>
  <label className="qa-inline-check"><input type="checkbox" checked={answers} onChange={e=>setAnswers(e.target.checked)}/> incluir as respostas</label>
  <Button variant="outline" size="sm" disabled={!!busy||!total} onClick={()=>void go('z','quiz/pdf-zip?'+with_({}))} title="Um PDF por resposta, até 500 por arquivo">{busy==='z'?<LoaderCircle className="spin" size={14}/>:<FileArchive size={14}/>} Comprovantes (ZIP)</Button>
 </div>;
}
export function QuizAnswers({refreshKey}:{refreshKey?:number}){
 const [quizzes,setQuizzes]=useState<R[]>([]),[filters,setFilters]=useState<R>({quiz:'all',result:'all',company:'',cpf:'',from:'',to:''});
 const [applied,setApplied]=useState<R>(filters),[page,setPage]=useState(1),[data,setData]=useState<R|null>(null),[error,setError]=useState(''),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{load<R>('quiz/list').then(d=>setQuizzes(d.rows),()=>setQuizzes([]))},[refreshKey]);
 useEffect(()=>{
  const p=query(applied);p.set('page',String(page));
  load<R>('quiz/attempts?'+p).then(d=>{setData(d);setError('')},e=>setError((e as Error).message));
 },[applied,page,refreshKey]);
 const apply=()=>{setPage(1);setApplied({...filters});};
 return <div className="qa-screen">
  <section className="n-panel qa-filters">
   <div className="qa-filter-grid">
    <Field label="Questionário"><Choice value={filters.quiz} onChange={v=>setFilters(x=>({...x,quiz:v}))} options={[{value:'all',label:'Todos'},...quizzes.map(q=>({value:q.id,label:q.title}))]}/></Field>
    <Field label="Resultado"><Choice value={filters.result} onChange={v=>setFilters(x=>({...x,result:v}))} options={[{value:'all',label:'Todos'},{value:'aprovado',label:'Aprovados'},{value:'reprovado',label:'Reprovados'}]}/></Field>
    <Field label="Empresa"><Input maxLength={120} value={filters.company} onChange={e=>setFilters(x=>({...x,company:e.target.value}))} onKeyDown={e=>{if(e.key==='Enter')apply()}}/></Field>
    <Field label="CPF completo"><Input inputMode="numeric" placeholder="000.000.000-00" value={filters.cpf} onChange={e=>setFilters(x=>({...x,cpf:typingCpf(e.target.value)}))} onKeyDown={e=>{if(e.key==='Enter')apply()}}/></Field>
    <Field label="De"><Input type="date" value={filters.from} onChange={e=>setFilters(x=>({...x,from:e.target.value}))}/></Field>
    <Field label="Até"><Input type="date" value={filters.to} onChange={e=>setFilters(x=>({...x,to:e.target.value}))}/></Field>
   </div>
   <div className="qa-actions"><Button onClick={apply}><Search size={15}/> Filtrar</Button><Button variant="ghost" onClick={()=>{const e={quiz:'all',result:'all',company:'',cpf:'',from:'',to:''};setFilters(e);setApplied(e);setPage(1);}}>Limpar</Button></div>
  </section>
  {error?<div className="error-panel"><TriangleAlert/><h2>Respostas indisponíveis</h2><p>{error}</p></div>
  :!data?<Skeleton className="h-64 rounded-xl"/>
  :<section className="n-panel">
   <ExportBar query={query(applied)} total={data.total}/>
   <div className="panel-heading"><div><h2>{data.total} resposta{data.total!==1?'s':''}</h2><p>{data.passed} aprovada{data.passed!==1?'s':''} · {data.total-data.passed} reprovada{data.total-data.passed!==1?'s':''}. CPF mascarado na lista; o completo aparece no detalhe (fica na auditoria).</p></div></div>
   {data.rows.length?<>
    <div className="qa-table"><table><thead><tr><th>Data</th><th>Nome</th><th>Empresa</th><th>CPF</th><th>Questionário</th><th className="num">Nota</th><th>Resultado</th><th>Válida até</th></tr></thead>
     <tbody>{(data.rows as R[]).map(r=><tr key={r.id} onClick={()=>setOpen(r.id)} tabIndex={0} onKeyDown={e=>{if(e.key==='Enter')setOpen(r.id)}}><td>{fmt(r.createdAt)}</td><td><b>{r.name}</b>{r.anonymizedAt&&<> <Badge>Anonimizado</Badge></>}</td><td>{r.company}</td><td className="mono">{r.cpf}</td><td>{r.quizTitle} <small>v{r.version}</small></td><td className="num mono">{pct(r.score)}</td><td>{r.passed?<Badge tone="success">Aprovado</Badge>:<Badge tone="danger">Reprovado</Badge>}</td><td>{dayText(r.validUntil)}</td></tr>)}</tbody></table></div>
    <ul className="qa-mcards">{(data.rows as R[]).map(r=><li key={r.id}><button type="button" onClick={()=>setOpen(r.id)}><div><b>{r.name}</b><small>{r.company} · {r.cpf}</small><small>{r.quizTitle} · {fmt(r.createdAt)}</small></div><div className="qa-mres">{r.passed?<Badge tone="success">Aprovado</Badge>:<Badge tone="danger">Reprovado</Badge>}<b>{pct(r.score)}</b></div></button></li>)}</ul>
    {data.pages>1&&<div className="tl-pager qa-pager"><Button variant="outline" size="sm" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Anterior</Button><span>Página {data.page} de {data.pages}</span><Button variant="outline" size="sm" disabled={page>=data.pages} onClick={()=>setPage(p=>p+1)}>Próxima</Button></div>}
   </>:<Empty icon={ClipboardCheck} title="Nenhuma resposta encontrada" description="Ajuste os filtros ou aguarde as primeiras respostas pelo QR code."/>}
  </section>}
  {open&&<AttemptDialog key={open} id={open} onClose={()=>setOpen(null)} onOpen={setOpen} onChanged={()=>{setOpen(null);setApplied(x=>({...x}));}}/>}
 </div>;
}

function AttemptDialog({id,onClose,onOpen,onChanged}:{id:string,onClose:()=>void,onOpen:(id:string)=>void,onChanged:()=>void}){
 const [anon,setAnon]=useState(false),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const [d,setD]=useState<R|null>(null),[error,setError]=useState('');
 useEffect(()=>{load<R>('quiz/attempt?id='+encodeURIComponent(id)).then(setD,e=>setError((e as Error).message))},[id]);
 const a=d?.attempt as R|undefined;
 return <Dialog open onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="n-dialog qa-attempt"><DialogHeader><DialogTitle>{a?a.name:'Resposta'}</DialogTitle><DialogDescription>{a?`${a.quizTitle} · versão ${a.version} · ${fmt(a.createdAt)}`:'Carregando…'}</DialogDescription></DialogHeader>
  {error?<p className="form-error">{error}</p>:!a?<Skeleton className="h-48 rounded-xl"/>:<>
   <dl className="qa-facts"><div><dt>Empresa</dt><dd>{a.company}</dd></div><div><dt>CPF</dt><dd className="mono">{a.anonymizedAt?'—':formatCpf(a.cpf)}</dd></div><div><dt>Comprovante</dt><dd className="mono">{a.code}</dd></div>
    <div><dt>Resultado</dt><dd>{a.passed?<Badge tone="success">Aprovado</Badge>:<Badge tone="danger">Reprovado</Badge>}</dd></div><div><dt>Nota</dt><dd className="mono">{pct(a.score)} ({a.correct}/{a.graded}) · mín. {a.minScore}%</dd></div><div><dt>Válida até</dt><dd>{dayText(a.validUntil)}</dd></div></dl>
   {a.anonymizedAt&&<p className="qa-warn">Dados pessoais anonimizados em {fmt(a.anonymizedAt)}{a.anonymizedReason?` · ${a.anonymizedReason}`:''}.</p>}
   <div className="qa-actions">
    <Button variant="outline" onClick={()=>window.open(`/api/quiz/pdf?id=${encodeURIComponent(a.id)}`,'_blank','noopener')}><FileText size={15}/> Comprovante (PDF)</Button>
    {!a.anonymizedAt&&<Button variant="ghost" onClick={()=>setAnon(v=>!v)}><UserX size={15}/> Anonimizar dados deste CPF</Button>}
   </div>
   {anon&&<div className="qa-anon"><p>Apaga nome, empresa, CPF e textos livres de <b>todas</b> as respostas deste CPF, em todos os questionários. Notas e datas ficam. Não se desfaz.</p>
    <Field label="Motivo *" wide><Textarea maxLength={300} rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Ex.: pedido do titular por e-mail em 16/11/2026"/></Field>
    <div className="qa-actions"><Button variant="destructive" disabled={busy||reason.trim().length<3} onClick={()=>void (async()=>{setBusy(true);try{const r=await post('quiz/anonymize',{cpf:a.cpf,reason});toast.success(r.message);onChanged();}catch(e){toast.error((e as Error).message)}finally{setBusy(false)}})()}>{busy&&<LoaderCircle className="spin" size={15}/>} Anonimizar</Button><Button variant="ghost" onClick={()=>setAnon(false)}>Cancelar</Button></div></div>}
   <h3 className="qa-h">Respostas</h3>
   <ol className="qa-answers">{(a.answers as R[]).map((x,i)=>{const opt=(id:string|null)=>(x.options as R[]|undefined)?.find(o=>o.id===id)?.text||'—';return <li key={x.id} className={x.isCorrect===true?'ok':x.isCorrect===false?'bad':''}>
    <div className="qa-ans-head">{x.isCorrect===true?<CheckCircle2 size={17}/>:x.isCorrect===false?<XCircle size={17}/>:<span className="qa-dot"/>}<b>{i+1}. {x.text}</b></div>
    {x.type==='texto'?<p>{x.answer||<em>Sem resposta</em>}</p>:<p>Respondeu: <b>{opt(x.answer)}</b>{x.isCorrect===false&&<> · certa: <b>{opt(x.correct)}</b></>}</p>}</li>;})}</ol>
   {(d!.history as R[]).length>1&&<><h3 className="qa-h">Todas as tentativas deste CPF</h3>
    <ul className="qa-history">{(d!.history as R[]).map(h=><li key={h.id}><button type="button" disabled={h.id===id} onClick={()=>onOpen(h.id)}><span>{fmt(h.createdAt)}</span><span>{h.quizTitle}</span><span className="mono">{pct(h.score)}</span>{h.passed?<Badge tone="success">Aprovado</Badge>:<Badge tone="danger">Reprovado</Badge>}</button></li>)}</ul></>}
  </>}
 </DialogContent></Dialog>;
}
