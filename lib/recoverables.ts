// Financeiro · recobráveis por equipamento: motor de diárias, sem banco nem tela. A MESMA regra
// para a OS, o painel e a exportação (as diárias nunca são gravadas, para não ficarem desatualizadas).
// Regra: a diária é por equipamento e cliente. O primeiro uso abre uma janela de P horas corridas
// (P = horas por diária da tarifa); todo uso daquele equipamento, em qualquer OS do mesmo cliente,
// que caia dentro dela entra na mesma diária. Uso que passa do fim abre a seguinte exatamente no fim
// da anterior (aberta pela OS desse uso); uso que começa no fim ou depois abre outra no seu início.
// A janela não reinicia à meia-noite. Valor = valor por hora × P da tarifa vigente no início da diária.

export type Rate={equipmentId:string,orgId:string,hourlyCents:number,hoursPerDay:number,validFrom:string,active:boolean};
/** Uso (ou período reservado) em milissegundos; `end=null` = em uso. */
export type Interval={id:string,orderId:string,orderNumber:number,equipmentId:string,orgId:string,start:number,end:number|null,pending:boolean};
export type Daily={equipmentId:string,orgId:string,start:number,end:number,openerOrderId:string,openerNumber:number,
 orderIds:string[],intervalIds:string[],hoursPerDay:number,hourlyCents:number,valueCents:number,pending:boolean};

const H=3600_000;
const localDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'});

/** Tarifa vigente no dia (Brasília) do instante: a de maior "vigente a partir de" até esse dia.
 * Vigência inativa = parou de cobrar a partir daquela data. */
export function rateAt(rates:Rate[],equipmentId:string,orgId:string,at:number):Rate|null{
 const day=localDay.format(at);
 let best:Rate|null=null;
 for(const r of rates)if(r.equipmentId===equipmentId&&r.orgId===orgId&&r.validFrom<=day&&(!best||r.validFrom>best.validFrom))best=r;
 return best?.active?best:null;
}

/** Diárias de todos os usos, por equipamento e cliente, ordenadas pelo início. */
export function dailies(intervals:Interval[],rates:Rate[],now:number):Daily[]{
 const groups=new Map<string,Interval[]>();
 for(const i of intervals){const k=i.equipmentId+'|'+i.orgId;groups.set(k,[...(groups.get(k)||[]),i]);}
 const out:Daily[]=[];
 for(const list of groups.values()){
  list.sort((x,y)=>x.start-y.start||(x.end??Infinity)-(y.end??Infinity));
  let cur:Daily|null=null;
  const open=(at:number,i:Interval):Daily|null=>{
   const r=rateAt(rates,i.equipmentId,i.orgId,at);if(!r)return null;
   const d:Daily={equipmentId:i.equipmentId,orgId:i.orgId,start:at,end:at+r.hoursPerDay*H,openerOrderId:i.orderId,openerNumber:i.orderNumber,
    orderIds:[],intervalIds:[],hoursPerDay:r.hoursPerDay,hourlyCents:r.hourlyCents,valueCents:r.hourlyCents*r.hoursPerDay,pending:false};
   out.push(d);return d;
  };
  const touch=(d:Daily,i:Interval)=>{
   if(!d.orderIds.includes(i.orderId))d.orderIds.push(i.orderId);
   if(!d.intervalIds.includes(i.id))d.intervalIds.push(i.id);
   if(i.pending||i.end==null)d.pending=true;
  };
  for(const i of list){
   const e=i.end??Math.max(now,i.start);
   if(!cur||i.start>=cur.end){cur=open(i.start,i);if(!cur)continue;}
   touch(cur,i);
   while(e>cur.end){const next:Daily|null=open(cur.end,i);if(!next)break;cur=next;touch(cur,i);}
  }
 }
 return out.sort((x,y)=>x.start-y.start);
}

/** Minutos do uso fora da união das janelas (períodos reservados). */
export function minutesOutside(use:[number,number],windows:[number,number][]):number{
 const [a,b]=use;let covered=0,reach=a;
 for(const [s,e] of [...windows].sort((x,y)=>x[0]-y[0])){
  const from=Math.max(s,reach),to=Math.min(e,b);
  if(to>from){covered+=to-from;reach=to;}
 }
 return Math.max(0,b-a-covered)/60000;
}

/** Mês de faturamento (Brasília) do instante: AAAA-MM. */
export function billingMonth(at:number){return localDay.format(at).slice(0,7);}
