// Ferramentaria · fase B: empréstimo para terceirizada (baixa na emissão), assinatura, devolução, encerramento,
// cancelamento, termo escaneado e posição da terceirizada. Travas do banco e idempotência.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate} from '../lib/service';
import {toolsGet,toolsMutate} from '../lib/tools';
import {loansGet,loansMutate,uploadLoanFile,downloadLoanFile} from '../lib/tools-loans';
import {type Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,almox:Member,operator:Member,contractor:string;
const key=()=>crypto.randomUUID();
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const rejects=(p:Promise<unknown>,status:number,code?:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);if(code)assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,profile:string,caps:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(Date.now());
const SIG='data:image/png;base64,'+'A'.repeat(400);
const item=async(name:string,kind:string,qty:number,unitId='un')=>(await toolsMutate('tools/items/save',{idempotencyKey:key(),kind,name,unitId,initialQty:qty},almox) as Row).id as string;
const balance=async(id:string)=>Number((await db.first('SELECT balance_milli FROM tool_items WHERE id=?',id))!.balance_milli)/1000;
const issue=(lines:Row[],b:Row={},k=key())=>loansMutate('tools/loans/issue',{idempotencyKey:k,contractorId:contractor,contractorPerson:'Carlos Souza',ocpName:'Alan',purpose:'Manutenção do guindaste',expectedReturn:today(),lines,...b},almox) as Promise<Row>;
const detail=async(id:string)=>await loansGet('tools/loan',url({id}),almox) as {loan:Row,lines:Row[],returns:Row[],files:Row[]};
const ret=(loanId:string,lines:Row[],b:Row={})=>loansMutate('tools/loans/return',{idempotencyKey:key(),loanId,lines,...b},almox) as Promise<Row>;

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 almox=await set(await addMember(db,'almoxarife' as never),'almoxarife',[]);
 operator=await set(await addMember(db,'operator'),'operator',[]);
 contractor=(await loansMutate('tools/contractors/save',{name:'Montagens Alfa'},almox) as Row).id as string;
});
after(async()=>{await ctx.drop();});

test('terceirizada: cadastro, responsáveis e nome único; operador não acessa',async()=>{
 await rejects(loansMutate('tools/contractors/save',{name:'montagens alfa'},almox),409);
 await loansMutate('tools/contractor-people/save',{contractorId:contractor,name:'Ana Lima'},almox);
 const c=(await loansGet('tools/contractors',url(),almox) as {rows:Row[]}).rows.find(r=>r.id===contractor)!;
 assert.deepEqual((c.people as Row[]).map(p=>p.name),['Ana Lima']);
 await rejects(loansGet('tools/contractors',url(),operator) as Promise<unknown>,403);
 await rejects(loansMutate('tools/loans/issue',{},operator) as Promise<unknown>,403);
});

test('emitir abate o estoque na hora, registra o responsável novo e é idempotente',async()=>{
 const furadeira=await item('Furadeira','ferramenta',3),disco=await item('Disco de corte','material',20);
 const k=key();
 const r=await issue([{itemId:furadeira,qty:2},{itemId:disco,qty:5}],{},k);
 assert.match(r.code as string,/^EMP-\d{5}$/);
 assert.equal(await balance(furadeira),1);assert.equal(await balance(disco),15);
 const again=await issue([{itemId:furadeira,qty:2},{itemId:disco,qty:5}],{},k);
 assert.equal(again.id,r.id);assert.equal(again.replayed,true);assert.equal(await balance(furadeira),1);
 const d=await detail(r.id as string);
 assert.equal(d.loan.status,'emitido');assert.equal(d.loan.signed,false);assert.equal(d.lines.length,2);
 const people=(await loansGet('tools/contractors',url(),almox) as {rows:Row[]}).rows.find(x=>x.id===contractor)!.people as Row[];
 assert.ok(people.some(p=>p.name==='Carlos Souza'),'responsável digitado entrou no cadastro');
 const moves=(await toolsGet('tools/movements',url({item:furadeira}),almox) as {rows:Row[]}).rows;
 assert.equal(moves[0].kind,'emprestimo');assert.equal(moves[0].delta,-2);assert.match(moves[0].reason,/EMP-\d{5}/);
});

test('emissão recusa saldo insuficiente, item repetido, data passada e assinatura pela metade',async()=>{
 const x=await item('Esmerilhadeira','ferramenta',1);
 await rejects(issue([{itemId:x,qty:2}]),409,'INSUFFICIENT_BALANCE');
 await rejects(issue([{itemId:x,qty:1},{itemId:x,qty:1}]),400,'VALIDATION');
 await rejects(issue([{itemId:x,qty:1}],{expectedReturn:'2020-01-01'}),400,'VALIDATION');
 await rejects(issue([{itemId:x,qty:1}],{ocpSignature:SIG}),400,'SIGNATURE_REQUIRED');
 assert.equal(await balance(x),1,'nada saiu do estoque');
});

test('assinatura na tela: as duas juntas, uma vez só; o banco não deixa trocar',async()=>{
 const x=await item('Lixadeira','ferramenta',1);
 const r=await issue([{itemId:x,qty:1}]);
 await rejects(loansMutate('tools/loans/sign',{loanId:r.id,ocpSignature:SIG},almox) as Promise<unknown>,400,'SIGNATURE_REQUIRED');
 await loansMutate('tools/loans/sign',{loanId:r.id,ocpSignature:SIG,contractorSignature:SIG},almox);
 const d=await detail(r.id as string);assert.equal(d.loan.signed,true);assert.equal(d.loan.signedOnScreen,true);
 await rejects(loansMutate('tools/loans/sign',{loanId:r.id,ocpSignature:SIG,contractorSignature:SIG},almox) as Promise<unknown>,409,'ALREADY_SIGNED');
 await assert.rejects(db.run('UPDATE tool_loans SET ocp_signature=? WHERE id=?','data:image/png;base64,'+'B'.repeat(400),r.id),/já registrada/);
 // Emitida já assinada.
 const y=await item('Serra','ferramenta',1);
 const s=await issue([{itemId:y,qty:1}],{ocpSignature:SIG,contractorSignature:SIG});
 assert.equal((await detail(s.id as string)).loan.signed,true);
});

test('devolução parcial: o que volta bom repõe o estoque; danificado e perdido não',async()=>{
 const chave=await item('Chave de boca','ferramenta',10);
 const r=await issue([{itemId:chave,qty:6}]);
 const line=(await detail(r.id as string)).lines[0];
 const d1=await ret(r.id as string,[{lineId:line.id,returned:3,damaged:1}]);
 assert.equal(d1.status,'parcial');assert.equal(await balance(chave),7,'4 no estoque + 3 de volta');
 await rejects(ret(r.id as string,[{lineId:line.id,returned:3}]),409,'OVER_RETURN');
 const d=await detail(r.id as string);
 assert.equal(d.lines[0].pending,2);assert.equal(d.lines[0].damaged,1);assert.equal(d.loan.status,'parcial');
 // Fecha: as 2 pendentes perdidas.
 await rejects(ret(r.id as string,[],{close:true}),409,'TOOLS_PENDING');
 const d2=await ret(r.id as string,[{lineId:line.id,lost:2}],{close:true});
 assert.equal(d2.status,'encerrado');assert.equal(await balance(chave),7);
 const fim=await detail(r.id as string);
 assert.equal(fim.loan.status,'encerrado');assert.equal(fim.returns.length,2);assert.equal(fim.lines[0].lost,2);
 await rejects(ret(r.id as string,[{lineId:line.id,returned:1}]),409,'LOAN_CLOSED');
});

test('material: a sobra volta ao estoque e, ao encerrar, o restante é dado como consumido',async()=>{
 const eletrodo=await item('Eletrodo','material',10,'kg'),alicate=await item('Alicate','ferramenta',2);
 const r=await issue([{itemId:eletrodo,qty:4.5},{itemId:alicate,qty:1}]);
 const lines=(await detail(r.id as string)).lines,le=lines.find(l=>l.kind==='material')!,la=lines.find(l=>l.kind==='ferramenta')!;
 await rejects(ret(r.id as string,[{lineId:le.id,lost:1}]),400,'VALIDATION');
 const d=await ret(r.id as string,[{lineId:le.id,returned:1.5},{lineId:la.id,returned:1}],{close:true});
 assert.equal(d.status,'encerrado');
 assert.equal(await balance(eletrodo),7,'5,5 no estoque + 1,5 de sobra');
 const fim=await detail(r.id as string);
 assert.equal(fim.lines.find(l=>l.kind==='material')!.consumed,3);
});

test('devolução que zera tudo encerra sozinha; reenvio da mesma devolução não duplica',async()=>{
 const x=await item('Martelo','ferramenta',2);
 const r=await issue([{itemId:x,qty:2}]);
 const line=(await detail(r.id as string)).lines[0],k=key();
 const a1=await loansMutate('tools/loans/return',{idempotencyKey:k,loanId:r.id,lines:[{lineId:line.id,returned:2}]},almox) as Row;
 const a2=await loansMutate('tools/loans/return',{idempotencyKey:k,loanId:r.id,lines:[{lineId:line.id,returned:2}]},almox) as Row;
 assert.equal(a1.status,'encerrado');assert.equal(a2.replayed,true);assert.equal(await balance(x),2);
});

test('cancelar: só sem devolução; tudo volta ao estoque com motivo',async()=>{
 const x=await item('Talha','ferramenta',1);
 const r=await issue([{itemId:x,qty:1}]);
 await rejects(loansMutate('tools/loans/cancel',{loanId:r.id},almox) as Promise<unknown>,400);
 await loansMutate('tools/loans/cancel',{loanId:r.id,reason:'Emitido por engano'},almox);
 assert.equal(await balance(x),1);
 const d=await detail(r.id as string);assert.equal(d.loan.status,'cancelado');assert.equal(d.loan.cancelReason,'Emitido por engano');
 const y=await item('Macaco','ferramenta',2);
 const s=await issue([{itemId:y,qty:2}]);
 await ret(s.id as string,[{lineId:(await detail(s.id as string)).lines[0].id,returned:1}]);
 await rejects(loansMutate('tools/loans/cancel',{loanId:s.id,reason:'x'},almox) as Promise<unknown>,409,'LOAN_HAS_RETURNS');
});

test('termo assinado em papel: PDF anexado conta como assinado; tipo errado é recusado',async()=>{
 const x=await item('Paquímetro','ferramenta',1);
 const r=await issue([{itemId:x,qty:1}]);
 await rejects(uploadLoanFile(almox,new URLSearchParams({loan:r.id as string,name:'termo.txt'}),new TextEncoder().encode('texto qualquer')),415);
 const pdf=new TextEncoder().encode('%PDF-1.4 termo assinado');
 const f=await uploadLoanFile(almox,new URLSearchParams({loan:r.id as string,name:'termo.pdf'}),pdf);
 const d=await detail(r.id as string);assert.equal(d.loan.signed,true);assert.equal(d.loan.signedOnScreen,false);assert.equal(d.files.length,1);
 const res=await downloadLoanFile(almox,f.id);
 assert.equal(res.headers.get('Content-Type'),'application/pdf');assert.equal(res.headers.get('Cache-Control'),'private, no-store');
 const listed=(await loansGet('tools/loans',url({status:'unsigned'}),almox) as {rows:Row[]}).rows;
 assert.ok(!listed.some(l=>l.id===r.id),'com o termo anexado sai da lista sem assinatura');
});

test('posição da terceirizada, filtros da lista e painel',async()=>{
 const x=await item('Multímetro','ferramenta',2);
 const r=await issue([{itemId:x,qty:2}]);
 const pos=await loansGet('tools/contractor-position',url({id:contractor}),almox) as {rows:Row[]};
 const row=pos.rows.find(p=>p.loanId===r.id)!;assert.equal(row.pending,2);assert.equal(row.itemName,'Multímetro');
 const open=(await loansGet('tools/loans',url({status:'open',q:'Alfa'}),almox) as {rows:Row[]}).rows;
 assert.ok(open.some(l=>l.id===r.id));
 const byCode=(await loansGet('tools/loans',url({status:'all',q:String(r.code)}),almox) as {rows:Row[]}).rows;
 assert.deepEqual(byCode.map(l=>l.id),[r.id]);
 const dash=await toolsGet('tools/dashboard',url(),almox) as {loans:Row};
 assert.ok(dash.loans.open>=1);assert.equal(typeof dash.loans.late,'number');
});

test('banco: empréstimo não se apaga, item emitido não muda, devolução não se desfaz',async()=>{
 const x=await item('Torquímetro','ferramenta',2);
 const r=await issue([{itemId:x,qty:2}]);
 const line=(await detail(r.id as string)).lines[0];
 await assert.rejects(db.run('DELETE FROM tool_loans WHERE id=?',r.id),/não pode ser alterado nem apagado/);
 await assert.rejects(db.run('UPDATE tool_loan_lines SET qty_out_milli=1000 WHERE id=?',line.id),/não pode ser alterado/);
 await ret(r.id as string,[{lineId:line.id,returned:1}]);
 await assert.rejects(db.run('UPDATE tool_loan_lines SET qty_returned_milli=0 WHERE id=?',line.id),/não pode ser desfeita/);
 await assert.rejects(db.run("UPDATE tool_loans SET status='emitido' WHERE id=?",r.id),/não pode passar/);
 await assert.rejects(db.run("UPDATE tool_loans SET purpose='outra' WHERE id=?",r.id),/não pode ser alterado/);
});

test('responsável do solicitante escolhido na assinatura; devolução prevista é opcional',async()=>{
 const x=await item('Talhadeira','ferramenta',2);
 // Emite sem responsável e sem data prevista.
 const r=await issue([{itemId:x,qty:1}],{contractorPerson:'',expectedReturn:''});
 let d=await detail(r.id as string);
 assert.equal(d.loan.contractorPerson,null);assert.equal(d.loan.expectedReturn,null);assert.equal(d.loan.late,false);
 const late=(await loansGet('tools/loans',url({status:'late'}),almox) as {rows:Row[]}).rows;
 assert.ok(!late.some(l=>l.id===r.id),'sem data prevista não fica atrasado');
 // Assinar exige dizer quem assina pelo solicitante.
 await rejects(loansMutate('tools/loans/sign',{loanId:r.id,ocpSignature:SIG,contractorSignature:SIG},almox) as Promise<unknown>,400,'VALIDATION');
 await loansMutate('tools/loans/sign',{loanId:r.id,contractorPerson:'Bruno Reis',ocpName:'Thiago Almeida',ocpSignature:SIG,contractorSignature:SIG},almox);
 d=await detail(r.id as string);
 assert.equal(d.loan.contractorPerson,'Bruno Reis');assert.equal(d.loan.ocpName,'Thiago Almeida');
 const people=(await loansGet('tools/contractors',url(),almox) as {rows:Row[]}).rows.find(c=>c.id===contractor)!.people as Row[];
 assert.ok(people.some(p=>p.name==='Bruno Reis'),'quem assinou entrou no cadastro');
 await assert.rejects(db.run("UPDATE tool_loans SET contractor_person='Outro' WHERE id=?",r.id),/não pode ser alterado/);
 // Assinar já na emissão também exige o nome.
 await rejects(issue([{itemId:x,qty:1}],{contractorPerson:'',ocpSignature:SIG,contractorSignature:SIG}),400,'VALIDATION');
 assert.equal(await balance(x),1);
});

test('devolução registra quem devolveu; assinar a devolução exige o nome',async()=>{
 const x=await item('Trena','ferramenta',2);
 const r=await issue([{itemId:x,qty:2}]);
 const line=(await detail(r.id as string)).lines[0];
 await rejects(ret(r.id as string,[{lineId:line.id,returned:1}],{ocpSignature:SIG,contractorSignature:SIG}),400,'VALIDATION');
 const d1=await ret(r.id as string,[{lineId:line.id,returned:1}],{returnedBy:'Pedro Alves',ocpSignature:SIG,contractorSignature:SIG});
 const d2=await ret(r.id as string,[{lineId:line.id,returned:1}]);
 await rejects(loansMutate('tools/loans/sign',{loanId:r.id,returnId:d2.id,ocpSignature:SIG,contractorSignature:SIG},almox) as Promise<unknown>,400,'VALIDATION');
 await loansMutate('tools/loans/sign',{loanId:r.id,returnId:d2.id,returnedBy:'Rita Gomes',ocpSignature:SIG,contractorSignature:SIG},almox);
 const d=await detail(r.id as string);
 assert.deepEqual(d.returns.map(x=>[x.id,x.returnedBy,x.signed]),[[d1.id,'Pedro Alves',true],[d2.id,'Rita Gomes',true]]);
 await assert.rejects(db.run("UPDATE tool_loan_returns SET returned_by='Outro' WHERE id=?",d1.id),/não pode ser alterada/);
});

test('histórico do item mostra quem registrou, o solicitante e quem retirou ou devolveu',async()=>{
 const x=await item('Nível a laser','ferramenta',2);
 const r=await issue([{itemId:x,qty:1}],{contractorPerson:'Lucas Pinto'});
 const line=(await detail(r.id as string)).lines[0];
 await ret(r.id as string,[{lineId:line.id,returned:1}],{returnedBy:'Paula Reis'});
 const moves=(await toolsGet('tools/movements',url({item:x}),almox) as {rows:Row[]}).rows;
 const [dev,emp,ini]=moves;
 assert.equal(dev.kind,'devolucao');assert.equal(dev.loan.code,r.code);assert.equal(dev.loan.contractor,'Montagens Alfa');assert.equal(dev.loan.person,'Paula Reis');
 assert.equal(emp.kind,'emprestimo');assert.equal(emp.loan.person,'Lucas Pinto');assert.equal(emp.loan.id,r.id);
 assert.equal(ini.loan,null);assert.ok(ini.authorName,'quem registrou');
 const byKind=(await toolsGet('tools/movements',url({item:x,kind:'emprestimo'}),almox) as {rows:Row[]}).rows;
 assert.deepEqual(byKind.map(m=>m.kind),['emprestimo']);
});
