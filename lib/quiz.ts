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

const TZ='America/Sao_Paulo';
const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
/** Tempo mínimo entre a etapa do CPF e o envio, e validade do bilhete. */
export const MIN_SECONDS=5,TICKET_HOURS=6;
const PAGE=30;

export type QuestionType='multipla'|'simnao'|'texto';
export type Question={id:string,type:QuestionType,text:string,required:boolean,options:{id:string,text:string}[],correct:string|null};
const YES_NO=[{id:'sim',text:'Sim'},{id:'nao',text:'Não'}];
const DETAILS=['resultado','nota','erradas'] as const;
const STATUS_NAME:Record<string,string>={rascunho:'Rascunho',publicado:'Publicado',pausado:'Pausado',encerrado:'Encerrado'};

// ───────────── Regras puras ─────────────
export const cpfDigits=(v:unknown)=>String(v??'').replace(/\D/g,'');
export function validCpf(d:string){
 if(!/^\d{11}$/.test(d)||/^(\d)\1{10}$/.test(d))return false;
 const n=d.split('').map(Number);
 for(const len of [9,10]){const s=n.slice(0,len).reduce((t,x,i)=>t+x*(len+1-i),0);if((s*10)%11%10!==n[len])return false;}
 return true;
}
export const maskCpf=(d:string)=>/^\d{11}$/.test(d)?`***.${d.slice(3,6)}.${d.slice(6,9)}-**`:'***';
export const formatCpf=(d:string)=>/^\d{11}$/.test(d)?`${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`:d;
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
  validity:{amount:Number(q.validity_amount),unit:q.validity_unit},companies:companies.map(c=>c.company as string)}};
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
 const p=person(b),s=await cpfState(db(),q,p.cpf);
 blockIfNeeded(q,s);
 const ticket=newToken();
 await db().run('INSERT INTO quiz_tickets(id,quiz_id,cpf,issued_at) VALUES(?,?,?,?)',ticket,q.id,p.cpf,now());
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
  const row=await tx.first(`INSERT INTO quiz_attempts(id,quiz_id,version,code,submit_key,cpf,name,company,answers,correct_count,graded_count,score,min_score,passed,valid_until,ip_hash,user_agent,started_at,created_at)
   VALUES(?,?,?,?,?,?,?,?,?::text::jsonb,?,?,?,?,?,?,?,?,?,?) RETURNING *`,id(),q.id,version,code,submitKey,p.cpf,p.name,p.company,JSON.stringify(g.snapshot),
   g.correct,g.graded,score,Number(q.min_score),passed?1:0,validUntil,String(meta.ipHash||'').slice(0,64),String(meta.userAgent||'').slice(0,200),started,at);
  await tx.run('UPDATE quiz_tickets SET used_at=? WHERE id=?',at,t.id);
  return resultOf(q,row!,s.today+1);
 });
}

// ───────────── Telas internas (acesso Avaliações) ─────────────
const access=async(m:Member)=>await requireAny(m,['avaliacoes']);
const int=(v:unknown,label:string,min:number,max:number)=>{const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw new AppError(`${label}: informe um número inteiro de ${min} a ${max}.`);return n;};
const quizRow=(q:Row)=>({id:q.id,token:q.token,path:'/q/'+q.token,status:q.status,statusName:STATUS_NAME[q.status],title:q.title,intro:q.intro,questions:q.questions,
 publishedVersion:Number(q.published_version),validityAmount:Number(q.validity_amount),validityUnit:q.validity_unit,minScore:Number(q.min_score),
 dailyLimit:Number(q.daily_limit),resultDetail:q.result_detail,shuffle:Number(q.shuffle)===1,closedMessage:q.closed_message,rev:Number(q.rev),updatedAt:q.updated_at});
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
  const t=now(),values=[title,intro,JSON.stringify(questions),amount,unit,minScore,dailyLimit,detail,shuffleFlag,closed];
  if(old){
   const r=await tx.first(`UPDATE quizzes SET title=?,intro=?,questions=?::text::jsonb,validity_amount=?,validity_unit=?,min_score=?,daily_limit=?,result_detail=?,shuffle=?,closed_message=?,rev=rev+1,updated_at=? WHERE id=? RETURNING rev`,...values,t,old.id);
   await audit(tx,a,'Avaliações: questionário atualizado',old.id as string,{title,questions:questions.length,validity:`${amount} ${unit}`,minScore,dailyLimit,resultDetail:detail});
   return {id:old.id as string,rev:Number(r!.rev),message:'Questionário salvo.'};
  }
  const qid=id();
  await tx.run(`INSERT INTO quizzes(id,token,title,intro,questions,validity_amount,validity_unit,min_score,daily_limit,result_detail,shuffle,closed_message,create_key,created_by,created_at,updated_at)
   VALUES(?,?,?,?,?::text::jsonb,?,?,?,?,?,?,?,?,?,?,?)`,qid,newToken(),...values,opKey,a.id,t,t);
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
 cpf:full?r.cpf:maskCpf(r.cpf),score:Number(r.score),correct:Number(r.correct_count),graded:Number(r.graded_count),minScore:Number(r.min_score),
 passed:Number(r.passed)===1,validUntil:r.valid_until||null,createdAt:r.created_at,...(full?{answers:r.answers,startedAt:r.started_at,userAgent:r.user_agent}:{})});

export async function attemptsList(member:Member,url:URL){
 await access(member);
 const p=url.searchParams,where:string[]=[],args:unknown[]=[];
 const qid=p.get('quiz');if(qid){where.push('a.quiz_id=?');args.push(text(qid,64));}
 const result=p.get('result');if(result==='aprovado')where.push('a.passed=1');else if(result==='reprovado')where.push('a.passed=0');
 const company=text(p.get('company'),120);if(company){where.push("a.company ILIKE ? ESCAPE '\\'");args.push('%'+company.replace(/[\\%_]/g,'\\$&')+'%');}
 const cpf=cpfDigits(p.get('cpf'));if(cpf){if(cpf.length!==11)throw new AppError('Informe o CPF completo para buscar.');where.push('a.cpf=?');args.push(cpf);}
 const from=p.get('from');if(from){where.push('a.created_at>=?');args.push(dayStart(isoDay(from)));}
 const to=p.get('to');if(to){const d=isoDay(to);where.push('a.created_at<?');args.push(dayStart(validUntilDay(d,1,'dias')));}
 const page=Math.max(1,Math.floor(Number(p.get('page'))||1));
 const sqlWhere=where.length?'WHERE '+where.join(' AND '):'';
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
 const history=await db().all('SELECT a.*,q.title quiz_title FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id WHERE a.cpf=? ORDER BY a.created_at DESC LIMIT 50',r.cpf);
 await db().tx(tx=>audit(tx,member,'Avaliações: tentativa consultada',r.id as string,{code:r.code,quiz:r.quiz_title}));
 return {attempt:attemptRow(r,true),history:history.map(h=>attemptRow(h))};
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
 throw new AppError('Ação não encontrada.',404);
}
