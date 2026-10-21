// Motor de ciclos da manutenção preventiva (sem acesso ao banco: testável isoladamente).
// Um critério define o marco zero (data ou leitura), o intervalo e a abrangência (tolerância).
// Ciclo fixo: marcos em zero + k × intervalo. Ciclo pela execução: cada marco conta a partir da
// conclusão da manutenção anterior (data de término ou leitura registrada).
// Situação: em dia (antes do marco), pendente (passou do marco, dentro da abrangência) e
// atrasada (passou do marco + abrangência). Sem leitura: plano por horímetro/odômetro sem dado.

export type Method='dias'|'horimetro'|'odometro';
export type CycleStatus='em_dia'|'pendente'|'atrasada'|'sem_leitura';
export type MarkState='feita'|'perdida'|'em_andamento'|'vencida'|'proxima'|'futura';
export type CyclePlan={method:Method,interval:number,tolerance:number,anchorDate?:string|null,anchorReading?:number|null,cycleMode:'fixo'|'execucao'};
export type CycleRecord={id:string,cycle:number,status:'em_andamento'|'concluida',endedAt:string|null,reading:number|null};
export type Mark={cycle:number,due:number,label:string,state:MarkState,recordId:string|null};
export type CycleResult={
 status:CycleStatus,
 /** Valor atual: dia (número do dia local) ou leitura. */
 current:number|null,
 /** Marco que a próxima manutenção atende (o mais recente vencido, ou o próximo). */
 target:number,
 /** Primeiro marco em aberto (define a situação). */
 firstOpen:number,
 firstOpenDue:number,
 /** Quanto falta até o primeiro marco em aberto (negativo: vencido há). */
 remaining:number|null,
 /** Data prevista do marco (leituras: pelo ritmo de uso recente). */
 projectedDay:number|null,
 /** Início e fim do trecho atual da régua (marco anterior → marco em aberto). */
 segment:{from:number,to:number},
 marks:Mark[],
 openRecordId:string|null,
};

const DAY=86400000;
/** Dia local de São Paulo (UTC−3, sem horário de verão) como número de dias. */
export const localDay=(iso:string|number|Date)=>Math.floor((new Date(iso).valueOf()-3*3600000)/DAY);
export const dayOf=(date:string)=>{const [y,m,d]=date.split('-').map(Number);return Math.floor(Date.UTC(y,m-1,d)/DAY);};
export const dateOf=(day:number)=>new Date(day*DAY).toISOString().slice(0,10);
export const unitOf=(m:Method)=>m==='dias'?'dias':m==='horimetro'?'h':'km';
const round1=(n:number)=>Math.round(n*10)/10;

/** Rótulo do marco: data (dias) ou leitura (horímetro/odômetro). */
export function markLabel(method:Method,due:number){
 if(method==='dias'){const [y,m,d]=dateOf(due).split('-');return `${d}/${m}/${y}`;}
 return `${round1(due).toLocaleString('pt-BR')} ${unitOf(method)}`;
}

/** Ritmo de uso (unidades por dia) pelas leituras dos últimos 30 dias; null sem dado suficiente. */
export function usageRate(readings:{value:number,readAt:string}[],now=Date.now()){
 const recent=readings.filter(r=>Date.parse(r.readAt)>=now-30*DAY).sort((a,b)=>Date.parse(a.readAt)-Date.parse(b.readAt));
 if(recent.length<2)return null;
 const a=recent[0],b=recent[recent.length-1];
 const days=(Date.parse(b.readAt)-Date.parse(a.readAt))/DAY;
 if(days<1||b.value<=a.value)return null;
 return (b.value-a.value)/days;
}

export function computeCycle(plan:CyclePlan,records:CycleRecord[],input:{current:number|null,today:number,rate?:number|null,window?:number}):CycleResult{
 const {method,interval,tolerance,cycleMode}=plan;
 const anchor=method==='dias'?dayOf(plan.anchorDate!):Number(plan.anchorReading);
 const current=method==='dias'?input.today:input.current;
 const done=records.filter(r=>r.status==='concluida').sort((a,b)=>a.cycle-b.cycle);
 const open=records.find(r=>r.status==='em_andamento')||null;
 const lastDone=done.length?done[done.length-1].cycle:0;
 // Valor em que a manutenção foi feita (base do próximo marco no ciclo pela execução).
 const doneValue=(r:CycleRecord,fallback:number)=>method==='dias'?(r.endedAt?localDay(r.endedAt):fallback):(r.reading??fallback);
 const marks:Mark[]=[];
 let due:(k:number)=>number;
 if(cycleMode==='fixo'){
  due=k=>anchor+k*interval;
 }else{
  // Cadeia: cada marco = execução anterior + intervalo; depois do último feito, projeção.
  const chain=new Map<number,number>();let base=anchor;
  for(let k=1;k<=lastDone;k++){chain.set(k,base+interval);const r=done.find(x=>x.cycle===k);base=r?doneValue(r,base+interval):base+interval;}
  const next=base;
  due=k=>chain.get(k)??next+(k-lastDone)*interval;
 }
 const firstOpen=lastDone+1,firstOpenDue=due(firstOpen);
 let status:CycleStatus,target=firstOpen;
 if(current==null)status='sem_leitura';
 else if(current<firstOpenDue)status='em_dia';
 else{
  status=current>firstOpenDue+tolerance?'atrasada':'pendente';
  // Ciclo fixo: a manutenção feita agora atende o marco vencido mais recente (os anteriores ficam perdidos).
  if(cycleMode==='fixo')target=Math.max(firstOpen,Math.floor((current-anchor)/interval+1e-9));
 }
 if(open&&open.cycle>target)target=open.cycle;
 // Próximo marco ainda não vencido (o que a caixa "quanto falta" acompanha depois de regularizar).
 let nextDue=firstOpen;if(current!=null)while(due(nextDue)<=current&&nextDue<firstOpen+100000)nextDue++;
 // Marcos exibidos: até 2 anteriores ao primeiro em aberto, os vencidos e os 2 seguintes.
 const win=input.window??2;
 const last=Math.max(target,firstOpen,Math.min(nextDue,target+1))+win;
 for(let k=Math.max(1,firstOpen-win);k<=last;k++){
  const rec=records.find(r=>r.cycle===k)||null;
  const d=due(k);
  let state:MarkState;
  if(rec?.status==='concluida')state='feita';
  else if(rec?.status==='em_andamento')state='em_andamento';
  else if(k<lastDone)state='perdida';
  else if(current!=null&&current>=d)state='vencida';
  else state=k===nextDue?'proxima':'futura';
  marks.push({cycle:k,due:d,label:markLabel(method,d),state,recordId:rec?.id||null});
 }
 const remaining=current==null?null:round1(firstOpenDue-current);
 let projectedDay:number|null=null;
 if(method==='dias')projectedDay=firstOpenDue;
 else if(current!=null&&input.rate&&input.rate>0)projectedDay=input.today+Math.ceil(Math.max(0,firstOpenDue-current)/input.rate);
 const prev=firstOpen>1?due(firstOpen-1):anchor;
 return {status,current,target,firstOpen,firstOpenDue,remaining,projectedDay,segment:{from:Math.min(prev,firstOpenDue),to:firstOpenDue},marks,openRecordId:open?.id||null};
}

/** Próximos marcos a partir do marco zero (prévia no cadastro do critério). */
export function previewMarks(plan:CyclePlan,count=3){
 const anchor=plan.method==='dias'?dayOf(plan.anchorDate!):Number(plan.anchorReading);
 return Array.from({length:count},(_,i)=>markLabel(plan.method,anchor+(i+1)*plan.interval));
}
