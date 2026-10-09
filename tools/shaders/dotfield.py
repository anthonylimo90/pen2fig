import numpy as np, sys
from PIL import Image
def h2(c): c=c.lstrip('#'); return np.array([int(c[i:i+2],16)/255 for i in (0,2,4)])
def fract(x): return x-np.floor(x)
def hsh(x,y): return fract(np.sin(x*127.1+y*311.7)*43758.5453123)
def noise(x,y):
    ix,iy=np.floor(x),np.floor(y); fx,fy=x-ix,y-iy
    a,b,c,d=hsh(ix,iy),hsh(ix+1,iy),hsh(ix,iy+1),hsh(ix+1,iy+1)
    ux,uy=fx*fx*(3-2*fx),fy*fy*(3-2*fy)
    return (a*(1-ux)+b*ux)*(1-uy)+(c*(1-ux)+d*ux)*uy
def fbm(x,y):
    v=0;a=.5
    for _ in range(5): v+=a*noise(x,y); x,y=x*2.03+11.3,y*2.03+7.1; a*=.5
    return v
def ss(e0,e1,x): t=np.clip((x-e0)/(e1-e0),0,1); return t*t*(3-2*t)
def render(W,H,base,dot,scale,flow,ds,bot,top,left,right,out,k=2):
    w,h=W*k,H*k
    X,Y=np.meshgrid(np.arange(w)+.5,np.arange(h)+.5); Y=h-Y
    ux,uy=X/w,Y/h; asp=w/h; px,py=ux*asp,uy
    f1=fbm(px*1.7,py*1.7); f2=fbm(px*2.6+5.2,py*2.6+1.3)
    gx=px*scale+(f1-.5)*flow*3; gy=py*scale+(f2-.5)*flow*3
    cx,cy=fract(gx)-.5,fract(gy)-.5; idx,idy=np.floor(gx),np.floor(gy)
    wave=fbm(idx/scale*1.9+2.7,idy/scale*1.9+4.1)
    ridge=np.sin(px*3.1-py*1.7+f1*5)*.5+.5
    amp=ss(.24,.82,wave*.6+ridge*.4)
    r=ds*(.30+1.25*amp); m=1-ss(r,r+.05,np.hypot(cx,cy))
    fade=bot+(top-bot)*uy; fade=fade*(left+(right-left)*ss(.4,.8,ux))
    t=(m*amp*fade)[...,None]
    img=h2(base)*(1-t)+h2(dot)*t
    Image.fromarray((img*255).round().astype('uint8')).save(out)
if __name__=="__main__":
    a=sys.argv
    sc,fl,dz=(map(float,a[10:13]) if len(a)>12 else (38,.8,.12))
    render(int(a[1]),int(a[2]),a[3],a[4],sc,fl,dz,*map(float,a[5:9]),a[9])
