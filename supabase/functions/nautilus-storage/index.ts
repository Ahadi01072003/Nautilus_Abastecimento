// Função de borda do Supabase usada pelo servidor do NAUTILUS para os anexos.
// A chave de serviço (SUPABASE_SERVICE_ROLE_KEY) só existe aqui, dentro do Supabase.
// O chamador se autentica com o token guardado em nautilus.app_settings (gerado no banco).
import postgres from 'npm:postgres@3.4.9';

const BUCKET='nautilus-anexos';
const PATH=/^plans\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|pdf)$/;
const base=Deno.env.get('SUPABASE_URL')!+'/storage/v1';
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const auth={Authorization:'Bearer '+key,apikey:key};
let cached:{token:string,at:number}|null=null;

async function expected(){
 if(cached&&Date.now()-cached.at<60_000)return cached.token;
 const sql=postgres(Deno.env.get('SUPABASE_DB_URL')!,{max:1,prepare:false});
 try{const [row]=await sql`SELECT value FROM nautilus.app_settings WHERE key='storage_token'`;cached={token:row?.value||'',at:Date.now()};return cached.token;}
 finally{await sql.end();}
}
function same(a:string,b:string){if(!a||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});

Deno.serve(async req=>{
 if(req.method!=='POST')return json({error:'method'},405);
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 if(!same(token,await expected()))return json({error:'unauthorized'},401);
 let body:{action?:string,path?:string,download?:string|null};
 try{body=await req.json();}catch{return json({error:'body'},400);}
 const path=String(body.path||'');
 if(!PATH.test(path))return json({error:'path'},400);
 if(body.action==='sign-upload'){
  const r=await fetch(`${base}/object/upload/sign/${BUCKET}/${path}`,{method:'POST',headers:auth});
  const j=await r.json();if(!r.ok||!j.url)return json({error:'sign-upload'},502);
  return json({url:Deno.env.get('SUPABASE_URL')+'/storage/v1'+j.url});
 }
 if(body.action==='sign-download'){
  const r=await fetch(`${base}/object/sign/${BUCKET}/${path}`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:120})});
  const j=await r.json();if(!r.ok||!j.signedURL)return json({error:'sign-download'},502);
  const name=body.download?String(body.download).replace(/[^\w.\- ]/g,'_').slice(0,120):'';
  return json({url:Deno.env.get('SUPABASE_URL')+'/storage/v1'+j.signedURL+(name?'&download='+encodeURIComponent(name):'')});
 }
 if(body.action==='inspect'){
  const r=await fetch(`${base}/object/authenticated/${BUCKET}/${path}`,{headers:{...auth,Range:'bytes=0-15'}});
  if(r.status===404||r.status===400)return json({exists:false});
  if(!r.ok)return json({error:'inspect'},502);
  const head=new Uint8Array(await r.arrayBuffer()).slice(0,16);
  const range=r.headers.get('Content-Range');const size=range?Number(range.split('/')[1]):Number(r.headers.get('Content-Length'));
  let bin='';for(const b of head)bin+=String.fromCharCode(b);
  return json({exists:true,size,head:btoa(bin)});
 }
 if(body.action==='remove'){
  const r=await fetch(`${base}/object/${BUCKET}`,{method:'DELETE',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({prefixes:[path]})});
  return json({ok:r.ok});
 }
 return json({error:'action'},400);
});
