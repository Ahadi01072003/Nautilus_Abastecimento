'use client';
// Exportação: escolha dos conjuntos, filtros e formato, com prévia das contagens antes de gerar.
// O servidor confere de novo o acesso a cada conjunto, o escopo de organizações e os limites.
import {useEffect,useMemo,useState} from 'react';
import {Download,FileSpreadsheet,FileText,LoaderCircle,CheckCircle2,AlertTriangle} from 'lucide-react';
import {toast} from 'sonner';
import {Input} from '@/components/ui/input';
import {Choice,Field,load,type R} from './kit';

type Set={id:string;label:string;desc:string;group:'abastecimento'|'operacao'|'financeiro'};
const SETS:Set[]=[
 {id:'os',label:'OS',desc:'Situação, solicitante, local, planejado × real, tempo efetivo e parado.',group:'operacao'},
 {id:'etapas',label:'Etapas',desc:'Cada etapa com horários, tempo efetivo, parado e desvios.',group:'operacao'},
 {id:'periodos',label:'Períodos',desc:'Trabalho e paradas (pausa, bloqueio, NC crítica) com duração.',group:'operacao'},
 {id:'apontamentos',label:'Apontamentos',desc:'Ocorrências, impactos e bloqueios, com resolução.',group:'operacao'},
 {id:'checklists',label:'Checklists',desc:'Preenchimentos por OS, momento, equipamento e NC.',group:'operacao'},
 {id:'usos_realizados',label:'Horas de uso realizadas',desc:'Atividades realizadas: cada uso de equipamento informado no registro, com início, fim, horas e se entra no recobrável.',group:'operacao'},
 {id:'equipamentos',label:'Equipamentos por OS',desc:'Uma linha por OS, etapa e equipamento: data, atividade, tipo, TAG e horas planejadas de uso.',group:'operacao'},
 {id:'recobraveis_previsto',label:'Recobráveis: previsto',desc:'De onde vem o previsto: cada OS com reserva do equipamento no período, horas, diárias, valor e se entra ou não (com o motivo).',group:'financeiro'},
 {id:'recobraveis_diarias',label:'Recobráveis: diárias',desc:'Cada diária com equipamento, cliente, OS que abriu, OS atendidas, valor e situação.',group:'financeiro'},
 {id:'recobraveis_usos',label:'Recobráveis: usos',desc:'Início e fim de cada uso de equipamento cobrado, origem do fim e conferência.',group:'financeiro'},
 {id:'recobraveis_atividades',label:'Recobráveis: atividades',desc:'Cada solicitação de recobrável pela data prevista: situação, fornecedor escolhido, valor cotado, margem, impostos, valor a faturar, OS e data da autorização.',group:'financeiro'},
 {id:'supplies',label:'Abastecimentos',desc:'Quantidade, equipamento, operador e autoria.',group:'abastecimento'},
 {id:'movements',label:'Movimentações de estoque',desc:'Entradas, saídas e ajustes de inventário.',group:'abastecimento'},
 {id:'requests',label:'Solicitações de reposição',desc:'Abertura, prazo e recebimentos.',group:'abastecimento'},
];

export default function ExportCenter({manager,operation,finance=false,fuels}:{manager:boolean;operation:boolean;finance?:boolean;fuels:R[]}){
 const available=useMemo(()=>SETS.filter(s=>s.group==='abastecimento'?manager:s.group==='financeiro'?manager||finance:manager||operation),[manager,operation,finance]);
 const [sets,setSets]=useState<string[]>(()=>available.slice(0,1).map(s=>s.id));
 const [format,setFormat]=useState<'xlsx'|'csv'>('xlsx'),[start,setStart]=useState(''),[end,setEnd]=useState(''),[fuel,setFuel]=useState('all'),[org,setOrg]=useState('all');
 const [orgs,setOrgs]=useState<R[]>([]),[preview,setPreview]=useState<{counts:Record<string,number>;limit:number;total:number}|null>(null),[previewError,setPreviewError]=useState(''),[busy,setBusy]=useState(false);
 const hasOps=sets.some(id=>['operacao','financeiro'].includes(SETS.find(s=>s.id===id)?.group||'')),hasFuel=sets.some(id=>SETS.find(s=>s.id===id)?.group==='abastecimento');
 const query=useMemo(()=>new URLSearchParams({sets:sets.join(','),format,...(start?{start}:{}),...(end?{end}:{}),...(hasFuel&&fuel!=='all'?{fuel}:{}),...(hasOps&&org!=='all'?{org}:{})}).toString(),[sets,format,start,end,fuel,org,hasFuel,hasOps]);
 const invalid=!sets.length||!!(start&&end&&start>end);
 useEffect(()=>{if(!operation&&!manager&&!finance)return;load<R>(operation||manager?'orders/refs':'finance/rates').then(r=>setOrgs(r.orgs||[])).catch(()=>setOrgs([]))},[operation,manager,finance]);
 // Prévia com atraso curto: só contagens, sem gerar arquivo.
 useEffect(()=>{if(invalid)return;const t=setTimeout(()=>{load<{counts:Record<string,number>;limit:number;total:number}>('export/preview?'+query).then(p=>{setPreview(p);setPreviewError('')}).catch(e=>{setPreview(null);setPreviewError((e as Error).message)})},300);return()=>clearTimeout(t)},[query,invalid]);
 const over=preview?Object.entries(preview.counts).filter(([,n])=>n>preview.limit):[];
 const tooBig=!!preview&&Object.values(preview.counts).reduce((t,n)=>t+n,0)>preview.total;
 const toggle=(id:string)=>setSets(v=>v.includes(id)?v.filter(x=>x!==id):[...available.map(s=>s.id).filter(x=>x===id||v.includes(x))]);
 async function generate(){
  setBusy(true);
  try{
   const r=await fetch('/api/export?'+query,{cache:'no-store'});
   if(!r.ok){const j=await r.json().catch(()=>({error:'Não foi possível gerar o arquivo.'}));throw new Error(j.error||'Não foi possível gerar o arquivo.');}
   const name=/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition')||'')?.[1]||'nautilus';
   const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),4000);
   toast.success(`Arquivo ${name} gerado.`);
  }catch(e){toast.error((e as Error).message)}finally{setBusy(false)}
 }
 const group=(g:Set['group'],title:string)=>{const list=available.filter(s=>s.group===g);return list.length?<fieldset className="xp-group"><legend>{title}</legend>
  {list.map(s=><label key={s.id} className="xp-set" data-on={sets.includes(s.id)}><input type="checkbox" checked={sets.includes(s.id)} onChange={()=>toggle(s.id)}/><span><b>{s.label}</b><small>{s.desc}</small></span>
   <em className={preview&&preview.counts[s.id]>preview.limit?'over':''}>{sets.includes(s.id)&&preview?.counts[s.id]!==undefined?`${preview.counts[s.id].toLocaleString('pt-BR')} linhas`:''}</em></label>)}
 </fieldset>:null;};

 return <div className="xp">
  <section className="n-panel xp-main">
   <div className="xp-head"><span className="xp-icon"><FileSpreadsheet size={26}/></span><div><h2>Monte o arquivo</h2><p>Escolha os conjuntos, o período e o formato. A prévia mostra quantas linhas cada conjunto terá.</p></div></div>
   {group('operacao','Operação · OS')}
   {group('financeiro','Financeiro · recobráveis')}
   {group('abastecimento','Abastecimento')}
   <div className="form-grid">
    <Field label="Data inicial"><Input type="date" value={start} onChange={e=>setStart(e.target.value)}/></Field>
    <Field label="Data final"><Input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></Field>
    {hasOps&&<Field label="Solicitante"><Choice value={org} onChange={setOrg} label="Organização solicitante" options={[{value:'all',label:'Todas no seu acesso'},...orgs.map(o=>({value:o.id,label:o.acronym+' · '+o.name}))]}/></Field>}
    {hasFuel&&<Field label="Combustível"><Choice value={fuel} onChange={setFuel} label="Combustível da exportação" options={[{value:'all',label:'Todos os combustíveis'},...fuels.map(f=>({value:f.id,label:f.name}))]}/></Field>}
   </div>
   <div className="xp-format" role="radiogroup" aria-label="Formato">
    <button type="button" role="radio" aria-checked={format==='xlsx'} onClick={()=>setFormat('xlsx')}><FileSpreadsheet size={18}/><span><b>Excel (.xlsx)</b><small>Uma aba por conjunto, cabeçalho fixo e filtros prontos.</small></span></button>
    <button type="button" role="radio" aria-checked={format==='csv'} onClick={()=>setFormat('csv')}><FileText size={18}/><span><b>CSV</b><small>{sets.length>1?'Um .csv por conjunto, juntos em .zip.':'Separador ponto e vírgula, UTF-8.'}</small></span></button>
   </div>
   {start&&end&&start>end&&<p className="xp-warn" role="alert"><AlertTriangle size={15}/>A data inicial precisa ser anterior à final.</p>}
   {previewError&&<p className="xp-warn" role="alert"><AlertTriangle size={15}/>{previewError}</p>}
   {over.length>0&&<p className="xp-warn" role="alert"><AlertTriangle size={15}/>Acima do limite de {preview!.limit.toLocaleString('pt-BR')} linhas por conjunto. Escolha um período menor.</p>}
   {!over.length&&tooBig&&<p className="xp-warn" role="alert"><AlertTriangle size={15}/>Somando os conjuntos, passa de {preview!.total.toLocaleString('pt-BR')} linhas. Escolha um período menor ou menos conjuntos.</p>}
   <button type="button" className="sn-btn go xp-go" disabled={invalid||busy||over.length>0||tooBig} onClick={()=>void generate()}>{busy?<LoaderCircle size={17} className="animate-spin"/>:<Download size={17}/>}{busy?'Gerando…':`Gerar ${format==='xlsx'?'planilha Excel':sets.length>1?'CSV (.zip)':'CSV'}`}</button>
   <small className="export-format">Horários de Brasília · toda exportação fica registrada na auditoria · até 5 arquivos por minuto</small>
  </section>
  <aside className="xp-aside">
   <section className="n-panel">{[['Relatório da OS em PDF','Em Operação › Apontamentos, abra a OS e use “Relatório PDF”: régua, etapas, paradas, apontamentos, checklists e assinaturas.'],['Tempo efetivo sem dupla contagem','Etapas em paralelo contam uma vez no tempo da OS.'],['Texto nunca vira fórmula','Células iniciadas por = + − @ são neutralizadas.']].map(([t,d])=><div className="export-check" key={t}><CheckCircle2 size={19}/><div><b>{t}</b><p>{d}</p></div></div>)}</section>
   <section className="bi-note"><FileSpreadsheet size={23}/><h3>Para o Power BI</h3><p>Prefira o Excel: cada aba vira uma tabela. Relacione pela coluna “ID da OS”. No CSV, use ponto e vírgula como delimitador e a localidade Português (Brasil).</p></section>
  </aside>
 </div>;
}
