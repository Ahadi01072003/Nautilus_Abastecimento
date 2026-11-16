// Avaliações · link público do QR code (/q/<token>). Sem login: qualquer número de visitantes usa o
// mesmo link. O gabarito não chega à página; a correção acontece no envio.
import type {Metadata} from 'next';
import {headers} from 'next/headers';
import {publicQuiz} from '@/lib/quiz';
import {rateLimit,ipKey} from '@/lib/security';
import QuizRunner,{type RunnerQuiz} from '../../quiz-runner';
import '../../quiz-public.css';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Avaliação · OceanPact LOG',robots:{index:false,follow:false},referrer:'no-referrer'};

function Closed({title,message}:{title:string,message:string}){
 return <main className="qz-closed"><div>
  {/* eslint-disable-next-line @next/next/no-img-element -- logotipo estático */}
  <img src="/logo-color.svg" alt="OceanPact LOG"/><h1>{title}</h1><p>{message}</p></div></main>;
}

export default async function PublicQuiz({params}:{params:Promise<{token:string}>}){
 const {token}=await params;
 try{await rateLimit(ipKey(await headers()),'quiz_read');}
 catch{return <Closed title="Muitos acessos" message="Aguarde um minuto e abra o link de novo."/>;}
 let data:Awaited<ReturnType<typeof publicQuiz>>;
 try{data=await publicQuiz(token);}
 catch{return <Closed title="Sem conexão" message="Não foi possível abrir o questionário agora. Tente de novo em instantes."/>;}
 if(data.status!=='ok'||!('quiz' in data))return <Closed title="Questionário indisponível" message={('message' in data&&data.message)||'Questionário indisponível no momento.'}/>;
 return <QuizRunner token={token} quiz={data.quiz as RunnerQuiz}/>;
}
