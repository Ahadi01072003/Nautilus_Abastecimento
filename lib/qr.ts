// QR code em SVG (um único path), para a tela, o download e o cartaz. Correção de erro "M" (15%).
import qrcode from 'qrcode-generator';

export function qrSvg(text:string,{margin=4,dark='#0b1d25',light='#ffffff'}:{margin?:number,dark?:string,light?:string}={}){
 const qr=qrcode(0,'M');qr.addData(text,'Byte');qr.make();
 const n=qr.getModuleCount(),size=n+margin*2;let d='';
 for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(qr.isDark(r,c))d+=`M${c+margin} ${r+margin}h1v1h-1z`;
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
