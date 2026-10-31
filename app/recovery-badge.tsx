// Selo da OS ligada a uma solicitação de recobrável (Lista de OS e cabeçalho da OS): o número para
// todos; fornecedor e valor a faturar só chegam do servidor para quem tem acesso Financeiro.
import {recNumber} from '@/lib/recovery-quote';
import {brl} from './finance';

export function RecoveryBadge({number,supplier,totalCents}:{number:number,supplier?:string|null,totalCents?:number|null}){
 return <span className="rq-badge" title="Atividade recobrável"><b>Recobrável {recNumber(number)}</b>{supplier?<span>{supplier}</span>:null}{totalCents!=null?<span>{brl(Number(totalCents))}</span>:null}</span>;
}
