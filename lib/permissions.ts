import {AppError} from './domain';

export type Profile='requester'|'planner'|'fueler'|'manager';
export type Member={id:string;profile:Profile;active?:number|boolean;name:string;[key:string]:unknown};
export const profiles:Profile[]=['requester','planner','fueler','manager'];
export function isManager(a:Member){return a.profile==='manager';}
export function canRequest(a:Member){return a.profile==='requester'||isManager(a);}
export function canPlan(a:Member){return a.profile==='planner'||isManager(a);}
export function canRecord(a:Member){return a.profile==='fueler'||isManager(a);}
export function requireProfile(a:Member,allowed:Profile[]){if(!allowed.includes(a.profile))throw new AppError('Seu perfil não permite esta ação.',403);}
export function modules(a:Member){
 if(isManager(a))return ['visao','solicitacoes','abastecimentos','estoque','alertas','equipamentos','operadores','combustiveis','exportacao'];
 if(a.profile==='requester')return ['solicitacoes'];
 if(a.profile==='planner')return ['solicitacoes'];
 if(a.profile==='fueler')return ['solicitacoes','abastecimentos'];
 return [];
}
