import postgres from 'postgres';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Colunas variam por consulta; entradas passam pelos validadores do domínio.
export type Row=Record<string,any>;
export type Executor={
 /** Linhas retornadas. Placeholders `?` são convertidos para `$n`. */
 all<T=Row>(query:string,...values:unknown[]):Promise<T[]>;
 first<T=Row>(query:string,...values:unknown[]):Promise<T|null>;
 /** Quantidade de linhas afetadas. */
 run(query:string,...values:unknown[]):Promise<number>;
};
export type Database=Executor&{tx<T>(fn:(tx:Executor)=>Promise<T>):Promise<T>};

export function env(){
 return process.env as {DATABASE_URL?:string;RESEND_API_KEY?:string;EMAIL_FROM?:string;EMAIL_ENABLED?:string;CRON_SECRET?:string;DEFAULT_PASSWORD?:string;APP_URL?:string};
}

/** Converte `?` em `$1..$n`, ignorando literais entre aspas simples. */
export function placeholders(query:string){
 let out='',n=0,quoted=false;
 for(const ch of query){
  if(ch==="'")quoted=!quoted;
  out+=!quoted&&ch==='?'?'$'+(++n):ch;
 }
 return out;
}

type Sql=postgres.Sql<Record<string,never>>;
type Unsafe=Pick<Sql,'unsafe'>;
/** Limita operações simultâneas ao tamanho do pool. Sem isso o driver enfileira várias
 *  consultas na mesma conexão (pipelining), o que trava o pooler do Supabase em modo transação. */
function limiter(size:number){
 let active=0;const waiting:(()=>void)[]=[];
 return async<T,>(fn:()=>Promise<T>)=>{
  if(active>=size)await new Promise<void>(resolve=>waiting.push(resolve));else active++;
  try{return await fn();}
  finally{const next=waiting.shift();if(next)next();else active--;}
 };
}
type Limit=ReturnType<typeof limiter>;
function executor(sql:Unsafe,limit?:Limit):Executor{
 const run=(query:string,values:unknown[])=>sql.unsafe(placeholders(query),values as postgres.ParameterOrJSON<never>[]);
 const exec=(query:string,values:unknown[])=>limit?limit(async()=>await run(query,values)):run(query,values);
 return {
  async all<T>(query:string,...values:unknown[]){return [...await exec(query,values)] as T[];},
  async first<T>(query:string,...values:unknown[]){const rows=await exec(query,values);return (rows[0]??null) as T|null;},
  async run(query:string,...values:unknown[]){return (await exec(query,values)).count;},
 };
}

let instance:Database|null=null;
let override:Database|null=null;

export function connect(url:string,options:postgres.Options<Record<string,never>>={}):Database&{end():Promise<void>}{
 const max=Number(options.max||process.env.DATABASE_POOL_MAX||5),limit=limiter(max);
 const sql=postgres(url,{
  // Pooler do Supabase em modo transação não suporta prepared statements nomeados.
  prepare:false,max,idle_timeout:20,connect_timeout:10,
  // int8 (COUNT, quantidades em milésimos) volta como number; valores < 2^53.
  types:{bigint:{to:20,from:[20],serialize:(x:number)=>String(x),parse:(x:string)=>Number(x)}},
  onnotice:()=>{},
  ...options,
 }) as unknown as Sql;
 return {
  ...executor(sql,limit),
  // A transação ocupa uma vaga do limitador inteira; dentro dela as consultas são sequenciais.
  tx:<T,>(fn:(tx:Executor)=>Promise<T>)=>limit(()=>sql.begin(tx=>fn(executor(tx as unknown as Unsafe))) as Promise<T>),
  end:()=>sql.end({timeout:5}),
 };
}

export function db():Database{
 if(override)return override;
 if(!instance){
  const url=env().DATABASE_URL;
  if(!url)throw new Error('DATABASE_URL não configurada.');
  instance=connect(url);
 }
 return instance;
}
/** Usado somente pelos testes automatizados. */
export function setTestDatabase(database:Database|null){override=database;}
