'use client';
// Exportar a agenda de recursos em PDF (A4 paisagem): período em datas e a mesma seleção da tela
// (tipos separados ou juntos e recursos específicos). Abre /agenda/recursos, que consulta de novo
// com os filtros da lista e confere o acesso no servidor.
import {useState,type FormEvent} from 'react';
import {FileDown,ClipboardCheck} from 'lucide-react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Field} from './kit';
import {ResourcePick} from './resource-agenda';
import {resourceParams,type Alloc,type ResKind} from '@/lib/resource-agenda';

export const RES_MAX_DAYS=92;
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
const plusDays=(iso:string,n:number)=>new Date(Date.parse(iso+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const daysBetween=(a:string,b:string)=>a&&b?Math.round((Date.parse(b)-Date.parse(a))/86400000)+1:0;
export function periodError(from:string,to:string){
 if(!from||!to)return '';
 if(to<from)return 'A data de fim deve ser igual ou posterior à de início.';
 return daysBetween(from,to)>RES_MAX_DAYS?`Escolha um período de até ${RES_MAX_DAYS} dias.`:'';
}
/** Endereço do PDF: filtros da origem + período + tipos e recursos escolhidos. */
export function resourcePdfUrl(base:URLSearchParams,from:string,to:string,kinds:ResKind[],picked:string[]){
 const q=new URLSearchParams(base);q.set('inicio',from);q.set('fim',to);
 for(const [k,v] of resourceParams(kinds,picked))q.set(k,v);
 q.set('imprimir','1');return '/agenda/recursos?'+q.toString();
}
/** Esc com a lista de recursos aberta fecha só a lista, não o diálogo. */
export const keepOpenForPick=(e:KeyboardEvent)=>{if(document.querySelector('[role=dialog] .mpick[open]'))e.preventDefault();};
export function openPdf(url:string){const w=window.open(url,'_blank');if(w)w.opener=null;else window.open(url,'_self');}
export const pickSummary=(kinds:ResKind[],picked:string[])=>`${kinds.length===3?'todos os tipos':kinds.map(k=>({equipamento:'equipamentos',funcao:'funções',material:'materiais'})[k]).join(' e ')} · ${picked.length?`${picked.length} recurso(s) escolhido(s)`:'todos os recursos'}`;

export default function ResourceExportDialog({allocs,initial,base,onClose}:{allocs:Alloc[],initial:{kinds:ResKind[],picked:string[],period:{from:string,to:string}},base:URLSearchParams,onClose:()=>void}){
 const start=initial.period.from.slice(0,10)||today();
 const [from,setFrom]=useState(start),[to,setTo]=useState(initial.period.to.slice(0,10)||plusDays(start,6));
 const [kinds,setKinds]=useState<ResKind[]>(initial.kinds),[picked,setPicked]=useState<string[]>(initial.picked);
 const error=periodError(from,to),ready=!!from&&!!to&&!error;
 function submit(e:FormEvent){e.preventDefault();if(!ready)return;openPdf(resourcePdfUrl(base,from,to,kinds,picked));onClose();}
 return <Dialog open onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="n-dialog" onEscapeKeyDown={keepOpenForPick}><DialogHeader><div className="modal-eyebrow"><FileDown size={16}/> Planejamento · Lista de OS programadas</div><DialogTitle>Exportar agenda de recursos</DialogTitle>
  <DialogDescription>PDF (A4 paisagem) com uma linha por recurso no eixo das datas e, em seguida, o detalhe de cada alocação. Usa as OS da lista com os filtros atuais.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><div className="form-grid">
   <Field label="Data de início *"><Input type="date" required value={from} max={to||undefined} onChange={e=>setFrom(e.target.value)}/></Field>
   <Field label="Data de fim *"><Input type="date" required value={to} min={from||undefined} onChange={e=>setTo(e.target.value)}/></Field>
   <div className="n-field wide"><label>Recursos</label><div className="ra-pick"><ResourcePick allocs={allocs} kinds={kinds} picked={picked} onKinds={setKinds} onPicked={setPicked}/></div></div>
   {ready&&<p className="wide notice"><ClipboardCheck size={16}/> {daysBetween(from,to)} dia(s) · {pickSummary(kinds,picked)}. A janela de impressão abre em seguida: escolha “Salvar como PDF”.</p>}
  </div>{error&&<div className="form-error" role="alert">{error}</div>}
  <div className="modal-footer"><Button type="button" variant="outline" onClick={onClose}>Voltar</Button><Button type="submit" className="primary-action" disabled={!ready}><FileDown size={16}/> Exportar em PDF</Button></div></form>
 </DialogContent></Dialog>;
}
