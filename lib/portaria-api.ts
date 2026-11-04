// Portaria · tabela de rotas (GET e POST) usada por app/api/[...path]/route.ts.
import {type Member} from './permissions';
import {fail} from './portaria-core';
import {searchCompanies,searchPeople,personDetail,pendingReview,registryList,portariaPeopleMutate} from './portaria-people';
import {presentNow,dayReport,portariaCoreMutate} from './portaria';
import {reportCheck,listReports,reportVersions,reportVersion,portariaReportMutate} from './portaria-reports';
import {listVisits,visitDetail,portariaVisitMutate} from './portaria-visits';
import {portariaDashboard} from './portaria-dashboard';

const notFound=()=>fail(404,'ROUTE_NOT_FOUND','Página não encontrada.');

export async function portariaGet(path:string,url:URL,member:Member):Promise<unknown>{
 switch(path){
  case 'portaria/people':return searchPeople(member,url);
  case 'portaria/companies':return searchCompanies(member,url);
  case 'portaria/person':return personDetail(member,url.searchParams.get('id')||'');
  case 'portaria/present':return presentNow(member);
  case 'portaria/visits':return listVisits(member,url);
  case 'portaria/visit':return visitDetail(member,url);
  case 'portaria/report':return dayReport(member,url);
  case 'portaria/reports':return listReports(member,url);
  case 'portaria/report/versions':return reportVersions(member,url);
  case 'portaria/report/version':return reportVersion(member,url);
  case 'portaria/report/check':return reportCheck(member,url);
  case 'portaria/dashboard':return portariaDashboard(member,url);
  case 'portaria/pending-review':return pendingReview(member,url);
  case 'portaria/registry':return registryList(member,url);
 }
 throw notFound();
}

export async function portariaPost(path:string,body:Record<string,unknown>,member:Member):Promise<unknown>{
 for(const run of [portariaPeopleMutate,portariaCoreMutate,portariaReportMutate,portariaVisitMutate]){
  const r=await run(path,body,member);
  if(r!==null&&r!==undefined)return r;
 }
 throw notFound();
}
