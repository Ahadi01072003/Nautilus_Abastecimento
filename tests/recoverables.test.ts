// Motor de diárias dos recobráveis por equipamento: janela de horas corridas por equipamento e
// cliente, sem banco. Valores fictícios (R$ 500/h, 8 h por diária).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dailies,rateAt,minutesOutside,billingMonth,type Rate,type Interval} from '../lib/recoverables';

const H=3600_000;
/** 04/05/2026 00:00 em Brasília: h(8) é 08:00 do mesmo dia. */
const BASE=Date.parse('2026-05-04T03:00:00Z');
const h=(n:number)=>BASE+n*H;
const R:Rate={equipmentId:'pta',orgId:'cli',hourlyCents:50000,hoursPerDay:8,validFrom:'2026-01-01',active:true};
let seq=0;
const use=(order:string,a:number,b:number|null,extra:Partial<Interval>={}):Interval=>({id:'u'+(++seq),orderId:order,orderNumber:order.charCodeAt(0),equipmentId:'pta',orgId:'cli',start:h(a),end:b==null?null:h(b),pending:false,...extra});
const count=(xs:Interval[],rates=[R],now=h(100))=>dailies(xs,rates,now).length;

test('diária: usos dentro da janela de 8 h contam uma vez',()=>{
 const one=dailies([use('A',8,12)],[R],h(100));
 assert.equal(one.length,1);assert.equal(one[0].valueCents,400000);
 assert.deepEqual([one[0].start,one[0].end],[h(8),h(16)]);
 assert.equal(count([use('A',8,12),use('A',14,15.5)]),1);
});

test('diária: uso que passa do fim abre a seguinte no fim da anterior; novo uso depois da janela abre outra',()=>{
 assert.deepEqual(dailies([use('A',8,24)],[R],h(100)).map(d=>d.start),[h(8),h(16)]);
 assert.equal(count([use('A',8,24.5)]),3);
 const gap=dailies([use('A',8,12),use('A',17,18)],[R],h(100));
 assert.deepEqual(gap.map(d=>d.start),[h(8),h(17)]);
});

test('diária: limite exato e meia-noite',()=>{
 assert.equal(count([use('A',8,16)]),1,'termina exatamente no fim da janela');
 assert.equal(count([use('A',8,10),use('A',16,17)]),2,'começa exatamente no fim da janela');
 // 2ª diária aberta às 17:00 vai até 01:00: o uso às 00:30 cabe nela.
 assert.equal(count([use('A',8,10),use('A',17,18),use('A',24.5,24.75)]),2);
});

test('diária: várias OS do mesmo cliente dividem a janela; a diária pertence à OS que abriu',()=>{
 const d=dailies([use('A',8,10),use('B',11,12),use('C',14,15),use('B',17,18)],[R],h(100));
 assert.equal(d.length,2);
 assert.equal(d[0].openerOrderId,'A');assert.deepEqual(d[0].orderIds,['A','B','C']);
 assert.equal(d[1].openerOrderId,'B');assert.deepEqual(d[1].orderIds,['B']);
});

test('diária: A 08–20 e B 20–21 → 2 diárias, ambas abertas por A',()=>{
 const d=dailies([use('A',8,20),use('B',20,21)],[R],h(100));
 assert.deepEqual(d.map(x=>[x.openerOrderId,x.start]),[['A',h(8)],['A',h(16)]]);
 assert.deepEqual(d[1].orderIds,['A','B']);
});

test('diária: uso em aberto conta até agora e marca pendente',()=>{
 const d=dailies([use('A',8,null)],[R],h(26));
 assert.equal(d.length,3);
 assert.ok(d.every(x=>x.pending));
 // Uso encerrado e não marcado fica conferido; marcado a conferir contamina a diária.
 assert.equal(dailies([use('A',8,12)],[R],h(100))[0].pending,false);
 assert.equal(dailies([use('A',8,12),use('B',13,14,{pending:true})],[R],h(100))[0].pending,true);
});

test('diária: cliente ou equipamento sem tarifa não gera diária',()=>{
 assert.equal(count([use('A',8,12,{orgId:'outro'})]),0);
 assert.equal(count([use('A',8,12,{equipmentId:'guindaste'})]),0);
 assert.equal(count([use('A',8,12)],[{...R,active:false}]),0,'tarifa inativa');
 assert.equal(rateAt([R],'pta','cli',Date.parse('2025-12-31T12:00:00Z')),null,'antes da vigência');
});

test('diária: troca de tarifa vale a partir do início de cada diária',()=>{
 const next:Rate={...R,validFrom:'2026-05-05',hourlyCents:60000,hoursPerDay:10};
 const d=dailies([use('A',8,10),use('A',32,33)],[R,next],h(100));
 assert.deepEqual(d.map(x=>x.valueCents),[400000,600000]);
 assert.equal(d[1].end-d[1].start,10*H);
 assert.equal(rateAt([R,next],'pta','cli',h(32))!.hourlyCents,60000);
});

test('minutesOutside: soma o que fica fora das janelas',()=>{
 assert.equal(minutesOutside([h(8),h(12)],[[h(9),h(11)]]),120);
 assert.equal(minutesOutside([h(8),h(12)],[[h(7),h(13)]]),0);
 assert.equal(minutesOutside([h(8),h(12)],[[h(8),h(9)],[h(8.5),h(10)]]),120,'janelas sobrepostas contam uma vez');
 assert.equal(minutesOutside([h(8),h(12)],[]),240);
});

test('billingMonth: usa o horário de Brasília',()=>{
 assert.equal(billingMonth(Date.parse('2026-11-01T02:00:00Z')),'2026-10');
 assert.equal(billingMonth(Date.parse('2026-11-01T03:00:00Z')),'2026-11');
});
