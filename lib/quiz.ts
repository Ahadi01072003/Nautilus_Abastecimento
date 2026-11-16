// Avaliações por QR code · fase A. Questionários com versões e link público permanente (/q/<token>):
// o visitante responde sem login, o servidor corrige (o gabarito nunca vai para a página pública) e guarda
// cada tentativa com a cópia das perguntas daquele momento. Uma avaliação válida por CPF por período
// (a validade conta da aprovação); reprovado refaz até passar, com limite de tentativas por dia.
// Acesso interno: "avaliacoes" (a Gestão tem sempre).
import {randomBytes,randomInt} from 'node:crypto';
import {db,type Executor,type Row} from './db';
import {AppError,required,text,isoDay} from './domain';
import {type Member,requireAny} from './permissions';
import {audit} from './registry';
import {xlsx,csv,zip,type Sheet} from './files';
import {certificatePdf,type CertificateData} from './quiz-pdf';
import {DEFAULT_LOGO_PNG} from './quiz-logo';
import {cpfDigits,validCpf,maskCpf,formatCpf} from './cpf';

const TZ='America/Sao_Paulo';
const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
/** Tempo mínimo entre a etapa do CPF e o envio, e validade do bilhete. */
export const MIN_SECONDS=5,TICKET_HOURS=6;
/** Comprovantes por arquivo .zip (cabe no tempo da função) e linhas por exportação. */
export const PDF_BATCH_LIMIT=500,EXPORT_LIMIT=20000;
const ANON='Anonimizado';
const PAGE=30;

export type QuestionType='multipla'|'simnao'|'texto';
export type Question={id:string,type:QuestionType,text:string,required:boolean,options:{id:string,text:string}[],correct:string|null};
const YES_NO=[{id:'sim',text:'Sim'},{id:'nao',text:'Não'}];
const DETAILS=['resultado','nota','erradas'] as const;
const DEFAULT_PDF_BODY='Certificamos que {nome}, da empresa {empresa}, realizou a avaliação "{questionario}" em {data}, com {nota} de acertos (mínimo {minimo}). Resultado: {resultado}.';
const STATUS_NAME:Record<string,string>={rascunho:'Rascunho',publicado:'Publicado',pausado:'Pausado',encerrado:'Encerrado'};

// ───────────── Regras puras ─────────────
export {cpfDigits,validCpf,maskCpf,formatCpf} from './cpf';
/** Data civil no horário de Brasília. */
export const brDay=(t:number|string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:TZ}).format(new Date(t));
const dayStart=(day:string)=>new Date(`${day}T00:00:00-03:00`).toISOString();
export const dayText=(day:string|null)=>day?`${day.slice(8,10)}/${day.slice(5,7)}/${day.slice(0,4)}`:'';
/** Último dia de validade: meses somam no calendário (31/01 + 1 mês = 28/02); dias somam dias. */
export function validUntilDay(day:string,amount:number,unit:'dias'|'meses'){
 const [y,m,d]=day.split('-').map(Number);
 let date:Date;
 if(unit==='dias')date=new Date(Date.UTC(y,m-1,d+amount));
 else{const total=m-1+amount,ny=y+Math.floor(total/12),nm=total%12,last=new Date(Date.UTC(ny,nm+1,0)).getUTCDate();date=new Date(Date.UTC(ny,nm,Math.min(d,last)));}
 return date.toISOString().slice(0,10);
}

const QID=/^[A-Za-z0-9_-]{1,40}$/;
const shortId=()=>randomBytes(6).toString('base64url');
/** Perguntas do rascunho: estrutura e limites (pode estar incompleto; publicar confere o gabarito). */
export function normQuestions(raw:unknown):Question[]{
 if(raw==null)return [];
 if(!Array.isArray(raw))throw new AppError('Perguntas inválidas.');
 if(raw.length>100)throw new AppError('Use no máximo 100 perguntas.');
 const seen=new Set<string>();
 return raw.map((q:Row,i)=>{
  if(!q||typeof q!=='object')throw new AppError('Perguntas inválidas.');
  const type=q.type as QuestionType;
  if(!['multipla','simnao','texto'].includes(type))throw new AppError(`Pergunta ${i+1}: tipo inválido.`);
  let qid=typeof q.id==='string'&&QID.test(q.id)?q.id:shortId();while(seen.has(qid))qid=shortId();seen.add(qid);
  const qtext=text(q.text,500);
  let options:Question['options']=[],correct:string|null=null;
  if(type==='multipla'){
   if(q.options!=null&&!Array.isArray(q.options))throw new AppError(`Pergunta ${i+1}: alternativas inválidas.`);
   const list=(q.options||[]) as Row[];
   if(list.length>10)throw new AppError(`Pergunta ${i+1}: use no máximo 10 alternativas.`);
   const oseen=new Set<string>();
   options=list.map(o=>{let oid=typeof o?.id==='string'&&QID.test(o.id)?o.id:shortId();while(oseen.has(oid))oid=shortId();oseen.add(oid);return {id:oid,text:text(o?.text,200)};});
   correct=typeof q.correct==='string'&&options.some(o=>o.id===q.correct)?q.correct:null;
  }else if(type==='simnao'){options=YES_NO;correct=q.correct==='sim'||q.correct==='nao'?q.correct:null;}
  return {id:qid,type,text:qtext,required:type==='texto'?q.required===true:true,options,correct};
 });
}
/** O que falta para publicar (null quando está tudo certo). */
export function publishIssue(qs:Question[]){
 if(!qs.length)return 'Inclua ao menos uma pergunta.';
 for(const [i,q] of qs.entries()){
  if(!q.text)return `Pergunta ${i+1}: escreva o enunciado.`;
  if(q.type==='multipla'){
   if(q.options.length<2)return `Pergunta ${i+1}: inclua ao menos duas alternativas.`;
   if(q.options.some(o=>!o.text))return `Pergunta ${i+1}: há alternativa sem texto.`;
  }
  if(q.type!=='texto'&&!q.correct)return `Pergunta ${i+1}: marque a resposta certa.`;
 }
 if(!qs.some(q=>q.type!=='texto'))return 'Inclua ao menos uma pergunta que vale nota (múltipla escolha ou sim/não).';
 return null;
}
/** Correção no servidor; devolve a cópia das perguntas com as respostas. */
export function grade(qs:Question[],answers:unknown){
 const given=(answers&&typeof answers==='object'&&!Array.isArray(answers)?answers:{}) as Row;
 let correct=0,graded=0;
 const snapshot=qs.map(q=>{
  const raw=given[q.id];
  if(q.type==='texto'){
   const value=text(typeof raw==='string'?raw:'',1000);
   if(q.required&&!value)throw new AppError('Responda todas as perguntas obrigatórias.',400,'MISSING_ANSWER');
   return {id:q.id,type:q.type,text:q.text,answer:value||null,correct:null,isCorrect:null};
  }
  graded++;
  const answer=typeof raw==='string'&&q.options.some(o=>o.id===raw)?raw:null;
  if(!answer)throw new AppError('Responda todas as perguntas obrigatórias.',400,'MISSING_ANSWER');
  const ok=answer===q.correct;if(ok)correct++;
  return {id:q.id,type:q.type,text:q.text,options:q.options,answer,correct:q.correct,isCorrect:ok};
 });
 return {snapshot,correct,graded};
}
function shuffled<T>(list:T[]){const a=[...list];for(let i=a.length-1;i>0;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
const newToken=()=>randomBytes(24).toString('base64url');
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode=()=>Array.from({length:8},()=>CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

// ───────────── Página pública (sem login) ─────────────
const UNAVAILABLE='Questionário indisponível no momento.';
async function liveQuiz(ex:Executor,token:string){
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{20,64}$/.test(token))return null;
 return await ex.first('SELECT * FROM quizzes WHERE token=?',token);
}
function unavailable(q:Row|null):never{throw new AppError(q?.closed_message||UNAVAILABLE,409,'UNAVAILABLE');}

/** Questionário para responder: sem gabarito; perguntas e alternativas embaralhadas quando configurado. */
export async function publicQuiz(token:string){
 const q=await liveQuiz(db(),token);
 if(!q||q.status!=='publicado')return {status:'indisponivel',message:q?.closed_message||UNAVAILABLE};
 const v=await db().first('SELECT * FROM quiz_versions WHERE quiz_id=? AND version=?',q.id,q.published_version);
 if(!v)return {status:'indisponivel',message:UNAVAILABLE};
 const companies=await db().all("SELECT min(trim(company)) company FROM quiz_attempts WHERE quiz_id=? GROUP BY lower(trim(company)) ORDER BY count(*) DESC LIMIT 100",q.id);
 let questions=(v.questions as Question[]).map(x=>({id:x.id,type:x.type,text:x.text,required:x.required,options:x.type==='multipla'&&Number(q.shuffle)===1?shuffled(x.options):x.options}));
 if(Number(q.shuffle)===1)questions=shuffled(questions);
 return {status:'ok',quiz:{title:v.title,intro:v.intro,version:Number(v.version),questions,minScore:Number(q.min_score),
  validity:{amount:Number(q.validity_amount),unit:q.validity_unit},companies:companies.map(c=>c.company as string),
  consent:{version:Number(q.consent_version),text:q.consent_text as string}}};
}

/** Aceite do termo: obrigatório e da versão em vigor (página antiga pede para recarregar). */
function consent(q:Row,b:Row){
 if(b.consent!==true)throw new AppError('Para continuar, leia e aceite o termo de uso dos dados.',400,'CONSENT','consent');
 if(Number(b.consentVersion)!==Number(q.consent_version))throw new AppError('O termo de uso dos dados foi atualizado. Recarregue a página e leia de novo.',409,'CONSENT');
 return Number(q.consent_version);
}
function person(b:Row){
 const cpf=cpfDigits(b.cpf);
 if(!validCpf(cpf))throw new AppError('CPF inválido. Confira os números.',400,'CPF_INVALID','cpf');
 const name=required(b.name,'Nome completo',120).replace(/\s+/g,' ');
 if(name.length<3||!/\S\s+\S/.test(name))throw new AppError('Informe o nome completo (nome e sobrenome).',400,'NAME','name');
 const company=required(b.company,'Empresa',120).replace(/\s+/g,' ');
 return {cpf,name,company};
}
/** Avaliação válida e tentativas de hoje do CPF neste questionário. */
async function cpfState(ex:Executor,q:Row,cpf:string){
 const today=brDay(Date.now());
 const [valid,count]=await Promise.all([
  ex.first("SELECT max(valid_until) valid_until FROM quiz_attempts WHERE quiz_id=? AND cpf=? AND passed=1 AND valid_until>=?",q.id,cpf,today),
  ex.first("SELECT count(*)::int n FROM quiz_attempts WHERE quiz_id=? AND cpf=? AND created_at>=?",q.id,cpf,dayStart(today))]);
 return {validUntil:(valid?.valid_until as string)||null,today:Number(count?.n||0)};
}
function blockIfNeeded(q:Row,s:{validUntil:string|null,today:number}){
 if(s.validUntil)throw new AppError(`Este CPF já tem avaliação válida até ${dayText(s.validUntil)}.`,409,'CPF_VALID',undefined,{validUntil:s.validUntil});
 if(s.today>=Number(q.daily_limit))throw new AppError('Limite de tentativas de hoje atingido. Tente novamente amanhã.',429,'DAILY_LIMIT');
}

/** Etapa 1: confere os dados e o CPF antes das perguntas; entrega um bilhete de uso único. */
export async function publicCheck(token:string,b:Row){
 const q=await liveQuiz(db(),token);
 if(!q||q.status!=='publicado')unavailable(q);
 const p=person(b),version=consent(q,b),s=await cpfState(db(),q,p.cpf);
 blockIfNeeded(q,s);
 const ticket=newToken();
 await db().run('INSERT INTO quiz_tickets(id,quiz_id,cpf,issued_at,consent_version) VALUES(?,?,?,?,?)',ticket,q.id,p.cpf,now(),version);
 if(Math.random()<0.02)await db().run('DELETE FROM quiz_tickets WHERE issued_at<?',new Date(Date.now()-24*3600_000).toISOString());
 return {ticket,remainingToday:Number(q.daily_limit)-s.today};
}

function resultOf(q:Row,a:Row,todayCount:number){
 const detail=q.result_detail as typeof DETAILS[number],passed=Number(a.passed)===1;
 return {status:'avaliado',passed,code:a.code as string,validUntil:(a.valid_until as string)||null,
  score:detail==='resultado'?null:Number(a.score),
  wrong:detail==='erradas'?(a.answers as Row[]).filter(x=>x.isCorrect===false).map(x=>x.text as string):null,
  remainingToday:passed?0:Math.max(0,Number(q.daily_limit)-todayCount)};
}

/** Etapa 2: envio das respostas. Corrige, grava a tentativa e devolve o resultado (reenvio devolve o mesmo). */
export async function publicSubmit(token:string,b:Row,meta:{ipHash:string,userAgent:string}){
 // Campo-armadilha preenchido: robô. Responde como recebido e não grava nada.
 if(typeof b.website==='string'&&b.website.trim())return {status:'recebido'};
 const submitKey=required(b.submitKey,'Chave do envio',64);
 if(submitKey.length<8)throw new AppError('Envio inválido. Recomece o questionário.');
 const p=person(b);
 return await db().tx(async tx=>{
  const q=await liveQuiz(tx,token);
  if(!q)unavailable(null);
  await tx.first('SELECT 1 ok FROM (SELECT pg_advisory_xact_lock(hashtext(?))) x','quiz:'+q.id+':'+p.cpf);
  const prev=await tx.first('SELECT * FROM quiz_attempts WHERE quiz_id=? AND submit_key=?',q.id,submitKey);
  if(prev)return resultOf(q,prev,(await cpfState(tx,q,prev.cpf as string)).today);
  if(q.status!=='publicado')unavailable(q);
  const t=await tx.first('SELECT * FROM quiz_tickets WHERE id=? AND quiz_id=? FOR UPDATE',text(b.ticket,64),q.id);
  const age=t?Date.now()-Date.parse(t.issued_at as string):Infinity;
  if(!t||t.used_at||t.cpf!==p.cpf||age>TICKET_HOURS*3600_000)throw new AppError('Este questionário expirou. Recomece pelos seus dados.',409,'TICKET');
  if(age<MIN_SECONDS*1000)throw new AppError('Envio rápido demais. Confira as respostas e envie de novo.',429,'TOO_FAST');
  if(t.consent_version==null)throw new AppError('Este questionário expirou. Recomece pelos seus dados.',409,'TICKET');
  const s=await cpfState(tx,q,p.cpf);
  blockIfNeeded(q,s);
  const asked=Math.floor(Number(b.version));
  const version=asked>=1&&asked<=Number(q.published_version)?asked:Number(q.published_version);
  const v=await tx.first('SELECT * FROM quiz_versions WHERE quiz_id=? AND version=?',q.id,version);
  if(!v)unavailable(q);
  const g=grade(v.questions as Question[],b.answers);
  const passed=g.correct*100>=Number(q.min_score)*g.graded;
  const score=Math.round(g.correct*10000/g.graded)/100;
  const at=now(),validUntil=passed?validUntilDay(brDay(at),Number(q.validity_amount),q.validity_unit):null;
  const started=typeof t.issued_at==='string'?t.issued_at:at;
  let code=newCode();
  for(let i=0;i<5&&await tx.first('SELECT 1 FROM quiz_attempts WHERE code=?',code);i++)code=newCode();
  const row=await tx.first(`INSERT INTO quiz_attempts(id,quiz_id,version,code,submit_key,cpf,name,company,answers,correct_count,graded_count,score,min_score,passed,valid_until,ip_hash,user_agent,started_at,created_at,consent_version,consent_at)
   VALUES(?,?,?,?,?,?,?,?,?::text::jsonb,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,id(),q.id,version,code,submitKey,p.cpf,p.name,p.company,JSON.stringify(g.snapshot),
   g.correct,g.graded,score,Number(q.min_score),passed?1:0,validUntil,String(meta.ipHash||'').slice(0,64),String(meta.userAgent||'').slice(0,200),started,at,Number(t.consent_version),started);
  await tx.run('UPDATE quiz_tickets SET used_at=? WHERE id=?',at,t.id);
  return resultOf(q,row!,s.today+1);
 });
}

// ───────────── Telas internas (acesso Avaliações) ─────────────
const access=async(m:Member)=>await requireAny(m,['avaliacoes']);
const int=(v:unknown,label:string,min:number,max:number)=>{const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw new AppError(`${label}: informe um número inteiro de ${min} a ${max}.`);return n;};
const quizRow=(q:Row)=>({id:q.id,token:q.token,path:'/q/'+q.token,status:q.status,statusName:STATUS_NAME[q.status],title:q.title,intro:q.intro,questions:q.questions,
 publishedVersion:Number(q.published_version),validityAmount:Number(q.validity_amount),validityUnit:q.validity_unit,minScore:Number(q.min_score),
 dailyLimit:Number(q.daily_limit),resultDetail:q.result_detail,shuffle:Number(q.shuffle)===1,closedMessage:q.closed_message,rev:Number(q.rev),updatedAt:q.updated_at,
 consentText:q.consent_text,consentVersion:Number(q.consent_version),retentionMonths:q.retention_months==null?null:Number(q.retention_months),
 pdfTitle:q.pdf_title,pdfBody:q.pdf_body,pdfFooter:q.pdf_footer,hasLogo:!!q.pdf_logo_type});
async function getQuiz(ex:Executor,qid:unknown,lock=false){
 const q=await ex.first(`SELECT * FROM quizzes WHERE id=?${lock?' FOR UPDATE':''}`,text(qid,64));
 if(!q)throw new AppError('Questionário não encontrado.',404);
 return q;
}
const checkRev=(q:Row,rev:unknown)=>{if(rev!=null&&Number(rev)!==Number(q.rev))throw new AppError('Este questionário foi alterado por outra pessoa. Atualize a tela.',409,'STALE');};

export async function quizList(member:Member){
 await access(member);
 const rows=await db().all(`SELECT q.*,
   (SELECT count(*)::int FROM quiz_attempts a WHERE a.quiz_id=q.id) attempts,
   (SELECT count(*)::int FROM quiz_attempts a WHERE a.quiz_id=q.id AND a.passed=1) passed,
   (SELECT max(created_at) FROM quiz_attempts a WHERE a.quiz_id=q.id) last_attempt
  FROM quizzes q ORDER BY CASE q.status WHEN 'publicado' THEN 0 WHEN 'pausado' THEN 1 WHEN 'rascunho' THEN 2 ELSE 3 END,q.updated_at DESC`);
 return {rows:rows.map(q=>({...quizRow(q),questions:undefined,questionCount:(q.questions as unknown[]).length,attempts:Number(q.attempts),passed:Number(q.passed),lastAttemptAt:q.last_attempt||null})),generatedAt:now()};
}

export async function quizDetail(member:Member,qid:string){
 await access(member);
 const q=await getQuiz(db(),qid);
 const versions=await db().all('SELECT v.version,v.title,v.published_at,m.name published_by_name,(SELECT count(*)::int FROM quiz_attempts a WHERE a.quiz_id=v.quiz_id AND a.version=v.version) attempts FROM quiz_versions v JOIN members m ON m.id=v.published_by WHERE v.quiz_id=? ORDER BY v.version DESC',q.id);
 const last=await db().first('SELECT (title=? AND intro=? AND questions=?::text::jsonb) same FROM quiz_versions WHERE quiz_id=? AND version=?',q.title,q.intro,JSON.stringify(q.questions),q.id,q.published_version);
 return {quiz:{...quizRow(q),dirty:Number(q.published_version)===0||!last?.same},
  versions:versions.map(v=>({version:Number(v.version),title:v.title,publishedAt:v.published_at,publishedBy:v.published_by_name,attempts:Number(v.attempts)}))};
}

async function saveQuiz(a:Member,b:Row){
 const opKey=b.id?null:required(b.idempotencyKey,'Chave do envio',64);
 return await db().tx(async tx=>{
  const old=b.id?await getQuiz(tx,b.id,true):null;
  if(!old&&opKey){const prev=await tx.first('SELECT id,rev FROM quizzes WHERE create_key=?',opKey);if(prev)return {id:prev.id as string,rev:Number(prev.rev),message:'Questionário já criado.',replayed:true};}
  if(old){checkRev(old,b.rev);if(old.status==='encerrado')throw new AppError('Questionário encerrado não pode ser alterado.',409);}
  const pick=(k:string,col:string,fallback:unknown)=>b[k]!==undefined?b[k]:old?old[col]:fallback;
  const title=required(pick('title','title',''),'Título',120);
  const intro=text(pick('intro','intro',''),2000);
  const questions=normQuestions(pick('questions','questions',[]));
  const unit=pick('validityUnit','validity_unit','meses');
  if(unit!=='dias'&&unit!=='meses')throw new AppError('Unidade da validade inválida.');
  const amount=int(pick('validityAmount','validity_amount',12),'Validade',1,unit==='meses'?120:3650);
  const minScore=int(pick('minScore','min_score',70),'Nota mínima (%)',1,100);
  const dailyLimit=int(pick('dailyLimit','daily_limit',3),'Tentativas por dia',1,20);
  const detail=pick('resultDetail','result_detail','erradas');
  if(!DETAILS.includes(detail as never))throw new AppError('Detalhe do resultado inválido.');
  const shuffle=pick('shuffle','shuffle',0);const shuffleFlag=shuffle===true||Number(shuffle)===1?1:0;
  const closed=text(pick('closedMessage','closed_message',''),300);
  const consentText=b.consentText!==undefined?required(b.consentText,'Termo de uso dos dados',4000):old?old.consent_text as string:null;
  if(consentText!=null&&consentText.length<20)throw new AppError('Termo de uso dos dados: escreva ao menos 20 caracteres.');
  const ret=pick('retentionMonths','retention_months',null);
  const retention=ret==null||ret===''?null:int(ret,'Retenção (meses)',6,120);
  const pdfTitle=required(pick('pdfTitle','pdf_title','Comprovante de avaliação'),'Título do comprovante',120);
  const pdfBody=text(pick('pdfBody','pdf_body',DEFAULT_PDF_BODY),2000);
  const pdfFooter=text(pick('pdfFooter','pdf_footer',''),300);
  const t=now(),values=[title,intro,JSON.stringify(questions),amount,unit,minScore,dailyLimit,detail,shuffleFlag,closed,retention,pdfTitle,pdfBody,pdfFooter];
  if(old){
   const r=await tx.first(`UPDATE quizzes SET title=?,intro=?,questions=?::text::jsonb,validity_amount=?,validity_unit=?,min_score=?,daily_limit=?,result_detail=?,shuffle=?,closed_message=?,
     retention_months=?,pdf_title=?,pdf_body=?,pdf_footer=?,rev=rev+1,updated_at=? WHERE id=? RETURNING rev`,...values,t,old.id);
   // Termo com texto novo vira nova versão (as tentativas guardam a versão aceita).
   if(consentText!=null&&consentText!==old.consent_text){
    const v=await tx.first('UPDATE quizzes SET consent_text=?,consent_version=consent_version+1 WHERE id=? RETURNING consent_version',consentText,old.id);
    await tx.run('INSERT INTO quiz_consents(quiz_id,version,text,created_at,created_by) VALUES(?,?,?,?,?)',old.id,v!.consent_version,consentText,t,a.id);
    await audit(tx,a,'Avaliações: termo de uso dos dados atualizado',old.id as string,{title,version:Number(v!.consent_version)});
   }
   await audit(tx,a,'Avaliações: questionário atualizado',old.id as string,{title,questions:questions.length,validity:`${amount} ${unit}`,minScore,dailyLimit,resultDetail:detail});
   return {id:old.id as string,rev:Number(r!.rev),message:'Questionário salvo.'};
  }
  const qid=id();
  await tx.run(`INSERT INTO quizzes(id,token,title,intro,questions,validity_amount,validity_unit,min_score,daily_limit,result_detail,shuffle,closed_message,retention_months,pdf_title,pdf_body,pdf_footer,create_key,created_by,created_at,updated_at${consentText?',consent_text':''})
   VALUES(?,?,?,?,?::text::jsonb,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${consentText?',?':''})`,qid,newToken(),...values,opKey,a.id,t,t,...(consentText?[consentText]:[]));
  await tx.run('INSERT INTO quiz_consents(quiz_id,version,text,created_at,created_by) SELECT id,consent_version,consent_text,?,? FROM quizzes WHERE id=?',t,a.id,qid);
  await audit(tx,a,'Avaliações: questionário criado',qid,{title});
  return {id:qid,rev:1,message:'Questionário criado. Publique para liberar o link.'};
 });
}

async function publishQuiz(a:Member,b:Row){
 return await db().tx(async tx=>{
  const q=await getQuiz(tx,b.id,true);checkRev(q,b.rev);
  if(q.status==='encerrado')throw new AppError('Questionário encerrado não pode ser publicado.',409);
  const issue=publishIssue(q.questions as Question[]);if(issue)throw new AppError(issue,400,'INCOMPLETE');
  if(Number(q.published_version)>0){
   const last=await tx.first('SELECT (title=? AND intro=? AND questions=?::text::jsonb) same FROM quiz_versions WHERE quiz_id=? AND version=?',q.title,q.intro,JSON.stringify(q.questions),q.id,q.published_version);
   if(last?.same)throw new AppError('Não há alterações para publicar.',400,'NOTHING');
  }
  const version=Number(q.published_version)+1,t=now();
  await tx.run('INSERT INTO quiz_versions(quiz_id,version,title,intro,questions,published_at,published_by) VALUES(?,?,?,?,?::text::jsonb,?,?)',q.id,version,q.title,q.intro,JSON.stringify(q.questions),t,a.id);
  const r=await tx.first("UPDATE quizzes SET published_version=?,status=CASE WHEN status='rascunho' THEN 'publicado' ELSE status END,rev=rev+1,updated_at=? WHERE id=? RETURNING rev,status",version,t,q.id);
  await audit(tx,a,'Avaliações: versão publicada',q.id as string,{title:q.title,version});
  return {id:q.id,rev:Number(r!.rev),version,status:r!.status,message:version===1?'Questionário publicado. O link já funciona.':`Versão ${version} publicada. O link e o QR code continuam os mesmos.`};
 });
}

async function setStatus(a:Member,b:Row){
 const status=b.status;
 if(!['publicado','pausado','encerrado'].includes(status))throw new AppError('Situação inválida.');
 return await db().tx(async tx=>{
  const q=await getQuiz(tx,b.id,true);
  if(q.status==='encerrado')throw new AppError('Questionário encerrado não volta.',409);
  if(Number(q.published_version)===0&&status!=='encerrado')throw new AppError('Publique o questionário antes.',409);
  const r=await tx.first('UPDATE quizzes SET status=?,rev=rev+1,updated_at=? WHERE id=? RETURNING rev',status,now(),q.id);
  await audit(tx,a,`Avaliações: questionário ${status==='publicado'?'reaberto':status}`,q.id as string,{title:q.title,from:q.status,to:status});
  return {id:q.id,rev:Number(r!.rev),status,message:status==='pausado'?'Questionário pausado: o link mostra "indisponível".':status==='encerrado'?'Questionário encerrado.':'Questionário reaberto.'};
 });
}

async function regenerateToken(a:Member,b:Row){
 return await db().tx(async tx=>{
  const q=await getQuiz(tx,b.id,true);
  if(q.status==='encerrado')throw new AppError('Questionário encerrado não pode ser alterado.',409);
  const token=newToken();
  const r=await tx.first('UPDATE quizzes SET token=?,rev=rev+1,updated_at=? WHERE id=? RETURNING rev',token,now(),q.id);
  await audit(tx,a,'Avaliações: link regerado',q.id as string,{title:q.title});
  return {id:q.id,rev:Number(r!.rev),token,path:'/q/'+token,message:'Link novo gerado. O link e o QR code antigos pararam de funcionar.'};
 });
}

const attemptRow=(r:Row,full=false)=>({id:r.id,quizId:r.quiz_id,quizTitle:r.quiz_title,version:Number(r.version),code:r.code,name:r.name,company:r.company,
 cpf:r.anonymized_at?'—':full?r.cpf:maskCpf(r.cpf),anonymizedAt:r.anonymized_at||null,anonymizedReason:full?r.anonymized_reason||null:undefined,consentVersion:r.consent_version==null?null:Number(r.consent_version),score:Number(r.score),correct:Number(r.correct_count),graded:Number(r.graded_count),minScore:Number(r.min_score),
 passed:Number(r.passed)===1,validUntil:r.valid_until||null,createdAt:r.created_at,...(full?{answers:r.answers,startedAt:r.started_at,userAgent:r.user_agent}:{})});

/** Filtros da lista de respostas (os mesmos valem para a exportação e o lote de comprovantes). */
function attemptFilter(p:URLSearchParams){
 const where:string[]=[],args:unknown[]=[];
 const qid=p.get('quiz');if(qid){where.push('a.quiz_id=?');args.push(text(qid,64));}
 const result=p.get('result');if(result==='aprovado')where.push('a.passed=1');else if(result==='reprovado')where.push('a.passed=0');
 const company=text(p.get('company'),120);if(company){where.push("a.company ILIKE ? ESCAPE '\\'");args.push('%'+company.replace(/[\\%_]/g,'\\$&')+'%');}
 const cpf=cpfDigits(p.get('cpf'));if(cpf){if(cpf.length!==11)throw new AppError('Informe o CPF completo para buscar.');where.push('a.cpf=?');args.push(cpf);}
 const from=p.get('from');if(from){where.push('a.created_at>=?');args.push(dayStart(isoDay(from)));}
 const to=p.get('to');if(to){const d=isoDay(to);where.push('a.created_at<?');args.push(dayStart(validUntilDay(d,1,'dias')));}
 return {sql:where.length?'WHERE '+where.join(' AND '):'',args,cpf,filters:{quiz:qid||null,result:result||null,company:company||null,cpf:cpf?maskCpf(cpf):null,from:from||null,to:to||null}};
}
export async function attemptsList(member:Member,url:URL){
 await access(member);
 const p=url.searchParams,{sql:sqlWhere,args,cpf}=attemptFilter(p);
 const page=Math.max(1,Math.floor(Number(p.get('page'))||1));
 const [rows,total]=await Promise.all([
  db().all(`SELECT a.*,q.title quiz_title FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id ${sqlWhere} ORDER BY a.created_at DESC,a.id DESC LIMIT ${PAGE} OFFSET ${(page-1)*PAGE}`,...args),
  db().first(`SELECT count(*)::int n,count(*) FILTER (WHERE a.passed=1)::int passed FROM quiz_attempts a ${sqlWhere}`,...args)]);
 if(cpf)await db().tx(tx=>audit(tx,member,'Avaliações: CPF consultado','cpf',{cpf:maskCpf(cpf)}));
 return {rows:rows.map(r=>attemptRow(r)),total:Number(total!.n),passed:Number(total!.passed),page,pages:Math.max(1,Math.ceil(Number(total!.n)/PAGE))};
}

export async function attemptDetail(member:Member,aid:string){
 await access(member);
 const r=await db().first('SELECT a.*,q.title quiz_title FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id WHERE a.id=?',text(aid,64));
 if(!r)throw new AppError('Tentativa não encontrada.',404);
 const history=r.cpf?await db().all('SELECT a.*,q.title quiz_title FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id WHERE a.cpf=? ORDER BY a.created_at DESC LIMIT 50',r.cpf):[r];
 await db().tx(tx=>audit(tx,member,'Avaliações: tentativa consultada',r.id as string,{code:r.code,quiz:r.quiz_title}));
 return {attempt:attemptRow(r,true),history:history.map(h=>attemptRow(h))};
}

// ───────────── Privacidade (LGPD) ─────────────
/** Troca nome, empresa, CPF, rede e textos livres; mantém nota, resultado e datas. */
async function anonymizeWhere(ex:Executor,where:string,args:unknown[],reason:string,by:string|null){
 return await ex.run(`UPDATE quiz_attempts a SET name=?,company=?,cpf='',ip_hash='',user_agent='',anonymized_at=?,anonymized_reason=?,anonymized_by=?,
   answers=(SELECT coalesce(jsonb_agg(CASE WHEN e->>'type'='texto' THEN jsonb_set(e,'{answer}','null'::jsonb) ELSE e END ORDER BY o),'[]'::jsonb) FROM jsonb_array_elements(a.answers) WITH ORDINALITY x(e,o))
  WHERE a.anonymized_at IS NULL AND ${where}`,ANON,ANON,now(),reason,by,...args);
}
async function anonymize(a:Member,b:Row){
 const cpf=cpfDigits(b.cpf);
 if(!validCpf(cpf))throw new AppError('Informe um CPF válido.',400,'CPF_INVALID','cpf');
 const reason=required(b.reason,'Motivo',300);
 if(reason.length<3)throw new AppError('Motivo: descreva o pedido (ex.: pedido do titular por e-mail).');
 return await db().tx(async tx=>{
  await tx.first('SELECT 1 ok FROM (SELECT pg_advisory_xact_lock(hashtext(?))) x','quiz-anon:'+cpf);
  const count=await anonymizeWhere(tx,'a.cpf=?',[cpf],reason,a.id);
  if(!count)throw new AppError('Nenhuma resposta com dados deste CPF.',404);
  await tx.run('DELETE FROM quiz_tickets WHERE cpf=?',cpf);
  await audit(tx,a,'Avaliações: dados anonimizados','cpf',{cpf:maskCpf(cpf),count,reason});
  return {count,message:`${count} resposta${count>1?'s':''} anonimizada${count>1?'s':''}. Nome, empresa, CPF e textos livres foram apagados; notas e datas ficam para estatística.`};
 });
}
/** Retenção: anonimiza as tentativas mais antigas que o prazo de cada questionário (rotina diária). */
export async function anonymizeExpired(){
 let total=0;
 for(const q of await db().all('SELECT id,retention_months FROM quizzes WHERE retention_months IS NOT NULL')){
  const cut=new Date();cut.setUTCMonth(cut.getUTCMonth()-Number(q.retention_months));
  total+=await db().tx(tx=>anonymizeWhere(tx,'a.quiz_id=? AND a.created_at<?',[q.id,cut.toISOString()],`Retenção automática (${q.retention_months} meses)`,null));
 }
 return total;
}

// ───────────── Exportação e comprovantes ─────────────
const fileHeaders=(type:string,name:string,inline=false)=>({'Content-Type':type,'Content-Disposition':`${inline?'inline':'attachment'}; filename="${name}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
const slug=(s:string)=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase().slice(0,60)||'avaliacao';
const pct=(n:number)=>`${Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2})}%`;
const when=(iso:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso)).replace(',','');
const optionText=(x:Row,idv:unknown)=>x.type==='texto'?String(idv??''):((x.options as Row[]|undefined)?.find(o=>o.id===idv)?.text as string)||'';

export async function quizExport(member:Member,url:URL){
 const a=await access(member),f=attemptFilter(url.searchParams);
 const format=url.searchParams.get('format')==='csv'?'csv':'xlsx',withAnswers=url.searchParams.get('answers')==='1';
 const n=Number((await db().first(`SELECT count(*)::int n FROM quiz_attempts a ${f.sql}`,...f.args))!.n);
 if(n>EXPORT_LIMIT)throw new AppError(`${n.toLocaleString('pt-BR')} respostas. Filtre por período ou questionário (limite de ${EXPORT_LIMIT.toLocaleString('pt-BR')}).`,413);
 const rows=await db().all(`SELECT a.*,q.title quiz_title FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id ${f.sql} ORDER BY a.created_at,a.id`,...f.args);
 const sheets:Sheet[]=[{name:'Tentativas',columns:['Data','Questionário','Versão','Nome','Empresa','CPF','Nota (%)','Acertos','Perguntas com nota','Nota mínima (%)','Resultado','Válida até','Comprovante','Termo aceito (versão)','Anonimizado em'],
  rows:rows.map(r=>[new Date(r.created_at),r.quiz_title,Number(r.version),r.name,r.company,r.cpf?formatCpf(r.cpf):'',Number(r.score),Number(r.correct_count),Number(r.graded_count),Number(r.min_score),
   Number(r.passed)===1?'Aprovado':'Reprovado',r.valid_until?dayText(r.valid_until):'',r.code,r.consent_version==null?'':Number(r.consent_version),r.anonymized_at?new Date(r.anonymized_at):''])}];
 if(withAnswers)sheets.push({name:'Respostas',columns:['Comprovante','Data','Questionário','Versão','Nome','CPF','Nº','Pergunta','Tipo','Resposta','Resposta certa','Acertou'],
  rows:rows.flatMap(r=>(r.answers as Row[]).map((x,i)=>[r.code,new Date(r.created_at),r.quiz_title,Number(r.version),r.name,r.cpf?formatCpf(r.cpf):'',i+1,x.text,
   x.type==='texto'?'Texto livre':x.type==='simnao'?'Sim ou não':'Múltipla escolha',optionText(x,x.answer),x.type==='texto'?'':optionText(x,x.correct),x.isCorrect==null?'':x.isCorrect?'Sim':'Não']))});
 await db().tx(tx=>audit(tx,a,'Avaliações: exportação',a.id,{format,answers:withAnswers,filters:f.filters,rows:rows.length}));
 const base=`avaliacoes_${brDay(Date.now())}`;
 if(format==='xlsx')return new Response(new Uint8Array(xlsx(sheets)),{headers:fileHeaders('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',base+'.xlsx')});
 if(sheets.length===1)return new Response(csv(sheets[0]),{headers:fileHeaders('text/csv; charset=utf-8',base+'.csv')});
 return new Response(new Uint8Array(zip([{name:'tentativas.csv',data:csv(sheets[0])},{name:'respostas.csv',data:csv(sheets[1])}])),{headers:fileHeaders('application/zip',base+'.zip')});
}

const fill=(tpl:string,v:Record<string,string>)=>tpl.replace(/\{(\w+)\}/g,(m,k)=>k in v?v[k]:m);
function certificateData(q:Row,r:Row,versionTitle:string):CertificateData{
 const passed=Number(r.passed)===1,anon=!!r.anonymized_at;
 const vars:Record<string,string>={nome:r.name,empresa:r.company,cpf:anon?'—':formatCpf(r.cpf),questionario:versionTitle,versao:String(r.version),data:when(r.created_at),
  nota:pct(Number(r.score)),minimo:pct(Number(r.min_score)),resultado:passed?'Aprovado':'Reprovado',validade:r.valid_until?dayText(r.valid_until):'—',codigo:r.code};
 return {title:fill(q.pdf_title,vars),body:fill(q.pdf_body,vars),footer:fill(q.pdf_footer,vars),passed,validUntil:r.valid_until?dayText(r.valid_until):null,code:r.code,issuedAt:when(now()),
  logo:q.pdf_logo?{bytes:new Uint8Array(q.pdf_logo as Buffer),type:q.pdf_logo_type}:null,
  facts:[['Nome',r.name],['Empresa',r.company],['CPF',vars.cpf],['Avaliação',`${versionTitle} (versão ${r.version})`],['Data',vars.data],
   ['Nota',`${vars.nota} (${r.correct_count} de ${r.graded_count}) · mínimo ${vars.minimo}`],['Resultado',vars.resultado],['Válida até',passed?vars.validade:'—']]};
}
const ATTEMPT_SELECT='SELECT a.*,v.title version_title FROM quiz_attempts a JOIN quiz_versions v ON v.quiz_id=a.quiz_id AND v.version=a.version';

export async function quizPdf(member:Member,aid:string){
 const a=await access(member);
 const r=await db().first(`${ATTEMPT_SELECT} WHERE a.id=?`,text(aid,64));
 if(!r)throw new AppError('Tentativa não encontrada.',404);
 const q=await getQuiz(db(),r.quiz_id);
 const pdf=await certificatePdf(certificateData(q,r,r.version_title));
 await db().tx(tx=>audit(tx,a,'Avaliações: comprovante emitido',r.id as string,{code:r.code}));
 return new Response(new Uint8Array(pdf),{headers:fileHeaders('application/pdf',`comprovante-${r.code}.pdf`,true)});
}
/** Exemplo do modelo, com dados fictícios (para conferir logotipo e textos antes de usar). */
export async function quizPdfSample(member:Member,qid:string){
 await access(member);
 const q=await getQuiz(db(),qid),t=now();
 const sample={name:'Nome do Visitante',company:'Empresa do Visitante',cpf:'00000000000',anonymized_at:t,version:Math.max(1,Number(q.published_version)),created_at:t,score:100,min_score:q.min_score,
  correct_count:5,graded_count:5,passed:1,valid_until:validUntilDay(brDay(t),Number(q.validity_amount),q.validity_unit),code:'EXEMPLO0'};
 const pdf=await certificatePdf(certificateData(q,sample,q.title));
 return new Response(new Uint8Array(pdf),{headers:fileHeaders('application/pdf','comprovante-exemplo.pdf',true)});
}
export async function quizPdfZip(member:Member,url:URL){
 const a=await access(member),f=attemptFilter(url.searchParams);
 const n=Number((await db().first(`SELECT count(*)::int n FROM quiz_attempts a ${f.sql}`,...f.args))!.n);
 if(!n)throw new AppError('Nenhuma resposta com estes filtros.',404);
 if(n>PDF_BATCH_LIMIT)throw new AppError(`${n.toLocaleString('pt-BR')} respostas. Filtre para até ${PDF_BATCH_LIMIT} comprovantes por arquivo.`,413);
 const rows=await db().all(`${ATTEMPT_SELECT} ${f.sql} ORDER BY a.created_at,a.id`,...f.args);
 const quizzes=new Map<string,Row>(),files:{name:string,data:Uint8Array}[]=[];
 for(const r of rows){
  if(!quizzes.has(r.quiz_id))quizzes.set(r.quiz_id,await getQuiz(db(),r.quiz_id));
  files.push({name:`${slug(r.name)}-${r.code}.pdf`,data:await certificatePdf(certificateData(quizzes.get(r.quiz_id)!,r,r.version_title))});
 }
 await db().tx(tx=>audit(tx,a,'Avaliações: comprovantes em lote',a.id,{filters:f.filters,count:files.length}));
 return new Response(new Uint8Array(zip(files)),{headers:fileHeaders('application/zip',`comprovantes_${brDay(Date.now())}.zip`)});
}

// ───────────── Logotipo do comprovante ─────────────
export const MAX_LOGO=524288;
export async function uploadQuizLogo(member:Member,params:URLSearchParams,body:Uint8Array){
 const a=await access(member);
 if(!body.byteLength)throw new AppError('Arquivo vazio.');
 if(body.byteLength>MAX_LOGO)throw new AppError('Logotipo acima de 512 KB. Use uma imagem menor.',413);
 const type=body[0]===0x89&&body[1]===0x50&&body[2]===0x4e&&body[3]===0x47?'image/png':body[0]===0xff&&body[1]===0xd8&&body[2]===0xff?'image/jpeg':null;
 if(!type)throw new AppError('Envie uma imagem PNG ou JPG.',400);
 try{const {PDFDocument}=await import('pdf-lib');const doc=await PDFDocument.create();if(type==='image/png')await doc.embedPng(body);else await doc.embedJpg(body);}
 catch{throw new AppError('Não foi possível ler esta imagem. Salve de novo como PNG ou JPG.',400);}
 return await db().tx(async tx=>{
  const q=await getQuiz(tx,params.get('id'),true);
  if(q.status==='encerrado')throw new AppError('Questionário encerrado não pode ser alterado.',409);
  const r=await tx.first('UPDATE quizzes SET pdf_logo=?,pdf_logo_type=?,rev=rev+1,updated_at=? WHERE id=? RETURNING rev',Buffer.from(body),type,now(),q.id);
  await audit(tx,a,'Avaliações: logotipo do comprovante',q.id as string,{title:q.title,type,size:body.byteLength});
  return {id:q.id,rev:Number(r!.rev),message:'Logotipo salvo.'};
 });
}
export async function quizLogo(member:Member,qid:string){
 await access(member);
 const q=await db().first('SELECT pdf_logo,pdf_logo_type FROM quizzes WHERE id=?',text(qid,64));
 if(!q?.pdf_logo)return new Response(Buffer.from(DEFAULT_LOGO_PNG,'base64'),{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 return new Response(new Uint8Array(q.pdf_logo as Buffer),{headers:{'Content-Type':q.pdf_logo_type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
async function removeLogo(a:Member,b:Row){
 return await db().tx(async tx=>{
  const q=await getQuiz(tx,b.id,true);
  const r=await tx.first('UPDATE quizzes SET pdf_logo=NULL,pdf_logo_type=NULL,rev=rev+1,updated_at=? WHERE id=? RETURNING rev',now(),q.id);
  await audit(tx,a,'Avaliações: logotipo do comprovante removido',q.id as string,{title:q.title});
  return {id:q.id,rev:Number(r!.rev),message:'Logotipo removido: o comprovante usa o logotipo padrão.'};
 });
}

export async function quizGet(path:string,url:URL,member:Member):Promise<unknown>{
 switch(path){
  case 'quiz/list':return quizList(member);
  case 'quiz/detail':return quizDetail(member,url.searchParams.get('id')||'');
  case 'quiz/attempts':return attemptsList(member,url);
  case 'quiz/attempt':return attemptDetail(member,url.searchParams.get('id')||'');
 }
 throw new AppError('Página não encontrada.',404);
}
export async function quizMutate(path:string,b:Row,member:Member):Promise<unknown>{
 const a=await access(member);
 if(path==='quiz/save')return saveQuiz(a,b);
 if(path==='quiz/publish')return publishQuiz(a,b);
 if(path==='quiz/status')return setStatus(a,b);
 if(path==='quiz/regenerate-token')return regenerateToken(a,b);
 if(path==='quiz/anonymize')return anonymize(a,b);
 if(path==='quiz/logo-remove')return removeLogo(a,b);
 throw new AppError('Ação não encontrada.',404);
}
