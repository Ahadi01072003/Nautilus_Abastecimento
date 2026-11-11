// Termo de empréstimo da Ferramentaria (A4, impressão pelo navegador) e comprovante de devolução
// (?devolucao=ID). Campos de assinatura do Responsável OCP e do Responsável da terceirizada: com a
// assinatura feita na tela, ela aparece; sem ela, linhas em branco para assinar no papel.
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {loanPrint} from '@/lib/tools-loans';
import {db,type Row} from '@/lib/db';
import {audit} from '@/lib/registry';
import {rateLimit} from '@/lib/security';
import {AppError} from '@/lib/domain';
import PrintButton from '../../../relatorio/[id]/print';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Termo de empréstimo · NAUTILUS',robots:{index:false,follow:false}};

type Search=Promise<Record<string,string|string[]|undefined>>;
const one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
const TZ='America/Sao_Paulo';
const f=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const dt=(v:unknown)=>v?f.format(new Date(String(v))).replace(',',''):'—';
const day=(v:unknown)=>{const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(v||''));return m?`${m[3]}/${m[2]}/${m[1]}`:'—';};
const q=(n:number)=>n.toLocaleString('pt-BR',{maximumFractionDigits:3});
const KIND:Record<string,string>={ferramenta:'Ferramenta',material:'Material'};

const css=`
html,body{background:#fff!important;color:#0b1d25}
body{font:13px/1.45 var(--f-body)}
.sheet{max-width:860px;margin:0 auto;padding:28px 28px 48px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rtop{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:3px solid #03161f;padding-bottom:14px}
.rtop img{width:132px;height:auto}
.rtop .id{text-align:right;font:600 11px/1.4 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#4b5f66}
.rtop .id b{display:block;font:800 26px/1 var(--f-display);letter-spacing:-.02em;color:#0b1d25;text-transform:none}
h1{font:850 26px/1.05 var(--f-display);letter-spacing:-.02em;margin:18px 0 4px}
.lead{color:#4b5f66;margin:0}
.warn{margin:10px 0 0;padding:8px 12px;border:1px solid #d0d5dd;background:#f2f4f7;font-weight:600}
h2{font:700 11px/1.4 var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:#087f77;margin:22px 0 6px}
.facts{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #c7d0ce;margin:14px 0 0}
.facts div{padding:8px 10px;border-right:1px solid #c7d0ce;border-bottom:1px solid #c7d0ce}
.facts dt{font:600 10px/1.2 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#6c7c82}
.facts dd{margin:3px 0 0;font-weight:700}
.facts .wide{grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{font:700 10px/1.2 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#4b5f66;text-align:left;background:#eef1f0;padding:7px 8px;border-bottom:1px solid #9fb0ad}
td{padding:7px 8px;border-bottom:1px solid #dde3e1}td.n,th.n{text-align:right}
tr{break-inside:avoid}
.decl{margin:18px 0 0;font-size:13px}
.signs{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:34px;break-inside:avoid}
.sign{display:grid;justify-items:center;text-align:center;gap:4px}
.sign .img{height:86px;display:flex;align-items:flex-end;justify-content:center;width:100%}
.sign img{max-height:86px;max-width:100%}
.sign .line{border-top:1px solid #0b1d25;width:100%;padding-top:6px}
.sign b{display:block}.sign small{color:#4b5f66}
.foot{margin-top:26px;display:flex;justify-content:space-between;gap:12px;font:500 10.5px/1.3 var(--f-mono);color:#6c7c82;border-top:1px solid #c7d0ce;padding-top:8px}
.noprint{position:fixed;right:18px;top:18px;background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer}
@media print{.noprint{display:none}.sheet{padding:0}@page{size:A4 portrait;margin:14mm}}
`;

export default async function LoanTerm({params,searchParams}:{params:Promise<{id:string}>,searchParams:Search}){
 const {id}=await params,s=await searchParams,returnId=one(s.devolucao)||undefined;
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 let r:Awaited<ReturnType<typeof loanPrint>>;
 try{await rateLimit(member.id,'export');r=await loanPrint(member,id,returnId);}
 catch(e){if(!(e instanceof AppError))throw e;return <main className="sheet"><style>{css}</style><p>{e.message}</p></main>;}
 const loan=r.loan as Row,ret=r.ret as Row|null;
 await db().tx(tx=>audit(tx,member,'Exportação: termo de empréstimo',loan.id,{code:loan.code,return:ret?Number(ret.number):undefined}));
 const sig=ret?{ocp:ret.ocp_signature as string|null,contractor:ret.contractor_signature as string|null}:r.signatures;
 const retLines=ret?((r.returns as Row[]).find(x=>x.id===ret.id)?.lines||[]) as Row[]:[];
 const title=ret?`Comprovante de devolução ${ret.number}`:'Termo de empréstimo';
 return <main className="sheet"><style>{css}</style><PrintButton/>
  <div className="rtop">
   {/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático */}
   <img src="/logo-color.svg" alt="OceanPact LOG"/>
   
   <div className="id">Ferramentaria · Base Açu<b>{loan.code}</b></div></div>
  <h1>{title}</h1>
  <p className="lead">{ret?`Registrada em ${dt(ret.created_at)} por ${ret.created_by_name}.`:`Emitido em ${dt(loan.issuedAt)} por ${loan.issuedByName}.`}</p>
  {loan.status==='cancelado'&&<p className="warn">Empréstimo cancelado em {dt(loan.cancelledAt)}: {loan.cancelReason}</p>}
  <dl className="facts">
   <div><dt>Terceirizada</dt><dd>{loan.contractorName}</dd></div><div><dt>Responsável da terceirizada</dt><dd>{loan.contractorPerson}</dd></div><div><dt>Responsável OCP</dt><dd>{loan.ocpName}</dd></div>
   <div><dt>Devolução prevista</dt><dd>{day(loan.expectedReturn)}</dd></div><div><dt>Situação</dt><dd>{({emitido:'Emitido',parcial:'Devolução parcial',encerrado:'Encerrado',cancelado:'Cancelado'} as Record<string,string>)[loan.status]}</dd></div><div><dt>Impresso em</dt><dd>{dt(new Date().toISOString())}</dd></div>
   <div className="wide"><dt>Finalidade</dt><dd>{loan.purpose}</dd></div>
   {ret?.note&&<div className="wide"><dt>Observação da devolução</dt><dd>{ret.note}</dd></div>}
  </dl>
  <h2>{ret?'Itens desta devolução':'Itens emprestados'}</h2>
  {ret?<table><thead><tr><th>Item</th><th>Tipo</th><th className="n">Devolvido</th><th className="n">Danificado</th><th className="n">Perdido</th><th className="n">Consumido</th><th>Un.</th></tr></thead><tbody>
    {retLines.map((l,i)=><tr key={i}><td>{l.itemName}</td><td>{KIND[l.kind]}</td><td className="n">{q(l.returned)}</td><td className="n">{q(l.damaged)}</td><td className="n">{q(l.lost)}</td><td className="n">{q(l.consumed)}</td><td>{l.unitAbbr}</td></tr>)}</tbody></table>
   :<table><thead><tr><th>Item</th><th>Tipo</th><th className="n">Quantidade</th><th>Un.</th></tr></thead><tbody>
    {(r.lines as Row[]).map(l=><tr key={l.id}><td>{l.itemName}</td><td>{KIND[l.kind]}{l.kind==='material'?' (consumível)':''}</td><td className="n">{q(l.out)}</td><td>{l.unitAbbr}</td></tr>)}</tbody></table>}
  <p className="decl">{ret?'Declaramos a devolução dos itens acima nas condições indicadas.'
   :`Declaro ter recebido os itens acima em perfeito estado de conservação e funcionamento, comprometendo-me a devolver as ferramentas até ${day(loan.expectedReturn)} nas mesmas condições e a responder por danos ou perdas. Materiais consumíveis são de uso no serviço indicado; a sobra deve ser devolvida.`}</p>
  <div className="signs">
   <div className="sign"><div className="img">
    {sig.ocp&&<>
     {/* eslint-disable-next-line @next/next/no-img-element -- assinatura feita na tela (data URL) */}
     <img src={sig.ocp} alt="Assinatura do responsável OCP"/>
    </>}
   </div><div className="line"><b>{loan.ocpName}</b><small>Responsável OCP</small></div></div>
   <div className="sign"><div className="img">
    {sig.contractor&&<>
     {/* eslint-disable-next-line @next/next/no-img-element -- assinatura feita na tela (data URL) */}
     <img src={sig.contractor} alt="Assinatura do responsável da terceirizada"/>
    </>}
   </div><div className="line"><b>{loan.contractorPerson}</b><small>Responsável da terceirizada · {loan.contractorName}</small></div></div>
  </div>
  <div className="foot"><span>NAUTILUS · Ferramentaria · Base Açu</span><span>{loan.code}{ret?` · devolução ${ret.number}`:''}</span></div>
 </main>;
}
