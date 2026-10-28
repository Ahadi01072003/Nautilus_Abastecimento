import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember,seedOperation} from './helpers';
import {mutate} from '../lib/service';
import {registryState,registryMutate} from '../lib/registry';
import {flowsState,flowsMutate,flowVersion} from '../lib/flows';
import {modules} from '../lib/permissions';
import type {Database} from '../lib/db';
import type {Member} from '../lib/permissions';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,clerk:Member,planner:Member,requester:Member;
before(async()=>{
 ctx=await freshDatabase();db=ctx.database;await seedOperation(db);
 manager=await addMember(db,'manager',{mustChange:false});
 clerk=await addMember(db,'fueler');planner=await addMember(db,'planner');requester=await addMember(db,'fueler');
 await mutate('members',{id:clerk.id,username:(clerk as Member&{username:string}).username,name:clerk.name,role:'fueler',capabilities:['cadastros']},manager);
 await mutate('members',{id:planner.id,username:(planner as Member&{username:string}).username,name:planner.name,role:'planner',capabilities:['planejamento']},manager);
 clerk={...clerk,capabilities:['cadastros']};planner={...planner,capabilities:['planejamento']};
});
after(async()=>{await ctx.drop();});

const rejects=(promise:Promise<unknown>,status:number,pattern?:RegExp)=>assert.rejects(promise,(e:{status?:number;message:string})=>{if(status)assert.equal(e.status,status,e.message);if(pattern)assert.match(e.message,pattern);return true;});
const pgRejects=(promise:Promise<unknown>,pattern:RegExp)=>assert.rejects(promise,(e:{message:string;constraint_name?:string})=>{assert.match(e.message+' '+(e.constraint_name||''),pattern);return true;});
const reg=(path:string,b:Record<string,unknown>,who:Member=manager)=>registryMutate('registry/'+path,b,who) as Promise<{id:string;version?:number;unchanged?:boolean}>;
const key=()=>crypto.randomUUID();

test('acessos: módulos por capacidade, revogação imediata e gestão de usuários só do gestor',async()=>{
 assert.ok(modules(clerk).includes('cad-equipamentos'));assert.ok(!modules(clerk).includes('plan-fluxos'));assert.ok(!modules(clerk).includes('exportacao'));
 assert.ok(modules(planner).includes('plan-fluxos'));assert.ok(!modules(requester).some(m=>m.startsWith('cad-')));
 assert.ok(modules(manager).includes('cad-checklists')&&modules(manager).includes('plan-fluxos'));
 await rejects(registryState(requester),403);
 await rejects(reg('functions',{name:'Sem acesso'},requester),403);
 await rejects(flowsState(clerk),403);
 const view=await registryState(clerk);
 assert.deepEqual(view.members,[]);assert.deepEqual(view.audits,[]);assert.equal('access' in view,false);
 // Capacidade inválida e gestor sem lista própria (já tem tudo).
 await rejects(mutate('members',{username:'x.y',name:'X',role:'fueler',capabilities:['root']},manager),400,/inválido/);
 // Revogar o acesso vale na próxima ação, mesmo com a sessão aberta.
 const temp=await addMember(db,'fueler');
 await mutate('members',{id:temp.id,username:(temp as Member&{username:string}).username,name:temp.name,role:'fueler',capabilities:['cadastros']},manager);
 await reg('functions',{name:'Sinaleiro'},{...temp,capabilities:['cadastros']});
 await mutate('members',{id:temp.id,username:(temp as Member&{username:string}).username,name:temp.name,role:'fueler',capabilities:[]},manager);
 await rejects(reg('functions',{name:'Amarrador'},{...temp,capabilities:['cadastros']}),403);
});

test('camada de dados: auditoria recusa ações fora do acesso de quem registra',async()=>{
 const insert=(who:Member,action:string)=>db.run('INSERT INTO audits(id,action,entity_id,author_id,author_name,created_at,detail) VALUES(?,?,?,?,?,?,?)',key(),action,'x',who.id,who.name,new Date().toISOString(),'{}');
 await insert(clerk,'Cadastros gerais: teste');
 await pgRejects(insert(clerk,'Fluxo: teste'),/Auditoria sem autorização/);
 await pgRejects(insert(requester,'Cadastros gerais: teste'),/Auditoria sem autorização/);
 await insert(planner,'Fluxo: teste');
});

test('solicitantes: organização com sigla e cor, pessoa vinculada e controle de versão',async()=>{
 await rejects(reg('orgs',{name:'Cliente X',acronym:'CX',category:'cliente',color:'vermelho'},clerk),400,/Cor inválida/);
 await rejects(reg('orgs',{name:'Cliente X',acronym:'CX',category:'parceiro',color:'#AA0000'},clerk),400,/categoria/);
 const org=await reg('orgs',{name:'Cliente X',acronym:'cx',category:'cliente',color:'#aa0000'},clerk);
 const row=await db.first('SELECT * FROM requester_orgs WHERE id=?',org.id);
 assert.equal(row!.acronym,'CX');assert.equal(row!.color,'#AA0000');
 await pgRejects(reg('orgs',{name:'Outro',acronym:'CX',category:'cliente',color:'#00AA00'},clerk),/requester_orgs_acronym_key/);
 await rejects(reg('orgs',{id:org.id,name:'Cliente X2',acronym:'CX',category:'cliente',color:'#AA0000',updatedAt:'antigo'},clerk),409,/outra pessoa/);
 await reg('orgs',{id:org.id,name:'Cliente X2',acronym:'CX',category:'cliente',color:'#AA0000',updatedAt:row!.updated_at},clerk);
 const person=await reg('people',{orgId:org.id,name:'Ana Lima',role:'Fiscal',email:'ANA@EXEMPLO.COM'},clerk);
 assert.equal((await db.first('SELECT email FROM requester_people WHERE id=?',person.id))!.email,'ana@exemplo.com');
 await rejects(reg('people',{orgId:'nao-existe',name:'X'},clerk),404);
});

test('locais: hierarquia unidade › área › local garantida no banco',async()=>{
 const unit=await reg('locations',{kind:'unidade',name:'Base Açu'},clerk);
 await rejects(reg('locations',{kind:'area',name:'Pátio'},clerk),400,/obrigatório/);
 const area=await reg('locations',{kind:'area',name:'Pátio',parentId:unit.id},clerk);
 const spot=await reg('locations',{kind:'local',name:'Doca 1',parentId:area.id},clerk);
 await pgRejects(reg('locations',{kind:'local',name:'Doca 2',parentId:spot.id},clerk),/Hierarquia de local inválida/);
 await pgRejects(reg('locations',{kind:'area',name:'Pátio',parentId:unit.id},clerk),/locations_name_key/);
 await pgRejects(db.run("UPDATE locations SET kind='unidade',parent_id=NULL WHERE id=?",area.id),/Nível do local/);
 const row=await db.first('SELECT * FROM locations WHERE id=?',spot.id);
 // O nível é preservado mesmo que a tela envie outro.
 await reg('locations',{id:spot.id,kind:'unidade',name:'Doca 1A',parentId:unit.id,updatedAt:row!.updated_at},clerk);
 assert.equal((await db.first('SELECT kind,parent_id FROM locations WHERE id=?',spot.id))!.kind,'local');
});

test('tipos e equipamentos: tipo cadastrado, renomeação propagada e combustíveis validados',async()=>{
 const type=await reg('equipment-types',{name:'Empilhadeira'},clerk);
 await pgRejects(reg('equipment-types',{name:'empilhadeira'},clerk),/equipment_types_name_key/);
 await rejects(reg('equipment',{tag:'emp-03',description:'Nova',typeId:type.id,fuelIds:['nao-existe']},clerk),400,/inválido/);
 await rejects(reg('equipment',{tag:'emp-03',description:'Nova',typeId:type.id,fuelIds:[]},clerk),400,/ao menos um/);
 const eq=await reg('equipment',{tag:'emp-03',description:'Nova',typeId:type.id,fuelIds:['diesel','diesel'],capacity:'2,5 t'},clerk);
 let row=await db.first('SELECT * FROM equipment WHERE id=?',eq.id);
 assert.equal(row!.tag,'EMP-03');assert.deepEqual(row!.fuel_ids,['diesel']);assert.equal(row!.type,'Empilhadeira');
 const t=await db.first('SELECT updated_at FROM equipment_types WHERE id=?',type.id);
 await reg('equipment-types',{id:type.id,name:'Empilhadeira elétrica',updatedAt:t!.updated_at},clerk);
 row=await db.first('SELECT type FROM equipment WHERE id=?',eq.id);assert.equal(row!.type,'Empilhadeira elétrica');
 await rejects(reg('equipment',{id:'nao-existe',tag:'X',description:'X',typeId:type.id,fuelIds:['diesel']},clerk),404);
 const t2=await db.first('SELECT updated_at FROM equipment_types WHERE id=?',type.id);
 await reg('equipment-types',{id:type.id,name:'Empilhadeira elétrica',active:false,updatedAt:t2!.updated_at},clerk);
 await rejects(reg('equipment',{tag:'emp-04',description:'Outra',typeId:type.id,fuelIds:['diesel']},clerk),400,/tipo de equipamento ativo/);
 // O equipamento que já usava o tipo continua editável.
 await reg('equipment',{id:eq.id,tag:'emp-03',description:'Nova revisada',typeId:type.id,fuelIds:['diesel']},clerk);
});

test('colaboradores e funções: várias funções e vínculo com usuário restrito ao gestor',async()=>{
 const f1=await reg('functions',{name:'Operador de empilhadeira'},clerk),f2=await reg('functions',{name:'Rigger'},clerk);
 const op=await reg('operators',{name:'Italo Souza',badge:'123',functionIds:[f1.id,f2.id,f1.id]},clerk);
 assert.equal((await db.all('SELECT * FROM operator_functions WHERE operator_id=?',op.id)).length,2);
 await rejects(reg('operators',{id:op.id,name:'Italo Souza',functionIds:[f1.id],memberId:requester.id},clerk),403,/gestor/);
 await reg('operators',{id:op.id,name:'Italo Souza',functionIds:[f1.id],memberId:requester.id},manager);
 const op2=await reg('operators',{name:'Outro'},manager);
 await pgRejects(reg('operators',{id:op2.id,name:'Outro',memberId:requester.id},manager),/operators_member_key/);
 // Quem só tem Cadastros pode editar o colaborador sem mexer no vínculo de acesso.
 await reg('operators',{id:op.id,name:'Italo S. Souza',functionIds:[f1.id,f2.id],memberId:requester.id},clerk);
 const f=await db.first('SELECT updated_at FROM job_functions WHERE id=?',f2.id);
 await reg('functions',{id:f2.id,name:'Rigger',active:false,updatedAt:f!.updated_at},clerk);
 await rejects(reg('operators',{name:'Novo',functionIds:[f2.id]},clerk),400,/inativo/);
 await reg('operators',{id:op.id,name:'Italo S. Souza',functionIds:[f1.id,f2.id],memberId:requester.id},clerk);
 const view=await registryState(manager);
 assert.equal(view.operators.find(o=>o.id===op.id)!.member_name,requester.name);
});

test('categorias de ocorrências, impactos e bloqueios',async()=>{
 await rejects(reg('categories',{kind:'outro',name:'Chuva'},clerk),400,/tipo/);
 await reg('categories',{kind:'bloqueio',name:'Chuva'},clerk);await reg('categories',{kind:'impacto',name:'Chuva'},clerk);
 await pgRejects(reg('categories',{kind:'bloqueio',name:'chuva'},clerk),/occurrence_categories_name_key/);
});

const question=(o:Record<string,unknown>={})=>({text:'Freios funcionando?',required:true,critical:true,target:'equipamento',allowNa:false,noteOn:['NC'],evidenceOn:['NC'],...o});
test('checklists: versões imutáveis, regras de N/A e vínculos obrigatórios',async()=>{
 const type=await reg('equipment-types',{name:'Guindaste'},clerk);
 const base={code:'ck-pre-uso',title:'Pré-uso de empilhadeira',moment:'pre_uso',mandatory:true,links:{equipmentTypeIds:[type.id],equipmentIds:['eq1']}};
 await rejects(reg('checklists',{...base,questions:[]},clerk),400,/ao menos uma pergunta/);
 await rejects(reg('checklists',{...base,questions:[question({noteOn:['NA']})]},clerk),400,/N\/A não é permitido/);
 await rejects(reg('checklists',{...base,links:{},questions:[question()]},clerk),400,/uso geral/);
 await rejects(reg('checklists',{...base,moment:'qualquer',questions:[question()]},clerk),400,/momento/);
 const ck=await reg('checklists',{...base,questions:[question(),question({text:'Buzina?',critical:false,allowNa:true,noteOn:['NA','NC']})]},clerk);
 assert.equal(ck.version,1);
 assert.equal((await db.first('SELECT code FROM checklist_templates WHERE id=?',ck.id))!.code,'CK-PRE-USO');
 const v1=await db.first('SELECT id FROM checklist_versions WHERE template_id=? AND version=1',ck.id);
 const same=await reg('checklists',{...base,id:ck.id,expectedVersion:1,questions:[question(),question({text:'Buzina?',critical:false,allowNa:true,noteOn:['NC','NA']})]},clerk);
 assert.equal(same.unchanged,true);
 const v2=await reg('checklists',{...base,id:ck.id,expectedVersion:1,questions:[question({text:'Freios e direção funcionando?'})]},clerk);
 assert.equal(v2.version,2);
 await rejects(reg('checklists',{...base,id:ck.id,expectedVersion:1,questions:[question()]},clerk),409,/nova versão/);
 // A versão 1 continua íntegra e não pode ser alterada nem apagada.
 assert.equal((await db.all('SELECT id FROM checklist_questions WHERE version_id=?',v1!.id)).length,2);
 await pgRejects(db.run("UPDATE checklist_questions SET critical=0 WHERE version_id=?",v1!.id),/imutável/);
 await pgRejects(db.run('DELETE FROM checklist_links WHERE version_id=?',v1!.id),/imutável/);
 const view=await registryState(clerk);
 const listed=view.checklists.find(c=>c.id===ck.id)!;
 assert.equal(listed.current!.version,2);assert.equal(listed.current!.questions.length,1);assert.deepEqual(listed.current!.equipment_ids,['eq1']);
 const t=await db.first('SELECT updated_at FROM checklist_templates WHERE id=?',ck.id);
 await reg('checklists/status',{id:ck.id,active:false,updatedAt:t!.updated_at},clerk);
 assert.equal((await db.first('SELECT active FROM checklist_templates WHERE id=?',ck.id))!.active,0);
});

const step=(k:string,name:string,deps:string[]=[],o:Record<string,unknown>={})=>({key:k,name,dependsOn:deps,...o});
test('fluxos: etapas paralelas, dependências sem ciclo e nova versão sem alterar a anterior',async()=>{
 const type=await reg('equipment-types',{name:'Carreta'},manager),fn=await reg('functions',{name:'Conferente'},manager);
 const steps=[step('prep-0001','Preparação do material'),step('insp-0001','Inspeção do equipamento',[],{needs:[{equipmentTypeId:type.id,quantity:1}]}),step('move-0001','Movimentação',['prep-0001','insp-0001'],{defaultMinutes:90}),step('conf-0001','Conferência final',['move-0001'],{needs:[{functionId:fn.id,quantity:2}]})];
 await rejects(flowsMutate('flows/save',{code:'MOV',name:'Movimentação de materiais',steps},clerk),403);
 await rejects(flowsMutate('flows/save',{code:'MOV',name:'Movimentação de materiais',steps:[step('a-0001','A',['b-0001']),step('b-0001','B',['a-0001'])]},planner),400,/circular/);
 await rejects(flowsMutate('flows/save',{code:'MOV',name:'Movimentação de materiais',steps:[step('a-0001','A',['a-0001'])]},planner),400,/si mesma/);
 await rejects(flowsMutate('flows/save',{code:'MOV',name:'X',steps:[step('a-0001','A',[],{needs:[{equipmentTypeId:type.id,functionId:fn.id,quantity:1}]})]},planner),400,/tipo de equipamento ou uma função/);
 const flow=await flowsMutate('flows/save',{code:'mov',name:'Movimentação de materiais',steps},planner) as {id:string;version:number};
 assert.equal(flow.version,1);
 let view=await flowsState(planner);
 let at=view.activityTypes.find(x=>x.id===flow.id)!;
 assert.equal(at.code,'MOV');assert.equal(at.steps.length,4);
 assert.deepEqual([...at.steps.find((s:{step_key:string})=>s.step_key==='move-0001').depends_on].sort(),['insp-0001','prep-0001']);
 const unchanged=await flowsMutate('flows/save',{id:flow.id,expectedVersion:1,name:'Movimentação de materiais',steps},planner) as {unchanged?:boolean};
 assert.equal(unchanged.unchanged,true);
 const v2=await flowsMutate('flows/save',{id:flow.id,expectedVersion:1,name:'Movimentação de materiais',notes:'Conferência opcional',steps:steps.map(s=>s.key==='conf-0001'?{...s,required:false}:s)},planner) as {version:number};
 assert.equal(v2.version,2);
 await rejects(flowsMutate('flows/save',{id:flow.id,expectedVersion:1,name:'X',steps},planner),409);
 view=await flowsState(planner);at=view.activityTypes.find(x=>x.id===flow.id)!;
 assert.equal(at.versions.length,2);
 const old=await flowVersion(planner,at.versions.find((v:{version:number})=>v.version===1).id);
 assert.equal(old.steps.find(s=>s.step_key==='conf-0001')!.required,1);
 assert.equal(at.steps.find((s:{step_key:string})=>s.step_key==='conf-0001').required,0);
 // Ciclo inserido diretamente no banco é recusado ao confirmar a transação.
 const vid=old.version.id,ids=Object.fromEntries(old.steps.map(s=>[s.step_key,s.id]));
 await pgRejects(db.tx(tx=>tx.run('INSERT INTO flow_dependencies(flow_version_id,step_id,depends_on_id) VALUES(?,?,?)',vid,ids['prep-0001'],ids['conf-0001'])),/circular|imutável/);
 await pgRejects(db.run('UPDATE flow_steps SET name=? WHERE flow_version_id=?','Outro',vid),/imutável/);
 const copy=await flowsMutate('flows/duplicate',{id:flow.id,code:'MOV-2',name:'Movimentação noturna'},planner) as {id:string};
 view=await flowsState(planner);
 assert.equal(view.activityTypes.find(x=>x.id===copy.id)!.steps.length,4);
 await rejects(flowsMutate('flows/status',{id:flow.id,active:false,updatedAt:'antigo'},planner),409);
 await flowsMutate('flows/status',{id:flow.id,active:false,updatedAt:at.updated_at},planner);
 // Checklist pode ser vinculado ao tipo de atividade enquanto ele está ativo.
 await rejects(reg('checklists',{code:'CK-MOV',title:'Pré-atividade',moment:'pre_atividade',links:{activityTypeIds:[flow.id]},questions:[question({target:'atividade',critical:false})]},clerk),400,/inativo/);
 await reg('checklists',{code:'CK-MOV',title:'Pré-atividade',moment:'pre_atividade',links:{activityTypeIds:[copy.id]},questions:[question({target:'atividade',critical:false})]},clerk);
});
