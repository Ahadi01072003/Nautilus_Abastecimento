// Relatório da Portaria para impressão (A4 retrato): revisão emitida (?id=) ou parcial do dia aberto (?reportId=).
// Mostra o documento completo; cada consulta é auditada em lib/portaria-reports e a página nunca vai para cache.
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {reportVersion} from '@/lib/portaria-reports';
import {rateLimit} from '@/lib/security';
import {AppError} from '@/lib/domain';
import PortariaPrint from './print';
export const dynamic='force-dynamic';

type Search=Promise<Record<string,string|string[]|undefined>>;
const one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
export const metadata:Metadata={title:'Relatório da Portaria · NAUTILUS',robots:{index:false,follow:false}};

type R=Record<string,any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- Fotografia JSON da revisão.
const KIND:Record<string,string>={original:'Original',atualizada:'Atualizada',retificada:'Retificada',parcial:'PARCIAL'};
const MODE:Record<string,string>={a_pe:'A pé',veiculo:'Veículo',outro:'Outro'};
const dmy=(d:string)=>d.split('-').reverse().join('/');
const css=`
html,body{background:#dfe5e3!important;color:#0b1d25}
body{font:9pt/1.35 var(--f-body);margin:0}
.noprint{position:fixed;right:18px;top:18px;display:grid;gap:6px;justify-items:end;z-index:5}
.noprint button{background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(3,22,31,.18)}
.noprint small{font-size:11px;color:#4b5f66;background:#fff;padding:3px 6px;border-radius:3px;max-width:260px}
.err{max-width:640px;margin:60px auto;background:#fff;padding:24px;border-radius:6px}
.doc{width:210mm;min-height:297mm;box-sizing:border-box;padding:12mm 12mm 10mm;margin:10mm auto;background:#fff;box-shadow:0 6px 28px rgba(3,22,31,.16);position:relative}
.top{display:grid;grid-template-columns:36mm 1fr auto;align-items:end;gap:6mm;border-bottom:.9mm solid #03161f;padding-bottom:2.4mm}
.top img{width:32mm;height:auto}
.eye{font:600 6.8pt/1.2 var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:#087f77}
h1{margin:.4mm 0 0;font:850 17pt/1 var(--f-display);letter-spacing:-.02em}
.meta{text-align:right;font:500 7pt/1.5 var(--f-mono);color:#4b5f66}
.partial{margin:3mm 0 0;border:.6mm solid #b42318;color:#b42318;padding:2mm 3mm;font:800 9pt/1.2 var(--f-body);text-align:center;letter-spacing:.04em}
.newer{margin:3mm 0 0;border:.4mm solid #b54708;background:#fffaeb;color:#7a2e0e;padding:2mm 3mm;font-size:8.4pt}
.ident{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:.3mm solid #c7d0ce;margin:3mm 0}
.ident div{padding:1.4mm 2.4mm;border-right:.3mm solid #c7d0ce;border-bottom:.3mm solid #c7d0ce}
.ident dt{font:600 6.2pt/1.2 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#6c7c82}
.ident dd{margin:.4mm 0 0;font:700 8.6pt/1.25 var(--f-body)}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);border:.3mm solid #c7d0ce;margin-bottom:3mm}
.kpis div{padding:1.6mm 2.4mm;border-right:.3mm solid #c7d0ce}.kpis div:last-child{border-right:0}
.kpis dt{font:600 6.2pt/1.2 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#6c7c82}
.kpis dd{margin:.4mm 0 0;font:800 14pt/1 var(--f-mono)}
h2{margin:4mm 0 1.4mm;font:800 9.4pt/1 var(--f-body);letter-spacing:.02em;text-transform:uppercase;color:#087f77;border-bottom:.3mm solid #c7d0ce;padding-bottom:1mm}
h2 small{font:500 7pt var(--f-mono);color:#6c7c82;text-transform:none;margin-left:2mm}
table{width:100%;border-collapse:collapse;font-size:7.6pt}
th{font:700 6.2pt/1.2 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#4b5f66;text-align:left;background:#eef1f0;padding:1.4mm 1.6mm;border-bottom:.3mm solid #9fb0ad}
td{padding:1.2mm 1.6mm;border-bottom:.2mm solid #dde3e1;vertical-align:top}
tr{break-inside:avoid}thead{display:table-header-group}
td small{display:block;color:#6c7c82;font-size:6.6pt}
.none{color:#6c7c82;font-style:italic;padding:2mm 0}
.just{margin:1.5mm 0;font-size:8pt;color:#33474e}
.foot{margin-top:5mm;display:flex;justify-content:space-between;gap:4mm;font:500 6.6pt/1.2 var(--f-mono);letter-spacing:.06em;color:#6c7c82;border-top:.3mm solid #c7d0ce;padding-top:1.6mm}
@media print{html,body{background:#fff!important}.noprint{display:none}.doc{margin:0;box-shadow:none;min-height:0}@page{size:A4 portrait;margin:0}}
`;

type Fmt={hm:(iso:string|null)=>string,dmyhm:(iso:string|null)=>string,full:(iso:string|null)=>string};
function formats(tz:string):Fmt{
 const f=(o:Intl.DateTimeFormatOptions)=>new Intl.DateTimeFormat('pt-BR',{timeZone:tz,...o});
 const hmF=f({hour:'2-digit',minute:'2-digit'}),shortF=f({day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}),fullF=f({day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
 return {hm:iso=>iso?hmF.format(new Date(iso)):'—',dmyhm:iso=>iso?shortF.format(new Date(iso)).replace(',',''):'—',full:iso=>iso?fullF.format(new Date(iso)).replace(',',''):'—'};
}
function Visits({rows,kind,f}:{rows:R[],kind:'entrada'|'saida'|'presente',f:Fmt}){
 const {hm,dmyhm}=f;
 if(!rows.length)return <p className="none">Nenhum registro.</p>;
 return <table><thead><tr><th>{kind==='saida'?'Saída':'Entrada'}</th><th>Visitante</th><th>Documento</th><th>Empresa</th><th>Objetivo</th><th>Acesso</th><th>{kind==='saida'?'Entrou':'Registrado por'}</th></tr></thead><tbody>
  {rows.map(v=><tr key={v.id+kind}><td>{hm(kind==='saida'?v.exitAt:v.entryAt)}{kind==='entrada'&&v.retroactive&&<small>lançamento posterior</small>}</td><td><b>{v.personName}</b></td><td>{v.documentType} {v.document}</td><td>{v.companyName}</td>
   <td>{v.purpose}{v.notes&&<small>{v.notes}</small>}</td><td>{MODE[v.accessMode]}{(kind==='saida'?(v.plateOut||v.plateIn):v.plateIn)?` · ${kind==='saida'?(v.plateOut||v.plateIn):v.plateIn}`:''}</td>
   <td>{kind==='saida'?<>{dmyhm(v.entryAt)}{v.fromPreviousDay&&<small>visita iniciada em dia anterior</small>}</>:v.entryByName}</td></tr>)}</tbody></table>;
}
export default async function PortariaRelatorio({searchParams}:{searchParams:Search}){
 const s=await searchParams;
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 let r:R;
 try{
  await rateLimit(member.id,'export');
  r=await reportVersion(member,new URL('http://local/?'+new URLSearchParams({...(one(s.id)?{id:one(s.id)}:{}),...(one(s.reportId)?{reportId:one(s.reportId)}:{})}))) as R;
 }catch(e){
  if(!(e instanceof AppError))throw e;
  return <main><style>{css}</style><div className="err"><h1>Relatório indisponível</h1><p>{e.message}</p></div></main>;
 }
 const snap=r.snapshot as R,f=formats(snap.timezone||'America/Sao_Paulo'),full=f.full;
 const t=snap.totals as R,partial=!!r.partial,newer=!partial&&r.latestNumber>snap.number;
 return <main><style>{css}</style><PortariaPrint auto={one(s.imprimir)==='1'}/>
  <div className="doc">
   <div className="top">
    {/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático */}
    <img src="/logo-color.svg" alt="OceanPact LOG"/>
    <div><div className="eye">Portaria · {snap.base.name}</div><h1>Relatório diário de acesso</h1></div>
    <div className="meta">Data operacional<br/><b style={{fontSize:'12pt',color:'#0b1d25'}}>{dmy(snap.date)}</b></div></div>
   {partial&&<div className="partial">RELATÓRIO PARCIAL · o dia ainda está aberto e este documento não é uma revisão emitida</div>}
   {newer&&<div className="newer">Existe revisão mais recente (revisão {r.latestNumber}). Esta é a revisão {snap.number}, conforme emitida em {full(r.version.issuedAt)}.</div>}
   <dl className="ident">
    <div><dt>Revisão</dt><dd>{partial?'—':`${snap.number} · ${KIND[snap.kind]}`}</dd></div>
    <div><dt>Fuso horário</dt><dd>{snap.timezone}</dd></div>
    <div><dt>Identificador</dt><dd style={{fontSize:'6.8pt'}}>{partial?snap.reportId:r.version.id}</dd></div>
    <div><dt>{partial?'Situação':'Fechado em'}</dt><dd>{partial?'Aberto':full(r.version.issuedAt)}</dd></div>
    <div><dt>{partial?'—':'Fechado por'}</dt><dd>{partial?'—':r.version.issuedByName}</dd></div>
    <div><dt>Consultado em</dt><dd>{full(r.generatedAt)} por {r.printedBy}</dd></div>
   </dl>
   {snap.reason&&<p className="just"><b>Motivo da revisão:</b> {snap.reason}</p>}
   {snap.closeJustification&&<p className="just"><b>Justificativa do fechamento:</b> {snap.closeJustification}</p>}
   <dl className="kpis"><div><dt>Entradas</dt><dd>{t.entradas}</dd></div><div><dt>Saídas</dt><dd>{t.saidas}</dd></div><div><dt>Pessoas únicas</dt><dd>{t.pessoasUnicas}</dd></div><div><dt>Na base</dt><dd>{t.presentes}</dd></div><div><dt>Anuladas</dt><dd>{t.anuladas}</dd></div></dl>
   {t.presentes>0&&<><h2>Na base {partial?'agora':'no fechamento'}<small>{t.presentes} pessoa(s) com visita em andamento</small></h2><Visits rows={snap.present as R[]} kind="presente" f={f}/></>}
   <h2>Entradas<small>{t.entradas} registro(s)</small></h2><Visits rows={snap.entries as R[]} kind="entrada" f={f}/>
   <h2>Saídas<small>{t.saidas} registro(s){t.saidasDeVisitasAnteriores?` · ${t.saidasDeVisitasAnteriores} de visitas de dias anteriores`:''}</small></h2><Visits rows={snap.exits as R[]} kind="saida" f={f}/>
   <h2>Por empresa</h2>
   {(snap.byCompany as R[]).length?<table><thead><tr><th>Empresa</th><th>Entradas</th><th>Pessoas únicas</th></tr></thead><tbody>{(snap.byCompany as R[]).map(c=><tr key={c.companyId}><td>{c.companyName}</td><td>{c.entradas}</td><td>{c.pessoasUnicas}</td></tr>)}</tbody></table>:<p className="none">Sem entradas.</p>}
   <div className="foot"><span>NAUTILUS · Portaria · {snap.base.name}</span><span>{partial?'Parcial':`Revisão ${snap.number} de ${r.latestNumber}`} · {dmy(snap.date)}</span></div>
  </div>
 </main>;
}
