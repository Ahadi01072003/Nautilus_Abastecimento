// Avaliações · comprovante em PDF (A4), gerado no servidor com pdf-lib e fontes padrão (Helvetica).
// Texto fora do conjunto da fonte (emoji, setas) vira "?" para nunca quebrar a geração. Com as respostas,
// cada pergunta mostra o que a pessoa marcou e se acertou (sem a resposta certa), em quantas páginas precisar.
import {PDFDocument,StandardFonts,rgb,type PDFFont,type PDFPage} from 'pdf-lib';
import {DEFAULT_LOGO_PNG} from './quiz-logo';

export type CertificateAnswer={text:string,answer:string|null,result:'certa'|'errada'|'livre'};
export type CertificateData={title:string,body:string,footer:string,passed:boolean,validUntil:string|null,code:string,issuedAt:string,
 facts:[string,string][],logo:{bytes:Uint8Array,type:string}|null,syllabus?:string,answers?:CertificateAnswer[]};

const INK=rgb(0.043,0.114,0.145),MUTED=rgb(0.29,0.37,0.4),LINE=rgb(0.78,0.82,0.81),GREEN=rgb(0.04,0.48,0.24),RED=rgb(0.71,0.14,0.09);
const W=595.28,H=841.89,M=56;
const DEFAULT_LOGO=Buffer.from(DEFAULT_LOGO_PNG,'base64');

/** Troca o que a fonte não tem por "?"; quebras de linha passam (o texto é quebrado em linhas depois). */
export function sanitizeFor(ok:Set<number>){
 return (s:string)=>Array.from(String(s??'').replace(/\r\n?/g,'\n').replace(/\t/g,' ').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[–—]/g,'-').replace(/‑/g,'-')).map(ch=>ch==='\n'||ok.has(ch.codePointAt(0)!)?ch:'?').join('');
}
const safeText=(font:PDFFont)=>sanitizeFor(new Set(font.getCharacterSet()));
/** Quebra o texto em linhas que cabem na largura (respeita parágrafos). */
function wrap(text:string,font:PDFFont,size:number,width:number){
 const lines:string[]=[];
 for(const para of text.split(/\r?\n/)){
  if(!para.trim()){lines.push('');continue;}
  let line='';
  for(const word of para.split(/\s+/)){
   const next=line?line+' '+word:word;
   if(font.widthOfTextAtSize(next,size)<=width){line=next;continue;}
   if(line)lines.push(line);
   // Palavra maior que a linha: corta.
   let w=word;while(font.widthOfTextAtSize(w,size)>width){let i=w.length;while(i>1&&font.widthOfTextAtSize(w.slice(0,i),size)>width)i--;lines.push(w.slice(0,i));w=w.slice(i);}
   line=w;
  }
  lines.push(line);
 }
 return lines;
}

export async function certificatePdf(d:CertificateData):Promise<Uint8Array>{
 const pdf=await PDFDocument.create();
 pdf.setTitle(`${d.title} ${d.code}`);pdf.setProducer('NAUTILUS');pdf.setCreator('NAUTILUS · Avaliações');
 const font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),mono=await pdf.embedFont(StandardFonts.Courier);
 const t=safeText(font);
 // O rodapé ocupa o pé de todas as páginas; o conteúdo para acima dele.
 const footer=d.footer.trim()?wrap(t(d.footer),font,9,W-2*M):[],BOTTOM=M+22+footer.length*12;
 let page:PDFPage=pdf.addPage([W,H]);
 let top=H-M;
 /** Garante espaço para um bloco; sem espaço, continua numa página nova (com o código no topo). */
 const room=(h:number)=>{
  if(top-h>=BOTTOM)return;
  page=pdf.addPage([W,H]);top=H-M;
  page.drawText(t(`${d.title} · ${d.code} (continuação)`),{x:M,y:top-8,size:8,font:mono,color:MUTED});
  top-=26;
 };
 // Logotipo (do modelo ou o padrão), até 180 × 54 pt.
 try{
  const img=d.logo?(d.logo.type==='image/jpeg'?await pdf.embedJpg(d.logo.bytes):await pdf.embedPng(d.logo.bytes)):await pdf.embedPng(DEFAULT_LOGO);
  const s=Math.min(180/img.width,54/img.height);
  page.drawImage(img,{x:M,y:top-img.height*s,width:img.width*s,height:img.height*s});
 }catch{/* logotipo inválido: segue sem ele */}
 const label='COMPROVANTE',lw=mono.widthOfTextAtSize(label,8);
 page.drawText(label,{x:W-M-lw,y:top-10,size:8,font:mono,color:MUTED});
 const cw=bold.widthOfTextAtSize(d.code,20);
 page.drawText(d.code,{x:W-M-cw,y:top-34,size:20,font:bold,color:INK});
 top-=70;
 page.drawRectangle({x:M,y:top,width:W-2*M,height:2.5,color:INK});
 top-=38;
 for(const l of wrap(t(d.title),bold,22,W-2*M)){page.drawText(l,{x:M,y:top,size:22,font:bold,color:INK});top-=27;}
 top-=8;
 for(const l of wrap(t(d.body),font,12,W-2*M)){room(18);page.drawText(l,{x:M,y:top,size:12,font,color:INK});top-=17.5;}
 // Resultado em destaque.
 top-=18;room(40);
 const res=d.passed?'APROVADO':'REPROVADO',color=d.passed?GREEN:RED,rw=bold.widthOfTextAtSize(res,15)+28;
 page.drawRectangle({x:M,y:top-30,width:rw,height:30,borderColor:color,borderWidth:1.6,color:rgb(1,1,1)});
 page.drawText(res,{x:M+14,y:top-20.5,size:15,font:bold,color});
 if(d.passed&&d.validUntil)page.drawText(t(`Válida até ${d.validUntil}`),{x:M+rw+14,y:top-20,size:13,font:bold,color:INK});
 top-=54;
 // Dados da avaliação.
 const col=150;
 page.drawRectangle({x:M,y:top,width:W-2*M,height:0.8,color:LINE});
 for(const [k,v] of d.facts){
  const lines=wrap(t(v||'—'),font,11,W-2*M-col);
  room(lines.length*15+12);
  page.drawText(t(k).toUpperCase(),{x:M,y:top-16,size:8,font:mono,color:MUTED});
  let y=top-16;for(const l of lines){page.drawText(l,{x:M+col,y,size:11,font,color:INK});y-=15;}
  top=y-6;
  page.drawRectangle({x:M,y:top,width:W-2*M,height:0.8,color:LINE});
 }
 // Conteúdo programático da versão respondida.
 if(d.syllabus?.trim()){
  top-=26;room(50);
  page.drawText(t('CONTEÚDO PROGRAMÁTICO'),{x:M,y:top,size:9,font:mono,color:MUTED});
  top-=18;
  for(const l of wrap(t(d.syllabus.trim()),font,10.5,W-2*M)){room(15);page.drawText(l,{x:M,y:top,size:10.5,font,color:INK});top-=14.5;}
 }
 // Perguntas e respostas: o que a pessoa marcou e se acertou (a resposta certa não aparece).
 if(d.answers?.length){
  top-=26;room(60);
  page.drawText('PERGUNTAS E RESPOSTAS',{x:M,y:top,size:9,font:mono,color:MUTED});
  top-=10;
  const tagW=62,textW=W-2*M-tagW-10;
  d.answers.forEach((x,i)=>{
   const q=wrap(t(`${i+1}. ${x.text}`),bold,10.5,textW),a=wrap(t(`Resposta: ${x.answer||'sem resposta'}`),font,10,textW);
   room(q.length*14+a.length*13+16);
   page.drawRectangle({x:M,y:top,width:W-2*M,height:0.6,color:LINE});
   let y=top-15;
   for(const l of q){page.drawText(l,{x:M,y,size:10.5,font:bold,color:INK});y-=14;}
   for(const l of a){page.drawText(l,{x:M,y,size:10,font,color:MUTED});y-=13;}
   const tag=x.result==='certa'?'CERTA':x.result==='errada'?'ERRADA':'SEM NOTA',tc=x.result==='certa'?GREEN:x.result==='errada'?RED:MUTED;
   page.drawText(tag,{x:W-M-bold.widthOfTextAtSize(tag,9),y:top-15,size:9,font:bold,color:tc});
   top=y-3;
  });
  page.drawRectangle({x:M,y:top,width:W-2*M,height:0.6,color:LINE});
 }
 // Rodapé em todas as páginas.
 const pages=pdf.getPages();
 pages.forEach((p,i)=>{
  p.drawText(t(`Emitido em ${d.issuedAt} · Comprovante ${d.code} · NAUTILUS${pages.length>1?` · página ${i+1} de ${pages.length}`:''}`),{x:M,y:M,size:8,font:mono,color:MUTED});
  let fy=M+14+(footer.length-1)*12;for(const l of footer){p.drawText(l,{x:M,y:fy,size:9,font,color:MUTED});fy-=12;}
 });
 return await pdf.save();
}
