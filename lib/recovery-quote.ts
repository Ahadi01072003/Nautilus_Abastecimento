// Financeiro · Frente B: cálculo de cada cotação pela regra A e caminhos de situação da solicitação.
// Puro, sem banco. Dinheiro em centavos inteiros; percentuais em centésimos de % (1500 = 15%).
// Regra A: margem = arredondar(P × m); valor a faturar = arredondar(P × (1 + m) ÷ (1 − i));
// subtotal = P + margem; impostos = valor a faturar − subtotal (absorvem o centavo da diferença).
import {AppError} from './domain';

export type QuoteTotals={quotedCents:number,marginCents:number,subtotalCents:number,taxCents:number,totalCents:number};
export type RequestStatus='em_cotacao'|'enviada'|'autorizada'|'em_execucao'|'concluida'|'cancelada';

/** Até R$ 100 milhões: todos os produtos abaixo cabem em Number.MAX_SAFE_INTEGER. */
const MAX_CENTS=10_000_000_000;
const BP=10000;

/** Margem, subtotal, impostos e valor a faturar de uma cotação (metade para cima, em inteiros). */
export function quoteTotals(quotedCents:number,marginBp:number,taxBp:number):QuoteTotals{
 if(!Number.isInteger(quotedCents)||quotedCents<0||quotedCents>MAX_CENTS)throw new AppError('Valor cotado inválido.');
 if(!Number.isInteger(marginBp)||marginBp<0||marginBp>=BP)throw new AppError('Margem inválida (de 0% a 99,99%).');
 if(!Number.isInteger(taxBp)||taxBp<0||taxBp>=BP)throw new AppError('Impostos inválidos (de 0% a 99,99%).');
 const marginCents=Math.floor((2*quotedCents*marginBp+BP)/(2*BP));
 const totalCents=Math.floor((2*quotedCents*(BP+marginBp)+(BP-taxBp))/(2*(BP-taxBp)));
 const subtotalCents=quotedCents+marginCents;
 return {quotedCents,marginCents,subtotalCents,taxCents:totalCents-subtotalCents,totalCents};
}

/** Caminhos de situação (spec §6). Com OS em execução não se cancela a solicitação: cancela-se a OS
 * antes, e a solicitação volta a "Autorizada" (decisão do usuário em 30/10/2026). */
export const NEXT:Record<RequestStatus,RequestStatus[]>={
 em_cotacao:['enviada','cancelada'],
 enviada:['em_cotacao','autorizada','cancelada'],
 autorizada:['em_cotacao','em_execucao','cancelada'],
 em_execucao:['autorizada','concluida'],
 concluida:[],
 cancelada:[],
};
export const canMove=(from:RequestStatus,to:RequestStatus)=>NEXT[from].includes(to);

export const recNumber=(n:number)=>'REC-'+String(n).padStart(6,'0');
