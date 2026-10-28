/**
 * The weather sky — a port of the handoff's `atlas-weather-sky.js`
 * (design/current/design_handoff_atlas_beta) to a TypeScript module.
 *
 * One full-screen fragment shader mixes clear, cloud, rain, wind, fog and
 * night, and eases between any two mixes (2.2 % of the gap per frame, as the
 * original). `mountSky(canvas)` returns a handle: `set` eases to a target,
 * `jump` lands on it, `pos` moves the light source (sun or moon) in 0–1 canvas
 * coordinates with y up, `destroy` stops the loop and releases the observers.
 *
 * Two things the original leaves to the page are handled here: the loop
 * sleeps while the canvas is off screen (IntersectionObserver, as the
 * original) and, when the viewer asked for reduced motion, the sky is drawn
 * once per change instead of animated — clouds and rain hold still.
 */

export interface SkyMix {
  cloud: number;
  rain: number;
  wind: number;
  sun: number;
  night: number;
  fog: number;
}

export interface SkyHandle {
  set(target: Partial<SkyMix>): void;
  jump(target: Partial<SkyMix>): void;
  pos(x: number, y: number): void;
  destroy(): void;
}

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

const UNIFORMS = ['uRes', 'uSP', 'uT', 'uCloud', 'uRain', 'uWind', 'uSun', 'uNight', 'uFog'] as const;
type UniformName = (typeof UNIFORMS)[number];
const MIX_KEYS: readonly (keyof SkyMix)[] = ['cloud', 'rain', 'wind', 'sun', 'night', 'fog'];

/** The mix the original starts from: a mild, partly cloudy day. */
export const DEFAULT_MIX: SkyMix = { cloud: 0.4, rain: 0, wind: 0.2, sun: 1, night: 0, fog: 0 };

/** A handle that does nothing — what a canvas without WebGL gets, so callers never branch. */
const NOOP: SkyHandle = { set() {}, jump() {}, pos() {}, destroy() {} };

function prefersStill(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function mountSky(canvas: HTMLCanvasElement): SkyHandle {
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
  if (!gl) return NOOP;

  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  if (!program || !vs || !fs) return NOOP;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {} as Record<UniformName, WebGLUniformLocation | null>;
  for (const k of UNIFORMS) U[k] = gl.getUniformLocation(program, k);

  const cur: SkyMix = { ...DEFAULT_MIX };
  const tgt: SkyMix = { ...DEFAULT_MIX };
  const light: [number, number] = [0.1, 0.82];
  const still = prefersStill();
  let raf = 0;
  let alive = true;
  let visible = true;
  const t0 = performance.now();

  const resize = () => {
    const s = Math.min(1.25, window.devicePixelRatio || 1);
    const w = Math.max(1, (canvas.clientWidth * s) | 0);
    const h = Math.max(1, (canvas.clientHeight * s) | 0);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };

  const draw = () => {
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform2f(U.uSP, light[0], light[1]);
    gl.uniform1f(U.uT, (performance.now() - t0) / 1000);
    gl.uniform1f(U.uCloud, cur.cloud);
    gl.uniform1f(U.uRain, cur.rain);
    gl.uniform1f(U.uWind, cur.wind);
    gl.uniform1f(U.uSun, cur.sun);
    gl.uniform1f(U.uNight, cur.night);
    gl.uniform1f(U.uFog, cur.fog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  // Reduced motion: no loop. Land on the target and draw one frame.
  const drawStill = () => {
    if (!alive) return;
    for (const k of MIX_KEYS) cur[k] = tgt[k];
    resize();
    draw();
  };

  const loop = () => {
    raf = 0;
    if (!alive || !visible) return;
    for (const k of MIX_KEYS) cur[k] += (tgt[k] - cur[k]) * 0.022;
    draw();
    raf = requestAnimationFrame(loop);
  };

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); if (still) drawStill(); }) : null;
  ro?.observe(canvas);
  resize();
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible && alive && !raf && !still) loop();
    })
    : null;
  io?.observe(canvas);

  if (still) drawStill(); else loop();

  return {
    set(target) { Object.assign(tgt, target); if (still) drawStill(); },
    jump(target) { Object.assign(tgt, target); Object.assign(cur, target); if (still) drawStill(); },
    pos(x, y) { light[0] = x; light[1] = y; if (still) drawStill(); },
    destroy() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
      io?.disconnect();
    },
  };
}
