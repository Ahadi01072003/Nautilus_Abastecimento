export class AppError extends Error { constructor(message:string,public status=400){super(message)} }
export function text(value:unknown,max=250){const s=String(value??'').trim();if(s.length>max)throw new AppError(`Texto deve ter até ${max} caracteres.`);return s;}
export function required(value:unknown,label:string,max=250){const s=text(value,max);if(!s)throw new AppError(`${label} é obrigatório.`);return s;}
export function email(value:unknown,optional=false){const s=text(value,254).toLowerCase();if(optional&&!s)return '';if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))throw new AppError('Informe um e-mail válido.');return s;}
export function milli(value:unknown,integral=false,allowZero=false){
 if(typeof value!=='number'||!Number.isFinite(value)||value<(allowZero?0:0.001)||value>100000000)throw new AppError('Informe uma quantidade válida.');
 const q=Math.round(value*1000);if(Math.abs(value*1000-q)>0.00001)throw new AppError('Use no máximo três casas decimais.');
 if(integral&&q%1000!==0)throw new AppError('Cilindros e unidades inteiras não aceitam frações.');return q;
}
export function dateISO(value:unknown){const s=required(value,'Data');const d=new Date(s);if(!Number.isFinite(d.valueOf()))throw new AppError('Data inválida.');if(d.valueOf()>Date.now()+60000)throw new AppError('O abastecimento não pode estar no futuro.');return d.toISOString();}
export function businessDeadline(iso:string,days:number,holidays:string[]=[]){
 const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(iso)).split(' ');
 const d=new Date(parts[0]+'T12:00:00Z');let count=0;
 while(count<days){d.setUTCDate(d.getUTCDate()+1);const key=d.toISOString().slice(0,10);if(d.getUTCDay()!==0&&d.getUTCDay()!==6&&!holidays.includes(key))count++;}
 return new Date(d.toISOString().slice(0,10)+'T'+parts[1]+'-03:00').toISOString();
}
export function safeCSV(value:unknown){let v=String(value??'');if(typeof value==='string'&&/^[\s]*[=+@-]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';}
/** Data civil AAAA-MM-DD válida (rejeita 2026-02-30 e similares). */
export function isoDay(value:unknown){const s=required(value,'Data',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw new AppError('Data inválida.');const [y,m,d]=s.split('-').map(Number);const date=new Date(Date.UTC(y,m-1,d));if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d)throw new AppError('Data inválida.');return s;}
