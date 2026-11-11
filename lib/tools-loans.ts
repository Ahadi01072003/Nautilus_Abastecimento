// Ferramentaria · fase B: solicitantes, empréstimos, assinaturas (na tela ou papel escaneado), devoluções
// e cancelamento. Emitir abate o estoque na hora; devolver em bom estado repõe; ferramenta danificada ou
// perdida e material consumido não voltam. Tudo idempotente e auditado; nada é apagado.
import {db,type Executor,type Row} from './db';
import {AppError,required,text,milli,isoDay} from './domain';
import {type Member} from './permissions';
import {audit} from './registry';
import {tools,key,dbError,type Actor} from './tools';
import {sniff,MAX_ATTACHMENT} from './finance-files';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(Date.now());
export const loanCode=(n:number)=>'EMP-'+String(n).padStart(5,'0');
const PAGE=30;
const like=(q:string)=>'%'+q.replace(/[\\%_]/g,'\\$&')+'%';
const flag=(v:unknown)=>v===false||v===0||v==='0'?0:1;
const UNSIGNED_ALERT_MS=24*3600_000;

/** Assinatura feita na tela: PNG em data URL, com tamanho limitado. */
function signature(value:unknown,label:string){
 const s=String(value??'');
 if(!s.startsWith('data:image/png;base64,')||s.length<200)throw new AppError(`${label}: assine no quadro antes de confirmar.`,400,'SIGNATURE_REQUIRED');
 if(s.length>400000)throw new AppError(`${label}: assinatura grande demais. Limpe e assine de novo.`,400,'SIGNATURE_TOO_LARGE');
 return s;
}
/** As duas assinaturas vêm juntas ou nenhuma. */
function signatures(b:Row){
 const has=!!(b.ocpSignature||b.contractorSignature);
 if(!has)return null;
 return {ocp:signature(b.ocpSignature,'Assinatura do responsável OCP'),contractor:signature(b.contractorSignature,'Assinatura do responsável do solicitante')};
}

const lineRow=(l:Row)=>{
 const out=Number(l.qty_out_milli),ret=Number(l.qty_returned_milli),dam=Number(l.qty_damaged_milli),lost=Number(l.qty_lost_milli),cons=Number(l.qty_consumed_milli);
 return {id:l.id,itemId:l.item_id,itemName:l.item_name,kind:l.item_kind,unitAbbr:l.unit_abbr,out:out/1000,returned:ret/1000,damaged:dam/1000,lost:lost/1000,consumed:cons/1000,pending:(out-ret-dam-lost-cons)/1000};
};
function loanRow(r:Row){
 const open=['emitido','parcial'].includes(r.status),signed=!!r.signed_at||Number(r.files||0)>0;
 return {id:r.id,number:Number(r.number),code:loanCode(Number(r.number)),contractorId:r.contractor_id,contractorName:r.contractor_name,contractorPerson:r.contractor_person,
  ocpName:r.ocp_name,purpose:r.purpose,expectedReturn:r.expected_return,status:r.status,late:open&&!!r.expected_return&&r.expected_return<today(),
  signed,signedOnScreen:!!r.signed_at,signedAt:r.signed_at||null,signedByName:r.signed_by_name||null,
  unsignedAlert:open&&!signed&&Date.now()-Date.parse(r.issued_at)>UNSIGNED_ALERT_MS,
  issuedAt:r.issued_at,issuedByName:r.issued_by_name,closedAt:r.closed_at||null,closedByName:r.closed_by_name||null,
  cancelledAt:r.cancelled_at||null,cancelledByName:r.cancelled_by_name||null,cancelReason:r.cancel_reason||null,
  lines:r.lines!=null?Number(r.lines):undefined,pendingLines:r.pending_lines!=null?Number(r.pending_lines):undefined,version:Number(r.version)};
}
const LOAN_SELECT=`SELECT l.*,(SELECT count(*)::int FROM tool_loan_files f WHERE f.loan_id=l.id AND f.return_id IS NULL) files,
 (SELECT count(*)::int FROM tool_loan_lines x WHERE x.loan_id=l.id) lines,
 (SELECT count(*)::int FROM tool_loan_lines x WHERE x.loan_id=l.id AND x.qty_out_milli>x.qty_returned_milli+x.qty_damaged_milli+x.qty_lost_milli+x.qty_consumed_milli) pending_lines
 FROM tool_loans l`;

async function loadLoan(ex:Executor,loanId:unknown,lock=false){
 const l=await ex.first(`SELECT * FROM tool_loans WHERE id=?${lock?' FOR UPDATE':''}`,String(loanId||''));
 if(!l)throw new AppError('Empréstimo não encontrado.',404,'LOAN_NOT_FOUND');
 return l;
}

// ---------- Consultas ----------

export async function contractorsList(member:Member){
 await tools(member);
 const [cs,ps,open]=await Promise.all([
  db().all('SELECT * FROM tool_contractors ORDER BY lower(name)'),
  db().all('SELECT * FROM tool_contractor_people ORDER BY lower(name)'),
  db().all("SELECT contractor_id,count(*)::int n FROM tool_loans WHERE status IN ('emitido','parcial') GROUP BY contractor_id")]);
 const openBy=new Map((open as Row[]).map(o=>[o.contractor_id,Number(o.n)]));
 return {rows:cs.map(c=>({id:c.id,name:c.name,active:Number(c.active)===1,openLoans:openBy.get(c.id)||0,
  people:ps.filter(p=>p.contractor_id===c.id).map(p=>({id:p.id,name:p.name,active:Number(p.active)===1}))}))};
}

export async function loansList(member:Member,url:URL){
 await tools(member);
 const p=Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1)),where:string[]=[],values:unknown[]=[];
 const status=url.searchParams.get('status')||'open';
 if(status==='open')where.push("l.status IN ('emitido','parcial')");
 else if(status==='late'){where.push("l.status IN ('emitido','parcial') AND l.expected_return<?");values.push(today());}
 else if(status==='unsigned')where.push("l.status IN ('emitido','parcial') AND l.signed_at IS NULL AND NOT EXISTS (SELECT 1 FROM tool_loan_files f WHERE f.loan_id=l.id AND f.return_id IS NULL)");
 else if(status==='closed')where.push("l.status='encerrado'");
 else if(status==='cancelled')where.push("l.status='cancelado'");
 else if(status!=='all')throw new AppError('Situação inválida.');
 const contractor=url.searchParams.get('contractor');if(contractor){where.push('l.contractor_id=?');values.push(contractor);}
 const q=(url.searchParams.get('q')||'').trim().slice(0,80);
 if(q){const n=Number(q.replace(/\D/g,''));where.push(`(l.contractor_name ILIKE ? OR l.contractor_person ILIKE ? OR l.purpose ILIKE ?${n?' OR l.number=?':''})`);values.push(like(q),like(q),like(q));if(n)values.push(n);}
 const rows=await db().all(`${LOAN_SELECT}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY l.number DESC LIMIT ? OFFSET ?`,...values,PAGE+1,(p-1)*PAGE);
 return {rows:rows.slice(0,PAGE).map(loanRow),page:p,hasMore:rows.length>PAGE};
}

export async function loanDetail(member:Member,loanId:string){
 await tools(member);
 const l=await db().first(`${LOAN_SELECT} WHERE l.id=?`,loanId);
 if(!l)throw new AppError('Empréstimo não encontrado.',404,'LOAN_NOT_FOUND');
 const [lines,returns,rlines,files]=await Promise.all([
  db().all('SELECT * FROM tool_loan_lines WHERE loan_id=? ORDER BY lower(item_name)',l.id),
  db().all('SELECT id,number,note,closes_loan,signed_at,returned_by,created_at,created_by_name FROM tool_loan_returns WHERE loan_id=? ORDER BY number',l.id),
  db().all('SELECT rl.*,ll.item_name,ll.unit_abbr,ll.item_kind FROM tool_loan_return_lines rl JOIN tool_loan_lines ll ON ll.id=rl.line_id WHERE ll.loan_id=? ORDER BY lower(ll.item_name)',l.id),
  db().all('SELECT id,return_id,file_name,content_type,size_bytes,created_at,created_by_name FROM tool_loan_files WHERE loan_id=? ORDER BY created_at',l.id)]);
 return {loan:loanRow(l),lines:lines.map(lineRow),
  returns:returns.map(r=>({id:r.id,number:Number(r.number),note:r.note||null,closesLoan:Number(r.closes_loan)===1,signed:!!r.signed_at,returnedBy:r.returned_by||null,createdAt:r.created_at,createdByName:r.created_by_name,
   lines:rlines.filter(x=>x.return_id===r.id).map(x=>({itemName:x.item_name,unitAbbr:x.unit_abbr,kind:x.item_kind,returned:Number(x.returned_milli)/1000,damaged:Number(x.damaged_milli)/1000,lost:Number(x.lost_milli)/1000,consumed:Number(x.consumed_milli)/1000}))})),
  files:files.map(f=>({id:f.id,returnId:f.return_id||null,name:f.file_name,contentType:f.content_type,size:Number(f.size_bytes),createdAt:f.created_at,createdByName:f.created_by_name}))};
}

/** Para a impressão: inclui as assinaturas (imagens). Quem chama confere o acesso. */
export async function loanPrint(member:Member,loanId:string,returnId?:string){
 const d=await loanDetail(member,loanId);
 const l=await db().first('SELECT ocp_signature,contractor_signature FROM tool_loans WHERE id=?',loanId);
 let ret:Row|null=null;
 if(returnId){
  ret=await db().first('SELECT id,number,note,closes_loan,ocp_signature,contractor_signature,signed_at,returned_by,created_at,created_by_name FROM tool_loan_returns WHERE id=? AND loan_id=?',returnId,loanId);
  if(!ret)throw new AppError('Devolução não encontrada.',404);
 }
 return {...d,signatures:{ocp:l!.ocp_signature||null,contractor:l!.contractor_signature||null},ret};
}

/** O que cada solicitante tem em mãos agora (empréstimos abertos, quantidade pendente). */
export async function contractorPosition(member:Member,contractorId:string){
 await tools(member);
 const c=await db().first('SELECT id,name FROM tool_contractors WHERE id=?',contractorId);
 if(!c)throw new AppError('Solicitante não encontrado.',404);
 const rows=await db().all(`SELECT ll.*,l.number,l.expected_return,l.contractor_person FROM tool_loan_lines ll JOIN tool_loans l ON l.id=ll.loan_id
  WHERE l.contractor_id=? AND l.status IN ('emitido','parcial') AND ll.qty_out_milli>ll.qty_returned_milli+ll.qty_damaged_milli+ll.qty_lost_milli+ll.qty_consumed_milli
  ORDER BY lower(ll.item_name),l.number`,c.id);
 return {contractor:{id:c.id,name:c.name},rows:rows.map(r=>({...lineRow(r),loanId:r.loan_id,loanCode:loanCode(Number(r.number)),expectedReturn:r.expected_return,late:!!r.expected_return&&r.expected_return<today(),person:r.contractor_person}))};
}

// ---------- Comandos ----------

async function saveContractor(a:Actor,b:Row){
 const name=required(b.name,'Nome do solicitante',120),active=flag(b.active);
 return await db().tx(async tx=>{
  const old=b.id?await tx.first('SELECT * FROM tool_contractors WHERE id=?',String(b.id)):null;
  if(b.id&&!old)throw new AppError('Solicitante não encontrado.',404);
  const rid=old?.id||id();
  try{
   if(old)await tx.run('UPDATE tool_contractors SET name=?,active=?,updated_at=? WHERE id=?',name,active,now(),rid);
   else await tx.run('INSERT INTO tool_contractors(id,name,active,created_at,updated_at) VALUES(?,?,?,?,?)',rid,name,active,now(),now());
  }catch(e){if(/tool_contractors_name_key/.test((e as Error).message))throw new AppError('Já existe solicitante com este nome.',409);throw e;}
  await audit(tx,a,`Ferramentaria: solicitante ${old?'atualizado':'cadastrado'}`,rid,{name,active:!!active});
  return {id:rid,message:`Solicitante ${old?'atualizado':'cadastrado'}.`};
 });
}

async function savePerson(a:Actor,b:Row){
 const name=required(b.name,'Nome do responsável',120),active=flag(b.active);
 return await db().tx(async tx=>{
  const old=b.id?await tx.first('SELECT * FROM tool_contractor_people WHERE id=?',String(b.id)):null;
  if(b.id&&!old)throw new AppError('Responsável não encontrado.',404);
  const contractorId=old?.contractor_id||required(b.contractorId,'Solicitante',100);
  if(!await tx.first('SELECT 1 FROM tool_contractors WHERE id=?',contractorId))throw new AppError('Solicitante não encontrado.',404);
  const rid=old?.id||id();
  try{
   if(old)await tx.run('UPDATE tool_contractor_people SET name=?,active=?,updated_at=? WHERE id=?',name,active,now(),rid);
   else await tx.run('INSERT INTO tool_contractor_people(id,contractor_id,name,active,created_at,updated_at) VALUES(?,?,?,?,?,?)',rid,contractorId,name,active,now(),now());
  }catch(e){if(/tool_contractor_people_name_key/.test((e as Error).message))throw new AppError('Este responsável já está cadastrado neste solicitante.',409);throw e;}
  await audit(tx,a,`Ferramentaria: responsável do solicitante ${old?'atualizado':'cadastrado'}`,rid,{name,contractorId,active:!!active});
  return {id:rid,message:`Responsável ${old?'atualizado':'cadastrado'}.`};
 });
}

/** Responsável que vai assinar o lado do solicitante: nem sempre é quem pediu, então é dito na assinatura. */
const personName=(v:unknown,required_:boolean)=>{const s=text(v,120);if(!s&&required_)throw new AppError('Informe o nome de quem assina pelo solicitante.',400,'VALIDATION','contractorPerson');return s||null;};

/** Cadastra no solicitante o responsável digitado na hora, se ainda não existe. */
async function rememberPerson(tx:Executor,contractorId:string,person:string|null){
 if(person&&!await tx.first('SELECT 1 FROM tool_contractor_people WHERE contractor_id=? AND lower(trim(name))=lower(trim(?))',contractorId,person))
  await tx.run('INSERT INTO tool_contractor_people(id,contractor_id,name,active,created_at,updated_at) VALUES(?,?,?,1,?,?)',id(),contractorId,person,now(),now());
}

/** Emite o empréstimo: abate o estoque na hora. Assinaturas na tela (com o nome de quem assina) podem vir junto ou depois. */
async function issueLoan(a:Actor,b:Row){
 const createKey=key(b.idempotencyKey);
 const sig=signatures(b);
 const person=personName(b.contractorPerson,!!sig),ocpName=text(b.ocpName,120)||a.name,purpose=required(b.purpose,'Finalidade',300);
 const expected=b.expectedReturn===undefined||b.expectedReturn===null||String(b.expectedReturn).trim()===''?null:isoDay(b.expectedReturn);
 if(expected&&expected<today())throw new AppError('A devolução prevista não pode ser antes de hoje.',400,'VALIDATION','expectedReturn');
 const lines=Array.isArray(b.lines)?b.lines as Row[]:[];
 if(!lines.length)throw new AppError('Inclua ao menos um item.',400,'VALIDATION','lines');
 if(lines.length>100)throw new AppError('Até 100 itens por empréstimo.',400,'VALIDATION','lines');
 const ids=lines.map(l=>String(l?.itemId||''));
 if(ids.some(x=>!x))throw new AppError('Escolha o item de cada linha.',400,'VALIDATION','lines');
 if(new Set(ids).size!==ids.length)throw new AppError('Item repetido na lista: some as quantidades numa linha só.',400,'VALIDATION','lines');
 return await db().tx(async tx=>{
  const prior=await tx.first('SELECT id,number FROM tool_loans WHERE create_key=?',createKey);
  if(prior)return {id:prior.id as string,code:loanCode(Number(prior.number)),replayed:true,message:`${loanCode(Number(prior.number))} já emitido.`};
  const c=await tx.first('SELECT * FROM tool_contractors WHERE id=?',required(b.contractorId,'Solicitante',100));
  if(!c)throw new AppError('Solicitante não encontrado.',404,'VALIDATION','contractorId');
  if(Number(c.active)!==1)throw new AppError(`${c.name} está inativo.`,409);
  await rememberPerson(tx,c.id,person);
  const lid=id(),stamp=now();
  const ins=await tx.first(`INSERT INTO tool_loans(id,contractor_id,contractor_name,contractor_person,ocp_name,purpose,expected_return,status,ocp_signature,contractor_signature,signed_at,signed_by_name,issued_at,issued_by,issued_by_name,create_key)
   VALUES(?,?,?,?,?,?,?,'emitido',?,?,?,?,?,?,?,?) RETURNING number`,lid,c.id,c.name,person,ocpName,purpose,expected,sig?.ocp??null,sig?.contractor??null,sig?stamp:null,sig?a.name:null,stamp,a.id,a.name,createKey);
  const code=loanCode(Number(ins!.number));
  const order=[...lines.keys()].sort((x,y)=>ids[x]<ids[y]?-1:1); // mesma ordem de trava sempre
  for(const idx of order){
   const item=await tx.first('SELECT i.*,u.abbr unit_abbr,u.integral FROM tool_items i JOIN tool_units u ON u.id=i.unit_id WHERE i.id=? FOR UPDATE OF i',ids[idx]);
   if(!item)throw new AppError('Item não encontrado.',404,'ITEM_NOT_FOUND');
   if(Number(item.active)!==1)throw new AppError(`${item.name} está inativo.`,409,'ITEM_INACTIVE');
   const q=milli(Number(lines[idx].qty),Number(item.integral)===1);
   if(q>Number(item.balance_milli))throw new AppError(`${item.name}: saldo insuficiente (disponível ${Number(item.balance_milli)/1000} ${item.unit_abbr}).`,409,'INSUFFICIENT_BALANCE');
   await tx.run('INSERT INTO tool_loan_lines(id,loan_id,item_id,item_name,item_kind,unit_abbr,qty_out_milli) VALUES(?,?,?,?,?,?,?)',id(),lid,item.id,item.name,item.kind,item.unit_abbr,q);
   try{
    await tx.run("INSERT INTO tool_movements(id,operation_key,item_id,kind,delta_milli,reason,ref_type,ref_id,occurred_at,author_id,author_name) VALUES(?,?,?,'emprestimo',?,?,'loan',?,?,?,?)",
     id(),`loan:${lid}:${item.id}`,item.id,-q,`Empréstimo ${code} · ${c.name}`,lid,stamp,a.id,a.name);
   }catch(e){dbError(e);}
  }
  await audit(tx,a,'Ferramentaria: empréstimo emitido',lid,{code,contractor:c.name,person,items:lines.length,signed:!!sig});
  return {id:lid,code,message:`${code} emitido para ${c.name}.${sig?'':' Falta a assinatura: assine na tela ou anexe o termo assinado.'}`};
 });
}

/** Assina na tela depois da emissão (o empréstimo ou uma devolução). Uma vez só. */
async function signLoan(a:Actor,b:Row){
 const sig=signatures(b);
 if(!sig)throw new AppError('Assine nos dois quadros antes de confirmar.',400,'SIGNATURE_REQUIRED');
 return await db().tx(async tx=>{
  const l=await loadLoan(tx,b.loanId,true);
  if(b.returnId){
   const r=await tx.first('SELECT * FROM tool_loan_returns WHERE id=? AND loan_id=? FOR UPDATE',String(b.returnId),l.id);
   if(!r)throw new AppError('Devolução não encontrada.',404);
   if(r.signed_at)throw new AppError('Esta devolução já foi assinada.',409,'ALREADY_SIGNED');
   const by=returnerName(b.returnedBy,!r.returned_by)||r.returned_by;
   await rememberPerson(tx,l.contractor_id,by);
   await tx.run('UPDATE tool_loan_returns SET ocp_signature=?,contractor_signature=?,signed_at=?,returned_by=? WHERE id=?',sig.ocp,sig.contractor,now(),by,r.id);
   await audit(tx,a,'Ferramentaria: devolução assinada na tela',l.id,{code:loanCode(Number(l.number)),return:Number(r.number),returnedBy:by});
   return {message:'Devolução assinada.'};
  }
  if(l.status==='cancelado')throw new AppError('Empréstimo cancelado não se assina.',409);
  if(l.signed_at)throw new AppError('Este empréstimo já foi assinado.',409,'ALREADY_SIGNED');
  const person=personName(b.contractorPerson,!l.contractor_person)||l.contractor_person,ocpName=text(b.ocpName,120)||l.ocp_name;
  await rememberPerson(tx,l.contractor_id,person);
  await tx.run('UPDATE tool_loans SET ocp_signature=?,contractor_signature=?,signed_at=?,signed_by_name=?,contractor_person=?,ocp_name=?,version=version+1 WHERE id=?',sig.ocp,sig.contractor,now(),a.name,person,ocpName,l.id);
  await audit(tx,a,'Ferramentaria: empréstimo assinado na tela',l.id,{code:loanCode(Number(l.number)),person,ocpName});
  return {message:`${loanCode(Number(l.number))} assinado.`};
 });
}

const returnerName=(v:unknown,required_:boolean)=>{const s=text(v,120);if(!s&&required_)throw new AppError('Informe o nome de quem devolve pelo solicitante.',400,'VALIDATION','returnedBy');return s||null;};

/** Devolução: o que volta em bom estado repõe o estoque. "Encerrar" dá o material restante como consumido. */
async function returnLoan(a:Actor,b:Row){
 const createKey=key(b.idempotencyKey),close=b.close===true,note=text(b.note,500)||null;
 const input=Array.isArray(b.lines)?b.lines as Row[]:[];
 const sig=signatures(b),by=returnerName(b.returnedBy,!!sig);
 return await db().tx(async tx=>{
  const prior=await tx.first('SELECT id,number FROM tool_loan_returns WHERE create_key=?',createKey);
  if(prior)return {id:prior.id as string,replayed:true,message:'Devolução já registrada.'};
  const l=await loadLoan(tx,b.loanId,true);
  const code=loanCode(Number(l.number));
  if(!['emitido','parcial'].includes(l.status))throw new AppError(`${code} está ${l.status==='cancelado'?'cancelado':'encerrado'}.`,409,'LOAN_CLOSED');
  const lines=await tx.all('SELECT * FROM tool_loan_lines WHERE loan_id=? ORDER BY item_id FOR UPDATE',l.id);
  const byId=new Map(lines.map(x=>[x.id as string,x]));
  const seen=new Set<string>();
  const plan:{line:Row,ret:number,dam:number,lost:number,cons:number}[]=[];
  for(const row of input){
   const line=byId.get(String(row?.lineId||''));
   if(!line)throw new AppError('Item não pertence a este empréstimo.',400,'VALIDATION','lines');
   if(seen.has(line.id))throw new AppError('Item repetido na devolução.',400,'VALIDATION','lines');seen.add(line.id);
   const integral=Number((await tx.first('SELECT u.integral FROM tool_items i JOIN tool_units u ON u.id=i.unit_id WHERE i.id=?',line.item_id))!.integral)===1;
   const q=(v:unknown)=>v===undefined||v===null||v===''||Number(v)===0?0:milli(Number(v),integral);
   const ret=q(row.returned),dam=line.item_kind==='ferramenta'?q(row.damaged):0,lost=line.item_kind==='ferramenta'?q(row.lost):0;
   if(line.item_kind==='material'&&(Number(row.damaged)||Number(row.lost)))throw new AppError(`${line.item_name}: material não volta danificado ou perdido; o que não voltar é consumido ao encerrar.`,400,'VALIDATION','lines');
   const pending=Number(line.qty_out_milli)-Number(line.qty_returned_milli)-Number(line.qty_damaged_milli)-Number(line.qty_lost_milli)-Number(line.qty_consumed_milli);
   if(ret+dam+lost>pending)throw new AppError(`${line.item_name}: devolução acima do pendente (${pending/1000} ${line.unit_abbr}).`,409,'OVER_RETURN');
   if(ret+dam+lost>0)plan.push({line,ret,dam,lost,cons:0});
  }
  // Situação de cada item depois desta devolução.
  const after=new Map(lines.map(x=>{const p=plan.find(y=>y.line.id===x.id);return [x.id as string,Number(x.qty_out_milli)-Number(x.qty_returned_milli)-Number(x.qty_damaged_milli)-Number(x.qty_lost_milli)-Number(x.qty_consumed_milli)-(p?p.ret+p.dam+p.lost:0)];}));
  if(close){
   const toolsPending=lines.filter(x=>x.item_kind==='ferramenta'&&after.get(x.id)!>0);
   if(toolsPending.length)throw new AppError(`Para encerrar, informe o destino das ferramentas pendentes: ${toolsPending.map(x=>x.item_name).join(', ')} (devolvida, danificada ou perdida).`,409,'TOOLS_PENDING');
   for(const x of lines.filter(y=>y.item_kind==='material'&&after.get(y.id)!>0)){
    const p=plan.find(y=>y.line.id===x.id);const rest=after.get(x.id)!;
    if(p)p.cons=rest;else plan.push({line:x,ret:0,dam:0,lost:0,cons:rest});
    after.set(x.id,0);
   }
  }
  if(!plan.length)throw new AppError('Informe o que está sendo devolvido.',400,'VALIDATION','lines');
  const allDone=[...after.values()].every(v=>v===0);
  const n=Number((await tx.first('SELECT coalesce(max(number),0)::int n FROM tool_loan_returns WHERE loan_id=?',l.id))!.n)+1;
  const rid=id(),stamp=now();
  await rememberPerson(tx,l.contractor_id,by);
  await tx.run('INSERT INTO tool_loan_returns(id,loan_id,number,note,closes_loan,ocp_signature,contractor_signature,signed_at,returned_by,created_at,created_by,created_by_name,create_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
   rid,l.id,n,note,allDone?1:0,sig?.ocp??null,sig?.contractor??null,sig?stamp:null,by,stamp,a.id,a.name,createKey);
  for(const p of plan){
   await tx.run('INSERT INTO tool_loan_return_lines(id,return_id,line_id,returned_milli,damaged_milli,lost_milli,consumed_milli) VALUES(?,?,?,?,?,?,?)',id(),rid,p.line.id,p.ret,p.dam,p.lost,p.cons);
   await tx.run('UPDATE tool_loan_lines SET qty_returned_milli=qty_returned_milli+?,qty_damaged_milli=qty_damaged_milli+?,qty_lost_milli=qty_lost_milli+?,qty_consumed_milli=qty_consumed_milli+? WHERE id=?',p.ret,p.dam,p.lost,p.cons,p.line.id);
   if(p.ret>0){
    try{
     await tx.run("INSERT INTO tool_movements(id,operation_key,item_id,kind,delta_milli,reason,ref_type,ref_id,occurred_at,author_id,author_name) VALUES(?,?,?,'devolucao',?,?,'loan',?,?,?,?)",
      id(),`ret:${rid}:${p.line.id}`,p.line.item_id,p.ret,`Devolução ${code} · ${l.contractor_name}`,l.id,stamp,a.id,a.name);
    }catch(e){dbError(e);}
   }
  }
  const status=allDone?'encerrado':'parcial';
  await tx.run(`UPDATE tool_loans SET status=?,version=version+1${allDone?',closed_at=?,closed_by_name=?':''} WHERE id=?`,...(allDone?[status,stamp,a.name,l.id]:[status,l.id]));
  await audit(tx,a,'Ferramentaria: devolução registrada',l.id,{code,return:n,closed:allDone,
   returned:plan.reduce((s,p)=>s+p.ret,0)/1000,damaged:plan.reduce((s,p)=>s+p.dam,0)/1000,lost:plan.reduce((s,p)=>s+p.lost,0)/1000,consumed:plan.reduce((s,p)=>s+p.cons,0)/1000});
  return {id:rid,status,message:allDone?`${code} encerrado.`:`Devolução ${n} registrada em ${code}.`};
 });
}

/** Cancela um empréstimo emitido por engano (sem devoluções): tudo volta ao estoque. */
async function cancelLoan(a:Actor,b:Row){
 const reason=required(b.reason,'Motivo do cancelamento',300);
 return await db().tx(async tx=>{
  const l=await loadLoan(tx,b.loanId,true),code=loanCode(Number(l.number));
  if(l.status==='cancelado')return {replayed:true,message:`${code} já está cancelado.`};
  if(l.status!=='emitido'||await tx.first('SELECT 1 FROM tool_loan_returns WHERE loan_id=?',l.id))
   throw new AppError(`${code} já tem devolução: registre a devolução do restante em vez de cancelar.`,409,'LOAN_HAS_RETURNS');
  const lines=await tx.all('SELECT * FROM tool_loan_lines WHERE loan_id=? ORDER BY item_id FOR UPDATE',l.id),stamp=now();
  for(const x of lines){
   await tx.run('UPDATE tool_loan_lines SET qty_returned_milli=qty_out_milli WHERE id=?',x.id);
   await tx.run("INSERT INTO tool_movements(id,operation_key,item_id,kind,delta_milli,reason,ref_type,ref_id,occurred_at,author_id,author_name) VALUES(?,?,?,'devolucao',?,?,'loan',?,?,?,?)",
    id(),`cancel:${l.id}:${x.id}`,x.item_id,Number(x.qty_out_milli),`Cancelamento ${code}`,l.id,stamp,a.id,a.name);
  }
  await tx.run("UPDATE tool_loans SET status='cancelado',cancelled_at=?,cancelled_by_name=?,cancel_reason=?,version=version+1 WHERE id=?",stamp,a.name,reason,l.id);
  await audit(tx,a,'Ferramentaria: empréstimo cancelado',l.id,{code,reason});
  return {message:`${code} cancelado. Os itens voltaram ao estoque.`};
 });
}

// ---------- Termo assinado em papel ----------

export async function uploadLoanFile(member:Member,params:URLSearchParams,body:Uint8Array){
 const a=await tools(member);
 const name=required(params.get('name'),'Nome do arquivo',200).replace(/^.*[\\/]/,'').replace(/[\u0000-\u001f\u007f"]/g,'_')||'arquivo';
 if(!body.byteLength)throw new AppError('Arquivo vazio.');
 if(body.byteLength>MAX_ATTACHMENT)throw new AppError('Arquivo acima de 4 MB.',413);
 const type=sniff(body);
 if(!type)throw new AppError('Envie PDF, JPG ou PNG.',415);
 return await db().tx(async tx=>{
  const l=await loadLoan(tx,params.get('loan'),true),code=loanCode(Number(l.number));
  const returnId=params.get('return')||null;
  if(returnId&&!await tx.first('SELECT 1 FROM tool_loan_returns WHERE id=? AND loan_id=?',returnId,l.id))throw new AppError('Devolução não encontrada.',404);
  const fid=id();
  await tx.run('INSERT INTO tool_loan_files(id,loan_id,return_id,file_name,content_type,size_bytes,content,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?)',
   fid,l.id,returnId,name,type,body.byteLength,Buffer.from(body.buffer,body.byteOffset,body.byteLength),now(),a.id,a.name);
  await audit(tx,a,'Ferramentaria: termo assinado anexado',l.id,{code,file:name,contentType:type,size:body.byteLength,return:returnId});
  return {id:fid,message:`Termo assinado anexado a ${code}.`};
 });
}

export async function downloadLoanFile(member:Member,fileId:string){
 const a=await tools(member);
 const f=await db().first<Row>('SELECT f.*,l.number FROM tool_loan_files f JOIN tool_loans l ON l.id=f.loan_id WHERE f.id=?',required(fileId,'Arquivo',100));
 if(!f)throw new AppError('Arquivo não encontrado.',404);
 await db().tx(tx=>audit(tx,a,'Exportação: termo de empréstimo',f.loan_id,{code:loanCode(Number(f.number)),file:f.file_name}));
 const content=Uint8Array.from(f.content as Uint8Array);
 return new Response(content,{headers:{'Content-Type':f.content_type,'Content-Length':String(content.byteLength),
  'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});
}

export async function loansGet(path:string,url:URL,member:Member):Promise<unknown|null>{
 if(path==='tools/contractors')return contractorsList(member);
 if(path==='tools/loans')return loansList(member,url);
 if(path==='tools/loan')return loanDetail(member,url.searchParams.get('id')||'');
 if(path==='tools/contractor-position')return contractorPosition(member,url.searchParams.get('id')||'');
 return null;
}

export async function loansMutate(path:string,b:Row,member:Member):Promise<unknown|null>{
 if(!['tools/contractors/save','tools/contractor-people/save','tools/loans/issue','tools/loans/sign','tools/loans/return','tools/loans/cancel'].includes(path))return null;
 const a=await tools(member);
 if(path==='tools/contractors/save')return saveContractor(a,b);
 if(path==='tools/contractor-people/save')return savePerson(a,b);
 if(path==='tools/loans/issue')return issueLoan(a,b);
 if(path==='tools/loans/sign')return signLoan(a,b);
 if(path==='tools/loans/return')return returnLoan(a,b);
 return cancelLoan(a,b);
}
