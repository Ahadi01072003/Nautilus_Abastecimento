'use client';
import {useEffect,useRef} from 'react';

/** Contornos batimétricos animados (isolinhas de um campo suave, por marching squares). */
export default function Bathy(){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const cv=ref.current,ctx=cv?.getContext('2d');
  if(!cv||!ctx)return;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w=0,h=0,t=0,raf=0,last=0;
  const size=()=>{const r=cv.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1);w=r.width;h=r.height;cv.width=w*d;cv.height=h*d;ctx.setTransform(d,0,0,d,0,0);};
  const f=(x:number,y:number)=>Math.sin(x*.011+t)*1.1+Math.sin(y*.0085-t*.6)*1.3+Math.sin((x+y)*.006+t*.4)*.9+Math.cos((x-y*.6)*.013-t*.3)*.6;
  const LV=[-2.4,-1.6,-.8,0,.8,1.6,2.4];
  const SEG:Record<number,[number,number][]>={1:[[3,0]],2:[[0,1]],3:[[3,1]],4:[[1,2]],5:[[3,0],[1,2]],6:[[0,2]],7:[[3,2]],8:[[2,3]],9:[[0,2]],10:[[0,1],[2,3]],11:[[1,2]],12:[[1,3]],13:[[0,1]],14:[[0,3]]};
  const draw=()=>{
   ctx.clearRect(0,0,w,h);
   const s=10,nx=Math.ceil(w/s)+1,ny=Math.ceil(h/s)+1,v=new Float32Array(nx*ny);
   for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)v[j*nx+i]=f(i*s,j*s);
   LV.forEach((lv,li)=>{
    ctx.strokeStyle=li===3?'rgba(200,242,90,.16)':`rgba(70,200,210,${.07+.02*(3-Math.abs(li-3))})`;
    ctx.lineWidth=li===3?1.2:1;ctx.beginPath();
    for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){
     const a=v[j*nx+i],b=v[j*nx+i+1],c=v[(j+1)*nx+i+1],d=v[(j+1)*nx+i];
     const code=(a>lv?1:0)|(b>lv?2:0)|(c>lv?4:0)|(d>lv?8:0);
     if(code===0||code===15)continue;
     const x=i*s,y=j*s,l=(p:number,q:number)=>(lv-p)/(q-p);
     const e=[[x+s*l(a,b),y],[x+s,y+s*l(b,c)],[x+s*l(d,c),y+s],[x,y+s*l(a,d)]];
     for(const [p,q] of SEG[code]){ctx.moveTo(e[p][0],e[p][1]);ctx.lineTo(e[q][0],e[q][1]);}
    }
    ctx.stroke();
   });
  };
  const loop=(ts:number)=>{raf=requestAnimationFrame(loop);if(ts-last<66)return;last=ts;t+=.012;draw();};
  const resize=()=>{size();draw();};
  const vis=()=>{cancelAnimationFrame(raf);if(!document.hidden&&!reduce)raf=requestAnimationFrame(loop);};
  size();draw();
  addEventListener('resize',resize);
  if(!reduce){raf=requestAnimationFrame(loop);document.addEventListener('visibilitychange',vis);}
  return ()=>{cancelAnimationFrame(raf);removeEventListener('resize',resize);document.removeEventListener('visibilitychange',vis);};
 },[]);
 return <canvas ref={ref} aria-hidden="true"/>;
}
