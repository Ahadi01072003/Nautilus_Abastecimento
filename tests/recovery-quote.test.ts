// Financeiro · Frente B: cálculo da cotação pela regra A (centavos, metade para cima; os impostos
// absorvem a diferença) e caminhos de situação da solicitação. Valores fictícios (10% e 10%).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quoteTotals,canMove,recNumber} from '../lib/recovery-quote';
import {AppError} from '../lib/domain';

const row=(t:ReturnType<typeof quoteTotals>)=>[t.quotedCents,t.marginCents,t.subtotalCents,t.taxCents,t.totalCents];

test('regra A: as três cotações do exemplo fecham centavo a centavo (10% e 10%)',()=>{
 assert.deepEqual(row(quoteTotals(1000000,1000,1000)),[1000000,100000,1100000,122222,1222222]);
 assert.deepEqual(row(quoteTotals(2500050,1000,1000)),[2500050,250005,2750055,305562,3055617]);
 assert.deepEqual(row(quoteTotals(833333,1000,1000)),[833333,83333,916666,101852,1018518]);
});

test('regra A: subtotal + impostos = valor a faturar para qualquer valor',()=>{
 for(const p of [1,99,12345,99999999,1234567890])for(const [m,i] of [[1000,1250],[0,0],[1500,0],[0,1250]]){
  const t=quoteTotals(p,m,i);
  assert.equal(t.subtotalCents+t.taxCents,t.totalCents,`${p} ${m} ${i}`);assert.ok(t.taxCents>=0);
 }
});

test('regra A: percentuais diferentes por cliente',()=>{
 const t=quoteTotals(1000000,1000,1250);
 assert.equal(t.totalCents,1257143);assert.equal(t.marginCents,100000);
});

test('entradas inválidas recusadas',()=>{
 for(const [p,m,i] of [[-1,1000,1000],[10.5,1000,1000],[1000,1000,10000],[1000,-1,1000]])assert.throws(()=>quoteTotals(p,m,i),AppError,`${p} ${m} ${i}`);
});

test('caminhos de situação',()=>{
 for(const [a,b] of [['em_cotacao','enviada'],['enviada','em_cotacao'],['autorizada','em_execucao'],['em_execucao','autorizada']] as const)assert.ok(canMove(a,b),`${a}→${b}`);
 // Com OS em execução, cancela-se a OS antes (decisão do usuário em 30/10/2026).
 for(const [a,b] of [['em_cotacao','autorizada'],['concluida','cancelada'],['em_execucao','cancelada']] as const)assert.ok(!canMove(a,b),`${a}→${b}`);
});

test('número da solicitação',()=>{assert.equal(recNumber(1),'REC-000001');});
