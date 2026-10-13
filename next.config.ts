import type {NextConfig} from 'next';

const dev=process.env.NODE_ENV!=='production';
// Anexos: envio e visualização direto no armazenamento privado (URLs assinadas e temporárias).
const storage=process.env.STORAGE_ORIGIN||'https://jmcghnptoagvjcgugzlf.supabase.co';
const csp=[
 "default-src 'self'",
 // Next.js injeta scripts inline para hidratação; não há scripts de terceiros.
 `script-src 'self' 'unsafe-inline'${dev?" 'unsafe-eval'":''}`,
 "style-src 'self' 'unsafe-inline'",
 `img-src 'self' data: ${storage}`,
 "font-src 'self' data:",
 `connect-src 'self' ${storage}`,
 `frame-src ${storage}`,
 "object-src 'none'",
 "base-uri 'self'",
 "form-action 'self'",
 "frame-ancestors 'none'",
].join('; ');

const nextConfig:NextConfig={
 poweredByHeader:false,
 async headers(){
  return [{source:'/:path*',headers:[
   {key:'Content-Security-Policy',value:csp},
   {key:'X-Content-Type-Options',value:'nosniff'},
   {key:'Referrer-Policy',value:'no-referrer'},
   {key:'X-Frame-Options',value:'DENY'},
   {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
   {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'},
  ]}];
 },
};
export default nextConfig;
