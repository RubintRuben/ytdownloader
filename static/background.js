// background.js — élő témahátterek (WebGL) és egyéni kép/videó háttér.
// Procedurális jelenetek: végtelenül, varrat nélkül ismétlődnek, bármilyen felbontáson élesek.
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

  // --- Fekete lyuk: Schwarzschild-fénygörbülés, akkréciós korong Doppler-fénnyel ---
  const BLACKHOLE = COMMON + `
vec3 stars(vec3 d){
  vec3 col = vec3(0.);
  vec2 sp = vec2(atan(d.z, d.x), asin(clamp(d.y, -1., 1.)));
  for (int l = 0; l < 3; l++){
    float s = 90. + float(l) * 130.;
    vec2 g = sp * s / 3.14159; vec2 id = floor(g); vec2 f = fract(g) - .5;
    vec2 o = hash22(id + float(l) * 17.) - .5;
    float h = hash12(id * 1.7 + float(l));
    float star = smoothstep(.06, 0., length(f - o * .7)) * step(.86, h);
    float tw = .7 + .3 * sin(uTime * (1. + h * 3.) + h * 40.);
    col += star * tw * mix(vec3(.75, .82, 1.), vec3(1., .85, .7), hash12(id + 3.)) * (1.2 - float(l) * .3);
  }
  float neb = fbm(sp * 2.2 + 3.);
  col += vec3(.25, .12, .35) * neb * neb * neb * .9 + vec3(.05, .09, .22) * pow(max(fbm(sp * 3.1 - 7.), 0.), 2.) * .8;
  return col;
}
vec3 disk(vec3 q, vec3 rd, float r){
  float inner = 3.0, outer = 11.0;
  if (r < inner || r > outer) return vec3(0.);
  // két, fél periódussal eltolt fázis keverése: a differenciális forgás nem nyúlik szét végtelenre
  float P = 24.;
  float t1 = mod(uTime, P), t2 = mod(uTime + P * .5, P);
  float w = abs(mod(uTime, P) / P * 2. - 1.);
  float spin = 5.5 / pow(r, 1.5);
  vec2 xz = q.xz;
  float a1 = t1 * spin, a2 = t2 * spin;
  vec2 u1 = mat2(cos(a1), -sin(a1), sin(a1), cos(a1)) * xz;
  vec2 u2 = mat2(cos(a2), -sin(a2), sin(a2), cos(a2)) * xz;
  float ang1 = atan(u1.y, u1.x), ang2 = atan(u2.y, u2.x);
  float n1 = fbm(vec2(r * 1.9, ang1 * 2.0) + 4.) * .6 + fbm(u1 * .9) * .4;
  float n2 = fbm(vec2(r * 1.9, ang2 * 2.0) + 4.) * .6 + fbm(u2 * .9) * .4;
  float n = mix(n1, n2, w);
  float band = .78 + .22 * sin(r * 5.1 + n * 7.);
  float streak = mix(noise(vec2(r * 9., ang1 * 1.5) + 11.), noise(vec2(r * 9., ang2 * 1.5) + 11.), w);
  float dens = smoothstep(inner, inner + .5, r) * smoothstep(outer, outer - 5.5, r) * (.25 + 1.05 * n * band) * (.75 + .5 * streak);
  float temp = smoothstep(outer, inner, r);
  vec3 c = mix(vec3(.9, .22, .04), vec3(1., .62, .26), temp);
  c = mix(c, vec3(1., .93, .82), temp * temp * temp);
  vec3 vel = normalize(vec3(-q.z, 0., q.x));
  float dop = 1. + .55 * dot(vel, -rd);
  return c * dens * dop * dop * dop * (1.1 + 1.8 * temp);
}
void main(){
  vec2 uv = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  float yaw = .25 * sin(uTime * .05) + uMouse.x * .18;
  float pitch = .12 + uMouse.y * .06;
  vec3 ro = vec3(sin(yaw) * 30., 30. * sin(pitch), -cos(yaw) * 30.);
  vec3 fw = normalize(-ro), rt = normalize(cross(vec3(0, 1, 0), fw)), up = cross(fw, rt);
  vec3 rd = normalize(fw * 2.0 + (uv.x - .08) * rt + (uv.y + .02) * up);
  vec3 p = ro, v = rd;
  vec3 h = cross(p, v); float h2 = dot(h, h);
  vec3 col = vec3(0.); float trans = 1.; float minR = 1e3; bool captured = false;
  int steps = uQuality > .5 ? 150 : 80;
  for (int i = 0; i < 150; i++){
    if (i >= steps) break;
    float r2 = dot(p, p); float r = sqrt(r2);
    minR = min(minR, r);
    if (r < 1.) { captured = true; break; }
    float dt = clamp(.075 * r, .045, 1.6);
    vec3 acc = -1.5 * h2 * p / (r2 * r2 * r);
    vec3 pn = p + v * dt; v += acc * dt;
    if (p.y * pn.y < 0.) {
      vec3 q = mix(p, pn, p.y / (p.y - pn.y));
      float rq = length(q.xz);
      vec3 e = disk(q, normalize(v), rq);
      float a = clamp(dot(e, vec3(.3)) * .9, 0., .97);
      col += trans * e; trans *= 1. - a;
    }
    p = pn;
    if (r > 80. && dot(p, v) > 0.) break;
  }
  if (!captured) col += trans * stars(normalize(v));
  if (!captured) col += vec3(1., .55, .2) * exp(-max(minR - 1.5, 0.) * 2.4) * .22 * trans;      // fotongyűrű-ragyogás
  col *= 1. + uFlash * .35;
  col = aces(col * 1.05);
  col *= 1. - .35 * dot(uv, uv);
  gl_FragColor = vec4(pow(max(col, 0.), vec3(.95)), 1.);
}`;

  // --- Mélytenger: fénysugarak, kausztikák, moszat, buborékok, lebegő részecskék ---
  const DEEPSEA = COMMON + `
float worley(vec2 p){ vec2 i = floor(p), f = fract(p); float d1 = 8., d2 = 8.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 g = vec2(x, y); vec2 o = hash22(i + g); o = .5 + .45 * sin(uTime * .55 + 6.2831 * o);
    float d = length(g + o - f); if (d < d1){ d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return d2 - d1; }
float caustic(vec2 p){ float a = max(0., 1. - smoothstep(0., .22, worley(p))); float b = max(0., 1. - smoothstep(0., .2, worley(p * 1.7 + 3.1))); return a * a * sqrt(a) + .6 * b * b * sqrt(b); }
float bubbles(vec2 uv, float t){
  float b = 0.;
  for (int l = 0; l < 3; l++){
    float fl = float(l); float sc = 7. + fl * 5.;
    vec2 g = uv * vec2(sc, sc * .5); g.y -= t * (.35 + fl * .12) * sc * .5;
    vec2 id = floor(g); vec2 f = fract(g) - .5;
    float h = hash12(id + fl * 13.);
    if (h > .82){
      f.x += sin(t * 2. + h * 30. + g.y * 2.) * .18;
      float rad = .08 + .1 * hash12(id + 7.);
      float d = length(f * vec2(1., 2.));
      b += smoothstep(rad, rad - .03, d) * .25 + smoothstep(.03, 0., abs(d - rad)) * .55
         + smoothstep(rad * .35, 0., length(f * vec2(1., 2.) - vec2(-rad * .35, rad * .4))) * .8;
    }
  }
  return b; }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; vec2 p = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  p += uMouse * .03;
  float t = uTime;
  vec3 deep = vec3(.004, .03, .07), mid = vec3(.0, .16, .26), top = vec3(.10, .55, .65);
  vec3 col = mix(deep, mid, smoothstep(-.1, .75, uv.y));
  col = mix(col, top, smoothstep(.62, 1.15, uv.y) * .85);
  // felszín hullámzó fénye
  float surf = caustic(vec2(p.x * 3.2, t * .15) + vec2(0., p.y * .3));
  col += vec3(.35, .85, .9) * surf * smoothstep(.72, 1.05, uv.y) * .35;
  // fénysugarak (god rays)
  float rays = 0.;
  vec2 rp = vec2(p.x + (1. - uv.y) * .35, uv.y);
  for (int i = 0; i < 4; i++){
    float fi = float(i);
    float x = rp.x * (3. + fi * 1.7) + sin(t * (.11 + fi * .03) + fi * 2.) * 1.3 + fi * 1.9;
    rays += pow(max(0., .5 + .5 * sin(x + noise(vec2(x * .3, t * .1)) * 2.)), 10. + fi * 6.) * (.55 - fi * .1);
  }
  col += vec3(.45, .85, .95) * rays * smoothstep(.0, 1., uv.y) * (.22 + .1 * uFlash);
  // tengerfenék kausztikákkal és homokdűnékkel
  float floorY = .17 + .05 * sin(p.x * 2.1 + 1.) + .03 * sin(p.x * 5.3);
  float onFloor = smoothstep(floorY + .01, floorY - .01, uv.y);
  vec2 fp = vec2(p.x * 3., uv.y * 9.) * (1. + (floorY - uv.y) * 2.);
  vec3 sand = vec3(.07, .16, .2) + vec3(.3, .7, .75) * caustic(fp * .9 + vec2(t * .05, 0.)) * .35;
  sand *= .55 + .45 * smoothstep(0., floorY, uv.y);
  col = mix(col, sand, onFloor);
  // moszat sziluettek (ringatóznak)
  for (int k = 0; k < 7; k++){
    float fk = float(k);
    float baseX = -1. + fk * .36 + .08 * sin(fk * 4.1);
    float hgt = .35 + .3 * hash12(vec2(fk, 3.));
    float yy = uv.y - floorY + .02;
    if (yy > 0. && yy < hgt){
      float sway = sin(t * (.6 + .1 * fk) + yy * 4. + fk) * .06 * yy / hgt * 2.5;
      float w = .012 * (1. - yy / hgt) + .004;
      float d = abs(p.x - baseX - sway);
      float leaf = smoothstep(w, w * .3, d);
      col = mix(col, vec3(.0, .05, .06) + vec3(.02, .12, .1) * (1. - yy / hgt), leaf * .9);
    }
  }
  // lebegő részecskék (marine snow) parallaxszal
  for (int l = 0; l < 3; l++){
    float fl = float(l);
    vec2 g = (p + uMouse * (.02 + fl * .02)) * (14. + fl * 10.) + vec2(t * .05 * (fl + 1.), -t * (.04 + fl * .02));
    vec2 id = floor(g); vec2 f = fract(g) - .5;
    float h = hash12(id + fl * 9.);
    if (h > .9){ vec2 o = (hash22(id) - .5) * .6; col += vec3(.6, .9, 1.) * smoothstep(.05, 0., length(f - o)) * (.35 + .2 * sin(t + h * 20.)); }
  }
  col += vec3(.75, .95, 1.) * bubbles(p, t) * .45;
  // mélységi köd + vignetta
  col = mix(col, deep, smoothstep(.5, -.25, uv.y) * .5);
  col *= 1. - .45 * dot(p * vec2(.8, 1.), p * vec2(.8, 1.));
  col = aces(col * 1.35);
  gl_FragColor = vec4(col, 1.);
}`;

  // --- Eső az ablakon: elmosódott éjszakai város, csúszó cseppek fénytöréssel, villámlás ---
  const RAIN = COMMON + `
vec3 city(vec2 uv, float blur){
  vec3 col = mix(vec3(.015, .02, .05), vec3(.065, .055, .13), smoothstep(-.2, .9, uv.y));
  col += vec3(.25, .3, .55) * uFlash * smoothstep(.1, 1., uv.y);
  // felhők a villám fényében
  col += vec3(.35, .38, .6) * uFlash * fbm(uv * 3. + uTime * .02) * smoothstep(.3, 1., uv.y);
  vec2 aspect = vec2(uRes.x / uRes.y, 1.);
  for (int l = 0; l < 3; l++){
    float fl = float(l); float sc = 4.5 + fl * 3.5;
    vec2 g = (uv * aspect + vec2(uTime * .004 * (fl + 1.), 0.)) * sc;
    vec2 base = floor(g);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
      vec2 id = base + vec2(float(x), float(y));
      float h = hash12(id * 1.3 + fl);
      if (h < .5) continue;
      vec2 c = id + .5 + (hash22(id + fl * 7.) - .5) * .8;
      float height = c.y / sc;
      float lit = smoothstep(.8, .15, height + fl * .06);
      if (lit <= 0.) continue;
      vec3 hue = mix(vec3(1., .55, .25), vec3(.4, .6, 1.), hash12(id + 2.));
      hue = mix(hue, vec3(1., .3, .62), step(.86, hash12(id + 5.)));
      float rad = (.22 + .3 * hash12(id + 9.)) * (1. + blur * .7);
      float d = length(g - c);
      float flick = .78 + .22 * sin(uTime * (.8 + h * 2.) + h * 50.);
      float ring = smoothstep(rad, rad * .9, d) * .25;
      col += hue * (smoothstep(rad, rad * (.25 - blur * .2), d) + ring) * lit * flick * (.2 - fl * .045);
    }
  }
  // utcai fényfolt alul
  col += vec3(.8, .45, .2) * .12 * smoothstep(.35, 0., uv.y) * (.6 + .4 * noise(vec2(uv.x * 4., uTime * .2)));
  return col; }
vec2 drops(vec2 uv, float t, out float trail){
  vec2 n = vec2(0.); trail = 0.;
  // nagy, lefelé csúszó cseppek
  vec2 a = vec2(6., 1.);
  vec2 g = uv * a * 2.2; g.y += t * .22;
  vec2 id = floor(g); vec2 st = fract(g) - .5;
  float h = hash12(id + 31.);
  float wob = sin(t * 3. + h * 20.) * .08;
  float y = -fract(t * .22 * (.6 + h * .5) + h) + .5;
  vec2 dp = vec2(st.x - (hash12(id) - .5) * .6 - wob * .5, (st.y - y) / a.x * a.y * 2.);
  float d = length(dp * vec2(1., 1.6));
  float drop = smoothstep(.07, .0, d);
  float tr = smoothstep(.05, .0, abs(dp.x)) * smoothstep(-.02, .2, st.y - y) * smoothstep(.5, .1, st.y - y);
  n += dp * drop * 12.;
  trail += tr;
  // apró, álló cseppek
  for (int l = 0; l < 2; l++){
    float fl = float(l);
    vec2 g2 = uv * (24. + fl * 18.);
    vec2 id2 = floor(g2); vec2 f2 = fract(g2) - .5;
    float h2 = hash12(id2 + fl * 5.);
    vec2 o = (hash22(id2) - .5) * .7;
    float life = fract(t * .05 + h2);
    float rad = .14 * smoothstep(1., .8, life) * step(.55, h2);
    vec2 q = f2 - o;
    float m = smoothstep(rad, rad * .4, length(q));
    n += q * m * 4.;
  }
  return n; }
float rainLines(vec2 uv, float t){
  float r = 0.;
  for (int l = 0; l < 3; l++){
    float fl = float(l);
    vec2 q = uv * vec2(70. + fl * 40., 2.5 + fl);
    q.x += q.y * .18;
    q.y += t * (6. + fl * 2.);
    vec2 id = floor(q); vec2 f = fract(q);
    float h = hash12(vec2(id.x, id.y + fl * 3.));
    r += step(.93, h) * smoothstep(.08, 0., abs(f.x - .5)) * smoothstep(0., .4, f.y) * smoothstep(1., .5, f.y) * (.25 - fl * .05);
  }
  return r; }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; vec2 p = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  float t = uTime;
  float trail;
  vec2 n = drops(p * .9 + uMouse * .01, t, trail);
  vec3 col = city(uv + n * .02 + uMouse * .01, .55);
  float lens = clamp(length(n) * 2. + trail * .6, 0., 1.);
  if (lens > .02) {
    // a csepp lencseként fordítva, élesebben mutatja a mögötte lévő fényeket
    vec3 sharp = city(uv - n * .06, .05) * 1.25;
    col = mix(col, sharp, lens);
    col += vec3(.9, .92, 1.) * pow(clamp(dot(normalize(n + 1e-4), vec2(-.6, .8)), 0., 1.), 8.) * lens * .35;
    col *= 1. - .25 * smoothstep(.6, 1., lens) * (1. - lens);
  }
  col += vec3(.6, .65, .9) * rainLines(p, t) * (.35 + uFlash * 1.5);
  col += uFlash * vec3(.55, .6, .9) * .25;
  col *= 1. - .35 * dot(p, p);
  col = aces(col * 1.5);
  gl_FragColor = vec4(col, 1.);
}`;

  const SCENES = { blackhole: BLACKHOLE, deepsea: DEEPSEA, rain: RAIN };

  let gl = null, program = null, uniforms = {}, sceneName = "", running = false, raf = 0;
  let quality = "high", lastFrame = 0, startTime = performance.now();
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  let flash = 0, nextFlash = 0, flashQueue = [];

  function initGL() {
    if (gl) return gl;
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) return null;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); gl = null; program = null; });
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

  const programs = {};
  function useScene(name) {
    if (!initGL()) return false;
    try {
      program = programs[name] ||= compile(SCENES[name]);
    } catch (error) {
      console.error("[background] shader", error);
      return false;
    }
    gl.useProgram(program);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    uniforms = Object.fromEntries(["uRes", "uTime", "uMouse", "uFlash", "uQuality"].map(u => [u, gl.getUniformLocation(program, u)]));
    sceneName = name;
    resize();
    return true;
  }

  function scale() {
    const base = { blackhole: .62, deepsea: .7, rain: .75 }[sceneName] || .7;
    return quality === "low" ? base * .55 : base;
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

  // A jelenet eseményei (villám, pulzus) innen vezérelve: a shader és a felület ugyanazt látja.
  function updateEvents(t, dt) {
    if (sceneName === "rain") {
      if (t > nextFlash) {
        const strikes = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < strikes; i++) flashQueue.push(t + i * (0.09 + Math.random() * 0.12));
        nextFlash = t + 7 + Math.random() * 11;
      }
      if (flashQueue.length && t >= flashQueue[0]) { flashQueue.shift(); flash = 0.75 + Math.random() * 0.25; }
      flash = Math.max(0, flash - dt * 2.6);
      root.style.setProperty("--scene-flash", flash.toFixed(3));
      root.style.setProperty("--scene-pulse", (0.35 + 0.15 * Math.sin(t * 0.6)).toFixed(3));
    } else if (sceneName === "blackhole") {
      flash = 0.5 + 0.5 * Math.sin(t * 0.42) * Math.sin(t * 0.13 + 1.3);
      root.style.setProperty("--scene-pulse", flash.toFixed(3));
      root.style.setProperty("--scene-flash", "0");
    } else if (sceneName === "deepsea") {
      flash = 0.5 + 0.5 * Math.sin(t * 0.5 + Math.sin(t * 0.17) * 2);
      root.style.setProperty("--scene-pulse", flash.toFixed(3));
      root.style.setProperty("--scene-flash", "0");
    }
  }

  function draw(now) {
    const t = (now - startTime) / 1000;
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;
    gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
    gl.uniform1f(uniforms.uTime, t);
    gl.uniform2f(uniforms.uMouse, mouse.x, mouse.y);
    gl.uniform1f(uniforms.uFlash, flash);
    gl.uniform1f(uniforms.uQuality, quality === "high" ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return t;
  }

  let lastEvent = 0;
  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const focused = document.hasFocus();
    const fps = quality === "low" ? 24 : focused ? 60 : 20;
    if (now - lastFrame < 1000 / fps - 2) return;
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = (now - startTime) / 1000;
    if (now - lastEvent > 50) { updateEvents(t, Math.max(dt, (now - lastEvent) / 1000)); lastEvent = now; }
    draw(now);
  }

  function drawOnce() {
    if (gl && program && sceneName) { flash = sceneName === "rain" ? 0 : 0.5; draw(performance.now()); }
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (sceneName && quality !== "off") start();
  });
  window.addEventListener("pointermove", (e) => {
    mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    mouse.ty = -(e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  // --- egyéni háttér: kép vagy (átúsztatva ismétlődő) videó, a felület színe követi ---
  let customKind = "", customUrl = "", sampleTimer = 0, crossfadeHandler = null;
  const sampler = document.createElement("canvas");
  sampler.width = sampler.height = 12;
  const sctx = sampler.getContext("2d", { willReadFrequently: true });

  function sampleColor(source) {
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
      const avgLum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n / 255;
      // élénk, jól olvasható akcentszín a domináns színből
      let [h, s, l] = rgbToHsl(...best);
      s = Math.max(s, 0.55); l = 0.68;
      const accent = hslToRgb(h, s, l), accent2 = hslToRgb((h + 0.08) % 1, s, 0.78);
      root.style.setProperty("--accent", `rgb(${accent.join(",")})`);
      root.style.setProperty("--accent-2", `rgb(${accent2.join(",")})`);
      root.style.setProperty("--glow", accent.join(","));
      root.style.setProperty("--scene-pulse", Math.min(1, avgLum * 2).toFixed(3));
    } catch { /* not ready */ }
  }
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

  function clearCustom() {
    clearInterval(sampleTimer);
    for (const v of [videoA, videoB]) {
      v.pause(); v.hidden = true; v.classList.remove("visible"); v.removeAttribute("src"); v.load();
      if (crossfadeHandler) v.removeEventListener("timeupdate", crossfadeHandler);
    }
    image.hidden = true; image.removeAttribute("src");
    for (const prop of ["--accent", "--accent-2", "--glow"]) root.style.removeProperty(prop);
    customKind = customUrl = "";
  }

  function showCustom(kind, url) {
    stop();
    canvas.hidden = true;
    if (customUrl === url && customKind === kind) return;
    clearCustom();
    customKind = kind; customUrl = url;
    if (kind === "image") {
      image.onload = () => sampleColor(image);
      image.src = url;
      image.hidden = false;
      return;
    }
    // két videó váltakozik: a vége előtt a másik indul az elejéről, és átúsztatunk (nincs ugrás)
    let active = videoA, idle = videoB;
    for (const v of [videoA, videoB]) { v.src = url; v.muted = true; v.hidden = false; v.loop = false; }
    active.classList.add("visible");
    active.play().catch(() => {});
    const FADE = 1.2;
    crossfadeHandler = function () {
      if (this !== active || !active.duration || active.duration < FADE * 3) { if (active.duration && active.duration < FADE * 3) active.loop = true; return; }
      if (active.duration - active.currentTime < FADE && idle.paused) {
        idle.currentTime = 0;
        idle.play().catch(() => {});
        idle.classList.add("visible");
        active.classList.remove("visible");
        const previous = active;
        [active, idle] = [idle, active];
        setTimeout(() => previous.pause(), FADE * 1000 + 100);
      }
    };
    videoA.addEventListener("timeupdate", crossfadeHandler);
    videoB.addEventListener("timeupdate", crossfadeHandler);
    sampleTimer = setInterval(() => { if (!document.hidden) sampleColor(active); }, 700);
  }

  // --- nyilvános API ---
  window.backgroundEngine = {
    apply(theme, settings = {}) {
      quality = settings.animations || "high";
      root.style.setProperty("--bg-dim", String((settings.background_dim ?? 55) / 100));
      const animated = theme in SCENES;
      const custom = theme === "custom" && settings.background;
      document.body.classList.toggle("animated-bg", animated || !!custom);
      document.body.classList.toggle("glass-high", (animated || !!custom) && quality === "high");
      layer.dataset.scene = custom ? "custom" : animated ? theme : "";
      if (custom) {
        showCustom(settings.background_kind, `${window.API_BASE || ""}/api/background?v=${encodeURIComponent(settings.background)}${settings._bust || ""}`);
        return;
      }
      clearCustom();
      if (!animated) { stop(); sceneName = ""; canvas.hidden = true; return; }
      canvas.hidden = false;
      if (sceneName !== theme && !useScene(theme)) { canvas.hidden = true; return; }
      resize();
      if (quality === "off" || document.hidden) { stop(); drawOnce(); }
      else start();
    },
    scenes: Object.keys(SCENES),
    benchmark(frames = 20) {   // fejlesztői mérés: átlagos GPU-idő képkockánként (ms)
      if (!gl || !program) return null;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) draw(t0 + i * 16);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return +((performance.now() - t0) / frames).toFixed(2);
    },
  };
})();
