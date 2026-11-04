// Portaria · peças comuns: acesso, erros de domínio com código estável, base única, datas no fuso da
// base, máscara do documento e idempotência. Datas e horas são timestamptz/date no banco; aqui os
// instantes viajam como texto ISO (UTC).
import {createHash} from 'node:crypto';
import {db,type Executor,type Row} from './db';
import {AppError} from './domain';
import {type Member,isManager,requireAny} from './permissions';

export type Actor=Member&{capabilities:string[],org_scope:string[]};
export const id=()=>crypto.randomUUID();
export const fail=(status:number,code:string,message:string,field?:string)=>new AppError(message,status,code,field);
export const invalid=(message:string,field?:string)=>fail(400,'VALIDATION',message,field);

/** Acesso à Portaria: perfil Porteiro, acesso "portaria" ou gestão. Confere o cadastro a cada chamada. */
export const portaria=async(member:Member)=>await requireAny(member,['portaria']) as Actor;
/** Ações exclusivas da gestão (cadastros, restauração, revisão). */
export function onlyManager(a:Actor){if(!isManager(a))throw fail(403,'FORBIDDEN','Esta ação é da gestão.');}

/** Limites configuráveis (padrões da especificação). */
export const LIMITS={
 retroactiveMinutes:Number(process.env.PORTARIA_RETRO_MINUTES||30),
 futureSkewMinutes:Number(process.env.PORTARIA_FUTURE_SKEW_MINUTES||2),
};

export type Base={id:string,name:string,timezone:string};
/** A Portaria tem uma base só (Base Açu); a coluna base_id existe para o dia em que houver mais de uma. */
export async function baseOf(ex:Executor):Promise<Base>{
 const b=await ex.first('SELECT id,name,timezone FROM portaria_bases ORDER BY id LIMIT 1');
 if(!b)throw fail(500,'BASE_NOT_FOUND','A base da portaria não está cadastrada.');
 return b as Base;
}

export const iso=(v:unknown):string|null=>v==null?null:v instanceof Date?v.toISOString():new Date(String(v)).toISOString();
const days=new Map<string,Intl.DateTimeFormat>();
/** Data local (AAAA-MM-DD) de um instante no fuso da base. */
export function localDate(instant:Date|string,timezone:string){
 let f=days.get(timezone);if(!f){f=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone});days.set(timezone,f);}
 return f.format(new Date(instant));
}

/** Instante informado pelo cliente (ISO com fuso) ou o do servidor. */
export function instantOf(value:unknown,label:string,field:string):Date{
 if(value==null||value==='')return new Date();
 const t=Date.parse(String(value));
 if(!Number.isFinite(t)||typeof value!=='string'||!/\d{4}-\d{2}-\d{2}T/.test(value))throw invalid(`${label}: data e hora inválidas.`,field);
 const d=new Date(t),year=d.getUTCFullYear();
 if(year<2000||year>2100)throw invalid(`${label}: ano fora da faixa (2000 a 2100).`,field);
 return d;
}

export function normDocument(value:string){return value.toUpperCase().replace(/[^A-Z0-9]/g,'');}
/** Mostra só o final do documento (preserva os separadores): "111.222.333-44" → "•••.•••.••3-44". */
export function maskDocument(value:string){
 const total=[...value].filter(c=>/[A-Za-z0-9]/.test(c)).length,visible=total>=8?3:total>=5?2:1;
 let seen=0;
 return [...value].reverse().map(c=>{if(!/[A-Za-z0-9]/.test(c))return c;seen++;return seen<=visible?c:'•';}).reverse().join('');
}

function stable(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value as Row).sort().filter(k=>(value as Row)[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable((value as Row)[k])).join(',')+'}';
 return JSON.stringify(value??null);
}

/** Chave de idempotência: a mesma chave com o mesmo conteúdo devolve a resposta guardada; com conteúdo
 * ou operação diferentes é recusada. A reserva da chave e a operação ficam na mesma transação: uma
 * falha desfaz as duas e a pessoa pode tentar de novo. */
export async function idempotent<T extends Row>(tx:Executor,a:Actor,payload:Row,operation:string,run:()=>Promise<T>):Promise<T&{replayed?:boolean}>{
 const key=payload.idempotencyKey;
 if(typeof key!=='string'||key.length<8||key.length>100)throw invalid('Informe a chave de idempotência da operação (de 8 a 100 caracteres).','idempotencyKey');
 const {idempotencyKey:_,...rest}=payload;void _;
 const hash=createHash('sha256').update(stable(rest)).digest('hex');
 const reserved=await tx.first("INSERT INTO portaria_idempotency(member_id,key,operation,request_hash,response) VALUES(?,?,?,?,'{}'::jsonb) ON CONFLICT (member_id,key) DO NOTHING RETURNING key",a.id,key,operation,hash);
 if(!reserved){
  const old=await tx.first('SELECT operation,request_hash,response FROM portaria_idempotency WHERE member_id=? AND key=?',a.id,key);
  if(!old||old.operation!==operation||old.request_hash!==hash)throw fail(409,'IDEMPOTENCY_KEY_REUSED','Esta chave de operação já foi usada com outros dados. Gere uma chave nova para uma operação diferente.');
  return {...(old.response as T),replayed:true};
 }
 const result=await run();
 await tx.run('UPDATE portaria_idempotency SET response=?::text::jsonb WHERE member_id=? AND key=?',JSON.stringify(result),a.id,key);
 return result;
}

/** Texto obrigatório com limite, devolvendo erro de campo. */
export function textField(value:unknown,label:string,field:string,max:number,requiredField=true){
 const s=String(value??'').replace(/\s+/g,' ').trim();
 if(!s&&requiredField)throw invalid(`${label} é obrigatório.`,field);
 if(s.length>max)throw invalid(`${label}: use até ${max} caracteres.`,field);
 return s;
}
/** Texto livre com quebras de linha, só limitado (observações e justificativas). */
export function longText(value:unknown,label:string,field:string,max:number,requiredField=false){
 const s=String(value??'').trim();
 if(!s&&requiredField)throw invalid(`${label} é obrigatória.`,field);
 if(s.length>max)throw invalid(`${label}: use até ${max} caracteres.`,field);
 return s;
}

export function pageOf(url:URL,max=50){
 const limit=Math.min(max,Math.max(1,Number(url.searchParams.get('limit'))||20)),page=Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1));
 return {limit,page,offset:(page-1)*limit};
}
/** Termo de busca seguro para ILIKE (escapa %, _ e \). */
export const likeOf=(q:string)=>'%'+q.replace(/[\\%_]/g,'\\$&')+'%';

export {db};
