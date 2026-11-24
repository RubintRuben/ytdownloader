// background.js — élő témahátterek (WebGL) és egyéni kép/videó háttér.
// A jelenet eseményei (villám, pulzálás, fényhullám) CSS-változókon át a felületet is mozgatják.
(() => {
  const layer = document.getElementById("bgLayer");
  const canvas = document.getElementById("bgCanvas");
  const videoA = document.getElementById("bgVideoA");
  const videoB = document.getElementById("bgVideoB");
  const image = document.getElementById("bgImage");
  const root = document.documentElement;

  const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

  const COMMON = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uFlash; uniform float uQuality;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0., a = .5; mat2 r = mat2(.8, .6, -.6, .8); for (int i = 0; i < 5; i++){ v += a * noise(p); p = r * p * 2.03; a *= .5; } return v; }
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
`;

  const SCENES = ["blackhole", "minecraft", "rain"];
  const SCENE_INDEX = { blackhole: 0, minecraft: 1, rain: 2 };

  // --- Valódi videó + kurzorra reagáló effektek (a videó WebGL-textúra) ---
  const VIDEO_FX = COMMON + `
uniform sampler2D uVideo; uniform sampler2D uFog; uniform vec2 uVideoRes; uniform int uScene; uniform vec3 uRip[8]; uniform float uFx;
vec2 coverUV(vec2 uv){ float sa = uRes.x / uRes.y, va = uVideoRes.x / max(uVideoRes.y, 1.);
  vec2 s = sa > va ? vec2(1., va / sa) : vec2(sa / va, 1.); return (uv - .5) * s + .5; }
vec3 vid(vec2 uv){ return texture2D(uVideo, clamp(coverUV(uv), .001, .999)).rgb; }
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
vec2 glassDrops(vec2 uv, float t, out float trail){
  vec2 n = vec2(0.); trail = 0.;
  vec2 a = vec2(6., 1.);
  vec2 g = uv * a * 2.2; g.y += t * .22;
  vec2 id = floor(g); vec2 st = fract(g) - .5;
  float h = hash12(id + 31.);
  float y = -fract(t * .2 * (.6 + h * .5) + h) + .5;
  vec2 dp = vec2(st.x - (hash12(id) - .5) * .6 - sin(t * 3. + h * 20.) * .04, (st.y - y) / a.x * a.y * 2.);
  float drop = smoothstep(.07, .0, length(dp * vec2(1., 1.6)));
  trail += smoothstep(.05, .0, abs(dp.x)) * smoothstep(-.02, .2, st.y - y) * smoothstep(.5, .1, st.y - y);
  n += dp * drop * 12.;
  for (int l = 0; l < 2; l++){
    float fl = float(l);
    vec2 g2 = uv * (24. + fl * 18.);
    vec2 id2 = floor(g2); vec2 f2 = fract(g2) - .5;
    float h2 = hash12(id2 + fl * 5.);
    vec2 q = f2 - (hash22(id2) - .5) * .7;
    float rad = .14 * smoothstep(1., .8, fract(t * .05 + h2)) * step(.55, h2);
    n += q * smoothstep(rad, rad * .4, length(q)) * 4.;
  }
  return n; }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 asp = vec2(uRes.x / uRes.y, 1.);
  vec2 d = (uv - uMouse) * asp; float r = length(d);
  vec3 col;
  if (uScene == 0) {
    // a kurzor kis gravitációs lencse: maga köré hajlítja a képet, Einstein-gyűrűvel
    float k = .0016 * uFx;
    vec2 off = -normalize(d + 1e-5) * k / (r + .015) * smoothstep(.45, .0, r);
    col = vid(uv + off / asp);
    col += vec3(1., .78, .5) * exp(-pow((r - sqrt(k * 6.)) * 85., 2.)) * .22 * uFx;
    // csillagok a sötét részeken, a kurzorral ellentétes parallaxszal
    vec2 sp = (uv + (uMouse - .5) * -.015) * asp * 120.;
    vec2 id = floor(sp); vec2 f = fract(sp) - .5;
    float h = hash12(id);
    float star = step(.985, h) * smoothstep(.12, 0., length(f - (hash22(id) - .5) * .6));
    float tw = .55 + .45 * sin(uTime * (1.5 + h * 4.) + h * 60.);
    col += vec3(.85, .9, 1.) * star * tw * (1. - smoothstep(.08, .35, lum(col))) * 1.4;
  } else if (uScene == 1) {
    // hullámgyűrűk és buborékok indulnak a kurzor mozgásából
    vec2 off = vec2(0.); float glow = 0.; float bub = 0.;
    for (int i = 0; i < 8; i++){
      vec3 rp = uRip[i]; float age = uTime - rp.z;
      if (age < 0. || age > 4.) continue;
      vec2 dd = (uv - rp.xy) * asp; float rr = length(dd); float rad = age * .22;
      float w = sin((rr - rad) * 70.) * exp(-age * 1.1) * smoothstep(.07, 0., abs(rr - rad));
      off += normalize(dd + 1e-5) * w * .004; glow += max(w, 0.);
      for (int b = 0; b < 3; b++){
        float fb = float(b);
        vec2 bp = rp.xy + vec2(sin(age * 2.5 + fb * 2.1 + rp.z) * .012 + (fb - 1.) * .012, age * (.05 + fb * .02));
        float br = (.0055 + .003 * fb) * (1. - age / 4.);
        float bd = length((uv - bp) * asp);
        bub += smoothstep(br, br * .6, bd) * .2 + smoothstep(.0015, 0., abs(bd - br)) * .6;
      }
    }
    col = vid(uv + off / asp * uFx);
    col += vec3(.6, .92, 1.) * (glow * .12 + bub * .55) * uFx;
    col += vec3(.3, .8, .9) * .07 * smoothstep(.35, 0., r) * uFx;
  } else {
    // pára az üvegen: a kurzor letörli, lassan visszapárásodik; cseppek folynak rajta
    float trail; vec2 n = glassDrops(uv * asp * .9, uTime, trail);
    float fog = texture2D(uFog, uv).r * uFx;
    vec3 sharp = vid(uv + n * .03);
    vec3 blur = (vid(uv + vec2(.007, 0.)) + vid(uv - vec2(.007, 0.)) + vid(uv + vec2(0., .012)) + vid(uv - vec2(0., .012))
               + vid(uv + vec2(.005, .008)) + vid(uv - vec2(.005, .008))) / 6.;
    float clearDrop = clamp(length(n) * 2.5 + trail * .5, 0., 1.);
    vec3 misted = mix(blur * .85 + vec3(.06, .07, .09), sharp, clearDrop);
    col = mix(sharp, misted, fog * .9);
    col += vec3(.9, .95, 1.) * pow(clamp(dot(normalize(n + 1e-4), vec2(-.6, .8)), 0., 1.), 8.) * clamp(length(n) * 2., 0., 1.) * .25;
  }
  gl_FragColor = vec4(col, 1.);
}`;

  // --- Wallpaper Engine "scene": eredeti kép + folyó torzítás + fénysugarak + részecskék + kurzor ---
  const SCENE_FX = COMMON + `
uniform sampler2D uImg; uniform sampler2D uFlowMap; uniform sampler2D uPhase;
uniform float uImgAspect; uniform float uHasFlow; uniform vec3 uFlowCfg;   // speed, strength, phasescale
uniform float uShine; uniform vec2 uLight; uniform int uCursorFx;            // 0: lencse, 1: kocka-törmelék, 2: semmi
uniform vec4 uEmit[10]; uniform vec4 uEmit2[10]; uniform int uEmitCount;   // (x,y,type,alpha) (sx,sy,speed,size)
uniform vec3 uRip[8]; uniform float uFx;
vec2 cover(vec2 uv){ float sa = uRes.x / uRes.y; vec2 s = sa > uImgAspect ? vec2(1., uImgAspect / sa) : vec2(sa / uImgAspect, 1.);
  return (uv - .5) * s + .5; }
vec4 img(vec2 t){ return texture2D(uImg, clamp(t, .001, .999)); }
vec4 flowed(vec2 t){
  if (uHasFlow < .5) return img(t);
  float phase = texture2D(uPhase, t * uFlowCfg.z).r;
  vec2 mask = (texture2D(uFlowMap, t).rg - vec2(.498)) * 2.;
  mask.y = -mask.y;
  float amount = length(mask);
  vec4 cyc = fract(vec4(uTime * uFlowCfg.x, uTime * uFlowCfg.x + .5, .25 + uTime * uFlowCfg.x, .75 + uTime * uFlowCfg.x));
  float b1 = 2. * abs(cyc.x - .5), b2 = 2. * abs(cyc.z - .5);
  cyc -= .5;
  vec4 o1 = mask.xyxy * uFlowCfg.y * .1 * cyc.xxyy, o2 = mask.xyxy * uFlowCfg.y * .1 * cyc.zzww;
  vec4 a = mix(img(t + o1.xy), img(t + o1.zw), b1);
  vec4 b = mix(img(t + o2.xy), img(t + o2.zw), b2);
  return mix(img(t), mix(a, b, smoothstep(.2, .8, phase)), amount);
}
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 asp = vec2(uRes.x / uRes.y, 1.);
  float t = uTime;
  vec2 d = (uv - uMouse) * asp; float r = length(d);
  vec2 suv = uv;
  if (uCursorFx == 0 && uFx > .5) {          // a kurzor kis gravitációs lencse
    float k = .0016;
    suv += (-normalize(d + 1e-5) * k / (r + .015) * smoothstep(.45, .0, r)) / asp;
  }
  vec2 tc = cover(suv);
  vec3 col = flowed(tc).rgb;
  if (uCursorFx == 0 && uFx > .5) col += vec3(1., .78, .5) * exp(-pow((r - sqrt(.0016 * 6.)) * 85., 2.)) * .2;
  // fénysugarak a fényes részekből a fényforrás felől
  if (uShine > 0.) {
    vec2 lt = cover(uLight);
    vec2 dir = (tc - lt) / 24.;
    float acc = 0., w = 1.;
    vec2 s = tc;
    for (int i = 0; i < 24; i++){
      s -= dir;
      acc += smoothstep(.55, 1., lum(img(s).rgb)) * w;
      w *= .93;
    }
    float flicker = .85 + .15 * noise(vec2(t * .4, 3.));
    col += vec3(1., .93, .82) * acc / 10. * uShine * flicker;
  }
  // részecskék
  for (int i = 0; i < 10; i++){
    if (i >= uEmitCount) break;
    vec4 e = uEmit[i]; vec4 e2 = uEmit2[i];
    float type = e.z; float a = e.w; float spd = max(e2.z, .05);
    if (type < 1.5) {                                                  // köd
      float band = smoothstep(.22 * max(e2.y, .2) + .05, 0., abs(uv.y - e.y)) * smoothstep(.55 * max(e2.x, .25) + .2, 0., abs(uv.x - e.x) * asp.x * .5);
      vec2 fp = uv * vec2(3., 7.) + vec2(t * .025 * spd, 0.) + (uMouse - .5) * .15;
      float fog = fbm(fp) * band;
      fog *= 1. - .55 * smoothstep(.16, 0., r) * uFx;                  // a kurzor szétoszlatja
      col = mix(col, vec3(.92, .95, 1.), clamp(fog * .55 * a, 0., .6));
    } else if (type < 2.5) {                                           // porszemek, szentjánosbogarak
      vec2 g = (uv + vec2(sin(t * .07 * spd), t * .01 * spd)) * asp * 28.;
      vec2 id = floor(g); vec2 f = fract(g) - .5;
      float h = hash12(id + float(i) * 7.);
      if (h > .86) {
        vec2 o = (hash22(id) - .5) * .7 + vec2(sin(t * .7 + h * 30.), cos(t * .6 + h * 20.)) * .15;
        vec2 cell = (id + .5 + o) / 28. / asp;
        vec2 away = (cell - uMouse) * asp;
        o += normalize(away + 1e-5) * smoothstep(.15, 0., length(away)) * 2.5 * uFx;
        float tw = .5 + .5 * sin(t * (1. + h * 3.) + h * 40.);
        col += vec3(1., .95, .8) * smoothstep(.09 * max(e2.w, .5), 0., length(f - o)) * tw * a * .8;
      }
    } else if (type < 3.5) {                                           // fénysugarak
      // The preset emits a slowly rotating, warm sprite only a few times per minute.
      vec2 rel = (tc - e.xy) * vec2(uImgAspect, 1.);
      float period = 1. / max(e2.w, .025);
      float age = mod(t + period * .28, period);
      float envelope = smoothstep(0., 1.6, age) * (1. - smoothstep(7., 15., age));
      float ang = atan(rel.y, rel.x) + 2.19 + .07 * sin(t * .19);
      float rays = .4 * exp(-pow((ang + .26) * 16., 2.))
                 + .8 * exp(-pow(ang * 12., 2.))
                 + .45 * exp(-pow((ang - .23) * 18., 2.));
      float fall = 1. - smoothstep(.08, .75, length(rel));
      col += vec3(.69, .55, .3) * rays * fall * envelope * .095 * a;
    } else if (type < 4.5) {                                           // hulló levelek
      for (int l = 0; l < 2; l++){
        float fl = float(l);
        float sc = 7. + fl * 5.;
        vec2 g = vec2(uv.x * asp.x * sc + sin(t * .5 + uv.y * 3.) * .4, uv.y * sc * .6 + t * .35 * spd * (1. + fl * .4));
        vec2 id = floor(g); vec2 f = fract(g) - .5;
        float h = hash12(id + fl * 13. + float(i));
        if (h > .91) {
          vec2 o = (hash22(id) - .5) * .5;
          vec2 world = vec2((id.x + .5 + o.x) / sc / asp.x, 0.);
          float push = smoothstep(.15, 0., length((vec2(world.x, uv.y) - uMouse) * asp)) * uFx;
          float ang = t * (1. + h) + h * 10.;
          vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (f - o - vec2(push * .6, 0.));
          float size = clamp(e2.w, .35, 1.);
          float leaf = 1. - smoothstep(.05, .13, length(q * vec2(1., 2.2)) / size);
          vec3 lc = mix(vec3(.35, .55, .2), vec3(.85, .55, .2), step(.93, h));
          col = mix(col, lc, leaf * .85 * a);
        }
      }
    } else if (type < 5.5) {                                           // hullócsillagok
      float period = 6. / max(e2.z, .3);
      float k = floor(t / period + float(i) * .37);
      float lt = fract(t / period + float(i) * .37);
      vec2 start = vec2(hash12(vec2(k, float(i))), .55 + .4 * hash12(vec2(k, 7.)));
      vec2 dirv = normalize(vec2(e.x < .5 ? 1. : -1., -.35));
      vec2 head = start + dirv * lt * .9;
      vec2 rel = (uv - head) * asp;
      float along = dot(rel, -dirv * asp / length(dirv * asp));
      float side = length(rel - (-dirv * asp / length(dirv * asp)) * along);
      float tail = smoothstep(.18, 0., along) * step(0., along) * smoothstep(.004, 0., side);
      col += vec3(.9, .95, 1.) * tail * smoothstep(.0, .1, lt) * smoothstep(.45, .2, lt) * a * 1.5;
    } else if (type < 6.5) {                                           // csillogó nyomvonal
      vec2 g = uv * asp * 60.;
      vec2 id = floor(g); float h = hash12(id + 91.);
      vec2 center = .24 + hash22(id + 13.) * .52;
      float star = 1. - smoothstep(.026, .12, length(fract(g) - center));
      col += vec3(1.) * star * step(.995, h) * (.5 + .5 * sin(t * 3. + h * 50.)) * a * .5;
    } else if (type < 7.5) {                                           // eső
      vec2 g = vec2(uv.x * asp.x * 90., uv.y * 3. + t * 5. * spd);
      vec2 id = floor(g); vec2 f = fract(g);
      col += vec3(.8, .85, 1.) * step(.93, hash12(id)) * smoothstep(.1, 0., abs(f.x - .5)) * smoothstep(0., .5, f.y) * .2 * a;
    } else {                                                           // hó
      vec2 g = vec2(uv.x * asp.x * 30. + sin(t + uv.y * 4.) * .5, uv.y * 15. + t * .8 * spd);
      vec2 id = floor(g); vec2 f = fract(g) - .5;
      col += vec3(1.) * step(.9, hash12(id)) * smoothstep(.12, .05, length(f)) * .7 * a;
    }
  }
  // kattintásra kocka-törmelék (a kép színeiből)
  if (uCursorFx == 1) {
    for (int i = 0; i < 8; i++){
      vec3 rp = uRip[i]; float age = t - rp.z;
      if (age < 0. || age > 1.2) continue;
      vec3 bc = img(cover(rp.xy)).rgb;
      for (int k = 0; k < 7; k++){
        float fk = float(k);
        vec2 v = vec2(cos(fk * .9 + rp.z * 3.), .6 + .7 * sin(fk * 2.1 + rp.z)) * .3;
        vec2 p = rp.xy + vec2(v.x / asp.x, v.y) * age - vec2(0., 1.1 * age * age);
        vec2 dd = abs((uv - p) * asp);
        float s = .008 * (1. - age / 1.2);
        col = mix(col, bc * (.75 + .5 * hash12(vec2(fk, rp.z))), step(max(dd.x, dd.y), s));
      }
    }
  }
  gl_FragColor = vec4(col, 1.);
}`;

  let gl = null, sceneName = "", running = false, raf = 0;
  let quality = "high", lastFrame = 0, startTime = performance.now();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let fxEnabled = true, mode = "";
  const mouse = { x: .5, y: .5, tx: .5, ty: .5, moved: 0 };
  let flash = 0;
  const programs = {};
  let current = null;                            // {prog, uniforms}
  let videoTex = null, fogTex = null;
  const ripples = Array.from({ length: 8 }, () => [0, 0, -99]);
  let rippleIndex = 0, lastRipple = 0;
  let cursorStyle = "lens";                       // lens | blocks | ripples | none
  let sceneDesc = null, sceneTex = {}, sceneLight = [.6, .6], sceneEmit = new Float32Array(40), sceneEmit2 = new Float32Array(40), sceneEmitCount = 0;
  const PARTICLE_TYPE = { fog: 1, dust: 2, shafts: 3, leaves: 4, stars: 5, trails: 6, rain: 7, snow: 8 };
  const sceneVideo = document.createElement("video");
  sceneVideo.muted = true; sceneVideo.loop = true; sceneVideo.playsInline = true; sceneVideo.preload = "auto";
  sceneVideo.crossOrigin = "anonymous";
  const fogCanvas = document.createElement("canvas");
  fogCanvas.width = 192; fogCanvas.height = 108;
  const fogCtx = fogCanvas.getContext("2d");

  function initGL() {
    if (gl) return gl;
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) return null;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); gl = null; current = null; videoTex = fogTex = null; for (const k in programs) delete programs[k]; });
    return gl;
  }

  function compile(source) {
    const make = (type, src) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, source));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    return prog;
  }

  function texture() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return tex;
  }

  function useProgram(key, source) {
    if (!initGL()) return false;
    try { programs[key] ||= compile(source); } catch (error) { console.error("[background] shader", error); return false; }
    const prog = programs[key];
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const names = ["uRes", "uTime", "uMouse", "uFlash", "uQuality", "uVideo", "uFog", "uVideoRes", "uScene", "uRip", "uFx",
      "uImg", "uFlowMap", "uPhase", "uImgAspect", "uHasFlow", "uFlowCfg", "uShine", "uLight", "uCursorFx", "uEmit", "uEmit2", "uEmitCount"];
    current = { prog, uniforms: Object.fromEntries(names.map(u => [u, gl.getUniformLocation(prog, u)])) };
    resize();
    return true;
  }

  function scale() {
    return quality === "low" ? .48 : .8;
  }

  function resize() {
    if (!gl) return;
    const s = scale() * Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(320, Math.round(window.innerWidth * s));
    const h = Math.max(200, Math.round(window.innerHeight * s));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }
  window.addEventListener("resize", () => { resize(); if (!running) drawOnce(); });

  // A jelenet eseményei: a shader és a felület ugyanazt az ütemet látja.
  let lumPulse = 0.5;
  function updateEvents(t) {
    flash = mode === "video" ? lumPulse : 0.5 + 0.5 * Math.sin(t * 0.42) * Math.sin(t * 0.13 + 1.3);
    root.style.setProperty("--scene-pulse", flash.toFixed(3));
  }

  function updateFog() {
    // a pára lassan visszatér; a kurzor nyoma letörli
    fogCtx.globalCompositeOperation = "source-over";
    fogCtx.fillStyle = "rgba(255,255,255,0.006)";
    fogCtx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    if (mouse.moved > 0) {
      const x = mouse.tx * fogCanvas.width, y = (1 - mouse.ty) * fogCanvas.height;
      const g = fogCtx.createRadialGradient(x, y, 0, x, y, 11);
      g.addColorStop(0, "rgba(0,0,0,0.9)"); g.addColorStop(1, "rgba(0,0,0,0)");
      fogCtx.fillStyle = g;
      fogCtx.beginPath(); fogCtx.arc(x, y, 11, 0, Math.PI * 2); fogCtx.fill();
      mouse.moved--;
    }
  }

  function draw(now) {
    if (!current || !mode) return 0;
    const t = (now - startTime) / 1000;
    mouse.x += (mouse.tx - mouse.x) * (mode === "video" ? 0.2 : 0.04);
    mouse.y += (mouse.ty - mouse.y) * (mode === "video" ? 0.2 : 0.04);
    const u = current.uniforms;
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uFlash, flash);
    gl.uniform1f(u.uQuality, quality === "high" ? 1 : 0);
    if (mode === "video") {
      gl.uniform2f(u.uMouse, mouse.x, mouse.y);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      if (sceneVideo.readyState >= 2) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, sceneVideo);
      }
      gl.uniform1i(u.uVideo, 0);
      gl.uniform2f(u.uVideoRes, sceneVideo.videoWidth || 1920, sceneVideo.videoHeight || 1080);
      gl.uniform1i(u.uScene, SCENE_INDEX[sceneName] ?? 0);
      gl.uniform1f(u.uFx, fxEnabled ? 1 : 0);
      gl.uniform3fv(u.uRip, ripples.flat());
      if (sceneName === "rain") {
        updateFog();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, fogTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, fogCanvas);
        gl.uniform1i(u.uFog, 1);
        gl.activeTexture(gl.TEXTURE0);
      }
    } else if (mode === "scene" && sceneDesc) {
      gl.uniform2f(u.uMouse, mouse.x, mouse.y);
      const textures = [sceneTex.img, sceneTex.flow || sceneTex.img, sceneTex.phase || sceneTex.img];
      textures.forEach((tex, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); });
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(u.uImg, 0); gl.uniform1i(u.uFlowMap, 1); gl.uniform1i(u.uPhase, 2);
      const layer = sceneDesc.layers[0];
      gl.uniform1f(u.uImgAspect, sceneTex.aspect || sceneDesc.aspect || 16 / 9);
      gl.uniform1f(u.uHasFlow, layer.flow && sceneTex.flow ? 1 : 0);
      gl.uniform3f(u.uFlowCfg, layer.flow?.speed ?? .1, layer.flow?.strength ?? 1, layer.flow?.phasescale ?? 2);
      gl.uniform1f(u.uShine, layer.shine ? Math.min(1.2, (layer.shine.intensity ?? .5) * 1.4) : 0);
      gl.uniform2f(u.uLight, sceneLight[0], sceneLight[1]);
      gl.uniform1i(u.uCursorFx, fxEnabled ? (cursorStyle === "blocks" ? 1 : cursorStyle === "lens" ? 0 : 2) : 2);
      gl.uniform1f(u.uFx, fxEnabled ? 1 : 0);
      gl.uniform4fv(u.uEmit, sceneEmit);
      gl.uniform4fv(u.uEmit2, sceneEmit2);
      gl.uniform1i(u.uEmitCount, sceneEmitCount);
      gl.uniform3fv(u.uRip, ripples.flat());
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return t;
  }

  let lastEvent = 0;
  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const focused = document.hasFocus();
    const fps = quality === "low" ? 30 : focused ? 60 : 24;
    if (now - lastFrame < 1000 / fps - 2) return;
    lastFrame = now;
    const t = (now - startTime) / 1000;
    if (now - lastEvent > 50) { updateEvents(t); lastEvent = now; }
    draw(now);
  }

  function drawOnce() {
    if (gl && current) { flash = sceneName === "rain" ? 0 : 0.5; draw(performance.now()); }
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stop(); sceneVideo.pause(); }
    else if (mode && quality !== "off") { if (mode === "video") sceneVideo.play().catch(() => {}); start(); }
  });

  // --- kurzor: a jelenet és a felület is követi ---
  let cssFrame = 0;
  window.addEventListener("pointermove", (e) => {
    mouse.tx = e.clientX / window.innerWidth;
    mouse.ty = 1 - e.clientY / window.innerHeight;
    mouse.moved = 3;
    const now = performance.now();
    if (cursorStyle === "ripples" && now - lastRipple > 140) {
      lastRipple = now;
      ripples[rippleIndex] = [mouse.tx, mouse.ty, (now - startTime) / 1000];
      rippleIndex = (rippleIndex + 1) % ripples.length;
    }
    if (fxEnabled && !web.hidden && now - lastWebMove > 33) {
      lastWebMove = now;
      web.contentWindow?.postMessage({ type: "dl-mouse", x: e.clientX / innerWidth, y: e.clientY / innerHeight }, "*");
    }
    if (!cssFrame) cssFrame = requestAnimationFrame(() => {
      cssFrame = 0;
      root.style.setProperty("--mx", e.clientX + "px");
      root.style.setProperty("--my", e.clientY + "px");
    });
  }, { passive: true });
  window.addEventListener("pointerdown", (e) => {
    if (!fxEnabled || !(cursorStyle === "ripples" || cursorStyle === "blocks")) return;
    // a felület gombjain nem törünk kockát, csak a szabad háttéren és a panelek között
    if (cursorStyle === "blocks" && e.target.closest("button, input, select, a, .yt-card, .short-card, .g-card")) return;
    const now = performance.now();
    ripples[rippleIndex] = [e.clientX / innerWidth, 1 - e.clientY / innerHeight, (now - startTime) / 1000];
    rippleIndex = (rippleIndex + 1) % ripples.length;
  }, { passive: true });

  // --- színmintavétel: a felület fényei a háttér színét és fényességét követik ---
  const sampler = document.createElement("canvas");
  sampler.width = sampler.height = 12;
  const sctx = sampler.getContext("2d", { willReadFrequently: true });
  let sampleTimer = 0;

  function sampleColor(source, setAccent) {
    try {
      sctx.drawImage(source, 0, 0, 12, 12);
      const data = sctx.getImageData(0, 0, 12, 12).data;
      let best = null, bestScore = -1, r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2];
        const max = Math.max(data[i], data[i + 1], data[i + 2]), min = Math.min(data[i], data[i + 1], data[i + 2]);
        const score = (max - min) * (max / 255);
        if (score > bestScore) { bestScore = score; best = [data[i], data[i + 1], data[i + 2]]; }
      }
      const n = data.length / 4;
      lumPulse = Math.min(1, ((0.2126 * r + 0.7152 * g + 0.0722 * b) / n / 255) * 2.2);
      root.style.setProperty("--scene-pulse", lumPulse.toFixed(3));
      if (setAccent && best) {
        let [h, s] = rgbToHsl(...best);
        s = Math.max(s, 0.55);
        setAccentColors(hslToRgb(h, s, 0.68), hslToRgb((h + 0.08) % 1, s, 0.78));
      }
    } catch { /* not ready yet */ }
  }
  function setAccentColors(a, b) {
    root.style.setProperty("--accent", `rgb(${a.join(",")})`);
    root.style.setProperty("--accent-2", `rgb(${b.join(",")})`);
    root.style.setProperty("--glow", a.join(","));
  }
  function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }
  function setSurface(hex) {
    const props = ["--bg", "--bg-2", "--panel", "--panel-2", "--line", "--line-2", "--hero-surface"];
    if (!hex) { props.forEach(p => root.style.removeProperty(p)); return; }
    const [h, s] = rgbToHsl(...hexToRgb(hex));
    const tone = (l, a) => { const c = hslToRgb(h, Math.min(s, .6), l); return `rgba(${c.join(",")},${a})`; };
    root.style.setProperty("--bg", tone(.04, .25));
    root.style.setProperty("--bg-2", tone(.07, .74));
    root.style.setProperty("--panel", tone(.1, .7));
    root.style.setProperty("--panel-2", tone(.16, .8));
    root.style.setProperty("--hero-surface", tone(.1, .6));
    root.style.setProperty("--line", tone(.6, .14));
    root.style.setProperty("--line-2", tone(.65, .26));
  }

  // --- a felület anyagai: nedves üveg, csillagos üveg, kausztikus fény (egyszer generálva) ---
  const textures = {};
  function makeTexture(kind) {
    if (textures[kind]) return textures[kind];
    const c = document.createElement("canvas");
    c.width = c.height = 320;
    const x = c.getContext("2d");
    if (kind === "wet") {
      for (let i = 0; i < 56; i++) {
        const px = Math.random() * 320, py = Math.random() * 320;
        const radius = .65 + Math.random() ** 3 * 3.1;
        x.save();
        x.translate(px, py);
        x.rotate((Math.random() - .5) * .8);
        x.scale(.85 + Math.random() * .25, 1 + Math.random() * .4);
        x.beginPath();
        x.moveTo(-radius * .06, -radius);
        x.bezierCurveTo(radius * .52, -radius * 1.03, radius * 1.04, -radius * .45, radius * .98, radius * .23);
        x.bezierCurveTo(radius * .91, radius * 1.2, -radius * .95, radius * 1.18, -radius, radius * .2);
        x.bezierCurveTo(-radius * 1.05, -radius * .44, -radius * .56, -radius * .88, -radius * .06, -radius);
        x.closePath();
        const body = x.createLinearGradient(0, -radius, 0, radius);
        body.addColorStop(0, "#0009");
        body.addColorStop(.54, "#1f334833");
        body.addColorStop(1, "#b3ceeb80");
        x.fillStyle = body;
        x.shadowColor = "#0008";
        x.shadowBlur = radius * .46;
        x.shadowOffsetY = radius * .4;
        x.fill();
        if (radius > 1.25) {
          x.shadowColor = "transparent";
          x.lineWidth = Math.max(.35, radius * .13);
          x.strokeStyle = "#e5f3ff78";
          x.beginPath();
          x.ellipse(0, 0, radius * .72, radius * .77, 0, 3.65, 4.65);
          x.stroke();
        }
        x.restore();
      }
    } else {
      for (let i = 0; i < 160; i++) {
        const px = Math.random() * 320, py = Math.random() * 320, r = Math.random() < .08 ? 1.6 : .7;
        x.fillStyle = `rgba(255,${235 + Math.random() * 20 | 0},${210 + Math.random() * 45 | 0},${.35 + Math.random() * .6})`;
        x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
        if (r > 1) { x.fillRect(px - 4, py - .3, 8, .6); x.fillRect(px - .3, py - 4, .6, 8); }
      }
    }
    return new Promise(resolve => c.toBlob(blob => { textures[kind] = URL.createObjectURL(blob); resolve(textures[kind]); }));
  }
  function pixelTexture(kind) {
    // 16×16-os, Minecraft-szerű kő/föld/fű textúra a gombokhoz és panelekhez
    const key = "px-" + kind;
    if (textures[key]) return Promise.resolve(textures[key]);
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const x = c.getContext("2d");
    const base = { stone: [118, 118, 118], dark: [44, 44, 44], dirt: [134, 96, 67], grass: [94, 157, 52], plank: [162, 130, 78] }[kind];
    for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
      const n = (Math.random() - .5) * (kind === "dark" ? 18 : 34);
      let [r, g, b] = base.map(v => Math.max(0, Math.min(255, v + n)));
      if (kind === "plank" && py % 4 === 0) [r, g, b] = [r * .78, g * .78, b * .78];
      x.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      x.fillRect(px, py, 1, 1);
    }
    return new Promise(resolve => c.toBlob(blob => { textures[key] = URL.createObjectURL(blob); resolve(textures[key]); }));
  }
  async function surfaceMaterial(scene) {
    document.body.classList.remove("scene-rain", "scene-blackhole", "scene-minecraft");
    if (!scene) return;
    document.body.classList.add("scene-" + scene);
    if (scene === "minecraft") {
      const [stone, dark, dirt, plank] = await Promise.all(["stone", "dark", "dirt", "plank"].map(pixelTexture));
      root.style.setProperty("--mc-stone", `url("${stone}")`);
      root.style.setProperty("--mc-dark", `url("${dark}")`);
      root.style.setProperty("--mc-dirt", `url("${dirt}")`);
      root.style.setProperty("--mc-plank", `url("${plank}")`);
      return;
    }
    const kind = { rain: "wet", blackhole: "stars" }[scene] || "stars";
    const url = await makeTexture(kind);
    if (!document.body.classList.contains("scene-" + scene)) return;
    root.style.setProperty("--material", `url("${url}")`);
  }

  // --- egyéni háttér: kép, (átúsztatva ismétlődő) videó vagy Wallpaper Engine web-háttér ---
  const web = document.getElementById("bgWeb");
  let lastWebMove = 0;
  let customKey = "", crossfadeHandler = null, customVideoActive = null;

  function clearCustom() {
    clearInterval(sampleTimer);
    for (const v of [videoA, videoB]) {
      v.pause(); v.hidden = true; v.classList.remove("visible"); v.removeAttribute("src"); v.load();
      if (crossfadeHandler) v.removeEventListener("timeupdate", crossfadeHandler);
    }
    image.hidden = true; image.removeAttribute("src");
    hideWeb();
    for (const prop of ["--accent", "--accent-2", "--glow"]) root.style.removeProperty(prop);
    setSurface("");
    customKey = ""; customVideoActive = null;
  }

  function hideWeb() {
    web.onload = null;
    web.hidden = true;
    web.removeAttribute("src");
  }

  function showWeb(src, muted, volume = 1) {
    web.hidden = false;
    const updateWeb = () => {
      web.contentWindow?.postMessage({ type: "dl-mute", muted }, "*");
      web.contentWindow?.postMessage({ type: "dl-volume", volume }, "*");
      web.contentWindow?.postMessage({ type: "dl-animation", quality }, "*");
    };
    if (web.getAttribute("src") === src) { updateWeb(); return; }
    web.onload = updateWeb;
    web.src = src;
  }

  function enableSoundOnGesture(video, volume) {
    const unlock = () => { video.muted = false; video.volume = volume; video.play().catch(() => {}); };
    window.addEventListener("pointerdown", unlock, { once: true });
  }

  function showCustom(theme) {
    const base = `${window.API_BASE || ""}/api/custom-themes/${theme.id}`;
    const key = [theme.id, theme.kind, theme.sound, theme.volume].join("|");
    const volume = (theme.volume ?? 60) / 100;
    if (customKey !== key) {
      clearCustom();
      customKey = key;
      if (theme.kind === "image") {
        image.onload = () => { if (!theme.accent) sampleColor(image, true); };
        image.src = base + "/media";
        image.hidden = false;
      } else if (theme.kind === "scene") {
        const request = ++sceneRequest;
        showWallpaperScene(`${base}/files/`, request, "lens");
      } else if (theme.kind === "web") {
        showWeb(base + "/files/" + encodeURI(theme.file), !theme.sound, volume);
        if (!theme.accent && theme.hasThumb) {
          const thumb = new Image();
          thumb.onload = () => sampleColor(thumb, true);
          thumb.src = base + "/thumb";
        }
      } else {
        // két videó váltakozik: a vége előtt a másik indul az elejéről, és átúsztatunk
        let active = videoA, idle = videoB;
        for (const v of [videoA, videoB]) { v.src = base + "/media"; v.muted = true; v.hidden = false; v.loop = false; v.volume = volume; }
        active.classList.add("visible");
        customVideoActive = active;
        const begin = () => {
          if (theme.sound) {
            active.muted = false;
            active.play().catch(() => { active.muted = true; active.play().catch(() => {}); enableSoundOnGesture(active, volume); });
          } else active.play().catch(() => {});
        };
        begin();
        const FADE = 1.2;
        crossfadeHandler = function () {
          if (this !== active || !active.duration) return;
          if (active.duration < FADE * 3) { active.loop = true; return; }
          if (active.duration - active.currentTime < FADE && idle.paused) {
            idle.currentTime = 0;
            idle.muted = !theme.sound;
            idle.play().catch(() => { idle.muted = true; idle.play().catch(() => {}); });
            idle.classList.add("visible");
            active.classList.remove("visible");
            const previous = active;
            [active, idle] = [idle, active];
            customVideoActive = active;
            setTimeout(() => { previous.pause(); previous.muted = true; }, FADE * 1000 + 100);
          }
        };
        videoA.addEventListener("timeupdate", crossfadeHandler);
        videoB.addEventListener("timeupdate", crossfadeHandler);
        sampleTimer = setInterval(() => { if (!document.hidden) sampleColor(customVideoActive, !theme.accent); }, 700);
      }
    }
    if (theme.accent) {
      const [h, s] = rgbToHsl(...hexToRgb(theme.accent));
      setAccentColors(hexToRgb(theme.accent), hslToRgb((h + 0.08) % 1, Math.max(s, .4), 0.78));
    }
    setSurface(theme.surface || "");
    root.style.setProperty("--bg-dim", String((theme.dim ?? 45) / 100));
  }

  // --- Wallpaper Engine scene betöltése (kép + effektek) ---
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }
  function uploadImage(img, repeat) {
    const tex = texture();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (repeat) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
    return tex;
  }
  function brightestPoint(img) {
    try {
      const c = document.createElement("canvas"); c.width = 64; c.height = 36;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0, 64, 36);
      const d = x.getImageData(0, 0, 64, 36).data;
      let best = 0, bx = .6, by = .6;
      for (let i = 0; i < d.length; i += 4) {
        const l = d[i] * .21 + d[i + 1] * .72 + d[i + 2] * .07;
        if (l > best) { best = l; bx = ((i / 4) % 64 + .5) / 64; by = 1 - (Math.floor(i / 4 / 64) + .5) / 36; }
      }
      return [bx, by];
    } catch { return [.6, .6]; }
  }
  async function loadSceneDescriptor(base, request) {
    const desc = await fetch(base + "scene.json", { cache: "no-store" }).then(r => r.json());
    const layer = desc.layers[0];
    const [img, flow, phase] = await Promise.all([
      loadImage(base + layer.image),
      layer.flow?.mask ? loadImage(base + layer.flow.mask).catch(() => null) : null,
      layer.flow?.phase ? loadImage(base + layer.flow.phase).catch(() => null) : null,
    ]);
    if (request !== sceneRequest) return null;
    if (!initGL()) throw new Error("WebGL unavailable");
    for (const key of ["img", "flow", "phase"]) if (sceneTex[key]) gl.deleteTexture(sceneTex[key]);
    sceneTex = { img: uploadImage(img), flow: flow ? uploadImage(flow) : null, phase: phase ? uploadImage(phase, true) : null,
                 aspect: img.naturalWidth / img.naturalHeight };
    sceneLight = brightestPoint(img);
    sceneEmit = new Float32Array(40); sceneEmit2 = new Float32Array(40);
    const parts = (desc.particles || []).filter(p => PARTICLE_TYPE[p.type]).slice(0, 10);
    parts.forEach((p, i) => {
      sceneEmit.set([p.x, p.y, PARTICLE_TYPE[p.type], Math.min(1, p.alpha ?? 1)], i * 4);
      const sizeOrShaftRate = p.type === "shafts" ? .2 * (p.rate ?? 1) : (p.size ?? 1);
      sceneEmit2.set([p.scale?.[0] ?? 1, p.scale?.[1] ?? 1, p.speed ?? 1, sizeOrShaftRate], i * 4);
    });
    sceneEmitCount = parts.length;
    sceneDesc = desc;
    return img;
  }
  async function showWallpaperScene(base, request, cursor) {
    try {
      const img = await loadSceneDescriptor(base, request);
      if (!img || request !== sceneRequest) return;
      mode = "scene";
      cursorStyle = cursor;
      if (!useProgram("scene", SCENE_FX)) { mode = ""; return; }
      canvas.hidden = false;
      clearInterval(sampleTimer);
      sampleColor(img, false);
      if (quality === "off") { stop(); drawOnce(); } else start();
    } catch (error) {
      if (request === sceneRequest) {
        console.error("[background] scene", error);
        toast("A háttérjelenet nem tölthető be.", [], "error");
      }
    }
  }

  let sceneRequest = 0;
  async function showScene(theme) {
    const request = ++sceneRequest;
    const base = `${window.API_BASE || ""}/api/theme-video/${theme}`;
    const status = await fetch(base + "/status?prepare=true").then(r => r.json()).catch(() => null);
    if (request !== sceneRequest) return;
    window.dispatchEvent(new CustomEvent("theme-video-status", { detail: { scene: theme, ...status } }));
    if (status?.state === "processing") {
      setTimeout(() => { if (request === sceneRequest) showScene(theme); }, 1500);
      return;
    }
    if (status?.state !== "ready") {
      if (status?.message) toast(status.message, [], "error");
      return;
    }
    const cursor = { blackhole: "lens", minecraft: "blocks", rain: "fog" }[theme];
    cursorStyle = cursor;
    if (status.kind === "web") {
      stop(); mode = ""; canvas.hidden = true; sceneVideo.pause();
      showWeb(`${base}/files/${encodeURI(status.file)}?v=${status.version}`, true);
      return;
    }
    hideWeb();
    if (status.kind === "scene") {
      sceneVideo.pause();
      showWallpaperScene(`${base}/files/`, request, cursor);
      return;
    }
    if (status.kind !== "video" || !initGL()) return;
    const src = `${base}?v=${status.version}`;
    if (sceneVideo.getAttribute("src") !== src) {
      sceneVideo.src = src;
      try { await sceneVideo.play(); }
      catch {
        if (request === sceneRequest) toast("A háttérvideó nem játszható le.", [], "error");
        return;
      }
    }
    if (request !== sceneRequest) return;
    videoTex ||= texture();
    fogTex ||= texture();
    fogCtx.fillStyle = "#fff"; fogCtx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    mode = "video";
    if (!useProgram("video", VIDEO_FX)) { mode = ""; return; }
    canvas.hidden = false;
    clearInterval(sampleTimer);
    if (quality === "off") { sceneVideo.pause(); stop(); drawOnce(); }
    else {
      sceneVideo.play().catch(() => {});
      sampleTimer = setInterval(() => { if (!document.hidden) sampleColor(sceneVideo, false); }, 600);
      start();
    }
  }

  // --- nyilvános API ---
  window.backgroundEngine = {
    apply(theme, settings = {}) {
      quality = reducedMotion.matches ? "off" : (settings.animations || "high");
      fxEnabled = settings.scene_effects !== false;
      const custom = theme?.startsWith?.("custom:") ? (settings.custom_themes || []).find(t => "custom:" + t.id === theme) : null;
      const animated = SCENES.includes(theme);
      document.body.classList.toggle("animated-bg", animated || !!custom);
      document.body.classList.toggle("glass-high", (animated || !!custom) && quality === "high");
      layer.dataset.scene = custom ? "custom" : animated ? theme : "";
      if (custom) {
        if (!customKey || custom.kind !== "scene") { stop(); sceneRequest++; mode = ""; canvas.hidden = true; }
        sceneName = "";
        sceneVideo.pause();
        clearInterval(sampleTimer);
        surfaceMaterial("");
        showCustom(custom);
        return;
      }
      if (customKey) clearCustom();
      root.style.setProperty("--bg-dim", String((settings.background_dim ?? 35) / 100));
      if (!animated) {
        stop(); sceneRequest++; mode = ""; sceneName = ""; canvas.hidden = true; sceneVideo.pause();
        hideWeb();
        clearInterval(sampleTimer);
        sceneVideo.removeAttribute("src"); sceneVideo.load();
        surfaceMaterial("");
        return;
      }
      surfaceMaterial(theme);
      if (sceneName !== theme) {
        stop();
        mode = "";
        canvas.hidden = true;
        sceneName = theme;
        sceneVideo.pause();
        sceneVideo.removeAttribute("src");
        hideWeb();
        clearInterval(sampleTimer);
      }
      showScene(theme);
    },
    scenes: SCENES,
    benchmark(frames = 20) {   // fejlesztői mérés: átlagos GPU-idő képkockánként (ms)
      if (!gl || !current) return null;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) draw(t0 + i * 16);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return +((performance.now() - t0) / frames).toFixed(2);
    },
  };
})();
