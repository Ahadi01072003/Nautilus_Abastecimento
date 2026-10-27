// Apresentação para TV (Painel central › Apresentação): tela cheia com todas as OS do período,
// atualizada sozinha. A sessão e o acesso são conferidos aqui e em cada consulta (/api/tv).
import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import {loadAccess,canSeeOrders} from '@/lib/permissions';
import Tv from './tv';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Apresentação · NAUTILUS',robots:{index:false,follow:false}};

export default async function Apresentacao({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 const member=await sessionMember(token).catch(()=>null);
 if(!member||member.must_change_password)redirect('/');
 const access=await loadAccess(member).catch(()=>null);
 if(!access||!canSeeOrders(access))return <main style={{padding:40,fontFamily:'system-ui'}}><h1>Apresentação indisponível</h1><p>Seu acesso não inclui a consulta de OS.</p></main>;
 const s=await searchParams,d=Number(Array.isArray(s.dias)?s.dias[0]:s.dias);
 // Organização e filtros herdados da tela de origem (modo, ordem, solicitante, setor e Lista/Gantt).
 const q=new URLSearchParams();for(const k of ['modo','ordem','setores','sol','setor','vis']){const v=s[k];const x=Array.isArray(v)?v[0]:v;if(x)q.set(k,x.slice(0,4000));}
 return <Tv initialDays={[1,3,7,14].includes(d)?d:7} query={q.toString()}/>;
}
