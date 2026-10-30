// Financeiro · Frente B: solicitação de recobráveis por atividade. Configuração por cliente (habilitado,
// margem e impostos com vigência), fornecedores, solicitações e cotações registradas aos poucos. Os
// valores de cada cotação saem do cálculo puro (lib/recovery-quote.ts) e não são gravados. Acesso:
// Financeiro e Gestão, no escopo de organizações de quem consulta.
import {db,type Executor,type Row} from './db';
import {AppError,required,text,isoDay} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {instant} from './planning';
import {quoteTotals,recNumber,type RequestStatus} from './recovery-quote';

type Actor=Member&{capabilities:string[],org_scope:string[]};
const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const ms=(v:string)=>Date.parse(v);
const localDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'});
const today=()=>localDay.format(Date.now());
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);
const finance=async(m:Member)=>await requireAny(m,['financeiro']) as Actor;

/** Percentual digitado ("11,75") em centésimos de % (1175), de 0 a 99,99. */
export function percentBp(value:unknown,label:string){
 const s=String(value??'').trim().replace('%','').replace(',','.'),n=Number(s);
 if(!s||!Number.isFinite(n)||n<0||n>=100)throw new AppError(`${label}: informe de 0 a 99,99%.`);
 const bp=Math.round(n*100);
 if(Math.abs(n*100-bp)>1e-6)throw new AppError(`${label}: use até duas casas decimais.`);
 return bp;
}
/** Valor em reais digitado ("10.000,00", "8333,33" ou "8333.33") em centavos. */
export function reaisToCents(value:unknown,label:string){
 if(typeof value==='number'){if(!Number.isFinite(value)||value<0)throw new AppError(`${label}: valor inválido.`);return Math.round(value*100);}
 let s=String(value??'').trim().replace(/^R\$\s*/,'').replace(/\s/g,'');
 if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');
 const n=Number(s);
 if(!s||!Number.isFinite(n)||n<0||n>100000000)throw new AppError(`${label}: informe o valor em reais.`);
 if(Math.abs(n*100-Math.round(n*100))>1e-6)throw new AppError(`${label}: use até duas casas decimais.`);
 return Math.round(n*100);
}
const day=(value:unknown,label:string)=>{const v=text(value,10);if(!v)return null;try{return isoDay(v);}catch{throw new AppError(`${label}: data inválida.`);}};

/** Margem e impostos vigentes para o cliente no dia (a vigência mais recente até o dia). */
export async function rateFor(ex:Executor,orgId:string,dayIso:string){
 const r=await ex.first('SELECT margin_bp,tax_bp FROM finance_client_rates WHERE org_id=? AND valid_from<=? ORDER BY valid_from DESC LIMIT 1',orgId,dayIso);
 return r?{marginBp:Number(r.margin_bp),taxBp:Number(r.tax_bp)}:null;
}

/** Traduz as travas do banco para mensagens da tela. */
function dbError(e:unknown):never{
 const m=(e as {message?:string}).message||'';
 if(/Cotação só muda em "Em cotação"/.test(m))throw new AppError('Esta solicitação não está mais em cotação: reabra a cotação para alterar.',409);
 if(/Dado da solicitação não pode ser alterado/.test(m))throw new AppError('Os dados só mudam com a solicitação em cotação.',409);
 if(/Situação da solicitação não pode passar/.test(m))throw new AppError('Esta ação não vale para a situação atual da solicitação. Atualize a tela.',409);
 if(/recovery_quotes_request_id_supplier_id_key/.test(m))throw new AppError('Este fornecedor já tem cotação nesta solicitação.',409);
 if(/suppliers_name/.test(m))throw new AppError('Já existe fornecedor com este nome.',409);
 throw e;
}

// ---- Consultas ----

/** Configuração: clientes (habilitado, vigente e histórico), fornecedores, sugestão para cliente novo
 * (a vigência cadastrada mais recente, de qualquer cliente) e os cadastros usados na solicitação. */
export async function financeConfig(member:Member){
 const a=await finance(member);
 const [orgs,clients,rates,suppliers,latest,people,activityTypes,equipmentTypes,functions,materials]=await Promise.all([
  db().all('SELECT id,name,acronym,active FROM requester_orgs ORDER BY name'),
  db().all('SELECT * FROM finance_clients'),
  db().all('SELECT * FROM finance_client_rates ORDER BY valid_from DESC'),
  db().all('SELECT * FROM suppliers ORDER BY lower(name)'),
  db().first('SELECT margin_bp,tax_bp FROM finance_client_rates ORDER BY created_at DESC LIMIT 1'),
  db().all('SELECT id,org_id,name,role,active FROM requester_people ORDER BY name'),
  db().all("SELECT id,code,name FROM activity_types WHERE active=1 AND coalesce(system,0)=0 ORDER BY code"),
  db().all('SELECT id,name FROM equipment_types WHERE active=1 ORDER BY name'),
  db().all('SELECT id,name FROM job_functions WHERE active=1 ORDER BY name'),
  db().all('SELECT id,name,unit FROM materials WHERE active=1 ORDER BY name'),
 ]);
 const t=today();
 const visible=orgs.filter(o=>inScope(a,o.id));
 return {
  clients:visible.map(o=>{const c=clients.find(x=>x.org_id===o.id),mine=rates.filter(r=>r.org_id===o.id),cur=mine.find(r=>r.valid_from<=t);
   return {orgId:o.id,name:o.name,acronym:o.acronym,active:!!o.active,enabled:!!c?.enabled,
    current:cur?{marginBp:Number(cur.margin_bp),taxBp:Number(cur.tax_bp),validFrom:cur.valid_from}:null,
    history:mine.map(r=>({id:r.id,marginBp:Number(r.margin_bp),taxBp:Number(r.tax_bp),validFrom:r.valid_from,createdByName:r.created_by_name,createdAt:r.created_at}))};}),
  suppliers,suggestion:latest?{marginBp:Number(latest.margin_bp),taxBp:Number(latest.tax_bp)}:null,
  people:people.filter(p=>visible.some(o=>o.id===p.org_id)),activityTypes,equipmentTypes,functions,materials,
 };
}

const SELECT_REQUEST=`SELECT r.*,o.name org_name,o.acronym org_acronym,p.name person_name,t.code type_code,t.name type_name,w.number wo_number,w.status wo_status,
 s.name chosen_supplier,(SELECT count(*) FROM recovery_quotes q WHERE q.request_id=r.id)::int quotes
 FROM recovery_requests r JOIN requester_orgs o ON o.id=r.org_id JOIN requester_people p ON p.id=r.requester_person_id
 LEFT JOIN activity_types t ON t.id=r.activity_type_id LEFT JOIN work_orders w ON w.id=r.work_order_id
 LEFT JOIN recovery_quotes cq ON cq.id=r.chosen_quote_id LEFT JOIN suppliers s ON s.id=cq.supplier_id`;
const activityOf=(r:Row)=>r.title||(r.type_code?`${r.type_code} · ${r.type_name}`:'');

/** Lista: número, cliente, atividade, data prevista, situação, cotações, fornecedor escolhido, valor a
 * faturar e OS. Filtros: situação, cliente e período (data prevista de início, dias de Brasília). */
export async function requestList(member:Member,url:URL){
 const a=await finance(member);
 const where:string[]=[],values:unknown[]=[];
 const status=url.searchParams.get('status');if(status){where.push('r.status=?');values.push(status);}
 const org=url.searchParams.get('org');if(org){where.push('r.org_id=?');values.push(org);}
 const from=url.searchParams.get('from'),to=url.searchParams.get('to');
 if(from){where.push('r.planned_start::timestamptz>=?::timestamptz');values.push(new Date(isoDay(from)+'T00:00:00-03:00').toISOString());}
 if(to){where.push('r.planned_start::timestamptz<?::timestamptz');values.push(new Date(Date.parse(isoDay(to)+'T00:00:00-03:00')+86400000).toISOString());}
 if(!isManager(a)&&a.org_scope.length){where.push('r.org_id = ANY(?::text[])');values.push(a.org_scope);}
 const rows=await db().all(`${SELECT_REQUEST}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY r.number DESC LIMIT 500`,...values);
 return {rows:rows.map(r=>({id:r.id,number:r.number,rec:recNumber(r.number),orgId:r.org_id,orgName:r.org_name,orgAcronym:r.org_acronym,activity:activityOf(r),plannedStart:r.planned_start,
  status:r.status,quotes:Number(r.quotes),chosenSupplier:r.chosen_supplier||null,totalCents:r.chosen_total_cents==null?null:Number(r.chosen_total_cents),workOrderId:r.work_order_id,workOrderNumber:r.wo_number??null}))};
}

/** Uma solicitação no escopo de quem consulta (404 fora dele). */
export async function loadRequest(ex:Executor,a:Actor,requestId:unknown,lock=false){
 const r=await ex.first(`${SELECT_REQUEST} WHERE r.id=?${lock?' FOR UPDATE OF r':''}`,required(requestId,'Solicitação',100));
 if(!r||!inScope(a,r.org_id))throw new AppError('Solicitação não encontrada ou fora do seu acesso.',404);
 return r;
}

/** Detalhe: dados, cotações com os valores da regra A, anexos (sem conteúdo), relatórios enviados,
 * histórico e as ações possíveis na situação atual. */
export async function requestDetail(member:Member,requestId:string){
 const a=await finance(member);
 const r=await loadRequest(db(),a,requestId);
 const [quotes,attachments,reports,history]=await Promise.all([
  db().all('SELECT q.*,s.name supplier_name FROM recovery_quotes q JOIN suppliers s ON s.id=q.supplier_id WHERE q.request_id=? ORDER BY coalesce(q.received_at,q.created_at),q.created_at',r.id),
  db().all('SELECT id,quote_id,kind,description,file_name,content_type,size_bytes,replaced_by,created_at,created_by_name FROM finance_attachments WHERE request_id=? ORDER BY created_at',r.id),
  db().all('SELECT version,issued_at,issued_by_name FROM recovery_reports WHERE request_id=? ORDER BY version',r.id),
  db().all('SELECT action,author_name,created_at,detail FROM audits WHERE entity_id=? ORDER BY created_at',r.id),
 ]);
 const st=r.status as RequestStatus,planner=isManager(a)||a.capabilities.includes('planejamento');
 return {request:{...r,rec:recNumber(r.number),activity:activityOf(r),quotes:undefined},
  quotes:quotes.map(q=>({id:q.id,supplierId:q.supplier_id,supplierName:q.supplier_name,proposalNumber:q.proposal_number,validUntil:q.valid_until,leadTime:q.lead_time,receivedAt:q.received_at,notes:q.notes,
   createdByName:q.created_by_name,chosen:q.id===r.chosen_quote_id,totals:quoteTotals(Number(q.value_cents),Number(r.margin_bp),Number(r.tax_bp))})),
  attachments,reports,history,
  can:{edit:st==='em_cotacao',send:st==='em_cotacao',reopen:st==='enviada'||(st==='autorizada'&&!r.work_order_id),authorize:st==='enviada',
   cancel:['em_cotacao','enviada','autorizada'].includes(st),plan:st==='autorizada'&&!r.work_order_id&&planner}};
}

// ---- Comandos ----

/** Recursos necessários (mesmo formato da OS sem fluxo): tipo de equipamento ou função com quantidade
 * (1 a 99), ou material com quantidade decimal e unidade. */
async function resourcesOf(value:unknown){
 if(value==null)return [];
 if(!Array.isArray(value)||value.length>30)throw new AppError('Recursos inválidos (até 30).');
 const out=(value as Row[]).map((n,i)=>{
  const label=`Recurso ${i+1}`;
  const et=n?.equipmentTypeId||null,fn=n?.functionId||null,mt=n?.materialId||null;
  if((et?1:0)+(fn?1:0)+(mt?1:0)!==1)throw new AppError(`${label}: inválido.`);
  if(mt){const amount=Number(n.amount),unit=required(n.unit,`${label} · unidade`,12);
   if(!Number.isFinite(amount)||amount<=0||amount>99999999)throw new AppError(`${label}: quantidade do material inválida.`);
   return {equipmentTypeId:null,functionId:null,materialId:String(mt),quantity:null,amount,unit};}
  const q=Number(n.quantity);if(!Number.isInteger(q)||q<1||q>99)throw new AppError(`${label}: quantidade de 1 a 99.`);
  return {equipmentTypeId:et?String(et):null,functionId:fn?String(fn):null,materialId:null,quantity:q,amount:null,unit:null};
 });
 const ids=(k:'equipmentTypeId'|'functionId'|'materialId')=>out.map(x=>x[k]).filter(Boolean) as string[];
 const [types,fns,mats]=await Promise.all([
  db().all('SELECT id FROM equipment_types WHERE id = ANY(?::text[])',ids('equipmentTypeId')),
  db().all('SELECT id FROM job_functions WHERE id = ANY(?::text[])',ids('functionId')),
  db().all('SELECT id FROM materials WHERE id = ANY(?::text[])',ids('materialId')),
 ]);
 if(types.length!==new Set(ids('equipmentTypeId')).size||fns.length!==new Set(ids('functionId')).size||mats.length!==new Set(ids('materialId')).size)throw new AppError('Recurso inexistente.');
 if(new Set(out.map(x=>`${x.equipmentTypeId}|${x.functionId}|${x.materialId}`)).size!==out.length)throw new AppError('Recurso repetido.');
 return out;
}

/** Fornecedor por id ou por nome ("cadastrar na hora": nome novo cria o cadastro; o mesmo nome, sem
 * diferenciar maiúsculas, reaproveita). */
async function supplierFor(ex:Executor,a:Actor,b:Row){
 if(b.supplierId){const s=await ex.first('SELECT * FROM suppliers WHERE id=?',String(b.supplierId));if(!s)throw new AppError('Fornecedor não encontrado.',404);return s;}
 const name=required(b.supplierName,'Fornecedor',160).replace(/\s+/g,' ');
 const found=await ex.first('SELECT * FROM suppliers WHERE lower(trim(name))=lower(?)',name);
 if(found){if(!found.active)throw new AppError('Este fornecedor está inativo. Reative em Financeiro › Configurações.',409);return found;}
 const sid=id();
 await ex.run('INSERT INTO suppliers(id,name,active,created_at,created_by) VALUES(?,?,1,?,?)',sid,name,now(),a.id);
 await audit(ex,a,'Financeiro: fornecedor cadastrado',sid,{name,onTheFly:true});
 return {id:sid,name,active:1};
}

export async function financeRequestsMutate(path:string,b:Row,member:Member){
 const a=await finance(member);

 if(path==='finance/config/client'){
  const org=await db().first('SELECT id,name FROM requester_orgs WHERE id=?',required(b.orgId,'Cliente',100));
  if(!org||!inScope(a,org.id))throw new AppError('Cliente não encontrado ou fora do seu acesso.',404);
  const enabled=b.enabled===false?0:1,t=now();
  await db().tx(async tx=>{
   await tx.run('INSERT INTO finance_clients(org_id,enabled,created_at,created_by,created_by_name) VALUES(?,?,?,?,?) ON CONFLICT (org_id) DO UPDATE SET enabled=excluded.enabled,updated_at=?',org.id,enabled,t,a.id,a.name,t);
   await audit(tx,a,enabled?'Financeiro: cliente habilitado para recobráveis':'Financeiro: cliente desabilitado para recobráveis',org.id,{org:org.name});
  });
  return {ok:true,message:enabled?`${org.name} habilitado para recobráveis.`:`${org.name} não aparece mais nas solicitações novas.`};
 }

 if(path==='finance/config/rate'){
  const org=await db().first('SELECT id,name FROM requester_orgs WHERE id=?',required(b.orgId,'Cliente',100));
  if(!org||!inScope(a,org.id))throw new AppError('Cliente não encontrado ou fora do seu acesso.',404);
  const marginBp=percentBp(b.margin,'Margem'),taxBp=percentBp(b.tax,'Impostos'),validFrom=isoDay(b.validFrom),rid=id();
  if(await db().first('SELECT 1 FROM finance_client_rates WHERE org_id=? AND valid_from=?',org.id,validFrom))throw new AppError('Já existe uma vigência nessa data para este cliente.',409);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO finance_client_rates(id,org_id,margin_bp,tax_bp,valid_from,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?)',rid,org.id,marginBp,taxBp,validFrom,now(),a.id,a.name);
   await audit(tx,a,'Financeiro: margem e impostos cadastrados',rid,{org:org.name,marginBp,taxBp,validFrom});
  });
  return {id:rid,message:'Vigência cadastrada. Solicitações já criadas mantêm os percentuais da época.'};
 }

 if(path==='finance/suppliers'){
  const name=required(b.name,'Nome do fornecedor',160).replace(/\s+/g,' '),cnpj=text(b.cnpj,20)||null,contact=text(b.contact,200)||null,active=b.active===false?0:1;
  try{
   if(b.id){
    const s=await db().first('SELECT * FROM suppliers WHERE id=?',String(b.id));if(!s)throw new AppError('Fornecedor não encontrado.',404);
    await db().tx(async tx=>{await tx.run('UPDATE suppliers SET name=?,cnpj=?,contact=?,active=? WHERE id=?',name,cnpj,contact,active,s.id);await audit(tx,a,'Financeiro: fornecedor atualizado',s.id,{before:{name:s.name,active:s.active},after:{name,active}});});
    return {id:s.id,message:'Fornecedor atualizado.'};
   }
   const sid=id();
   await db().tx(async tx=>{await tx.run('INSERT INTO suppliers(id,name,cnpj,contact,active,created_at,created_by) VALUES(?,?,?,?,?,?,?)',sid,name,cnpj,contact,active,now(),a.id);await audit(tx,a,'Financeiro: fornecedor cadastrado',sid,{name});});
   return {id:sid,message:'Fornecedor cadastrado.'};
  }catch(e){dbError(e);}
 }

 if(path==='finance/requests/save'){
  const org=await db().first('SELECT o.id,o.name,o.active,c.enabled FROM requester_orgs o LEFT JOIN finance_clients c ON c.org_id=o.id WHERE o.id=?',required(b.orgId,'Cliente',100));
  if(!org||!inScope(a,org.id))throw new AppError('Cliente não encontrado ou fora do seu acesso.',404);
  if(!org.enabled||!org.active)throw new AppError('Este cliente não está habilitado para recobráveis. Habilite em Financeiro › Configurações.',409);
  const person=await db().first('SELECT id,org_id,active FROM requester_people WHERE id=?',required(b.personId,'Pessoa solicitante',100));
  if(!person||person.org_id!==org.id||!person.active)throw new AppError('Escolha uma pessoa solicitante ativa deste cliente.');
  const activityTypeId=b.activityTypeId?String(b.activityTypeId):null;
  if(activityTypeId&&!await db().first('SELECT 1 FROM activity_types WHERE id=? AND active=1 AND coalesce(system,0)=0',activityTypeId))throw new AppError('Tipo de atividade inválido.');
  const title=activityTypeId?'':required(b.title,'Título da atividade',160);
  const description=text(b.description,2000),notes=text(b.notes,2000);
  const start=instant(b.plannedStart,'Data prevista de início');if(!start)throw new AppError('Informe a data prevista de início.');
  const end=b.plannedEnd?instant(b.plannedEnd,'Data prevista de fim'):null;
  if(end&&ms(end)<=ms(start))throw new AppError('O fim previsto deve ser depois do início.');
  const resources=await resourcesOf(b.resources);
  try{
   if(!b.id){
    const rates=await rateFor(db(),org.id,today());
    if(!rates)throw new AppError('Cadastre margem e impostos do cliente em Financeiro › Configurações.',409);
    const rid=id(),t=now();
    const row=await db().tx(async tx=>{
     const r=await tx.first(`INSERT INTO recovery_requests(id,org_id,requester_person_id,activity_type_id,title,description,planned_start,planned_end,resources,notes,margin_bp,tax_bp,created_at,created_by,created_by_name,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?::text::jsonb,?,?,?,?,?,?,?) RETURNING number`,rid,org.id,person.id,activityTypeId,title,description,start,end,JSON.stringify(resources),notes,rates.marginBp,rates.taxBp,t,a.id,a.name,t);
     await audit(tx,a,'Financeiro: solicitação de recobrável criada',rid,{number:r!.number,org:org.name,marginBp:rates.marginBp,taxBp:rates.taxBp});
     return r!;
    });
    return {id:rid,number:row.number,rec:recNumber(row.number),message:`${recNumber(row.number)} criada.`};
   }
   const cur=await loadRequest(db(),a,b.id);
   if(cur.status!=='em_cotacao')throw new AppError('Os dados só mudam com a solicitação em cotação.',409);
   if(b.version!==cur.version)throw new AppError('A solicitação foi alterada em outra tela. Atualize para continuar.',409);
   // Mudou o cliente: valem os percentuais do novo cliente no dia em que a solicitação nasceu.
   const rates=org.id===cur.org_id?{marginBp:Number(cur.margin_bp),taxBp:Number(cur.tax_bp)}:await rateFor(db(),org.id,localDay.format(ms(cur.created_at)));
   if(!rates)throw new AppError('Cadastre margem e impostos do cliente em Financeiro › Configurações.',409);
   await db().tx(async tx=>{
    const n=await tx.run(`UPDATE recovery_requests SET org_id=?,requester_person_id=?,activity_type_id=?,title=?,description=?,planned_start=?,planned_end=?,resources=?::text::jsonb,notes=?,margin_bp=?,tax_bp=?,version=version+1,updated_at=?
     WHERE id=? AND version=? AND status='em_cotacao'`,org.id,person.id,activityTypeId,title,description,start,end,JSON.stringify(resources),notes,rates.marginBp,rates.taxBp,now(),cur.id,cur.version);
    if(!n)throw new AppError('A solicitação foi alterada em outra tela. Atualize para continuar.',409);
    await audit(tx,a,'Financeiro: solicitação de recobrável alterada',cur.id,{number:cur.number});
   });
   return {id:cur.id,message:'Solicitação salva.'};
  }catch(e){dbError(e);}
 }

 if(path==='finance/quotes'){
  const r=await loadRequest(db(),a,b.requestId);
  if(r.status!=='em_cotacao')throw new AppError('Esta solicitação não está mais em cotação: reabra a cotação para alterar.',409);
  const valueCents=b.valueCents!=null?Number(b.valueCents):reaisToCents(b.value,'Valor da proposta');
  if(!Number.isInteger(valueCents)||valueCents<0)throw new AppError('Valor da proposta inválido.');
  const fields={proposal:text(b.proposalNumber,60),validUntil:day(b.validUntil,'Validade'),leadTime:text(b.leadTime,80),receivedAt:day(b.receivedAt,'Data de recebimento')||today(),notes:text(b.notes,1000)};
  try{
   return await db().tx(async tx=>{
    const s=await supplierFor(tx,a,b);
    if(b.id){
     const q=await tx.first('SELECT * FROM recovery_quotes WHERE id=? AND request_id=?',String(b.id),r.id);if(!q)throw new AppError('Cotação não encontrada.',404);
     await tx.run('UPDATE recovery_quotes SET supplier_id=?,value_cents=?,proposal_number=?,valid_until=?,lead_time=?,received_at=?,notes=?,updated_at=? WHERE id=?',s.id,valueCents,fields.proposal,fields.validUntil,fields.leadTime,fields.receivedAt,fields.notes,now(),q.id);
     await audit(tx,a,'Financeiro: cotação alterada',r.id,{number:r.number,supplier:s.name,before:Number(q.value_cents),after:valueCents});
     return {id:q.id,message:'Cotação atualizada.'};
    }
    const qid=id();
    await tx.run(`INSERT INTO recovery_quotes(id,request_id,supplier_id,value_cents,proposal_number,valid_until,lead_time,received_at,notes,created_at,created_by,created_by_name,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,qid,r.id,s.id,valueCents,fields.proposal,fields.validUntil,fields.leadTime,fields.receivedAt,fields.notes,now(),a.id,a.name,now());
    await audit(tx,a,'Financeiro: cotação registrada',r.id,{number:r.number,supplier:s.name,valueCents});
    const n=Number((await tx.first('SELECT count(*)::int n FROM recovery_quotes WHERE request_id=?',r.id))!.n);
    return {id:qid,message:`Cotação registrada (${n} de 3).`};
   });
  }catch(e){dbError(e);}
 }

 throw new AppError('Ação não encontrada.',404);
}
