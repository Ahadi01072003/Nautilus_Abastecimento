// Documentos do planejamento (JPG, PNG, PDF até 20 MiB) em armazenamento privado.
// O arquivo vai direto do navegador para o Supabase Storage por URL assinada; o servidor
// do NAUTILUS confere permissão antes e o conteúdo real (assinatura do arquivo) depois.
// A chave de serviço do Supabase nunca sai do Supabase: uma função de borda faz as
// operações, autenticada por um token gerado no próprio banco (app_settings).
import {db,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny,canSeeOrders} from './permissions';
import {audit} from './registry';

const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
export const MAX_BYTES=20*1024*1024;
const TYPES:Record<string,{ext:string[],magic:(h:Uint8Array)=>boolean}>={
 'image/jpeg':{ext:['jpg','jpeg'],magic:h=>h[0]===0xff&&h[1]===0xd8&&h[2]===0xff},
 'image/png':{ext:['png'],magic:h=>[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((v,i)=>h[i]===v)},
 'application/pdf':{ext:['pdf'],magic:h=>h[0]===0x25&&h[1]===0x50&&h[2]===0x44&&h[3]===0x46&&h[4]===0x2d},
};

export type Storage={
 signUpload(path:string):Promise<string>;
 signDownload(path:string,downloadName?:string):Promise<string>;
 inspect(path:string):Promise<{size:number,head:Uint8Array}|null>;
 remove(path:string):Promise<void>;
};

/** Gateway real: função de borda nautilus-storage. URL e token ficam em app_settings. */
async function edgeStorage():Promise<Storage>{
 const rows=await db().all("SELECT key,value FROM app_settings WHERE key IN ('storage_url','storage_token')");
 const url=rows.find(r=>r.key==='storage_url')?.value,token=rows.find(r=>r.key==='storage_token')?.value;
 if(!url||!token)throw new AppError('Os anexos ainda não foram configurados neste ambiente.',503);
 const call=async(body:Row)=>{
  const r=await fetch(url+'/functions/v1/nautilus-storage',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new AppError('O armazenamento de anexos não respondeu. Tente novamente em instantes.',503);
  return j as Row;
 };
 return {
  signUpload:async path=>(await call({action:'sign-upload',path})).url,
  signDownload:async (path,downloadName)=>(await call({action:'sign-download',path,download:downloadName||null})).url,
  inspect:async path=>{const j=await call({action:'inspect',path});return j.exists?{size:j.size,head:Uint8Array.from(Buffer.from(j.head,'base64'))}:null;},
  remove:async path=>{await call({action:'remove',path});},
 };
}
let override:Storage|null=null;
export function setTestStorage(s:Storage|null){override=s;}
const storage=()=>override?Promise.resolve(override):edgeStorage();

async function context(a:Member&{org_scope:string[]},planId:string){
 const plan=await db().first('SELECT p.*,w.number FROM plans p LEFT JOIN work_orders w ON w.id=p.work_order_id WHERE p.id=?',planId);
 if(!plan)throw new AppError('Planejamento não encontrado.',404);
 const own=plan.author_id===a.id||isManager(a);
 const scoped=isManager(a)||!a.org_scope.length||a.org_scope.includes(plan.org_id);
 const view=plan.status==='draft'?own:canSeeOrders(a)&&scoped;
 if(!view)throw new AppError('Documento fora do seu acesso.',404);
 return {plan,edit:plan.status==='draft'&&own};
}

export async function attachmentsMutate(path:string,b:Row,member:Member){
 const a=await requireAny(member,['planejamento']);
 if(path==='attachments/start'){
  const {plan,edit}=await context(a,required(b.planId,'Planejamento',100));
  if(!edit)throw new AppError('Documentos do planejamento só podem ser incluídos no rascunho, pelo autor ou pelo gestor.',403);
  const name=required(b.name,'Arquivo',200),mime=String(b.mime||''),size=Number(b.size);
  const kind=TYPES[mime];const ext=name.toLowerCase().split('.').pop()||'';
  if(!kind||!kind.ext.includes(ext))throw new AppError('Use arquivos JPG, PNG ou PDF.');
  if(!Number.isSafeInteger(size)||size<=0)throw new AppError('Arquivo vazio ou inválido.');
  if(size>MAX_BYTES)throw new AppError('O arquivo passa de 20 MB. Reduza o tamanho e tente novamente.',413);
  let stepKey:string|null=null;
  if(b.stepKey){stepKey=required(b.stepKey,'Etapa',60);if(!await db().first('SELECT 1 FROM plan_steps WHERE plan_id=? AND step_key=?',plan.id,stepKey))throw new AppError('Etapa não encontrada.',404);}
  const pending=await db().first("SELECT count(*) n FROM attachments WHERE plan_id=? AND status IN ('pendente','pronto')",plan.id);
  if(pending!.n>=200)throw new AppError('Limite de 200 documentos por planejamento.',409);
  const aid=id(),storagePath=`plans/${plan.id}/${aid}.${kind.ext[0]}`;
  const title=required(b.title||name,'Título',200);
  await db().tx(async tx=>{
   await tx.run("INSERT INTO attachments(id,plan_id,step_key,title,description,purpose,original_name,mime,size_bytes,storage_path,status,author_id,author_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pendente',?,?,?)",aid,plan.id,stepKey,title,text(b.description,500),text(b.purpose,120),name,mime,size,storagePath,a.id,a.name,now());
  });
  const uploadUrl=await (await storage()).signUpload(storagePath);
  return {id:aid,uploadUrl};
 }
 const att=await db().first('SELECT * FROM attachments WHERE id=?',required(b.id,'Documento',100));
 if(!att)throw new AppError('Documento não encontrado.',404);
 const {edit}=await context(a,att.plan_id);
 if(!edit)throw new AppError('Documentos do planejamento lançado não podem ser alterados.',403);
 if(path==='attachments/finish'){
  if(att.status==='pronto')return {ok:true,repeated:true};
  if(att.status!=='pendente')throw new AppError('Envio já encerrado.',409);
  const s=await storage();
  const info=await s.inspect(att.storage_path);
  // Só é "salvo" depois de conferido: tamanho declarado e assinatura real do conteúdo.
  const ok=!!info&&info.size===Number(att.size_bytes)&&TYPES[att.mime].magic(info.head);
  if(!ok){
   if(info)await s.remove(att.storage_path).catch(()=>{});
   await db().run("UPDATE attachments SET status='recusado' WHERE id=?",att.id);
   throw new AppError(info?'O conteúdo do arquivo não corresponde a JPG, PNG ou PDF, ou chegou incompleto. Envie novamente.':'O arquivo não chegou ao armazenamento. Envie novamente.',422);
  }
  await db().tx(async tx=>{
   await tx.run("UPDATE attachments SET status='pronto',ready_at=? WHERE id=? AND status='pendente'",now(),att.id);
   await audit(tx,a,'Planejamento: documento anexado',att.plan_id,{attachment:att.id,title:att.title,step:att.step_key,size:att.size_bytes});
  });
  return {ok:true};
 }
 if(path==='attachments/remove'){
  await db().tx(async tx=>{
   await tx.run("UPDATE attachments SET status='removido' WHERE id=?",att.id);
   await audit(tx,a,'Planejamento: documento removido do rascunho',att.plan_id,{attachment:att.id,title:att.title});
  });
  await (await storage()).remove(att.storage_path).catch(()=>{});
  return {ok:true};
 }
 throw new AppError('Ação não encontrada.',404);
}

/** Link temporário (2 min) para ver ou baixar, depois de conferir o acesso. */
export async function attachmentUrl(member:Member,url:URL){
 const a=await requireAny(member,['planejamento','acompanhamento']);
 const att=await db().first('SELECT * FROM attachments WHERE id=?',required(url.searchParams.get('id'),'Documento',100));
 if(!att||att.status!=='pronto')throw new AppError('Documento não encontrado.',404);
 await context(a,att.plan_id);
 const download=url.searchParams.get('download')==='1';
 return {url:await (await storage()).signDownload(att.storage_path,download?att.original_name:undefined),mime:att.mime,name:att.original_name};
}
