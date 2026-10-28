'use client';
// Componentes compartilhados entre os módulos (Abastecimento, Planejamento e Cadastros gerais).
import {Component,ReactNode,useId,isValidElement,cloneElement} from 'react';
import {ClipboardList,AlertTriangle} from 'lucide-react';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {Checkbox} from '@/components/ui/checkbox';
import {Switch} from '@/components/ui/switch';
import {Button} from '@/components/ui/button';
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
export const fmt=(s:string,short=false)=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',...(short?{}:{year:'numeric',hour:'2-digit',minute:'2-digit'})}).format(new Date(s)).replace(',','');
/** Unidade no singular quando a quantidade é 1 (1 cilindro, 2 cilindros); siglas (L, kg, m³) não mudam. */
/** Período numa linha só: "24/10/2026 07:00 → 14:00" no mesmo dia; data nas duas pontas quando
 * muda o dia; "→ em curso" sem fim. Usado em listas e cabeçalhos (início e fim lado a lado). */
export function periodText(a?:string|null,b?:string|null,open='em curso'){
 if(!a)return '—';
 // Ano corrente fica implícito (mais curto); outro ano aparece por extenso.
 const year=String(new Date().getFullYear()),short=(v:string)=>v.slice(6,10)===year?v.slice(0,5)+v.slice(10):v;
 const x=fmt(a);if(!b)return `${short(x)} → ${open}`;
 const y=fmt(b);return x.slice(0,10)===y.slice(0,10)?`${short(x)} → ${y.slice(11)}`:`${short(x)} → ${short(y)}`;
}
export function Period({a,b,open}:{a?:string|null,b?:string|null,open?:string}){return <span className="period-line" title={a?`${fmt(a)} → ${b?fmt(b):open||'em curso'}`:undefined}>{periodText(a,b,open)}</span>}
export const unitFor=(n:number,unit:string)=>Math.abs(n)===1&&/^[a-zà-ú]{4,}s$/i.test(unit)?unit.slice(0,-1):unit;
export async function post(path:string,body:R){const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j:R=await r.json().catch(()=>({}));if(r.status===401){window.location.reload();throw new Error('Sua sessão expirou. Entre novamente.')}if(!r.ok)throw new Error(j.error||'Não foi possível salvar.');return j}
export async function load<T>(path:string):Promise<T>{const r=await fetch('/api/'+path,{cache:'no-store'});const j=await r.json().catch(()=>({error:'Não foi possível carregar.'}));if(r.status===401){window.location.reload();throw new Error('Sua sessão expirou.')}if(!r.ok)throw new Error(j.error||'Não foi possível carregar.');return j as T}
/** Unidades de medida sugeridas (o campo aceita outras). */
/** Limite visual de descrições em listas (≈ mediana das descrições em uso); o texto completo fica no detalhe e na dica. */
export const DESCRIPTION_LIMIT=90;
export const clip=(value:string|null|undefined,limit=DESCRIPTION_LIMIT)=>{const s=(value||'').replace(/\s+/g,' ').trim();return s.length>limit?s.slice(0,limit-1).trimEnd()+'…':s;};
/** Campo datetime-local ↔ instante, no horário de Brasília (UTC−3, sem horário de verão). Nunca
 * lança exceção: data fora do formato vira '' (ida) ou null (volta); o ano fica com 4 dígitos. */
export const BR_OFFSET=3*3600_000;
const LOCAL=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
export const toLocalInput=(iso?:string|null)=>{const t=iso?Date.parse(iso):NaN;if(!Number.isFinite(t))return '';const d=new Date(t-BR_OFFSET),y=d.getUTCFullYear();if(y<0||y>9999)return '';const p=(n:number)=>String(n).padStart(2,'0');return `${String(y).padStart(4,'0')}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;};
export const fromLocalInput=(local:string)=>{if(!local||!LOCAL.test(local))return null;const t=Date.parse(local+':00-03:00');return Number.isFinite(t)?new Date(t).toISOString():null;};
/** Ano aceito nas datas da operação (o servidor confere a mesma faixa). */
export const YEAR_MIN=2000,YEAR_MAX=2100;
export const INPUT_MIN=`${YEAR_MIN}-01-01T00:00`,INPUT_MAX=`${YEAR_MAX}-12-31T23:59`;
/** Problema de um campo datetime-local já preenchido ('' quando está tudo certo ou vazio). */
export const localIssue=(local:string)=>{if(!local)return '';const m=LOCAL.exec(local);if(!m||!fromLocalInput(local))return 'Data inválida: confira dia, mês, ano e hora.';const y=Number(m[1]);return y<YEAR_MIN||y>YEAR_MAX?`Ano ${y} fora da faixa aceita (${YEAR_MIN} a ${YEAR_MAX}).`:'';};
export const UNITS=['un','pç','cx','kg','t','g','L','mL','m','m²','m³','h','jogo','par','rolo'];

/** Erro inesperado numa tela: só aquele módulo mostra o aviso (menu e sessão continuam) e dá para
 * tentar de novo ou voltar, sem recarregar a página. A troca de tela (key) zera o erro. */
export class ModuleBoundary extends Component<{children:ReactNode,onBack?:()=>void},{error:Error|null}>{
 state={error:null as Error|null};
 static getDerivedStateFromError(error:Error){return {error};}
 componentDidCatch(error:Error){console.error(error);}
 render(){
  if(!this.state.error)return this.props.children;
  return <div className="error-panel" role="alert"><AlertTriangle/><h2>Esta tela encontrou um erro inesperado</h2><p>Nada do que já estava salvo foi perdido. Tente abrir de novo; se o erro voltar, avise o gestor com o horário ({new Date().toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'})}).</p>
   <div className="access-actions"><Button onClick={()=>this.setState({error:null})}>Tentar de novo</Button>{this.props.onBack&&<Button variant="outline" onClick={()=>{this.setState({error:null});this.props.onBack!();}}>Voltar</Button>}</div></div>;
 }
}
