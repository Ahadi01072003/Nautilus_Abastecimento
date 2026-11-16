// Programação publicada do D+1 (P3): o que a reunião das 16:00 publicou, por barra. Serve à TV (tela cheia,
// atualiza sozinha) e ao celular do líder. Mostra só versões publicadas; mudanças não publicadas não aparecem.
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import ProgramView from './view';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Programação do dia · NAUTILUS',robots:{index:false,follow:false}};

export default async function Programacao({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const member=await sessionMember((await cookies()).get(SESSION_COOKIE)?.value).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 const s=await searchParams,one=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]:v||'';
 const bar=one(s.bar),day=one(s.day);
 return <ProgramView bar={bar==='ocp'||bar==='equinor'?bar:''} day={/^\d{4}-\d{2}-\d{2}$/.test(day)?day:''}/>;
}
