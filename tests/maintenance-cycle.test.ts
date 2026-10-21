import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeCycle,dayOf,dateOf,usageRate,previewMarks,localDay,type CyclePlan} from '../lib/maintenance-cycle';

const anchor='2030-01-01',A=dayOf(anchor);
const days:CyclePlan={method:'dias',interval:30,tolerance:5,anchorDate:anchor,cycleMode:'fixo'};
const states=(r:ReturnType<typeof computeCycle>)=>r.marks.map(m=>`${m.cycle}:${m.state}`).join(' ');

test('ciclo fixo em dias: em dia, pendente, atrasada e marco que a manutenção atende',()=>{
 let r=computeCycle(days,[],{current:null,today:A+20});
 assert.equal(r.status,'em_dia');assert.equal(r.remaining,10);assert.equal(r.target,1);assert.equal(dateOf(r.projectedDay!),'2030-01-31');
 r=computeCycle(days,[],{current:null,today:A+30});assert.equal(r.status,'pendente','no dia do marco já está pendente');assert.equal(r.remaining,0);
 r=computeCycle(days,[],{current:null,today:A+35});assert.equal(r.status,'pendente','dentro da abrangência');
 r=computeCycle(days,[],{current:null,today:A+36});assert.equal(r.status,'atrasada');assert.equal(r.remaining,-6);
 // Dois marcos vencidos: a manutenção de agora atende o mais recente; o vermelho conta do primeiro em aberto.
 r=computeCycle(days,[],{current:null,today:A+65});
 assert.equal(r.status,'atrasada');assert.equal(r.target,2);assert.equal(r.firstOpen,1);
 assert.match(states(r),/1:vencida 2:vencida 3:proxima/);
 r=computeCycle(days,[{id:'x',cycle:2,status:'concluida',endedAt:'2030-03-07T15:00:00Z',reading:null}],{current:null,today:A+66});
 assert.equal(r.status,'em_dia');assert.equal(r.firstOpen,3);assert.equal(r.remaining,24);
 assert.match(states(r),/1:perdida 2:feita 3:proxima/);
 // Feita antes do vencimento: o ciclo fixo não se desloca.
 r=computeCycle(days,[{id:'y',cycle:1,status:'concluida',endedAt:'2030-01-20T15:00:00Z',reading:null}],{current:null,today:A+25});
 assert.equal(r.firstOpenDue,A+60);
});

test('ciclo pela execução: o próximo marco conta a partir do término da anterior',()=>{
 const plan:CyclePlan={...days,cycleMode:'execucao'};
 const rec=[{id:'a',cycle:1,status:'concluida' as const,endedAt:'2030-02-10T15:00:00Z',reading:null}];
 const r=computeCycle(plan,rec,{current:null,today:A+45});
 assert.equal(r.firstOpenDue,dayOf('2030-02-10')+30);assert.equal(r.status,'em_dia');
 assert.equal(r.marks.find(m=>m.cycle===1)!.due,A+30,'o marco feito mantém o vencimento original');
});

test('horímetro: leitura atual, previsão pelo ritmo de uso, sem leitura e manutenção em andamento',()=>{
 const plan:CyclePlan={method:'horimetro',interval:250,tolerance:25,anchorReading:1000,cycleMode:'fixo'};
 let r=computeCycle(plan,[],{current:1240,today:A,rate:5});
 assert.equal(r.status,'em_dia');assert.equal(r.remaining,10);assert.equal(r.projectedDay,A+2);
 assert.equal(r.marks[0].label,'1.250 h');
 r=computeCycle(plan,[],{current:1260,today:A,rate:5});assert.equal(r.status,'pendente');
 r=computeCycle(plan,[],{current:1276,today:A});assert.equal(r.status,'atrasada');
 r=computeCycle(plan,[],{current:null,today:A});assert.equal(r.status,'sem_leitura');assert.equal(r.remaining,null);
 r=computeCycle(plan,[{id:'o',cycle:1,status:'em_andamento',endedAt:null,reading:null}],{current:1255,today:A});
 assert.equal(r.openRecordId,'o');assert.equal(r.target,1);assert.equal(r.status,'pendente','em andamento não esconde a situação');
 // Pela execução: próximo marco = leitura registrada no fim + intervalo.
 r=computeCycle({...plan,cycleMode:'execucao'},[{id:'d',cycle:1,status:'concluida',endedAt:'2030-01-02T10:00:00Z',reading:1262}],{current:1300,today:A});
 assert.equal(r.firstOpenDue,1512);
});

test('utilitários: ritmo de uso, prévia de marcos e dia local',()=>{
 const now=Date.parse('2030-05-31T12:00:00Z');
 assert.equal(usageRate([{value:100,readAt:'2030-05-01T12:00:00Z'},{value:250,readAt:'2030-05-31T12:00:00Z'}],now),5);
 assert.equal(usageRate([{value:100,readAt:'2030-05-31T10:00:00Z'}],now),null);
 assert.deepEqual(previewMarks(days),['31/01/2030','02/03/2030','01/04/2030']);
 assert.equal(dateOf(localDay('2030-01-02T02:00:00Z')),'2030-01-01','23h de Brasília ainda é o dia anterior');
});
