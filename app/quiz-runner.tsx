'use client';
// Avaliações: o questionário que o visitante responde pelo celular, em 3 passos (seus dados → perguntas →
// resultado). Também serve de pré-visualização no editor (preview): mesmo visual, nada é gravado.
import {useMemo,useRef,useState,type FormEvent} from 'react';
import {CheckCircle2,XCircle,ShieldCheck,LoaderCircle,ArrowLeft,RotateCcw,Info} from 'lucide-react';
import {cpfDigits,validCpf,typingCpf} from '@/lib/cpf';
import './quiz-public.css';

export type RunnerQuestion={id:string,type:'multipla'|'simnao'|'texto',text:string,required:boolean,options:{id:string,text:string}[],correct?:string|null};
export type RunnerQuiz={title:string,intro:string,version:number,questions:RunnerQuestion[],minScore:number,validity:{amount:number,unit:string},companies:string[]};
export type PreviewRules={resultDetail:'resultado'|'nota'|'erradas',dailyLimit:number};
type Result={status:string,passed?:boolean,score?:number|null,wrong?:string[]|null,validUntil?:string|null,code?:string,remainingToday?:number};
type Block={kind:'valida'|'limite'|'indisponivel'|'erro',message:string,validUntil?:string};

const dayText=(d?:string|null)=>d?`${d.slice(8,10)}/${d.slice(5,7)}/${d.slice(0,4)}`:'';
const validityText=(v:{amount:number,unit:string})=>v.unit==='meses'?(v.amount%12===0?`${v.amount/12} ${v.amount===12?'ano':'anos'}`:`${v.amount} ${v.amount===1?'mês':'meses'}`):`${v.amount} ${v.amount===1?'dia':'dias'}`;
const newKey=()=>(typeof crypto!=='undefined'&&'randomUUID' in crypto)?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36);

async function send(path:string,body:Record<string,unknown>){
 const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const j=await r.json().catch(()=>({error:'Sem resposta do servidor. Confira a internet e tente de novo.'}));
 if(!r.ok)throw Object.assign(new Error(j.error||'Não foi possível enviar.'),{code:j.code as string|undefined,data:j.data as Record<string,string>|undefined});
 return j;
}
/** Correção local, só na pré-visualização (o editor já conhece o gabarito). */
function localGrade(q:RunnerQuiz,answers:Record<string,string>,rules:PreviewRules):Result{
 const graded=q.questions.filter(x=>x.type!=='texto'),right=graded.filter(x=>answers[x.id]===x.correct);
 const passed=right.length*100>=q.minScore*graded.length,score=graded.length?Math.round(right.length*10000/graded.length)/100:0;
 return {status:'avaliado',passed,score:rules.resultDetail==='resultado'?null:score,wrong:rules.resultDetail==='erradas'?graded.filter(x=>answers[x.id]!==x.correct).map(x=>x.text):null,
  validUntil:passed?'(data da aprovação + validade)':null,code:'PREVIEW0',remainingToday:passed?0:rules.dailyLimit-1};
}

export default function QuizRunner({token,quiz,preview}:{token?:string,quiz:RunnerQuiz,preview?:PreviewRules}){
 const [step,setStep]=useState<1|2|3>(1);
 const [person,setPerson]=useState({name:'',company:'',cpf:''}),[trap,setTrap]=useState('');
 const [touched,setTouched]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [block,setBlock]=useState<Block|null>(null);
 const [ticket,setTicket]=useState(''),[answers,setAnswers]=useState<Record<string,string>>({});
 const [missing,setMissing]=useState<string[]>([]),[result,setResult]=useState<Result|null>(null);
 const submitKey=useRef(newKey()),top=useRef<HTMLDivElement>(null);
 const cpf=cpfDigits(person.cpf);
 const issues={name:!/\S\s+\S/.test(person.name.trim())||person.name.trim().length<3?'Informe nome e sobrenome.':'',
  company:!person.company.trim()?'Informe a empresa.':'',cpf:cpf.length<11?'Informe os 11 números do CPF.':!validCpf(cpf)?'CPF inválido. Confira os números.':''};
 const answered=useMemo(()=>quiz.questions.filter(q=>(answers[q.id]||'').trim()).length,[answers,quiz.questions]);
 const scrollTop=()=>top.current?.scrollIntoView({behavior:'smooth',block:'start'});

 function fail(e:unknown){
  const err=e as Error&{code?:string,data?:Record<string,string>};
  if(err.code==='CPF_VALID')setBlock({kind:'valida',message:err.message,validUntil:err.data?.validUntil});
  else if(err.code==='DAILY_LIMIT')setBlock({kind:'limite',message:err.message});
  else if(err.code==='UNAVAILABLE')setBlock({kind:'indisponivel',message:err.message});
  else if(err.code==='TICKET'){setStep(1);setError(err.message);}
  else setError(err.message);
 }
 async function start(e?:FormEvent){
  e?.preventDefault();setTouched(true);setError('');
  if(issues.name||issues.company||issues.cpf)return;
  setBusy(true);
  try{
   if(!preview){const r=await send('public/quiz/check',{token,...person,cpf});setTicket(r.ticket);}
   submitKey.current=newKey();setAnswers({});setMissing([]);setResult(null);setStep(2);scrollTop();
  }catch(err){fail(err)}finally{setBusy(false)}
 }
 async function finish(){
  setError('');
  const lack=quiz.questions.filter(q=>q.required&&!(answers[q.id]||'').trim()).map(q=>q.id);
  setMissing(lack);
  if(lack.length){document.getElementById('q-'+lack[0])?.scrollIntoView({behavior:'smooth',block:'center'});setError(`Falta${lack.length>1?'m':''} ${lack.length} pergunta${lack.length>1?'s':''} obrigatória${lack.length>1?'s':''}.`);return;}
  setBusy(true);
  try{
   const r:Result=preview?localGrade(quiz,answers,preview):await send('public/quiz/submit',{token,...person,cpf,ticket,submitKey:submitKey.current,version:quiz.version,answers,website:trap});
   setResult(r);setStep(3);scrollTop();
  }catch(err){fail(err)}finally{setBusy(false)}
 }

 return <div className="qz" ref={top}>
  <header className="qz-top">
   {/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático */}
   <img src="/logo-color.svg" alt="OceanPact LOG"/>
   <span>Avaliação{preview&&' · pré-visualização'}</span>
  </header>
  <main className="qz-main">
   <h1>{quiz.title}</h1>
   <ol className="qz-steps" aria-label="Etapas">{['Seus dados','Perguntas','Resultado'].map((s,i)=><li key={s} className={step===i+1?'on':step>i+1?'done':''} aria-current={step===i+1?'step':undefined}><b>{i+1}</b>{s}</li>)}</ol>

   {block?<section className={`qz-card qz-block ${block.kind}`} role="alert">
     {block.kind==='valida'?<ShieldCheck/>:<Info/>}
     <h2>{block.kind==='valida'?'Avaliação já válida':block.kind==='limite'?'Limite de hoje atingido':'Questionário indisponível'}</h2>
     <p>{block.message}</p>
     {block.kind==='valida'&&<p className="qz-hint">Não é preciso responder de novo. Em caso de dúvida, procure a recepção.</p>}
     <button type="button" className="qz-btn ghost" onClick={()=>{setBlock(null);setStep(1);}}><ArrowLeft size={18}/> Voltar</button>
    </section>

   :step===1?<form className="qz-card" onSubmit={start} noValidate>
     {quiz.intro&&<p className="qz-intro">{quiz.intro}</p>}
     <p className="qz-rules">{quiz.questions.length} pergunta{quiz.questions.length>1?'s':''} · nota mínima {quiz.minScore}% · válida por {validityText(quiz.validity)} após a aprovação</p>
     <label className="qz-field"><span>Nome completo</span>
      <input autoComplete="name" maxLength={120} value={person.name} onChange={e=>setPerson(p=>({...p,name:e.target.value}))} aria-invalid={touched&&!!issues.name}/>
      {touched&&issues.name&&<small role="alert">{issues.name}</small>}</label>
     <label className="qz-field"><span>Empresa</span>
      <input autoComplete="organization" maxLength={120} list="qz-companies" value={person.company} onChange={e=>setPerson(p=>({...p,company:e.target.value}))} aria-invalid={touched&&!!issues.company}/>
      <datalist id="qz-companies">{quiz.companies.map(c=><option key={c} value={c}/>)}</datalist>
      {touched&&issues.company&&<small role="alert">{issues.company}</small>}</label>
     <label className="qz-field"><span>CPF</span>
      <input inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" value={person.cpf} onChange={e=>setPerson(p=>({...p,cpf:typingCpf(e.target.value)}))} aria-invalid={touched&&!!issues.cpf}/>
      {touched&&issues.cpf&&<small role="alert">{issues.cpf}</small>}</label>
     {/* Campo-armadilha: invisível para pessoas; robôs preenchem. */}
     <div className="qz-trap" aria-hidden="true"><label>Site<input tabIndex={-1} autoComplete="off" value={trap} onChange={e=>setTrap(e.target.value)} name="website"/></label></div>
     {error&&<p className="qz-error" role="alert">{error}</p>}
     <button type="submit" className="qz-btn" disabled={busy}>{busy&&<LoaderCircle className="qz-spin" size={18}/>} Começar</button>
     <p className="qz-hint">Seus dados servem só para registrar esta avaliação.</p>
    </form>

   :step===2?<div className="qz-questions">
     <p className="qz-progress" aria-live="polite"><span><b>{answered}</b> de {quiz.questions.length} respondidas</span><i aria-hidden style={{['--p' as string]:`${quiz.questions.length?answered*100/quiz.questions.length:0}%`}}/></p>
     {quiz.questions.map((q,i)=><fieldset key={q.id} id={'q-'+q.id} className={`qz-card qz-q ${missing.includes(q.id)&&!(answers[q.id]||'').trim()?'missing':''}`}>
      <legend><span className="qz-num">{i+1}</span><span>{q.text}{!q.required&&<em> (opcional)</em>}</span></legend>
      {q.type==='texto'
       ?<textarea maxLength={1000} rows={3} value={answers[q.id]||''} onChange={e=>setAnswers(a=>({...a,[q.id]:e.target.value}))} aria-label={q.text}/>
       :<div className={`qz-options ${q.type==='simnao'?'yesno':''}`}>{q.options.map(o=><label key={o.id} className={answers[q.id]===o.id?'on':''}>
         <input type="radio" name={q.id} value={o.id} checked={answers[q.id]===o.id} onChange={()=>setAnswers(a=>({...a,[q.id]:o.id}))}/><span>{o.text}</span></label>)}</div>}
     </fieldset>)}
     {error&&<p className="qz-error" role="alert">{error}</p>}
     <button type="button" className="qz-btn" disabled={busy} onClick={()=>void finish()}>{busy&&<LoaderCircle className="qz-spin" size={18}/>} Enviar respostas</button>
    </div>

   :result?.status==='recebido'?<section className="qz-card qz-result"><CheckCircle2/><h2>Respostas recebidas</h2></section>
   :result&&<section className={`qz-card qz-result ${result.passed?'pass':'fail'}`} aria-live="polite">
     {result.passed?<CheckCircle2/>:<XCircle/>}
     <h2>{result.passed?'Aprovado':'Reprovado'}</h2>
     {result.score!=null&&<p className="qz-score"><b>{result.score.toLocaleString('pt-BR',{maximumFractionDigits:2})}%</b> de acertos · mínimo {quiz.minScore}%</p>}
     {result.passed?<>
       <p>Avaliação válida até <b>{preview?result.validUntil:dayText(result.validUntil)}</b>.</p>
       <p className="qz-code">Comprovante <b>{result.code}</b></p>
       <p className="qz-hint">Se pedirem, mostre esta tela na recepção.</p>
      </>:<>
       {!!result.wrong?.length&&<div className="qz-wrong"><h3>Reveja estas perguntas</h3><ul>{result.wrong.map(w=><li key={w}>{w}</li>)}</ul></div>}
       {(result.remainingToday||0)>0
        ?<><p>Você pode tentar de novo: {result.remainingToday} tentativa{result.remainingToday!==1?'s':''} restante{result.remainingToday!==1?'s':''} hoje.</p>
          <button type="button" className="qz-btn" disabled={busy} onClick={()=>void start()}>{busy?<LoaderCircle className="qz-spin" size={18}/>:<RotateCcw size={18}/>} Tentar de novo</button></>
        :<p>As tentativas de hoje acabaram. Você pode tentar de novo amanhã.</p>}
      </>}
     {error&&<p className="qz-error" role="alert">{error}</p>}
    </section>}
  </main>
 </div>;
}
