// Avaliações · fase B: termo de consentimento versionado, anonimização (a pedido e por retenção),
// exportação Excel/CSV, comprovante em PDF (um e em lote) e logotipo do modelo.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {PDFDocument} from 'pdf-lib';
import {quizGet,quizMutate,publicQuiz,publicCheck,publicSubmit,anonymizeExpired,quizExport,quizPdf,quizPdfZip,quizPdfZipIds,uploadQuizLogo,PDF_BATCH_LIMIT} from '../lib/quiz';
import {type Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,evaluator:Member,operator:Member;
const key=()=>crypto.randomUUID();
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const rejects=(p:Promise<unknown>,status:number,code?:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);if(code)assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,profile:string,caps:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
function cpf(seed:number){const d=String(100000000+seed).slice(-9).split('').map(Number);for(const n of [9,10]){const s=d.reduce((t,x,i)=>t+x*(n+1-i),0);d.push((s*10)%11%10);}return d.join('');}
const meta={ipHash:'ip_test',userAgent:'teste'};
const QUESTIONS=[
 {id:'q1',type:'multipla',text:'Cor do capacete?',required:true,options:[{id:'a',text:'Branco'},{id:'b',text:'Azul'}],correct:'b'},
 {id:'q3',type:'texto',text:'Comentários',required:false},
];
async function published(b:Row={}){
 const q=await quizMutate('quiz/save',{idempotencyKey:key(),title:'Integração',questions:QUESTIONS,minScore:100,dailyLimit:5,...b},evaluator) as Row;
 const d=await quizGet('quiz/detail',url({id:q.id}),evaluator) as Row;
 await quizMutate('quiz/publish',{id:q.id,rev:d.quiz.rev},evaluator);
 return {id:q.id as string,token:d.quiz.token as string};
}
async function answer(token:string,doc:string,answers:Row,name='Maria da Silva'){
 const page=await publicQuiz(token) as Row,person={cpf:doc,name,company:'Empresa X',consent:true,consentVersion:page.quiz.consent.version};
 const c=await publicCheck(token,person) as Row;
 await db.run('UPDATE quiz_tickets SET issued_at=? WHERE id=?',new Date(Date.now()-60_000).toISOString(),c.ticket);
 return await publicSubmit(token,{...person,ticket:c.ticket,submitKey:key(),version:page.quiz.version,answers},meta) as Row;
}
const RIGHT={q1:'b',q3:'Meu telefone é 9999'},WRONG={q1:'a'};
const bytes=async(r:Response)=>new Uint8Array(await r.arrayBuffer());
/** Nomes dos arquivos de um .zip (diretório central). */
function zipNames(b:Uint8Array){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);const names:string[]=[];for(let i=0;i<b.length-4;i++)if(v.getUint32(i,true)===0x02014b50){const n=v.getUint16(i+28,true);names.push(new TextDecoder().decode(b.slice(i+46,i+46+n)));}return names;}
function zipFile(b:Uint8Array,name:string){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);for(let i=0;i<b.length-4;i++)if(v.getUint32(i,true)===0x04034b50){const size=v.getUint32(i+18,true),n=v.getUint16(i+26,true),e=v.getUint16(i+28,true);if(new TextDecoder().decode(b.slice(i+30,i+30+n))===name)return new TextDecoder().decode(inflateRawSync(b.slice(i+30+n+e,i+30+n+e+size)));}return '';}

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 evaluator=await set(await addMember(db,'operator'),'operator',['avaliacoes']);
 operator=await set(await addMember(db,'operator'),'operator',[]);
});
after(async()=>{await ctx.drop();});

test('termo: aceite obrigatório, versão gravada na tentativa e nova versão ao mudar o texto',async()=>{
 const {id,token}=await published();
 const page=await publicQuiz(token) as Row;
 assert.equal(page.quiz.consent.version,1);assert.ok(page.quiz.consent.text.length>20);
 await rejects(publicCheck(token,{cpf:cpf(1),name:'Ana Lima',company:'X'}),400,'CONSENT');
 const r=await answer(token,cpf(1),RIGHT);assert.equal(r.passed,true);
 const row=await db.first('SELECT consent_version,consent_at FROM quiz_attempts WHERE code=?',r.code);
 assert.equal(row!.consent_version,1);assert.ok(row!.consent_at);
 const d=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 await quizMutate('quiz/save',{id,rev:d.quiz.rev,consentText:'Novo termo: autorizo o registro dos meus dados para esta avaliação.'},evaluator);
 const again=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 assert.equal(again.quiz.consentVersion,2);
 assert.equal((await db.first('SELECT count(*)::int n FROM quiz_consents WHERE quiz_id=?',id))!.n,2);
 await rejects(publicCheck(token,{cpf:cpf(2),name:'Ana Lima',company:'X',consent:true,consentVersion:1}),409,'CONSENT');
 assert.equal((await answer(token,cpf(2),WRONG)).passed,false);
});

test('anonimizar a pedido: troca dados pessoais em todos os questionários, mantém nota; só com o acesso',async()=>{
 const a=await published(),b=await published();
 const doc=cpf(10);
 const r1=await answer(a.token,doc,RIGHT),r2=await answer(b.token,doc,WRONG);
 await rejects(quizMutate('quiz/anonymize',{cpf:doc,reason:'Pedido do titular'},operator),403);
 await rejects(quizMutate('quiz/anonymize',{cpf:doc,reason:''},evaluator),400);
 const res=await quizMutate('quiz/anonymize',{cpf:doc,reason:'Pedido do titular por e-mail'},evaluator) as Row;
 assert.equal(res.count,2);
 const rows=await db.all('SELECT * FROM quiz_attempts WHERE code IN (?,?) ORDER BY code',r1.code,r2.code);
 for(const x of rows){assert.equal(x.name,'Anonimizado');assert.equal(x.cpf,'');assert.equal(x.company,'Anonimizado');assert.ok(x.anonymized_at);assert.equal(x.ip_hash,'');}
 const pass=rows.find(x=>x.code===r1.code)!;assert.equal(Number(pass.score),100);
 assert.equal((pass.answers as Row[]).find(x=>x.type==='texto')!.answer,null,'texto livre apagado');
 assert.equal((await db.first('SELECT count(*)::int n FROM quiz_attempts WHERE cpf=?',doc))!.n,0);
 assert.equal((await db.first("SELECT count(*)::int n FROM audits WHERE action='Avaliações: dados anonimizados'"))!.n,1);
 await rejects(quizMutate('quiz/anonymize',{cpf:doc,reason:'De novo'},evaluator),404);
 await assert.rejects(db.run("UPDATE quiz_attempts SET score=0 WHERE code=?",r1.code),/não podem ser alterados/);
 await assert.rejects(db.run("DELETE FROM quiz_attempts WHERE code=?",r1.code),/não podem ser alterados/);
});

test('retenção: anonimiza automaticamente o que passou do prazo',async()=>{
 const {id,token}=await published();
 const d=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 await quizMutate('quiz/save',{id,rev:d.quiz.rev,retentionMonths:12},evaluator);
 const old=await answer(token,cpf(20),RIGHT),fresh=await answer(token,cpf(21),RIGHT);
 await db.run('ALTER TABLE quiz_attempts DISABLE TRIGGER quiz_attempts_guard');
 await db.run('UPDATE quiz_attempts SET created_at=? WHERE code=?',new Date(Date.now()-400*86400_000).toISOString(),old.code);
 await db.run('ALTER TABLE quiz_attempts ENABLE TRIGGER quiz_attempts_guard');
 assert.ok(await anonymizeExpired()>=1);
 assert.equal((await db.first('SELECT name FROM quiz_attempts WHERE code=?',old.code))!.name,'Anonimizado');
 assert.equal((await db.first('SELECT name FROM quiz_attempts WHERE code=?',fresh.code))!.name,'Maria da Silva');
 assert.match((await db.first('SELECT anonymized_reason FROM quiz_attempts WHERE code=?',old.code))!.anonymized_reason,/Retenção/);
});

test('exportação Excel e CSV com filtros, CPF completo e respostas; fica na auditoria',async()=>{
 const {id,token}=await published();
 await answer(token,cpf(30),RIGHT,'Carlos Pereira');await answer(token,cpf(31),WRONG,'Paula Reis');
 const x=await quizExport(evaluator,url({quiz:id,format:'xlsx',answers:'1'}));
 assert.match(x.headers.get('Content-Type')!,/spreadsheetml/);
 const xb=await bytes(x);assert.ok(zipNames(xb).some(n=>n.startsWith('xl/worksheets/sheet2')),'aba de respostas');
 const c=await quizExport(evaluator,url({quiz:id,format:'csv',result:'aprovado'}));
 assert.match(c.headers.get('Content-Type')!,/text\/csv/);
 const text=await c.text();
 assert.ok(text.includes('Carlos Pereira')&&!text.includes('Paula Reis'));
 const doc=cpf(30);assert.ok(text.includes(`${doc.slice(0,3)}.${doc.slice(3,6)}.${doc.slice(6,9)}-${doc.slice(9)}`),'CPF completo na exportação');
 const z=await quizExport(evaluator,url({quiz:id,format:'csv',answers:'1'}));
 assert.match(z.headers.get('Content-Type')!,/zip/);
 const zb=await bytes(z);assert.deepEqual(zipNames(zb).sort(),['respostas.csv','tentativas.csv']);
 assert.ok(zipFile(zb,'respostas.csv').includes('Cor do capacete?'));
 await rejects(quizExport(operator,url({format:'csv'})),403);
 assert.ok((await db.first("SELECT count(*)::int n FROM audits WHERE action='Avaliações: exportação'"))!.n>=3);
});

test('comprovante em PDF: um por tentativa e em lote (ZIP); modelo com logotipo',async()=>{
 const {id,token}=await published();
 const r=await answer(token,cpf(40),RIGHT,'Lúcia Araújo');await answer(token,cpf(41),WRONG,'João Gonçalves');
 const list=await quizGet('quiz/attempts',url({quiz:id}),evaluator) as Row;
 const one=await quizPdf(evaluator,list.rows.find((x:Row)=>x.code===r.code).id);
 assert.equal(one.headers.get('Content-Type'),'application/pdf');
 const pdf=await bytes(one);assert.equal(new TextDecoder().decode(pdf.slice(0,5)),'%PDF-');
 const z=await quizPdfZip(evaluator,url({quiz:id}));
 const names=zipNames(await bytes(z));assert.equal(names.length,2);assert.ok(names.every(n=>n.endsWith('.pdf')));
 assert.ok(PDF_BATCH_LIMIT>=100);
 await rejects(uploadQuizLogo(evaluator,new URLSearchParams({id}),new TextEncoder().encode('<svg/>')),400);
 const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64'));
 await uploadQuizLogo(evaluator,new URLSearchParams({id}),png);
 assert.equal((await db.first('SELECT pdf_logo_type FROM quizzes WHERE id=?',id))!.pdf_logo_type,'image/png');
 assert.equal(new TextDecoder().decode((await bytes(await quizPdf(evaluator,list.rows[0].id))).slice(0,5)),'%PDF-');
 const d=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 assert.equal(d.quiz.hasLogo,true);
 await quizMutate('quiz/logo-remove',{id},evaluator);
 assert.equal((await db.first('SELECT pdf_logo FROM quizzes WHERE id=?',id))!.pdf_logo,null);
 await rejects(quizPdf(operator,list.rows[0].id),403);
});

test('busca por nome: parte do nome, sem diferença de maiúsculas e acentos',async()=>{
 const {id,token}=await published();
 await answer(token,cpf(50),RIGHT,'João Gonçalves');await answer(token,cpf(51),RIGHT,'Maria Souza');
 const r=await quizGet('quiz/attempts',url({quiz:id,name:'joao GON'}),evaluator) as Row;
 assert.deepEqual(r.rows.map((x:Row)=>x.name),['João Gonçalves']);
 const none=await quizGet('quiz/attempts',url({quiz:id,name:'100%_'}),evaluator) as Row;
 assert.equal(none.total,0,'curingas do LIKE são texto comum');
});

test('ZIP só das selecionadas; com respostas, o PDF traz as perguntas e cresce em páginas',async()=>{
 const many=Array.from({length:40},(_,i)=>({id:'m'+i,type:'multipla',text:`Pergunta longa número ${i+1} sobre as regras de segurança da base, com texto suficiente para ocupar mais de uma linha no PDF?`,required:true,options:[{id:'a',text:'Certa'},{id:'b',text:'Errada'}],correct:'a'}));
 const {id,token}=await published({questions:many,minScore:50});
 const all=Object.fromEntries(many.map((q,i)=>[q.id,i%3?'a':'b']));
 const r1=await answer(token,cpf(60),all,'Ana Lima'),r2=await answer(token,cpf(61),all,'Bruno Reis'),r3=await answer(token,cpf(62),all,'Carla Dias');
 const list=await quizGet('quiz/attempts',url({quiz:id}),evaluator) as Row;
 const idOf=(code:string)=>list.rows.find((x:Row)=>x.code===code).id as string;
 const z=await quizPdfZipIds(evaluator,[idOf(r1.code),idOf(r3.code)],false);
 assert.deepEqual(zipNames(await bytes(z)).sort(),[`ana-lima-${r1.code}.pdf`,`carla-dias-${r3.code}.pdf`]);
 await rejects(quizPdfZipIds(evaluator,[],false),400);
 await rejects(quizPdfZipIds(evaluator,['x'.repeat(10)],false),404);
 await rejects(quizPdfZipIds(evaluator,Array.from({length:PDF_BATCH_LIMIT+1},(_,i)=>'id'+i),false),413);
 await rejects(quizPdfZipIds(operator,[idOf(r2.code)],false),403);
 const plain=await PDFDocument.load(await bytes(await quizPdf(evaluator,idOf(r2.code))));
 const full=await PDFDocument.load(await bytes(await quizPdf(evaluator,idOf(r2.code),true)));
 assert.equal(plain.getPageCount(),1);assert.ok(full.getPageCount()>=2,'40 perguntas ocupam mais de uma página');
 const zf=await quizPdfZip(evaluator,url({quiz:id,answers:'1'}));
 assert.equal(zipNames(await bytes(zf)).length,3);
});

test('conteúdo programático: versionado, no passo 1, no Excel e no PDF',async()=>{
 const syllabus='1. Regras de ouro\n2. EPIs obrigatórios\n3. Permissão de trabalho';
 const {id,token}=await published({syllabus});
 const d=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 assert.equal(d.quiz.syllabus,syllabus);
 assert.equal((await publicQuiz(token) as Row).quiz.syllabus,syllabus);
 const r=await answer(token,cpf(70),RIGHT,'Rita Melo');
 // Mudar o conteúdo sem publicar não muda a página nem o que a resposta guardou.
 await quizMutate('quiz/save',{id,rev:d.quiz.rev,syllabus:'Conteúdo novo'},evaluator);
 assert.equal((await publicQuiz(token) as Row).quiz.syllabus,syllabus);
 const after=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 assert.equal(after.quiz.dirty,true,'conteúdo diferente da versão publicada pede nova publicação');
 const c=await quizExport(evaluator,url({quiz:id,format:'csv'}));
 const text=await c.text();
 assert.ok(text.includes('Conteúdo programático'));assert.ok(text.includes('Regras de ouro'));assert.ok(!text.includes('Conteúdo novo'));
 const list=await quizGet('quiz/attempts',url({quiz:id}),evaluator) as Row;
 const pdf=await PDFDocument.load(await bytes(await quizPdf(evaluator,list.rows.find((x:Row)=>x.code===r.code).id)));
 assert.equal(pdf.getPageCount(),1);
 await quizMutate('quiz/publish',{id,rev:after.quiz.rev},evaluator);
 assert.equal((await publicQuiz(token) as Row).quiz.syllabus,'Conteúdo novo');
 await rejects(quizMutate('quiz/save',{id,rev:(await quizGet('quiz/detail',url({id}),evaluator) as Row).quiz.rev,syllabus:'x'.repeat(4001)},evaluator),400);
});

test('PDF: quebras de linha viram linhas, não "?"',async()=>{
 const {sanitizeFor}=await import('../lib/quiz-pdf');
 const ok=new Set(Array.from({length:95},(_,i)=>i+32));
 assert.equal(sanitizeFor(ok)('1. Regras\n2. EPIs\r\n3. PT'),'1. Regras\n2. EPIs\n3. PT');
 assert.equal(sanitizeFor(ok)('seta → fim'),'seta ? fim');
});
