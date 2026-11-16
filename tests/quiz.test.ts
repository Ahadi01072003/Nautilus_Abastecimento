// Avaliações por QR code · fase A: CPF, versões, link público, correção no servidor, validade por CPF,
// refazer até passar com limite diário, idempotência, gabarito fora da página pública e acesso.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {quizGet,quizMutate,publicQuiz,publicCheck,publicSubmit,validCpf,maskCpf,validUntilDay,brDay} from '../lib/quiz';
import {modules,type Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,evaluator:Member,operator:Member;
const key=()=>crypto.randomUUID();
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const rejects=(p:Promise<unknown>,status:number,code?:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);if(code)assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,profile:string,caps:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
/** CPF válido a partir de 9 dígitos. */
function cpf(seed:number){const d=String(100000000+seed).slice(-9).split('').map(Number);for(const n of [9,10]){const s=d.reduce((t,x,i)=>t+x*(n+1-i),0);d.push((s*10)%11%10);}return d.join('');}
const meta={ipHash:'ip_test',userAgent:'teste'};
const QUESTIONS=[
 {id:'q1',type:'multipla',text:'Cor do capacete do visitante?',required:true,options:[{id:'a',text:'Branco'},{id:'b',text:'Azul'},{id:'c',text:'Verde'}],correct:'b'},
 {id:'q2',type:'simnao',text:'Pode fumar na área?',required:true,correct:'nao'},
 {id:'q3',type:'texto',text:'Comentários',required:false},
];
const save=(b:Row,who:Member=evaluator)=>quizMutate('quiz/save',{idempotencyKey:key(),...b},who) as Promise<Row>;
async function published(b:Row={}){
 const q=await save({title:'Integração de visitantes',intro:'Leia antes.',questions:QUESTIONS,validityAmount:12,validityUnit:'meses',minScore:100,dailyLimit:2,resultDetail:'erradas',...b});
 const d=await quizGet('quiz/detail',url({id:q.id}),evaluator) as Row;
 await quizMutate('quiz/publish',{id:q.id,rev:d.quiz.rev},evaluator);
 return {id:q.id as string,token:d.quiz.token as string};
}
/** Passa pela etapa do CPF e envia (o bilhete é envelhecido para cumprir o tempo mínimo). */
async function answer(token:string,doc:string,answers:Row,extra:Row={}){
 const person={cpf:doc,name:'Maria da Silva',company:'Empresa X'};
 const c=await publicCheck(token,person) as Row;
 await db.run('UPDATE quiz_tickets SET issued_at=? WHERE id=?',new Date(Date.now()-60_000).toISOString(),c.ticket);
 const page=await publicQuiz(token) as Row;
 return await publicSubmit(token,{...person,ticket:c.ticket,submitKey:key(),version:page.quiz.version,answers,...extra},meta) as Row;
}
const RIGHT={q1:'b',q2:'nao',q3:'Tudo certo'},WRONG={q1:'a',q2:'nao'};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 evaluator=await set(await addMember(db,'operator'),'operator',['avaliacoes']);
 operator=await set(await addMember(db,'operator'),'operator',[]);
});
after(async()=>{await ctx.drop();});

test('CPF: dígitos verificadores, repetidos recusados e máscara',()=>{
 assert.ok(validCpf('52998224725'));assert.ok(validCpf(cpf(1)));
 assert.ok(!validCpf('52998224724'));assert.ok(!validCpf('11111111111'));assert.ok(!validCpf('123'));
 assert.equal(maskCpf('52998224725'),'***.982.247-**');
});

test('validade: meses somam no calendário e dias somam dias',()=>{
 assert.equal(validUntilDay('2026-11-16',12,'meses'),'2027-11-16');
 assert.equal(validUntilDay('2027-01-31',1,'meses'),'2027-02-28');
 assert.equal(validUntilDay('2026-11-16',30,'dias'),'2026-12-16');
});

test('acesso: Avaliações e Gestão entram; outros não; módulo aparece no menu',async()=>{
 await quizGet('quiz/list',url(),evaluator);await quizGet('quiz/list',url(),manager);
 await rejects(quizGet('quiz/list',url(),operator),403);
 await rejects(quizMutate('quiz/save',{title:'x'},operator),403);
 assert.ok(modules(evaluator).includes('ava-questionarios'));assert.ok(modules(manager).includes('ava-respostas'));
 assert.ok(!modules(operator).includes('ava-questionarios'));
});

test('rascunho e publicação: link indisponível até publicar; publicar exige gabarito completo',async()=>{
 const q=await save({title:'Rascunho',questions:[{id:'x',type:'multipla',text:'Sem certa',options:[{id:'a',text:'A'},{id:'b',text:'B'}]}]});
 const d=await quizGet('quiz/detail',url({id:q.id}),evaluator) as Row;
 assert.equal((await publicQuiz(d.quiz.token) as Row).status,'indisponivel');
 await rejects(quizMutate('quiz/publish',{id:q.id,rev:d.quiz.rev},evaluator),400);
 const again=await save({idempotencyKey:'repetida-1',title:'Mesmo envio'});const twice=await save({idempotencyKey:'repetida-1',title:'Mesmo envio'});
 assert.equal(again.id,twice.id,'mesma chave devolve o mesmo questionário');
});

test('página pública sem gabarito; aprovado recebe validade e o CPF fica bloqueado com a data',async()=>{
 const {token}=await published();
 const page=await publicQuiz(token) as Row;
 assert.equal(page.status,'ok');
 assert.ok(!JSON.stringify(page).includes('"correct"'),'a página pública não recebe a resposta certa');
 const doc=cpf(10);
 const r=await answer(token,doc,RIGHT);
 assert.equal(r.passed,true);assert.equal(r.score,100);
 assert.equal(r.validUntil,validUntilDay(brDay(Date.now()),12,'meses'));
 await rejects(publicCheck(token,{cpf:doc,name:'Maria da Silva',company:'Empresa X'}),409,'CPF_VALID');
 await assert.rejects(publicCheck(token,{cpf:doc,name:'Maria da Silva',company:'X'}),(e:{data?:Row})=>e.data?.validUntil===r.validUntil);
});

test('reprovado refaz até o limite do dia; erradas aparecem sem a resposta certa',async()=>{
 const {token}=await published();
 const doc=cpf(20);
 const r1=await answer(token,doc,WRONG);
 assert.equal(r1.passed,false);assert.equal(r1.validUntil,null);assert.equal(r1.remainingToday,1);
 assert.deepEqual(r1.wrong,['Cor do capacete do visitante?']);
 assert.ok(!JSON.stringify(r1).includes('Azul'));
 const r2=await answer(token,doc,WRONG);assert.equal(r2.remainingToday,0);
 await rejects(publicCheck(token,{cpf:doc,name:'Maria da Silva',company:'Empresa X'}),429,'DAILY_LIMIT');
 const n=await db.first('SELECT count(*)::int n FROM quiz_attempts WHERE cpf=?',doc);assert.equal(n!.n,2,'todas as tentativas ficam registradas');
});

test('envio repetido grava uma vez; bilhete é de uso único e exige tempo mínimo',async()=>{
 const {token}=await published({dailyLimit:5});
 const doc=cpf(30),person={cpf:doc,name:'João Souza',company:'Empresa Y'};
 const c=await publicCheck(token,person) as Row,page=await publicQuiz(token) as Row;
 const body={...person,ticket:c.ticket,submitKey:key(),version:page.quiz.version,answers:WRONG};
 await rejects(publicSubmit(token,body,meta),429,'TOO_FAST');
 await db.run('UPDATE quiz_tickets SET issued_at=? WHERE id=?',new Date(Date.now()-60_000).toISOString(),c.ticket);
 const a=await publicSubmit(token,body,meta) as Row,b=await publicSubmit(token,body,meta) as Row;
 assert.equal(a.code,b.code);
 assert.equal((await db.first('SELECT count(*)::int n FROM quiz_attempts WHERE cpf=?',doc))!.n,1);
 await rejects(publicSubmit(token,{...body,submitKey:key()},meta),409,'TICKET');
});

test('campo-armadilha descarta sem gravar',async()=>{
 const {token}=await published();
 const doc=cpf(40);
 const r=await answer(token,doc,RIGHT,{website:'http://spam'});
 assert.equal(r.status,'recebido');
 assert.equal((await db.first('SELECT count(*)::int n FROM quiz_attempts WHERE cpf=?',doc))!.n,0);
});

test('nova versão não muda o link nem o histórico; pausar e regerar link',async()=>{
 const {id,token}=await published({dailyLimit:5});
 const doc=cpf(50);await answer(token,doc,WRONG);
 let d=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 await save({id,rev:d.quiz.rev,title:'Integração v2',questions:[{...QUESTIONS[0],text:'Cor do capacete? (v2)'},QUESTIONS[1]]});
 d=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 await quizMutate('quiz/publish',{id,rev:d.quiz.rev},evaluator);
 const page=await publicQuiz(token) as Row;assert.equal(page.quiz.version,2);assert.equal(page.quiz.title,'Integração v2');
 const list=await quizGet('quiz/attempts',url({quiz:id}),evaluator) as Row;
 const old=await quizGet('quiz/attempt',url({id:list.rows[0].id}),evaluator) as Row;
 assert.equal(old.attempt.version,1);assert.equal(old.attempt.answers[0].text,'Cor do capacete do visitante?');
 assert.equal(list.rows[0].cpf,maskCpf(doc),'lista mostra o CPF mascarado');assert.equal(old.attempt.cpf,doc);
 d=await quizGet('quiz/detail',url({id}),evaluator) as Row;
 await quizMutate('quiz/status',{id,status:'pausado'},evaluator);
 assert.equal((await publicQuiz(token) as Row).status,'indisponivel');
 await rejects(publicCheck(token,{cpf:cpf(51),name:'Ana Lima',company:'Z'}),409,'UNAVAILABLE');
 await quizMutate('quiz/status',{id,status:'publicado'},evaluator);
 const r=await quizMutate('quiz/regenerate-token',{id},evaluator) as Row;
 assert.notEqual(r.token,token);
 assert.equal((await publicQuiz(token) as Row).status,'indisponivel');
 assert.equal((await publicQuiz(r.token) as Row).status,'ok');
 await quizMutate('quiz/status',{id,status:'encerrado'},evaluator);
 await rejects(quizMutate('quiz/status',{id,status:'publicado'},evaluator),409);
});

test('dados pessoais: CPF inválido e nome incompleto são recusados',async()=>{
 const {token}=await published();
 await rejects(publicCheck(token,{cpf:'52998224724',name:'Maria da Silva',company:'X'}),400,'CPF_INVALID');
 await rejects(publicCheck(token,{cpf:cpf(60),name:'Maria',company:'X'}),400);
 await rejects(publicCheck(token,{cpf:cpf(60),name:'Maria da Silva',company:''}),400);
});

test('dois envios simultâneos do mesmo CPF não passam do limite',async()=>{
 const {token}=await published({dailyLimit:1});
 const doc=cpf(70),person={cpf:doc,name:'Paulo Reis',company:'W'};
 const t1=await publicCheck(token,person) as Row,t2=await publicCheck(token,person) as Row,page=await publicQuiz(token) as Row;
 await db.run('UPDATE quiz_tickets SET issued_at=?',new Date(Date.now()-60_000).toISOString());
 const results=await Promise.allSettled([t1,t2].map(t=>publicSubmit(token,{...person,ticket:t.ticket,submitKey:key(),version:page.quiz.version,answers:WRONG},meta)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await db.first('SELECT count(*)::int n FROM quiz_attempts WHERE cpf=?',doc))!.n,1);
});
