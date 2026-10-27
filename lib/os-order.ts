// Organização das OS: UMA regra para a Lista de OS, o Gantt e a Apresentação (TV). Recebe a coleção
// já consultada, aplica os filtros de solicitante e setor e devolve os grupos na ordem de exibição.
// Lista e Gantt desenham os mesmos grupos e as mesmas linhas; só a posição horizontal das barras
// muda com as datas. Sem dependências de banco ou de tela (roda no servidor e no navegador).

export type ArrangeMode='execucao'|'setor'|'status';
export type Dir='asc'|'desc';
export type Arrange={mode:ArrangeMode,dir:Dir,sectorDir:Dir};
/** Filtros desta etapa: solicitante (organização) e setor. Vazio = todos. */
export type OsFilter={orgs:string[],sectors:string[]};
/** Setor “vazio” no filtro (OS sem setor). */
export const NO_SECTOR='-';
export const DEFAULT_ARRANGE:Arrange={mode:'execucao',dir:'asc',sectorDir:'asc'};
export const EMPTY_FILTER:OsFilter={orgs:[],sectors:[]};

export type OsItem={id:string,number:number,status:string,org_id:string,sector_code?:string|null,sector_name?:string|null,
 planned_start?:string|null,planned_end?:string|null,actual_start?:string|null,actual_end?:string|null};
export type Flags={
 /** Programada com o início planejado vencido (grupo “Em atraso” no modo por status). */
 late:boolean,
 /** Em andamento depois do término planejado (sinalizador; continua no grupo “Em andamento”). */
 overdue:boolean,
 /** Sem início planejado: fica no fim, sem data inventada. */
 noStart:boolean,
 /** Datas inconsistentes, sinalizadas sem corrigir nem inverter nada. */
 issues:string[],
};
export type OsRow<T extends OsItem>={item:T,flags:Flags};
export type OsGroup<T extends OsItem>={key:string,label:string,note?:string,rows:OsRow<T>[]};

const at=(v?:string|null)=>{if(!v)return null;const t=Date.parse(v);return Number.isFinite(t)?t:null;};

export function flagsOf(o:OsItem,now:number):Flags{
 const ps=at(o.planned_start),pe=at(o.planned_end),as=at(o.actual_start),ae=at(o.actual_end);
 const issues:string[]=[];
 if(o.planned_start&&ps==null)issues.push('Início planejado ilegível');
 if(o.planned_end&&pe==null)issues.push('Término planejado ilegível');
 if(ps!=null&&pe!=null&&pe<=ps)issues.push('Término planejado igual ou anterior ao início');
 if(ae!=null&&as==null)issues.push('Término real sem início real');
 if(as!=null&&ae!=null&&ae<as)issues.push('Término real anterior ao início real');
 if(as!=null&&as>now+5*60000)issues.push('Início real no futuro');
 return {late:o.status==='programada'&&ps!=null&&ps<now,overdue:o.status==='em_andamento'&&pe!=null&&pe<now,noStart:ps==null,issues};
}

/** Filtro compartilhado: OU dentro do mesmo filtro, E entre solicitante e setor. */
export function matches(o:OsItem,f:OsFilter){
 return (!f.orgs.length||f.orgs.includes(o.org_id))&&(!f.sectors.length||f.sectors.includes(o.sector_code||NO_SECTOR));
}

/** Datas completas (com hora); nulos sempre no fim; empate: término planejado e número da OS. */
function chrono<T extends OsItem>(key:(o:T)=>number|null,dir:Dir){
 return (x:OsRow<T>,y:OsRow<T>)=>{
  const a=key(x.item),b=key(y.item);
  if(a==null||b==null){if(a!=null)return -1;if(b!=null)return 1;}
  else if(a!==b)return dir==='asc'?a-b:b-a;
  const ea=at(x.item.planned_end),eb=at(y.item.planned_end);
  if(ea!==eb){if(ea==null)return 1;if(eb==null)return -1;return ea-eb;}
  return x.item.number-y.item.number||x.item.id.localeCompare(y.item.id);
 };
}
const byStart=<T extends OsItem>(dir:Dir)=>chrono<T>(o=>at(o.planned_start),dir);

/** Hierarquia operacional (modo por status): ordem fixa dos grupos e ordem interna própria de cada um.
 * O sentido crescente/decrescente NÃO se aplica aqui. */
export const STATUS_GROUPS:{key:string,label:string,note:string}[]=[
 {key:'em_andamento',label:'Em andamento',note:'início real mais antigo primeiro'},
 {key:'encerramento_pendente',label:'Encerramento pendente',note:'execução terminada, aguardando checklist ou conferência'},
 {key:'atraso',label:'Em atraso',note:'início planejado vencido há mais tempo primeiro'},
 {key:'previstas',label:'Previstas',note:'início planejado mais próximo primeiro'},
 {key:'outras',label:'Outras situações',note:'situação sem regra própria nesta tela'},
 {key:'concluida',label:'Concluídas',note:'início planejado em ordem crescente'},
 {key:'cancelada',label:'Canceladas',note:'início planejado em ordem crescente; sem data no fim'},
];
export function statusGroupOf(o:OsItem,f:Flags){
 if(o.status==='em_andamento'||o.status==='encerramento_pendente'||o.status==='concluida'||o.status==='cancelada')return o.status;
 if(o.status==='programada')return f.late?'atraso':'previstas';
 return 'outras';
}

export function arrangeOrders<T extends OsItem>(list:T[],arrange:Arrange,filter:OsFilter,now:number,sectorLabel?:(code:string)=>string):OsGroup<T>[]{
 const rows=list.filter(o=>matches(o,filter)).map(item=>({item,flags:flagsOf(item,now)}));
 if(arrange.mode==='status'){
  const groups=STATUS_GROUPS.map(g=>({...g,rows:[] as OsRow<T>[]}));
  for(const r of rows)groups.find(g=>g.key===statusGroupOf(r.item,r.flags))!.rows.push(r);
  const real=chrono<T>(o=>at(o.actual_start),'asc'),asc=byStart<T>('asc');
  for(const g of groups)g.rows.sort(g.key==='em_andamento'||g.key==='encerramento_pendente'?real:asc);
  return groups.filter(g=>g.rows.length).map(g=>({key:g.key,label:g.label,note:g.note,rows:g.rows}));
 }
 const sort=byStart<T>(arrange.dir);
 if(arrange.mode==='setor'){
  const by=new Map<string,OsRow<T>[]>();
  for(const r of rows){const k=r.item.sector_code||NO_SECTOR;by.set(k,[...(by.get(k)||[]),r]);}
  const keys=[...by.keys()].filter(k=>k!==NO_SECTOR).sort((a,b)=>(arrange.sectorDir==='asc'?1:-1)*a.localeCompare(b,'pt-BR',{sensitivity:'base'}));
  if(by.has(NO_SECTOR))keys.push(NO_SECTOR);
  return keys.map(k=>{const rs=by.get(k)!.sort(sort);const name=rs.find(r=>r.item.sector_name)?.item.sector_name;
   return {key:'setor:'+k,label:k===NO_SECTOR?'Sem setor':sectorLabel?.(k)||(name?`${k} · ${name}`:k),rows:rs};});
 }
 // Ordem de execução: uma sequência só; as OS sem início planejado ficam no fim, identificadas.
 const dated=rows.filter(r=>!r.flags.noStart).sort(sort),undated=rows.filter(r=>r.flags.noStart).sort(sort);
 const out:OsGroup<T>[]=[];
 if(dated.length)out.push({key:'execucao',label:'',rows:dated});
 if(undated.length)out.push({key:'sem-inicio',label:'Sem início planejado',note:'sem data para posicionar',rows:undated});
 return out;
}

export const flatRows=<T extends OsItem>(groups:OsGroup<T>[])=>groups.flatMap(g=>g.rows);

/** Configuração na URL (para abrir a Apresentação herdando a tela de origem) e de volta. */
export function viewToParams(a:Arrange,f:OsFilter,display?:string){
 const q=new URLSearchParams({modo:a.mode,ordem:a.dir,setores:a.sectorDir});
 if(f.orgs.length)q.set('sol',f.orgs.join(','));
 if(f.sectors.length)q.set('setor',f.sectors.join(','));
 if(display)q.set('vis',display);
 return q;
}
export function viewFromParams(q:URLSearchParams):{arrange?:Arrange,filter?:OsFilter,display?:string}{
 const mode=q.get('modo'),dir=q.get('ordem'),sd=q.get('setores');
 const list=(k:string)=>(q.get(k)||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,200);
 const okDir=(d:string|null):Dir=>d==='desc'?'desc':'asc';
 return {
  arrange:mode==='execucao'||mode==='setor'||mode==='status'?{mode,dir:okDir(dir),sectorDir:okDir(sd)}:undefined,
  filter:q.has('sol')||q.has('setor')?{orgs:list('sol'),sectors:list('setor')}:undefined,
  display:q.get('vis')||undefined,
 };
}
