'use client';
import {useEffect} from 'react';
/** Botão de impressão; com ?imprimir=1 abre a janela de impressão quando as fontes carregam. */
export default function PortariaPrint({auto}:{auto:boolean}){
 useEffect(()=>{if(!auto)return;let done=false;const go=()=>{if(!done){done=true;window.print();}};document.fonts?.ready.then(()=>setTimeout(go,250)).catch(go);const t=setTimeout(go,2500);return()=>clearTimeout(t)},[auto]);
 return <div className="noprint"><button type="button" onClick={()=>window.print()}>Imprimir</button><small>Papel A4 retrato. O documento aparece completo nesta impressão: guarde com cuidado.</small></div>;
}
