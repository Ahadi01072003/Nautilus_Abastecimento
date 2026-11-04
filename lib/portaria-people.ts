// Portaria · visitantes e empresas. Os visitantes e as empresas criadas na hora ficam só na Portaria
// (bloco "Visitantes" em Cadastros › Colaboradores), separados dos colaboradores do Planejamento e do
// cadastro de Solicitantes e clientes. As empresas já cadastradas em Solicitantes e clientes aparecem
// na busca e são espelhadas aqui na primeira vez em que alguém as escolhe (só leitura).
import {db,type Executor,type Row} from './db';
import {audit} from './registry';
import {type Member,isManager} from './permissions';
import {type Actor,id,fail,invalid,portaria,onlyManager,iso,normDocument,maskDocument,idempotent,textField,pageOf,likeOf} from './portaria-core';

export const DOCUMENT_TYPES=['CPF','RG','CNH','PASSAPORTE','OUTRO'];

// ---- Empresas ----

/** Empresa da Portaria a partir de uma referência: id da Portaria ou "org:<id>" (cadastro de Solicitantes). */
export async function resolveCompany(tx:Executor,a:Actor,ref:unknown,field='companyId'){
 const r=String(ref??'');
 if(!r)throw invalid('Escolha a empresa.',field);
 if(r.startsWith('org:')){
  const org=await tx.first('SELECT id,name,active FROM requester_orgs WHERE id=?',r.slice(4));
  if(!org)throw fail(404,'COMPANY_NOT_FOUND','Empresa não encontrada.');
  if(!org.active)throw fail(409,'COMPANY_INACTIVE',`A empresa ${org.name} está inativa. Peça à gestão para reativá-la.`);
  await tx.run("INSERT INTO portaria_companies(id,org_id,name,origin,active,created_by) VALUES(?,?,?,'cadastro',1,?) ON CONFLICT (org_id) DO NOTHING",id(),org.id,org.name,a.id);
  return (await tx.first('SELECT * FROM portaria_companies WHERE org_id=?',org.id))!;
 }
 const c=await tx.first('SELECT c.*,o.active org_active,o.name org_name FROM portaria_companies c LEFT JOIN requester_orgs o ON o.id=c.org_id WHERE c.id=?',r);
 if(!c)throw fail(404,'COMPANY_NOT_FOUND','Empresa não encontrada.');
 if(!c.active||(c.org_id&&!c.org_active))throw fail(409,'COMPANY_INACTIVE',`A empresa ${c.org_name||c.name} está inativa. Peça à gestão para reativá-la.`);
 return {...c,name:c.org_name||c.name};
}

/** Busca de empresas para a lista suspensa: as da Portaria e as de Solicitantes e clientes ainda não espelhadas. */
export async function searchCompanies(member:Member,url:URL){
 const a=await portaria(member);
 const q=(url.searchParams.get('q')||'').trim().slice(0,80),all=url.searchParams.get('all')==='1'&&isManager(a);
 const rows=await db().all(`SELECT * FROM (
   SELECT c.id ref,coalesce(o.name,c.name) name,c.origin,(c.active=1 AND (o.id IS NULL OR o.active=1)) active,
    EXISTS (SELECT 1 FROM portaria_pending_review r WHERE r.kind='empresa' AND r.entity_id=c.id AND r.reviewed_at IS NULL) pending
    FROM portaria_companies c LEFT JOIN requester_orgs o ON o.id=c.org_id
   UNION ALL
   SELECT 'org:'||o.id,o.name,'cadastro',(o.active=1),false FROM requester_orgs o WHERE NOT EXISTS (SELECT 1 FROM portaria_companies c WHERE c.org_id=o.id)
  ) x WHERE (?::boolean OR active) AND name ILIKE ? ORDER BY lower(name) LIMIT 100`,all,likeOf(q));
 return {rows:rows.map(r=>({id:r.ref,name:r.name,origin:r.origin,active:!!r.active,pending:!!r.pending}))};
}

// ---- Visitantes ----

function documentOf(b:Row){
 const type=String(b.documentType||'').toUpperCase();
 if(!DOCUMENT_TYPES.includes(type))throw invalid('Escolha o tipo de documento.','documentType');
 const number=textField(b.documentNumber,'Número do documento','documentNumber',40),norm=normDocument(number);
 if(norm.length<3)throw invalid('Documento inválido: informe ao menos 3 letras ou números.','documentNumber');
 return {type,number,norm};
}

const SELECT_PERSON=`SELECT p.*,coalesce(o.name,c.name) company_name,c.org_id,
  EXISTS (SELECT 1 FROM portaria_visits v WHERE v.person_id=p.id AND v.status='em_andamento') present,
  EXISTS (SELECT 1 FROM portaria_pending_review r WHERE r.kind='pessoa' AND r.entity_id=p.id AND r.reviewed_at IS NULL) pending
  FROM portaria_people p JOIN portaria_companies c ON c.id=p.company_id LEFT JOIN requester_orgs o ON o.id=c.org_id`;

/** Linha de pessoa para listas e buscas: documento mascarado. */
export const personRow=(p:Row)=>({id:p.id,name:p.name,companyId:p.company_id,companyName:p.company_name,documentType:p.document_type,documentMasked:maskDocument(p.document_number),active:!!p.active,present:!!p.present,pending:!!p.pending});

/** Busca paginada para a lista suspensa. O documento só é encontrado pelo número completo. */
export async function searchPeople(member:Member,url:URL){
 await portaria(member);
 const q=(url.searchParams.get('q')||'').trim().slice(0,80),{limit,page,offset}=pageOf(url);
 const norm=normDocument(q),onlyActive=url.searchParams.get('active')==='1';
 const where:string[]=[],values:unknown[]=[];
 if(q){where.push('(p.name ILIKE ? OR coalesce(o.name,c.name) ILIKE ?'+(norm.length>=3?' OR p.document_norm=?':'')+')');values.push(likeOf(q),likeOf(q));if(norm.length>=3)values.push(norm);}
 if(onlyActive)where.push('p.active=1');
 const company=url.searchParams.get('company');if(company){where.push('p.company_id=?');values.push(company);}
 const rows=await db().all(`${SELECT_PERSON}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY lower(p.name),p.id LIMIT ? OFFSET ?`,...values,limit+1,offset);
 return {rows:rows.slice(0,limit).map(personRow),page,limit,hasMore:rows.length>limit};
}

/** Detalhe da pessoa com o documento completo (porteiro e gestão). Cada consulta vai para a auditoria. */
export async function personDetail(member:Member,personId:string){
 const a=await portaria(member);
 const p=await db().first(`${SELECT_PERSON} WHERE p.id=?`,personId);
 if(!p)throw fail(404,'PERSON_NOT_FOUND','Pessoa não encontrada.');
 await db().tx(tx=>audit(tx,a,'Portaria: documento consultado',p.id,{person:p.id,documentMasked:maskDocument(p.document_number)}));
 return {...personRow(p),documentNumber:p.document_number,createdAt:iso(p.created_at)};
}

/** Cadastros feitos na hora aguardando revisão (gestão). */
export async function pendingReview(member:Member,url:URL){
 const a=await portaria(member);onlyManager(a);
 const all=url.searchParams.get('all')==='1';
 const rows=await db().all(`SELECT r.id,r.kind,r.entity_id,r.created_at,r.reviewed_at,m.name created_by_name,rv.name reviewed_by_name,
   CASE WHEN r.kind='pessoa' THEN p.name ELSE c.name END entity_name,
   CASE WHEN r.kind='pessoa' THEN coalesce(po.name,pc.name) END company_name,
   CASE WHEN r.kind='pessoa' THEN p.document_type END document_type
   FROM portaria_pending_review r JOIN members m ON m.id=r.created_by LEFT JOIN members rv ON rv.id=r.reviewed_by
   LEFT JOIN portaria_people p ON r.kind='pessoa' AND p.id=r.entity_id LEFT JOIN portaria_companies pc ON pc.id=p.company_id LEFT JOIN requester_orgs po ON po.id=pc.org_id
   LEFT JOIN portaria_companies c ON r.kind='empresa' AND c.id=r.entity_id
   WHERE (?::boolean OR r.reviewed_at IS NULL) ORDER BY r.created_at DESC LIMIT 500`,all);
 return {rows:rows.map(r=>({id:r.id,kind:r.kind,entityId:r.entity_id,name:r.entity_name,companyName:r.company_name||null,documentType:r.document_type||null,createdByName:r.created_by_name,createdAt:iso(r.created_at),reviewedAt:iso(r.reviewed_at),reviewedByName:r.reviewed_by_name||null}))};
}

/** Lista de visitantes e empresas da Portaria para o bloco de cadastro da gestão. */
export async function registryList(member:Member,url:URL){
 const a=await portaria(member);onlyManager(a);
 const people=await searchPeople(member,url);
 const companies=await db().all(`SELECT c.id,c.name,c.active,EXISTS (SELECT 1 FROM portaria_pending_review r WHERE r.kind='empresa' AND r.entity_id=c.id AND r.reviewed_at IS NULL) pending,
   (SELECT count(*)::int FROM portaria_people p WHERE p.company_id=c.id) people FROM portaria_companies c WHERE c.origin='portaria' ORDER BY lower(c.name)`);
 return {...people,companies:companies.map(c=>({id:c.id,name:c.name,active:!!c.active,pending:!!c.pending,people:c.people}))};
}

export async function portariaPeopleMutate(path:string,b:Row,member:Member){
 const a=await portaria(member);

 if(path==='portaria/company/quick'){
  const name=textField(b.name,'Nome da empresa','name',120);
  return await db().tx(tx=>idempotent(tx,a,b,path,async()=>{
   const org=await tx.first('SELECT id,name,active FROM requester_orgs WHERE lower(trim(name))=lower(?)',name);
   if(org){const c=await resolveCompany(tx,a,'org:'+org.id);return {id:c.id as string,name:org.name as string,created:false,message:`${org.name} já estava cadastrada e foi selecionada.`};}
   const own=await tx.first("SELECT id,name,active FROM portaria_companies WHERE origin='portaria' AND lower(trim(name))=lower(?)",name);
   if(own){
    if(!own.active)throw fail(409,'COMPANY_INACTIVE',`A empresa ${own.name} está inativa. Peça à gestão para reativá-la.`);
    return {id:own.id as string,name:own.name as string,created:false,message:`${own.name} já estava cadastrada e foi selecionada.`};
   }
   const cid=id();
   await tx.run("INSERT INTO portaria_companies(id,name,origin,created_by) VALUES(?,?,'portaria',?)",cid,name,a.id);
   await tx.run('INSERT INTO portaria_pending_review(id,kind,entity_id,created_by) VALUES(?,?,?,?)',id(),'empresa',cid,a.id);
   await audit(tx,a,'Portaria: empresa cadastrada na hora',cid,{name});
   return {id:cid,name,created:true,message:`Empresa ${name} cadastrada. A gestão revisa o cadastro depois.`};
  }));
 }

 if(path==='portaria/person/quick'){
  const name=textField(b.name,'Nome','name',180),doc=documentOf(b);
  return await db().tx(tx=>idempotent(tx,a,b,path,async()=>{
   const company=await resolveCompany(tx,a,b.companyId);
   const dup=await tx.first('SELECT p.name,coalesce(o.name,c.name) company FROM portaria_people p JOIN portaria_companies c ON c.id=p.company_id LEFT JOIN requester_orgs o ON o.id=c.org_id WHERE p.document_type=? AND p.document_norm=?',doc.type,doc.norm);
   if(dup)throw fail(409,'DOCUMENT_DUPLICATE',`Já existe cadastro com este documento: ${dup.name} (${dup.company}). Selecione a pessoa na lista.`,'documentNumber');
   const pid=id();
   try{
    await tx.run('INSERT INTO portaria_people(id,name,document_type,document_number,document_norm,company_id,created_by) VALUES(?,?,?,?,?,?,?)',pid,name,doc.type,doc.number,doc.norm,company.id,a.id);
   }catch(e){if(/portaria_people_document/.test((e as {message?:string}).message||''))throw fail(409,'DOCUMENT_DUPLICATE','Já existe cadastro com este documento. Selecione a pessoa na lista.','documentNumber');throw e;}
   await tx.run('INSERT INTO portaria_pending_review(id,kind,entity_id,created_by) VALUES(?,?,?,?)',id(),'pessoa',pid,a.id);
   await audit(tx,a,'Portaria: visitante cadastrado na hora',pid,{name,company:company.name,documentType:doc.type,documentMasked:maskDocument(doc.number)});
   const p=await tx.first(`${SELECT_PERSON} WHERE p.id=?`,pid);
   return {id:pid,person:personRow(p!),message:`${name} cadastrado. A gestão revisa o cadastro depois.`};
  }));
 }

 // Daqui para baixo: só a gestão.
 onlyManager(a);

 if(path==='portaria/person/save'){
  const name=textField(b.name,'Nome','name',180),doc=documentOf(b),active=b.active===false?0:1;
  return await db().tx(async tx=>{
   const old=b.id?await tx.first('SELECT * FROM portaria_people WHERE id=?',String(b.id)):null;
   if(b.id&&!old)throw fail(404,'PERSON_NOT_FOUND','Pessoa não encontrada.');
   const company=await resolveCompany(tx,a,b.companyId).catch(e=>{if(old&&e.code==='COMPANY_INACTIVE'&&old.company_id===b.companyId)return null;throw e;});
   const companyId=company?.id||old!.company_id;
   const dup=await tx.first('SELECT p.id,p.name FROM portaria_people p WHERE p.document_type=? AND p.document_norm=? AND p.id<>?',doc.type,doc.norm,old?.id||'');
   if(dup)throw fail(409,'DOCUMENT_DUPLICATE',`Já existe cadastro com este documento: ${dup.name}.`,'documentNumber');
   const pid=old?.id||id();
   if(old)await tx.run('UPDATE portaria_people SET name=?,document_type=?,document_number=?,document_norm=?,company_id=?,active=?,updated_at=now() WHERE id=?',name,doc.type,doc.number,doc.norm,companyId,active,pid);
   else await tx.run('INSERT INTO portaria_people(id,name,document_type,document_number,document_norm,company_id,active,created_by) VALUES(?,?,?,?,?,?,?,?)',pid,name,doc.type,doc.number,doc.norm,companyId,active,a.id);
   await audit(tx,a,old?'Portaria: visitante atualizado':'Portaria: visitante cadastrado',pid,{before:old?{name:old.name,companyId:old.company_id,documentMasked:maskDocument(old.document_number),active:!!old.active}:null,after:{name,companyId,documentMasked:maskDocument(doc.number),active:!!active}});
   return {id:pid,message:old?'Visitante atualizado.':'Visitante cadastrado.'};
  });
 }

 if(path==='portaria/company/save'){
  const name=textField(b.name,'Nome da empresa','name',120),active=b.active===false?0:1;
  return await db().tx(async tx=>{
   const old=b.id?await tx.first('SELECT * FROM portaria_companies WHERE id=?',String(b.id)):null;
   if(b.id&&!old)throw fail(404,'COMPANY_NOT_FOUND','Empresa não encontrada.');
   if(old&&old.origin!=='portaria')throw fail(409,'COMPANY_READ_ONLY','Esta empresa vem de Solicitantes e clientes: edite-a lá.');
   const clash=await tx.first("SELECT id FROM portaria_companies WHERE origin='portaria' AND lower(trim(name))=lower(?) AND id<>?",name,old?.id||'')
    ||await tx.first('SELECT id FROM requester_orgs WHERE lower(trim(name))=lower(?)',name);
   if(clash)throw fail(409,'COMPANY_DUPLICATE','Já existe empresa com este nome.','name');
   const cid=old?.id||id();
   if(old)await tx.run('UPDATE portaria_companies SET name=?,active=?,updated_at=now() WHERE id=?',name,active,cid);
   else await tx.run("INSERT INTO portaria_companies(id,name,origin,active,created_by) VALUES(?,?,'portaria',?,?)",cid,name,active,a.id);
   await audit(tx,a,old?'Portaria: empresa atualizada':'Portaria: empresa cadastrada',cid,{before:old?{name:old.name,active:!!old.active}:null,after:{name,active:!!active}});
   return {id:cid,message:old?'Empresa atualizada.':'Empresa cadastrada.'};
  });
 }

 if(path==='portaria/review/mark'){
  return await db().tx(async tx=>{
   const r=await tx.first('SELECT * FROM portaria_pending_review WHERE id=? FOR UPDATE',String(b.id||''));
   if(!r)throw fail(404,'REVIEW_NOT_FOUND','Pendência não encontrada.');
   if(!r.reviewed_at){
    await tx.run('UPDATE portaria_pending_review SET reviewed_at=now(),reviewed_by=? WHERE id=?',a.id,r.id);
    await audit(tx,a,'Portaria: cadastro revisado',r.entity_id,{kind:r.kind});
   }
   return {ok:true,message:'Cadastro marcado como revisado.'};
  });
 }

 throw fail(404,'NOT_FOUND','Ação não encontrada.');
}
