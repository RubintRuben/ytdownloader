// background.js — élő témahátterek (WebGL) és egyéni kép/videó háttér.
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
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0., a = .5; mat2 r = mat2(.8, .6, -.6, .8); for (int i = 0; i < 5; i++){ v += a * noise(p); p = r * p * 2.03; a *= .5; } return v; }
`;

  const SCENES = ["blackhole", "minecraft", "rain"];

  const SCENE_FX = COMMON + `
uniform sampler2D uImg; uniform sampler2D uFlowMap; uniform sampler2D uPhase;
uniform float uImgAspect; uniform float uHasFlow; uniform vec3 uFlowCfg;   // speed, strength, phasescale
uniform vec4 uShine;  // intensity, length, threshold, direction
uniform float uLens;
uniform vec4 uEmit[10]; uniform vec4 uEmit2[10]; uniform int uEmitCount;
uniform vec4 uMotion[10];  // velocity x/y, lifetime, emission interval
uniform vec2 uStart[10];   // start time, sprite size
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
  if (uLens > .5) {
    float amount = .004 * (r / .014) * exp(-r / .014) * (1. - smoothstep(.025, .048, r));
    suv -= normalize(d + 1e-5) * amount / asp;
  }
  vec2 tc = cover(suv);
  vec3 col = flowed(tc).rgb;
  if (uLens > .5) col += vec3(1., .84, .65) * (1. - smoothstep(.001, .006, r)) * .085;
  if (uShine.x > 0.) {
    // The source shine uses a highlight threshold and a short, directional cast.
    vec2 dir = vec2(cos(uShine.w), sin(uShine.w)) * uShine.y * .21;
    float light = 0.;
    for (int i = 1; i <= 4; i++) {
      vec3 sampleColor = img(tc - dir * float(i) / 4.).rgb;
      light += smoothstep(max(.65, uShine.z - .1), .999, max(sampleColor.r, max(sampleColor.g, sampleColor.b)));
    }
    col += (vec3(1.) - col) * light * uShine.x * .025;
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
      col = mix(col, vec3(.92, .95, 1.), clamp(fog * .22 * a, 0., .30));
    } else if (type < 2.5) {                                           // porszemek, szentjánosbogarak
      vec2 g = (uv + vec2(sin(t * .07 * spd), t * .01 * spd)) * asp * 28.;
      vec2 id = floor(g); vec2 f = fract(g) - .5;
      float h = hash12(id + float(i) * 7.);
      if (h > .86) {
        vec2 o = (hash22(id) - .5) * .7 + vec2(sin(t * .7 + h * 30.), cos(t * .6 + h * 20.)) * .15;
        float tw = .5 + .5 * sin(t * (1. + h * 3.) + h * 40.);
        col += vec3(1., .95, .8) * smoothstep(.09 * max(e2.w, .5), 0., length(f - o)) * tw * a * .8;
      }
    } else if (type < 3.5) {                                           // fénysugarak
      vec4 motion = uMotion[i];
      float age = mod(t * spd + uStart[i].x, max(motion.w, .1));
      float life = max(motion.z, .1);
      float fade = smoothstep(0., life * .14, age) * (1. - smoothstep(life * .5, life, age));
      vec2 rel = (tc - e.xy - motion.xy * age * .4) * vec2(uImgAspect, 1.);
      float angle = atan(rel.y, rel.x) + 2.22 - min(age, life) * .022;
      float fan = .38 * exp(-pow((angle + .22) * 14., 2.)) + .62 * exp(-pow(angle * 12., 2.))
                + .32 * exp(-pow((angle - .18) * 18., 2.));
      float fall = smoothstep(.02, .12, length(rel)) * (1. - smoothstep(.14, .82, length(rel)));
      col += vec3(.67, .46, .21) * fan * fall * fade * .115 * a;
    } else if (type < 4.5) {                                           // hulló levelek
      vec4 motion = uMotion[i];
      float period = max(motion.w, .12);
      for (int j = 0; j < 6; j++) {
        float slot = float(j) * period;
        float clock = t * spd + uStart[i].x - slot;
        if (clock < 0.) continue;
        float age = mod(clock, period * 6.);
        if (age >= motion.z) continue;
        float seed = floor(clock / (period * 6.)) * 19. + float(i) * 47. + float(j);
        vec2 random = hash22(vec2(seed, 2.));
        vec2 spawn = e.xy + vec2((random.x - .50) * .64, (random.y - .5) * .35);
        vec2 drift = vec2(sin(age * 1.8 + seed) * .012, sin(age * 2.1 + seed) * .014);
        vec2 center = spawn + motion.xy * age * (.68 + .65 * random.x) + drift;
        vec2 delta = (tc - center) * vec2(uImgAspect, 1.);
        float radius = uStart[i].y * (.50 + .23 * random.y);
        if (dot(delta, delta) > radius * radius) continue;
        float angle = seed + age * (random.y - .48) * 2.2;
        vec2 q = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * delta / radius;
        q.x /= .44 + .56 * abs(cos(age * 2.3 + seed));
        float silhouette = abs(q.x) * 1.6 + abs(q.y + q.x * .19);
        float leaf = 1. - smoothstep(.78, 1., silhouette);
        float vein = 1. - smoothstep(.018, .08, abs(q.x + q.y * .12));
        float fade = smoothstep(0., .65, age) * (1. - smoothstep(motion.z * .7, motion.z, age));
        vec3 green = mix(vec3(.31, .37, .14), vec3(.58, .48, .20), random.x);
        col = mix(col, green * (.82 + vein * .3), leaf * fade * a);
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
    } else if (type < 6.5) {
      continue;  // Cursor-emitted source trails are represented by the local pointer effect.
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
  gl_FragColor = vec4(col, 1.);
}`;

  let gl = null, sceneName = "", running = false, raf = 0;
  let quality = "high", lastFrame = 0;
  const startTime = performance.now();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let fxEnabled = true;
  let pointer = null;
  let sceneDesc = null, sceneTex = {}, sceneEmitCount = 0;
  const sceneEmit = new Float32Array(40), sceneEmit2 = new Float32Array(40);
  const sceneMotion = new Float32Array(40), sceneStart = new Float32Array(20);
  const PARTICLE_TYPE = { fog: 1, dust: 2, shafts: 3, leaves: 4, stars: 5, rain: 7, snow: 8 };
  let current = null;

  function initGL() {
    if (gl) return gl;
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) return null;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    return gl;
  }

  canvas.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    stop();
    gl = null; current = null; sceneTex = {};
  });
  canvas.addEventListener("webglcontextrestored", () => {
    if (sceneName && sceneName !== "rain") showScene(sceneName);
    else if (customKey && !canvas.hidden) {
      const base = `${window.API_BASE || ""}/api/custom-themes/${customKey.split("|")[0]}/files/`;
      showWallpaperScene(base, ++sceneRequest, "custom");
    }
  });

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

  function useProgram() {
    if (!initGL()) return false;
    if (current) { resize(); return true; }
    let prog;
    try { prog = compile(SCENE_FX); } catch (error) { console.error("[background] shader", error); return false; }
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const names = ["uRes", "uTime", "uMouse", "uImg", "uFlowMap", "uPhase", "uImgAspect", "uHasFlow",
      "uFlowCfg", "uShine", "uLens", "uEmit", "uEmit2", "uEmitCount", "uMotion", "uStart"];
    current = Object.fromEntries(names.map(name => [name, gl.getUniformLocation(prog, name)]));
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

  function draw(now) {
    if (!current || canvas.hidden || !sceneDesc) return;
    const u = current;
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uTime, (now - startTime) / 1000);
    gl.uniform2f(u.uMouse, pointer ? pointer.x / innerWidth : .5, pointer ? 1 - pointer.y / innerHeight : .5);
    const textures = [sceneTex.img, sceneTex.flow || sceneTex.img, sceneTex.phase || sceneTex.img];
    textures.forEach((tex, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); });
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uImg, 0); gl.uniform1i(u.uFlowMap, 1); gl.uniform1i(u.uPhase, 2);
    const layer = sceneDesc.layers[0];
    gl.uniform1f(u.uImgAspect, sceneTex.aspect || sceneDesc.aspect || 16 / 9);
    gl.uniform1f(u.uHasFlow, layer.flow && sceneTex.flow ? 1 : 0);
    gl.uniform3f(u.uFlowCfg, layer.flow?.speed ?? .1, layer.flow?.strength ?? 1, layer.flow?.phasescale ?? 2);
    gl.uniform4f(u.uShine, layer.shine?.intensity ?? 0, layer.shine?.length ?? .1, layer.shine?.threshold ?? .95,
      (layer.shine?.direction ?? 0) * Math.PI / 180);
    gl.uniform1f(u.uLens, fxEnabled && pointer && sceneName === "blackhole" ? 1 : 0);
    gl.uniform4fv(u.uEmit, sceneEmit);
    gl.uniform4fv(u.uEmit2, sceneEmit2);
    gl.uniform4fv(u.uMotion, sceneMotion);
    gl.uniform2fv(u.uStart, sceneStart);
    gl.uniform1i(u.uEmitCount, sceneEmitCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const fps = quality === "low" ? 30 : document.hasFocus() ? 60 : 24;
    if (now - lastFrame < 1000 / fps - 2) return;
    lastFrame = now;
    draw(now);
  }

  function drawOnce() { draw(startTime + 1200); }

  function start() {
    if (running) return;
    running = true;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (!canvas.hidden && quality !== "off") start();
  });

  const glow = document.createElement("span");
  glow.className = "surface-pointer-light";
  glow.setAttribute("aria-hidden", "true");
  const lightSurfaces = ".hero, .ed-side, .source-card, .topbar, .settings-dialog, .small-dialog, .ai-popover, .context-menu";
  let pointerFrame = 0;
  function updatePointerLight() {
    pointerFrame = 0;
    const surface = fxEnabled && sceneName && pointer &&
      document.elementFromPoint(pointer.x, pointer.y)?.closest(lightSurfaces);
    if (!surface) { glow.remove(); return; }
    const rect = surface.getBoundingClientRect();
    const x = (pointer.x - rect.left) * surface.offsetWidth / rect.width - surface.clientLeft;
    const y = (pointer.y - rect.top) * surface.offsetHeight / rect.height - surface.clientTop;
    glow.style.setProperty("--pointer-x", x + "px");
    glow.style.setProperty("--pointer-y", y + "px");
    glow.style.translate = `${surface.scrollLeft}px ${surface.scrollTop}px`;
    if (glow.parentElement !== surface) surface.prepend(glow);
  }
  function queuePointerLight() {
    if (!pointerFrame) pointerFrame = requestAnimationFrame(updatePointerLight);
  }
  function clearPointer() {
    pointer = null;
    glow.remove();
  }
  window.addEventListener("pointermove", event => {
    pointer = { x: event.clientX, y: event.clientY };
    queuePointerLight();
    const now = performance.now();
    if (fxEnabled && !web.hidden && now - lastWebMove > 30) {
      lastWebMove = now;
      web.contentWindow?.postMessage({ type: "dl-mouse", x: pointer.x / innerWidth, y: pointer.y / innerHeight }, "*");
    }
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", clearPointer);
  window.addEventListener("blur", clearPointer);
  document.addEventListener("scroll", queuePointerLight, { capture: true, passive: true });

  const blocks = document.getElementById("blockParticles");
  const blockColors = ["#71943d", "#567635", "#8a6643", "#684d34"];
  window.addEventListener("click", event => {
    if (sceneName !== "minecraft" || !fxEnabled || !event.detail) return;
    blocks.hidePopover();
    blocks.showPopover();
    for (let i = 0; i < blockColors.length; i++) {
      if (blocks.childElementCount >= 12) blocks.firstElementChild.remove();
      const piece = document.createElement("i");
      piece.style.cssText = `left:${event.clientX}px; top:${event.clientY}px; color:${blockColors[i]}; width:${i % 2 + 3}px; height:${i % 2 + 3}px`;
      blocks.append(piece);
      const drift = (i - 1.5) * (9 + Math.random() * 4);
      const lift = 8 + (i % 3) * 5;
      const sprite = piece.animate([
        { transform: "translate(-2px, -2px)", opacity: 1 },
        { transform: `translate(${drift * .55}px, ${-lift}px)`, opacity: 1, offset: .37 },
        { transform: `translate(${drift}px, ${12 + i * 5}px)`, opacity: 0 },
      ], { duration: 430, easing: "linear" });
      sprite.onfinish = () => {
        piece.remove();
        if (!blocks.childElementCount) blocks.hidePopover();
      };
    }
  });

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
      const light = Math.min(1, ((0.2126 * r + 0.7152 * g + 0.0722 * b) / n / 255) * 2.2);
      root.style.setProperty("--scene-pulse", light.toFixed(3));
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
      for (let i = 0; i < 79; i++) {
        const px = Math.random() * 320, py = Math.random() * 320;
        const r = Math.random() < .06 ? 1.1 : .40 + Math.random() * .24;
        x.fillStyle = `rgba(255,244,223,${.14 + Math.random() * .40})`;
        x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
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
        showWallpaperScene(`${base}/files/`, request, "custom");
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
  async function loadSceneDescriptor(base, request, theme) {
    const response = await fetch(base + "scene.json", { cache: "no-store" });
    if (!response.ok) throw new Error("A jelenet leírófájlja nem érhető el.");
    const desc = await response.json();
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
    const parts = (desc.particles || []).filter(p => PARTICLE_TYPE[p.type] && !(theme === "minecraft" && p.type === "dust")).slice(0, 10);
    parts.forEach((p, i) => {
      const leaves = p.type === "leaves";
      const motion = p.motion || (leaves
        ? { position: [p.x + .15, p.y + .62], velocity: [-.037, -.052], lifetime: 9, rate: 1.6, size: .066, start: 4 }
        : { position: [p.x, p.y], velocity: [-.026, .03], lifetime: 14, rate: .2 * (p.rate ?? 1), size: .85, start: 6 });
      const at = p.type === "shafts" || leaves ? motion.position : [p.x, p.y];
      sceneEmit.set([...at, PARTICLE_TYPE[p.type], Math.min(1, p.alpha ?? 1)], i * 4);
      sceneEmit2.set([p.scale?.[0] ?? 1, p.scale?.[1] ?? 1, p.speed ?? 1, p.size ?? 1], i * 4);
      sceneMotion.set([...motion.velocity, motion.lifetime, 1 / Math.max(.001, motion.rate)], i * 4);
      sceneStart.set([motion.start, motion.size * (p.size ?? 1)], i * 2);
    });
    sceneEmitCount = parts.length;
    sceneDesc = desc;
    return img;
  }
  async function showWallpaperScene(base, request, theme) {
    try {
      const img = await loadSceneDescriptor(base, request, theme);
      if (!img || request !== sceneRequest) return;
      if (!useProgram()) throw new Error("A jelenet WebGL-programja nem indult el.");
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
    if (status?.state !== "ready") {
      if (status?.message) toast(status.message, [], "error");
      return;
    }
    if (status.kind === "web") {
      stop();
      canvas.hidden = true;
      showWeb(`${base}/files/${encodeURI(status.file)}?v=${status.version}`, true);
    } else if (status.kind === "scene") {
      hideWeb();
      showWallpaperScene(`${base}/files/`, request, theme);
    }
  }

  // --- nyilvános API ---
  window.backgroundEngine = {
    apply(theme, settings = {}) {
      quality = reducedMotion.matches ? "off" : (settings.animations || "high");
      fxEnabled = settings.scene_effects !== false && quality !== "off";
      queuePointerLight();
      if (theme !== "minecraft" || !fxEnabled) { blocks.replaceChildren(); blocks.hidePopover(); }
      const custom = theme?.startsWith?.("custom:") ? (settings.custom_themes || []).find(t => "custom:" + t.id === theme) : null;
      const animated = SCENES.includes(theme);
      document.body.classList.toggle("animated-bg", animated || !!custom);
      document.body.classList.toggle("glass-high", (animated || !!custom) && quality === "high");
      layer.dataset.scene = custom ? "custom" : animated ? theme : "";
      if (custom) {
        if (!customKey || custom.kind !== "scene") { stop(); sceneRequest++; canvas.hidden = true; }
        sceneName = "";
        surfaceMaterial("");
        showCustom(custom);
        return;
      }
      if (customKey) clearCustom();
      root.style.setProperty("--bg-dim", String((settings.background_dim ?? 35) / 100));
      if (!animated) {
        stop(); sceneRequest++; sceneName = ""; canvas.hidden = true;
        hideWeb();
        surfaceMaterial("");
        return;
      }
      surfaceMaterial(theme);
      if (sceneName !== theme) {
        stop();
        canvas.hidden = true;
        sceneName = theme;
        hideWeb();
        clearInterval(sampleTimer);
      }
      showScene(theme);
    },
    scenes: SCENES,
    benchmark(frames = 20) {   // fejlesztői mérés: átlagos GPU-idő képkockánként (ms)
      if (!gl || !current || canvas.hidden) return null;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) draw(t0 + i * 16);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return +((performance.now() - t0) / frames).toFixed(2);
    },
  };
})();
