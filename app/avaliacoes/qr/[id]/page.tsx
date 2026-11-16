// Avaliações · cartaz A4 com o QR code do questionário (impressão pelo navegador). Só para quem tem o acesso.
import type {Metadata} from 'next';
import {cookies,headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {quizDetail} from '@/lib/quiz';
import {qrSvg} from '@/lib/qr';
import {env} from '@/lib/db';
import {AppError} from '@/lib/domain';
import PrintButton from '../../../relatorio/[id]/print';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Cartaz do QR code · NAUTILUS',robots:{index:false,follow:false}};

const css=`
html,body{background:#fff!important;color:#0b1d25}
.poster{max-width:760px;margin:0 auto;padding:36px 32px;display:grid;gap:22px;justify-items:center;text-align:center;font:16px/1.45 var(--f-body);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.poster img.logo{width:170px;height:auto}
.poster h1{font:850 40px/1.05 var(--f-display);letter-spacing:-.02em;margin:0}
.poster .lead{font-size:20px;margin:0;color:#24414b;max-width:30ch}
.poster .qr{width:min(100%,430px);border:3px solid #0b1d25;border-radius:18px;padding:14px;background:#fff}
.poster .qr svg{display:block;width:100%;height:auto}
.poster ol{text-align:left;margin:0;padding-left:24px;font-size:17px;display:grid;gap:6px}
.poster .url{font:600 13px/1.4 var(--f-mono);color:#4b5f66;word-break:break-all;border-top:1px solid #c7d0ce;padding-top:12px;width:100%}
.noprint{position:fixed;right:18px;top:18px;background:#c8f25a;color:#0b1d25;border:0;border-radius:4px;padding:10px 16px;font-weight:700;cursor:pointer}
@media print{.noprint{display:none}.poster{padding:0}@page{size:A4 portrait;margin:14mm}}
`;

export default async function QuizPoster({params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 const member=await sessionMember((await cookies()).get(SESSION_COOKIE)?.value).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 let d:Awaited<ReturnType<typeof quizDetail>>;
 try{d=await quizDetail(member,id);}
 catch(e){if(!(e instanceof AppError))throw e;return <main className="poster"><style>{css}</style><p>{e.message}</p></main>;}
 const h=await headers(),host=h.get('x-forwarded-host')||h.get('host')||'';
 const origin=env().APP_URL?.replace(/\/$/,'')||`${h.get('x-forwarded-proto')||'https'}://${host}`;
 const url=origin+d.quiz.path;
 return <main className="poster"><style>{css}</style><PrintButton/>
  {/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático */}
  <img className="logo" src="/logo-color.svg" alt="OceanPact LOG"/>
  <h1>{d.quiz.title}</h1>
  <p className="lead">Aponte a câmera do celular para o código e responda a avaliação. Não precisa baixar nada nem criar conta.</p>
  <div className="qr" dangerouslySetInnerHTML={{__html:qrSvg(url)}}/>
  <ol><li>Abra a câmera do celular e aponte para o código.</li><li>Toque no link que aparecer.</li><li>Preencha seus dados, responda e veja o resultado na hora.</li></ol>
  <p className="url">{url}</p>
 </main>;
}
