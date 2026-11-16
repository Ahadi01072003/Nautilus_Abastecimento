// CPF: dígitos verificadores, máscara e formato. Sem dependências: usado no servidor e na página pública.
export const cpfDigits=(v:unknown)=>String(v??'').replace(/\D/g,'');
export function validCpf(d:string){
 if(!/^\d{11}$/.test(d)||/^(\d)\1{10}$/.test(d))return false;
 const n=d.split('').map(Number);
 for(const len of [9,10]){const s=n.slice(0,len).reduce((t,x,i)=>t+x*(len+1-i),0);if((s*10)%11%10!==n[len])return false;}
 return true;
}
/** Lista: só o miolo aparece (***.456.789-**). */
export const maskCpf=(d:string)=>/^\d{11}$/.test(d)?`***.${d.slice(3,6)}.${d.slice(6,9)}-**`:'***';
export const formatCpf=(d:string)=>/^\d{11}$/.test(d)?`${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`:d;
/** Máscara enquanto digita: 000.000.000-00. */
export function typingCpf(v:string){
 const d=cpfDigits(v).slice(0,11);
 return d.replace(/^(\d{3})(\d)/,'$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/,'$1.$2.$3').replace(/\.(\d{3})(\d)/,'.$1-$2');
}
