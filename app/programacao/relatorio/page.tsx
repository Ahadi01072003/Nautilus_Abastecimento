// Relatório da reunião das 16h: o dia consolidado (as duas barras), com HH, ordem, recursos, participantes e
// observações. Impressão pelo navegador (A4) ou Salvar como PDF. Mostra a versão pedida ou a última.
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {d1Consolidated} from '@/lib/d1';
import {AppError} from '@/lib/domain';
import {dayText} from '@/lib/days';
import PrintButton from '../../relatorio/[id]/print';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Relatório de planejamento · NAUTILUS',robots:{index:false,follow:false}};

type R=Record<string,any>;// eslint-disable-line @typescript-eslint/no-explicit-any -- retrato consolidado (JSON)
const h=(n:number)=>Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const WEEK=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const at=(iso:string)=>new Date(iso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const css=`
html,body{background:#fff!important;color:#0b1d25}
.sheet{max-width:880px;margin:0 auto;padding:28px 28px 48px;font:13px/1.45 var(--f-body)}
.top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #03161f;padding-bottom:12px}
.top img{width:132px}.top div{text-align:right;font:600 11px/1.4 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;color:#4b5f66}.top b{display:block;font:800 20px/1.1 var(--f-display);color:#0b1d25;text-transform:none;letter-spacing:0}
h1{font:850 24px/1.1 var(--f-display);margin:16px 0 2px}.lead{margin:0;color:#4b5f66}
h2{font:700 11px/1.4 var(--f-mono);letter-spacing:.16em;text-transform:uppercase;color:#087f77;margin:20px 0 6px}
table{width:100%;border-collapse:collapse}th{font:700 10px/1.2 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:#4b5f66;text-align:left;background:#eef1f0;padding:6px 8px;border-bottom:1px solid #9fb0ad}
td{padding:6px 8px;border-bottom:1px solid #dde3e1;vertical-align:top}td.n,th.n{text-align:right}td.ok{width:70px}
.box{display:inline-block;width:14px;height:14px;border:1.5px solid #0b1d25;border-radius:3px}
tr{break-inside:avoid}.muted{color:#6c7c82}
.noprint{position:fixed;right:18px;top:18px;background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer}
@media print{.noprint{display:none}.sheet{padding:0}@page{size:A4 portrait;margin:14mm}}
`;
const extra=`.bar{margin-top:18px;border-top:3px solid var(--c);padding-top:6px}.bar h2{color:var(--c)}.sum{margin:0 0 6px;color:#4b5f66}.em{color:#B42318;font-weight:700}
.res{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:8px}.res ul{margin:2px 0;padding-left:16px}.notes{white-space:pre-wrap;border:1px solid #dde3e1;border-radius:6px;padding:8px 10px}`;

export default async function Relatorio({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const member=await sessionMember((await cookies()).get(SESSION_COOKIE)?.value).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 const s=await searchParams,one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
 let p:Awaited<ReturnType<typeof d1Consolidated>>;
 const bar=one(s.bar)==='ocp'?'ocp':'equinor';
 try{p=await d1Consolidated(member,new URL(`http://x/?bar=${bar}&day=${encodeURIComponent(one(s.day))}${one(s.version)?`&version=${encodeURIComponent(one(s.version))}`:''}`));}
 catch(e){if(!(e instanceof AppError))throw e;return <main className="sheet"><style>{css}</style><p>{e.message}</p></main>;}
 const snap=p.snapshot as R|null,wd=new Date(p.day+'T12:00:00Z').getUTCDay();
 return <main className="sheet"><style>{css+extra}</style><PrintButton/>
  <div className="top">
   {/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático */}
   <img src="/logo-color.svg" alt="OceanPact LOG"/><div>Relatório de planejamento · barra {p.barName}<b>{WEEK[wd]}, {dayText(p.day)}</b></div></div>
  {!snap?<><h1>Relatório de planejamento</h1><p className="lead">A barra {p.barName} de {dayText(p.day)} ainda não foi consolidada.</p></>:<>
   <h1>Relatório de planejamento</h1>
   <p className="lead">Consolidado em {at(p.consolidatedAt!)} por {p.consolidatedBy}{p.version!>1?` · versão ${p.version}`:''}. Participantes: {(p.participants as string[]).join(', ')}.</p>
   {[bar].map(b=>{const x=snap;const r=x.resources as R;
    return <section key={b} className="bar" style={{['--c' as string]:b==='ocp'?'#14254A':'#B3261E'}}>
     <h2>Barra {b==='ocp'?'OCP':'Equinor'}</h2>
     <p className="sum">HH {h(x.demandHh)} de {h(x.staff.hh)} ({x.staff.hh>0?Math.round(x.demandHh/x.staff.hh*100):0}%){x.extraHh>0?` · ${h(x.extraHh)} HH além do limite`:''} · Duração programada {h(x.durationTotal)} h · {x.cards.length} atividade{x.cards.length===1?'':'s'}</p>
     {(x.cards as R[]).length?<table><thead><tr><th>#</th><th>OS</th><th>Atividade</th><th>Solicitante</th><th className="n">Duração</th><th className="n">Pessoas</th><th className="n">HH</th></tr></thead>
      <tbody>{(x.cards as R[]).map(c=><tr key={c.planId}><td>{c.position}</td><td><b>{c.label}</b>{c.emergency?<><br/><span className="em">Emergencial</span></>:null}</td><td>{c.title}{c.location?<><br/><span className="muted">{c.location}</span></>:null}</td><td>{c.org?.acronym||'—'}</td><td className="n">{h(c.hours)} h</td><td className="n">{c.people}</td><td className="n">{h(c.hh)}</td></tr>)}</tbody></table>
      :<p className="muted">Nenhuma OS consolidada nesta barra.</p>}
     <div className="res">
      <div><b>Funções</b><ul>{(r.functions as R[]).map(f=><li key={f.name}>{f.name} · {f.activities} atividade{f.activities>1?'s':''} · até {f.maxPeople}</li>)}{!(r.functions as R[]).length&&<li>—</li>}</ul></div>
      <div><b>Equipamentos</b><ul>{(r.equipment as R[]).map(e=><li key={e.tag}>{e.tag} · {h(e.hours)} h{e.over?' · acima da jornada':''}{e.impeded?' · impedimento técnico':''}</li>)}{!(r.equipment as R[]).length&&<li>—</li>}</ul></div>
      <div><b>Materiais</b><ul>{(r.materials as R[]).map(m=><li key={m.name+m.unit}>{m.name} · {h(m.amount)} {m.unit}</li>)}{!(r.materials as R[]).length&&<li>—</li>}</ul></div>
     </div>
    </section>;})}
   <h2>Observações da reunião</h2>
   <p className="notes">{p.notes||'—'}</p>
  </>}
 </main>;
}
