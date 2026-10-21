'use client';
// Configuração central de módulos e telas. Uma tela só aparece quando existe e quando o
// servidor a libera em actor.modules; o servidor revalida cada consulta e comando.
import {useEffect,useState} from 'react';
import {LayoutDashboard,Fuel,Warehouse,Bell,Truck,Users,Download,CalendarDays,KeyRound,LogOut,ChevronDown,Building2,MapPin,ListChecks,Tags,Workflow,Database,Droplets,CalendarRange,CalendarPlus,FilePen,ListOrdered,HardHat,ClipboardList,Gauge,Wrench,ClipboardCheck,Timer,Activity,Radar,ClipboardPlus,type LucideIcon} from 'lucide-react';
import {Sidebar,SidebarContent,SidebarHeader,SidebarFooter,SidebarGroup,SidebarGroupLabel,SidebarMenu,SidebarMenuItem,SidebarMenuButton,SidebarMenuSub,SidebarMenuSubItem,SidebarMenuSubButton,useSidebar} from '@/components/ui/sidebar';
import {signOut} from './login';
import Bathy from './bathy';

export type Screen={id:string;label:string;icon:LucideIcon;subtitle:string};
export type Module={id:string;label:string;icon:LucideIcon;screens:Screen[]};

/** Tela inicial, acima dos módulos. */
export const HOME:Screen={id:'painel',label:'Painel central',icon:Radar,subtitle:'Resumo de cada módulo e os avisos que pedem atenção, conforme o seu acesso.'};
export const MODULES:Module[]=[
 {id:'abastecimento',label:'Abastecimento',icon:Droplets,screens:[
  {id:'visao',label:'Visão geral',icon:LayoutDashboard,subtitle:'Estoque, registros e reposições da sua operação.'},
  {id:'solicitacoes',label:'Solicitações',icon:CalendarDays,subtitle:'Solicite, acompanhe o agendamento e consulte a realização.'},
  {id:'abastecimentos',label:'Abastecimentos',icon:Fuel,subtitle:'Cada lançamento com quantidade, equipamento e responsável.'},
  {id:'estoque',label:'Controle de estoque',icon:Warehouse,subtitle:'Saldos, movimentações e parâmetros de cada combustível.'},
  {id:'alertas',label:'Alertas e reposições',icon:Bell,subtitle:'Solicitações de reposição e prazos em dias úteis.'},
 ]},
 {id:'planejamento',label:'Planejamento',icon:CalendarRange,screens:[
  {id:'plan-fluxos',label:'Cadastro de fluxo',icon:Workflow,subtitle:'Tipos de atividade, etapas, dependências e necessidades padrão, com versões.'},
  {id:'plan-atividade',label:'Planejamento de atividade',icon:CalendarPlus,subtitle:'Rascunho com horários, recursos e documentos; revise e lance a OS.'},
  {id:'plan-rascunhos',label:'Rascunhos',icon:FilePen,subtitle:'Planejamentos ainda não lançados e as reservas provisórias que eles seguram.'},
  {id:'plan-os',label:'Lista de OS programadas',icon:ListOrdered,subtitle:'OS lançadas, com filtros por período, solicitante, local e situação.'},
 ]},
 {id:'operacao',label:'Operação',icon:HardHat,screens:[
  {id:'op-painel',label:'Painel de OS',icon:Gauge,subtitle:'Cada OS em andamento com a régua e o cronômetro do tempo efetivo.'},
  {id:'op-os',label:'Apontamentos',icon:ClipboardList,subtitle:'Execução das etapas, ocorrências, impactos, bloqueios e checklists de cada OS.'},
  {id:'op-registro',label:'Registrar atividade realizada',icon:ClipboardPlus,subtitle:'Atividade feita sem planejamento (urgência): mesmo formulário da OS sem fluxo, já com início e fim reais.'},
 ]},
 {id:'manutencao',label:'Manutenção',icon:Wrench,screens:[
  {id:'man-painel',label:'Painel de preventivas',icon:Activity,subtitle:'Linha do tempo de cada equipamento com os marcos do ciclo e quanto falta para o próximo.'},
  {id:'man-criterios',label:'Critérios de manutenção',icon:ClipboardCheck,subtitle:'Planos, pontos de atenção, inconformidades e o método de cada equipamento: dias, horímetro ou odômetro.'},
  {id:'man-corretivas',label:'Corretivas',icon:Wrench,subtitle:'Manutenções não programadas: pontos manutenidos, horas e observações.'},
  {id:'man-leituras',label:'Leituras',icon:Timer,subtitle:'Horímetro e odômetro dos equipamentos, base dos critérios por leitura.'},
 ]},
 {id:'cadastros',label:'Cadastros gerais',icon:Database,screens:[
  {id:'cad-solicitantes',label:'Solicitantes e clientes',icon:Building2,subtitle:'Organizações solicitantes, etiquetas visuais e pessoas de contato.'},
  {id:'cad-locais',label:'Locais',icon:MapPin,subtitle:'Unidades, áreas e locais onde as atividades acontecem.'},
  {id:'cad-equipamentos',label:'Tipos e equipamentos',icon:Truck,subtitle:'Tipos, capacidades, combustíveis e identificação de cada equipamento.'},
  {id:'cad-colaboradores',label:'Colaboradores e funções',icon:Users,subtitle:'Pessoas da operação, funções, usuários, senhas e acessos.'},
  {id:'cad-checklists',label:'Checklists',icon:ListChecks,subtitle:'Modelos com perguntas C, NC e N/A, criticidade e vínculos.'},
  {id:'cad-categorias',label:'Ocorrências, impactos e bloqueios',icon:Tags,subtitle:'Categorias usadas nos apontamentos da operação.'},
 ]},
];
/** Telas fora dos módulos. */
export const STANDALONE:Screen[]=[
 {id:'exportacao',label:'Exportação',icon:Download,subtitle:'OS, etapas, apontamentos e abastecimentos em Excel ou CSV, com prévia antes de gerar.'},
];
export const ALL_SCREENS=[HOME,...MODULES.flatMap(m=>m.screens),...STANDALONE];
export const moduleOf=(view:string)=>MODULES.find(m=>m.screens.some(s=>s.id===view));
export const screenOf=(view:string)=>ALL_SCREENS.find(s=>s.id===view);

const STORAGE='nautilus.nav.expanded';
function readExpanded():string[]|null{try{const v=sessionStorage.getItem(STORAGE);return v?JSON.parse(v):null}catch{return null}}
function saveExpanded(v:string[]){try{sessionStorage.setItem(STORAGE,JSON.stringify(v))}catch{/* navegação privada: segue sem lembrar */}}

export function Navigation({view,setView,allowed,counts,person,onAccount}:{view:string,setView:(v:string)=>void,allowed:string[]|null,counts:Record<string,number>,person:{name:string,detail:string},onAccount:()=>void}){
 const {setOpenMobile,isMobile}=useSidebar();
 const [expanded,setExpanded]=useState<string[]>([]);
 // Restaura o que estava aberto nesta sessão (sessionStorage só existe no navegador).
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Preferência local lida após montar, para não divergir da renderização do servidor.
 useEffect(()=>{setExpanded(readExpanded()??['abastecimento'])},[]);
 // Depois que o servidor libera as telas, o módulo da tela ativa fica aberto
 // (inclusive ao chegar por link ou pelo voltar do navegador).
 const active=moduleOf(view)?.id,ready=!!allowed;
 // eslint-disable-next-line react-hooks/set-state-in-effect -- Sincroniza com a tela ativa vinda da URL.
 useEffect(()=>{if(ready&&active)setExpanded(e=>{if(e.includes(active))return e;const next=[...e,active];saveExpanded(next);return next})},[active,ready]);
 const toggle=(id:string)=>setExpanded(e=>{const next=e.includes(id)?e.filter(x=>x!==id):[...e,id];saveExpanded(next);return next});
 const go=(id:string)=>{setView(id);if(isMobile)setOpenMobile(false)};
 const visible=(s:Screen)=>!!allowed?.includes(s.id);
 return <Sidebar className="n-sidebar" collapsible="offcanvas">
  <div className="sonar-bathy" aria-hidden="true"><Bathy/></div>
  <SidebarHeader className="n-sidebar-header"><div className="brand sonar-brand">{/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático pequeno */}
   <img src="/logo-white.png" alt="OceanPact | CBO" width={285} height={79}/><div className="sonar-sys">NAUTILUS</div></div></SidebarHeader>
  <SidebarContent>
   <SidebarGroup><SidebarMenu>{visible(HOME)&&<SidebarMenuItem className="nav-standalone nav-home"><SidebarMenuButton isActive={view===HOME.id} aria-current={view===HOME.id?'page':undefined} onClick={()=>go(HOME.id)} className="nav-item"><HOME.icon/><span>{HOME.label}</span>{!!counts.painel&&<span className="nav-count" aria-label={`${counts.painel} avisos críticos`}>{counts.painel}</span>}</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></SidebarGroup>
   <SidebarGroup><SidebarGroupLabel>MÓDULOS</SidebarGroupLabel><SidebarMenu>
    {MODULES.map(m=>{const screens=m.screens.filter(visible);if(!screens.length)return null;const open=expanded.includes(m.id),current=active===m.id,total=screens.reduce((n,s)=>n+(counts[s.id]||0),0);
     return <SidebarMenuItem key={m.id} className="nav-module">
      <SidebarMenuButton className={`nav-item nav-module-button ${current?'has-active':''}`} aria-expanded={open} aria-controls={`nav-${m.id}`} onClick={()=>toggle(m.id)}>
       <m.icon/><span>{m.label}</span>{!open&&total>0&&<span className="nav-count" aria-label={`${total} pendentes`}>{total}</span>}<ChevronDown className="nav-chevron" aria-hidden/>
      </SidebarMenuButton>
      {open&&<SidebarMenuSub id={`nav-${m.id}`} className="nav-sub">
       {screens.map(s=><SidebarMenuSubItem key={s.id}><SidebarMenuSubButton asChild isActive={view===s.id}><button type="button" className="nav-sub-item" aria-current={view===s.id?'page':undefined} onClick={()=>go(s.id)}><s.icon/><span>{s.label}</span>{!!counts[s.id]&&<span className="nav-count">{counts[s.id]}</span>}</button></SidebarMenuSubButton></SidebarMenuSubItem>)}
      </SidebarMenuSub>}
     </SidebarMenuItem>})}
    {/* Fora dos módulos (ex.: Exportação), logo abaixo deles para continuar visível. */}
    {STANDALONE.filter(visible).map(s=><SidebarMenuItem key={s.id} className="nav-standalone"><SidebarMenuButton isActive={view===s.id} aria-current={view===s.id?'page':undefined} onClick={()=>go(s.id)} className="nav-item"><s.icon/><span>{s.label}</span></SidebarMenuButton></SidebarMenuItem>)}
   </SidebarMenu></SidebarGroup>

  </SidebarContent>
  <SidebarFooter className="n-sidebar-footer"><div className="sidebar-person"><span className="person-avatar">{(person.name||'N').slice(0,2).toUpperCase()}</span><div><b>{person.name}</b><small>{person.detail}</small></div><div className="sidebar-person-actions"><button type="button" onClick={onAccount} title="Alterar minha senha" aria-label="Alterar minha senha"><KeyRound size={16}/></button><button type="button" onClick={()=>void signOut()} title="Sair" aria-label="Sair"><LogOut size={16}/></button></div></div></SidebarFooter>
 </Sidebar>;
}
