import {createHash} from 'node:crypto';
import {AppError} from './domain';
import {db} from './db';

export const MAX_BODY_BYTES=32768;
export async function boundedJSON(req:Request){
 if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers.get('Content-Type')||''))throw new AppError('Formato inválido.',415);
 const reader=req.body?.getReader();if(!reader)throw new AppError('Dados inválidos.');
 let bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});let source='';
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BODY_BYTES){await reader.cancel();throw new AppError('Dados excedem o limite.',413);}source+=decoder.decode(value,{stream:true});}source+=decoder.decode();}
 catch(e){if(e instanceof AppError)throw e;throw new AppError('Dados inválidos.');}
 let body;try{body=JSON.parse(source);}catch{throw new AppError('Dados inválidos.');}
 if(!body||Array.isArray(body)||typeof body!=='object')throw new AppError('Dados inválidos.');return body;
}
/** Bloqueia requisições de alteração vindas de outros sites (CSRF). */
export function sameOrigin(req:Request){
 const origin=req.headers.get('Origin'),host=req.headers.get('x-forwarded-host')||req.headers.get('host');
 const expected=new Set([new URL(req.url).origin]);
 if(host)expected.add(`${req.headers.get('x-forwarded-proto')||new URL(req.url).protocol.replace(':','')}://${host}`);
 if(!origin||!expected.has(origin)||req.headers.get('Sec-Fetch-Site')==='cross-site')throw new AppError('Origem não autorizada.',403);
}
const limits={read:90,write:30,export:5,cron:10,email_test:2,login:10,password:10};
/** Contador atômico por chave (conta ou hash do endereço de rede), janela de 1 minuto. */
export async function rateLimit(subject:string,action:keyof typeof limits){
 const minute=Math.floor(Date.now()/60000),key=subject+':'+action;
 const row=await db().first<{hits:number}>('INSERT INTO rate_limits(key,window_start,hits) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,hits=CASE WHEN rate_limits.window_start=excluded.window_start THEN rate_limits.hits+1 ELSE 1 END RETURNING hits',key,minute);
 if(!row||row.hits>limits[action])throw new AppError('Muitas solicitações. Aguarde um minuto e tente novamente.',429);
 if(Math.random()<0.05)await db().run('DELETE FROM rate_limits WHERE window_start<?',minute-10);
}
/** Identificador não reversível do cliente para limitar tentativas de login sem guardar o IP. */
export function clientKey(req:Request){
 const ip=(req.headers.get('x-forwarded-for')||'').split(',')[0].trim()||req.headers.get('x-real-ip')||'local';
 return 'ip_'+createHash('sha256').update('nautilus:'+ip).digest('hex').slice(0,32);
}
export async function bearerMatches(received:string|null,secret:string|undefined){
 if(!secret||!received?.startsWith('Bearer '))return false;
 const digest=async(s:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
 const [a,b]=await Promise.all([digest(received.slice(7)),digest(secret)]);let delta=0;for(let i=0;i<a.length;i++)delta|=a[i]^b[i];return delta===0;
}
