/* Atlas weather sky: WebGL sky that mixes clear, cloud, rain, wind, fog and night and eases
   between any two mixes. window.AtlasSky.mount(canvas) → { set(target), jump(target), pos(x, y), destroy() }
   target: { cloud, rain, wind, sun, night, fog } (0–1). pos: light source in 0–1 canvas coords (y up). */
(function () {
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FS = `precision highp float;
uniform vec2 uRes,uSP;uniform float uT,uCloud,uRain,uWind,uSun,uNight,uFog;
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<6;i++){v+=a*n(p);p=m*p;a*=.5;}return v;}
float stars(vec2 q,float sc,float th){vec2 g=q*sc,id=floor(g),f=fract(g)-.5;float r=h(id);vec2 o=vec2(h(id+3.1),h(id+7.7))-.5;float d=length(f-o*.7);float b=smoothstep(.06+.05*r,.0,d)*step(th,r);return b*(.5+.5*r);}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;float asp=uRes.x/uRes.y;vec2 q=vec2(uv.x*asp,uv.y);
  float storm=clamp(uRain*1.1+uCloud*.25,0.,1.);
  vec3 dayTop=mix(vec3(.13,.38,.80),vec3(.34,.38,.44),uCloud);dayTop=mix(dayTop,vec3(.17,.19,.23),storm*.9);
  vec3 dayHor=mix(vec3(.60,.78,.95),vec3(.64,.67,.71),uCloud);dayHor=mix(dayHor,vec3(.30,.33,.37),storm*.85);
  vec3 nTop=vec3(.012,.02,.055),nHor=mix(vec3(.06,.08,.17),vec3(.10,.10,.13),uCloud);
  vec3 top=mix(dayTop,nTop,uNight),hor=mix(dayHor,nHor,uNight);
  vec3 col=mix(hor,top,pow(uv.y,.75));
  col+=vec3(.55,.32,.14)*uNight*(1.-uCloud*.5)*smoothstep(.45,0.,uv.y)*.18;
  vec2 sp=vec2(uSP.x*asp,uSP.y);float d=length(q-sp);
  float sunVis=uSun*(1.-uNight)*(1.-uCloud*.7)*(1.-storm*.8);
  col+=vec3(1.,.85,.58)*(exp(-d*5.)*.5+exp(-d*18.)*.6)*sunVis;
  float moonVis=uNight*(1.-uCloud*.8)*(1.-uRain*.7);col+=vec3(.72,.78,.95)*(exp(-d*9.)*.22+exp(-d*30.)*.25)*moonVis;
  float clr=uNight*(1.-uCloud)*(1.-uRain)*smoothstep(.12,.7,uv.y);
  vec2 mw=vec2(q.x*.8+q.y*.55,q.y-q.x*.35);float band=exp(-pow((mw.y-.35)*4.2,2.))*fbm(mw*4.+3.);
  col+=vec3(.45,.48,.62)*band*clr*.22;
  float tw=.65+.35*sin(uT*2.3+h(floor(q*300.))*40.);
  col+=vec3(.95,.97,1.)*(stars(q,90.,.86)*.9*tw+stars(q,220.,.9)*.6+stars(q,420.,.82)*.35)*clr*(1.-exp(-d*6.)*.8);
  float sp1=uT*(.010+uWind*.075);vec2 cq=q*vec2(1.5,2.5)+vec2(sp1,0.);
  float warp=fbm(cq*.5+vec2(sp1*.3,0.));float c1=fbm(cq+warp*.7);float c2=fbm(cq*2.3+vec2(sp1*1.7,3.1)+warp);
  float thr=mix(.80,.26,uCloud);float dens=smoothstep(thr,thr+.32,c1*.72+c2*.38);dens*=smoothstep(-.1,.4,uv.y+.2);
  float shade=fbm(cq+vec2(0.,-.07))-c1;
  vec3 cLit=mix(vec3(1.,.98,.95),vec3(.62,.64,.68),storm);cLit=mix(cLit,vec3(.13,.14,.19),uNight);
  vec3 cDark=mix(vec3(.58,.62,.69),vec3(.18,.20,.24),storm);cDark=mix(cDark,vec3(.035,.04,.06),uNight);
  vec3 cc=mix(cLit,cDark,clamp(.5+shade*4.5,0.,1.));cc+=vec3(1.,.86,.66)*exp(-d*3.5)*sunVis*.4;cc+=vec3(.6,.66,.85)*exp(-d*6.)*moonVis*.25;
  col=mix(col,cc,dens*(.5+.5*uCloud));
  col=mix(col,mix(vec3(.42,.45,.5),vec3(.07,.08,.1),uNight),uRain*.35*smoothstep(1.,.1,uv.y));
  float sl=-(.015+uWind*.07);vec2 ru=vec2(uv.x+uv.y*sl,uv.y);float rain=0.;
  for(int i=0;i<4;i++){float fi=float(i);float z=1.+fi*.75;vec2 g=vec2(ru.x*(70.+fi*48.)*asp,ru.y*(1.6+fi*.5)+uT*(2.6+fi*.7)/z);float col_=floor(g.x);float off=h(vec2(col_,fi));g.y+=off*13.;float cell=floor(g.y);float rnd=h(vec2(col_,cell+fi*9.));float fy=fract(g.y),fx=fract(g.x)-.5;float len=.25+.5*h(vec2(cell,col_));float streak=smoothstep(.07/z,.0,abs(fx))*smoothstep(0.,.08,fy)*smoothstep(len,len-.25,fy);rain+=streak*step(1.-uRain*.75,rnd)*(.55/z);}
  vec3 rc=mix(vec3(.85,.88,.94),vec3(.42,.46,.55),uNight);
  col=mix(col,rc,clamp(rain,0.,1.)*uRain*.65);
  float splash=n(vec2(uv.x*180.,uT*14.))*n(vec2(uv.x*60.+uT*3.,uT*9.));col+=rc*splash*uRain*smoothstep(.12,0.,uv.y)*.25;
  col=mix(col,mix(vec3(.6,.63,.68),vec3(.08,.09,.12),uNight),uFog*smoothstep(.8,0.,uv.y)*(.55+.25*fbm(vec2(uv.x*3.+uT*.02,uv.y*2.))));
  col*=1.-.2*length(uv-.5);
  gl_FragColor=vec4(pow(col,vec3(.95)),1.);
}`;
  function mount(canvas) {
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) return { set() {}, jump() {}, pos() {}, destroy() {} };
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {}; ['uRes', 'uSP', 'uT', 'uCloud', 'uRain', 'uWind', 'uSun', 'uNight', 'uFog'].forEach((k) => { U[k] = gl.getUniformLocation(pr, k); });
    const cur = { cloud: .4, rain: 0, wind: .2, sun: 1, night: 0, fog: 0 }, tgt = Object.assign({}, cur), SP = [0.1, 0.82];
    let raf = 0, alive = true, t0 = performance.now(), vis = true;
    const resize = () => { const s = Math.min(1.25, window.devicePixelRatio || 1), w = Math.max(1, canvas.clientWidth * s | 0), h = Math.max(1, canvas.clientHeight * s | 0); if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); } };
    const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
    const io = new IntersectionObserver((es) => { vis = es[0].isIntersecting; if (vis && alive && !raf) loop(); }); io.observe(canvas);
    function loop() { raf = 0; if (!alive || !vis) return; for (const k in cur) cur[k] += (tgt[k] - cur[k]) * 0.022; gl.uniform2f(U.uRes, canvas.width, canvas.height); gl.uniform2f(U.uSP, SP[0], SP[1]); gl.uniform1f(U.uT, (performance.now() - t0) / 1000); gl.uniform1f(U.uCloud, cur.cloud); gl.uniform1f(U.uRain, cur.rain); gl.uniform1f(U.uWind, cur.wind); gl.uniform1f(U.uSun, cur.sun); gl.uniform1f(U.uNight, cur.night); gl.uniform1f(U.uFog, cur.fog); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); raf = requestAnimationFrame(loop); }
    loop();
    return { set(o) { Object.assign(tgt, o); }, jump(o) { Object.assign(tgt, o); Object.assign(cur, o); }, pos(x, y) { SP[0] = x; SP[1] = y; }, destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); } };
  }
  window.AtlasSky = { mount };
})();
