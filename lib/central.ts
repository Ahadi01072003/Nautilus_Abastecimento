// Painel central: resumo de cada módulo e avisos de todo o sistema, conforme o acesso de quem vê.
// Cada aviso leva à tela (e ao item) de origem. Nenhum dado de fora do escopo da pessoa entra aqui.
import {db,type Row} from './db';
import {type Member,isManager,has,canPlan,canSeeOrders,loadAccess} from './permissions';
import {preventiveRows} from './maintenance';
import {osNumber} from './planning';
import {localDay,dateOf} from './maintenance-cycle';
import {rateAt} from './recoverables';
import {toRate} from './finance';

const all=(q:string,...v:unknown[])=>db().all(q,...v);
const HOUR=3600000,DAY=24*HOUR;
export type Severity='critico'|'atencao'|'info';
export type Alert={id:string,module:'abastecimento'|'operacao'|'planejamento'|'manutencao'|'financeiro',severity:Severity,title:string,detail:string,at:string|null,link:{view:string,os?:string}};
const RANK:Record<Severity,number>={critico:0,atencao:1,info:2};
const hm=(ms:number)=>{const h=Math.floor(ms/HOUR);return h>=48?`${Math.floor(h/24)} dias`:h>=1?`${h} h`:`${Math.max(1,Math.round(ms/60000))} min`;};
const qty=(milli:number,unit:string)=>`${(milli/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})} ${unit}`;

export async function centralState(member:Member){
 const a=await loadAccess(member);
 const manager=isManager(a),orders=canSeeOrders(a),planning=has(a,'planejamento'),maint=has(a,'manutencao');
 const maintView=maint||planning||has(a,'operacao');
 const scope=manager||!a.org_scope.length?null:a.org_scope as string[];
 const t=Date.now(),alerts:Alert[]=[];
 const out:Row={actor:{name:a.name,manager},generatedAt:new Date(t).toISOString(),sections:{}};

 // ── Abastecimento ──
 if(manager){
  const [fuels,requests]=await Promise.all([
   all('SELECT id,name,unit,stock_milli,minimum_milli,capacity_milli FROM fuels WHERE active=1 ORDER BY name'),
   all("SELECT r.id,r.fuel_id,r.requested_milli,r.received_milli,r.deadline,r.status,r.opened_at,f.name,f.unit FROM requests r JOIN fuels f ON f.id=r.fuel_id WHERE r.status IN ('open','purchasing','partial') ORDER BY r.deadline"),
  ]);
  for(const f of fuels)if(f.stock_milli<=f.minimum_milli)alerts.push({id:'fuel:'+f.id,module:'abastecimento',severity:'critico',title:`${f.name} ${f.stock_milli<f.minimum_milli?'abaixo do mínimo':'no mínimo'}`,detail:`Estoque ${qty(f.stock_milli,f.unit)} · mínimo ${qty(f.minimum_milli,f.unit)}`,at:null,link:{view:'estoque'}});
  for(const r of requests){const late=Date.parse(r.deadline)<t;alerts.push({id:'req:'+r.id,module:'abastecimento',severity:late?'critico':'atencao',title:`Reposição de ${r.name} ${late?'vencida':'pendente'}`,detail:`${qty(r.requested_milli-r.received_milli,r.unit)} a receber · prazo ${new Date(r.deadline).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})}`,at:r.opened_at,link:{view:'alertas'}});}
  out.sections.abastecimento={fuels:fuels.map(f=>({id:f.id,name:f.name,unit:f.unit,stock:f.stock_milli/1000,minimum:f.minimum_milli/1000,capacity:f.capacity_milli/1000,low:f.stock_milli<=f.minimum_milli})),requests:requests.length};
 }
 if(has(a,'abastecimento')){
  // Quem tem o módulo sem agendar nem registrar acompanha só as próprias solicitações.
  const own=!manager&&a.profile!=='fueler'&&!canPlan(a);
  const mine=own?' AND requester_id=?':'';
  const ap=await all(`SELECT status,count(*)::int n,count(*) FILTER (WHERE status='scheduled' AND scheduled_at::timestamptz < now())::int late FROM appointments WHERE status IN ('requested','scheduled')${mine} GROUP BY status`,...(mine?[a.id]:[]));
  const requested=ap.find(x=>x.status==='requested')?.n||0,scheduled=ap.find(x=>x.status==='scheduled')?.n||0,lateScheduled=ap.find(x=>x.status==='scheduled')?.late||0;
  out.sections.solicitacoes={requested,scheduled,lateScheduled,own};
  if(canPlan(a)&&requested)alerts.push({id:'appt:requested',module:'abastecimento',severity:'atencao',title:`${requested} solicitação(ões) de abastecimento aguardando agendamento`,detail:'Defina horário e responsável.',at:null,link:{view:'solicitacoes'}});
  if((a.profile==='fueler'||manager)&&lateScheduled)alerts.push({id:'appt:late',module:'abastecimento',severity:'atencao',title:`${lateScheduled} abastecimento(s) agendado(s) com horário vencido`,detail:'Registre o abastecimento ou reagende.',at:null,link:{view:a.profile==='fueler'?'abastecimentos':'solicitacoes'}});
 }

 // ── Operação ──
 if(orders){
  const sw=scope?' AND w.org_id = ANY(?::text[])':'',sv=scope?[scope]:[];
  const [rows,blocks]=await Promise.all([
   all(`SELECT w.id,w.number,w.status,w.planned_start,w.planned_end,w.actual_start,coalesce(nullif(w.title,''),t.name) activity_name,o.acronym
    FROM work_orders w JOIN activity_types t ON t.id=w.activity_type_id JOIN requester_orgs o ON o.id=w.org_id
    WHERE w.status IN ('programada','em_andamento','encerramento_pendente')${sw} ORDER BY w.planned_start LIMIT 500`,...sv),
   all(`SELECT x.work_order_id,count(*)::int n,min(x.occurred_at) since FROM occurrences x JOIN work_orders w ON w.id=x.work_order_id WHERE x.blocking=1 AND x.status='aberto'${sw} GROUP BY x.work_order_id`,...sv),
  ]);
  const today=localDay(t);
  const label=(w:Row)=>`${osNumber(w.number)} · ${w.activity_name} · ${w.acronym}`;
  for(const w of rows){
   const ps=Date.parse(w.planned_start),pe=Date.parse(w.planned_end);
   if(w.status==='programada'&&ps<t)alerts.push({id:'late:'+w.id,module:'operacao',severity:t-ps>DAY?'critico':'atencao',title:`Início vencido há ${hm(t-ps)}`,detail:label(w),at:w.planned_start,link:{view:'op-os',os:w.id}});
   if(w.status==='em_andamento'&&pe<t)alerts.push({id:'over:'+w.id,module:'operacao',severity:'critico',title:`Fora do planejado: fim previsto vencido há ${hm(t-pe)}`,detail:label(w),at:w.planned_end,link:{view:'op-os',os:w.id}});
   if(w.status==='em_andamento'&&w.actual_start&&Date.parse(w.actual_start)-ps>HOUR)alerts.push({id:'startdev:'+w.id,module:'operacao',severity:'info',title:`Começou ${hm(Date.parse(w.actual_start)-ps)} depois do previsto`,detail:label(w),at:w.actual_start,link:{view:'op-os',os:w.id}});
   if(w.status==='encerramento_pendente')alerts.push({id:'close:'+w.id,module:'operacao',severity:'atencao',title:'Encerramento pendente: falta checklist obrigatório',detail:label(w),at:w.planned_end,link:{view:'op-os',os:w.id}});
  }
  for(const b of blocks){const w=rows.find(x=>x.id===b.work_order_id);if(w)alerts.push({id:'block:'+w.id,module:'operacao',severity:'critico',title:`${b.n} bloqueio(s) aberto(s) há ${hm(t-Date.parse(b.since))}`,detail:label(w),at:b.since,link:{view:'op-os',os:w.id}});}
  out.sections.operacao={
   running:rows.filter(w=>w.status==='em_andamento').length,
   today:rows.filter(w=>w.status==='programada'&&localDay(w.planned_start)===today).length,
   late:rows.filter(w=>w.status==='programada'&&Date.parse(w.planned_start)<t).length,
   overdue:rows.filter(w=>w.status==='em_andamento'&&Date.parse(w.planned_end)<t).length,
   pending:rows.filter(w=>w.status==='encerramento_pendente').length,
   blocked:blocks.length,
   agenda:rows.filter(w=>w.status==='programada'&&Date.parse(w.planned_start)>=t-DAY&&Date.parse(w.planned_start)<t+7*DAY).slice(0,8).map(w=>({id:w.id,number:w.number,title:w.activity_name,org:w.acronym,start:w.planned_start,late:Date.parse(w.planned_start)<t})),
  };
 }

 // ── Planejamento ──
 if(planning){
  const drafts=await all(`SELECT p.id,p.updated_at,p.author_name,p.work_order_id,(SELECT count(*)::int FROM reservations r WHERE r.plan_id=p.id AND r.status='provisoria') reservations
   FROM plans p WHERE p.status='draft'${manager?'':' AND p.author_id=?'}`,...(manager?[]:[a.id]));
  const stale=drafts.filter(d=>d.reservations>0&&t-Date.parse(d.updated_at)>3*DAY);
  if(stale.length)alerts.push({id:'drafts:stale',module:'planejamento',severity:'info',title:`${stale.length} rascunho(s) parado(s) há mais de 3 dias segurando equipamentos`,detail:manager?'Libere as reservas dos esquecidos ou peça para lançar.':'Lance ou descarte para liberar os equipamentos.',at:null,link:{view:'plan-atividade'}});
  out.sections.planejamento={drafts:drafts.length,revisions:drafts.filter(d=>d.work_order_id).length,stale:stale.length};
 }

 // ── Manutenção ──
 if(maintView){
  const [rows,impediments,open]=await Promise.all([
   preventiveRows(),
   all(`SELECT i.id,i.equipment_id,i.kind,i.reason,i.opened_at,e.tag,(SELECT count(*)::int FROM reservations r WHERE r.equipment_id=i.equipment_id AND r.status<>'liberada' AND r.end_at::timestamptz > now()) commitments
    FROM equipment_impediments i JOIN equipment e ON e.id=i.equipment_id WHERE i.released_at IS NULL ORDER BY i.opened_at`),
   maint?all("SELECT r.id,r.started_at,r.stopped,r.failure,e.tag FROM maintenance_records r JOIN equipment e ON e.id=r.equipment_id WHERE r.kind='corretiva' AND r.status='em_andamento' ORDER BY r.started_at"):Promise.resolve([] as Row[]),
  ]);
  const panel='man-painel';
  for(const r of rows){
   const what=`${r.tag} · ${r.name}`;
   const amount=(n:number)=>r.method==='dias'?`${n} dia(s)`:`${n.toLocaleString('pt-BR')} ${r.unit}`;
   if(r.status==='atrasada')alerts.push({id:'prev:'+r.planId,module:'manutencao',severity:'critico',title:`Preventiva atrasada há ${amount(-(r.remaining??0))}`,detail:`${what} · marco ${r.firstOpenLabel}`,at:null,link:{view:panel}});
   else if(r.status==='pendente')alerts.push({id:'prev:'+r.planId,module:'manutencao',severity:'atencao',title:`Preventiva pendente (venceu há ${amount(-(r.remaining??0))})`,detail:`${what} · marco ${r.firstOpenLabel} · abrangência ${amount(r.tolerance)}`,at:null,link:{view:panel}});
   else if(r.status==='sem_leitura'||r.stale)alerts.push({id:'read:'+r.planId,module:'manutencao',severity:'info',title:r.status==='sem_leitura'?'Critério sem leitura registrada':'Leitura desatualizada (mais de 15 dias)',detail:what,at:r.readingAt,link:{view:has(a,'manutencao')||has(a,'operacao')?'man-leituras':panel}});
  }
  for(const i of impediments)alerts.push({id:'imp:'+i.id,module:'manutencao',severity:i.commitments?'critico':'atencao',title:`${i.tag} bloqueado${i.kind==='nc_critica'?' por NC crítica':i.kind==='manutencao'?' (em manutenção)':''}`,detail:`${i.reason}${i.commitments?` · ${i.commitments} reserva(s) afetada(s)`:''}`,at:i.opened_at,link:{view:maint?'man-corretivas':'op-painel'}});
  for(const r of open)alerts.push({id:'corr:'+r.id,module:'manutencao',severity:r.stopped?'atencao':'info',title:`Corretiva em aberto há ${hm(t-Date.parse(r.started_at))}`,detail:`${r.tag}${r.failure?` · ${r.failure}`:''}${r.stopped?' · equipamento parado':''}`,at:r.started_at,link:{view:'man-corretivas'}});
  const worst=new Map<string,string>();const rank:Record<string,number>={em_dia:0,sem_leitura:1,pendente:2,atrasada:3};
  for(const r of rows){const w=worst.get(r.equipmentId);if(!w||rank[r.status]>rank[w])worst.set(r.equipmentId,r.status);}
  const count=(s:string)=>[...worst.values()].filter(v=>v===s).length;
  const today=localDay(t);
  out.sections.manutencao={equipment:worst.size,emDia:count('em_dia'),pendentes:count('pendente'),atrasados:count('atrasada'),semLeitura:count('sem_leitura'),blocked:impediments.length,openCorrectives:maint?open.length:null,
   agenda:rows.filter(r=>r.status==='em_dia'&&r.projectedDate&&localDay(r.projectedDate+'T12:00:00Z')<=today+7).sort((x,y)=>String(x.projectedDate).localeCompare(String(y.projectedDate))).slice(0,8).map(r=>({planId:r.planId,tag:r.tag,name:r.name,date:r.projectedDate,label:r.firstOpenLabel,remaining:r.remaining,unit:r.unit}))};
 }
 // ── Financeiro ── Uso de equipamento recobrável aberto há uma diária inteira (provável esquecimento)
 // para quem executa e para o Financeiro; usos a conferir só para o Financeiro.
 const finance=manager||has(a,'financeiro');
 if(finance||has(a,'operacao')){
  const sw=scope?' AND w.org_id = ANY(?::text[])':'';
  const [open,rates]=await Promise.all([
   all(`SELECT u.id,u.work_order_id,u.started_at,u.equipment_id,u.org_id,e.tag,w.number FROM equipment_uses u JOIN equipment e ON e.id=u.equipment_id JOIN work_orders w ON w.id=u.work_order_id WHERE u.ended_at IS NULL${sw}`,...(scope?[scope]:[])),
   all('SELECT * FROM recovery_rates'),
  ]);
  const list=rates.map(toRate);
  for(const u of open){
   const age=t-Date.parse(u.started_at),limit=(rateAt(list,u.equipment_id,u.org_id,Date.parse(u.started_at))?.hoursPerDay||8)*HOUR;
   // Quem não abre OS (só o acesso Financeiro) corrige pelo Painel de recobráveis.
   if(age>=limit)alerts.push({id:'use:'+u.id,module:'financeiro',severity:'atencao',title:`${u.tag} em uso há ${hm(age)} sem fim registrado`,at:u.started_at,
    ...(canSeeOrders(a)?{detail:`${osNumber(u.number)} · registre o fim do uso na OS`,link:{view:'op-os',os:u.work_order_id}}:{detail:`${osNumber(u.number)} · corrija no Painel de recobráveis`,link:{view:'fin-painel'}})});
  }
 }
 if(finance){
  const review=(await all(`SELECT count(*)::int n FROM equipment_uses WHERE review='a_conferir'${scope?' AND org_id = ANY(?::text[])':''}`,...(scope?[scope]:[])))[0]?.n||0;
  if(review)alerts.push({id:'uses:review',module:'financeiro',severity:'info',title:`${review} uso(s) de equipamento a conferir`,detail:'Confira ou corrija no Painel de recobráveis.',at:null,link:{view:'fin-painel'}});
 }

 alerts.sort((x,y)=>RANK[x.severity]-RANK[y.severity]||String(x.at||'').localeCompare(String(y.at||'')));
 out.alerts=alerts.slice(0,300);
 out.counts={critico:alerts.filter(x=>x.severity==='critico').length,atencao:alerts.filter(x=>x.severity==='atencao').length,info:alerts.filter(x=>x.severity==='info').length,total:alerts.length};
 out.today=dateOf(localDay(t));
 return out;
}
