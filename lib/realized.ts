// Operação › Registrar atividade realizada: atividade feita sem planejamento prévio (urgência).
// Usa o mesmo rascunho e formulário da OS sem fluxo; ao registrar, cria a OS já executada com o
// início e o fim reais (eventos, período de trabalho e término), confirma as reservas do período,
// aplica os checklists previstos e encerra a OS (ou deixa em encerramento pendente, se faltar checklist).
import {db,type Row} from './db';
import {AppError,required} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {loadPlan,validation,validateDraft,createRequirements,osNumber,realizedNotes} from './planning';
import {checkClosure,event} from './operation';
import {newDailies,toRate} from './finance';
import {rateAt} from './recoverables';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const idOf=(value:unknown,label:string)=>required(value,label,100);
type Actor=Member&{capabilities:string[],org_scope:string[]};
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);
const tag=(a:Actor)=>isManager(a)||a.capabilities.includes('planejamento')?'Planejamento':'Operação';
const H=3600_000,ms=(v:string)=>Date.parse(v);
type Use={key:string,equipmentId:string,start:string,end:string,recoverable:boolean};

/** Conferência das horas de uso do registro: horas por linha, recobráveis × demais, diárias novas e o
 * valor que vão para o Financeiro. Pendência quando a linha recobrável não tem tarifa para o cliente
 * ou colide com outro uso do equipamento já registrado no Financeiro. */
export async function realizedReview(plan:Row){
 const uses=(plan.realized_uses||[]) as Use[];
 const tags=new Map((await db().all('SELECT id,tag FROM equipment WHERE id = ANY(?::text[])',[...new Set(uses.map(u=>u.equipmentId))])).map(e=>[e.id as string,e.tag as string]));
 const rates=plan.org_id?(await db().all('SELECT * FROM recovery_rates WHERE org_id=?',plan.org_id)).map(toRate):[];
 const rows=uses.map(u=>({...u,tag:tags.get(u.equipmentId)||u.equipmentId,hours:Math.round((ms(u.end)-ms(u.start))/H*100)/100}));
 const errors:{message:string}[]=[];
 for(const [i,u] of rows.entries()){
  if(!u.recoverable)continue;
  const label=`Uso ${i+1} (${u.tag})`;
  if(!plan.org_id||!rateAt(rates,u.equipmentId,plan.org_id,ms(u.start))){errors.push({message:`${label}: sem tarifa de recobrável para este cliente nessa data. Desmarque “Entra no cálculo de recobráveis”.`});continue;}
  const clash=await db().first(`SELECT w.number FROM equipment_uses x JOIN work_orders w ON w.id=x.work_order_id WHERE x.equipment_id=?
   AND tstzrange(x.started_at::timestamptz,coalesce(x.ended_at::timestamptz,'infinity'),'[)') && tstzrange(?::timestamptz,?::timestamptz,'[)') LIMIT 1`,u.equipmentId,u.start,u.end);
  if(clash)errors.push({message:`${label}: o equipamento já está em uso nesse horário na ${osNumber(clash.number)} (registrado no Financeiro).`});
 }
 let dailies=0,valueCents=0;
 if(plan.org_id&&!errors.length)for(const eq of new Set(rows.filter(u=>u.recoverable).map(u=>u.equipmentId))){
  const p=await newDailies(db(),eq,plan.org_id,rows.filter(u=>u.recoverable&&u.equipmentId===eq));dailies+=p.n;valueCents+=p.cents;}
 const sum=(l:typeof rows)=>Math.round(l.reduce((s,u)=>s+u.hours,0)*100)/100;
 return {errors,realized:{rows,recoverableHours:sum(rows.filter(u=>u.recoverable)),otherHours:sum(rows.filter(u=>!u.recoverable)),dailies,valueCents}};
}

/** Conferência do rascunho: a do planejamento e, na atividade realizada, as horas de uso. */
export async function validateRealized(member:Member,planId:string){
 const result=await validateDraft(member,planId);
 const plan=await loadPlan(idOf(planId,'Planejamento'));
 if(plan?.mode!=='realizada')return {...result,realized:null};
 const r=await realizedReview(plan);
 return {...result,errors:[...result.errors,...r.errors],realized:r.realized};
}

/** Equipamentos com tarifa de recobrável ativa para o cliente na data (sem valores): a tela mostra a
 * marca "Entra no cálculo de recobráveis" só para eles. */
export async function recoverableEquipment(member:Member,url:URL){
 const a=await requireAny(member,['planejamento','operacao']) as Actor;
 const org=url.searchParams.get('org');
 if(!org||!inScope(a,org))return {equipmentIds:[] as string[]};
 const at=url.searchParams.get('at'),t=at&&Number.isFinite(Date.parse(at))?Date.parse(at):Date.now();
 const rates=(await db().all('SELECT * FROM recovery_rates WHERE org_id=?',org)).map(toRate);
 return {equipmentIds:[...new Set(rates.map(r=>r.equipmentId))].filter(e=>rateAt(rates,e,org,t)).sort()};
}

export async function realizeActivity(b:Row,member:Member){
 const a=await requireAny(member,['planejamento','operacao']) as Actor;
 const plan=await loadPlan(idOf(b.id,'Registro'));
 if(!plan||plan.mode!=='realizada'||(plan.author_id!==a.id&&!isManager(a)))throw new AppError('Registro de atividade não encontrado.',404);
 const key=required(b.launchKey,'Identificador do registro',100);
 if(plan.status!=='draft'){
  if(plan.launch_key===key&&plan.work_order_id){const w=await db().first('SELECT id,number FROM work_orders WHERE id=?',plan.work_order_id);return {workOrderId:w!.id,number:w!.number,repeated:true,message:`${osNumber(w!.number)} já foi registrada.`};}
  throw new AppError('Este registro já foi concluído ou descartado.',409);
 }
 if(plan.org_id&&!inScope(a,plan.org_id))throw new AppError('Organização fora do seu acesso.',403);
 if(b.version!==plan.version)throw new AppError('O registro mudou desde a sua conferência. Confira de novo antes de registrar.',409);
 const check=await validation(plan,a),review=await realizedReview(plan);
 const pending=check.errors.length+review.errors.length;
 if(pending)throw new AppError(`Há ${pending} pendência(s) no registro. Confira o formulário.`,409);
 // Apontamentos do registro: revalidados contra o período final (o período pode ter mudado depois).
 const notes=await realizedNotes(plan.realized_notes||[],plan.planned_start,plan.planned_end);
 try{
  return await db().tx(async tx=>{
   const locked=await tx.first('SELECT status,version FROM plans WHERE id=? FOR UPDATE',plan.id);
   if(locked!.status!=='draft'||locked!.version!==plan.version)throw new AppError('O registro mudou desde a sua conferência. Confira de novo antes de registrar.',409);
   const wid=id(),t=now(),start=plan.planned_start as string,end=plan.planned_end as string;
   const w=await tx.first(`INSERT INTO work_orders(id,current_plan_id,original_plan_id,activity_type_id,org_id,location_id,planned_start,planned_end,actual_start,launched_at,launched_by,launched_by_name,title,code,origin,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'realizada','em_andamento') RETURNING number`,wid,plan.id,plan.id,plan.activity_type_id,plan.org_id,plan.location_id,start,end,start,t,a.id,a.name,plan.title,plan.code||null);
   await tx.run("UPDATE plans SET status='launched',work_order_id=?,launch_key=?,launched_at=?,launched_by=?,updated_at=?,version=version+1 WHERE id=?",wid,key,t,a.id,t,plan.id);
   await tx.run("UPDATE reservations SET status='confirmada' WHERE plan_id=? AND status='provisoria'",plan.id);
   // Execução já ocorrida: início e término nas datas reais, com o período de trabalho entre eles.
   const step=plan.steps.find(s=>s.included)!;
   const sid=id();
   await tx.run("INSERT INTO os_steps(id,work_order_id,step_key,plan_step_id,status,actual_start,actual_end) VALUES(?,?,?,?,'concluida',?,?)",sid,wid,step.step_key,step.id,start,end);
   const wo={id:wid,number:w!.number,status:'em_andamento'};
   const e1=await event(tx,a,wo,sid,'inicio',`realize:start:${wid}`,{late:true,source:'atividade realizada'},start);
   // Bloqueios informados dividem o período: trabalho → parado → trabalho (o tempo efetivo desconta as paradas).
   const iv=(kind:string,s0:string,s1:string,ev0:string,ev1:string)=>tx.run('INSERT INTO step_intervals(id,os_step_id,kind,start_at,end_at,start_event_id,end_event_id) VALUES(?,?,?,?,?,?,?)',id(),sid,kind,s0,s1,ev0,ev1);
   let cursor=start,cursorEvent=e1;
   for(const [i,n] of notes.entries()){
    const oid=id(),blocking=n.kind==='bloqueio';
    // Impacto: início no "quando ocorreu"; com fim informado já nasce encerrado, sem fim fica em aberto.
    const impact=n.kind==='impacto',closed=blocking||(impact&&!!n.until);
    await tx.run(`INSERT INTO occurrences(id,work_order_id,os_step_id,kind,blocking,category_id,description,impact_start,impact_end,occurred_at,registered_at,late,author_id,author_name,operation_key,status,resolved_at,resolved_by,resolved_by_name,resolution)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`,oid,wid,sid,n.kind,blocking?1:0,n.categoryId,n.description,impact?n.at:null,impact?n.until:null,n.at,t,a.id,a.name,`realize:note:${wid}:${i}`,
     closed?'resolvido':'aberto',blocking?n.until:closed?t:null,closed?a.id:null,closed?a.name:null,blocking?'Registrado com a atividade realizada':null);
    if(!blocking)continue;
    const b0=await event(tx,a,wo,sid,'bloqueio',`realize:block:${wid}:${i}`,{occurrence:oid,category:n.categoryName,late:true},n.at);
    const b1=await event(tx,a,wo,sid,'retomada',`realize:resume:${wid}:${i}`,{late:true},n.until!);
    await iv('ativo',cursor,n.at,cursorEvent,b0);await iv('interrompido',n.at,n.until!,b0,b1);
    cursor=n.until!;cursorEvent=b1;
   }
   const e2=await event(tx,a,wo,sid,'termino',`realize:end:${wid}`,{late:true,source:'atividade realizada'},end);
   await iv('ativo',cursor,end,cursorEvent,e2);
   // Horas de uso recobráveis: viram usos no Financeiro ligados à OS (as demais ficam no registro).
   for(const [i,u] of review.realized.rows.entries()){
    if(!u.recoverable)continue;
    const uid=id();
    await tx.run(`INSERT INTO equipment_uses(id,work_order_id,equipment_id,org_id,started_at,ended_at,end_source,ended_by,ended_by_name,review,started_by,started_by_name,operation_key,created_at)
     VALUES(?,?,?,?,?,?,'registrado',?,?,'normal',?,?,?,?)`,uid,wid,u.equipmentId,plan.org_id,u.start,u.end,a.id,a.name,a.id,a.name,`realize:use:${wid}:${i}`,t);
    await audit(tx,a,`${tag(a)}: uso de equipamento registrado`,uid,{number:w!.number,equipmentId:u.equipmentId,startedAt:u.start,endedAt:u.end,source:'atividade realizada'});
   }
   const required=await createRequirements(tx,wid,plan);
   await audit(tx,a,`${tag(a)}: atividade realizada registrada`,wid,{number:w!.number,code:plan.code||undefined,title:plan.title,start,end,reservations:plan.steps.flatMap(s=>s.equipment_ids).length,checklists:required,notes:notes.length});
   const closure=await checkClosure(tx,a,wo);
   return {workOrderId:wid,number:w!.number as number,closure,message:closure==='concluida'?`${osNumber(w!.number)} registrada e encerrada.`:`${osNumber(w!.number)} registrada. Falta preencher checklist obrigatório para encerrar (em Apontamentos).`};
  });
 }catch(e){
  const msg=(e as {message?:string}).message||'';
  if(/Equipamento reservado no período/.test(msg))throw new AppError('Um dos equipamentos já estava reservado para outra atividade nesse período. Confira o equipamento ou o horário.',409);
  if(/impedimento técnico/.test(msg))throw new AppError('Um dos equipamentos estava bloqueado por impedimento técnico nesse período. Confira o equipamento.',409);
  if(/Equipamento já em uso no período/.test(msg))throw new AppError(`Um uso recobrável colide com outro uso do equipamento na ${osNumber(Number((e as {detail?:string}).detail))}. Confira os horários.`,409);
  throw e;
 }
}
