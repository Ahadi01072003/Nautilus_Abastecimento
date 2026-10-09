import type {Metadata,Viewport} from 'next';
import './globals.css';

export const metadata:Metadata={
 title:'NAUTILUS · Abastecimentos',
 description:'Registro de abastecimentos, controle de estoque e reposições da Base Açu.',
 icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'},
 robots:{index:false,follow:false},
};
export const viewport:Viewport={themeColor:'#071D2B',width:'device-width',initialScale:1};

export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){
 return <html lang="pt-BR"><body className="antialiased">{children}</body></html>;
}
