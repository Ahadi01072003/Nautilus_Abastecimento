// Manutenção: critérios por equipamento, painel de preventivas (ciclos calculados), registros de
// preventiva e corretiva com apontamentos, leituras de horímetro/odômetro e parada do equipamento.
// Quem tem "Manutenção" registra; Planejamento e Operação consultam o painel; Operação registra leituras.
import {db,type Executor,type Row} from './db';
import {AppError,required,text,isoDay} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {computeCycle,usageRate,localDay,dateOf,markLabel,unitOf,previewMarks,type CyclePlan,type CycleRecord,type CycleStatus,type Method} from './maintenance-cycle';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const all=(q:string,...v:unknown[])=>db().all(q,...v);
const first=(q:string,...v:unknown[])=>db().first(q,...v);
const idOf=(value:unknown,label:string)=>required(value,label,100);
const METHODS:Method[]=['dias','horimetro','odometro'];
const VIEW=['manutencao','planejamento','operacao'] as const;
const HOUR=3600000;
type Actor=Member&{capabilities:string[]};
const canMaintain=(a:Actor)=>isManager(a)||a.capabilities.includes('manutencao');

/** Lista de textos (itens do plano, pontos de atenção, inconformidades). */
function textList(value:unknown,label:string,max=60,len=300){
 if(value==null)return [] as string[];
 if(!Array.isArray(value)||value.length>max)throw new AppError(`${label}: lista inválida (até ${max} itens).`);
 const out=value.map(v=>text(v,len)).filter(Boolean);
 if(new Set(out.map(x=>x.toLocaleLowerCase('pt-BR'))).size!==out.length)throw new AppError(`${label}: item repetido.`);
 return out;
}
const num=(value:unknown,label:string,min=0,max=100000000)=>{
 const n=Number(typeof value==='string'?value.replace(',','.'):value);
 if(value===''||value==null||!Number.isFinite(n)||n<min||n>max)throw new AppError(`${label}: valor inválido.`);
 return Math.round(n*10)/10;
};
/** Mensagens claras para as travas do banco nas leituras e registros. */
function dbError(e:unknown):never{
 const x=e as {message?:string,detail?:string};const m=x.message||'';
 const d=x.detail?Number(x.detail).toLocaleString('pt-BR'):'';
 if(/Leitura menor que a anterior/.test(m))throw new AppError(`A leitura é menor que a anterior (${d}). Leituras não voltam; confira o valor e a data.`,409);
 if(/Leitura maior que uma leitura posterior/.test(m))throw new AppError(`A leitura é maior que uma leitura registrada depois dessa data (${d}). Confira o valor e a data.`,409);
 if(/Horímetro avançou mais que o tempo decorrido/.test(m))throw new AppError('O horímetro avançou mais horas do que se passaram desde a leitura anterior. Confira o valor e a data.',409);
 if(/Leitura com data no futuro|com início no futuro|com fim no futuro/.test(m))throw new AppError('Data e hora não podem estar no futuro.',400);
 if(/Fim da manutenção deve ser depois do início/.test(m))throw new AppError('O fim da manutenção deve ser depois do início.',400);
 if(/maintenance_records_cycle|maintenance_records_open_plan/.test(m))throw new AppError('Este marco já tem manutenção registrada ou em andamento. Atualize a tela.',409);
 throw e;
}

/* ───────────── leituras ───────────── */

/** Leitura mais recente de cada equipamento (horímetro e odômetro) e o ritmo de uso dos últimos 30 dias. */
async function meters(ex:Executor=db()){
 const [latest,recent]=await Promise.all([
  ex.all('SELECT DISTINCT ON (equipment_id,kind) equipment_id,kind,value::float8 value,read_at,source FROM equipment_meter ORDER BY equipment_id,kind,read_at::timestamptz DESC,value DESC'),
  ex.all("SELECT equipment_id,kind,value::float8 value,read_at FROM equipment_meter WHERE read_at::timestamptz > now() - interval '31 days'"),
 ]);
 const get=(eq:string,kind:string)=>latest.find(r=>r.equipment_id===eq&&r.kind===kind)||null;
 const rate=(eq:string,kind:string)=>usageRate(recent.filter(r=>r.equipment_id===eq&&r.kind===kind).map(r=>({value:Number(r.value),readAt:r.read_at})));
 return {latest,get,rate};
}

/* ───────────── ciclos ───────────── */

const cyclePlan=(p:Row):CyclePlan=>({method:p.method,interval:Number(p.interval_value),tolerance:Number(p.tolerance_value),anchorDate:p.anchor_date,anchorReading:p.anchor_reading==null?null:Number(p.anchor_reading),cycleMode:p.cycle_mode});
const cycleRecords=(records:Row[],planId:string):CycleRecord[]=>records.filter(r=>r.plan_id===planId&&r.status!=='anulada').map(r=>({id:r.id,cycle:r.cycle,status:r.status,endedAt:r.ended_at,reading:r.reading==null?null:Number(r.reading)}));
const RANK:Record<CycleStatus,number>={em_dia:0,sem_leitura:1,pendente:2,atrasada:3};

/** Situação de todos os critérios ativos (painel, painel central e avisos). */
export async function preventiveRows(ex:Executor=db()){
 const [plans,records,m]=await Promise.all([
  ex.all(`SELECT p.*,e.tag,e.description equipment_description,e.type_id,t.name type_name FROM maintenance_plans p JOIN equipment e ON e.id=p.equipment_id LEFT JOIN equipment_types t ON t.id=e.type_id
   WHERE p.active=1 AND e.active=1 ORDER BY e.tag,p.name`),
  ex.all("SELECT id,plan_id,cycle,status,started_at,ended_at,reading::float8 reading,responsible_name FROM maintenance_records WHERE kind='preventiva' AND status<>'anulada'"),
  meters(ex),
 ]);
 const today=localDay(Date.now());
 return plans.map(p=>{
  const method=p.method as Method;
  const meter=method==='dias'?null:m.get(p.equipment_id,method);
  const res=computeCycle(cyclePlan(p),cycleRecords(records,p.id),{current:meter?Number(meter.value):null,today,rate:meter?m.rate(p.equipment_id,method):null});
  const open=records.find(r=>r.id===res.openRecordId)||null;
  const last=records.filter(r=>r.plan_id===p.id&&r.status==='concluida').sort((a,b)=>b.cycle-a.cycle)[0]||null;
  const stale=method!=='dias'&&(!meter||Date.now()-Date.parse(meter.read_at)>15*24*HOUR);
  return {planId:p.id,equipmentId:p.equipment_id,tag:p.tag,equipmentDescription:p.equipment_description,typeId:p.type_id,typeName:p.type_name,name:p.name,method,unit:unitOf(method),
   interval:Number(p.interval_value),tolerance:Number(p.tolerance_value),cycleMode:p.cycle_mode,anchor:method==='dias'?p.anchor_date:Number(p.anchor_reading),
   status:res.status,current:res.current,currentLabel:res.current==null?null:markLabel(method,res.current),readingAt:meter?.read_at||null,readingSource:meter?.source||null,stale,
   target:res.target,targetDue:markLabel(method,res.marks.find(x=>x.cycle===res.target)?.due??res.firstOpenDue),firstOpen:res.firstOpen,firstOpenLabel:markLabel(method,res.firstOpenDue),
   remaining:res.remaining,projectedDate:res.projectedDay==null?null:dateOf(res.projectedDay),segment:res.segment,
   marks:res.marks,openRecord:open?{id:open.id,cycle:open.cycle,startedAt:open.started_at,responsible:open.responsible_name}:null,
   lastDone:last?{cycle:last.cycle,endedAt:last.ended_at}:null,
   tasks:p.tasks,attention:p.attention,nonconformities:p.nonconformities,estimatedMinutes:p.estimated_minutes};
 });
}

/** Horas de manutenção concluídas (duração e homem-hora) no período. */
async function hoursOf(kind:'preventiva'|'corretiva'|null,days:number|null){
 const r=await first(`SELECT count(*)::int n,coalesce(sum(extract(epoch FROM (ended_at::timestamptz-started_at::timestamptz))),0)::float8 s,
  coalesce(sum(extract(epoch FROM (ended_at::timestamptz-started_at::timestamptz))*(1+cardinality(team_ids))),0)::float8 hh
  FROM maintenance_records WHERE status='concluida'${kind?' AND kind=?':''}${days?" AND ended_at::timestamptz > now() - make_interval(days => ?)":''}`,...[kind,days].filter(v=>v!=null));
 return {count:r!.n as number,hours:Math.round(r!.s/36)/100,manHours:Math.round(r!.hh/36)/100};
}
const periodDays=(v:string|null)=>v==='todos'?null:[7,30,90,365].includes(Number(v))?Number(v):30;

export async function maintenancePanel(member:Member,url:URL){
 const a=await requireAny(member,[...VIEW]) as Actor;
 const days=periodDays(url.searchParams.get('periodo'));
 const [rows,hours,types,operators]=await Promise.all([preventiveRows(),hoursOf('preventiva',days),all('SELECT id,name FROM equipment_types WHERE active=1 ORDER BY name'),all('SELECT id,name FROM operators WHERE active=1 ORDER BY name')]);
 // Cartões por equipamento: vale a pior situação entre os critérios dele.
 const worst=new Map<string,CycleStatus>();
 for(const r of rows){const w=worst.get(r.equipmentId);if(!w||RANK[r.status]>RANK[w])worst.set(r.equipmentId,r.status);}
 const count=(s:CycleStatus)=>[...worst.values()].filter(v=>v===s).length;
 return {rows,types,operators,cards:{equipment:worst.size,emDia:count('em_dia'),pendentes:count('pendente'),atrasados:count('atrasada'),semLeitura:count('sem_leitura'),hours},
  period:days,canEdit:canMaintain(a),today:dateOf(localDay(Date.now())),generatedAt:now()};
}

/* ───────────── critérios ───────────── */

export async function maintenanceCriteria(member:Member){
 const a=await requireAny(member,['manutencao']) as Actor;
 const [equipment,types,plans,records,m,operators]=await Promise.all([
  all('SELECT e.id,e.tag,e.description,e.type_id,e.active,t.name type_name FROM equipment e LEFT JOIN equipment_types t ON t.id=e.type_id ORDER BY e.tag'),
  all('SELECT id,name FROM equipment_types ORDER BY name'),
  all('SELECT * FROM maintenance_plans ORDER BY name'),
  all("SELECT plan_id,count(*)::int n FROM maintenance_records WHERE kind='preventiva' AND status<>'anulada' GROUP BY plan_id"),
  meters(),
  all('SELECT id,name,active FROM operators ORDER BY name'),
 ]);
 return {equipment:equipment.map(e=>({...e,horimetro:m.get(e.id,'horimetro'),odometro:m.get(e.id,'odometro')})),types,operators,
  plans:plans.map((p):Row=>({...p,interval_value:Number(p.interval_value),tolerance_value:Number(p.tolerance_value),anchor_reading:p.anchor_reading==null?null:Number(p.anchor_reading),records:records.find(r=>r.plan_id===p.id)?.n||0,preview:previewMarks(cyclePlan(p))})),
  canEdit:canMaintain(a),generatedAt:now()};
}

async function savePlan(a:Actor,b:Row){
 const old=b.id?await first('SELECT * FROM maintenance_plans WHERE id=?',idOf(b.id,'Critério')):null;
 if(b.id&&!old)throw new AppError('Critério não encontrado.',404);
 if(old&&b.version!==old.version)throw new AppError('Este critério foi alterado por outra pessoa. Atualize a tela.',409);
 const equipment=await first('SELECT id,tag,active FROM equipment WHERE id=?',old?.equipment_id||idOf(b.equipmentId,'Equipamento'));
 if(!equipment)throw new AppError('Equipamento não encontrado.',404);
 if(!old&&!equipment.active)throw new AppError('Equipamento inativo.');
 const name=required(b.name,'Nome do plano',120);
 const method=b.method as Method;if(!METHODS.includes(method))throw new AppError('Escolha o método: tempo corrido (dias), horímetro ou odômetro.');
 const interval=method==='dias'?num(b.interval,'Intervalo (dias)',1,3650):num(b.interval,'Intervalo',0.1,10000000);
 if(method==='dias'&&!Number.isInteger(interval))throw new AppError('Intervalo em dias deve ser um número inteiro.');
 const tolerance=num(b.tolerance??0,'Abrangência',0,10000000);
 if(method==='dias'&&!Number.isInteger(tolerance))throw new AppError('Abrangência em dias deve ser um número inteiro.');
 if(tolerance>interval)throw new AppError('A abrangência não pode ser maior que o intervalo.');
 const anchorDate=method==='dias'?isoDay(b.anchorDate):null;
 const anchorReading=method==='dias'?null:num(b.anchorReading,'Leitura do marco zero',0);
 const cycleMode=b.cycleMode==='execucao'?'execucao':'fixo';
 const tasks=textList(b.tasks,'Itens do plano');if(!tasks.length)throw new AppError('Informe ao menos um item do plano de manutenção.');
 const attention=textList(b.attention,'Pontos de atenção'),nonconformities=textList(b.nonconformities,'Principais inconformidades');
 const estimated=b.estimatedMinutes==null||b.estimatedMinutes===''?null:Math.round(num(b.estimatedMinutes,'Duração estimada',1,100000));
 const active=b.active===false?0:1;
 const records=old?(await first("SELECT count(*)::int n FROM maintenance_records WHERE plan_id=? AND status<>'anulada'",old.id))!.n:0;
 // Mudar a regra do ciclo muda os marcos: exige motivo (auditoria com antes e depois).
 const ruleChanged=old&&(old.method!==method||Number(old.interval_value)!==interval||Number(old.tolerance_value)!==tolerance||old.anchor_date!==anchorDate||(old.anchor_reading==null?null:Number(old.anchor_reading))!==anchorReading||old.cycle_mode!==cycleMode);
 if(old&&records&&old.method!==method)throw new AppError('Este critério já tem manutenções registradas: o método não muda. Inative-o e cadastre um novo critério.',409);
 const reason=ruleChanged?required(b.reason,'Motivo da mudança da regra do ciclo',500):text(b.reason,500);
 const pid=old?.id||id(),t=now();
 await db().tx(async tx=>{
  if(old){
   const changed=await tx.run(`UPDATE maintenance_plans SET name=?,method=?,interval_value=?,tolerance_value=?,anchor_date=?,anchor_reading=?,cycle_mode=?,tasks=?::text::jsonb,attention=?::text::jsonb,nonconformities=?::text::jsonb,estimated_minutes=?,active=?,version=version+1,updated_at=? WHERE id=? AND version=?`,
    name,method,interval,tolerance,anchorDate,anchorReading,cycleMode,JSON.stringify(tasks),JSON.stringify(attention),JSON.stringify(nonconformities),estimated,active,t,pid,old.version);
   if(!changed)throw new AppError('Este critério foi alterado por outra pessoa. Atualize a tela.',409);
  }else await tx.run(`INSERT INTO maintenance_plans(id,equipment_id,name,method,interval_value,tolerance_value,anchor_date,anchor_reading,cycle_mode,tasks,attention,nonconformities,estimated_minutes,active,created_at,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?::text::jsonb,?::text::jsonb,?::text::jsonb,?,?,?,?,?)`,
   pid,equipment.id,name,method,interval,tolerance,anchorDate,anchorReading,cycleMode,JSON.stringify(tasks),JSON.stringify(attention),JSON.stringify(nonconformities),estimated,active,t,a.id,t);
  await audit(tx,a,old?'Manutenção: critério atualizado':'Manutenção: critério cadastrado',pid,{tag:equipment.tag,reason:reason||undefined,before:old?{name:old.name,method:old.method,interval:Number(old.interval_value),tolerance:Number(old.tolerance_value),anchorDate:old.anchor_date,anchorReading:old.anchor_reading,cycleMode:old.cycle_mode,active:old.active}:null,after:{name,method,interval,tolerance,anchorDate,anchorReading,cycleMode,active}});
 }).catch(e=>{if(/maintenance_plans_name_key/.test((e as Error).message))throw new AppError('Este equipamento já tem um critério com este nome.',409);throw e;});
 return {id:pid,message:old?'Critério atualizado.':`Critério cadastrado. 1º marco: ${previewMarks({method,interval,tolerance,anchorDate,anchorReading,cycleMode},1)[0]}.`};
}

/* ───────────── registros ───────────── */

async function operatorsOf(ids:unknown,label:string){
 if(ids==null)return [] as Row[];
 if(!Array.isArray(ids)||ids.length>30)throw new AppError(`${label}: seleção inválida.`);
 const list=[...new Set(ids.map(v=>idOf(v,label)))];
 const rows=list.length?await all('SELECT id,name,active FROM operators WHERE id = ANY(?::text[])',list):[];
 if(rows.length!==list.length)throw new AppError(`${label}: colaborador inexistente.`);
 return rows;
}
async function responsibleOf(b:Row){
 if(b.responsibleId){const r=await first('SELECT id,name,active FROM operators WHERE id=?',idOf(b.responsibleId,'Responsável'));if(!r)throw new AppError('Responsável não encontrado.',404);if(!r.active)throw new AppError('Responsável inativo.');return {id:r.id as string,name:r.name as string};}
 return {id:null,name:required(b.responsibleName,'Responsável',120)};
}
/** Data e hora completas com fuso (mesma regra do planejamento). */
function instant(value:unknown,label:string){
 if(value==null||value==='')return null;
 if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)||!/(Z|[+-]\d{2}:\d{2})$/.test(value))throw new AppError(`${label}: informe data e hora completas.`);
 const d=new Date(value);if(!Number.isFinite(d.valueOf()))throw new AppError(`${label}: data inválida.`);
 return d.toISOString();
}
const when=(value:unknown,label:string)=>{const v=instant(value,label);if(!v)throw new AppError(`${label}: informe data e hora.`);if(Date.parse(v)>Date.now()+5*60000)throw new AppError(`${label}: não pode estar no futuro.`);return v;};

/** Para a operação: o equipamento fica bloqueado para reservas e início de etapas até o fim da manutenção. */
async function stopEquipment(tx:Executor,a:Actor,equipmentId:string,reason:string,ref:string){
 const iid=id();
 await tx.run("INSERT INTO equipment_impediments(id,equipment_id,kind,reason,source_ref,opened_at,opened_by,opened_by_name) VALUES(?,?,'manutencao',?,?,?,?,?)",iid,equipmentId,reason,ref,now(),a.id,a.name);
 return iid;
}
async function release(tx:Executor,a:Actor,impedimentId:string,reason:string,evidence:string){
 return tx.run('UPDATE equipment_impediments SET released_at=?,released_by=?,released_by_name=?,release_reason=?,release_evidence=? WHERE id=? AND released_at IS NULL',now(),a.id,a.name,reason,evidence,impedimentId);
}

async function startPreventive(a:Actor,b:Row){
 const key=required(b.operationKey,'Identificador da operação',100);
 const again=await first('SELECT id FROM maintenance_records WHERE operation_key=?',key);if(again)return {id:again.id,repeated:true};
 const planId=idOf(b.planId,'Critério');
 const startedAt=when(b.startedAt,'Início');
 const resp=await responsibleOf(b),team=await operatorsOf(b.teamIds,'Equipe');
 try{
  return await db().tx(async tx=>{
   const plan=await tx.first('SELECT p.*,e.tag,e.active equipment_active FROM maintenance_plans p JOIN equipment e ON e.id=p.equipment_id WHERE p.id=? FOR UPDATE OF p',planId);
   if(!plan)throw new AppError('Critério não encontrado.',404);
   if(!plan.active||!plan.equipment_active)throw new AppError('Critério ou equipamento inativo.',409);
   const row=(await preventiveRows(tx)).find(r=>r.planId===plan.id)!;
   if(row.openRecord)throw new AppError(`Já há uma preventiva em andamento neste critério (marco ${row.openRecord.cycle}).`,409);
   if(b.cycle!=null&&Number(b.cycle)!==row.target)throw new AppError('Os marcos mudaram desde que a tela foi aberta. Atualize e tente de novo.',409);
   const rid=id(),t=now();
   const impediment=b.stopped?await stopEquipment(tx,a,plan.equipment_id,`Em manutenção preventiva: ${plan.name}`,rid):null;
   await tx.run(`INSERT INTO maintenance_records(id,kind,equipment_id,plan_id,cycle,due_label,status,started_at,responsible_id,responsible_name,team_ids,items,stopped,impediment_id,operation_key,created_at,created_by,created_by_name)
    VALUES(?,'preventiva',?,?,?,?,'em_andamento',?,?,?,?::text[],?::text::jsonb,?,?,?,?,?,?)`,rid,plan.equipment_id,plan.id,row.target,row.targetDue,startedAt,resp.id,resp.name,team.map(x=>x.id),JSON.stringify((plan.tasks as string[]).map(text=>({text,done:false}))),b.stopped?1:0,impediment,key,t,a.id,a.name);
   await audit(tx,a,'Manutenção: preventiva iniciada',rid,{tag:plan.tag,plan:plan.name,cycle:row.target,due:row.targetDue,startedAt,stopped:!!b.stopped});
   return {id:rid,message:`Preventiva do marco ${row.target} (${row.targetDue}) iniciada${b.stopped?'; equipamento bloqueado para reservas até o fim':''}.`};
  });
 }catch(e){dbError(e);}
}

async function createCorrective(a:Actor,b:Row){
 const key=required(b.operationKey,'Identificador da operação',100);
 const again=await first('SELECT id FROM maintenance_records WHERE operation_key=?',key);if(again)return {id:again.id,repeated:true};
 const equipment=await first('SELECT id,tag,active FROM equipment WHERE id=?',idOf(b.equipmentId,'Equipamento'));
 if(!equipment)throw new AppError('Equipamento não encontrado.',404);
 const startedAt=when(b.startedAt,'Início'),endedAt=b.endedAt?when(b.endedAt,'Fim'):null;
 if(endedAt&&Date.parse(endedAt)<=Date.parse(startedAt))throw new AppError('O fim da manutenção deve ser depois do início.');
 const points=textList(b.points,'Pontos manutenidos',80,500);
 if(endedAt&&!points.length)throw new AppError('Informe ao menos um ponto manutenido.');
 const resp=await responsibleOf(b),team=await operatorsOf(b.teamIds,'Equipe');
 const notes=text(b.notes,4000),failure=text(b.failure,1000);
 const reading=readingOf(b);
 try{
  return await db().tx(async tx=>{
   const rid=id(),t=now();
   const impediment=b.stopped&&!endedAt?await stopEquipment(tx,a,equipment.id,`Em manutenção corretiva${failure?': '+failure.slice(0,200):''}`,rid):null;
   await tx.run(`INSERT INTO maintenance_records(id,kind,equipment_id,status,started_at,ended_at,responsible_id,responsible_name,team_ids,reading,reading_kind,items,notes,failure,stopped,impediment_id,late,operation_key,created_at,created_by,created_by_name,closed_at,closed_by,closed_by_name)
    VALUES(?,'corretiva',?,?,?,?,?,?,?::text[],?,?,?::text::jsonb,?,?,?,?,?,?,?,?,?,?,?,?)`,rid,equipment.id,endedAt?'concluida':'em_andamento',startedAt,endedAt,resp.id,resp.name,team.map(x=>x.id),reading?.value??null,reading?.kind??null,
    JSON.stringify(points.map(text=>({text}))),notes,failure,b.stopped&&!endedAt?1:0,impediment,endedAt&&Date.now()-Date.parse(endedAt)>24*HOUR?1:0,key,t,a.id,a.name,endedAt?t:null,endedAt?a.id:null,endedAt?a.name:null);
   if(reading&&endedAt)await insertReading(tx,a,equipment.id,reading.kind,reading.value,endedAt,'manutencao',rid,'Leitura na manutenção corretiva');
   const released=endedAt?await releaseOthers(tx,a,equipment.id,b,rid):0;
   await audit(tx,a,endedAt?'Manutenção: corretiva registrada':'Manutenção: corretiva iniciada',rid,{tag:equipment.tag,startedAt,endedAt,points:points.length,stopped:!!impediment,released});
   return {id:rid,message:endedAt?`Corretiva de ${equipment.tag} registrada${released?' e equipamento liberado':''}.`:`Corretiva de ${equipment.tag} aberta${impediment?'; equipamento bloqueado para reservas até o fim':''}.`};
  });
 }catch(e){dbError(e);}
}

function readingOf(b:Row){
 if(b.reading==null||b.reading==='')return null;
 const kind=b.readingKind;if(kind!=='horimetro'&&kind!=='odometro')throw new AppError('Informe se a leitura é de horímetro ou odômetro.');
 return {kind:kind as 'horimetro'|'odometro',value:num(b.reading,'Leitura',0)};
}
async function insertReading(tx:Executor,a:Actor,equipmentId:string,kind:string,value:number,readAt:string,source:'manual'|'manutencao',recordId:string|null,note:string){
 const rid=id();
 await tx.run('INSERT INTO equipment_readings(id,equipment_id,kind,value,read_at,registered_at,source,record_id,note,author_id,author_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)',rid,equipmentId,kind,value,readAt,now(),source,recordId,note,a.id,a.name);
 return rid;
}
/** Liberação técnica de outros impedimentos do equipamento (ex.: NC crítica) ao fim da manutenção. */
async function releaseOthers(tx:Executor,a:Actor,equipmentId:string,b:Row,recordId:string){
 if(!Array.isArray(b.releaseImpedimentIds)||!b.releaseImpedimentIds.length)return 0;
 const reason=required(b.releaseReason,'Justificativa da liberação técnica',500);
 let n=0;
 for(const iid of b.releaseImpedimentIds.slice(0,10)){
  const imp=await tx.first('SELECT id,kind,reason FROM equipment_impediments WHERE id=? AND equipment_id=? AND released_at IS NULL',idOf(iid,'Impedimento'),equipmentId);
  if(!imp)throw new AppError('Impedimento não encontrado ou já liberado. Atualize a tela.',409);
  n+=await release(tx,a,imp.id,reason,`Registro de manutenção ${recordId.slice(0,8)}`);
  await audit(tx,a,'Condição técnica: liberação técnica',equipmentId,{impediment:imp.id,reason,evidence:`Registro de manutenção ${recordId}`});
 }
 return n;
}

async function lockRecord(tx:Executor,recordId:string){
 const r=await tx.first('SELECT r.*,p.method,p.name plan_name,e.tag FROM maintenance_records r LEFT JOIN maintenance_plans p ON p.id=r.plan_id JOIN equipment e ON e.id=r.equipment_id WHERE r.id=? FOR UPDATE OF r',recordId);
 if(!r)throw new AppError('Registro de manutenção não encontrado.',404);
 return r;
}

/** Itens executados (preventiva: textos do registro, marcação vinda da tela) ou pontos (corretiva). */
function itemsFor(r:Row,raw:unknown){
 if(r.kind==='preventiva'){
  const done=Array.isArray(raw)?raw:[];
  return (r.items as Row[]).map((it,i)=>({text:it.text,done:!!(done[i] as Row)?.done}));
 }
 return textList(Array.isArray(raw)?raw.map(x=>typeof x==='string'?x:(x as Row)?.text):raw,'Pontos manutenidos',80,500).map(text=>({text}));
}

async function updateRecord(a:Actor,b:Row){
 return db().tx(async tx=>{
  const r=await lockRecord(tx,idOf(b.id,'Registro'));
  if(r.status!=='em_andamento')throw new AppError('Só manutenções em andamento podem ser alteradas.',409);
  const items=b.items===undefined?r.items:itemsFor(r,b.items);
  const ncs=b.nonconformities===undefined?r.nonconformities:textList(b.nonconformities,'Inconformidades encontradas',60,300);
  const team=b.teamIds===undefined?r.team_ids:(await operatorsOf(b.teamIds,'Equipe')).map(x=>x.id);
  await tx.run('UPDATE maintenance_records SET items=?::text::jsonb,nonconformities=?::text::jsonb,notes=?,failure=?,team_ids=?::text[] WHERE id=?',JSON.stringify(items),JSON.stringify(ncs),b.notes===undefined?r.notes:text(b.notes,4000),b.failure===undefined?r.failure:text(b.failure,1000),team,r.id);
  return {ok:true};
 });
}

async function addNote(a:Actor,b:Row){
 const note=required(b.text,'Apontamento',2000);
 return db().tx(async tx=>{
  const r=await lockRecord(tx,idOf(b.id,'Registro'));
  if(r.status==='anulada')throw new AppError('Registro anulado.',409);
  const nid=id();
  await tx.run('INSERT INTO maintenance_notes(id,record_id,text,noted_at,author_id,author_name) VALUES(?,?,?,?,?,?)',nid,r.id,note,now(),a.id,a.name);
  await audit(tx,a,'Manutenção: apontamento registrado',r.id,{tag:r.tag,late:r.status==='concluida'});
  return {id:nid,message:'Apontamento registrado.'};
 });
}

async function finish(a:Actor,b:Row){
 const endedAt=when(b.endedAt,'Fim');
 try{
  return await db().tx(async tx=>{
   const r=await lockRecord(tx,idOf(b.id,'Registro'));
   if(r.status==='concluida')return {ok:true,repeated:true};
   if(r.status!=='em_andamento')throw new AppError('Este registro foi anulado.',409);
   if(Date.parse(endedAt)<=Date.parse(r.started_at))throw new AppError('O fim da manutenção deve ser depois do início.');
   const items=itemsFor(r,b.items);
   if(r.kind==='corretiva'&&!items.length)throw new AppError('Informe ao menos um ponto manutenido.');
   const ncs=textList(b.nonconformities,'Inconformidades encontradas',60,300);
   // Preventiva por horímetro/odômetro: a leitura no fim é obrigatória (base dos próximos marcos).
   const reading=r.kind==='preventiva'&&r.method!=='dias'
    ?{kind:r.method as 'horimetro'|'odometro',value:num(b.reading,`Leitura do ${r.method==='horimetro'?'horímetro':'odômetro'} no fim`,0)}
    :readingOf(b);
   const t=now(),late=Date.now()-Date.parse(endedAt)>24*HOUR?1:0;
   await tx.run(`UPDATE maintenance_records SET status='concluida',ended_at=?,items=?::text::jsonb,nonconformities=?::text::jsonb,notes=?,failure=?,reading=?,reading_kind=?,late=?,closed_at=?,closed_by=?,closed_by_name=? WHERE id=?`,
    endedAt,JSON.stringify(items),JSON.stringify(ncs),b.notes===undefined?r.notes:text(b.notes,4000),b.failure===undefined?r.failure:text(b.failure,1000),reading?.value??null,reading?.kind??null,late,t,a.id,a.name,r.id);
   if(reading)await insertReading(tx,a,r.equipment_id,reading.kind,reading.value,endedAt,'manutencao',r.id,r.kind==='preventiva'?`Preventiva: ${r.plan_name}`:'Manutenção corretiva');
   let released=0;
   if(r.impediment_id)released+=await release(tx,a,r.impediment_id,`Fim da manutenção ${r.kind}`,`Registro de manutenção ${r.id.slice(0,8)}`);
   released+=await releaseOthers(tx,a,r.equipment_id,b,r.id);
   const hours=Math.round((Date.parse(endedAt)-Date.parse(r.started_at))/36000)/100;
   await audit(tx,a,r.kind==='preventiva'?'Manutenção: preventiva concluída':'Manutenção: corretiva concluída',r.id,{tag:r.tag,plan:r.plan_name||undefined,cycle:r.cycle||undefined,endedAt,hours,done:items.filter(x=>(x as Row).done).length,nonconformities:ncs.length,released,late:!!late});
   return {ok:true,hours,message:`Manutenção concluída: ${hours.toLocaleString('pt-BR')} h${released?' · equipamento liberado':''}${late?' · registrada como tardia':''}.`};
  });
 }catch(e){dbError(e);}
}

async function voidRecord(a:Actor,b:Row){
 if(!isManager(a))throw new AppError('Somente o gestor anula registros de manutenção.',403);
 const reason=required(b.reason,'Motivo da anulação',500);
 return db().tx(async tx=>{
  const r=await lockRecord(tx,idOf(b.id,'Registro'));
  if(r.status==='anulada')return {ok:true,repeated:true};
  await tx.run("UPDATE maintenance_records SET status='anulada',voided_at=?,voided_by=?,voided_by_name=?,void_reason=? WHERE id=?",now(),a.id,a.name,reason,r.id);
  if(r.impediment_id)await release(tx,a,r.impediment_id,'Registro de manutenção anulado: '+reason,`Registro de manutenção ${r.id.slice(0,8)}`);
  await audit(tx,a,'Manutenção: registro anulado',r.id,{tag:r.tag,kind:r.kind,cycle:r.cycle||undefined,reason});
  return {ok:true,message:r.kind==='preventiva'?'Registro anulado. O marco volta a ficar em aberto.':'Registro anulado.'};
 });
}

async function registerReading(a:Actor,b:Row){
 const equipment=await first('SELECT id,tag,active FROM equipment WHERE id=?',idOf(b.equipmentId,'Equipamento'));
 if(!equipment)throw new AppError('Equipamento não encontrado.',404);
 const kind=b.kind;if(kind!=='horimetro'&&kind!=='odometro')throw new AppError('Escolha horímetro ou odômetro.');
 const value=num(b.value,'Leitura',0),readAt=when(b.readAt,'Data da leitura'),note=text(b.note,300);
 try{
  return await db().tx(async tx=>{
   const rid=await insertReading(tx,a,equipment.id,kind,value,readAt,'manual',null,note);
   await audit(tx,a,'Manutenção: leitura registrada',equipment.id,{tag:equipment.tag,kind,value,readAt});
   return {id:rid,message:`Leitura de ${equipment.tag} registrada: ${value.toLocaleString('pt-BR')} ${kind==='horimetro'?'h':'km'}.`};
  });
 }catch(e){dbError(e);}
}

async function voidReading(a:Actor,b:Row){
 if(!isManager(a))throw new AppError('Somente o gestor anula leituras.',403);
 const reason=required(b.reason,'Motivo da anulação',500);
 return db().tx(async tx=>{
  const r=await tx.first('SELECT r.*,e.tag FROM equipment_readings r JOIN equipment e ON e.id=r.equipment_id WHERE r.id=? FOR UPDATE OF r',idOf(b.id,'Leitura'));
  if(!r)throw new AppError('Leitura não encontrada (leituras de abastecimento são corrigidas no próprio abastecimento).',404);
  if(r.voided_at)return {ok:true,repeated:true};
  await tx.run('UPDATE equipment_readings SET voided_at=?,voided_by=?,void_reason=? WHERE id=?',now(),a.id,reason,r.id);
  await audit(tx,a,'Manutenção: leitura anulada',r.equipment_id,{tag:r.tag,kind:r.kind,value:Number(r.value),readAt:r.read_at,reason});
  return {ok:true,message:'Leitura anulada.'};
 });
}

export async function maintenanceMutate(path:string,b:Row,member:Member){
 if(path==='maint/reading')return registerReading(await requireAny(member,['manutencao','operacao']) as Actor,b);
 const a=await requireAny(member,['manutencao']) as Actor;
 if(path==='maint/plan')return savePlan(a,b);
 if(path==='maint/start')return startPreventive(a,b);
 if(path==='maint/corrective')return createCorrective(a,b);
 if(path==='maint/update')return updateRecord(a,b);
 if(path==='maint/note')return addNote(a,b);
 if(path==='maint/finish')return finish(a,b);
 if(path==='maint/void')return voidRecord(a,b);
 if(path==='maint/reading/void')return voidReading(a,b);
 throw new AppError('Ação não encontrada.',404);
}

/* ───────────── consultas de registros e leituras ───────────── */

const durationH=(r:Row)=>r.ended_at?Math.round((Date.parse(r.ended_at)-Date.parse(r.started_at))/36000)/100:null;

export async function maintenanceRecord(member:Member,recordId:string){
 const a=await requireAny(member,[...VIEW]) as Actor;
 const r=await first(`SELECT r.*,r.reading::float8 reading,e.tag,e.description equipment_description,t.name type_name,p.name plan_name,p.method,p.tasks plan_tasks,p.attention,p.nonconformities plan_nonconformities,p.estimated_minutes
  FROM maintenance_records r JOIN equipment e ON e.id=r.equipment_id LEFT JOIN equipment_types t ON t.id=e.type_id LEFT JOIN maintenance_plans p ON p.id=r.plan_id WHERE r.id=?`,idOf(recordId,'Registro'));
 if(!r)throw new AppError('Registro de manutenção não encontrado.',404);
 const [notes,team,impediments]=await Promise.all([
  all('SELECT * FROM maintenance_notes WHERE record_id=? ORDER BY noted_at',r.id),
  r.team_ids.length?all('SELECT id,name FROM operators WHERE id = ANY(?::text[])',r.team_ids):[],
  all('SELECT id,kind,reason,opened_at FROM equipment_impediments WHERE equipment_id=? AND released_at IS NULL AND id IS DISTINCT FROM ?',r.equipment_id,r.impediment_id),
 ]);
 return {record:{...r,hours:durationH(r),manHours:r.ended_at?Math.round(durationH(r)!*(1+r.team_ids.length)*100)/100:null},notes,team,impediments,canEdit:canMaintain(a),canVoid:isManager(a)};
}

export async function maintenanceRecords(member:Member,url:URL){
 const a=await requireAny(member,['manutencao']) as Actor;
 const kind=url.searchParams.get('kind')==='preventiva'?'preventiva':'corretiva';
 const days=periodDays(url.searchParams.get('periodo'));
 const where=['r.kind=?'],values:unknown[]=[kind];
 if(days){where.push("r.started_at::timestamptz > now() - make_interval(days => ?)");values.push(days);}
 for(const [param,col] of [['equipment','r.equipment_id'],['type','e.type_id'],['status','r.status']] as const){const v=url.searchParams.get(param);if(v){where.push(col+'=?');values.push(v);}}
 if(!url.searchParams.get('status'))where.push("r.status<>'anulada'");
 const rows=await all(`SELECT r.id,r.kind,r.equipment_id,r.plan_id,r.cycle,r.due_label,r.status,r.started_at,r.ended_at,r.responsible_name,r.team_ids,r.items,r.notes,r.failure,r.stopped,r.late,r.void_reason,r.reading::float8 reading,r.reading_kind,
  e.tag,e.type_id,t.name type_name,p.name plan_name,(SELECT count(*)::int FROM maintenance_notes n WHERE n.record_id=r.id) notes_count
  FROM maintenance_records r JOIN equipment e ON e.id=r.equipment_id LEFT JOIN equipment_types t ON t.id=e.type_id LEFT JOIN maintenance_plans p ON p.id=r.plan_id
  WHERE ${where.join(' AND ')} ORDER BY r.started_at DESC LIMIT 500`,...values);
 const list:Row[]=rows.map(r=>({...r,hours:durationH(r)}));
 const done=list.filter(r=>r.status==='concluida');
 const byEquipment=new Map<string,{tag:string,n:number}>();for(const r of list.filter(x=>x.status!=='anulada')){const v=byEquipment.get(r.equipment_id)||{tag:r.tag,n:0};v.n++;byEquipment.set(r.equipment_id,v);}
 const top=[...byEquipment.values()].sort((x,y)=>y.n-x.n)[0]||null;
 const hours=Math.round(done.reduce((s,r)=>s+(r.hours||0),0)*100)/100;
 const [equipment,types,operators]=await Promise.all([all('SELECT id,tag,description,type_id,active FROM equipment ORDER BY tag'),all('SELECT id,name FROM equipment_types ORDER BY name'),all('SELECT id,name,active FROM operators ORDER BY name')]);
 return {records:list,equipment,types,operators,period:days,
  cards:{total:list.filter(r=>r.status!=='anulada').length,open:list.filter(r=>r.status==='em_andamento').length,hours,mttr:done.length?Math.round(hours/done.length*100)/100:null,top,stopped:list.filter(r=>r.status==='em_andamento'&&r.stopped).length},
  canEdit:canMaintain(a),canVoid:isManager(a),generatedAt:now()};
}

export async function maintenanceReadings(member:Member,url:URL){
 const a=await requireAny(member,['manutencao','operacao']) as Actor;
 const [equipment,m,planned]=await Promise.all([
  all('SELECT e.id,e.tag,e.description,e.type_id,t.name type_name FROM equipment e LEFT JOIN equipment_types t ON t.id=e.type_id WHERE e.active=1 ORDER BY e.tag'),
  meters(),
  all("SELECT DISTINCT equipment_id,method FROM maintenance_plans WHERE active=1 AND method<>'dias'"),
 ]);
 const eq=url.searchParams.get('equipment');
 const history=eq?await all(`SELECT * FROM (SELECT r.id,r.kind,r.value::float8 value,r.read_at,r.source,r.note,r.author_name,r.voided_at,r.void_reason,true manual FROM equipment_readings r WHERE r.equipment_id=?
   UNION ALL SELECT s.id,'horimetro',greatest(s.hourmeter_milli,coalesce(s.hourmeter_end_milli,0))/1000.0,s.occurred_at,'abastecimento','',s.author_name,NULL,NULL,false FROM supplies s WHERE s.equipment_id=? AND s.status='confirmed' AND s.hourmeter_milli IS NOT NULL) x
   ORDER BY read_at::timestamptz DESC LIMIT 200`,eq,eq):[];
 return {equipment:equipment.map(e=>({...e,horimetro:m.get(e.id,'horimetro'),odometro:m.get(e.id,'odometro'),meters:planned.filter(p=>p.equipment_id===e.id).map(p=>p.method),
  rate:{horimetro:m.rate(e.id,'horimetro'),odometro:m.rate(e.id,'odometro')}})),history,canVoid:isManager(a),generatedAt:now()};
}
