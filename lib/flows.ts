// Planejamento › Cadastro de fluxo: tipos de atividade e versões imutáveis de etapas,
// dependências (término → início) e necessidades padrão de equipamentos e colaboradores.
import {db,type Executor,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,requireCapability} from './permissions';
import {audit,idList} from './registry';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const all=(q:string,...v:unknown[])=>db().all(q,...v);
const first=(q:string,...v:unknown[])=>db().first(q,...v);
const idOf=(value:unknown,label:string)=>required(value,label,100);
const CODE=/^[A-Z0-9][A-Z0-9._-]{1,19}$/;

type Need={equipmentTypeId:string|null;functionId:string|null;quantity:number};
type Step={key:string;name:string;description:string;defaultMinutes:number|null;required:number;dependsOn:string[];needs:Need[]};

async function versionSteps(versionIds:string[]){
 if(!versionIds.length)return [] as Row[];
 const [steps,deps,needs]=await Promise.all([
  all('SELECT * FROM flow_steps WHERE flow_version_id = ANY(?::text[]) ORDER BY position',versionIds),
  all('SELECT d.flow_version_id,s.step_key,p.step_key depends_on FROM flow_dependencies d JOIN flow_steps s ON s.id=d.step_id JOIN flow_steps p ON p.id=d.depends_on_id WHERE d.flow_version_id = ANY(?::text[])',versionIds),
  all('SELECT * FROM flow_step_needs WHERE flow_version_id = ANY(?::text[])',versionIds),
 ]);
 return steps.map(s=>({...s,depends_on:deps.filter(d=>d.flow_version_id===s.flow_version_id&&d.step_key===s.step_key).map(d=>d.depends_on),needs:needs.filter(n=>n.step_id===s.id).map(n=>({equipment_type_id:n.equipment_type_id,function_id:n.function_id,quantity:n.quantity}))}));
}

export async function flowsState(member:Member){
 await requireCapability(member,'planejamento');
 const [types,versions,equipmentTypes,functions]=await Promise.all([
  all('SELECT * FROM activity_types WHERE system=0 ORDER BY name'),
  all('SELECT id,activity_type_id,version,name,description,notes,created_at,created_by_name FROM flow_versions ORDER BY version DESC'),
  all('SELECT id,name,active FROM equipment_types ORDER BY name'),
  all('SELECT id,name,active FROM job_functions ORDER BY name'),
 ]);
 const current=types.map(t=>versions.find(v=>v.activity_type_id===t.id&&v.version===t.current_version)).filter(Boolean) as Row[];
 const steps=await versionSteps(current.map(v=>v.id));
 return {
  activityTypes:types.map((t):Row=>{const v=current.find(x=>x.activity_type_id===t.id);return {...t,versions:versions.filter(x=>x.activity_type_id===t.id),steps:v?steps.filter(s=>s.flow_version_id===v.id):[]};}),
  equipmentTypes,functions,generatedAt:now(),
 };
}

/** Consulta de uma versão anterior (somente leitura). */
export async function flowVersion(member:Member,versionId:string){
 await requireCapability(member,'planejamento');
 const v=await first('SELECT * FROM flow_versions WHERE id=?',idOf(versionId,'Versão'));
 if(!v)throw new AppError('Versão não encontrada.',404);
 return {version:v,steps:await versionSteps([v.id]) as Row[]};
}

/** Valida etapas, dependências sem ciclo e necessidades; devolve na ordem de exibição. */
export function normalizeSteps(value:unknown):Step[]{
 if(!Array.isArray(value)||!value.length)throw new AppError('Inclua ao menos uma etapa.');
 if(value.length>60)throw new AppError('Use no máximo 60 etapas por fluxo.');
 const keys=new Set<string>();
 const steps=value.map((raw:Row,i:number)=>{
  if(!raw||typeof raw!=='object')throw new AppError('Etapa inválida.');
  const label=`Etapa ${i+1}`;
  const key=required(raw.key,`${label}: identificador`,60);
  if(!/^[A-Za-z0-9_-]{4,60}$/.test(key)||keys.has(key))throw new AppError(`${label}: identificador inválido ou repetido.`);
  keys.add(key);
  const minutes=raw.defaultMinutes===''||raw.defaultMinutes==null?null:Number(raw.defaultMinutes);
  if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>525600))throw new AppError(`${label}: duração padrão deve ser em minutos inteiros (até 1 ano).`);
  if(raw.needs!=null&&(!Array.isArray(raw.needs)||raw.needs.length>30))throw new AppError(`${label}: necessidades inválidas.`);
  const seen=new Set<string>();
  const needs=((raw.needs||[]) as Row[]).map(n=>{
   const equipmentTypeId=n?.equipmentTypeId?idOf(n.equipmentTypeId,'Tipo de equipamento'):null,functionId=n?.functionId?idOf(n.functionId,'Função'):null;
   if((equipmentTypeId?1:0)+(functionId?1:0)!==1)throw new AppError(`${label}: cada necessidade é um tipo de equipamento ou uma função.`);
   const quantity=Number(n.quantity);
   if(!Number.isInteger(quantity)||quantity<1||quantity>99)throw new AppError(`${label}: quantidade deve ser de 1 a 99.`);
   const k=(equipmentTypeId||'')+'|'+(functionId||'');if(seen.has(k))throw new AppError(`${label}: necessidade repetida. Ajuste a quantidade em vez de repetir.`);seen.add(k);
   return {equipmentTypeId,functionId,quantity};
  });
  return {key,name:required(raw.name,`${label}: nome`,120),description:text(raw.description,1000),defaultMinutes:minutes,required:raw.required===false?0:1,dependsOn:idList(raw.dependsOn,`${label}: dependências`,60),needs};
 });
 for(const s of steps){
  if(s.dependsOn.includes(s.key))throw new AppError(`A etapa “${s.name}” não pode depender de si mesma.`);
  const missing=s.dependsOn.find(d=>!keys.has(d));if(missing)throw new AppError(`A etapa “${s.name}” depende de uma etapa que não está no fluxo.`);
 }
 // Kahn: se sobrar etapa sem ordem possível, existe ciclo.
 const pending=new Map(steps.map(s=>[s.key,new Set(s.dependsOn)]));
 let progress=true;
 while(pending.size&&progress){progress=false;for(const [k,deps] of pending){if([...deps].every(d=>!pending.has(d))){pending.delete(k);progress=true;}}}
 if(pending.size){const names=steps.filter(s=>pending.has(s.key)).map(s=>s.name).join(', ');throw new AppError(`Dependência circular entre as etapas: ${names}.`);}
 return steps;
}

async function checkNeeds(steps:Step[],keep:Step[]=[]){
 const kept=new Set(keep.flatMap(s=>s.needs.map(n=>n.equipmentTypeId||n.functionId)));
 const types=[...new Set(steps.flatMap(s=>s.needs.map(n=>n.equipmentTypeId).filter(Boolean)))] as string[];
 const fns=[...new Set(steps.flatMap(s=>s.needs.map(n=>n.functionId).filter(Boolean)))] as string[];
 const [tr,fr]=await Promise.all([types.length?all('SELECT id,active FROM equipment_types WHERE id = ANY(?::text[])',types):[],fns.length?all('SELECT id,active FROM job_functions WHERE id = ANY(?::text[])',fns):[]]);
 for(const v of types){const r=tr.find(x=>x.id===v);if(!r||(!r.active&&!kept.has(v)))throw new AppError('Há tipo de equipamento inativo ou inexistente nas necessidades.');}
 for(const v of fns){const r=fr.find(x=>x.id===v);if(!r||(!r.active&&!kept.has(v)))throw new AppError('Há função inativa ou inexistente nas necessidades.');}
}

function asSteps(rows:Row[]):Step[]{
 return rows.map(s=>({key:s.step_key,name:s.name,description:s.description,defaultMinutes:s.default_minutes,required:s.required,dependsOn:[...s.depends_on].sort(),needs:s.needs.map((n:Row)=>({equipmentTypeId:n.equipment_type_id,functionId:n.function_id,quantity:n.quantity})).sort((x:Need,y:Need)=>((x.equipmentTypeId||'')+(x.functionId||'')).localeCompare((y.equipmentTypeId||'')+(y.functionId||'')))}));
}
const canonical=(name:string,description:string,steps:Step[])=>JSON.stringify({name,description,steps:steps.map(s=>({...s,dependsOn:[...s.dependsOn].sort(),needs:[...s.needs].sort((x,y)=>((x.equipmentTypeId||'')+(x.functionId||'')).localeCompare((y.equipmentTypeId||'')+(y.functionId||'')))}))});

async function insertVersion(tx:Executor,a:Member,typeId:string,version:number,name:string,description:string,notes:string,steps:Step[]){
 const vid=id(),t=now(),ids=new Map(steps.map(s=>[s.key,id()]));
 await tx.run('INSERT INTO flow_versions(id,activity_type_id,version,name,description,notes,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?)',vid,typeId,version,name,description,notes,t,a.id,a.name);
 for(const [i,s] of steps.entries())await tx.run('INSERT INTO flow_steps(id,flow_version_id,step_key,position,name,description,default_minutes,required) VALUES(?,?,?,?,?,?,?,?)',ids.get(s.key),vid,s.key,i+1,s.name,s.description,s.defaultMinutes,s.required);
 for(const s of steps){
  for(const d of s.dependsOn)await tx.run('INSERT INTO flow_dependencies(flow_version_id,step_id,depends_on_id) VALUES(?,?,?)',vid,ids.get(s.key),ids.get(d));
  for(const n of s.needs)await tx.run('INSERT INTO flow_step_needs(id,flow_version_id,step_id,equipment_type_id,function_id,quantity) VALUES(?,?,?,?,?,?)',id(),vid,ids.get(s.key),n.equipmentTypeId,n.functionId,n.quantity);
 }
 return vid;
}

export async function flowsMutate(path:string,b:Row,member:Member){
 const a=await requireCapability(member,'planejamento');
 const t=now();

 if(path==='flows/save'){
  const old=b.id?await first('SELECT * FROM activity_types WHERE id=? AND system=0',idOf(b.id,'Tipo de atividade')):null;
  if(b.id&&!old)throw new AppError('Tipo de atividade não encontrado.',404);
  const name=required(b.name,'Nome',120),description=text(b.description,1000),notes=text(b.notes,500);
  const steps=normalizeSteps(b.steps);
  let previous:Step[]=[];
  if(old){
   if(b.expectedVersion!==old.current_version)throw new AppError('Este fluxo ganhou uma nova versão enquanto você editava. Atualize a tela e confira antes de salvar.',409);
   const v=await first('SELECT id,name,description FROM flow_versions WHERE activity_type_id=? AND version=?',old.id,old.current_version);
   previous=asSteps(await versionSteps([v!.id]));
   if(canonical(v!.name,v!.description,previous)===canonical(name,description,steps))return {id:old.id,version:old.current_version,unchanged:true,message:'Nenhuma alteração: a versão vigente foi mantida.'};
  }
  await checkNeeds(steps,previous);
  const code=old?.code||required(b.code,'Código',20).toUpperCase();
  if(!CODE.test(code))throw new AppError('Código deve ter de 2 a 20 letras, números, ponto, hífen ou sublinhado.');
  if(code.startsWith('SYS.'))throw new AppError('Códigos iniciados por SYS. são reservados ao sistema.');
  const tid=old?.id||id(),version=(old?.current_version||0)+1;
  await db().tx(async tx=>{
   if(old){
    const changed=await tx.run('UPDATE activity_types SET name=?,description=?,current_version=?,updated_at=? WHERE id=? AND current_version=?',name,description,version,t,tid,old.current_version);
    if(!changed)throw new AppError('Este fluxo ganhou uma nova versão enquanto você editava. Atualize a tela.',409);
   }else await tx.run('INSERT INTO activity_types(id,code,name,description,active,current_version,created_at,created_by,updated_at) VALUES(?,?,?,?,1,1,?,?,?)',tid,code,name,description,t,a.id,t);
   await insertVersion(tx,a,tid,version,name,description,notes,steps);
   await audit(tx,a,old?'Fluxo: nova versão':'Fluxo: tipo de atividade cadastrado',tid,{code,version,steps:steps.length,notes});
  });
  return {id:tid,version,message:old?`Versão ${version} publicada. Planejamentos e OS existentes continuam na versão em que foram criados.`:'Fluxo cadastrado (versão 1).'};
 }

 if(path==='flows/duplicate'){
  const source=await first('SELECT * FROM activity_types WHERE id=? AND system=0',idOf(b.id,'Tipo de atividade'));
  if(!source)throw new AppError('Tipo de atividade não encontrado.',404);
  const code=required(b.code,'Código',20).toUpperCase(),name=required(b.name,'Nome',120);
  if(!CODE.test(code))throw new AppError('Código deve ter de 2 a 20 letras, números, ponto, hífen ou sublinhado.');
  if(code.startsWith('SYS.'))throw new AppError('Códigos iniciados por SYS. são reservados ao sistema.');
  const v=await first('SELECT * FROM flow_versions WHERE activity_type_id=? AND version=?',source.id,source.current_version);
  const steps=asSteps(await versionSteps([v!.id]));
  await checkNeeds(steps);
  const tid=id();
  await db().tx(async tx=>{
   await tx.run('INSERT INTO activity_types(id,code,name,description,active,current_version,created_at,created_by,updated_at) VALUES(?,?,?,?,1,1,?,?,?)',tid,code,name,v!.description,t,a.id,t);
   await insertVersion(tx,a,tid,1,name,v!.description,`Cópia de ${source.code} v${source.current_version}`,steps);
   await audit(tx,a,'Fluxo: tipo de atividade duplicado',tid,{code,from:source.code,fromVersion:source.current_version});
  });
  return {id:tid,version:1,message:`Fluxo ${code} criado a partir de ${source.code}.`};
 }

 if(path==='flows/status'){
  const old=await first('SELECT * FROM activity_types WHERE id=? AND system=0',idOf(b.id,'Tipo de atividade'));
  if(!old)throw new AppError('Tipo de atividade não encontrado.',404);
  if(b.updatedAt!==old.updated_at)throw new AppError('Este fluxo foi alterado por outra pessoa. Atualize a tela.',409);
  const active=b.active===false?0:1;
  await db().tx(async tx=>{
   await tx.run('UPDATE activity_types SET active=?,updated_at=? WHERE id=?',active,t,old.id);
   await audit(tx,a,active?'Fluxo: tipo de atividade reativado':'Fluxo: tipo de atividade inativado',old.id,{code:old.code});
  });
  return {ok:true};
 }

 throw new AppError('Ação não encontrada.',404);
}
