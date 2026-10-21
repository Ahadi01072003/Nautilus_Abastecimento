// Relatórios da OS: planilha Excel completa (uma aba por assunto) e dados do relatório em PDF.
// O alcance é o mesmo da tela da OS (orderDetail confere acesso e escopo de organizações).
import {db,type Row} from './db';
import {type Member} from './permissions';
import {orderDetail} from './operation';
import {osNumber} from './planning';
import {audit} from './registry';
import {xlsx,brDateTime,type Sheet,type Cell} from './files';

const STEP:Record<string,string>={nao_iniciada:'Não iniciada',em_execucao:'Em execução',bloqueada:'Bloqueada',pausada:'Pausada',concluida:'Concluída',dispensada:'Dispensada'};
export const ORDER_STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada'};
const KIND:Record<string,string>={ocorrencia:'Ocorrência',impacto:'Impacto',bloqueio:'Bloqueio'};
const EVENT:Record<string,string>={inicio:'Início',bloqueio:'Bloqueio',pausa:'Pausa',retomada:'Retomada',termino:'Término',dispensa:'Dispensa',encerramento:'Encerramento',encerramento_pendente:'Encerramento pendente',nc_critica:'NC crítica',interrupcao_tecnica:'Interrupção técnica'};
const MOMENT:Record<string,string>={pre_atividade:'Pré-atividade',pre_uso:'Pré-uso',durante:'Durante',pos_atividade:'Pós-atividade'};
const d=(v:unknown):Cell=>v?new Date(String(v)):null;
const ms=(v:unknown)=>Date.parse(String(v));
const minutes=(x:number)=>Math.round(x/60000);

/** Tudo o que o relatório e a planilha mostram, já calculado (tempos efetivos, parados e desvios). */
export async function orderReport(member:Member,id:string){
 const data=await orderDetail(member,id);
 const now=Date.now();
 const order=data.order,plan=data.plan!;
 const intervals=data.intervals as Row[];
 const steps=(data.steps as Row[]).map((s):Row=>{
  const p=(plan.steps as Row[]).find(x=>x.id===s.plan_step_id)!;
  const iv=intervals.filter(i=>i.os_step_id===s.id);
  const total=(k:string)=>iv.filter(i=>i.kind===k).reduce((t,i)=>t+((i.end_at?ms(i.end_at):now)-ms(i.start_at)),0);
  return {...s,name:p.name,position:p.position,planned_start:p.planned_start,planned_end:p.planned_end,equipment_ids:p.equipment_ids as string[],operator_ids:p.operator_ids as string[],
   active:total('ativo'),stopped:total('interrompido'),
   startDev:s.actual_start&&p.planned_start?ms(s.actual_start)-ms(p.planned_start):null,endDev:s.actual_end&&p.planned_end?ms(s.actual_end)-ms(p.planned_end):null};
 }).sort((a,b)=>a.position-b.position);
 // Tempo efetivo da OS: união dos intervalos ativos (etapas em paralelo não contam duas vezes).
 const spans=intervals.filter(i=>i.kind==='ativo').map(i=>[ms(i.start_at),i.end_at?ms(i.end_at):now]).sort((a,b)=>a[0]-b[0]);
 let effective=0,cur:number[]|null=null;
 for(const s of spans){if(!cur||s[0]>cur[1]){if(cur)effective+=cur[1]-cur[0];cur=[...s];}else cur[1]=Math.max(cur[1],s[1]);}
 if(cur)effective+=cur[1]-cur[0];
 const tag=(eid:string)=>(data.equipmentTags as Row[]).find(t=>t.id===eid)?.tag||eid;
 const person=(oid:string)=>(data.operatorNames as Row[]).find(t=>t.id===oid)?.name||oid;
 const org=(data.orgs as Row[])[0];
 const [loc,requester]=await Promise.all([
  order.location_id?db().first('SELECT name FROM locations WHERE id=?',order.location_id):null,
  plan.requester_person_id?db().first('SELECT name FROM requester_people WHERE id=?',plan.requester_person_id):null,
 ]);
 return {data,order,plan,steps,effective,tag,person,org,location:(loc?.name as string)||null,requester:(requester?.name as string)||null,now:new Date(now).toISOString()};
}

export async function orderWorkbook(member:Member,id:string){
 const r=await orderReport(member,id);
 const {data,order,plan,steps,org}=r;
 const stepName=(sid:string|null)=>sid?steps.find(s=>s.id===sid)?.name||'—':'OS';
 const sheets:Sheet[]=[
  {name:'Resumo',columns:['Campo','Valor'],rows:[
   ['OS',osNumber(order.number)],['Atividade',`${order.activity_code} · ${order.activity_name}`],['Situação',ORDER_STATUS[order.status]],['Solicitante',org?`${org.acronym} · ${org.name}`:''],
   ['Pessoa solicitante',r.requester||''],['Local',r.location||''],['Fluxo',plan.free?'Sem fluxo':`${plan.activity_code} v${plan.flow_version}`],['Código da atividade',order.activity_code||''],['Origem',order.origin==='realizada'?'Realizada sem planejamento (registro posterior)':'Planejada'],['Revisão do planejamento',order.revision?`${order.revision}${plan.revision_reason?' · '+plan.revision_reason:''}`:'Original'],['Início planejado',d(order.planned_start)],['Fim planejado',d(order.planned_end)],
   ['Início real',d(order.actual_start)],['Fim real',d(order.actual_end)],['Encerramento administrativo',d(order.closed_at)],['Tempo efetivo (min)',minutes(r.effective)],
   ['Etapas concluídas',`${steps.filter(s=>['concluida','dispensada'].includes(s.status)).length} de ${steps.length}`],['Apontamentos',(data.occurrences as Row[]).length],['Emitido em',d(r.now)],['Emitido por',member.name],
  ]},
  {name:'Etapas',columns:['#','Etapa','Situação','Início planejado','Fim planejado','Início real','Fim real','Efetivo (min)','Parado (min)','Desvio de início (min)','Desvio de fim (min)','Equipamentos','Colaboradores'],
   rows:steps.map((s,i)=>[i+1,s.name,STEP[s.status],d(s.planned_start),d(s.planned_end),d(s.actual_start),d(s.actual_end),minutes(s.active),minutes(s.stopped),s.startDev===null?null:minutes(s.startDev),s.endDev===null?null:minutes(s.endDev),
    s.equipment_ids.map(r.tag).join(', '),s.operator_ids.map(r.person).join(', ')])},
  {name:'Períodos',columns:['Etapa','Tipo','Motivo','Início','Fim','Duração (min)'],
   rows:(data.intervals as Row[]).map(i=>[stepName(i.os_step_id),i.kind==='ativo'?'Trabalho':'Parado',i.kind==='ativo'?'':EVENT[i.start_kind]||'',d(i.start_at),d(i.end_at),minutes((i.end_at?ms(i.end_at):Date.parse(r.now))-ms(i.start_at))])},
  {name:'Apontamentos',columns:['Etapa','Tipo','Bloqueia','Categoria','Descrição','Severidade','Ocorrido em','Registrado em','Autor','Impacto: início','Impacto: fim','Situação','Resolução','Resolvido por','Resolvido em'],
   rows:(data.occurrences as Row[]).slice().reverse().map(o=>[stepName(o.os_step_id),KIND[o.kind],o.blocking?'Sim':'Não',o.category_name,o.description,o.severity,d(o.occurred_at),d(o.registered_at),o.author_name,d(o.impact_start),d(o.impact_end),o.status==='resolvido'?'Resolvido':'Aberto',o.resolution,o.resolved_by_name,d(o.resolved_at)])},
  {name:'Checklists',columns:['Checklist','Versão','Momento','Equipamento','Obrigatório','Situação','Respostas','NC','Concluído por','Concluído em'],
   rows:(data.instances as Row[]).map(i=>{const req=(data.requirements as Row[]).find(q=>q.id===i.requirement_id);return [`${i.code} · ${i.title}`,i.version,MOMENT[i.moment],i.equipment_id?r.tag(i.equipment_id):'',req?(req.mandatory?'Sim':'Não'):'Complementar',i.status==='concluido'?'Concluído':'Em preenchimento',i.answers.length,i.answers.filter((a:Row)=>a.answer==='NC').length,i.completed_by_name,d(i.completed_at)];})},
  {name:'Respostas',columns:['Checklist','Pergunta','Resposta','Observação'],
   rows:(data.instances as Row[]).flatMap(i=>(i.answers as Row[]).map(a=>{const q=(data.questions as Row[]).find(x=>x.id===a.question_id);return [i.code,q?`${q.position}. ${q.text}`:a.question_id,a.answer==='NA'?'N/A':a.answer,a.note];}))},
  {name:'Histórico',columns:['Quando','Evento','Etapa','Autor','Detalhe'],rows:(data.events as Row[]).slice().reverse().map(e=>[d(e.occurred_at),EVENT[e.kind]||e.kind,stepName(e.os_step_id),e.author_name,e.detail?.reason||e.detail?.resolution||''])},
 ];
 await db().tx(tx=>audit(tx,member,'Exportação: planilha da OS',order.id,{number:order.number}));
 const file=xlsx(sheets);
 const name=`${osNumber(order.number).replace(' ','-')}_${new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date())}.xlsx`;
 return new Response(new Uint8Array(file),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export {brDateTime};
