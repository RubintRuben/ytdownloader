// player.js — feliratok (YouTube-szerű stílusokkal), hangsáv és sebesség az előnézethez.
(() => {
  const video = $("igVideo");
  const overlay = $("subOverlay");
  const menu = $("playerMenu");
  const menuButton = $("playerMenuBtn");
  const ccButton = $("ccBtn");
  const STORE = "downloader.player";

  const DEFAULT_STYLE = { size: 100, color: "#ffffff", bg: "#080808", bgOpacity: 75, font: "sans", edge: "none", win: 0 };
  const COLORS = [["Fehér", "#ffffff"], ["Sárga", "#ffff00"], ["Zöld", "#00ff00"], ["Cián", "#00ffff"], ["Kék", "#3d7bff"],
    ["Bíbor", "#ff00ff"], ["Piros", "#ff3b30"], ["Fekete", "#080808"]];
  const FONTS = [["Proporcionális sans-serif", "sans", '"Segoe UI", Roboto, Arial, sans-serif'],
    ["Monospace sans-serif", "mono", 'Consolas, "Cascadia Mono", monospace'],
    ["Proporcionális serif", "serif", 'Georgia, "Times New Roman", serif'],
    ["Laza", "casual", '"Comic Sans MS", "Segoe Print", cursive'],
    ["Kiskapitális", "smallcaps", '"Segoe UI", Arial, sans-serif']];
  const EDGES = [["Nincs", "none"], ["Vetett árnyék", "shadow"], ["Kiemelt", "raised"], ["Süllyesztett", "depressed"], ["Körvonal", "outline"]];
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  let prefs = { captions: false, lang: "", style: { ...DEFAULT_STYLE }, speed: 1 };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; prefs.style = { ...DEFAULT_STYLE, ...prefs.style }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch { /* optional */ } };

  let media = null;          // az aktuális info (feliratlisták, subsKey)
  let cues = [];             // [{start, end, text}]
  let activeKey = "";        // a betöltött felirat azonosítója ("m:en" / "a:hu")
  let loadSeq = 0;
  let frame = 0;

  // --- felirat-források -----------------------------------------------------
  function tracks() {
    if (!media) return [];
    const list = (media.subtitles || []).map(s => ({ key: "m:" + s.lang, label: languageName(s.lang) }));
    if (media.captionsOrig) list.push({ key: "a:" + media.captionsOrig, label: languageName(media.captionsOrig) + " (automatikus)" });
    return list;
  }

  function preferredKey() {
    const available = tracks();
    if (!available.length) return "";
    const translated = prefs.lang.startsWith("a:") && (media.translate || []).includes(prefs.lang.slice(2));
    if (available.some(t => t.key === prefs.lang) || translated) return prefs.lang;
    const base = prefs.lang.slice(2);
    const original = media.captionsOrig || (media.audioTracks || []).find(t => t.original)?.lang;
    return (base && available.find(t => t.key.slice(2) === base)?.key)
      || available.find(t => t.key === "m:hu")?.key
      || (original && available.find(t => t.key === "m:" + original)?.key)
      || available.find(t => t.key === "m:en")?.key
      || (original && available.find(t => t.key === "a:" + original)?.key)
      || available.find(t => t.key.startsWith("m:"))?.key || available[0].key;
  }

  function parseVtt(text) {
    const out = [];
    const toSec = (h, m, s, ms) => (+h || 0) * 3600 + +m * 60 + +s + +ms / 1000;
    for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
      const match = block.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/);
      if (!match) continue;
      const body = block.slice(block.indexOf(match[0]) + match[0].length).split("\n").slice(1).join("\n");
      const textOnly = body.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/[​‌‍﻿]/g, "").replace(/[ \t ]{2,}/g, " ").trim();
      if (textOnly) out.push({ start: toSec(match[1], match[2], match[3], match[4]), end: toSec(match[5], match[6], match[7], match[8]), text: textOnly });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  async function loadTrack(key) {
    const seq = ++loadSeq;
    cues = [];
    activeKey = key;
    render();
    if (!key || !media?.subsKey) return;
    const notice = $("previewNotice");
    try {
      const response = await fetch(`${API}/api/subs/${media.subsKey}?lang=${encodeURIComponent(key.slice(2))}&auto=${key.startsWith("a:")}`);
      const text = await response.text();
      if (seq !== loadSeq) return;
      if (!response.ok) throw new Error((() => { try { return JSON.parse(text).detail; } catch { return ""; } })() || "A felirat nem tölthető be.");
      cues = parseVtt(text);
      render();
    } catch (error) {
      if (seq !== loadSeq) return;
      notice.textContent = error.message;
      setTimeout(() => { if (notice.textContent === error.message) notice.textContent = ""; }, 3500);
    }
  }

  // --- megjelenítés -------------------------------------------------------------
  let lastHtml = "";
  function render() {
    if (!prefs.captions || !cues.length || video.hidden) {
      if (lastHtml) { overlay.replaceChildren(); lastHtml = ""; }
      return;
    }
    const t = video.currentTime;
    // bináris keresés az első lehetséges cue-ra, aztán az aktívak összegyűjtése
    let lo = 0, hi = cues.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) lo = mid + 1; else hi = mid; }
    const lines = [];
    for (let i = lo - 1; i >= 0 && i > lo - 40; i--) {
      const cue = cues[i];
      if (cue.end > t && !lines.includes(cue.text)) lines.unshift(cue.text);
    }
    const shown = lines.slice(-2).join("\n");
    if (shown === lastHtml) return;
    lastHtml = shown;
    overlay.replaceChildren(...shown.split("\n").filter(Boolean).map(line => {
      const span = document.createElement("span");
      span.textContent = line;
      return span;
    }));
  }

  function loop() {
    render();
    if (!video.paused) frame = requestAnimationFrame(loop);
  }
  video.addEventListener("play", () => { cancelAnimationFrame(frame); loop(); });
  video.addEventListener("seeked", render);
  video.addEventListener("timeupdate", () => { if (video.paused) render(); });

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${alpha})`;
  }

  function applyStyle() {
    const s = prefs.style;
    const font = FONTS.find(f => f[1] === s.font) || FONTS[0];
    overlay.style.setProperty("--sub-scale", String(s.size / 100));
    overlay.style.setProperty("--sub-color", s.color);
    overlay.style.setProperty("--sub-bg", hexToRgba(s.bg, s.bgOpacity / 100));
    overlay.style.setProperty("--sub-font", font[2]);
    overlay.style.fontVariant = s.font === "smallcaps" ? "small-caps" : "normal";
    const shadow = {
      none: "none",
      shadow: "2px 2px 3px rgba(0,0,0,.9), 2px 2px 6px rgba(0,0,0,.6)",
      raised: "1px 1px 0 rgba(0,0,0,.9), 2px 2px 0 rgba(0,0,0,.7)",
      depressed: "-1px -1px 0 rgba(0,0,0,.9), 1px 1px 0 rgba(255,255,255,.35)",
      outline: "-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 0 3px #000",
    }[s.edge] || "none";
    overlay.style.setProperty("--sub-shadow", shadow);
  }

  function setCaptions(on, key) {
    prefs.captions = !!on;
    if (key) prefs.lang = key;
    save();
    ccButton.setAttribute("aria-pressed", String(prefs.captions));
    ccButton.classList.toggle("on", prefs.captions);
    const wanted = prefs.captions ? (key || preferredKey()) : "";
    if (wanted !== activeKey) loadTrack(wanted);
    else render();
  }

  // --- menü (YouTube-szerű, almenükkel) -------------------------------------
  function openMenu(view = "root") {
    menu.replaceChildren();
    const header = (title) => {
      const head = document.createElement("button");
      head.type = "button";
      head.className = "pm-head";
      head.innerHTML = `<span aria-hidden="true">‹</span> ${escapeHtml(title)}`;
      head.addEventListener("click", () => openMenu(view.startsWith("style-") ? "style" : "root"));
      menu.appendChild(head);
    };
    const item = (label, value, onClick, checked) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pm-item" + (checked ? " checked" : "");
      b.role = checked === undefined ? "menuitem" : "menuitemradio";
      if (checked !== undefined) b.setAttribute("aria-checked", String(!!checked));
      b.innerHTML = `<span>${escapeHtml(label)}</span>${value !== null && value !== undefined ? `<em>${escapeHtml(value)}</em>` : ""}`;
      b.addEventListener("click", onClick);
      menu.appendChild(b);
      return b;
    };
    const list = tracks();
    const currentLabel = () => {
      if (!prefs.captions || !activeKey) return "Ki";
      const found = list.find(t => t.key === activeKey);
      return found ? found.label : languageName(activeKey.slice(2)) + " (fordítás)";
    };
    if (view === "root") {
      if (list.length) item("Feliratok", currentLabel() + " ›", () => openMenu("subs"));
      item("Feliratstílus", "›", () => openMenu("style"));
      const audio = media?.audioTracks || [];
      if (audio.length > 1) {
        const current = audio.find(t => (t.original ? "" : t.lang) === audioLang) || audio[0];
        item("Hangsáv", languageName(current.lang) + (current.original ? " (eredeti)" : "") + " ›", () => openMenu("audio"));
      }
      item("Lejátszási sebesség", (prefs.speed === 1 ? "Normál" : prefs.speed + "×") + " ›", () => openMenu("speed"));
    } else if (view === "subs") {
      header("Feliratok");
      item("Ki", null, () => { setCaptions(false); closeMenu(); }, !prefs.captions);
      for (const t of list) item(t.label, null, () => { setCaptions(true, t.key); closeMenu(); }, prefs.captions && activeKey === t.key);
      if (media?.captionsOrig && media.translate?.length) item("Automatikus fordítás", "›", () => openMenu("translate"));
    } else if (view === "translate") {
      header("Automatikus fordítás");
      const codes = [...media.translate].filter(c => c !== media.captionsOrig)
        .sort((a, b) => languageName(a).localeCompare(languageName(b), "hu"));
      const hu = codes.indexOf("hu");
      if (hu > 0) codes.unshift(...codes.splice(hu, 1));
      for (const code of codes) item(languageName(code), null, () => { setCaptions(true, "a:" + code); closeMenu(); },
        prefs.captions && activeKey === "a:" + code);
    } else if (view === "audio") {
      header("Hangsáv");
      for (const t of media.audioTracks) {
        const value = t.original ? "" : t.lang;
        item(languageName(t.lang) + (t.original ? " (eredeti)" : ""), null, () => {
          closeMenu();
          setAudioLang(value, true);
          reloadPreviewAudio();
        }, value === audioLang);
      }
    } else if (view === "speed") {
      header("Lejátszási sebesség");
      for (const speed of SPEEDS) item(speed === 1 ? "Normál" : speed + "×", null, () => {
        prefs.speed = speed; save(); video.playbackRate = speed; closeMenu();
      }, prefs.speed === speed);
    } else if (view === "style") {
      header("Feliratstílus");
      const s = prefs.style;
      item("Betűméret", s.size + "% ›", () => openMenu("style-size"));
      item("Betűszín", (COLORS.find(c => c[1] === s.color) || ["Egyéni"])[0] + " ›", () => openMenu("style-color"));
      item("Betűtípus", (FONTS.find(f => f[1] === s.font) || FONTS[0])[0] + " ›", () => openMenu("style-font"));
      item("Háttérszín", (COLORS.find(c => c[1] === s.bg) || ["Egyéni"])[0] + " ›", () => openMenu("style-bg"));
      item("Háttér átlátszatlansága", s.bgOpacity + "% ›", () => openMenu("style-opacity"));
      item("Karakterszegély", (EDGES.find(e => e[1] === s.edge) || EDGES[0])[0] + " ›", () => openMenu("style-edge"));
      item("Alaphelyzet", null, () => { prefs.style = { ...DEFAULT_STYLE }; save(); applyStyle(); openMenu("style"); });
      const preview = document.createElement("div");
      preview.className = "pm-preview";
      preview.innerHTML = "<span>Így néz ki a felirat</span>";
      menu.appendChild(preview);
      const sample = preview.firstElementChild;
      const st = getComputedStyle(overlay);
      sample.style.cssText = `color:${s.color};background:${st.getPropertyValue("--sub-bg")};font-family:${st.getPropertyValue("--sub-font")};text-shadow:${st.getPropertyValue("--sub-shadow")};font-size:${Math.round(13 * s.size / 100)}px`;
    } else {
      header({ "style-size": "Betűméret", "style-color": "Betűszín", "style-font": "Betűtípus", "style-bg": "Háttérszín",
        "style-opacity": "Háttér átlátszatlansága", "style-edge": "Karakterszegély" }[view]);
      const set = (key, value) => () => { prefs.style[key] = value; save(); applyStyle(); openMenu("style"); };
      const s = prefs.style;
      if (view === "style-size") [50, 75, 100, 150, 200, 300].forEach(v => item(v + "%", null, set("size", v), s.size === v));
      if (view === "style-color") COLORS.forEach(([n, v]) => item(n, null, set("color", v), s.color === v).style.setProperty("--swatch", v));
      if (view === "style-bg") COLORS.forEach(([n, v]) => item(n, null, set("bg", v), s.bg === v).style.setProperty("--swatch", v));
      if (view === "style-font") FONTS.forEach(([n, v]) => item(n, null, set("font", v), s.font === v));
      if (view === "style-opacity") [0, 25, 50, 75, 100].forEach(v => item(v + "%", null, set("bgOpacity", v), s.bgOpacity === v));
      if (view === "style-edge") EDGES.forEach(([n, v]) => item(n, null, set("edge", v), s.edge === v));
      if (view === "style-color" || view === "style-bg") menu.classList.add("swatches"); else menu.classList.remove("swatches");
    }
    if (!view.startsWith("style-")) menu.classList.remove("swatches");
    menu.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
    menu.querySelector(".pm-item, .pm-head")?.focus({ preventScroll: true });
  }

  function closeMenu() {
    menu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  }

  menuButton.addEventListener("click", () => menu.hidden ? openMenu() : closeMenu());
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !event.target.closest("#playerMenu, #playerMenuBtn")) closeMenu();
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) { closeMenu(); menuButton.focus(); } });
  ccButton.addEventListener("click", () => setCaptions(!prefs.captions));

  // Az előnézet a stage-en belül skálázódik: a felirat mérete a lejátszó magasságát követi.
  new ResizeObserver(([entry]) => {
    overlay.style.setProperty("--stage-h", entry.contentRect.height + "px");
  }).observe($("stage"));

  applyStyle();

  window.playerHooks = {
    load(info) {
      media = info;
      cues = [];
      activeKey = "";
      lastHtml = "";
      overlay.replaceChildren();
      ccButton.hidden = !tracks().length;
      ccButton.classList.toggle("on", prefs.captions);
      ccButton.setAttribute("aria-pressed", String(prefs.captions));
      video.playbackRate = prefs.speed;
      video.defaultPlaybackRate = prefs.speed;
      closeMenu();
      if (prefs.captions && tracks().length) loadTrack(preferredKey());
    },
    reset() { media = null; cues = []; activeKey = ""; overlay.replaceChildren(); lastHtml = ""; closeMenu(); },
    audioChanged() { reloadPreviewAudio(); },
    toggleCaptions() { if (tracks().length) setCaptions(!prefs.captions); },
  };
  video.addEventListener("loadeddata", () => { video.playbackRate = prefs.speed; });
})();
