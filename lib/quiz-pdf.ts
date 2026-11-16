// Avaliações · comprovante em PDF (A4), gerado no servidor com pdf-lib e fontes padrão (Helvetica).
// Texto fora do conjunto da fonte (emoji, setas) vira "?" para nunca quebrar a geração.
import {PDFDocument,StandardFonts,rgb,type PDFFont,type PDFPage} from 'pdf-lib';
import {DEFAULT_LOGO_PNG} from './quiz-logo';

export type CertificateData={title:string,body:string,footer:string,passed:boolean,validUntil:string|null,code:string,issuedAt:string,
 facts:[string,string][],logo:{bytes:Uint8Array,type:string}|null};

const INK=rgb(0.043,0.114,0.145),MUTED=rgb(0.29,0.37,0.4),LINE=rgb(0.78,0.82,0.81),GREEN=rgb(0.04,0.48,0.24),RED=rgb(0.71,0.14,0.09);
const W=595.28,H=841.89,M=56;
const DEFAULT_LOGO=Buffer.from(DEFAULT_LOGO_PNG,'base64');

function safeText(font:PDFFont){
 const ok=new Set(font.getCharacterSet());
 return (s:string)=>Array.from(String(s??'').replace(/\t/g,' ').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[–—]/g,'-')).map(ch=>ok.has(ch.codePointAt(0)!)?ch:'?').join('');
}
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
function draw(page:PDFPage,lines:string[],x:number,y:number,font:PDFFont,size:number,lead:number,color=INK){
 for(const l of lines){page.drawText(l,{x,y,size,font,color});y-=lead;}
 return y;
}

export async function certificatePdf(d:CertificateData):Promise<Uint8Array>{
 const pdf=await PDFDocument.create();
 pdf.setTitle(`${d.title} ${d.code}`);pdf.setProducer('NAUTILUS');pdf.setCreator('NAUTILUS · Avaliações');
 const page=pdf.addPage([W,H]);
 const font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),mono=await pdf.embedFont(StandardFonts.Courier);
 const t=safeText(font);
 // Logotipo (do modelo ou o padrão), até 180 × 54 pt.
 let top=H-M;
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
 top=draw(page,wrap(t(d.title),bold,22,W-2*M),M,top,bold,22,27);
 top-=8;
 top=draw(page,wrap(t(d.body),font,12,W-2*M),M,top,font,12,17.5);
 // Resultado em destaque.
 top-=18;
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
  page.drawText(t(k).toUpperCase(),{x:M,y:top-16,size:8,font:mono,color:MUTED});
  let y=top-16;for(const l of lines){page.drawText(l,{x:M+col,y,size:11,font,color:INK});y-=15;}
  top=y-6;
  page.drawRectangle({x:M,y:top,width:W-2*M,height:0.8,color:LINE});
 }
 // Rodapé.
 let fy=M+14;
 page.drawText(t(`Emitido em ${d.issuedAt} · Comprovante ${d.code} · NAUTILUS`),{x:M,y:M,size:8,font:mono,color:MUTED});
 if(d.footer.trim()){const lines=wrap(t(d.footer),font,9,W-2*M);fy+=(lines.length-1)*12;draw(page,lines,M,fy,font,9,12,MUTED);}
 return await pdf.save();
}
