import {AppError} from './domain';
import {db} from './db';

/** Perfil do usuário: define o módulo principal. O gestor tem todos os módulos. */
export type Profile='fueler'|'planner'|'operator'|'maintainer'|'manager';
/** Acessos adicionais (outros módulos), acumuláveis com o módulo principal do perfil. */
export type Capability='abastecimento'|'planejamento'|'operacao'|'manutencao'|'cadastros'|'acompanhamento';
export const capabilities:Capability[]=['abastecimento','planejamento','operacao','manutencao','cadastros','acompanhamento'];
export type Member={id:string;profile:Profile;active?:number|boolean;name:string;capabilities?:string[];[key:string]:unknown};
export const profiles:Profile[]=['fueler','planner','operator','maintainer','manager'];
/** Módulo principal concedido por cada perfil (não precisa ser marcado nos acessos adicionais). */
export const PROFILE_MODULE:Record<Exclude<Profile,'manager'>,Capability>={fueler:'abastecimento',planner:'planejamento',operator:'operacao',maintainer:'manutencao'};
/** Acessos efetivos: módulo principal do perfil + acessos adicionais gravados. */
export function effectiveCaps(profile:string,stored:string[]|null|undefined):string[]{
 const main=PROFILE_MODULE[profile as keyof typeof PROFILE_MODULE];
 return [...new Set([...(main?[main]:[]),...(stored||[])])];
}
export function isManager(a:Member){return a.profile==='manager';}
export function has(a:Member,c:Capability){return isManager(a)||effectiveCaps(a.profile,a.capabilities).includes(c);}
/** Abastecimento: solicitar é de quem tem o módulo; agendar é do planejador com o módulo; registrar é do abastecedor. */
export function canRequest(a:Member){return has(a,'abastecimento');}
export function canPlan(a:Member){return isManager(a)||(a.profile==='planner'&&has(a,'abastecimento'));}
export function canRecord(a:Member){return a.profile==='fueler'||isManager(a);}
/** Cancelar OS: só perfil Planejador ou Gestão (acesso adicional ao Planejamento não basta). */
export function canCancelOrders(a:Member){return a.profile==='planner'||isManager(a);}
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
 // Capacidades efetivas: o módulo principal do perfil já vem incluído.
 return {...a,profile:current.profile,capabilities:effectiveCaps(current.profile,current.capabilities),org_scope:current.org_scope||[]} as Member&{capabilities:string[],org_scope:string[]};
}
export const fuelModules=['visao','solicitacoes','abastecimentos','estoque','alertas'];
export const registryModules=['cad-solicitantes','cad-locais','cad-equipamentos','cad-colaboradores','cad-checklists','cad-categorias'];
export const planningModules=['plan-fluxos','plan-atividade','plan-os'];
export const operationModules=['op-painel','op-os','op-registro'];
export const maintenanceModules=['man-painel','man-criterios','man-corretivas','man-leituras'];
/** Telas liberadas: o módulo principal do perfil e os módulos dos acessos adicionais (o gestor vê
 * todos). O servidor revalida cada consulta e comando. */
export function modules(a:Member){
 // Painel central: tela inicial de todos (o conteúdo segue o acesso de cada pessoa).
 const list:string[]=['painel'];
 if(has(a,'abastecimento'))list.push(...(isManager(a)?fuelModules:canRecord(a)?['solicitacoes','abastecimentos']:['solicitacoes']));
 if(has(a,'planejamento'))list.push(...planningModules);
 // Operação: quem executa; "Acompanhamento" consulta o painel e os apontamentos.
 if(has(a,'operacao'))list.push(...operationModules);
 else if(has(a,'acompanhamento'))list.push('op-painel','op-os');
 if(has(a,'manutencao'))list.push(...maintenanceModules);
 if(has(a,'cadastros'))list.push(...registryModules);
 // Exportação: o gestor exporta tudo; quem consulta OS exporta os dados de Operação do seu escopo.
 if(isManager(a)||canSeeOrders(a))list.push('exportacao');
 return list;
}
/** Pode consultar OS lançadas (respeitando o escopo de organizações). */
export function canSeeOrders(a:Member){return has(a,'planejamento')||has(a,'acompanhamento')||has(a,'operacao');}
