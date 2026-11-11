'use client';
// Ferramentaria: peças compartilhadas pelas telas (nomes, números, envio com chave de idempotência e listas suspensas).
import {useEffect,useId,useRef,useState,type KeyboardEvent,type RefObject} from 'react';
import {ChevronDown,Search} from 'lucide-react';
import {Input} from '@/components/ui/input';
import {load,post,type R} from './kit';

export const KIND_NAMES:Record<string,string>={ferramenta:'Ferramenta',material:'Material'};
export const MOVE_NAMES:Record<string,string>={entrada:'Entrada',saida:'Saída',perda:'Perda',ajuste:'Ajuste',emprestimo:'Empréstimo',devolucao:'Devolução',contagem:'Contagem'};
export const REASONS:Record<string,string[]>={entrada:['Compra','Devolução','Transferência','Outro'],saida:['Consumo','Descarte','Transferência','Outro'],perda:['Extravio','Quebra','Desgaste','Outro'],ajuste:['Contagem','Correção de cadastro','Outro']};
export const PRESET_KEY='nautilus.tools.kind';
export const qtyText=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:3});
export const pl=(n:number,one:string,many:string)=>`${n} ${n===1?one:many}`;
export const num=(s:string)=>Number(String(s).trim().replace(/\./g,'').replace(',','.'));

/** Uma chave por tentativa: reenviar o MESMO conteúdo (duplo toque, rede) devolve o mesmo resultado; conteúdo novo ganha chave nova. */
export function useKey(){
 const ref=useRef<{id:string,body:string}|null>(null);
 if(ref.current==null)ref.current={id:crypto.randomUUID(),body:''};
 return {for:(body:unknown)=>{const c=ref.current as {id:string,body:string},t=JSON.stringify(body);if(c.body&&t!==c.body)c.id=crypto.randomUUID();c.body=t;return c.id;},renew:()=>{ref.current={id:crypto.randomUUID(),body:''};}};
}
export const tpost=(path:string,body:R,k:ReturnType<typeof useKey>)=>post(path,{...body,idempotencyKey:k.for(body)});

export type ComboOption={id:string,label:string,sub?:string};
/** Lista suspensa com busca: abre ao tocar (sem precisar digitar), filtra ao digitar, fecha ao escolher, ao tocar fora ou com Esc. */
export function Combo({value,onText,options,onPick,label,placeholder,note,onEnter,inputRef,search,disabled,autoFocus}:{value:string,onText:(v:string)=>void,options:ComboOption[],onPick:(o:ComboOption)=>void,
 label:string,placeholder?:string,note?:string,onEnter?:()=>void,inputRef?:RefObject<HTMLInputElement|null>,search?:boolean,disabled?:boolean,autoFocus?:boolean}){
 const [open,setOpen]=useState(false),[active,setActive]=useState(-1),box=useRef<HTMLDivElement>(null),own=useRef<HTMLInputElement>(null),listId=useId();
 const input=inputRef||own;
 const pick=(o:ComboOption)=>{onPick(o);setOpen(false);setActive(-1);};
 function key(e:KeyboardEvent<HTMLInputElement>){
  if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);setActive(a=>Math.min(options.length-1,a+1));}
  else if(e.key==='ArrowUp'){e.preventDefault();setActive(a=>Math.max(0,a-1));}
  else if(e.key==='Enter'){if(open&&options[active]){e.preventDefault();pick(options[active]);}else if(onEnter){e.preventDefault();onEnter();setOpen(false);}}
  else if(e.key==='Escape'||e.key==='Tab')setOpen(false);
 }
 return <div ref={box} className="tl-combo" onBlur={e=>{if(!box.current?.contains(e.relatedTarget as Node|null))setOpen(false)}}>
  <div className="tl-combo-field">{search&&<Search size={16} aria-hidden/>}
   <Input ref={input} value={value} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={label} placeholder={placeholder} autoComplete="off" disabled={disabled} autoFocus={autoFocus}
    aria-activedescendant={open&&active>=0?`${listId}-${active}`:undefined}
    onClick={()=>setOpen(true)} onFocus={()=>setOpen(true)} onChange={e=>{onText(e.target.value);setOpen(true);setActive(-1);}} onKeyDown={key}/>
   <button type="button" className="tl-combo-toggle" tabIndex={-1} disabled={disabled} aria-label={open?'Fechar a lista':'Abrir a lista'} onMouseDown={e=>e.preventDefault()} onClick={()=>{setOpen(o=>!o);input.current?.focus();}}><ChevronDown size={18}/></button>
  </div>
  {open&&<div className="tl-combo-pop">
   {options.length>0&&<ul id={listId} role="listbox" aria-label={label}>{options.map((o,i)=><li key={o.id}><button type="button" id={`${listId}-${i}`} role="option" aria-selected={i===active} tabIndex={-1} className={i===active?'on':''}
    onMouseDown={e=>e.preventDefault()} onClick={()=>pick(o)}><b>{o.label}</b>{o.sub&&<small>{o.sub}</small>}</button></li>)}</ul>}
   {note&&<p className="tl-combo-note">{note}</p>}
  </div>}
 </div>;
}

/** Escolha de item do estoque em lista suspensa. Com "available", só itens ativos com saldo (empréstimo, saída). */
export function ItemPicker({onPick,available,all,exclude=[],refreshKey,inputRef,autoFocus,label='Adicionar item'}:{onPick:(item:R)=>void,available?:boolean,all?:boolean,exclude?:string[],refreshKey?:unknown,inputRef?:RefObject<HTMLInputElement|null>,autoFocus?:boolean,label?:string}){
 const [q,setQ]=useState(''),[rows,setRows]=useState<R[]|null>(null),[more,setMore]=useState(false);
 useEffect(()=>{
  let stale=false;const p=new URLSearchParams({status:available?'available':all?'all':'active'});if(q.trim())p.set('q',q.trim());
  const t=setTimeout(()=>{load<R>('tools/items?'+p).then(d=>{if(!stale){setRows(d.rows as R[]);setMore(!!d.hasMore);}},()=>{if(!stale)setRows([]);})},q.trim()?220:0);
  return()=>{stale=true;clearTimeout(t);};
 },[q,available,all,refreshKey]);
 const list=(rows||[]).filter(i=>!exclude.includes(i.id));
 const options=list.map(i=>({id:i.id as string,label:i.name as string,sub:`${KIND_NAMES[i.kind]} · ${available?'disponível':'saldo'} ${qtyText(i.balance)} ${i.unitAbbr}${i.locationName?` · ${i.locationName}`:''}${i.code?` · ${i.code}`:''}${i.active?'':' · inativo'}`}));
 const choose=(id:string)=>{const it=list.find(i=>i.id===id);if(it){onPick(it);setQ('');}};
 const onEnter=()=>{const t=q.trim().toLowerCase(),exact=list.find(i=>i.code&&String(i.code).toLowerCase()===t);if(exact)choose(exact.id);else if(list.length===1)choose(list[0].id);};
 const note=rows===null?'Carregando…':!list.length?(q.trim()?`Nenhum item para “${q.trim()}”.`:available?'Nenhum item com saldo.':'Nenhum item cadastrado.'):more?'Mostrando os primeiros. Digite para filtrar.':undefined;
 return <Combo search value={q} onText={setQ} options={options} onPick={o=>choose(o.id)} onEnter={onEnter} note={note} inputRef={inputRef} autoFocus={autoFocus}
  label={label} placeholder="Toque para escolher ou digite"/>;
}

/** Nome de quem assina pelo solicitante: lista dos responsáveis cadastrados; nome novo também vale. */
export function PersonPicker({value,onChange,people,label}:{value:string,onChange:(v:string)=>void,people:string[],label:string}){
 const t=value.trim().toLowerCase(),opts=people.filter(p=>!t||p.toLowerCase().includes(t)||people.some(x=>x.toLowerCase()===t)).map(p=>({id:p,label:p}));
 const fresh=!!t&&!people.some(p=>p.toLowerCase()===t);
 return <Combo value={value} onText={onChange} options={opts} onPick={o=>onChange(o.label)} label={label} placeholder={people.length?'Toque para escolher ou digite o nome':'Digite o nome'}
  note={fresh?'Nome novo: entra no cadastro do solicitante.':!people.length?'Nenhum responsável cadastrado ainda.':undefined}/>;
}

/** Esc com a lista aberta fecha só a lista, não a janela. */
export const keepComboEsc=(e:globalThis.KeyboardEvent)=>{if((e.target as Element|null)?.closest?.('.tl-combo')?.querySelector('.tl-combo-pop'))e.preventDefault();};
