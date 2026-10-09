import type {NextConfig} from 'next';

const dev=process.env.NODE_ENV!=='production';
const csp=[
 "default-src 'self'",
 // Next.js injeta scripts inline para hidratação; não há scripts de terceiros.
 `script-src 'self' 'unsafe-inline'${dev?" 'unsafe-eval'":''}`,
 "style-src 'self' 'unsafe-inline'",
 "img-src 'self' data:",
 "font-src 'self' data:",
 "connect-src 'self'",
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
