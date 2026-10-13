'use client';
// Componentes compartilhados entre os módulos (Abastecimento, Planejamento e Cadastros gerais).
import {ReactNode,useId,isValidElement,cloneElement} from 'react';
import {ClipboardList} from 'lucide-react';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {Checkbox} from '@/components/ui/checkbox';
import {Switch} from '@/components/ui/switch';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dados de tabelas e formulários heterogêneos; autorização e validação ficam no servidor.
export type R=Record<string,any>;
export type Option={value:string,label:string};

export function Choice({value,onChange,options,label,placeholder='Selecione',disabled=false}:{value:string,onChange:(v:string)=>void,options:Option[],label?:string,placeholder?:string,disabled?:boolean}){return <Select disabled={disabled} value={value||undefined} onValueChange={onChange}><SelectTrigger className="choice" aria-label={label||placeholder}><SelectValue placeholder={placeholder}/></SelectTrigger><SelectContent>{options.map(o=><SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>}
export function Badge({children,tone='muted'}:{children:ReactNode,tone?:string}){return <span className={`n-badge ${tone}`}>{children}</span>}
export function Empty({icon:Icon=ClipboardList,title,description,action}:{icon?:React.ComponentType<{size?:number}>,title:string,description?:string,action?:ReactNode}){return <div className="n-empty"><span><Icon size={26}/></span><h3>{title}</h3>{description&&<p>{description}</p>}{action}</div>}
export function Field({label,children,hint,wide=false}:{label:string,children:ReactNode,hint?:string,wide?:boolean}){const fieldId=useId();const child=isValidElement(children)?cloneElement(children as React.ReactElement<Record<string,unknown>>,{id:fieldId,'aria-label':label,...(children.type===Choice?{label}:{})}):children;return <div className={`n-field ${wide?'wide':''}`}><label htmlFor={fieldId}>{label}</label>{child}{hint&&<small>{hint}</small>}</div>}
/** Grupo de caixas de seleção com rótulo visível (fieldset acessível). */
export function MultiCheck({label,options,value,onChange,hint,empty='Nenhuma opção cadastrada.'}:{label:string,options:Option[],value:string[],onChange:(v:string[])=>void,hint?:string,empty?:string}){return <fieldset className="n-field wide"><legend>{label}</legend>{options.length?<div className="checkbox-options">{options.map(o=><label key={o.value}><Checkbox checked={value.includes(o.value)} onCheckedChange={v=>onChange(v?[...value,o.value]:value.filter(x=>x!==o.value))}/>{o.label}</label>)}</div>:<small>{empty}</small>}{hint&&<small>{hint}</small>}</fieldset>}
export function Toggle({title,description,checked,onChange}:{title:string,description?:string,checked:boolean,onChange:(v:boolean)=>void}){const id=useId();return <div className="switch-field wide"><div><b id={id}>{title}</b>{description&&<small>{description}</small>}</div><Switch aria-labelledby={id} checked={checked} onCheckedChange={onChange}/></div>}
/** Etiqueta do solicitante: texto + cor, com contraste calculado (WCAG). */
export function OrgTag({org}:{org?:R|null}){if(!org)return <span className="pending-text">Sem organização</span>;const hex=org.color.replace('#','');const [r,g,b]=[0,2,4].map(i=>{const c=parseInt(hex.slice(i,i+2),16)/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4});const light=0.2126*r+0.7152*g+0.0722*b>0.179;return <span className="org-tag" style={{background:org.color,color:light?'#071d2b':'#fff'}} title={org.name}>{org.acronym}<small>{org.name}</small></span>}
export const fmt=(s:string,short=false)=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',...(short?{}:{year:'numeric',hour:'2-digit',minute:'2-digit'})}).format(new Date(s));
export async function post(path:string,body:R){const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j:R=await r.json().catch(()=>({}));if(r.status===401){window.location.reload();throw new Error('Sua sessão expirou. Entre novamente.')}if(!r.ok)throw new Error(j.error||'Não foi possível salvar.');return j}
export async function load<T>(path:string):Promise<T>{const r=await fetch('/api/'+path,{cache:'no-store'});const j=await r.json().catch(()=>({error:'Não foi possível carregar.'}));if(r.status===401){window.location.reload();throw new Error('Sua sessão expirou.')}if(!r.ok)throw new Error(j.error||'Não foi possível carregar.');return j as T}
