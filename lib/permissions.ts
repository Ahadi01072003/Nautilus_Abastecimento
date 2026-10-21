import {AppError} from './domain';
import {db} from './db';

export type Profile='requester'|'planner'|'fueler'|'manager'|'none';
/** Acessos adicionais, acumuláveis com qualquer perfil. O gestor tem todos. */
export type Capability='cadastros'|'planejamento'|'acompanhamento'|'manutencao'|'operacao';
export const capabilities:Capability[]=['cadastros','planejamento','acompanhamento','manutencao','operacao'];
export type Member={id:string;profile:Profile;active?:number|boolean;name:string;capabilities?:string[];[key:string]:unknown};
export const profiles:Profile[]=['requester','planner','fueler','manager','none'];
export function isManager(a:Member){return a.profile==='manager';}
export function canRequest(a:Member){return a.profile==='requester'||isManager(a);}
export function canPlan(a:Member){return a.profile==='planner'||isManager(a);}
export function canRecord(a:Member){return a.profile==='fueler'||isManager(a);}
export function has(a:Member,c:Capability){return isManager(a)||!!a.capabilities?.includes(c);}
export function requireProfile(a:Member,allowed:Profile[]){if(!allowed.includes(a.profile))throw new AppError('Seu perfil não permite esta ação.',403);}
/** Reconfere no cadastro atual (não na sessão): revogações valem na hora. */
export async function requireCapability(a:Member,c:Capability){
 return requireAny(a,[c]);
}
/** Basta um dos acessos. Devolve o cadastro atual, com o escopo de organizações. */
export async function requireAny(a:Member,list:Capability[]){
 const current=await loadAccess(a);
 if(!isManager(current)&&!list.some(c=>current.capabilities.includes(c)))throw new AppError('Seu acesso não permite esta ação.',403);
 return current;
}
/** Cadastro atual (perfil, acessos e escopo), sem exigir um acesso específico. */
export async function loadAccess(a:Member){
 const current=await db().first('SELECT profile,active,capabilities,org_scope FROM members WHERE id=?',a.id);
 if(!current?.active)throw new AppError('Seu acesso mudou. Atualize a tela.',403);
 return {...a,profile:current.profile,capabilities:current.capabilities||[],org_scope:current.org_scope||[]} as Member&{capabilities:string[],org_scope:string[]};
}
export const fuelModules=['visao','solicitacoes','abastecimentos','estoque','alertas'];
export const registryModules=['cad-solicitantes','cad-locais','cad-equipamentos','cad-colaboradores','cad-checklists','cad-categorias'];
export const planningModules=['plan-fluxos','plan-atividade','plan-rascunhos','plan-os'];
export const operationModules=['op-painel','op-os'];
export const maintenanceModules=['man-painel','man-criterios','man-corretivas','man-leituras'];
/** Telas liberadas para o usuário. O servidor revalida cada consulta e comando. */
export function modules(a:Member){
 // Painel central: tela inicial de todos (o conteúdo segue o acesso de cada pessoa).
 const list:string[]=['painel',...(isManager(a)?fuelModules:a.profile==='fueler'?['solicitacoes','abastecimentos']:a.profile==='none'?[]:['solicitacoes'])];
 if(has(a,'planejamento'))list.push(...planningModules);
 if(has(a,'planejamento')||has(a,'acompanhamento')||has(a,'operacao'))list.push(...operationModules);
 // Registrar atividade realizada sem planejamento (urgência): quem executa ou planeja.
 if(has(a,'planejamento')||has(a,'operacao'))list.push('op-registro');
 if(has(a,'cadastros'))list.push(...registryModules);
 // Manutenção: quem tem o acesso registra tudo; Planejamento e Operação consultam o painel; Operação registra leituras.
 if(has(a,'manutencao'))list.push(...maintenanceModules);
 else{if(has(a,'planejamento')||has(a,'operacao'))list.push('man-painel');if(has(a,'operacao'))list.push('man-leituras');}
 // Exportação: o gestor exporta tudo; quem consulta OS exporta os dados de Operação do seu escopo.
 if(isManager(a)||canSeeOrders(a))list.push('exportacao');
 return list;
}
/** Pode consultar OS lançadas (respeitando o escopo de organizações). */
export function canSeeOrders(a:Member){return has(a,'planejamento')||has(a,'acompanhamento')||has(a,'operacao');}
