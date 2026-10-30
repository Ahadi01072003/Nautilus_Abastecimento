import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packLanes,labelSide,resourceRows,resourceOptions,resourceParams,resourceFromParams,ALL_KINDS,type Alloc} from '../lib/resource-agenda';

const H=3600_000,T0=Date.UTC(2033,4,20,11);
const at=(h:number)=>new Date(T0+h*H).toISOString();
const alloc=(p:Partial<Alloc>&{n:number,s:number,e:number}):Alloc=>({kind:'equipamento',key:'eq1',label:'ED-16-02',sub:'Empilhadeira',step:'Execução',quantity:1,unit:null,
 orderId:'o'+p.n,number:p.n,activity:'Movimentação',status:'programada',orgId:'org',sector:null,...p,start:at(p.s),end:at(p.e)});

test('agenda de recursos: alocações curtas e próximas não se sobrepõem no desenho (faixas pela barra + etiqueta)',()=>{
 // Três usos de 30 min com 15 min entre eles: no tempo não se sobrepõem, mas a etiqueta ao lado (140 px a 24 px/h ≈ 5,8 h) sim.
 const rows=resourceRows([alloc({n:1,s:0,e:.5}),alloc({n:2,s:.75,e:1.25}),alloc({n:3,s:1.5,e:2}),alloc({n:4,s:10,e:11})],ALL_KINDS);
 const x=(t:number)=>(t-T0)/H*24;
 assert.equal(packLanes(rows[0].items,x,140,8),3);
 assert.deepEqual(rows[0].items.map(i=>i.lane),[0,1,2,0],'a 4ª, 10 h depois, volta para a 1ª faixa');
 // Sem etiqueta (só o horário), cabiam numa faixa só.
 assert.equal(packLanes(rows[0].items,x,0,0),1);
 // Nenhuma barra desenhada encosta em outra da mesma faixa.
 packLanes(rows[0].items,x,140,8);
 const byLane=new Map<number,number[]>();for(const i of rows[0].items){const l=byLane.get(i.lane)||[];l.push(x(i.a));byLane.set(i.lane,l);}
 for(const ls of byLane.values())for(let k=1;k<ls.length;k++)assert.ok(ls[k]-ls[k-1]>=148);
});

test('agenda de recursos: barra no período exato em qualquer zoom; texto dentro quando cabe, ao lado quando não',()=>{
 // 24 px/h: 30 min = 12 px (texto de 140 px não cabe) e 8 h = 192 px (cabe).
 const rows=resourceRows([alloc({n:1,s:0,e:.5}),alloc({n:2,s:12,e:20}),alloc({n:3,s:40,e:41})],ALL_KINDS);
 const x=(t:number)=>(t-T0)/H*24;
 packLanes(rows[0].items,x,140,8,1000);
 assert.deepEqual(rows[0].items.map(i=>i.side),['right','in','left'],'a última fica perto da borda (960 px de 1000): etiqueta à esquerda');
 assert.deepEqual(rows[0].items.map(i=>i.lane),[0,0,0]);
 // A posição da barra não depende da etiqueta: começa e termina no horário exato.
 assert.equal(labelSide(0,12,140,8),'right');assert.equal(labelSide(0,192,140,8),'in');
 // Barra que começa antes do período visível: conta só o trecho à vista para decidir se o texto cabe.
 assert.equal(labelSide(-300,100,140,8,1000,0),'right');
 assert.equal(labelSide(-300,200,140,8,1000,0),'in');
});

test('agenda de recursos: tipos separados ou juntos, recursos específicos e seleção na URL',()=>{
 const all=[alloc({n:1,s:0,e:2}),alloc({n:2,s:3,e:4,key:'eq2',label:'PTA-001'}),
  alloc({n:1,s:0,e:2,kind:'funcao',key:'f1',label:'Sinaleiro',quantity:2,unit:'pessoa(s)'}),
  alloc({n:2,s:3,e:4,kind:'material',key:'m1|un',label:'Cinta',quantity:4,unit:'un'})];
 assert.deepEqual(resourceRows(all,ALL_KINDS).map(r=>r.label),['ED-16-02','PTA-001','Sinaleiro','Cinta'],'equipamentos → funções → materiais');
 assert.deepEqual(resourceRows(all,['funcao','material']).map(r=>r.kind),['funcao','material']);
 assert.deepEqual(resourceRows(all,ALL_KINDS,['equipamento:eq2','material:m1|un']).map(r=>r.label),['PTA-001','Cinta']);
 assert.equal(resourceRows(all,['material'])[0].total,4);
 assert.deepEqual(resourceOptions(all,['equipamento']).map(o=>o.label),['Equipamento: ED-16-02','Equipamento: PTA-001']);
 const q=resourceParams(['equipamento'],['equipamento:eq2']);
 assert.deepEqual(resourceFromParams(q),{kinds:['equipamento'],picked:['equipamento:eq2']});
 assert.deepEqual(resourceFromParams(new URLSearchParams('tipos=xyz&recursos=../etc')),{kinds:ALL_KINDS,picked:[]},'valores inválidos são ignorados');
});
