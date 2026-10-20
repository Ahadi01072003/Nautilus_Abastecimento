'use client';
export default function PrintButton(){
 return <button type="button" className="noprint" onClick={()=>window.print()}>Imprimir ou salvar em PDF</button>;
}
