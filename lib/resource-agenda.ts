// Agenda de recursos: UMA regra para a tela (Lista de OS › Agenda de recursos), o PDF
// (/agenda/recursos) e os filtros de recurso. Recebe as alocações já consultadas (lib/planning
// ordersResources) e devolve as linhas por recurso, na ordem de exibição. Sem banco nem tela.

export type ResKind='equipamento'|'funcao'|'material';
export const RES_KINDS:{id:ResKind,label:string,one:string}[]=[
 {id:'equipamento',label:'Equipamentos',one:'Equipamento'},
 {id:'funcao',label:'Funções',one:'Função'},
 {id:'material',label:'Materiais',one:'Material'},
];
export const ALL_KINDS:ResKind[]=RES_KINDS.map(k=>k.id);
export type Alloc={kind:ResKind,key:string,label:string,sub?:string|null,start:string,end:string,step?:string|null,quantity:number,unit?:string|null,
 orderId:string,number:number,activity:string,status:string,orgId:string,sector:string|null};
/** Onde fica o texto da alocação: dentro da barra ou numa etiqueta ao lado dela. */
export type Side='in'|'right'|'left';
export type ResItem=Alloc&{a:number,b:number,lane:number,side:Side};
export type ResRow={id:string,kind:ResKind,label:string,sub:string,unit:string|null,items:ResItem[],lanes:number,hours:number,total:number|null,orders:number};

/** Identificador do recurso na seleção (tipo + chave): "equipamento:<id>", "material:<id>|t". */
export const resId=(a:{kind:string,key:string})=>a.kind+':'+a.key;
const ms=(v:string)=>{const t=Date.parse(v);return Number.isFinite(t)?t:null;};

/** Recursos dos tipos marcados (para o seletor), em ordem alfabética dentro de cada tipo. */
export function resourceOptions(allocs:Alloc[],kinds:ResKind[]){
 const m=new Map<string,{value:string,label:string,kind:ResKind}>();
 for(const a of allocs)if(kinds.includes(a.kind)&&!m.has(resId(a)))m.set(resId(a),{value:resId(a),label:`${RES_KINDS.find(k=>k.id===a.kind)!.one}: ${a.label}`,kind:a.kind});
 return [...m.values()].sort((x,y)=>ALL_KINDS.indexOf(x.kind)-ALL_KINDS.indexOf(y.kind)||x.label.localeCompare(y.label,'pt-BR'));
}

/** Linhas da agenda: uma por recurso, agrupadas por tipo (equipamentos → funções → materiais). Sem
 * seleção de recursos, entram todos os dos tipos marcados. Alocação sem datas válidas fica de fora. */
export function resourceRows(allocs:Alloc[],kinds:ResKind[],picked:string[]=[]):ResRow[]{
 const by=new Map<string,ResRow>();
 for(const x of allocs){
  if(!kinds.includes(x.kind)||(picked.length&&!picked.includes(resId(x))))continue;
  const a=ms(x.start),b=ms(x.end);if(a==null||b==null||b<a)continue;
  const id=resId(x);
  const r=by.get(id)||{id,kind:x.kind,label:x.label,sub:x.sub||'',unit:x.unit||null,items:[],lanes:1,hours:0,total:null,orders:0};
  r.items.push({...x,a,b,lane:0,side:'in'});by.set(id,r);
 }
 const rows=[...by.values()];
 for(const r of rows){
  r.items.sort((p,q)=>p.a-q.a||p.b-q.b||p.number-q.number);
  r.hours=r.items.reduce((n,i)=>n+(i.b-i.a)/3600_000,0);
  r.total=r.kind==='material'?r.items.reduce((n,i)=>n+Number(i.quantity||0),0):null;
  r.orders=new Set(r.items.map(i=>i.orderId)).size;
 }
 return ALL_KINDS.flatMap(k=>rows.filter(r=>r.kind===k).sort((p,q)=>p.label.localeCompare(q.label,'pt-BR')));
}

/** A barra fica SEMPRE no período exato (nunca alongada para caber o texto): em qualquer zoom, o
 * começo e o fim batem com o calendário. O texto vai dentro quando cabe; quando não, numa etiqueta
 * ao lado: à direita, ou à esquerda se passar da borda `limit`. `lo` é a borda esquerda à vista
 * (barra que começa antes do período conta só o trecho visível). Mesma unidade em tudo (px ou mm). */
export function labelSide(l:number,r:number,label:number,gap:number,limit=Infinity,lo=-Infinity):Side{
 const vl=Math.max(l,lo);
 if(r-vl>=label)return 'in';
 return r+gap+label<=limit||vl-gap-label<lo?'right':'left';
}

/** Faixas pela extensão DESENHADA (barra exata + etiqueta ao lado quando o texto não cabe): duas
 * alocações curtas e próximas nunca se sobrepõem, nem o texto delas. `x` converte instante em posição
 * (px ou mm) e `label`/`gap` usam a mesma unidade. Grava a faixa e o lado do texto em cada item e
 * devolve a quantidade de faixas. */
export function packLanes(items:ResItem[],x:(t:number)=>number,label:number,gap:number,limit=Infinity,lo=-Infinity){
 const ends:number[]=[];
 for(const it of items){
  const l=x(it.a),r=x(it.b),side=labelSide(l,r,label,gap,limit,lo);
  const from=side==='left'?Math.max(l,lo)-gap-label:l,to=side==='right'?r+gap+label:r;
  let lane=ends.findIndex(e=>e+gap<=from);
  if(lane<0){lane=ends.length;ends.push(-Infinity);}
  ends[lane]=to;it.lane=lane;it.side=side;
 }
 return Math.max(1,ends.length);
}

/** Seleção de tipos e recursos na URL (PDF e Apresentação). */
export function resourceParams(kinds:ResKind[],picked:string[]){
 const q=new URLSearchParams();
 if(kinds.length&&kinds.length<ALL_KINDS.length)q.set('tipos',kinds.join(','));
 if(picked.length)q.set('recursos',picked.join(','));
 return q;
}
export function resourceFromParams(q:URLSearchParams):{kinds:ResKind[],picked:string[]}{
 const kinds=(q.get('tipos')||'').split(',').filter((k):k is ResKind=>ALL_KINDS.includes(k as ResKind));
 const picked=(q.get('recursos')||'').split(',').map(s=>s.trim()).filter(s=>/^(equipamento|funcao|material):.{1,200}$/.test(s)).slice(0,300);
 return {kinds:kinds.length?[...new Set(kinds)]:ALL_KINDS,picked:[...new Set(picked)]};
}

const LIST_STATUS:Record<string,string>={programada:'Programada',em_andamento:'Em andamento',encerramento_pendente:'Encerramento pendente',concluida:'Concluída',cancelada:'Cancelada',todas:'todas, inclusive canceladas'};
/** Filtros da Lista de OS que a agenda de recursos herda (na janela de exportação e no PDF), em texto e
 * na ordem da lista. `names` traduz os ids de tipo de atividade, local e solicitante; sem nome, fica o id. */
export function listFilterLabels(q:URLSearchParams,names:{type?:Record<string,string>,location?:Record<string,string>,sol?:Record<string,string>}){
 const ids=(k:string)=>(q.get(k)||'').split(',').map(x=>x.trim()).filter(Boolean);
 const name=(k:'type'|'location'|'sol',id:string)=>names[k]?.[id]||id;
 const status=q.get('status'),number=(q.get('number')||'').replace(/\D/g,''),code=q.get('code');
 return [
  status?`Situação: ${LIST_STATUS[status]||status}`:'',
  number?`Nº da OS: ${number.padStart(6,'0')}`:'',
  code?`Código: ${code}`:'',
  q.get('type')?`Tipo de atividade: ${name('type',q.get('type')!)}`:'',
  q.get('location')?`Local: ${name('location',q.get('location')!)}`:'',
  ids('sol').length?`Solicitante: ${ids('sol').map(id=>name('sol',id)).join(', ')}`:'',
  ids('setor').length?`Setor: ${ids('setor').map(s=>s==='-'?'sem setor':s).join(', ')}`:'',
 ].filter(Boolean);
}
