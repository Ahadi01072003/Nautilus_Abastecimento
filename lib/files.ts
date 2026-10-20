import {deflateRawSync} from 'node:zlib';

/** Gera arquivos .zip e .xlsx sem dependências externas (menos superfície de ataque). */
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(buf:Uint8Array){let c=0xffffffff;for(let i=0;i<buf.length;i++)c=CRC[(c^buf[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}

export function zip(files:{name:string;data:string|Uint8Array}[],date=new Date()){
 const dosTime=((date.getHours()<<11)|(date.getMinutes()<<5)|Math.floor(date.getSeconds()/2))&0xffff;
 const dosDate=(((date.getFullYear()-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate())&0xffff;
 const chunks:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const f of files){
  const name=Buffer.from(f.name,'utf8'),raw=typeof f.data==='string'?Buffer.from(f.data,'utf8'):Buffer.from(f.data);
  const body=deflateRawSync(raw,{level:6}),crc=crc32(raw);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);
  local.writeUInt16LE(dosTime,10);local.writeUInt16LE(dosDate,12);local.writeUInt32LE(crc,14);
  local.writeUInt32LE(body.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(0,28);
  chunks.push(local,name,body);
  const dir=Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50,0);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x0800,8);dir.writeUInt16LE(8,10);
  dir.writeUInt16LE(dosTime,12);dir.writeUInt16LE(dosDate,14);dir.writeUInt32LE(crc,16);dir.writeUInt32LE(body.length,20);
  dir.writeUInt32LE(raw.length,24);dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(offset,42);
  central.push(dir,name);
  offset+=30+name.length+body.length;
 }
 const size=central.reduce((t,b)=>t+b.length,0),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...chunks,...central,end]);
}

export type Cell=string|number|null|undefined|Date;
export type Sheet={name:string;columns:string[];rows:Cell[][];total?:number};

// Caracteres de controle não são permitidos em XML 1.0.
const xml=(s:string)=>s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const colName=(i:number)=>{let s='';i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;};
/** Datas viram texto no horário de Brasília (dd/mm/aaaa hh:mm): legível e sem fuso ambíguo. */
export const brDateTime=(d:Date)=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d).replace(',','');

/** Texto sempre como string literal (inlineStr): fórmulas nunca são interpretadas. */
export function xlsx(sheets:Sheet[]){
 const names=new Set<string>();
 const safe=sheets.map((s,i)=>{let n=s.name.replace(/[[\]:*?/\\]/g,' ').slice(0,31)||`Planilha ${i+1}`;while(names.has(n))n=(n.slice(0,28)+' '+i);names.add(n);return {...s,name:n};});
 const sheetXml=(s:Sheet)=>{
  const row=(cells:Cell[],r:number,header=false)=>`<row r="${r}">${cells.map((v,c)=>{
   const ref=colName(c)+r;
   if(v===null||v===undefined||v==='')return '';
   if(typeof v==='number'&&Number.isFinite(v))return `<c r="${ref}"${header?' s="1"':''}><v>${v}</v></c>`;
   const str=v instanceof Date?brDateTime(v):String(v);
   return `<c r="${ref}" t="inlineStr"${header?' s="1"':''}><is><t xml:space="preserve">${xml(str.slice(0,32000))}</t></is></c>`;
  }).join('')}</row>`;
  const widths=s.columns.map((c,i)=>Math.min(60,Math.max(c.length,...s.rows.slice(0,200).map(r=>String(r[i]??'').length))+2));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${row(s.columns,1,true)}${s.rows.map((r,i)=>row(r,i+2)).join('')}</sheetData>${s.rows.length?`<autoFilter ref="A1:${colName(s.columns.length-1)}${s.rows.length+1}"/>`:''}</worksheet>`;
 };
 const files=[
  {name:'[Content_Types].xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`},
  {name:'_rels/.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
  {name:'xl/workbook.xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`},
  {name:'xl/_rels/workbook.xml.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${safe.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
  {name:'xl/styles.xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF03161F"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`},
  ...safe.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:sheetXml(s)})),
 ];
 return zip(files);
}

/** CSV com ";" (padrão do Excel em pt-BR) e neutralização de fórmulas (=, +, -, @, tab, CR). */
export function csv(sheet:Sheet){
 const cell=(v:Cell)=>{
  if(v===null||v===undefined)return '';
  if(typeof v==='number')return String(v).replace('.',',');
  let s=v instanceof Date?brDateTime(v):String(v);
  if(/^\s*[=+\-@]|^[\t\r]/.test(s))s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
 };
 return '﻿'+[sheet.columns,...sheet.rows].map(r=>r.map(cell).join(';')).join('\r\n');
}
