// Financeiro · Frente B: solicitação de recobráveis por atividade — banco, configuração, cotações,
// envio, autorização, anexos, ligação com o Planejamento, painel e exportação. Banco próprio;
// valores, clientes e fornecedores fictícios (margem 10% e impostos 10%).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryMutate} from '../lib/registry';
import {modules,type Member} from '../lib/permissions';
import {financeConfig,financeRequestsMutate,requestDetail,requestList,requestReport} from '../lib/finance-requests';
import {uploadAttachment,downloadAttachment} from '../lib/finance-files';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,operator:Member,fin:Member,scoped:Member;
let org:string,person:string,other:string,otherPerson:string;
const key=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const rejects=(p:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(p,(e:{status?:number;message:string})=>{assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const fr=(path:string,b:Row,who:Member=fin)=>financeRequestsMutate('finance/'+path,b,who) as Promise<Row>;
const pgRejects=(p:Promise<unknown>,pattern:RegExp)=>assert.rejects(p,(e:{message:string})=>{assert.match(e.message,pattern);return true;});
const set=async(who:Member,caps:string[],profile:string,orgScope:string[]=[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps,orgScope},manager);return {...who,profile,capabilities:caps} as Member;};

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 operator=await set(await addMember(db,'operator'),[],'operator');
 const reg=(p:string,b:Row)=>registryMutate('registry/'+p,b,manager) as Promise<{id:string}>;
 org=(await reg('orgs',{name:'Cliente Teste',acronym:'CTE',category:'cliente',color:'#2B5F7A'})).id;
 person=(await reg('people',{orgId:org,name:'Pessoa Teste',role:'Fiscal'})).id;
 other=(await reg('orgs',{name:'Outro Cliente',acronym:'OCL',category:'cliente',color:'#7A2B5F'})).id;
 otherPerson=(await reg('people',{orgId:other,name:'Pessoa Outra',role:'Fiscal'})).id;
 fin=await set(await addMember(db,'planner'),['financeiro'],'planner');
 scoped=await set(await addMember(db,'fueler'),['financeiro'],'fueler',[other]);
 // Cliente Teste habilitado com margem 10% e impostos 10%; Outro Cliente não habilitado.
 await financeRequestsMutate('finance/config/client',{orgId:org,enabled:true},manager);
 await financeRequestsMutate('finance/config/rate',{orgId:org,margin:'10',tax:'10',validFrom:'2026-01-01'},manager);
});
const tomorrow=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(Date.now()+86400000);
const newRequest=(b:Row={})=>fr('requests/save',{orgId:org,personId:person,title:'Içamento de tubulação',description:'Içar e posicionar',plannedStart:'2026-11-10T11:00:00.000Z',resources:[],notes:'',...b});
after(async()=>{await ctx.drop();});

/** Solicitação inserida direto no banco (testes das travas). */
async function rawRequest(status='em_cotacao'){
 const id=key();
 await db.run(`INSERT INTO recovery_requests(id,org_id,requester_person_id,title,description,planned_start,margin_bp,tax_bp,created_at,created_by,created_by_name,updated_at)
  VALUES(?,?,?,?,?,?,1000,1000,?,?,'Gestor',?)`,id,org,person,'Içamento de teste','',now(),now(),manager.id,now());
 if(status!=='em_cotacao')await db.run('UPDATE recovery_requests SET status=? WHERE id=?',status,id);
 return id;
}

test('banco: caminhos de situação, cotação travada, autorização exige relatório assinado, anexo não se apaga',async()=>{
 assert.ok(modules({...operator,capabilities:['financeiro']}).includes('fin-solicitacoes'));
 assert.ok(modules({...operator,capabilities:['financeiro']}).includes('fin-config'));
 const r=await rawRequest();
 await pgRejects(db.run("UPDATE recovery_requests SET status='autorizada' WHERE id=?",r),/Situação/);
 const sup=key();await db.run("INSERT INTO suppliers(id,name,active,created_at,created_by) VALUES(?,'Fornecedor Alfa',1,?,?)",sup,now(),manager.id);
 const q=key();
 await db.run('INSERT INTO recovery_quotes(id,request_id,supplier_id,value_cents,created_at,created_by,created_by_name,updated_at) VALUES(?,?,?,1000000,?,?,?,?)',q,r,sup,now(),manager.id,'Gestor',now());
 await db.run("UPDATE recovery_requests SET status='enviada',justification='Só um fornecedor atende' WHERE id=?",r);
 await pgRejects(db.run("UPDATE recovery_requests SET title='Outro título' WHERE id=?",r),/não pode ser alterad/);
 const sup2=key();await db.run("INSERT INTO suppliers(id,name,active,created_at,created_by) VALUES(?,'Fornecedor Beta',1,?,?)",sup2,now(),manager.id);
 await pgRejects(db.run('INSERT INTO recovery_quotes(id,request_id,supplier_id,value_cents,created_at,created_by,created_by_name,updated_at) VALUES(?,?,?,500,?,?,?,?)',key(),r,sup2,now(),manager.id,'Gestor',now()),/Cotação só muda em "Em cotação"/);
 await pgRejects(db.run("UPDATE recovery_requests SET status='autorizada',chosen_quote_id=? WHERE id=?",q,r),/relatório assinado/);
 const att=key();
 await db.run("INSERT INTO finance_attachments(id,request_id,kind,file_name,content_type,size_bytes,content,created_at,created_by,created_by_name) VALUES(?,?,'relatorio_assinado','assinado.pdf','application/pdf',5,?,?,?,'Gestor')",att,r,Buffer.from('%PDF-'),now(),manager.id);
 await db.run("UPDATE recovery_requests SET status='autorizada',chosen_quote_id=? WHERE id=?",q,r);
 await pgRejects(db.run('DELETE FROM finance_attachments WHERE id=?',att),/não pode ser apagado/);
 await pgRejects(db.run("UPDATE finance_attachments SET file_name='x.pdf' WHERE id=?",att),/não pode ser alterad/);
 await pgRejects(db.run('DELETE FROM recovery_requests WHERE id=?',r),/não pode ser apagad/);
 await db.run("INSERT INTO finance_client_rates(id,org_id,margin_bp,tax_bp,valid_from,created_at,created_by,created_by_name) VALUES(?,?,1000,1000,'2025-06-01',?,?,'Gestor')",key(),org,now(),manager.id);
 await pgRejects(db.run('UPDATE finance_client_rates SET tax_bp=1250 WHERE org_id=?',org),/nova vigência/);
 // Número sequencial por sequência do banco.
 const n=await db.all('SELECT number FROM recovery_requests ORDER BY number');
 assert.ok(n.length>=1&&Number(n[0].number)>=1);
});

test('configuração: só cliente habilitado aparece; nova vigência não altera solicitação antiga',async()=>{
 const r=await newRequest();
 assert.match(String(r.rec),/^REC-\d{6}$/);
 await fr('config/rate',{orgId:org,margin:'10',tax:'12,5',validFrom:tomorrow()});
 assert.equal(Number((await db.first('SELECT tax_bp FROM recovery_requests WHERE id=?',r.id))!.tax_bp),1000,'solicitação guarda os percentuais do dia em que nasceu');
 const cfg=await financeConfig(fin);
 assert.deepEqual(cfg.suggestion,{marginBp:1000,taxBp:1250},'sugestão = vigência cadastrada mais recente');
 const byOrg=(id:string)=>(cfg.clients as Row[]).find(c=>c.orgId===id)!;
 assert.equal(byOrg(org).enabled,true);assert.equal(byOrg(other).enabled,false);
 assert.deepEqual([byOrg(org).current.marginBp,byOrg(org).current.taxBp],[1000,1000],'vigente hoje');
 await rejects(newRequest({orgId:other,personId:otherPerson}),409,/não está habilitado/);
});

test('cotações chegam em dias diferentes; o detalhe mostra "n de 3" e os valores da regra A',async()=>{
 const r=await newRequest({title:'Remoção de sucata'});
 await fr('quotes',{requestId:r.id,supplierName:'Fornecedor Alfa',value:'10.000,00',proposalNumber:'P-1',receivedAt:'2026-10-26'});
 let d=await requestDetail(fin,r.id);assert.equal(d.quotes.length,1);
 await fr('quotes',{requestId:r.id,supplierName:'Fornecedor Beta',value:'25.000,50',proposalNumber:'P-2',receivedAt:'2026-10-28'});
 await fr('quotes',{requestId:r.id,supplierName:'Fornecedor Gama',value:'8333,33',proposalNumber:'P-3',receivedAt:'2026-10-30'});
 d=await requestDetail(fin,r.id);
 assert.deepEqual((d.quotes as Row[]).map(q=>q.totals.totalCents),[1222222,3055617,1018518]);
 assert.deepEqual((d.quotes as Row[]).map(q=>q.supplierName),['Fornecedor Alfa','Fornecedor Beta','Fornecedor Gama']);
 const row=(await requestList(fin,new URL('http://x/'))).rows.find((x:Row)=>x.id===r.id)!;
 assert.equal(row.quotes,3);assert.equal(row.status,'em_cotacao');
 // Editar uma cotação enquanto em cotação.
 const q=(d.quotes as Row[])[0];
 await fr('quotes',{id:q.id,requestId:r.id,supplierId:q.supplierId,value:'11.000,00',proposalNumber:'P-1b',receivedAt:'2026-10-26'});
 assert.equal((await requestDetail(fin,r.id)).quotes[0].totals.quotedCents,1100000);
});

test('fornecedor: cadastrar na hora e não repetir na mesma solicitação',async()=>{
 const r=await newRequest({title:'Pintura'});
 await fr('quotes',{requestId:r.id,supplierName:'Fornecedor Delta',value:'500,00'});
 await rejects(fr('quotes',{requestId:r.id,supplierName:'fornecedor delta',value:'600,00'}),409,/já tem cotação nesta solicitação/);
 const r2=await newRequest({title:'Pintura 2'});
 await fr('quotes',{requestId:r2.id,supplierName:'  FORNECEDOR DELTA ',value:'700,00'});
 assert.equal((await db.all("SELECT id FROM suppliers WHERE lower(trim(name))='fornecedor delta'")).length,1,'mesmo cadastro');
});

test('escopo e acesso',async()=>{
 await rejects(newRequest.call(null,{}).then(()=>financeRequestsMutate('finance/requests/save',{orgId:org,personId:person,title:'X',plannedStart:'2026-11-10T11:00:00.000Z'},operator)),403);
 const r=await newRequest({title:'Escopo'});
 await rejects(requestDetail(scoped,r.id),404);
 assert.ok(!(await requestList(scoped,new URL('http://x/'))).rows.some((x:Row)=>x.id===r.id));
});

const PDF=(n=64)=>{const b=new Uint8Array(n);b.set([0x25,0x50,0x44,0x46,0x2d]);return b;};
const PNG=()=>new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const upload=(request:string,kind:string,name:string,bytes:Uint8Array,who:Member=fin,extra:Record<string,string>={})=>uploadAttachment(who,new URLSearchParams({request,kind,name,...extra}),bytes) as Promise<Row>;
const ver=async(id:string)=>(await requestDetail(fin,id)).request.version as number;
/** Solicitação com as três cotações do exemplo (Alfa 10.000,00; Beta 25.000,50; Gama 8.333,33). */
async function withQuotes(title:string,n=3){
 const r=await newRequest({title});
 const list=[['Fornecedor Alfa','10.000,00'],['Fornecedor Beta','25.000,50'],['Fornecedor Gama','8333,33']].slice(0,n);
 for(const [s,v] of list)await fr('quotes',{requestId:r.id,supplierName:s,value:v});
 return r.id as string;
}

test('envio com menos de 3 sem justificativa é recusado; com justificativa gera o relatório versão 1',async()=>{
 const id=await withQuotes('Envio com uma cotação',1);
 await rejects(fr('requests/send',{id,version:await ver(id)}),409,/justificativa/);
 await fr('requests/send',{id,version:await ver(id),justification:'Só um fornecedor atende na região'});
 const d=await requestDetail(fin,id);
 assert.equal(d.request.status,'enviada');assert.deepEqual(d.reports.map((x:Row)=>x.version),[1]);
 const rep=await requestReport(fin,id);
 assert.equal(rep.version,1);assert.equal(rep.snapshot.request.justification,'Só um fornecedor atende na região');
 assert.equal(rep.snapshot.quotes[0].totals.totalCents,1222222);
});

test('reabrir com motivo volta a "Em cotação" e o novo envio gera a versão 2',async()=>{
 const id=await withQuotes('Reabertura');
 await fr('requests/send',{id,version:await ver(id)});
 // Assinatura da versão 1 recebida antes da reabertura: não vale para autorizar a versão 2.
 await upload(id,'relatorio_assinado','assinado-v1.pdf',PDF());
 await rejects(fr('requests/reopen',{id,version:await ver(id)}),400,/Motivo/);
 await fr('requests/reopen',{id,version:await ver(id),reason:'Cliente pediu nova proposta do Alfa'});
 assert.equal((await requestDetail(fin,id)).request.status,'em_cotacao');
 const alfa=(await requestDetail(fin,id)).quotes.find((q:Row)=>q.supplierName==='Fornecedor Alfa')!;
 await fr('quotes',{id:alfa.id,requestId:id,supplierId:alfa.supplierId,value:'9.000,00'});
 await fr('requests/send',{id,version:await ver(id)});
 assert.deepEqual((await requestDetail(fin,id)).reports.map((x:Row)=>x.version),[1,2]);
 const v1=await requestReport(fin,id,1),v2=await requestReport(fin,id,2);
 const q=(rep:Row)=>(rep.snapshot.quotes as Row[]).find(x=>x.supplierName==='Fornecedor Alfa')!.totals.quotedCents;
 assert.equal(q(v1),1000000,'versão 1 guarda o valor da época');assert.equal(q(v2),900000);
 const auth=async()=>fr('requests/authorize',{id,version:await ver(id),quoteId:alfa.id,signerName:'Pessoa do Cliente',signerRole:'Fiscal',signedAt:'2026-10-29'});
 await rejects(auth(),409,/versão 2/);
 await upload(id,'relatorio_assinado','assinado-v2.pdf',PDF());
 await auth();
 assert.equal(Number((await requestDetail(fin,id)).request.chosen_total_cents),1100000);
});

test('autorizar sem anexo do relatório assinado é recusado; com anexo autoriza e trava valores',async()=>{
 const id=await withQuotes('Autorização');
 await fr('requests/send',{id,version:await ver(id)});
 const alfa=(await requestDetail(fin,id)).quotes.find((q:Row)=>q.supplierName==='Fornecedor Alfa')!;
 const auth=async()=>fr('requests/authorize',{id,version:await ver(id),quoteId:alfa.id,signerName:'Pessoa do Cliente',signerRole:'Fiscal',signedAt:'2026-10-29'});
 await rejects(auth(),409,/relatório assinado/);
 await upload(id,'relatorio_assinado','relatorio-assinado.pdf',PDF());
 await auth();
 const d=await requestDetail(fin,id);
 assert.equal(d.request.status,'autorizada');assert.equal(Number(d.request.chosen_total_cents),1222222);
 assert.ok(d.quotes.find((q:Row)=>q.id===alfa.id)!.chosen);
 await rejects(fr('quotes',{id:alfa.id,requestId:id,supplierId:alfa.supplierId,value:'1,00'}),409,/não está mais em cotação/);
 await rejects(fr('requests/save',{id,version:await ver(id),orgId:org,personId:person,title:'Outro',plannedStart:'2026-11-10T11:00:00.000Z',resources:[]}),409,/em cotação/);
 // Cancelar exige motivo.
 const other=await withQuotes('Cancelamento',1);
 await rejects(fr('requests/cancel',{id:other,version:await ver(other)}),400,/Motivo/);
 await fr('requests/cancel',{id:other,version:await ver(other),reason:'Cliente desistiu'});
 assert.equal((await requestDetail(fin,other)).request.status,'cancelada');
});

test('anexos: tipo errado e acima de 4 MB recusados; substituição sem apagar; download sem acesso recusado',async()=>{
 const id=await withQuotes('Anexos',1);
 const exe=new Uint8Array([0x4d,0x5a,0x90,0,3,0,0,0]);
 await rejects(upload(id,'outro','programa.pdf',exe,fin,{description:'Teste'}),415,/PDF, JPG ou PNG/);
 await rejects(upload(id,'outro','grande.pdf',PDF(4_194_305),fin,{description:'Grande'}),413,/4 MB/);
 const a1=await upload(id,'relatorio_assinado','v1.pdf',PDF());
 const a2=await upload(id,'relatorio_assinado','v2.pdf',PDF());
 const rows=await db.all('SELECT id,replaced_by FROM finance_attachments WHERE request_id=? AND kind=? ORDER BY created_at',id,'relatorio_assinado');
 assert.equal(rows.length,2);assert.equal(rows.find(x=>x.id===a1.id)!.replaced_by,a2.id);
 const png=await upload(id,'outro','x.pdf',PNG(),fin,{description:'Foto da placa'});
 assert.equal((await db.first('SELECT content_type FROM finance_attachments WHERE id=?',png.id))!.content_type,'image/png');
 await rejects(downloadAttachment(operator,a2.id),403);
 await rejects(downloadAttachment(scoped,a2.id),404);
 const res=await downloadAttachment(fin,a2.id);
 assert.equal(res.headers.get('content-type'),'application/pdf');assert.match(res.headers.get('content-disposition')||'',/attachment; filename\*=UTF-8''v2\.pdf/);
 assert.equal((await res.arrayBuffer()).byteLength,64);
});
