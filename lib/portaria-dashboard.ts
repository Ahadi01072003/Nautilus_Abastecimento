// Portaria · indicadores calculados sempre dos registros válidos (sem contador gravado).
// Entradas: visitas não anuladas por data local de entrada. Saídas: visitas finalizadas por data local de saída.
// Pessoas únicas: DISTINCT sobre o período todo (nunca soma de dias). Anuladas ficam fora de tudo.
import {db,type Row} from './db';
import {type Member} from './permissions';
import {fail,invalid,portaria,baseOf,iso,localDate} from './portaria-core';

const GRANULARITIES=['day','month','year'];
const MAX_DAYS=3660;
const dayOf=(value:unknown,field:string)=>{
 const s=String(value||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw invalid('Data inválida.',field);
 return s;
};
const addDays=(date:string,n:number)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);

export async function portariaDashboard(member:Member,url:URL){
 await portaria(member);
 const base=await baseOf(db()),tz=base.timezone,today=localDate(new Date(),tz);
 const granularity=url.searchParams.get('granularity')||'day';
 if(!GRANULARITIES.includes(granularity))throw invalid('Escolha dia, mês ou ano.','granularity');
 const to=url.searchParams.get('to')?dayOf(url.searchParams.get('to'),'to'):today;
 const from=url.searchParams.get('from')?dayOf(url.searchParams.get('from'),'from'):addDays(to,-29);
 if(from>to)throw invalid('A data inicial não pode ser depois da final.','from');
 if((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000>MAX_DAYS)throw invalid('Período máximo de 10 anos.','from');
 const company=url.searchParams.get('company')||'';
 if(company){
  const c=await db().first('SELECT id FROM portaria_companies WHERE id=?',company);
  if(!c)throw fail(404,'COMPANY_NOT_FOUND','Empresa não encontrada.','company');
 }
 const atRaw=url.searchParams.get('at');
 let at:Date|null=null;
 if(atRaw){at=new Date(atRaw);if(Number.isNaN(at.getTime()))throw invalid('Instante inválido.','at');}

 // Limites do período como instantes: 00:00 local de "from" até 00:00 local do dia seguinte a "to".
 const bounds=`(?::date::timestamp AT TIME ZONE ?::text)`;
 const lo=[from,tz],hi=[addDays(to,1),tz];
 const co=company?' AND v.company_id=?':'';
 const cp=company?[company]:[];
 const bucket=(col:string)=>`date_trunc('${granularity}',(${col} AT TIME ZONE ?::text))::date::text`;

 const [entriesTotal,exitsTotal,entrySeries,exitSeries,byCompany,present]=await Promise.all([
  db().first(`SELECT count(*)::int entries,count(DISTINCT v.person_id)::int people FROM portaria_visits v
   WHERE v.base_id=? AND v.status<>'anulada' AND v.entry_at>=${bounds} AND v.entry_at<${bounds}${co}`,base.id,...lo,...hi,...cp),
  db().first(`SELECT count(*)::int exits,count(DISTINCT v.person_id)::int people FROM portaria_visits v
   WHERE v.base_id=? AND v.status='finalizada' AND v.exit_at>=${bounds} AND v.exit_at<${bounds}${co}`,base.id,...lo,...hi,...cp),
  db().all(`SELECT ${bucket('v.entry_at')} bucket,count(*)::int entries,count(DISTINCT v.person_id)::int people FROM portaria_visits v
   WHERE v.base_id=? AND v.status<>'anulada' AND v.entry_at>=${bounds} AND v.entry_at<${bounds}${co} GROUP BY 1`,tz,base.id,...lo,...hi,...cp),
  db().all(`SELECT ${bucket('v.exit_at')} bucket,count(*)::int exits FROM portaria_visits v
   WHERE v.base_id=? AND v.status='finalizada' AND v.exit_at>=${bounds} AND v.exit_at<${bounds}${co} GROUP BY 1`,tz,base.id,...lo,...hi,...cp),
  db().all(`SELECT v.company_id,coalesce(nullif(v.company_name,''),'Sem empresa') name,count(*)::int entries,count(DISTINCT v.person_id)::int people FROM portaria_visits v
   WHERE v.base_id=? AND v.status<>'anulada' AND v.entry_at>=${bounds} AND v.entry_at<${bounds}${co}
   GROUP BY v.company_id,2 ORDER BY entries DESC,name LIMIT 50`,base.id,...lo,...hi,...cp),
  db().first(`SELECT count(*)::int n FROM portaria_visits v WHERE v.base_id=? AND v.status='em_andamento'${co}`,base.id,...cp),
 ]);

 // Presença em um instante (histórico): entrou até t e ainda não tinha saído em t. Inclui visitas anteriores ao período.
 let presentAt:{at:string,count:number}|null=null;
 if(at){
  const r=await db().first(`SELECT count(*)::int n FROM portaria_visits v WHERE v.base_id=? AND v.status<>'anulada'
   AND v.entry_at<=?::timestamptz AND (v.exit_at IS NULL OR v.exit_at>?::timestamptz)${co}`,base.id,at.toISOString(),at.toISOString(),...cp);
  presentAt={at:at.toISOString(),count:Number(r?.n||0)};
 }

 const merged=new Map<string,{bucket:string,entries:number,exits:number,people:number}>();
 const slot=(b:string)=>{let s=merged.get(b);if(!s){s={bucket:b,entries:0,exits:0,people:0};merged.set(b,s);}return s;};
 for(const r of entrySeries as Row[]){const s=slot(r.bucket);s.entries=Number(r.entries);s.people=Number(r.people);}
 for(const r of exitSeries as Row[]){slot(r.bucket).exits=Number(r.exits);}
 const series=[...merged.values()].sort((a,b)=>a.bucket<b.bucket?-1:1);

 return {
  period:{from,to},granularity,timezone:tz,base:{id:base.id,name:base.name},company:company||null,
  totals:{entries:Number(entriesTotal?.entries||0),exits:Number(exitsTotal?.exits||0),uniquePeople:Number(entriesTotal?.people||0),presentNow:Number(present?.n||0)},
  presentAt,series,
  byCompany:(byCompany as Row[]).map(r=>({companyId:r.company_id||null,name:r.name,entries:Number(r.entries),uniquePeople:Number(r.people)})),
  notes:{uniquePeople:'Pessoas únicas contam cada pessoa uma vez no período todo. Por empresa, a mesma pessoa pode aparecer em mais de uma, então a soma pode passar do total.',
   source:'Calculado dos registros válidos; visitas anuladas ficam de fora.'},
  generatedAt:iso(new Date()),
 };
}
