// Cadastros gerais: solicitantes, locais, tipos e equipamentos, colaboradores e funções,
// modelos de checklist e categorias de apontamentos. Toda alteração grava auditoria na
// mesma transação; o gatilho de auditoria confere o acesso também no banco.
import {db,type Executor,type Row} from './db';
import {AppError,required,text,email} from './domain';
import {type Member,isManager,requireCapability} from './permissions';
import {defaultPassword,TEMPORARY_PASSWORD_DAYS} from './auth';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const flag=(value:unknown)=>value===false||value===0?0:1;
const bool=(value:unknown)=>value===true||value===1?1:0;
const idOf=(value:unknown,label:string)=>required(value,label,100);
const all=(q:string,...v:unknown[])=>db().all(q,...v);
const first=(q:string,...v:unknown[])=>db().first(q,...v);

export function audit(tx:Executor,a:Member,action:string,entityId:string,detail:unknown){
 return tx.run('INSERT INTO audits(id,action,entity_id,author_id,author_name,created_at,detail) VALUES(?,?,?,?,?,?,?)',id(),action,entityId,a.id,a.name,now(),JSON.stringify(detail??{}));
}
/** Lista de IDs (sem repetição) enviada pela tela. */
export function idList(value:unknown,label:string,max=200){
 if(value==null)return [] as string[];
 if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||!v||v.length>100))throw new AppError(`${label}: seleção inválida.`);
 return [...new Set(value as string[])];
}
/** Controle de versão otimista: recusa gravar sobre um cadastro alterado por outra pessoa. */
function fresh(old:Row|null,b:Row){
 if(old&&b.updatedAt!==old.updated_at)throw new AppError('Este cadastro foi alterado por outra pessoa. Atualize a tela e confira antes de salvar.',409);
}
async function existing(table:string,value:unknown,label:string){
 if(!value)return null;
 const row=await first(`SELECT * FROM ${table} WHERE id=?`,idOf(value,label));
 if(!row)throw new AppError(`${label} não encontrado.`,404);
 return row;
}
/** Confere que todos os IDs existem e estão ativos (ou já estavam vinculados antes). */
async function activeIds(table:string,ids:string[],label:string,keep:string[]=[]){
 if(!ids.length)return;
 const rows=await all(`SELECT id,active FROM ${table} WHERE id = ANY(?::text[])`,ids);
 for(const v of ids){const r=rows.find(x=>x.id===v);if(!r||(!r.active&&!keep.includes(v)))throw new AppError(`${label}: há item inativo ou inexistente na seleção.`);}
}

const COLOR=/^#[0-9A-F]{6}$/;
const MOMENTS=['pre_atividade','pre_uso','durante','pos_atividade'];
const ANSWERS=['C','NC','NA'];

export async function registryState(member:Member){
 const a=await requireCapability(member,'cadastros');
 const manager=isManager(a);
 const none=Promise.resolve([] as Row[]);
 const [orgs,people,locations,equipmentTypes,equipment,fuels,functions,operators,categories,templates,versions,questions,links,activityTypes,members,audits]=await Promise.all([
  all('SELECT * FROM requester_orgs ORDER BY name'),
  all('SELECT * FROM requester_people ORDER BY name'),
  all('SELECT * FROM locations ORDER BY name'),
  all('SELECT t.*,(SELECT count(*) FROM equipment e WHERE e.type_id=t.id) equipment_count FROM equipment_types t ORDER BY name'),
  all('SELECT * FROM equipment ORDER BY tag'),
  all('SELECT id,name,active FROM fuels ORDER BY name'),
  all('SELECT * FROM job_functions ORDER BY name'),
  all("SELECT o.*,coalesce(array_agg(f.function_id) FILTER (WHERE f.function_id IS NOT NULL),'{}') function_ids,m.name member_name,m.username member_username FROM operators o LEFT JOIN operator_functions f ON f.operator_id=o.id LEFT JOIN members m ON m.id=o.member_id GROUP BY o.id,m.name,m.username ORDER BY o.name"),
  all('SELECT * FROM occurrence_categories ORDER BY kind,name'),
  all('SELECT * FROM checklist_templates ORDER BY code'),
  all('SELECT v.* FROM checklist_versions v JOIN checklist_templates t ON t.id=v.template_id AND t.current_version=v.version'),
  all('SELECT q.* FROM checklist_questions q JOIN checklist_versions v ON v.id=q.version_id JOIN checklist_templates t ON t.id=v.template_id AND t.current_version=v.version ORDER BY q.position'),
  all('SELECT l.* FROM checklist_links l JOIN checklist_versions v ON v.id=l.version_id JOIN checklist_templates t ON t.id=v.template_id AND t.current_version=v.version'),
  all('SELECT id,code,name,active FROM activity_types ORDER BY name'),
  manager?all('SELECT id,username,email,name,profile AS role,capabilities,notify_requests,notify_schedule,active,created_at,must_change_password,password_changed_at,locked_until,last_login_at FROM members ORDER BY name'):none,
  manager?all('SELECT * FROM audits ORDER BY created_at DESC LIMIT 150'):none,
 ]);
 const checklists:Row[]=templates.map(t=>{
  const v=versions.find(x=>x.template_id===t.id);
  const own=links.filter(l=>l.version_id===v?.id);
  return {...t,current:v?{...v,questions:questions.filter(q=>q.version_id===v.id),activity_type_ids:own.filter(l=>l.activity_type_id).map(l=>l.activity_type_id),equipment_ids:own.filter(l=>l.equipment_id).map(l=>l.equipment_id),equipment_type_ids:own.filter(l=>l.equipment_type_id).map(l=>l.equipment_type_id)}:null};
 });
 let standard:string|null=null;
 if(manager){try{standard=defaultPassword();}catch{standard=null;}}
 return {
  actor:{id:a.id,manager},
  orgs,people,locations,equipmentTypes,equipment,fuels,functions,operators,categories,checklists,activityTypes,
  members,audits,...(manager?{access:{defaultPassword:standard,temporaryPasswordDays:TEMPORARY_PASSWORD_DAYS}}:{}),
  generatedAt:now(),
 };
}

export async function checklistVersions(member:Member,templateId:string){
 await requireCapability(member,'cadastros');
 return {versions:await all('SELECT id,version,title,notes,created_at,created_by_name FROM checklist_versions WHERE template_id=? ORDER BY version DESC',idOf(templateId,'Checklist'))};
}

export async function registryMutate(path:string,b:Row,member:Member){
 const a=await requireCapability(member,'cadastros');
 const t=now();

 if(path==='registry/orgs'){
  const old=await existing('requester_orgs',b.id,'Organização');fresh(old,b);
  const name=required(b.name,'Nome',120),acronym=required(b.acronym,'Sigla',12).toUpperCase(),color=required(b.color,'Cor',30).toUpperCase();
  if(!['interna','cliente'].includes(b.category))throw new AppError('Escolha a categoria: operação interna ou cliente.');
  if(!/^[A-Z0-9][A-Z0-9 ._-]{0,11}$/.test(acronym))throw new AppError('Sigla deve ter até 12 letras ou números.');
  if(!COLOR.test(color))throw new AppError('Cor inválida. Use o formato #RRGGBB.');
  const oid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO requester_orgs(id,name,acronym,category,color,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,acronym=excluded.acronym,category=excluded.category,color=excluded.color,active=excluded.active,updated_at=excluded.updated_at',oid,name,acronym,b.category,color,active,old?.created_at||t,t);
   await audit(tx,a,old?'Cadastros gerais: organização atualizada':'Cadastros gerais: organização cadastrada',oid,{before:old,after:{name,acronym,category:b.category,color,active}});
  });
  return {id:oid};
 }

 if(path==='registry/people'){
  const old=await existing('requester_people',b.id,'Pessoa solicitante');fresh(old,b);
  const name=required(b.name,'Nome',180),role=text(b.role,120),phone=text(b.phone,40),addr=b.email?email(b.email):null;
  const org=await existing('requester_orgs',idOf(b.orgId,'Organização'),'Organização');
  if(!org?.active&&org?.id!==old?.org_id)throw new AppError('Escolha uma organização ativa.');
  const pid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO requester_people(id,org_id,name,role,email,phone,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET org_id=excluded.org_id,name=excluded.name,role=excluded.role,email=excluded.email,phone=excluded.phone,active=excluded.active,updated_at=excluded.updated_at',pid,org!.id,name,role,addr,phone,active,old?.created_at||t,t);
   await audit(tx,a,old?'Cadastros gerais: solicitante atualizado':'Cadastros gerais: solicitante cadastrado',pid,{before:old,after:{orgId:org!.id,name,role,email:addr,phone,active}});
  });
  return {id:pid};
 }

 if(path==='registry/locations'){
  const old=await existing('locations',b.id,'Local');fresh(old,b);
  const kind=old?.kind||b.kind;
  if(!['unidade','area','local'].includes(kind))throw new AppError('Escolha o nível: unidade, área ou local.');
  const name=required(b.name,'Nome',120),code=text(b.code,30).toUpperCase(),description=text(b.description,500);
  const parent=kind==='unidade'?null:await existing('locations',idOf(b.parentId,kind==='area'?'Unidade':'Unidade ou área'),'Local superior');
  if(parent&&!parent.active&&parent.id!==old?.parent_id)throw new AppError('Escolha um local superior ativo.');
  const lid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO locations(id,parent_id,kind,code,name,description,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,code=excluded.code,name=excluded.name,description=excluded.description,active=excluded.active,updated_at=excluded.updated_at',lid,parent?.id||null,kind,code,name,description,active,old?.created_at||t,t);
   await audit(tx,a,old?'Cadastros gerais: local atualizado':'Cadastros gerais: local cadastrado',lid,{before:old,after:{kind,parentId:parent?.id||null,code,name,active}});
  });
  return {id:lid};
 }

 if(path==='registry/equipment-types'){
  const old=await existing('equipment_types',b.id,'Tipo de equipamento');fresh(old,b);
  const name=required(b.name,'Nome',100),description=text(b.description,500),tid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO equipment_types(id,name,description,active,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,active=excluded.active,updated_at=excluded.updated_at',tid,name,description,active,old?.created_at||t,t);
   // O nome do tipo também aparece nos formulários de abastecimento.
   if(old&&old.name!==name)await tx.run('UPDATE equipment SET type=? WHERE type_id=?',name,tid);
   await audit(tx,a,old?'Cadastros gerais: tipo de equipamento atualizado':'Cadastros gerais: tipo de equipamento cadastrado',tid,{before:old,after:{name,description,active}});
  });
  return {id:tid};
 }

 if(path==='registry/equipment'){
  const old=await existing('equipment',b.id,'Equipamento');
  const tag=required(b.tag,'TAG',60).toUpperCase(),description=required(b.description,'Descrição',250),capacity=text(b.capacity,60);
  const fuelIds=idList(b.fuelIds,'Combustíveis',50);
  if(!fuelIds.length)throw new AppError('Selecione ao menos um combustível compatível.');
  const fuels=await all('SELECT id FROM fuels WHERE active=1');if(fuelIds.some(f=>!fuels.some(v=>v.id===f)))throw new AppError('Combustível inválido.');
  const type=await existing('equipment_types',idOf(b.typeId,'Tipo'),'Tipo de equipamento');
  if(!type?.active&&type?.id!==old?.type_id)throw new AppError('Escolha um tipo de equipamento ativo.');
  const location=b.locationId?await existing('locations',b.locationId,'Local'):null;
  if(location&&!location.active&&location.id!==old?.location_id)throw new AppError('Escolha um local ativo.');
  const eid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO equipment(id,tag,description,type,type_id,location_id,capacity,fuel_ids,active) VALUES(?,?,?,?,?,?,?,?::text[],?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag,description=excluded.description,type=excluded.type,type_id=excluded.type_id,location_id=excluded.location_id,capacity=excluded.capacity,fuel_ids=excluded.fuel_ids,active=excluded.active',eid,tag,description,type!.name,type!.id,location?.id||null,capacity,fuelIds,active);
   await audit(tx,a,old?'Cadastros gerais: equipamento atualizado':'Cadastros gerais: equipamento cadastrado',eid,{before:old,after:{tag,description,typeId:type!.id,locationId:location?.id||null,capacity,fuelIds,active}});
  });
  return {id:eid};
 }

 if(path==='registry/functions'){
  const old=await existing('job_functions',b.id,'Função');fresh(old,b);
  const name=required(b.name,'Nome',100),description=text(b.description,500),fid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO job_functions(id,name,description,active,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,active=excluded.active,updated_at=excluded.updated_at',fid,name,description,active,old?.created_at||t,t);
   await audit(tx,a,old?'Cadastros gerais: função atualizada':'Cadastros gerais: função cadastrada',fid,{before:old,after:{name,description,active}});
  });
  return {id:fid};
 }

 if(path==='registry/operators'){
  const old=await existing('operators',b.id,'Colaborador');
  const name=required(b.name,'Nome',180),badge=text(b.badge,60),functionIds=idList(b.functionIds,'Funções',30);
  const before=old?(await all('SELECT function_id FROM operator_functions WHERE operator_id=?',old.id)).map(r=>r.function_id as string):[];
  await activeIds('job_functions',functionIds,'Funções',before);
  // Vincular um usuário de acesso é decisão do gestor (gestão de acessos).
  const memberId=b.memberId?idOf(b.memberId,'Usuário'):null;
  if((memberId||null)!==(old?.member_id||null)){
   if(!isManager(a))throw new AppError('Somente o gestor vincula colaboradores a usuários de acesso.',403);
   if(memberId&&!await first('SELECT id FROM members WHERE id=?',memberId))throw new AppError('Usuário não encontrado.',404);
  }
  const oid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO operators(id,name,badge,active,member_id) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,badge=excluded.badge,active=excluded.active,member_id=excluded.member_id',oid,name,badge,active,memberId);
   await tx.run('DELETE FROM operator_functions WHERE operator_id=?',oid);
   for(const f of functionIds)await tx.run('INSERT INTO operator_functions(operator_id,function_id) VALUES(?,?)',oid,f);
   await audit(tx,a,old?'Cadastros gerais: colaborador atualizado':'Cadastros gerais: colaborador cadastrado',oid,{before:old?{...old,functionIds:before}:null,after:{name,badge,functionIds,memberId,active}});
  });
  return {id:oid};
 }

 if(path==='registry/categories'){
  const old=await existing('occurrence_categories',b.id,'Categoria');fresh(old,b);
  const kind=old?.kind||b.kind;
  if(!['ocorrencia','impacto','bloqueio'].includes(kind))throw new AppError('Escolha o tipo: ocorrência, impacto ou bloqueio.');
  const name=required(b.name,'Nome',100),description=text(b.description,500),cid=old?.id||id(),active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('INSERT INTO occurrence_categories(id,kind,name,description,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,active=excluded.active,updated_at=excluded.updated_at',cid,kind,name,description,active,old?.created_at||t,t);
   await audit(tx,a,old?'Cadastros gerais: categoria atualizada':'Cadastros gerais: categoria cadastrada',cid,{before:old,after:{kind,name,description,active}});
  });
  return {id:cid};
 }

 if(path==='registry/checklists')return saveChecklist(b,a);

 if(path==='registry/checklists/status'){
  const old=await existing('checklist_templates',idOf(b.id,'Checklist'),'Checklist');fresh(old,b);
  const active=flag(b.active);
  await db().tx(async tx=>{
   await tx.run('UPDATE checklist_templates SET active=?,updated_at=? WHERE id=?',active,t,old!.id);
   await audit(tx,a,active?'Cadastros gerais: checklist reativado':'Cadastros gerais: checklist inativado',old!.id,{code:old!.code});
  });
  return {ok:true};
 }

 throw new AppError('Ação não encontrada.',404);
}

/** Normaliza perguntas e vínculos; a comparação evita criar versão idêntica à vigente. */
function checklistContent(b:Row){
 const title=required(b.title,'Título',160),description=text(b.description,1000),instructions=text(b.instructions,2000),notes=text(b.notes,500);
 if(!MOMENTS.includes(b.moment))throw new AppError('Escolha o momento de aplicação.');
 if(!Array.isArray(b.questions)||!b.questions.length)throw new AppError('Inclua ao menos uma pergunta.');
 if(b.questions.length>150)throw new AppError('Use no máximo 150 perguntas por checklist.');
 const questions=b.questions.map((q:Row,i:number)=>{
  if(!q||typeof q!=='object')throw new AppError('Pergunta inválida.');
  const label=`Pergunta ${i+1}`;
  const textValue=required(q.text,label,500);
  if(!['atividade','equipamento'].includes(q.target))throw new AppError(`${label}: indique se a pergunta é sobre a atividade ou o equipamento.`);
  const answers=(v:unknown,what:string)=>{const list=idList(v,`${label} · ${what}`,3);if(list.some(x=>!ANSWERS.includes(x)))throw new AppError(`${label}: resposta inválida em ${what}.`);return ANSWERS.filter(x=>list.includes(x));};
  const allowNa=bool(q.allowNa),noteOn=answers(q.noteOn,'observação obrigatória'),evidenceOn=answers(q.evidenceOn,'anexo obrigatório');
  if(!allowNa&&(noteOn.includes('NA')||evidenceOn.includes('NA')))throw new AppError(`${label}: N/A não é permitido, então não pode exigir observação ou anexo para N/A.`);
  return {text:textValue,required:bool(q.required),critical:bool(q.critical),target:q.target as string,allowNa,noteOn,evidenceOn};
 });
 const links=b.links&&typeof b.links==='object'?b.links:{};
 const activityTypeIds=idList(links.activityTypeIds,'Tipos de atividade').sort(),equipmentIds=idList(links.equipmentIds,'Equipamentos').sort(),equipmentTypeIds=idList(links.equipmentTypeIds,'Tipos de equipamento').sort();
 const generalUse=bool(b.generalUse);
 if(!generalUse&&!activityTypeIds.length&&!equipmentIds.length&&!equipmentTypeIds.length)throw new AppError('Vincule o checklist a tipos de atividade, equipamentos ou tipos de equipamento, ou marque “uso geral”.');
 return {title,description,instructions,notes,moment:b.moment as string,mandatory:bool(b.mandatory),generalUse,questions,activityTypeIds,equipmentIds,equipmentTypeIds};
}

async function saveChecklist(b:Row,a:Member){
 const old=await existing('checklist_templates',b.id,'Checklist');
 const c=checklistContent(b);
 let current:Row|null=null,before:{activity:string[],equipment:string[],types:string[]}={activity:[],equipment:[],types:[]};
 if(old){
  if(b.expectedVersion!==old.current_version)throw new AppError('Este checklist ganhou uma nova versão enquanto você editava. Atualize a tela e confira antes de salvar.',409);
  current=await first('SELECT * FROM checklist_versions WHERE template_id=? AND version=?',old.id,old.current_version);
  const qs=await all('SELECT * FROM checklist_questions WHERE version_id=? ORDER BY position',current!.id);
  const ls=await all('SELECT * FROM checklist_links WHERE version_id=?',current!.id);
  before={activity:ls.filter(l=>l.activity_type_id).map(l=>l.activity_type_id).sort(),equipment:ls.filter(l=>l.equipment_id).map(l=>l.equipment_id).sort(),types:ls.filter(l=>l.equipment_type_id).map(l=>l.equipment_type_id).sort()};
  const same=JSON.stringify({title:current!.title,description:current!.description,instructions:current!.instructions,moment:current!.moment,mandatory:current!.mandatory,generalUse:current!.general_use,questions:qs.map(q=>({text:q.text,required:q.required,critical:q.critical,target:q.target,allowNa:q.allow_na,noteOn:q.note_on,evidenceOn:q.evidence_on})),activityTypeIds:before.activity,equipmentIds:before.equipment,equipmentTypeIds:before.types})
   ===JSON.stringify({title:c.title,description:c.description,instructions:c.instructions,moment:c.moment,mandatory:c.mandatory,generalUse:c.generalUse,questions:c.questions,activityTypeIds:c.activityTypeIds,equipmentIds:c.equipmentIds,equipmentTypeIds:c.equipmentTypeIds});
  if(same)return {id:old.id,version:old.current_version,unchanged:true,message:'Nenhuma alteração: a versão vigente foi mantida.'};
 }
 await activeIds('activity_types',c.activityTypeIds,'Tipos de atividade',before.activity);
 await activeIds('equipment',c.equipmentIds,'Equipamentos',before.equipment);
 await activeIds('equipment_types',c.equipmentTypeIds,'Tipos de equipamento',before.types);
 const code=old?.code||required(b.code,'Código',20).toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9._-]{1,19}$/.test(code))throw new AppError('Código deve ter de 2 a 20 letras, números, ponto, hífen ou sublinhado.');
 const tid=old?.id||id(),version=(old?.current_version||0)+1,vid=id(),t=now();
 await db().tx(async tx=>{
  if(old){
   const changed=await tx.run('UPDATE checklist_templates SET current_version=?,updated_at=? WHERE id=? AND current_version=?',version,t,tid,old.current_version);
   if(!changed)throw new AppError('Este checklist ganhou uma nova versão enquanto você editava. Atualize a tela.',409);
  }else await tx.run('INSERT INTO checklist_templates(id,code,active,current_version,created_at,created_by,updated_at) VALUES(?,?,1,1,?,?,?)',tid,code,t,a.id,t);
  await tx.run('INSERT INTO checklist_versions(id,template_id,version,title,description,instructions,moment,mandatory,general_use,notes,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',vid,tid,version,c.title,c.description,c.instructions,c.moment,c.mandatory,c.generalUse,c.notes,t,a.id,a.name);
  for(const [i,q] of c.questions.entries())await tx.run('INSERT INTO checklist_questions(id,version_id,position,text,required,critical,target,allow_na,note_on,evidence_on) VALUES(?,?,?,?,?,?,?,?,?::text[],?::text[])',id(),vid,i+1,q.text,q.required,q.critical,q.target,q.allowNa,q.noteOn,q.evidenceOn);
  for(const v of c.activityTypeIds)await tx.run('INSERT INTO checklist_links(id,version_id,activity_type_id) VALUES(?,?,?)',id(),vid,v);
  for(const v of c.equipmentIds)await tx.run('INSERT INTO checklist_links(id,version_id,equipment_id) VALUES(?,?,?)',id(),vid,v);
  for(const v of c.equipmentTypeIds)await tx.run('INSERT INTO checklist_links(id,version_id,equipment_type_id) VALUES(?,?,?)',id(),vid,v);
  await audit(tx,a,old?'Cadastros gerais: nova versão de checklist':'Cadastros gerais: checklist cadastrado',tid,{code,version,title:c.title,questions:c.questions.length,critical:c.questions.filter(q=>q.critical).length,notes:c.notes});
 });
 return {id:tid,version,message:old?`Versão ${version} publicada. Preenchimentos anteriores continuam na versão em que foram feitos.`:'Checklist cadastrado (versão 1).'};
}
