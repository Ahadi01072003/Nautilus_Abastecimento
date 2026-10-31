// Financeiro · Frente B: anexos das solicitações de recobráveis (proposta do fornecedor por cotação,
// relatório assinado pelo cliente e outros documentos com descrição). PDF, JPG ou PNG de até 4 MB,
// guardados no próprio banco; o tipo vem do conteúdo, não do nome. Nada é apagado: outro arquivo no
// mesmo lugar marca o anterior como substituído. Acesso: Financeiro e Gestão, no escopo de organizações.
import {db,type Row} from './db';
import {AppError,required,text} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';
import {loadRequest} from './finance-requests';
import {recNumber} from './recovery-quote';

type Actor=Member&{capabilities:string[],org_scope:string[]};
type Kind='proposta'|'relatorio_assinado'|'outro';
export const MAX_ATTACHMENT=4_194_304;
const KINDS:Record<Kind,string>={proposta:'Proposta do fornecedor',relatorio_assinado:'Relatório assinado',outro:'Documento'};
const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const inScope=(a:Actor,orgId:string)=>isManager(a)||!a.org_scope.length||a.org_scope.includes(orgId);

/** Tipo pelo começo do arquivo: PDF (%PDF-), JPG (FF D8 FF) ou PNG (assinatura de 8 bytes). */
export function sniff(bytes:Uint8Array):'application/pdf'|'image/jpeg'|'image/png'|null{
 const starts=(sig:number[])=>bytes.length>=sig.length&&sig.every((v,i)=>bytes[i]===v);
 if(starts([0x25,0x50,0x44,0x46,0x2d]))return 'application/pdf';
 if(starts([0xff,0xd8,0xff]))return 'image/jpeg';
 if(starts([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return 'image/png';
 return null;
}

/** Corpo binário do envio, lido aos pedaços e cortado acima do limite (sem carregar tudo antes). */
export async function readAttachmentBody(req:Request){
 const reader=req.body?.getReader();if(!reader)throw new AppError('Arquivo vazio.');
 const parts:Uint8Array[]=[];let size=0;
 while(true){
  const {done,value}=await reader.read();if(done)break;
  size+=value.byteLength;
  if(size>MAX_ATTACHMENT){await reader.cancel();throw new AppError('Arquivo acima de 4 MB.',413);}
  parts.push(value);
 }
 const out=new Uint8Array(size);let at=0;for(const p of parts){out.set(p,at);at+=p.byteLength;}
 return out;
}

/** Nome guardado e devolvido no download: sem pastas, aspas nem caracteres de controle. */
const fileName=(v:unknown)=>required(v,'Nome do arquivo',200).replace(/^.*[\\/]/,'').replace(/[\u0000-\u001f\u007f"]/g,'_')||'arquivo';

export async function uploadAttachment(member:Member,params:URLSearchParams,body:Uint8Array){
 const a=await requireAny(member,['financeiro']) as Actor;
 const kind=params.get('kind') as Kind;
 if(!KINDS[kind])throw new AppError('Tipo de anexo inválido.');
 const name=fileName(params.get('name')),description=text(params.get('description'),300);
 if(kind==='outro'&&!description)throw new AppError('Descreva o documento.');
 if(!body.byteLength)throw new AppError('Arquivo vazio.');
 if(body.byteLength>MAX_ATTACHMENT)throw new AppError('Arquivo acima de 4 MB.',413);
 const type=sniff(body);
 if(!type)throw new AppError('Envie PDF, JPG ou PNG.',415);
 return await db().tx(async tx=>{
  // A linha da solicitação fica travada: dois envios no mesmo lugar não deixam dois arquivos "atuais".
  const r=await loadRequest(tx,a,params.get('request'),true);
  let quoteId:string|null=null;
  if(kind==='proposta'){
   const q=await tx.first('SELECT id FROM recovery_quotes WHERE id=? AND request_id=?',required(params.get('quote'),'Cotação',100),r.id);
   if(!q)throw new AppError('Cotação não encontrada nesta solicitação.',404);
   quoteId=q.id as string;
  }
  // Proposta (por cotação) e relatório assinado têm um arquivo atual; "outro" acumula.
  const previous=kind==='outro'?null:await tx.first('SELECT id FROM finance_attachments WHERE request_id=? AND kind=? AND quote_id IS NOT DISTINCT FROM ? AND replaced_by IS NULL',r.id,kind,quoteId);
  const aid=id();
  await tx.run('INSERT INTO finance_attachments(id,request_id,quote_id,kind,description,file_name,content_type,size_bytes,content,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
   aid,r.id,quoteId,kind,description,name,type,body.byteLength,Buffer.from(body.buffer,body.byteOffset,body.byteLength),now(),a.id,a.name);
  if(previous)await tx.run('UPDATE finance_attachments SET replaced_by=? WHERE id=?',aid,previous.id);
  await audit(tx,a,'Financeiro: anexo enviado',r.id,{number:r.number,kind,file:name,contentType:type,size:body.byteLength,replaced:previous?.id});
  return {id:aid,contentType:type,replaced:previous?.id||null,message:`${KINDS[kind]} anexado a ${recNumber(r.number)}${previous?' (o anterior ficou como substituído)':''}.`};
 });
}

export async function downloadAttachment(member:Member,attachmentId:string){
 const a=await requireAny(member,['financeiro']) as Actor;
 const f=await db().first<Row>('SELECT f.*,r.org_id,r.number FROM finance_attachments f JOIN recovery_requests r ON r.id=f.request_id WHERE f.id=?',required(attachmentId,'Anexo',100));
 if(!f||!inScope(a,f.org_id))throw new AppError('Anexo não encontrado ou fora do seu acesso.',404);
 await db().tx(tx=>audit(tx,a,'Exportação: anexo de recobrável',f.request_id,{number:f.number,attachment:f.id,file:f.file_name}));
 const content=Uint8Array.from(f.content as Uint8Array);
 return new Response(content,{headers:{
  'Content-Type':f.content_type,'Content-Length':String(content.byteLength),
  'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,
  'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store',
 }});
}
