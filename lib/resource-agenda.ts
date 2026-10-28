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
export type ResItem=Alloc&{a:number,b:number,lane:number};
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
  r.items.push({...x,a,b,lane:0});by.set(id,r);
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

/** Faixas pela extensão VISÍVEL da barra (com a largura mínima), não só pelo horário: duas
 * alocações curtas e próximas nunca se sobrepõem no desenho. `x` converte instante em posição
 * (px ou mm) e `min`/`gap` usam a mesma unidade. Devolve a quantidade de faixas. */
export function packLanes(items:ResItem[],x:(t:number)=>number,min:number,gap:number){
 const ends:number[]=[];
 for(const it of items){
  const l=x(it.a),r=Math.max(x(it.b),l+min);
  let lane=ends.findIndex(e=>e+gap<=l);
  if(lane<0){lane=ends.length;ends.push(0);}
  ends[lane]=r;it.lane=lane;
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
