// app.js — Downloader frontend (YouTube + Instagram, kereső + editor).

// --- Globális hibakijelző (látható a képernyőn + konzolban) -----------------
function showFatal(msg) {
  let box = document.getElementById("fatalError");
  if (!box) {
    box = document.createElement("div");
    box.id = "fatalError";
    box.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fff;" +
      "padding:12px 16px;font:13px/1.5 monospace;white-space:pre-wrap;max-height:40vh;overflow:auto;" +
      "box-shadow:0 4px 20px rgba(0,0,0,.5)";
    document.body.appendChild(box);
  }
  box.textContent = "⚠ HIBA: " + msg;
}
window.addEventListener("error", (e) => {
  console.error("[Downloader error]", e.message, e.filename, e.lineno);
  showFatal(`${e.message}\n  (${e.filename}:${e.lineno}:${e.colno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[Downloader promise]", e.reason);
  showFatal("Promise: " + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

const API = (window.API_BASE || "").replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

// tabok / landing
const tabsEl = $("tabs");
const heroTitle = $("heroTitle");
const heroSub = $("heroSub");
const sourceHint = $("sourceHint");
const sourcePanel = $("sourcePanel");
const landing = $("landing");
const searchForm = $("searchForm");
const urlInput = $("url");
const fetchBtn = $("fetchBtn");
const fetchText = fetchBtn.querySelector(".btn-text");
const fetchSpinner = fetchBtn.querySelector(".spinner");
const statusEl = $("status");
const resultsEl = $("results");
const resultsGrid = $("resultsGrid");
const resultsTitle = $("resultsTitle");
const ytChannels = $("ytChannels");
const ytChannelsRow = $("ytChannelsRow");
// folyamatok menü
const jobsBtn = $("jobsBtn");
const jobsBadge = $("jobsBadge");
const jobsPanel = $("jobsPanel");
const jobsOverlay = $("jobsOverlay");
const jobsClose = $("jobsClose");
const jobsList = $("jobsList");
const jobsEmpty = $("jobsEmpty");
const cancelBtn = $("cancelBtn");
// letöltési lista menü
const listBtn = $("listBtn");
const listBadge = $("listBadge");
const listPanel = $("listPanel");
const listOverlay = $("listOverlay");
const listClose = $("listClose");
const listItemsEl = $("listItems");
const listEmpty = $("listEmpty");
const listToolbar = $("listToolbar");
const listSelectAll = $("listSelectAll");
const listSelCount = $("listSelCount");
const listRemoveSel = $("listRemoveSel");
const listDownloadSel = $("listDownloadSel");
// editor lista-gombok
const addListBtn = $("addListBtn");
const addListText = $("addListText");
const removeListBtn = $("removeListBtn");
// editor
const editor = $("editor");
const backBtn = $("backBtn");
const edUrl = $("edUrl");
const stage = $("stage");
const igVideo = $("igVideo");
const titleEl = $("title");
const uploaderEl = $("uploader");
const formatToggle = $("formatToggle");
const qualityLabel = $("qualityLabel");
const qualitySelect = $("quality");
const trimBlock = $("trimBlock");
const startTimeEl = $("startTime");
const endTimeEl = $("endTime");
const selectedLenEl = $("selectedLen");
const estimateSizeEl = $("estimateSize");
const downloadBtn = $("downloadBtn");
const dlText = downloadBtn.querySelector(".dl-text");
const progressBox = $("progressBox");
const progressFill = $("progressFill");
const progressStage = $("progressStage");
const progressMeta = $("progressMeta");
const progressPct = $("progressPct");
// timeline
const edTimeline = $("edTimeline");
const playBtn = $("playBtn");
const playPath = $("playPath");
const PLAY_D = "M8 5v14l11-7z";
const PAUSE_D = "M6 5h4v14H6zM14 5h4v14h-4z";
const curTimeEl = $("curTime");
const totTimeEl = $("totTime");
const timeline = $("timeline");
const filmstrip = $("filmstrip");
const tlWindow = $("tlWindow");
const handleL = $("handleL");
const handleR = $("handleR");
const dimLeft = $("dimLeft");
const dimRight = $("dimRight");
const playhead = $("playhead");
const bubbleL = $("bubbleL");
const bubbleR = $("bubbleR");
const phBubble = $("phBubble");

let currentTab = "any";
let currentFormat = "mp4";
let info = null;
let isInstagram = false;       // az aktuálisan betöltött média Instagram-e
let isYoutube = false;         // …vagy YouTube (a többi: univerzális 'other')
let igPostsMode = false;       // az IG keresőben épp egy fiók reeljeit nézzük-e
let ytSearchState = null;      // a YT végtelen görgetés állapota {query, shown, loading, done}
let searchToken = 0;           // minden új keresés/tab-váltás növeli; az elavult válaszokat eldobjuk
let duration = 0;
let selStart = 0;
let selEnd = 0;
let loopSelection = false;
let previewGeneration = 0;
let previewController = null;
let retryPreview = null;
let previewWantPlay = false;
let seekPreview = null;
let frameSampler = null;
let pendingSelection = null;
let pendingPreviewSeek = null;
const MP3_BITRATES = [320, 256, 192, 128, 96];

// előnézet-lejátszó: a <video> (igVideo) állását figyelő időzítő
let pollTimer = null;

// --- segédek ---------------------------------------------------------------

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
function fmtSize(b) {
  if (!b || b < 0) return "—";
  const mb = b / 1048576;
  if (mb < 1) return (b / 1024).toFixed(0) + " KB";
  if (mb < 1024) return mb.toFixed(1) + " MB";
  return (mb / 1024).toFixed(2) + " GB";
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return "";
  return fmtSize(bps) + "/s";
}
function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (type || "");
  statusEl.hidden = false;
}
function hideStatus() { statusEl.hidden = true; }
function setLoading(on) {
  fetchBtn.disabled = on;
  fetchSpinner.hidden = !on;
  fetchText.textContent = on ? "…" : (currentTab === "youtube" ? "Keresés" : "Megnyitás");
}

function looksLikeUrl(s) {
  return /^\w+:\/\//i.test(s) || /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(s);
}

function sourceUrlError(value, tab) {
  let url;
  try { url = new URL(/^\w+:\/\//.test(value) ? value : "https://" + value); }
  catch { return "Érvénytelen videólink."; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "Érvénytelen videólink.";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const youtube = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host);
  const instagram = ["instagram.com", "instagr.am", "ig.me"].includes(host) || host.endsWith(".instagram.com");
  const tiktok = ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "m.tiktok.com"].includes(host);
  if (tab === "youtube" && !youtube) return "Ide csak YouTube-linket illeszthetsz be. Más forráshoz válts a megfelelő részre.";
  if (tab === "instagram" && !instagram) return "Ide csak Instagram-linket illeszthetsz be. Más forráshoz válts a megfelelő részre.";
  if (tab === "tiktok" && !tiktok) return "Ide TikTok-linket illeszthetsz be.";
  return "";
}

// --- Tabok -----------------------------------------------------------------

tabsEl.addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b || b.dataset.tab === currentTab) return;
  setTab(b.dataset.tab);
});

sourcePanel.addEventListener("click", (event) => {
  const card = event.target.closest("[data-source]");
  if (card) setTab(card.dataset.source);
});

const hero = document.querySelector(".hero");
if (matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches) {
  hero.addEventListener("pointermove", (event) => {
    const rect = hero.getBoundingClientRect();
    hero.style.setProperty("--spot-x", (event.clientX - rect.left) + "px");
    hero.style.setProperty("--spot-y", (event.clientY - rect.top) + "px");
  });
}

$("pasteLinkBtn").addEventListener("click", async () => {
  try {
    const native = window.pywebview?.api;
    const text = native?.clipboard_text ? await native.clipboard_text() : await navigator.clipboard.readText();
    if (text?.trim()) {
      urlInput.value = text.trim();
      hideStatus();
    } else showStatus("A vágólapon most nincs szöveg.", "error");
  } catch {
    showStatus("Illeszd be a linket a Ctrl+V billentyűvel.", "error");
  }
  urlInput.focus();
});

function setTab(tab) {
  if (tab === "other") tab = "any";
  const wasInEditor = !editor.hidden;
  if (wasInEditor) {
    stopPreview();
    clearInterval(pollTimer);
    showView("landing");
  }

  currentTab = tab;
  sourcePanel.hidden = tab !== "any";
  tabsEl.querySelectorAll(".tab").forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (tab === "instagram") {
    heroTitle.textContent = "Instagram letöltő";
    heroSub.textContent = "Illeszd be egy reel vagy videóposzt linkjét.";
    urlInput.placeholder = "Illeszd be egy Instagram reel/poszt linkjét…";
    sourceHint.textContent = "";
  } else if (tab === "tiktok") {
    heroTitle.textContent = "TikTok letöltő";
    heroSub.textContent = "Használhatod a megosztásnál kapott rövid linket vagy a videó teljes címét.";
    urlInput.placeholder = "TikTok-videó linkje…";
    sourceHint.textContent = "";
  } else if (tab === "any") {
    heroTitle.textContent = "Videók letöltése";
    heroSub.textContent = "Illeszd be a linket, és mentsd el a videót vagy a hangját.";
    urlInput.placeholder = "Illessz be egy videólinket…";
    sourceHint.textContent = "Vimeo- és Dailymotion-linkeket is megnyit.";
  } else {
    heroTitle.textContent = "YouTube-letöltő";
    heroSub.textContent = "Keress a videó címére, vagy illeszd be a YouTube-linket.";
    urlInput.placeholder = "YouTube link vagy keresőszó…";
    sourceHint.textContent = "";
  }
  // tab-váltáskor tiszta lap — és a futó keresést azonnal érvénytelenítjük,
  // hogy a régi tab válasza NE jelenjen meg az új tabon
  searchToken++;
  searchController?.abort();
  ytSearchState = null;
  setLoading(false);
  hideStatus();
  resultsEl.hidden = true;
  resultsGrid.innerHTML = "";
  if (ytChannels) { ytChannels.hidden = true; ytChannelsRow.innerHTML = ""; }
  igPostsMode = false;
  urlInput.value = "";
  urlInput.focus();
}

// --- Landing: link VAGY keresés --------------------------------------------

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  handleInput();
});

async function handleInput() {
  const raw = urlInput.value.trim();
  if (!raw) { showStatus("Illeszd be a linket vagy írj be egy keresőszót.", "error"); return; }

  // Ha link → egyből editor.
  if (looksLikeUrl(raw)) {
    loadFromUrl(raw);
    return;
  }
  // Nem link:
  if (currentTab === "any") {
    showStatus("Illessz be egy videólinket, vagy válts a YouTube-keresésre.", "error");
  } else if (currentTab === "tiktok") {
    showStatus("Illessz be egy TikTok-videólinket.", "error");
  } else if (currentTab === "instagram") {
    // Instagram: nincs keresés (cookie nélkül nem megbízható) — csak link-beillesztés.
    showStatus("Az Instagram fülön illeszd be egy reel vagy poszt linkjét.", "error");
  } else {
    // YouTube cím-keresés
    runSearch(raw, "youtube");
  }
}

// --- YouTube keresés (találati boxok) --------------------------------------

function renderSkeletons(n, keepTitle) {
  resultsEl.hidden = false;
  if (!keepTitle) resultsTitle.textContent = "Keresés…";
  resultsGrid.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div");
    c.className = "result-card skeleton";
    c.innerHTML = `<div class="rc-thumb"></div><div class="sk-line a"></div><div class="sk-line b"></div>`;
    resultsGrid.appendChild(c);
  }
}

const YT_SEARCH_FIRST = 18;
let searchController = null;

async function runSearch(query, source) {
  source = source || "youtube";
  const myToken = ++searchToken;   // ez a keresés azonosítója; ha közben tab-ot váltunk, elavul
  searchController?.abort();
  searchController = new AbortController();
  const signal = searchController.signal;
  igPostsMode = false;
  setLoading(true);
  hideStatus();
  renderSkeletons(12);
  try {
    const res = await fetch(`${API}/api/search?q=` + encodeURIComponent(query) +
                            "&limit=" + YT_SEARCH_FIRST + "&source=youtube", { signal });
    // ha közben tab-ot váltottak (vagy új keresés indult), ezt a választ eldobjuk
    if (myToken !== searchToken) return;
    const data = await res.json();
    if (myToken !== searchToken) return;
    if (!res.ok) throw new Error(data.detail || "A keresés nem sikerült.");
    const items = data.results || [];
    if (!items.length) {
      resultsEl.hidden = true;
      showStatus("Nincs találat erre: " + query, "error");
      return;
    }
    // YouTube: előbb a csatorna-sor (kerek profilképek), alatta a videó-találatok
    const channels = data.channels || [];
    ytChannelsRow.innerHTML = "";
    if (channels.length) {
      channels.forEach((c, i) => ytChannelsRow.appendChild(makeChannelCard(c, i)));
      ytChannels.hidden = false;
    } else {
      ytChannels.hidden = true;
    }
    // YouTube videó-találatok + végtelen görgetés indítása
    ytSearchState = { query, shown: items.length, loading: false, done: items.length < YT_SEARCH_FIRST };
    resultsTitle.textContent = `Találatok: „${query}”`;
    resultsGrid.className = "results-grid";
    resultsGrid.innerHTML = "";
    items.forEach((it, i) => resultsGrid.appendChild(makeVideoCard(it, i)));
    resultsEl.hidden = false;
    fetch(`${API}/api/search/channels?q=${encodeURIComponent(query)}`, { signal })
      .then(r => r.ok ? r.json() : { channels: [] })
      .then(data => {
        if (myToken !== searchToken) return;
        ytChannelsRow.replaceChildren(...(data.channels || []).map(makeChannelCard));
        ytChannels.hidden = !data.channels?.length;
      }).catch(() => {});
  } catch (e) {
    if (myToken !== searchToken) return;   // elavult keresés hibája — némán elnyeljük
    console.error("[Downloader] keresés hiba:", e);
    resultsEl.hidden = true;
    showStatus("Hiba a keresésnél: " + e.message, "error");
  } finally {
    if (myToken === searchToken) setLoading(false);
  }
}

// --- videó-kártya (YouTube találat / IG reel) ---
function makeVideoCard(it, i, igStyle) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "result-card" + (igStyle ? " ig" : "");
  card.style.animationDelay = (Math.min(i, 12) * 30) + "ms";
  const dur = it.duration ? `<span class="rc-dur">${fmtTime(it.duration)}</span>` : "";
  const thumb = it.thumbnail ? `${API}/api/thumb?url=` + encodeURIComponent(it.thumbnail) : "";
  // a reel készítőjének profilképe (ha van) — kis kerek avatar az uploader előtt
  const avatar = it.authorPic
    ? `<img class="rc-avatar" src="${API}/api/thumb?url=${encodeURIComponent(it.authorPic)}" alt="" onerror="this.style.display='none'">`
    : "";
  card.innerHTML = `
    <div class="rc-thumb">
      ${thumb ? `<img src="${thumb}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ""}
      ${dur}
      <div class="rc-play"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></div>
    </div>
    <div class="rc-body">
      <div class="rc-title">${escapeHtml(it.title)}</div>
      <div class="rc-uploader">${avatar}<span>${escapeHtml(it.uploader || "")}</span></div>
    </div>`;
  card.addEventListener("click", () => loadFromUrl(it.url));
  return card;
}

// (Az IG ember-kereső kártyák megszűntek — az Instagram fülön már csak link-beillesztés van.)

// követőszám rövid formázása (504000000 → "504M")
function fmtFollowers(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "Mrd";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "E";
  return String(n);
}

// --- csatorna-kártya (YouTube csatorna-keresés, kerek profilkép) ---
function makeChannelCard(c, i) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "channel-card";
  card.style.animationDelay = (Math.min(i, 8) * 30) + "ms";
  const pic = c.thumbnail ? `${API}/api/thumb?url=` + encodeURIComponent(c.thumbnail) : "";
  const initial = escapeHtml((c.title || "?").charAt(0).toUpperCase());
  const subs = c.followers ? `<div class="cc-subs">${fmtFollowers(c.followers)} feliratkozó</div>` : "";
  card.innerHTML = `
    <div class="cc-pic"><span class="cc-initial">${initial}</span>${pic ? `<img src="${pic}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}</div>
    <div class="cc-name">${escapeHtml(c.title)}</div>
    ${subs}`;
  card.addEventListener("click", () => openYtChannel(c.id, c.title));
  return card;
}

// egy YouTube csatorna videóinak betöltése (a csatorna-kártyára kattintva)
async function openYtChannel(channelId, title) {
  const myToken = ++searchToken;
  igPostsMode = false;
  setLoading(true);
  hideStatus();
  resultsEl.hidden = false;
  ytChannels.hidden = true;
  resultsGrid.className = "results-grid";
  renderSkeletons(8, true);
  resultsTitle.innerHTML = `<button class="back-link" id="chBack">← Vissza</button> ${escapeHtml(title || "Csatorna")} videói`;
  $("chBack").addEventListener("click", () => runSearch(ytSearchState ? ytSearchState.query : title, "youtube"));
  try {
    const res = await fetch(`${API}/api/yt/channel?channel_id=` + encodeURIComponent(channelId) + "&limit=48");
    if (myToken !== searchToken) return;
    const data = await res.json();
    if (myToken !== searchToken) return;
    if (!res.ok) throw new Error(data.detail || "Nem sikerült.");
    const vids = data.videos || [];
    resultsGrid.innerHTML = "";
    if (!vids.length) { showStatus("Ennek a csatornának nincs elérhető videója.", "error"); return; }
    vids.forEach((v, i) => resultsGrid.appendChild(makeVideoCard(v, i)));
  } catch (e) {
    if (myToken !== searchToken) return;
    resultsGrid.innerHTML = "";
    showStatus("Hiba: " + e.message, "error");
  } finally {
    if (myToken === searchToken) setLoading(false);
  }
}

// (Az IG fiók-reel böngészés megszűnt — az Instagram fülön link-beillesztés van.)

// --- YouTube végtelen görgetés ---
async function loadMoreYt() {
  if (!ytSearchState || ytSearchState.loading || ytSearchState.done) return;
  const myToken = searchToken;
  ytSearchState.loading = true;
  const next = ytSearchState.shown + 24;   // egyszerre sok továbbit töltünk (mint az igazi YT)
  try {
    const res = await fetch(`${API}/api/search?q=` + encodeURIComponent(ytSearchState.query) +
                            "&limit=" + next + "&source=youtube");
    const data = await res.json();
    if (myToken !== searchToken || !ytSearchState) return;   // tab-váltás közben — eldobjuk
    const items = data.results || [];
    if (items.length <= ytSearchState.shown) { ytSearchState.done = true; return; }
    for (let i = ytSearchState.shown; i < items.length; i++) {
      resultsGrid.appendChild(makeVideoCard(items[i], i));
    }
    if (items.length < next) ytSearchState.done = true;
    ytSearchState.shown = items.length;
  } catch { /* csendben */ } finally {
    if (ytSearchState) ytSearchState.loading = false;
  }
}

// görgetésre töltsünk be többet (a landing görgethető)
landing.addEventListener("scroll", () => {
  if (currentTab !== "youtube" || igPostsMode || resultsEl.hidden) return;
  const nearBottom = landing.scrollTop + landing.clientHeight >= landing.scrollHeight - 600;
  if (nearBottom) loadMoreYt();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- info lekérés (link vagy találat → editor) -----------------------------

async function loadFromUrl(url, keepListEdit) {
  const sourceError = sourceUrlError(url, currentTab);
  if (sourceError) { showStatus(sourceError, "error"); return false; }
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const infoToken = ++searchToken;
  searchController?.abort();
  // friss betöltés (link/kártya) → ez NEM egy lista-elem szerkesztése.
  // (Az openListItem true-val hívja, mert ott pont egy lista-elemet nyitunk.)
  if (!keepListEdit) editingListId = null;
  urlInput.value = url;
  setLoading(true);
  showStatus("Betöltés…", "loading");
  try {
    const res = await fetch(`${API}/api/info?url=` + encodeURIComponent(url) + "&source=" + currentTab);
    const data = await res.json();
    if (infoToken !== searchToken) return false;
    if (!res.ok) throw new Error(data.detail || "Hiba történt.");
    info = data;
    isInstagram = data.source === "instagram";
    isYoutube = data.source === "youtube";
    duration = data.duration || 0;
    selStart = 0;
    selEnd = duration;
    openEditor(url);
    return true;
  } catch (e) {
    if (infoToken !== searchToken) return false;
    console.error("[Downloader] info HIBA:", e);
    showStatus("Hiba: " + e.message, "error");
    return false;
  } finally {
    if (infoToken === searchToken) setLoading(false);
  }
}

function showView(which) {
  const showEditor = which === "editor";
  landing.hidden = showEditor;
  editor.hidden = !showEditor;
}

function openEditor(url) {
  hideStatus();
  showView("editor");
  edUrl.textContent = url;
  edUrl.title = url;
  $("editorSource").textContent = {youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram"}[info.source] || "Web";

  // EGYSÉGES előnézet: MINDEN forrásnál a <video> elem szól, és a timeline mindig
  // kattintható/vágható (a videó hosszára épül). YouTube-nál storyboard-kockákat is
  // rajzolunk a csíkba; a többi forrásnál sima (kockák nélküli) idősáv.
  editor.classList.remove("no-timeline");
  editor.classList.toggle("timeline-pending", !(duration > 0));
  trimBlock.hidden = false;
  timeline.setAttribute("aria-busy", String(!(duration > 0)));
  pendingSelection = null;

  stage.classList.remove("ready");
  titleEl.classList.remove("title-skeleton");
  titleEl.textContent = info.title || "";
  uploaderEl.textContent = info.uploader || "";
  totTimeEl.textContent = fmtTime(duration);
  curTimeEl.textContent = "0:00";

  updateQuality();
  refreshEstimate();
  updateEditorListButtons();

  // a filmstrip: YouTube-nál storyboard-kockák, máshol üres (a sima csík marad)
  buildFilmstrip();
  requestAnimationFrame(layoutWindow);
  setupDirectPlayer();
}

function updateTimelineDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const previousDuration = duration;
  const fullSelection = selEnd <= 0 || Math.abs(selEnd - previousDuration) < 0.1;
  duration = seconds;
  info.duration = seconds;
  if (pendingSelection) {
    selStart = Math.max(0, pendingSelection.start || 0);
    selEnd = pendingSelection.end > 0 ? Math.min(seconds, pendingSelection.end) : seconds;
    pendingSelection = null;
  } else selEnd = fullSelection ? seconds : Math.min(selEnd, seconds);
  selStart = Math.min(Math.max(0, selStart), Math.max(0, selEnd - Math.min(0.1, seconds)));
  editor.classList.remove("no-timeline", "timeline-pending");
  trimBlock.hidden = false;
  timeline.setAttribute("aria-busy", "false");
  totTimeEl.textContent = fmtTime(seconds);
  layoutWindow();
  scheduleEstimate();
}

function releaseFrameSampler() {
  if (!frameSampler) return;
  frameSampler.pause();
  frameSampler.removeAttribute("src");
  frameSampler.load();
  frameSampler = null;
}

function stopPreview() {
  previewGeneration++;
  previewController?.abort();
  previewController = null;
  previewWantPlay = false;
  seekPreview = null;
  clearInterval(pollTimer);
  releaseFrameSampler();
  for (const name of ["onloadedmetadata", "ondurationchange", "onloadeddata", "onerror", "onwaiting", "onplaying", "oncanplay"]) {
    igVideo[name] = null;
  }
  igVideo.pause();
  igVideo.hidden = true;
  igVideo.removeAttribute("src");
  igVideo.load();
}

function setupDirectPlayer(refresh = false) {
  stopPreview();
  const generation = previewGeneration;
  const controller = new AbortController();
  previewController = controller;
  const signal = controller.signal;
  const active = () => !signal.aborted && generation === previewGeneration;
  const notice = $("previewNotice");
  const retryButton = $("previewRetry");
  const poster = $("previewPoster");
  const setNotice = text => { notice.textContent = text; };
  let streamController;
  let mediaTimer;
  let seekTimer;
  let mode;
  let hasAudio = true;
  let fallbackStarted = false;
  let framesStarted = false;

  poster.hidden = !info.thumbnail;
  if (info.thumbnail) poster.src = API + "/api/thumb?url=" + encodeURIComponent(info.thumbnail);
  else poster.removeAttribute("src");
  stage.classList.add("ready");
  igVideo.preload = "auto";
  retryButton.hidden = true;
  playBtn.disabled = info.isLive;
  lastSeekT = -1;
  pendingPreviewSeek = null;
  setNotice("Előnézet betöltése…");
  setPlayIcon(false);

  const fail = message => {
    if (!active()) return;
    clearTimeout(mediaTimer);
    setNotice(message);
    retryButton.hidden = false;
    setPlayIcon(false);
  };
  retryPreview = () => setupDirectPlayer(true);
  signal.addEventListener("abort", () => {
    clearTimeout(mediaTimer);
    clearTimeout(seekTimer);
    streamController?.abort();
  }, { once: true });

  function switchSource() {
    if (!active()) return;
    const target = pendingPreviewSeek ?? igVideo.currentTime;
    previewWantPlay ||= !igVideo.paused;
    if (target > 0) pendingPreviewSeek = target;
    if (mode === "direct" && canStream()) {
      loadStream(target);
      return;
    }
    if (mode !== "file") {
      mode = "file";
      streamController?.abort();
      igVideo.pause();
      igVideo.hidden = true;
      igVideo.removeAttribute("src");
      igVideo.load();
      setNotice("Kompatibilis előnézet előkészítése…");
      prepareFile();
    } else fail("Az előnézet nem játszható le. Kattints az Újratöltésre.");
  }

  function waitForMedia(ms) {
    clearTimeout(mediaTimer);
    mediaTimer = setTimeout(switchSource, ms);
  }

  function canStream() {
    return info.streamUrl && window.MediaSource?.isTypeSupported(previewMime(info.streamHasAudio));
  }

  function loadStream(target = 0) {
    streamController?.abort();
    streamController = new AbortController();
    const stream = streamController;
    mode = "stream";
    hasAudio = info.streamHasAudio;
    igVideo.pause();
    igVideo.hidden = false;
    setNotice("Előnézet betöltése…");
    const limit = duration > 0 ? duration - 0.15 : target;
    const start = Math.max(0, Math.min(target, limit));
    waitForMedia(11000);
    attachPreviewStream(igVideo, API + info.streamUrl, start, duration, hasAudio, stream.signal)
      .catch(() => { if (!stream.signal.aborted) switchSource(); });
  }

  seekPreview = (target) => {
    if (mode !== "stream") return false;
    const buffered = igVideo.buffered;
    for (let i = 0; i < buffered.length; i++) {
      if (target >= buffered.start(i) && target < buffered.end(i) - 0.05) {
        clearTimeout(seekTimer);
        return false;
      }
    }
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      previewWantPlay ||= !igVideo.paused;
      pendingPreviewSeek = target;
      loadStream(target);
    }, 130);
    return true;
  };

  igVideo.onloadedmetadata = igVideo.ondurationchange = () => {
    if (!active()) return;
    if (mode !== "stream" || !(duration > 0)) updateTimelineDuration(igVideo.duration);
    if (mode !== "stream" && pendingPreviewSeek !== null && igVideo.readyState >= 1) {
      igVideo.currentTime = Math.max(0, Math.min(pendingPreviewSeek, igVideo.duration - 0.05));
      pendingPreviewSeek = null;
    }
  };
  igVideo.onerror = switchSource;
  igVideo.onloadeddata = () => {
    if (!active()) return;
    clearTimeout(mediaTimer);
    pendingPreviewSeek = null;
    poster.hidden = true;
    setNotice(hasAudio ? "" : "A forrásvideó nem tartalmaz hangsávot.");
    if (mode === "file" && !framesStarted && !info.storyboard) {
      framesStarted = true;
      buildPreviewFilmstrip(igVideo.currentSrc, generation);
    }
    if (previewWantPlay) {
      previewWantPlay = false;
      igVideo.play().catch(() => { if (active()) setNotice("Az előnézet kész. Indítsd a lejátszás gombbal."); });
    }
  };
  igVideo.onwaiting = () => {
    if (!active() || igVideo.paused) return;
    setNotice("Előnézet betöltése…");
    waitForMedia(mode === "direct" ? 8000 : 12000);
  };
  igVideo.onplaying = igVideo.oncanplay = () => {
    if (!active()) return;
    clearTimeout(mediaTimer);
    setNotice(hasAudio ? "" : "A forrásvideó nem tartalmaz hangsávot.");
  };

  async function prepareFile() {
    if (fallbackStarted) return;
    fallbackStarted = true;
    let errors = 0;
    let retry = refresh;
    while (active()) {
      try {
        const params = new URLSearchParams({ url: edUrl.textContent });
        if (retry) params.set("retry", "true");
        const response = await fetch(API + "/api/preview/status?" + params, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), cache: "no-store"
        });
        if (!response.ok) throw new Error("Status unavailable");
        retry = false;
        const data = await response.json();
        if (!active()) return;
        errors = 0;
        if (data.status === "error") { fail(data.message); return; }
        if (data.status === "ready") {
          hasAudio = data.hasAudio !== false;
          updateTimelineDuration(data.duration);
          igVideo.hidden = false;
          igVideo.src = API + info.previewUrl;
          waitForMedia(12000);
          return;
        }
        setNotice(data.message || "Előnézet előkészítése…");
      } catch {
        if (!active()) return;
        if (++errors >= 3) { fail("Megszakadt az előnézet kapcsolata. Kattints az Újratöltésre."); return; }
      }
      await new Promise(resolve => setTimeout(resolve, 850));
    }
  }

  async function start() {
    if (info.isLive) { setNotice("Az adás befejezése után lesz elérhető az előnézet."); return; }
    if (refresh) {
      try {
        const params = new URLSearchParams({ url: edUrl.textContent, refresh: "true" });
        const response = await fetch(API + "/api/info?" + params, { signal });
        const updated = response.ok && await response.json();
        if (updated && active()) Object.assign(info, updated);
      } catch { /* The stored fallback URL can still be used. */ }
    }
    if (!active()) return;
    if (info.directUrl) {
      mode = "direct";
      igVideo.hidden = false;
      igVideo.src = API + info.directUrl;
      waitForMedia(5000);
    } else if (canStream()) loadStream();
    else switchSource();
  }

  start();
  startPlayhead();
}

$("previewRetry").addEventListener("click", () => retryPreview?.());
$("muteBtn").addEventListener("click", () => {
  igVideo.muted = !igVideo.muted;
  if (!igVideo.muted && igVideo.volume === 0) { igVideo.volume = 1; $("previewVolume").value = "100"; }
  $("muteBtn").textContent = igVideo.muted ? "Némítva" : "Hang be";
  $("muteBtn").setAttribute("aria-pressed", String(igVideo.muted));
});
$("previewVolume").addEventListener("input", event => {
  igVideo.volume = Number(event.target.value) / 100;
  igVideo.muted = igVideo.volume === 0;
  $("muteBtn").textContent = igVideo.muted ? "Némítva" : "Hang be";
  $("muteBtn").setAttribute("aria-pressed", String(igVideo.muted));
});

// Sample another, muted video element: generating thumbnails never seeks or mutes the player.
async function buildPreviewFilmstrip(source, generation) {
  const sampler = document.createElement("video");
  frameSampler = sampler;
  sampler.muted = true;
  sampler.preload = "auto";
  const waitFor = event => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); sampler.removeEventListener(event, done); sampler.removeEventListener("error", fail); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("Frame unavailable")); };
    const timer = setTimeout(fail, 12000);
    sampler.addEventListener(event, done, { once: true });
    sampler.addEventListener("error", fail, { once: true });
  });
  try {
    const loaded = waitFor("loadeddata");
    sampler.src = source;
    await loaded;
    if (generation !== previewGeneration || !(sampler.duration > 0)) return;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = Math.max(1, Math.round(160 * sampler.videoHeight / sampler.videoWidth));
    const ctx = canvas.getContext("2d");
    const count = Math.max(6, Math.min(12, Math.ceil(timeline.clientWidth / 100)));
    filmstrip.replaceChildren();
    filmstrip.classList.remove("plain");
    for (let i = 0; i < count; i++) {
      if (generation !== previewGeneration) return;
      const seeked = waitFor("seeked");
      sampler.currentTime = Math.min(sampler.duration - 0.001, ((i + 0.5) / count) * sampler.duration);
      await seeked;
      if (generation !== previewGeneration) return;
      ctx.drawImage(sampler, 0, 0, canvas.width, canvas.height);
      const frame = document.createElement("div");
      frame.className = "frame";
      frame.style.backgroundImage = `url("${canvas.toDataURL("image/jpeg", 0.65)}")`;
      filmstrip.appendChild(frame);
    }
  } catch { /* The time ruler remains usable if a particular frame cannot be decoded. */ }
  finally { if (frameSampler === sampler) releaseFrameSampler(); }
}

backBtn.addEventListener("click", () => {
  stopPreview();
  clearInterval(pollTimer);
  showView("landing");
  urlInput.focus();
});

function setPlayIcon(playing) {
  playPath.setAttribute("d", playing ? PAUSE_D : PLAY_D);
  playBtn.setAttribute("aria-label", playing ? "Szünet" : "Lejátszás");
}

// A playhead/idő a <video> elem állásából frissül (egységes minden forrásnál).
function startPlayhead() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (igVideo.hidden || igVideo.readyState < 2 || pendingPreviewSeek !== null) return;
    if (drag && drag.kind === "seek") return;
    const t = igVideo.currentTime || 0;
    curTimeEl.textContent = fmtTime(t);
    if (duration > 0) playhead.style.left = (t / duration) * 100 + "%";
    if (phBubble) phBubble.textContent = fmtTime(t);
    setPlayIcon(!igVideo.paused && !igVideo.ended);
    // a kijelölt szakasz végén megállunk (lejátszás-előnézet a vágáshoz)
    if (loopSelection && !igVideo.paused && t >= selEnd - 0.1) {
      try { igVideo.pause(); } catch {}
      loopSelection = false;
    }
  }, 100);
}

playBtn.addEventListener("click", () => {
  if (info?.isLive) return;
  if (igVideo.hidden) { previewWantPlay = true; return; }
  if (igVideo.error) { retryPreview?.(); return; }
  if (igVideo.readyState < 2) { previewWantPlay = true; $("previewNotice").textContent = "Előkészítés után indul a lejátszás…"; return; }
  if (igVideo.paused || igVideo.ended) {
    // ha a playhead a kijelölésen kívül van, a kijelölés elejéről indítjuk
    if (duration > 0 && (igVideo.currentTime < selStart - 0.2 || igVideo.currentTime >= selEnd - 0.05)) {
      seekTo(selStart);
    }
    igVideo.play().catch(() => { $("previewNotice").textContent = "Az előnézet nem indult el. Próbáld újra a lejátszást."; setPlayIcon(false); });
    setPlayIcon(true);
  } else {
    try { igVideo.pause(); } catch {}
    setPlayIcon(false);
  }
});

// --- minőség ---------------------------------------------------------------

function updateQuality() {
  qualitySelect.innerHTML = "";
  if (currentFormat === "mp3") {
    qualityLabel.textContent = "Bitráta";
    for (const br of MP3_BITRATES) {
      const o = document.createElement("option");
      o.value = br; o.textContent = `${br} kbps`;
      if (br === 192) o.selected = true;
      qualitySelect.appendChild(o);
    }
  } else {
    qualityLabel.textContent = "Felbontás";
    let r = (info && info.resolutions) || [];
    if (!r.length) r = [1080, 720, 480, 360];
    for (const h of r) {
      const o = document.createElement("option");
      o.value = h;
      const t = h >= 2160 ? " · 4K" : h >= 1440 ? " · 2K" : h >= 1080 ? " · FHD" : "";
      o.textContent = `${h}p${t}`;
      qualitySelect.appendChild(o);
    }
  }
}
formatToggle.addEventListener("click", (e) => {
  const b = e.target.closest(".seg");
  if (!b) return;
  currentFormat = b.dataset.format;
  formatToggle.querySelectorAll(".seg").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  updateQuality();
  refreshEstimate();
});
qualitySelect.addEventListener("change", refreshEstimate);

// --- filmstrip (storyboard kockák) -----------------------------------------

function buildFilmstrip() {
  filmstrip.innerHTML = "";
  filmstrip.classList.remove("loading", "plain");
  const sb = info.storyboard;
  const urls = sb && (sb.urls || (sb.url ? [sb.url] : null));
  if (!sb || !urls || !urls.length || !sb.columns || !sb.rows) {
    // nincs storyboard (IG / egyéb forrás) → nyugodt, üres idősáv-csík (nem pörgő skeleton)
    filmstrip.classList.add("plain");
    return;
  }

  const cols = sb.columns, rows = sb.rows;
  const perSheet = cols * rows;
  const totalTiles = perSheet * urls.length;

  const aspect = (sb.tileWidth && sb.tileHeight) ? sb.tileWidth / sb.tileHeight : 16 / 9;
  const tlW = timeline.clientWidth || 1000;
  const tlH = timeline.clientHeight || 84;
  const frameW = tlH * aspect;
  const count = Math.max(8, Math.min(totalTiles, Math.round(tlW / frameW)));

  const proxiedFor = (u) => `${API}/api/storyboard?url=` + encodeURIComponent(u);

  for (let i = 0; i < count; i++) {
    const frac = (i + 0.5) / count;
    const tile = Math.min(totalTiles - 1, Math.floor(frac * totalTiles));
    const sheet = Math.floor(tile / perSheet);
    const idxInSheet = tile % perSheet;
    const cx = idxInSheet % cols, cy = Math.floor(idxInSheet / cols);

    const cell = document.createElement("div");
    cell.className = "frame";
    cell.style.backgroundImage = `url("${proxiedFor(urls[sheet])}")`;
    cell.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
    cell.style.backgroundPosition =
      `${cols > 1 ? (cx / (cols - 1)) * 100 : 0}% ${rows > 1 ? (cy / (rows - 1)) * 100 : 0}%`;
    filmstrip.appendChild(cell);
  }
}

// --- timeline: vágó-fülek + seek -------------------------------------------

function layoutWindow() {
  for (const [handle, value] of [[handleL, selStart], [handleR, selEnd]]) {
    handle.setAttribute("aria-valuemax", String(duration || 0));
    handle.setAttribute("aria-valuenow", String(Number(value.toFixed(2))));
    handle.setAttribute("aria-valuetext", `${value.toFixed(2)} másodperc`);
    handle.setAttribute("aria-disabled", String(!(duration > 0)));
  }
  if (!(duration > 0)) {
    startTimeEl.textContent = endTimeEl.textContent = selectedLenEl.textContent = totTimeEl.textContent = "—";
    tlWindow.style.left = "0"; tlWindow.style.width = "100%";
    dimLeft.style.width = dimRight.style.width = "0";
    return;
  }
  const w = timeline.clientWidth || 1;
  const left = (selStart / (duration || 1)) * w;
  const right = (selEnd / (duration || 1)) * w;
  tlWindow.style.left = left + "px";
  tlWindow.style.width = Math.max(8, right - left) + "px";
  dimLeft.style.width = left + "px";
  dimRight.style.width = (w - right) + "px";
  startTimeEl.textContent = fmtTime(selStart);
  endTimeEl.textContent = fmtTime(selEnd);
  selectedLenEl.textContent = fmtTime(selEnd - selStart);
  if (bubbleL) bubbleL.textContent = fmtTime(selStart);
  if (bubbleR) bubbleR.textContent = fmtTime(selEnd);
}

let drag = null;
let lastSeekT = -1;

function clientX(ev) { return ev.touches ? ev.touches[0].clientX : ev.clientX; }

function secAt(px) {
  const rect = timeline.getBoundingClientRect();
  const frac = (px - rect.left) / rect.width;
  return Math.max(0, Math.min(duration, frac * duration));
}

function seekTo(t) {
  if (igVideo.readyState < 1) pendingPreviewSeek = t;
  if (duration > 0) playhead.style.left = (t / duration) * 100 + "%";
  curTimeEl.textContent = fmtTime(t);
  if (phBubble) phBubble.textContent = fmtTime(t);
  if (seekPreview?.(t)) return;
  if (!igVideo.hidden && Math.abs(t - lastSeekT) > 0.03) {
    try { igVideo.currentTime = t; } catch {}
    lastSeekT = t;
  }
}

function startDrag(kind, ev) {
  if (!(duration > 0)) return;
  ev.preventDefault();
  if (kind === "l") handleL.focus({ preventScroll: true });
  if (kind === "r") handleR.focus({ preventScroll: true });
  drag = { kind, x0: clientX(ev), s0: selStart, e0: selEnd };
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", moveDrag);
  window.addEventListener("mouseup", endDrag);
  window.addEventListener("touchmove", moveDrag, { passive: false });
  window.addEventListener("touchend", endDrag);
  if (kind === "seek") { scrubbing(true); seekTo(secAt(clientX(ev))); }
}

function moveDrag(ev) {
  if (!drag) return;
  ev.preventDefault();
  if (drag.kind === "seek") { seekTo(secAt(clientX(ev))); return; }

  const w = timeline.clientWidth;
  const dSec = ((clientX(ev) - drag.x0) / w) * duration;
  const minGap = Math.min(0.1, duration);
  if (drag.kind === "l") {
    selStart = Math.min(Math.max(0, drag.s0 + dSec), selEnd - minGap);
  } else {
    selEnd = Math.max(Math.min(duration, drag.e0 + dSec), selStart + minGap);
  }
  layoutWindow();
  scheduleEstimate();
}

function endDrag() {
  const wasHandle = drag && drag.kind !== "seek";
  drag = null;
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", moveDrag);
  window.removeEventListener("mouseup", endDrag);
  window.removeEventListener("touchmove", moveDrag);
  window.removeEventListener("touchend", endDrag);
  scrubbing(false);
  if (wasHandle) refreshEstimate();
}

handleL.addEventListener("mousedown", (e) => { e.stopPropagation(); startDrag("l", e); });
handleR.addEventListener("mousedown", (e) => { e.stopPropagation(); startDrag("r", e); });
handleL.addEventListener("touchstart", (e) => { e.stopPropagation(); startDrag("l", e); }, { passive: false });
handleR.addEventListener("touchstart", (e) => { e.stopPropagation(); startDrag("r", e); }, { passive: false });
for (const [handle, side] of [[handleL, "l"], [handleR, "r"]]) {
  handle.addEventListener("keydown", e => {
    if (!(duration > 0) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const gap = Math.min(0.1, duration);
    let value = (side === "l" ? selStart : selEnd) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
    if (e.key === "Home") value = 0;
    if (e.key === "End") value = duration;
    if (side === "l") selStart = Math.max(0, Math.min(selEnd - gap, value));
    else selEnd = Math.min(duration, Math.max(selStart + gap, value));
    layoutWindow(); scheduleEstimate();
  });
}

function timelineDown(e) {
  if (e.target.closest(".tl-handle")) return;
  startDrag("seek", e);
}
timeline.addEventListener("mousedown", timelineDown);
timeline.addEventListener("touchstart", timelineDown, { passive: false });
playhead.addEventListener("mousedown", (e) => { e.stopPropagation(); startDrag("seek", e); });
playhead.addEventListener("touchstart", (e) => { e.stopPropagation(); startDrag("seek", e); }, { passive: false });

function scrubbing(on) {
  playhead.classList.toggle("scrub", on);
  timeline.classList.toggle("scrubbing", on);
}

window.addEventListener("resize", () => { if (!editor.hidden && duration > 0) layoutWindow(); });

// a videóra kattintva play/szünet (mivel a böngésző-kontroll ki van kapcsolva)
igVideo.addEventListener("click", () => playBtn.click());

// --- becslés ---------------------------------------------------------------

let estTimer = null;
function scheduleEstimate() {
  estimateSizeEl.textContent = "…";
  clearTimeout(estTimer);
  estTimer = setTimeout(refreshEstimate, 250);
}
async function refreshEstimate() {
  if (!info) return;
  const u = urlInput.value.trim();
  const p = new URLSearchParams({
    url: u, format: currentFormat, quality: qualitySelect.value, source: currentTab,
    start: String(selStart), end: String(selEnd),
  });
  estimateSizeEl.textContent = "…";
  try {
    const res = await fetch(`${API}/api/estimate?` + p.toString());
    const data = await res.json();
    estimateSizeEl.textContent = res.ok ? "~ " + fmtSize(data.bytes) : "—";
  } catch { estimateSizeEl.textContent = "—"; }
}

// --- letöltés + folyamatok -------------------------------------------------
// activeJob = az editor progress sávjához kötött aktuális job_id (a többi a menüben fut)
let activeJob = null;
const savedJobs = new Set();   // amikhez már elindult a mentés (ne kétszer)
let saveQueue = Promise.resolve();
const savingJobs = new Set();
function queueSave(jobId) {
  if (savingJobs.has(jobId)) return;
  savingJobs.add(jobId);
  saveQueue = saveQueue.catch(() => {}).then(() => saveFinished(jobId)).finally(() => savingJobs.delete(jobId));
}

async function download() {
  if (!info) return;
  const u = urlInput.value.trim();
  const isFull = !(duration > 0) || (selStart <= 0.01 && selEnd >= duration - 0.01);
  const p = new URLSearchParams({
    url: u, format: currentFormat, quality: qualitySelect.value, source: currentTab,
  });
  if (!isFull) { p.set("start", String(selStart)); p.set("end", String(selEnd)); }

  downloadBtn.disabled = true;
  dlText.textContent = "Előkészítés…";
  progressBox.hidden = false;
  progressFill.style.background = "";
  setProgress(0, "starting");
  progressMeta.textContent = "";

  try {
    const data = await prepareJob(p);
    activeJob = data.job_id;
    startJobPolling();           // a folyamatok motorja (badge + menü + editor sáv)
    // az editor gombja gyorsan visszaáll, hogy újabb letöltés is indítható legyen
    setTimeout(() => { downloadBtn.disabled = false; dlText.textContent = "Letöltés"; }, 1200);
  } catch (e) {
    failDownload(e.message);
  }
}

// Egy letöltési job indítása a backenden (a folyamatok motor figyeli majd).
// A `params` egy URLSearchParams (url, format, quality, opcionálisan start/end).
async function prepareJob(params) {
  const res = await fetch(`${API}/api/prepare?` + params.toString(), { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Hiba.");
  return data;
}

// URLSearchParams összeállítása egy lista-elem paramétereiből (vágással együtt).
function paramsFromListItem(it) {
  const p = new URLSearchParams({ url: it.url, format: it.format, quality: String(it.quality || "") });
  const dur = it.duration || 0;
  const trimmed = (it.start > 0.01) || (it.end > 0 && it.end < dur - 0.01);
  if (trimmed && it.end > it.start) { p.set("start", String(it.start)); p.set("end", String(it.end)); }
  return p;
}

function setProgress(pct, stage) {
  progressFill.style.width = pct + "%";
  progressPct.textContent = Math.round(pct) + "%";
  const labels = { downloading: "Letöltés", processing: "Feldolgozás", done: "Kész ✓",
                   starting: "Előkészítés", canceling: "Megszakítás…", canceled: "Megszakítva" };
  if (stage) progressStage.textContent = labels[stage] || stage;
}

function failDownload(msg) {
  progressStage.textContent = msg;
  progressMeta.textContent = "";
  progressFill.style.background = "#ef4444";
  downloadBtn.disabled = false;
  dlText.textContent = "Újra";
  setTimeout(() => {
    progressBox.hidden = true;
    progressFill.style.background = "";
    dlText.textContent = "Letöltés";
  }, 4000);
}

// a fő cancel gomb (az editor progress alatt) az aktuális jobot szakítja meg
cancelBtn.addEventListener("click", () => { if (activeJob) cancelJob(activeJob); });

async function cancelJob(jobId) {
  try { await fetch(`${API}/api/cancel/${jobId}`, { method: "POST" }); } catch {}
}
async function dismissJob(jobId) {
  try { await fetch(`${API}/api/jobs/${jobId}/dismiss`, { method: "POST" }); } catch {}
  refreshJobsNow();
}

// --- a folyamatok motor: egyetlen poll mindenre ----------------------------
let jobPoll = null;
function startJobPolling() {
  if (jobPoll) return;
  jobPoll = setInterval(refreshJobsNow, 600);
  refreshJobsNow();
}
function stopJobPollingIfIdle(jobs) {
  const anyActive = jobs.some((j) => ["running", "starting", "canceling"].includes(j.status));
  if (!anyActive) { clearInterval(jobPoll); jobPoll = null; }
}

async function refreshJobsNow() {
  let jobs = [];
  try {
    const res = await fetch(`${API}/api/jobs`);
    jobs = (await res.json()).jobs || [];
  } catch { return; }

  // badge: aktív (folyamatban lévő) letöltések száma
  const active = jobs.filter((j) => ["running", "starting", "canceling"].includes(j.status)).length;
  jobsBadge.textContent = String(active);
  jobsBadge.hidden = active === 0;

  // a kész jobokat automatikusan mentésre ajánljuk (egyszer)
  for (const j of jobs) {
    if (j.status === "done" && !savedJobs.has(j.job_id)) {
      savedJobs.add(j.job_id);
      queueSave(j.job_id);
    }
  }

  // az editor progress sávja az aktuális jobot tükrözi
  if (activeJob) {
    const cur = jobs.find((j) => j.job_id === activeJob);
    if (cur) updateEditorProgress(cur);
  }

  renderJobs(jobs);
  if (jobsPanel.hidden === false) { /* nyitva: már renderelve */ }
  stopJobPollingIfIdle(jobs);
}

function updateEditorProgress(j) {
  if (j.status === "error") { failDownload(j.error || "Hiba a letöltésnél."); activeJob = null; return; }
  if (j.status === "canceled") {
    setProgress(j.progress || 0, "canceled");
    setTimeout(() => { progressBox.hidden = true; }, 1500);
    activeJob = null; return;
  }
  if (j.status === "done") { setProgress(100, "done"); return; }
  progressBox.hidden = false;
  setProgress(j.progress, j.stage);
  if (j.stage === "downloading" && j.speed) progressMeta.textContent = fmtSpeed(j.speed);
  else if (j.stage === "processing") progressMeta.textContent = "egyesítés…";
  else progressMeta.textContent = "";
}

// A kész fájl mentése. Natív ablakban a pywebview "Mentés másként" párbeszéde nyílik
// (a felhasználó választja a helyet); böngésző-tartalékban a szokásos letöltés.
async function saveFinished(jobId) {
  const hasNative = window.pywebview && window.pywebview.api && window.pywebview.api.save_file;
  if (hasNative) {
    try {
      const r = await window.pywebview.api.save_file(jobId);
      if (r && r.ok) { if (jobId === activeJob) { dlText.textContent = "Mentve ✓"; } }
      else if (r && r.error) { showStatus(r.error, "error"); }
    } catch (e) { console.warn("mentés hiba:", e); }
  } else {
    const f = document.createElement("iframe");
    f.style.display = "none"; document.body.appendChild(f);
    f.src = `${API}/api/file/${jobId}`;
    setTimeout(() => f.remove(), 60000);
  }
  if (jobId === activeJob) {
    setTimeout(() => { progressBox.hidden = true; dlText.textContent = "Letöltés"; activeJob = null; }, 1800);
  }
  refreshJobsNow();
}

// --- Folyamatok panel megjelenítése ----------------------------------------

// A kártyákat job_id alapján CACHE-eljük, és csak a változó értékeket frissítjük —
// így NEM épül újra a DOM minden poll-ciklusban (nincs vibrálás/rezgés).
const _jobCards = new Map();   // job_id -> { el, fill, meta, x }

function statusText(j) {
  return {
    running: Math.round(j.progress) + "%", starting: "Indul…",
    processing: "Feldolgozás…", canceling: "Megszakítás…",
    done: "Kész ✓", error: "Hiba", canceled: "Megszakítva",
  }[j.status] || j.status;
}

function renderJobs(jobs) {
  jobsEmpty.hidden = jobs.length > 0;
  const seen = new Set();

  jobs.forEach((j, idx) => {
    seen.add(j.job_id);
    let c = _jobCards.get(j.job_id);
    if (!c) {
      // ÚJ kártya — egyszer hozzuk létre (az animáció csak most fut le)
      const el = document.createElement("div");
      el.className = "job-card status-" + j.status;
      const thumb = j.thumbnail ? `${API}/api/thumb?url=` + encodeURIComponent(j.thumbnail) : "";
      const srcLabel = { instagram: "IG", youtube: "YT", tiktok: "TikTok" }[j.source] || "WEB";
      el.innerHTML = `
        <div class="jc-thumb">${thumb ? `<img src="${thumb}" alt="" onerror="this.style.display='none'">` : ""}
          <span class="jc-badge ${j.source}">${srcLabel}</span>
        </div>
        <div class="jc-body">
          <div class="jc-title">${escapeHtml(j.title || j.filename || "videó")}</div>
          <div class="jc-bar"><div class="jc-fill"></div></div>
          <div class="jc-meta"><span class="jc-stat"></span><span class="jc-fmt">${(j.format||"").toUpperCase()}</span></div>
        </div>
        <button class="jc-x">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6 16.9 4.3z"/></svg>
        </button>`;
      const x = el.querySelector(".jc-x");
      c = { el, fill: el.querySelector(".jc-fill"), stat: el.querySelector(".jc-stat"), x, meta: j };
      const save = document.createElement("button");
      save.className = "jc-save";
      save.textContent = "Fájl mentése";
      save.addEventListener("click", e => { e.stopPropagation(); queueSave(j.job_id); });
      el.querySelector(".jc-body").appendChild(save);
      c.save = save;
      el.querySelector(".jc-body").addEventListener("click", () => reopenFromJob(c.meta));
      el.querySelector(".jc-thumb").addEventListener("click", () => reopenFromJob(c.meta));
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        if (x.dataset.active === "true") cancelJob(j.job_id);
        else dismissJob(j.job_id);
      });
      _jobCards.set(j.job_id, c);
    }
    // pozíció (sorrend) — csak ha kell
    if (jobsList.children[idx] !== c.el) {
      jobsList.insertBefore(c.el, jobsList.children[idx] || null);
    }
    // FRISSÍTÉS (csak a változó értékek — nincs újraépítés)
    c.el.className = "job-card status-" + j.status;
    const pct = j.status === "done" ? 100 : j.progress;
    c.fill.style.width = pct + "%";
    const speed = (j.status === "running" && j.speed) ? " · " + fmtSpeed(j.speed) : "";
    c.stat.textContent = statusText(j) + speed;
    const isActive = ["running", "starting", "canceling", "processing"].includes(j.status);
    c.x.dataset.active = String(isActive);
    c.x.title = isActive ? "Megszakítás" : "Eltávolítás";
    c.meta = j;
    c.save.hidden = j.status !== "done";
    c.stat.title = j.error || "";
    if (j.status === "error") c.stat.textContent = j.error || "Sikertelen letöltés";
  });

  // eltűnt jobok kártyáinak eltávolítása
  for (const [id, c] of _jobCards) {
    if (!seen.has(id)) { c.el.remove(); _jobCards.delete(id); }
  }
}

// egy folyamat kártyájára kattintva visszahozzuk a videót és a kijelölt vágást
async function reopenFromJob(j) {
  closeJobs();
  // a megfelelő tabra váltunk
  if (j.source !== currentTab) setTab(j.source);
  // betöltjük az URL-t (ez beállítja az editort), majd ráállítjuk a vágást/minőséget
  if (!await loadFromUrl(j.url)) return;
  if (j.quality) {
    // formátum a fájlnévből: ha mp3, váltsunk
    const isMp3 = (j.format === "mp3");
    currentFormat = isMp3 ? "mp3" : "mp4";
    formatToggle.querySelectorAll(".seg").forEach((s) => s.classList.toggle("active", s.dataset.format === currentFormat));
    updateQuality();
    qualitySelect.value = String(j.quality);
  }
  pendingSelection = { start: j.start, end: j.end };
  if (duration > 0 && (j.start || j.end)) {
    selStart = j.start || 0;
    selEnd = j.end || duration;
    layoutWindow();
  }
  refreshEstimate();
}

// ===========================================================================
// Letöltési lista (kosár) — videók paraméterezve összegyűjtve, tömeges letöltés
// ===========================================================================
//
// Egy lista-elem: { id, url, source, title, thumbnail, format, quality,
//                   start, end, duration, estBytes }
// A lista localStorage-ban marad meg (app-újraindítás után is). Az editor egy
// lista-elemet szerkeszthet (editingListId): ekkor a „Listához adás" helyett
// „Mentés a listára" + „Kivétel a listából" jelenik meg.

let downloadList = [];
const listSelected = new Set();   // a lista-panelben kijelölt elem-id-k
let editingListId = null;         // ha az editor egy meglévő lista-elemet szerkeszt
const LIST_KEY = "downloader_list_v1";

function loadList() {
  try { downloadList = JSON.parse(localStorage.getItem(LIST_KEY) || "[]") || []; }
  catch { downloadList = []; }
  if (!Array.isArray(downloadList)) downloadList = [];
  downloadList = downloadList.filter(x => x && typeof x.id === "string" && typeof x.url === "string");
}
function persistList() {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(downloadList)); } catch {}
  updateListBadge();
}
function updateListBadge() {
  listBadge.textContent = String(downloadList.length);
  listBadge.hidden = downloadList.length === 0;
}

// az editor jelenlegi beállításaiból összerak egy lista-elemet
function currentEditorAsItem() {
  if (!info) return null;
  const dur = duration || 0;
  const trimmed = (selStart > 0.01) || (selEnd > 0 && selEnd < dur - 0.01);
  return {
    id: editingListId || ("li_" + Math.random().toString(36).slice(2, 10)),
    url: urlInput.value.trim(),
    source: info.source || currentTab,
    title: info.title || "videó",
    thumbnail: info.thumbnail || "",
    format: currentFormat,
    quality: qualitySelect.value || "",
    start: trimmed ? selStart : 0,
    end: trimmed ? selEnd : dur,
    duration: dur,
    estBytes: 0,
  };
}

// a becsült méret lekérése a backendtől egy lista-elemhez (a kártya frissül utána)
async function fillEstimate(item) {
  try {
    const p = paramsFromListItem(item);
    const res = await fetch(`${API}/api/estimate?` + p.toString());
    const data = await res.json();
    if (res.ok) {
      item.estBytes = data.bytes || 0;
      persistList();
      const card = _listCards.get(item.id);
      if (card) card.size.textContent = item.estBytes ? "~ " + fmtSize(item.estBytes) : "—";
    }
  } catch {}
}

// „Listához adás" / „Mentés a listára"
function addOrSaveCurrentToList() {
  const item = currentEditorAsItem();
  if (!item) return;
  const idx = downloadList.findIndex((x) => x.id === item.id);
  if (idx >= 0) downloadList[idx] = item;       // szerkesztés → felülírás
  else downloadList.unshift(item);              // új → a lista elejére
  editingListId = item.id;                      // mostantól ezt szerkesztjük
  persistList();
  fillEstimate(item);
  updateEditorListButtons();
  // rövid visszajelzés a gombon
  addListBtn.classList.add("added");
  addListText.textContent = idx >= 0 ? "Mentve ✓" : "Hozzáadva ✓";
  setTimeout(() => { addListBtn.classList.remove("added"); updateEditorListButtons(); }, 1400);
  if (!listPanel.hidden) renderList();
}

function removeFromList(id) {
  downloadList = downloadList.filter((x) => x.id !== id);
  listSelected.delete(id);
  persistList();
  if (editingListId === id) { editingListId = null; updateEditorListButtons(); }
  renderList();
}

// az editor lista-gombjainak állapota (új elem vs. meglévő szerkesztése)
function updateEditorListButtons() {
  const onList = editingListId && downloadList.some((x) => x.id === editingListId);
  addListText.textContent = onList ? "Mentés a listára" : "Listához adás";
  removeListBtn.hidden = !onList;
}

// --- lista-panel renderelése (checkbox-os kártyák) ---
const _listCards = new Map();   // id -> { el, check, size }
let listBusy = false;
function visibleList() {
  const query = $("listFilter").value.trim().toLocaleLowerCase("hu");
  const items = downloadList.filter(x => !query || `${x.title} ${x.url}`.toLocaleLowerCase("hu").includes(query));
  const sort = $("listSort").value;
  if (sort === "title") items.sort((a,b) => (a.title || "").localeCompare(b.title || "", "hu"));
  if (sort === "duration") items.sort((a,b) => (a.duration || 0) - (b.duration || 0));
  return items;
}

function renderList() {
  const visible = visibleList();
  listEmpty.hidden = visible.length > 0;
  listEmpty.textContent = downloadList.length ? "Nincs találat a listában." : "Még üres a listád. Nyiss meg egy videót, és válaszd a Listához adás gombot.";
  listToolbar.hidden = downloadList.length === 0;
  const seen = new Set();

  visible.forEach((it, idx) => {
    seen.add(it.id);
    let c = _listCards.get(it.id);
    if (!c) {
      const el = document.createElement("div");
      el.className = "job-card list-card";
      const thumb = it.thumbnail ? `${API}/api/thumb?url=` + encodeURIComponent(it.thumbnail) : "";
      const srcLabel = { instagram: "IG", youtube: "YT", tiktok: "TikTok" }[it.source] || "WEB";
      el.innerHTML = `
        <label class="lc-check"><input type="checkbox"></label>
        <div class="jc-thumb">${thumb ? `<img src="${thumb}" alt="" onerror="this.style.display='none'">` : ""}
          <span class="jc-badge ${it.source}">${srcLabel}</span>
        </div>
        <div class="jc-body" style="flex:1;min-width:0">
          <div class="jc-title">${escapeHtml(it.title || "videó")}</div>
          <div class="jc-meta">
            <span class="jc-size"></span>
            <span class="jc-cut"></span>
            <span class="jc-fmt">${(it.format || "").toUpperCase()}${it.quality ? " · " + it.quality + (it.format === "mp3" ? "k" : "p") : ""}</span>
          </div>
        </div>
        <button class="jc-x" title="Eltávolítás">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6 16.9 4.3z"/></svg>
        </button>`;
      const check = el.querySelector("input");
      check.setAttribute("aria-label", `${it.title || "Videó"} kijelölése`);
      c = { el, check, size: el.querySelector(".jc-size"), cut: el.querySelector(".jc-cut") };
      // kártyára kattintva → editorban megnyitjuk szerkesztésre (kivéve a checkbox/x gombot)
      el.querySelector(".jc-body").addEventListener("click", () => openListItem(it.id));
      const body = el.querySelector(".jc-body");
      body.tabIndex = 0;
      body.setAttribute("role", "button");
      body.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openListItem(it.id); } });
      el.querySelector(".jc-thumb").addEventListener("click", () => openListItem(it.id));
      check.addEventListener("change", () => {
        if (check.checked) listSelected.add(it.id); else listSelected.delete(it.id);
        el.classList.toggle("selected", check.checked);
        updateListSelectionUI();
      });
      el.querySelector(".jc-x").addEventListener("click", (e) => { e.stopPropagation(); removeFromList(it.id); });
      _listCards.set(it.id, c);
    }
    if (listItemsEl.children[idx] !== c.el) {
      listItemsEl.insertBefore(c.el, listItemsEl.children[idx] || null);
    }
    // frissítjük a változó adatokat
    c.size.textContent = it.estBytes ? "~ " + fmtSize(it.estBytes) : "—";
    c.el.querySelector(".jc-title").textContent = it.title || "Videó";
    c.el.querySelector(".jc-fmt").textContent = `${(it.format || "").toUpperCase()} · ${it.quality || "auto"}${it.quality ? (it.format === "mp3" ? " kbps" : "p") : ""}`;
    const trimmed = (it.start > 0.01) || (it.end > 0 && it.end < (it.duration || 0) - 0.01);
    c.cut.textContent = trimmed ? `✂ ${fmtTime(it.start)}–${fmtTime(it.end)}` : "";
    c.check.checked = listSelected.has(it.id);
    c.el.classList.toggle("selected", listSelected.has(it.id));
  });

  for (const [id, c] of _listCards) {
    if (!seen.has(id)) { c.el.remove(); _listCards.delete(id); }
  }
  updateListSelectionUI();
}

function updateListSelectionUI() {
  // töröljük a listából már eltűnt id-kat a kijelölésből
  for (const id of [...listSelected]) {
    if (!downloadList.some((x) => x.id === id)) listSelected.delete(id);
  }
  const n = listSelected.size;
  listSelCount.textContent = n ? `${n} kijelölve` : "0 kijelölve";
  listDownloadSel.disabled = listBusy || n === 0;
  listRemoveSel.disabled = listBusy || n === 0;
  const visible = visibleList();
  const selectedVisible = visible.filter(x => listSelected.has(x.id)).length;
  listSelectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  listSelectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  const selected = downloadList.filter(x => listSelected.has(x.id));
  const bytes = selected.reduce((sum,x) => sum + (x.estBytes || 0), 0);
  $("listSummary").textContent = `${downloadList.length} videó a listában${n ? ` · ${n} kijelölve${bytes ? " · ~ " + fmtSize(bytes) : ""}` : ""}`;
}

// egy lista-elem megnyitása az editorban (szerkesztésre)
async function openListItem(id) {
  const it = downloadList.find((x) => x.id === id);
  if (!it) return;
  closeList();
  if (it.source && it.source !== currentTab) setTab(it.source);
  editingListId = id;            // FONTOS: loadFromUrl → openEditor előtt, hogy a gombok jól álljanak
  if (!await loadFromUrl(it.url, true)) return;
  // formátum + minőség visszaállítása
  currentFormat = it.format === "mp3" ? "mp3" : "mp4";
  formatToggle.querySelectorAll(".seg").forEach((s) => s.classList.toggle("active", s.dataset.format === currentFormat));
  updateQuality();
  if (it.quality) qualitySelect.value = String(it.quality);
  // Restore after metadata arrives too, when the original site omitted duration.
  pendingSelection = { start: it.start, end: it.end };
  if (duration > 0) {
    selStart = it.start || 0;
    selEnd = (it.end && it.end <= duration) ? it.end : duration;
    layoutWindow();
  }
  refreshEstimate();
  updateEditorListButtons();
}

// --- tömeges (kijelölt) letöltés ---
async function downloadSelected() {
  if (listBusy) return;
  const items = downloadList.filter((x) => listSelected.has(x.id));
  if (!items.length) return;
  listBusy = true;
  updateListSelectionUI();
  $("listNotice").hidden = true;
  const started = new Set(), failures = [];
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) {
        const it = items[next++];
        try { await prepareJob(paramsFromListItem(it)); started.add(it.id); startJobPolling(); }
        catch (e) { failures.push(`${it.title}: ${e.message}`); }
      }
    }));
    downloadList = downloadList.filter(x => !started.has(x.id));
    started.forEach(id => listSelected.delete(id));
    if (started.has(editingListId)) { editingListId = null; updateEditorListButtons(); }
    persistList();
  } finally {
    listBusy = false;
    renderList();
  }
  if (failures.length) {
    $("listNotice").textContent = `${started.size} elindult; ${failures.length} elem a listában maradt. ${failures.join(" · ")}`;
    $("listNotice").hidden = false;
  } else { closeList(); openJobs(); }
}

// --- lista-panel nyit/zár + események ---
function openList() {
  closeJobs();
  clearTimeout(listCloseTimer);
  renderList();
  listPanel.hidden = false;
  listOverlay.hidden = false;
  requestAnimationFrame(() => { listPanel.classList.add("open"); listOverlay.classList.add("show"); });
  $("listFilter").focus();
}
let listCloseTimer;
function closeList() {
  listPanel.classList.remove("open");
  listOverlay.classList.remove("show");
  listCloseTimer = setTimeout(() => { listPanel.hidden = true; listOverlay.hidden = true; }, 260);
}
listBtn.addEventListener("click", () => { listPanel.hidden ? openList() : closeList(); });
listClose.addEventListener("click", closeList);
listOverlay.addEventListener("click", closeList);
listSelectAll.addEventListener("change", () => {
  if (listSelectAll.checked) visibleList().forEach((x) => listSelected.add(x.id));
  else visibleList().forEach(x => listSelected.delete(x.id));
  renderList();
});
listRemoveSel.addEventListener("click", () => {
  const ids = [...listSelected];
  downloadList = downloadList.filter((x) => !ids.includes(x.id));
  if (ids.includes(editingListId)) { editingListId = null; updateEditorListButtons(); }
  listSelected.clear();
  persistList();
  renderList();
});
listDownloadSel.addEventListener("click", downloadSelected);
$("listFilter").addEventListener("input", renderList);
$("listSort").addEventListener("change", renderList);
addListBtn.addEventListener("click", addOrSaveCurrentToList);
removeListBtn.addEventListener("click", () => { if (editingListId) removeFromList(editingListId); });

loadList();
updateListBadge();

// --- Folyamatok panel nyit/zár ---------------------------------------------

function openJobs() {
  closeList();
  clearTimeout(jobsCloseTimer);
  jobsPanel.hidden = false;
  jobsOverlay.hidden = false;
  requestAnimationFrame(() => { jobsPanel.classList.add("open"); jobsOverlay.classList.add("show"); });
  refreshJobsNow();
  jobsClose.focus();
}
let jobsCloseTimer;
function closeJobs() {
  jobsPanel.classList.remove("open");
  jobsOverlay.classList.remove("show");
  jobsCloseTimer = setTimeout(() => { jobsPanel.hidden = true; jobsOverlay.hidden = true; }, 260);
}
jobsBtn.addEventListener("click", () => { jobsPanel.hidden ? openJobs() : closeJobs(); });
jobsClose.addEventListener("click", closeJobs);
jobsOverlay.addEventListener("click", closeJobs);

// induláskor egyszer lekérjük az állapotot (hátha fut már valami)
refreshJobsNow();

// --- események -------------------------------------------------------------

downloadBtn.addEventListener("click", download);

setTab("any");

// Native chrome and keyboard navigation use the same controls as the pointer UI.
function enableNativeChrome() {
  if (!window.pywebview?.api?.window_action) return;
  document.body.classList.add("native");
  $("windowControls").hidden = false;
}
window.addEventListener("pywebviewready", enableNativeChrome);
enableNativeChrome();
async function windowAction(action) {
  const result = await window.pywebview?.api?.window_action(action);
  if (result) document.body.classList.toggle("maximized", result.maximized);
}
document.querySelectorAll("[data-window]").forEach(button => {
  button.addEventListener("click", () => windowAction(button.dataset.window));
});
document.querySelector(".titlebar-drag").addEventListener("dblclick", () => windowAction("maximize"));
const grip = document.createElement("div");
grip.className = "resize-grip";
document.body.appendChild(grip);
grip.addEventListener("pointerdown", e => {
  grip.setPointerCapture(e.pointerId);
  const start = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight };
  const resize = ev => window.pywebview?.api?.resize_window(start.w + ev.screenX - start.x, start.h + ev.screenY - start.y);
  let last = 0;
  grip.onpointermove = ev => { if (performance.now() - last > 40) { resize(ev); last = performance.now(); } };
  grip.onpointerup = ev => { resize(ev); grip.onpointermove = null; grip.onpointerup = null; };
});
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    if ($("settingsDialog").open) return;
    e.preventDefault(); closeList(); closeJobs(); stopPreview(); showView("landing"); urlInput.focus(); urlInput.select();
  }
  if (e.key === "Escape") {
    if (listPanel.classList.contains("open")) { closeList(); listBtn.focus(); }
    else if (jobsPanel.classList.contains("open")) { closeJobs(); jobsBtn.focus(); }
  }
  const panel = listPanel.classList.contains("open") ? listPanel : jobsPanel.classList.contains("open") ? jobsPanel : null;
  if (e.key === "Tab" && panel) {
    const focusable = [...panel.querySelectorAll('button, input, select, [tabindex="0"]')].filter(x => !x.disabled && x.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
