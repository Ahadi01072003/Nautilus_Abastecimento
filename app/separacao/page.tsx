// Lista de separação do D+1 publicado (P3): materiais e equipamentos de cada OS do dia e o total por material,
// para a Ferramentaria e o almoxarifado prepararem. Impressão pelo navegador (A4). Usa a versão publicada.
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {d1Consolidated} from '@/lib/d1';
import {AppError} from '@/lib/domain';
import {dayText} from '@/lib/days';
import PrintButton from '../relatorio/[id]/print';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Lista de separação · NAUTILUS',robots:{index:false,follow:false}};

type R=Record<string,any>;// eslint-disable-line @typescript-eslint/no-explicit-any -- retrato publicado (JSON)
const h=(n:number)=>Number(n).toLocaleString('pt-BR',{maximumFractionDigits:3});
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

export default async function Separacao({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const member=await sessionMember((await cookies()).get(SESSION_COOKIE)?.value).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 const s=await searchParams,one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
 const bar=one(s.bar)==='ocp'?'ocp':'equinor',barName=bar==='ocp'?'OCP':'Equinor';
 let p:Awaited<ReturnType<typeof d1Consolidated>>;
 try{p=await d1Consolidated(member,new URL(`http://x/?bar=${bar}&day=${encodeURIComponent(one(s.day))}`));}
 catch(e){if(!(e instanceof AppError))throw e;return <main className="sheet"><style>{css}</style><p>{e.message}</p></main>;}
 const snap=p.snapshot as R|null;
 return <main className="sheet"><style>{css}</style><PrintButton/>
  <div className="top">
   {/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático */}
   <img src="/logo-color.svg" alt="OceanPact LOG"/><div>Lista de separação · barra {barName}<b>{dayText(p.day)}</b></div></div>
  {!snap?<><h1>Lista de separação</h1><p className="lead">A barra {barName} de {dayText(p.day)} ainda não foi consolidada.</p></>:<>
   <h1>Lista de separação</h1>
   <p className="lead">Consolidada por {p.consolidatedBy}{p.version!>1?` (versão ${p.version})`:''}. {(snap.cards as R[]).length} OS no dia.</p>
   <h2>Total por material</h2>
   {(snap.resources.materials as R[]).length?<table><thead><tr><th>Material</th><th className="n">Quantidade</th><th>Separado</th></tr></thead>
    <tbody>{(snap.resources.materials as R[]).map(m=><tr key={m.name+m.unit}><td>{m.name}</td><td className="n">{h(m.amount)} {m.unit}</td><td className="ok"><span className="box"/></td></tr>)}</tbody></table>:<p className="muted">Nenhum material informado nas OS do dia.</p>}
   <h2>Por OS</h2>
   <table><thead><tr><th>#</th><th>OS</th><th>Materiais</th><th>Equipamentos</th><th>Separado</th></tr></thead>
    <tbody>{(snap.cards as R[]).map(c=><tr key={c.planId}><td>{c.position}</td><td><b>{c.label}</b>{c.emergency?' · Emergencial':''}<br/>{c.title}{c.location?<><br/><span className="muted">{c.location}</span></>:null}</td>
     <td>{(c.materials as R[]).length?(c.materials as R[]).map((m,i)=><div key={i}>{h(m.amount)} {m.unit} {m.name}</div>):<span className="muted">—</span>}</td>
     <td>{(c.equipment as R[]).length?(c.equipment as R[]).map((e,i)=><div key={i}>{e.tag} · {h(c.hours)} h</div>):<span className="muted">—</span>}</td>
     <td className="ok"><span className="box"/></td></tr>)}</tbody></table>
  </>}
 </main>;
}
