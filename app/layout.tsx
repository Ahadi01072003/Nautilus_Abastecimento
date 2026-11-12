import type {Metadata,Viewport} from 'next';
import {Archivo,Instrument_Sans,JetBrains_Mono} from 'next/font/google';
import './globals.css';

// Identidade Sonar: display expandida, texto humanista e números monoespaçados (fontes servidas pelo próprio site).
const archivo=Archivo({subsets:['latin'],axes:['wdth'],variable:'--font-archivo',display:'swap'});
const instrument=Instrument_Sans({subsets:['latin'],variable:'--font-instrument',display:'swap'});
const jetbrains=JetBrains_Mono({subsets:['latin'],variable:'--font-jetbrains',display:'swap'});

export const metadata:Metadata={
 title:'NAUTILUS · Gestão operacional',
 description:'Abastecimento, planejamento, operação e cadastros da Base Açu · OceanPact LOG.',
 icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'},
 robots:{index:false,follow:false},
};
export const viewport:Viewport={themeColor:'#03161F',width:'device-width',initialScale:1};

export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){
 // Ambiente de teste (ramo "teste", banco separado): faixa sempre visível para não confundir com o sistema oficial.
 const test=process.env.NAUTILUS_AMBIENTE==='teste';
 return <html lang="pt-BR" className={`${archivo.variable} ${instrument.variable} ${jetbrains.variable}`}><body className="antialiased">{children}
  {test&&<div className="env-test" role="note">Ambiente de teste · dados copiados da produção · nada aqui afeta o sistema oficial</div>}</body></html>;
}
