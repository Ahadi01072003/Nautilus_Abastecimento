// Painel central › Apresentação (TV): visão ao vivo de todas as OS do período, com cronograma,
// o que está em execução agora, as próximas e os recursos (equipamentos, equipe e materiais).
// Reaproveita a agenda (recursos por OS), o Painel de OS (etapas e períodos das OS em andamento) e
// os indicadores do turno; tudo respeita o acesso e o escopo de organizações de quem consulta.
import {type Row} from './db';
import {AppError} from './domain';
import {type Member} from './permissions';
import {agendaData} from './agenda';
import {opsBoard,opsDashboard} from './board';

const DAY=86400_000,H=3600_000;
export const TV_DAYS=[1,3,7,14];
const dayISO=(t:number)=>new Date(t-3*H).toISOString().slice(0,10);

export async function tvData(member:Member,url:URL){
 const days=Number(url.searchParams.get('dias')||7);
 if(!TV_DAYS.includes(days))throw new AppError('Período inválido.');
 const today=Date.parse(dayISO(Date.now())+'T00:00:00-03:00');
 // OS em andamento (com etapas e períodos) e indicadores do turno.
 const [board,dash]=await Promise.all([opsBoard(member,new URL('http://x/?group=andamento')),opsDashboard(member)]);
 // A janela começa no dia anterior (o que acabou de acontecer) e, se houver OS em andamento que
 // começou antes, recua até ela (no máximo 30 dias) para que os recursos dela também apareçam.
 const oldest=Math.min(today-DAY,...(board.orders as Row[]).map(o=>Date.parse(o.planned_start)));
 const from=Math.max(oldest,today-30*DAY);
 const agenda=await agendaData(member,{from:dayISO(from+3*H),to:dayISO(today+(days-1)*DAY+3*H)});
 const running=new Map((board.orders as Row[]).map(o=>[o.id,o]));
 const orders=(agenda.orders as Row[]).map(o=>{const r=running.get(o.id);
  return {id:o.id,number:o.number,status:o.status,origin:o.origin,planned_start:o.planned_start,planned_end:o.planned_end,actual_start:o.actual_start,actual_end:o.actual_end,
   sector:o.sector_code||null,title:o.activity_name,org:{acronym:o.org_acronym,name:o.org_name,color:o.org_color},location:o.location_name,
   equipment:o.equipment,people:o.people,functions:o.functions,materials:o.materials,
   steps:r?.steps||null,intervals:r?.intervals||null,occurrences:r?(r.occurrences as Row[]).filter(x=>x.blocking&&x.status==='aberto'):null};});
 return {
  window:{from:new Date(today-DAY).toISOString(),to:new Date(today+days*DAY).toISOString(),days,today:new Date(today).toISOString()},
  orders,kpis:dash.kpis,summary:{total:agenda.summary.total,hours:agenda.summary.hours,people:agenda.summary.people,alerts:agenda.summary.alerts},
  serverNow:new Date().toISOString(),
 };
}
