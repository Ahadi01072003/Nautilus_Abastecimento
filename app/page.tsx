import {cookies} from 'next/headers';
import {SESSION_COOKIE,sessionMember} from '@/lib/auth';
import Workspace from './workspace';
import {LoginScreen,FirstAccessScreen} from './login';
export const dynamic='force-dynamic';

export default async function Home(){
 const token=(await cookies()).get(SESSION_COOKIE)?.value;
 let member:Awaited<ReturnType<typeof sessionMember>>=null,unavailable=false;
 try{member=await sessionMember(token);}catch{unavailable=true;}
 if(!member)return <LoginScreen unavailable={unavailable}/>;
 const identity={name:String(member.name),username:String(member.username)};
 if(member.must_change_password)return <FirstAccessScreen identity={identity}/>;
 return <Workspace identity={identity}/>;
}
