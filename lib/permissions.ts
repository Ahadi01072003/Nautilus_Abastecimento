import {AppError} from './domain';
import {db} from './db';

export type Profile='requester'|'planner'|'fueler'|'manager';
/** Acessos adicionais, acumuláveis com qualquer perfil. O gestor tem todos. */
export type Capability='cadastros'|'planejamento';
export const capabilities:Capability[]=['cadastros','planejamento'];
export type Member={id:string;profile:Profile;active?:number|boolean;name:string;capabilities?:string[];[key:string]:unknown};
export const profiles:Profile[]=['requester','planner','fueler','manager'];
export function isManager(a:Member){return a.profile==='manager';}
export function canRequest(a:Member){return a.profile==='requester'||isManager(a);}
export function canPlan(a:Member){return a.profile==='planner'||isManager(a);}
export function canRecord(a:Member){return a.profile==='fueler'||isManager(a);}
export function has(a:Member,c:Capability){return isManager(a)||!!a.capabilities?.includes(c);}
export function requireProfile(a:Member,allowed:Profile[]){if(!allowed.includes(a.profile))throw new AppError('Seu perfil não permite esta ação.',403);}
/** Reconfere no cadastro atual (não na sessão): revogações valem na hora. */
export async function requireCapability(a:Member,c:Capability){
 const current=await db().first('SELECT profile,active,capabilities FROM members WHERE id=?',a.id);
 if(!current?.active)throw new AppError('Seu acesso mudou. Atualize a tela.',403);
 if(current.profile!=='manager'&&!(current.capabilities||[]).includes(c))throw new AppError('Seu acesso não permite esta ação.',403);
 return {...a,profile:current.profile,capabilities:current.capabilities||[]} as Member;
}
export const fuelModules=['visao','solicitacoes','abastecimentos','estoque','alertas'];
export const registryModules=['cad-solicitantes','cad-locais','cad-equipamentos','cad-colaboradores','cad-checklists','cad-categorias'];
export const planningModules=['plan-fluxos'];
/** Telas liberadas para o usuário. O servidor revalida cada consulta e comando. */
export function modules(a:Member){
 const list:string[]=isManager(a)?[...fuelModules,'exportacao']:a.profile==='fueler'?['solicitacoes','abastecimentos']:['solicitacoes'];
 if(has(a,'planejamento'))list.push(...planningModules);
 if(has(a,'cadastros'))list.push(...registryModules);
 return list;
}
