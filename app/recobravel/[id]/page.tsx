// Relatório da solicitação de recobrável para o cliente escolher e assinar (impressão pelo navegador,
// A4). Mostra a versão guardada no envio (?versao=N; padrão: a última), nunca os dados atuais.
// requestReport confere a sessão, o acesso Financeiro ou da Gestão e o escopo de organizações.
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {requestReport} from '@/lib/finance-requests';
import {db,type Row} from '@/lib/db';
import {audit} from '@/lib/registry';
import {rateLimit} from '@/lib/security';
import {AppError} from '@/lib/domain';
import PrintButton from '../../relatorio/[id]/print';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Relatório de recobrável · NAUTILUS',robots:{index:false,follow:false}};

type Search=Promise<Record<string,string|string[]|undefined>>;
const one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
const TZ='America/Sao_Paulo';
const f=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const dt=(v:unknown)=>v?f.format(new Date(String(v))).replace(',',''):'—';
const day=(v:unknown)=>{const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(v||''));return m?`${m[3]}/${m[2]}/${m[1]}`:'—';};
const brl=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const money=(c:number)=>brl.format(c/100);
const pct=(bp:number)=>(bp/100).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%';

const css=`
html,body{background:#fff!important;color:#0b1d25}
body{font:13px/1.45 var(--f-body)}
.sheet{max-width:960px;margin:0 auto;padding:28px 28px 48px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rtop{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:3px solid #03161f;padding-bottom:14px}
.rtop img{width:132px;height:auto}
.rtop .id{text-align:right;font:600 11px/1.4 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#4b5f66}
.rtop .id b{display:block;font:800 26px/1 var(--f-display);letter-spacing:-.02em;color:#0b1d25;text-transform:none}
h1{font:850 28px/1.05 var(--f-display);font-variation-settings:"wdth" 112;letter-spacing:-.02em;margin:18px 0 4px}
h1 i{font-style:normal;color:#087f77}
.lead{color:#4b5f66;margin:0}
.old{margin:10px 0 0;padding:8px 12px;border:1px solid #f0b37e;background:#fff6ed;color:#7a3d06;font-weight:600}
h2{font:700 11px/1.4 var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:#087f77;margin:22px 0 6px;break-after:avoid;break-inside:avoid}
.facts{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #c7d0ce;margin:14px 0 0}
.facts div{padding:8px 10px;border-right:1px solid #c7d0ce}.facts div:nth-child(3n){border-right:0}
.facts div:nth-child(n+4){border-top:1px solid #c7d0ce}
.facts dt{font:600 9.5px/1.2 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#6c7c82}.facts dd{margin:2px 0 0;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:11.5px}th,td{padding:6px 7px;border-bottom:1px solid #dde3e1;text-align:left;vertical-align:top}
tr{break-inside:avoid}
th{font:600 9px/1.2 var(--f-mono);letter-spacing:.08em;text-transform:uppercase;color:#4b5f66;background:#eef1f0}
td.n,th.n{text-align:right;font-family:var(--f-mono);white-space:nowrap}td small{display:block;color:#6c7c82}
td.total{font-weight:800;color:#087f77}
tr.chosen td{background:#e7f5f3;border-top:2px solid #087f77;border-bottom:2px solid #087f77}
tr.chosen td:first-child{border-left:2px solid #087f77}tr.chosen td:last-child{border-right:2px solid #087f77}
.tag{display:inline-block;margin-top:3px;padding:1px 6px;background:#087f77;color:#fff;font:700 9px/1.4 var(--f-mono);letter-spacing:.08em;text-transform:uppercase}
td.pick{text-align:center}td.pick span{display:inline-block;width:16px;height:16px;border:1.5px solid #0b1d25}
.box{border:1px solid #c7d0ce;padding:10px 12px;white-space:pre-wrap;min-height:36px}
ul.res{margin:0;padding-left:18px}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:40px;break-inside:avoid}
.sign section{border:1px solid #c7d0ce;padding:10px 14px 14px}
.sign h3{margin:0 0 10px;font:700 11px/1.4 var(--f-mono);letter-spacing:.14em;text-transform:uppercase;color:#087f77}
.sign p{display:grid;grid-template-columns:76px 1fr;align-items:end;gap:8px;margin:14px 0 0;font-size:11.5px;color:#4b5f66}
.sign p span{border-bottom:1px solid #0b1d25;min-height:18px;color:#0b1d25;font-weight:600}
.sign p.sig span{min-height:40px}
.foot{margin-top:28px;font:500 10px/1.4 var(--f-mono);letter-spacing:.08em;color:#6c7c82;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.noprint{position:fixed;right:20px;top:20px;background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(3,22,31,.18)}
@media (max-width:700px){.facts{grid-template-columns:1fr 1fr}.facts div:nth-child(3n){border-right:1px solid #c7d0ce}.facts div:nth-child(2n){border-right:0}.facts div:nth-child(n+3){border-top:1px solid #c7d0ce}.sign{grid-template-columns:1fr}.sheet{padding:20px 16px 40px}.tw{overflow-x:auto}}
@media print{.noprint{display:none}.sheet{padding:0;max-width:none}@page{size:A4;margin:12mm}}
`;

export default async function RecoveryReport({params,searchParams}:{params:Promise<{id:string}>,searchParams:Search}){
 const {id}=await params,s=await searchParams;
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 const asked=one(s.versao),version=asked?Number(asked):undefined;
 let r:Awaited<ReturnType<typeof requestReport>>;
 // Mesmo limite das outras exportações; erros de negócio (403, 404, 429) aparecem com a própria mensagem.
 try{
  if(asked&&!(Number.isInteger(version)&&version!>0))throw new AppError('Versão do relatório inválida.');
  await rateLimit(member.id,'export');r=await requestReport(member,id,version);
 }catch(e){if(!(e instanceof AppError))throw e;return <main className="sheet"><style>{css}</style><p>{e.message}</p></main>;}
 await db().tx(tx=>audit(tx,member,'Exportação: relatório de recobrável',r.request.id,{number:r.request.number,version:r.version}));
 const d=r.snapshot.request as Row,quotes=r.snapshot.quotes as Row[];
 const chosen=r.chosenQuoteId&&quotes.some(q=>q.id===r.chosenQuoteId)?r.chosenQuoteId:null;
 const cols=chosen?9:10;

 return <main className="sheet"><style>{css}</style><PrintButton/>
  {/* eslint-disable-next-line @next/next/no-img-element -- Logo estático, mesmo arquivo na impressão. */}
  <div className="rtop"><img src="/logo-color.svg" alt="OceanPact LOG" width={240} height={118}/><div className="id">NAUTILUS · solicitação de recobrável<b>{d.rec}</b>Versão {r.version} · emitida em {dt(r.issuedAt)}</div></div>
  <h1>{d.activity}<i>.</i></h1>
  <p className="lead">{d.orgAcronym} · {d.org} · margem {pct(d.marginBp)} e impostos {pct(d.taxBp)} sobre o valor cotado</p>
  {r.version<r.latest&&<p className="old">Versão {r.version} de {r.latest}: há uma versão mais nova deste relatório.</p>}
  <dl className="facts">
   <div><dt>Solicitante</dt><dd>{d.orgAcronym} · {d.org}</dd></div>
   <div><dt>Pessoa solicitante</dt><dd>{d.person||'—'}</dd></div>
   <div><dt>Data prevista</dt><dd>{dt(d.plannedStart)}{d.plannedEnd?` → ${dt(d.plannedEnd)}`:''}</dd></div>
  </dl>
  {d.description&&<><h2>Descrição</h2><div className="box">{d.description}</div></>}
  <h2>Recursos</h2>
  {(d.resources as string[]).length?<ul className="res">{(d.resources as string[]).map((x,i)=><li key={i}>{x}</li>)}</ul>:<p className="lead">Sem recursos informados.</p>}
  {d.notes&&<><h2>Observações</h2><div className="box">{d.notes}</div></>}

  <h2>Cotações</h2>
  <div className="tw"><table><thead><tr><th>Fornecedor</th><th>Proposta</th><th>Validade</th><th>Prazo</th><th className="n">Valor cotado</th><th className="n">Margem</th><th className="n">Subtotal</th><th className="n">Impostos</th><th className="n">Valor a faturar</th>{!chosen&&<th>Escolha do cliente</th>}</tr></thead>
   <tbody>{quotes.map(q=>{const t=q.totals as Row;return <tr key={q.id} className={q.id===chosen?'chosen':undefined}>
    <td>{q.supplierName}{q.id===chosen&&<><br/><span className="tag">Escolhida pelo cliente</span></>}</td><td>{q.proposalNumber||'—'}</td><td>{day(q.validUntil)}</td><td>{q.leadTime||'—'}</td>
    <td className="n">{money(t.quotedCents)}</td><td className="n">{money(t.marginCents)}</td><td className="n">{money(t.subtotalCents)}</td><td className="n">{money(t.taxCents)}</td><td className="n total">{money(t.totalCents)}</td>
    {!chosen&&<td className="pick"><span/></td>}</tr>;})}
   {!quotes.length&&<tr><td colSpan={cols}>Sem cotações.</td></tr>}</tbody></table></div>
  {d.justification&&<><h2>Justificativa ({quotes.length} de 3 cotações)</h2><div className="box">{d.justification}</div></>}

  <div className="sign">
   {['Gestão Interna','Gestão do Cliente'].map(t=><section key={t}><h3>{t}</h3><p>Nome<span/></p><p>Cargo<span/></p><p>Data<span/></p><p className="sig">Assinatura<span/></p></section>)}
  </div>
  <div className="foot"><span>Versão {r.version} emitida em {dt(r.issuedAt)} por {r.issuedByName}</span><span>Impresso por {member.name} · horários de Brasília · NAUTILUS</span></div>
 </main>;
}
