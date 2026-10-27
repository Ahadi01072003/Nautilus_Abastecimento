import {test} from 'node:test';
import assert from 'node:assert/strict';
import {arrangeOrders,flatRows,viewFromParams,viewToParams,NO_SECTOR,type OsItem} from '../lib/os-order';

// Agora: 10/05/2033 12:00 (UTC). Datas completas, com hora.
const NOW=Date.UTC(2033,4,10,12);
const h=(d:number,hh:number)=>new Date(Date.UTC(2033,4,d,hh)).toISOString();
let n=0;
const os=(p:Partial<OsItem>):OsItem=>({id:'id'+(++n),number:n,status:'programada',org_id:'A',sector_code:null,planned_start:null,planned_end:null,...p});
const numbers=(g:ReturnType<typeof arrangeOrders>)=>flatRows(g).map(r=>r.item.number);

const list=[
 os({number:1,status:'programada',planned_start:h(12,8),planned_end:h(12,17),sector_code:'PAT',org_id:'A'}),
 os({number:2,status:'programada',planned_start:h(11,8),planned_end:h(11,10),sector_code:'ARM',org_id:'B'}),
 os({number:3,status:'programada',planned_start:h(11,8),planned_end:h(11,9),sector_code:'ARM',org_id:'A'}),   // empate de início: término menor primeiro
 os({number:4,status:'programada',planned_start:h(9,8),planned_end:h(9,17),org_id:'A'}),                        // em atraso (início vencido), sem setor
 os({number:5,status:'programada',planned_start:h(8,8),planned_end:h(8,17),sector_code:'PAT',org_id:'B'}),    // em atraso há mais tempo
 os({number:6,status:'em_andamento',planned_start:h(7,8),planned_end:h(7,17),actual_start:h(7,9),sector_code:'ARM',org_id:'A'}), // em andamento e atrasada
 os({number:7,status:'em_andamento',planned_start:h(10,8),planned_end:h(10,20),actual_start:h(10,7),org_id:'B'}),
 os({number:8,status:'cancelada',planned_start:h(13,8),planned_end:h(13,9),org_id:'A'}),
 os({number:9,status:'cancelada',planned_start:null,planned_end:null,org_id:'A'}),                             // cancelada sem data: fim
 os({number:10,status:'programada',planned_start:null,planned_end:null,org_id:'A'}),                           // sem início planejado
 os({number:11,status:'concluida',planned_start:h(5,8),planned_end:h(5,17),actual_start:h(5,8),actual_end:h(5,12),org_id:'B'}),
 os({number:12,status:'encerramento_pendente',planned_start:h(6,8),planned_end:h(6,17),actual_start:h(6,8),actual_end:h(6,12),org_id:'A'}),
 os({number:13,status:'rascunho_estranho',planned_start:h(14,8),planned_end:h(14,9),org_id:'A'}),             // situação sem regra própria
];
const none={orgs:[],sectors:[]};

test('ordem de execução: crescente e decrescente por data e hora completas; sem início planejado sempre no fim',()=>{
 const asc=arrangeOrders(list,{mode:'execucao',dir:'asc',sectorDir:'asc'},none,NOW);
 assert.deepEqual(numbers(asc),[11,12,6,5,4,7,3,2,1,8,13,9,10]);
 assert.equal(asc.at(-1)!.label,'Sem início planejado');
 const desc=arrangeOrders(list,{mode:'execucao',dir:'desc',sectorDir:'asc'},none,NOW);
 // Decrescente: do mais distante ao mais antigo; empates mantêm término e número crescentes; sem data no fim.
 assert.deepEqual(numbers(desc),[13,8,1,3,2,7,4,5,6,12,11,9,10]);
});

test('por setor: setores em ordem alfabética nos dois sentidos, "Sem setor" no fim e OS cronológicas dentro',()=>{
 const g=arrangeOrders(list,{mode:'setor',dir:'asc',sectorDir:'asc'},none,NOW,c=>c+' · nome');
 assert.deepEqual(g.map(x=>x.label),['ARM · nome','PAT · nome','Sem setor']);
 assert.deepEqual(g[0].rows.map(r=>r.item.number),[6,3,2]);
 const z=arrangeOrders(list,{mode:'setor',dir:'desc',sectorDir:'desc'},none,NOW);
 assert.deepEqual(z.map(x=>x.key),['setor:PAT','setor:ARM','setor:'+NO_SECTOR]);
 assert.deepEqual(z[1].rows.map(r=>r.item.number),[3,2,6],'empate de início: término e número crescentes');
 assert.deepEqual(z[2].rows.slice(-2).map(r=>r.item.number),[9,10],'sem data continua no fim mesmo em decrescente');
});

test('por status: prioridade fixa, sem duplicar a OS em andamento atrasada, e o sentido não inverte nada',()=>{
 const g=arrangeOrders(list,{mode:'status',dir:'asc',sectorDir:'asc'},none,NOW);
 assert.deepEqual(g.map(x=>x.key),['em_andamento','encerramento_pendente','atraso','previstas','outras','concluida','cancelada']);
 assert.deepEqual(g[0].rows.map(r=>r.item.number),[6,7],'início real mais antigo primeiro');
 assert.equal(g[0].rows[0].flags.overdue,true,'em andamento com prazo vencido leva o sinalizador');
 assert.ok(!g[2].rows.some(r=>r.item.number===6),'não aparece também em "Em atraso"');
 assert.deepEqual(g[2].rows.map(r=>r.item.number),[5,4],'vencida há mais tempo primeiro');
 assert.deepEqual(g[3].rows.map(r=>r.item.number),[3,2,1,10],'mais próxima primeiro; sem data no fim');
 assert.deepEqual(g[6].rows.map(r=>r.item.number),[8,9]);
 const desc=arrangeOrders(list,{mode:'status',dir:'desc',sectorDir:'desc'},none,NOW);
 assert.deepEqual(numbers(desc),numbers(g));
 assert.equal(new Set(numbers(g)).size,list.length,'cada OS uma vez só');
});

test('filtros: OU dentro do mesmo filtro, E entre solicitante e setor; vazio = todos',()=>{
 const a={mode:'execucao' as const,dir:'asc' as const,sectorDir:'asc' as const};
 assert.deepEqual(numbers(arrangeOrders(list,a,{orgs:['B'],sectors:[]},NOW)).sort((x,y)=>x-y),[2,5,7,11]);
 assert.deepEqual(numbers(arrangeOrders(list,a,{orgs:[],sectors:['ARM','PAT']},NOW)).sort((x,y)=>x-y),[1,2,3,5,6]);
 assert.deepEqual(numbers(arrangeOrders(list,a,{orgs:['B'],sectors:['ARM']},NOW)),[2]);
 assert.deepEqual(numbers(arrangeOrders(list,a,{orgs:['A'],sectors:[NO_SECTOR]},NOW)).sort((x,y)=>x-y),[4,8,9,10,12,13]);
 assert.deepEqual(arrangeOrders(list,a,{orgs:['Z'],sectors:[]},NOW),[]);
});

test('datas inconsistentes são sinalizadas sem corrigir nada',()=>{
 const bad=[os({number:50,planned_start:h(12,10),planned_end:h(12,8)}),os({number:51,status:'concluida',planned_start:h(1,8),planned_end:h(1,9),actual_end:h(1,9)}),os({number:52,status:'concluida',planned_start:h(1,8),planned_end:h(1,9),actual_start:h(1,9),actual_end:h(1,8)})];
 const rows=flatRows(arrangeOrders(bad,{mode:'execucao',dir:'asc',sectorDir:'asc'},none,NOW));
 const by=(k:number)=>rows.find(r=>r.item.number===k)!.flags.issues;
 assert.match(by(50).join(),/Término planejado/);assert.match(by(51).join(),/sem início real/);assert.match(by(52).join(),/anterior ao início real/);
 assert.equal(rows.find(r=>r.item.number===50)!.item.planned_start,h(12,10),'valor original mantido');
});

test('configuração vai e volta pela URL (Apresentação herda a tela de origem)',()=>{
 const q=viewToParams({mode:'setor',dir:'desc',sectorDir:'asc'},{orgs:['A','B'],sectors:[NO_SECTOR]},'gantt');
 assert.deepEqual(viewFromParams(q),{arrange:{mode:'setor',dir:'desc',sectorDir:'asc'},filter:{orgs:['A','B'],sectors:[NO_SECTOR]},display:'gantt'});
 assert.equal(viewFromParams(new URLSearchParams('modo=qualquer')).arrange,undefined);
});
