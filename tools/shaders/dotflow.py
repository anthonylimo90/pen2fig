import numpy as np, sys
from PIL import Image
exec(open(__file__.replace("dotflow.py","dotfield.py")).read().split("def render")[0])
def render(W,H,base,deep,dot,scale,flow,ds,out,k=2):
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
    t1=ss(0,1,uy*.85+.15)[...,None]
    field=h2(deep)*(1-t1)+h2(base)*t1
    fade=.92+(.30-.92)*uy
    t=(m*amp*fade)[...,None]
    img=field*(1-t)+h2(dot)*t
    Image.fromarray((np.clip(img,0,1)*255).round().astype('uint8')).save(out)
if __name__=="__main__":
    a=sys.argv; render(int(a[1]),int(a[2]),a[3],a[4],a[5],float(a[6]),float(a[7]),float(a[8]),a[9])
