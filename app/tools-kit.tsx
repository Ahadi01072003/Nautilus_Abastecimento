'use client';
// Ferramentaria: peças compartilhadas pelas telas (nomes, números e envio com chave de idempotência).
import {useRef} from 'react';
import {post,type R} from './kit';

export const KIND_NAMES:Record<string,string>={ferramenta:'Ferramenta',material:'Material'};
export const MOVE_NAMES:Record<string,string>={entrada:'Entrada',saida:'Saída',perda:'Perda',ajuste:'Ajuste',emprestimo:'Empréstimo',devolucao:'Devolução',contagem:'Contagem'};
export const REASONS:Record<string,string[]>={entrada:['Compra','Devolução','Transferência','Outro'],saida:['Consumo','Descarte','Transferência','Outro'],perda:['Extravio','Quebra','Desgaste','Outro'],ajuste:['Contagem','Correção de cadastro','Outro']};
export const PRESET_KEY='nautilus.tools.kind';
export const qtyText=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:3});
export const pl=(n:number,one:string,many:string)=>`${n} ${n===1?one:many}`;
export const num=(s:string)=>Number(String(s).trim().replace(/\./g,'').replace(',','.'));

/** Uma chave por tentativa: reenviar o MESMO conteúdo (duplo toque, rede) devolve o mesmo resultado; conteúdo novo ganha chave nova. */
export function useKey(){
 const ref=useRef<{id:string,body:string}|null>(null);
 if(ref.current==null)ref.current={id:crypto.randomUUID(),body:''};
 return {for:(body:unknown)=>{const c=ref.current as {id:string,body:string},t=JSON.stringify(body);if(c.body&&t!==c.body)c.id=crypto.randomUUID();c.body=t;return c.id;},renew:()=>{ref.current={id:crypto.randomUUID(),body:''};}};
}
export const tpost=(path:string,body:R,k:ReturnType<typeof useKey>)=>post(path,{...body,idempotencyKey:k.for(body)});
