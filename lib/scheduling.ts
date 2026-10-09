import {AppError,required} from './domain';

export function scheduledDate(value:unknown){
 const date=new Date(required(value,'Data e hora do agendamento'));
 if(!Number.isFinite(date.valueOf()))throw new AppError('Data de agendamento inválida.');
 if(date.valueOf()<Date.now()-60000)throw new AppError('Escolha uma data e hora futura para o agendamento.');
 return date.toISOString();
}
export function appointmentVersion(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<0)throw new AppError('Atualize a solicitação antes de continuar.',409);return Number(value);}
