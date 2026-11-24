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
const channelProfile = $("channelProfile");
const sourceNames = {youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram"};
const sourceImages = {youtube: "youtube.jpg", tiktok: "tiktok.png", instagram: "instagram.jpg"};
let channelReturnQuery = null;

function sourceLogo(source) {
  const filename = Object.hasOwn(sourceImages, source) ? sourceImages[source] : "";
  return filename ? '<img src="brands/' + filename + '" alt="">' : "";
}

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
let searchToken = 0;           // minden új keresés/tab-váltás növeli; az elavult válaszokat eldobjuk
let duration = 0;
let selStart = 0;
let selEnd = 0;
let previewGeneration = 0;
let previewController = null;
let retryPreview = null;
let previewWantPlay = false;
let seekPreview = null;
let frameSampler = null;
let pendingSelection = null;
let pendingPreviewSeek = null;
const MP3_BITRATES = [320, 256, 192, 128, 96];

let previewFrame = null;
let clipEndTimer = null;

// --- segédek ---------------------------------------------------------------

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
function fmtTrimTime(seconds) {
  const ticks = Math.round(Math.max(0, seconds) * 100);
  return fmtTime(Math.floor(ticks / 100)) + "," + String(ticks % 100).padStart(2, "0");
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
  if (!editor.hidden || !$("gallery").hidden) {
    stopPreview();
    showView("landing");
  }

  currentTab = tab;
  const platformIcon = $("heroPlatformIcon");
  platformIcon.innerHTML = sourceLogo(tab);
  platformIcon.hidden = !platformIcon.firstElementChild;
  hideChannelProfile();
  channelReturnQuery = null;
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
  feed = null;
  landing.classList.remove("searching");
  setLoading(false);
  hideStatus();
  resultsEl.hidden = true;
  resultsGrid.innerHTML = "";
  ytChannels.hidden = true;
  ytChannels.replaceChildren();
  resultsGrid.classList.remove("shorts-grid");
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
  const channelRef = (currentTab === "youtube" || currentTab === "any") && youtubeChannelRef(raw);
  if (channelRef) { openYtChannel(channelRef); return; }

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

// --- YouTube keresés: a YouTube-oldalhoz hasonló rács (videók + Shorts-polc + csatornák) ---

const ICON_VERIFIED = '<svg class="verified-badge" viewBox="0 0 24 24" width="14" height="14" aria-label="Hitelesített"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.6 14.6-4.2-4.2 1.4-1.4 2.8 2.8 6.4-6.4 1.4 1.4z"/></svg>';
const ICON_SHORTS = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="#ff0033" d="M17.8 9.6 16 8.6a4 4 0 0 0-1.5-7.2 4 4 0 0 0-2.4.6L6.2 5.5a4 4 0 0 0 .1 7l1.8 1a4 4 0 0 0 1.5 7.2c.8.1 1.6-.1 2.4-.6l5.9-3.5a4 4 0 0 0-.1-7z"/><path fill="#fff" d="m10 9 5 3-5 3z"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 7a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 12 7zm0 6.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zm0 6.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z"/></svg>';

function thumbUrl(url) {
  return url ? `${API}/api/thumb?url=` + encodeURIComponent(url.startsWith("//") ? "https:" + url : url) : "";
}

function renderSkeletons(n, keepTitle) {
  resultsEl.hidden = false;
  if (!keepTitle) resultsTitle.textContent = "Keresés…";
  resultsGrid.replaceChildren();
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div");
    c.className = "yt-card skeleton";
    c.innerHTML = `<div class="yt-thumb"></div><div class="yt-meta"><span class="yt-avatar"></span><div class="yt-text"><div class="sk-line a"></div><div class="sk-line b"></div></div></div>`;
    resultsGrid.appendChild(c);
  }
}

let searchController = null;
let feed = null;   // {kind:"search"|"channel", query, ref, tab, next, loading}

function gridColumns() {
  const columns = getComputedStyle(resultsGrid).gridTemplateColumns.split(" ").filter(Boolean).length;
  return Math.max(1, columns || 3);
}

async function runSearch(query, source) {
  hideChannelProfile();
  channelReturnQuery = null;
  const myToken = ++searchToken;
  searchController?.abort();
  searchController = new AbortController();
  const signal = searchController.signal;
  setLoading(true);
  hideStatus();
  renderSkeletons(12);
  ytChannels.hidden = true;
  ytChannels.replaceChildren();
  feed = { kind: "search", query, next: null, loading: true, count: 0 };
  landing.classList.add("searching");
  try {
    const res = await fetch(`${API}/api/yt/search?q=` + encodeURIComponent(query), { signal });
    const data = await res.json();
    if (myToken !== searchToken) return;
    if (!res.ok) throw new Error(data.detail || "A keresés nem sikerült.");
    resultsTitle.textContent = "";
    $("resultsHead").hidden = true;
    resultsGrid.replaceChildren();
    showChannelRows(data.channels || []);
    if (!data.videos?.length && !data.shorts?.length && !data.channels?.length) {
      resultsEl.hidden = true;
      showStatus("Nincs találat erre: " + query, "error");
      return;
    }
    appendFeed(data.videos || [], data.shorts || [], true);
    feed.next = data.next;
    resultsEl.hidden = false;
    // a csatornasor külön (szűrt) kéréssel jön, ha a fő találatok között nem volt
    if (!data.channels?.length) {
      fetch(`${API}/api/yt/search?channels=true&q=` + encodeURIComponent(query), { signal })
        .then(r => r.ok ? r.json() : null)
        .then(more => {
          if (myToken !== searchToken || !more) return;
          const top = (more.channels || []).filter(c => c.title.toLocaleLowerCase("hu").includes(query.toLocaleLowerCase("hu").split(" ")[0]));
          showChannelRows(top.slice(0, 1));
        }).catch(() => {});
    }
  } catch (e) {
    if (myToken !== searchToken || e.name === "AbortError") return;
    console.error("[Downloader] keresés hiba:", e);
    resultsEl.hidden = true;
    showStatus("Hiba a keresésnél: " + e.message, "error");
  } finally {
    if (myToken === searchToken) { setLoading(false); if (feed) feed.loading = false; }
  }
}

// Videók rácsba; a Shorts-polc az első sor után kerül be (mint a YouTube-on).
function appendFeed(videos, shorts, first) {
  const start = resultsGrid.querySelectorAll(".yt-card").length;
  const cols = gridColumns();
  let placedShorts = !shorts.length;
  videos.forEach((video, index) => {
    resultsGrid.appendChild(makeVideoCard(video, start + index));
    if (!placedShorts && (first ? index + 1 === cols : index + 1 === Math.min(videos.length, cols * 2))) {
      resultsGrid.appendChild(makeShortsShelf(shorts));
      placedShorts = true;
    }
  });
  if (!placedShorts) resultsGrid.appendChild(makeShortsShelf(shorts));
  feed && (feed.count = start + videos.length);
}

function metaLine(item) {
  return [item.views, item.published].filter(Boolean).join(" • ");
}

function makeVideoCard(it, i) {
  const card = document.createElement("article");
  card.className = "yt-card";
  card.style.animationDelay = (Math.min(i % 24, 12) * 25) + "ms";
  const badge = it.live ? '<span class="yt-badge live">ÉLŐ</span>'
    : (it.length || it.duration) ? `<span class="yt-badge">${escapeHtml(it.length || fmtTime(it.duration))}</span>` : "";
  const avatar = it.avatar ? `<img src="${thumbUrl(it.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  const initial = escapeHtml((it.uploader || "?").charAt(0).toUpperCase());
  card.innerHTML = `
    <button type="button" class="yt-thumb" aria-label="${escapeHtml(it.title)} megnyitása">
      ${it.thumbnail ? `<img src="${thumbUrl(it.thumbnail)}" alt="" loading="lazy" onerror="this.style.opacity=0">` : ""}
      ${badge}
      <span class="yt-quick" title="Gyors letöltés (MP4)" data-quick="mp4">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 16l-6-6h4V4h4v6h4zM4 18h16v2H4z"/></svg>
      </span>
    </button>
    <div class="yt-meta">
      <button type="button" class="yt-avatar" title="${escapeHtml(it.uploader || "")}" ${it.channelId ? "" : "disabled"}><span>${initial}</span>${avatar}</button>
      <div class="yt-text">
        <h3 class="yt-title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</h3>
        ${it.uploader ? `<button type="button" class="yt-channel" ${it.channelId ? "" : "disabled"}>${escapeHtml(it.uploader)}${it.verified ? ICON_VERIFIED : ""}</button>` : ""}
        <div class="yt-stats">${escapeHtml(metaLine(it))}</div>
      </div>
      <button type="button" class="yt-more" aria-label="További műveletek">${ICON_MORE}</button>
    </div>`;
  card.querySelector(".yt-thumb").addEventListener("click", (event) => {
    if (event.target.closest("[data-quick]")) { event.stopPropagation(); quickDownload(it, "mp4"); return; }
    loadFromUrl(it.url);
  });
  card.querySelector(".yt-title").addEventListener("click", () => loadFromUrl(it.url));
  const openChannel = () => it.channelId && openYtChannel(it.channelId, it.uploader, { thumbnail: it.avatar, verified: it.verified });
  card.querySelector(".yt-avatar").addEventListener("click", openChannel);
  card.querySelector(".yt-channel")?.addEventListener("click", openChannel);
  card.querySelector(".yt-more").addEventListener("click", (event) => openCardMenu(event.currentTarget, it));
  return card;
}

function makeShortsShelf(shorts) {
  const shelf = document.createElement("section");
  shelf.className = "shorts-shelf";
  shelf.innerHTML = `<h2>${ICON_SHORTS}<span>Shorts</span></h2><div class="shorts-row"></div>`;
  const row = shelf.querySelector(".shorts-row");
  shorts.forEach((item, index) => row.appendChild(makeShortCard(item, index)));
  if (shorts.length > 5) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "shorts-toggle";
    toggle.textContent = "Több megjelenítése";
    toggle.addEventListener("click", () => {
      const open = shelf.classList.toggle("expanded");
      toggle.textContent = open ? "Kevesebb megjelenítése" : "Több megjelenítése";
    });
    shelf.appendChild(toggle);
  }
  return shelf;
}

function makeShortCard(it, i) {
  const card = document.createElement("article");
  card.className = "short-card";
  card.style.animationDelay = (Math.min(i, 10) * 30) + "ms";
  card.innerHTML = `
    <button type="button" class="short-thumb" aria-label="${escapeHtml(it.title)} megnyitása">
      <img src="${thumbUrl(it.thumbnail)}" alt="" loading="lazy" onerror="this.style.opacity=0">
      <span class="yt-quick" title="Gyors letöltés (MP4)" data-quick="mp4"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 16l-6-6h4V4h4v6h4zM4 18h16v2H4z"/></svg></span>
    </button>
    <div class="short-meta">
      <div><h3 title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</h3><span>${escapeHtml(it.views || "")}</span></div>
      <button type="button" class="yt-more" aria-label="További műveletek">${ICON_MORE}</button>
    </div>`;
  card.querySelector(".short-thumb").addEventListener("click", (event) => {
    if (event.target.closest("[data-quick]")) { event.stopPropagation(); quickDownload(it, "mp4"); return; }
    loadFromUrl(it.url);
  });
  card.querySelector("h3").addEventListener("click", () => loadFromUrl(it.url));
  card.querySelector(".yt-more").addEventListener("click", (event) => openCardMenu(event.currentTarget, it));
  return card;
}

function showChannelRows(channels) {
  ytChannels.replaceChildren(...channels.slice(0, 2).map(makeChannelRow));
  ytChannels.hidden = !ytChannels.children.length;
}

function makeChannelRow(c) {
  const row = document.createElement("article");
  row.className = "yt-channel-row";
  const pic = c.thumbnail ? `<img src="${thumbUrl(c.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  row.innerHTML = `
    <button type="button" class="ycr-avatar"><span>${escapeHtml((c.title || "?").charAt(0).toUpperCase())}</span>${pic}</button>
    <div class="ycr-info">
      <h3>${escapeHtml(c.title)}${c.verified ? ICON_VERIFIED : ""}</h3>
      <p>${escapeHtml([c.handle, c.subs].filter(Boolean).join(" • "))}</p>
      ${c.description ? `<p class="ycr-desc">${escapeHtml(c.description)}</p>` : ""}
    </div>
    <button type="button" class="yt-sub-btn">Csatorna</button>`;
  const open = () => openYtChannel(c.id, c.title, c);
  row.querySelector(".ycr-avatar").addEventListener("click", open);
  row.querySelector("h3").addEventListener("click", open);
  row.querySelector(".yt-sub-btn").addEventListener("click", open);
  return row;
}

// --- kártya-menü (⋮) és gyorsműveletek ---
function openCardMenu(anchor, it) {
  showContextMenu(anchor, [
    { label: "Megnyitás a szerkesztőben", action: () => loadFromUrl(it.url) },
    { label: "Letöltés MP4 (videó)", action: () => quickDownload(it, "mp4") },
    { label: "Letöltés MP3 (hang)", action: () => quickDownload(it, "mp3") },
    { label: "Listához adás", action: () => addRawToList(it) },
    it.channelId && { label: "Csatorna megnyitása", action: () => openYtChannel(it.channelId, it.uploader, { thumbnail: it.avatar }) },
    { label: "Link másolása", action: () => copyText(it.url, "Link másolva.") },
  ].filter(Boolean));
}

async function quickDownload(it, format) {
  const settings = window.appSettings || {};
  const params = new URLSearchParams({ url: it.url, format, source: "youtube" });
  if (format === "mp4") params.set("quality", settings.default_quality || "1080");
  else params.set("quality", "192");
  try {
    await prepareJob(params);
    startJobPolling();
    toast(`Letöltés elindult: ${it.title}`, [{ label: "Letöltések", action: openJobs }]);
  } catch (error) {
    toast(error.message, [], "error");
  }
}

function addRawToList(it) {
  const settings = window.appSettings || {};
  downloadList.unshift({
    id: "li_" + Math.random().toString(36).slice(2, 10), url: it.url, source: "youtube",
    title: it.title || "videó", thumbnail: it.thumbnail || "", format: settings.default_format || "mp4",
    quality: settings.default_format === "mp3" ? "192" : (settings.default_quality || "1080"),
    start: 0, end: it.duration || 0, duration: it.duration || 0, estBytes: 0,
  });
  persistList();
  fillEstimate(downloadList[0]);
  toast("Hozzáadva a listához.", [{ label: "Lista", action: openList }]);
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message || "Másolva."); }
  catch { toast("Nem sikerült a vágólapra másolni.", [], "error"); }
}

function showContextMenu(anchor, items) {
  const menu = $("contextMenu");
  menu.replaceChildren(...items.map(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = item.label;
    if (item.danger) button.classList.add("danger");
    button.addEventListener("click", () => { hideContextMenu(); item.action(); });
    return button;
  }));
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width));
  const top = rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 4 : rect.bottom + 4;
  menu.style.left = left + "px";
  menu.style.top = Math.max(8, top) + "px";
  menu.querySelector("button")?.focus({ preventScroll: true });
}
function hideContextMenu() { $("contextMenu").hidden = true; }
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#contextMenu, .yt-more, .g-more")) hideContextMenu();
}, true);
window.addEventListener("blur", hideContextMenu);

// --- toast értesítések ---
function toast(message, actions = [], type = "") {
  const box = document.createElement("div");
  box.className = "toast " + type;
  const text = document.createElement("span");
  text.textContent = message;
  box.appendChild(text);
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => { action.action(); box.remove(); });
    box.appendChild(button);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-x";
  close.setAttribute("aria-label", "Bezárás");
  close.textContent = "✕";
  close.addEventListener("click", () => box.remove());
  box.appendChild(close);
  $("toasts").appendChild(box);
  setTimeout(() => box.classList.add("leaving"), actions.length ? 7000 : 3800);
  setTimeout(() => box.remove(), actions.length ? 7400 : 4200);
}

const channelCountFormat = new Intl.NumberFormat("hu-HU", { notation: "compact", maximumFractionDigits: 1 });
function fmtFollowers(count) { return channelCountFormat.format(count); }

function youtubeChannelRef(value) {
  if (/^UC[A-Za-z0-9_-]{22}$/.test(value) || /^@[\p{L}\p{N}_.-]{2,100}$/u.test(value)) return value;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
    const hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];
    if (!hosts.includes(url.hostname.toLowerCase())) return null;
    if (!/^\/(?:@[^/]+|channel\/UC[A-Za-z0-9_-]{22}|(?:c|user)\/[^/]+)(?:\/[^/]+)?\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function hideChannelProfile() {
  channelProfile.hidden = true;
  landing.classList.remove("channel-mode");
  $("resultsHead").hidden = false;
}

function channelPicture(node, url) {
  node.hidden = !url;
  if (!url) { node.removeAttribute("src"); return; }
  node.onerror = () => { node.hidden = true; };
  node.src = thumbUrl(url);
}

let currentChannel = null;
function renderChannelProfile(channel) {
  currentChannel = channel;
  const title = channel.title || "YouTube-csatorna";
  $("channelName").textContent = title;
  $("channelInitial").textContent = title[0].toUpperCase();
  $("channelVerified").hidden = !channel.verified;
  const stats = channel.stats || (typeof channel.followers === "number" ? [fmtFollowers(channel.followers) + " feliratkozó"] : []);
  $("channelMeta").innerHTML = [channel.handle ? `<strong>${escapeHtml(channel.handle)}</strong>` : "", ...stats.map(escapeHtml)]
    .filter(Boolean).join(" • ");
  const description = $("channelDescription");
  const text = (channel.description || "").trim();
  description.hidden = !text;
  description.classList.remove("expanded");
  description.innerHTML = escapeHtml(text) + '<span class="more">…stb.</span>';
  channelPicture($("channelBanner"), channel.banner);
  $("channelBannerWrap").hidden = !channel.banner;
  channelPicture($("channelAvatar"), channel.thumbnail);
}

$("channelDescription").addEventListener("click", (event) => event.currentTarget.classList.toggle("expanded"));
$("channelSubscribe").addEventListener("click", () => {
  if (currentChannel?.id) openExternal(`https://www.youtube.com/channel/${currentChannel.id}?sub_confirmation=1`);
});
$("channelOpenWeb").addEventListener("click", () => {
  if (currentChannel?.id) openExternal(`https://www.youtube.com/channel/${currentChannel.id}`);
});

function openExternal(url) {
  const native = window.pywebview?.api;
  if (native?.open_url) native.open_url(url);
  else window.open(url, "_blank", "noopener");
}

$("channelBack").addEventListener("click", () => {
  const query = channelReturnQuery;
  if (query) {
    urlInput.value = query;
    runSearch(query, "youtube");
  } else setTab("youtube");
});

const CHANNEL_TAB_NAMES = { videos: "Videók", shorts: "Shorts", streams: "Élő" };

function renderChannelTabs(tabs, active) {
  const holder = $("channelTabs");
  holder.replaceChildren(...tabs.map(tab => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "tab";
    button.textContent = CHANNEL_TAB_NAMES[tab] || tab;
    button.setAttribute("aria-selected", String(tab === active));
    button.addEventListener("click", () => {
      if (tab !== active && currentChannel) loadChannelTab(currentChannel.id, tab);
    });
    return button;
  }));
}

async function openYtChannel(channelId, title, placeholder = {}) {
  if (currentTab !== "youtube") setTab("youtube");
  if (!editor.hidden || !$("gallery").hidden) { stopPreview(); showView("landing"); }
  channelReturnQuery = (feed?.kind === "search" ? feed.query : null) || channelReturnQuery;
  hideStatus();
  landing.classList.add("channel-mode");
  channelProfile.hidden = false;
  $("resultsHead").hidden = true;
  ytChannels.hidden = true;
  renderChannelProfile({ ...placeholder, id: channelId, title: title || placeholder.title });
  renderChannelTabs(["videos", "shorts"], "videos");
  landing.scrollTop = 0;
  await loadChannelTab(channelId, "videos", placeholder);
}

async function loadChannelTab(channelId, tab, placeholder = {}) {
  const myToken = ++searchToken;
  searchController?.abort();
  searchController = new AbortController();
  const notice = $("channelStatus");
  notice.hidden = true;
  resultsEl.hidden = false;
  renderSkeletons(8, true);
  resultsGrid.classList.toggle("shorts-grid", tab === "shorts");
  feed = { kind: "channel", ref: channelId, tab, next: null, loading: true };
  try {
    const res = await fetch(`${API}/api/yt/channel?channel_id=${encodeURIComponent(channelId)}&tab=${tab}`,
      { signal: searchController.signal });
    const data = await res.json();
    if (myToken !== searchToken) return;
    if (!res.ok) throw new Error(data.detail || "A csatorna most nem érhető el.");
    const channel = data.channel || {};
    renderChannelProfile({ ...placeholder, ...currentChannel, ...channel,
      thumbnail: channel.thumbnail || placeholder.thumbnail || currentChannel?.thumbnail });
    feed.ref = channel.id || channelId;
    renderChannelTabs(data.tabs || ["videos"], tab);
    resultsGrid.replaceChildren(...renderChannelItems(data.items || [], tab, 0));
    feed.next = data.next;
    if (!data.items?.length) {
      notice.textContent = tab === "shorts" ? "Ezen a csatornán nincs Shorts-videó." : "A csatornán nincs elérhető videó.";
      notice.hidden = false;
    }
  } catch (error) {
    if (myToken !== searchToken || error.name === "AbortError") return;
    resultsGrid.replaceChildren();
    notice.textContent = error.message;
    notice.hidden = false;
  } finally {
    if (myToken === searchToken && feed) feed.loading = false;
  }
}

function renderChannelItems(items, tab, offset) {
  return items.map((item, index) => tab === "shorts" ? makeShortCard(item, offset + index) : makeVideoCard(item, offset + index));
}

// --- végtelen görgetés (keresés és csatorna) ---
async function loadMoreFeed() {
  if (!feed || feed.loading || !feed.next) return;
  const myToken = searchToken;
  const current = feed;
  current.loading = true;
  $("loadMore").hidden = false;
  try {
    const url = current.kind === "search"
      ? `${API}/api/yt/search?page=${encodeURIComponent(current.next)}&q=${encodeURIComponent(current.query)}`
      : `${API}/api/yt/channel?channel_id=${encodeURIComponent(current.ref)}&tab=${current.tab}&page=${encodeURIComponent(current.next)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (myToken !== searchToken || feed !== current) return;
    if (current.kind === "search") appendFeed(data.videos || [], data.shorts || [], false);
    else resultsGrid.append(...renderChannelItems(data.items || [], current.tab, resultsGrid.children.length));
    current.next = data.next;
  } catch { /* a következő görgetés újrapróbálja */ } finally {
    current.loading = false;
    $("loadMore").hidden = true;
  }
}

landing.addEventListener("scroll", () => {
  if (resultsEl.hidden || !feed?.next) return;
  if (landing.scrollTop + landing.clientHeight >= landing.scrollHeight - 900) loadMoreFeed();
}, { passive: true });

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
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
  landing.hidden = which !== "landing";
  editor.hidden = which !== "editor";
  $("gallery").hidden = which !== "gallery";
  $("galleryBtn").classList.toggle("active-view", which === "gallery");
  document.body.dataset.view = which;
  if (which !== "editor") window.playerHooks?.reset?.();
}

function openEditor(url) {
  hideStatus();
  showView("editor");
  edUrl.textContent = url;
  edUrl.title = url;
  $("editorSource").innerHTML = sourceLogo(info.source) + (sourceNames[info.source] || "Web");

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
  if (info.source === "youtube" && info.channelId && info.uploader) {
    const channelButton = document.createElement("button");
    channelButton.type = "button";
    channelButton.className = "uploader-link";
    channelButton.textContent = info.uploader;
    channelButton.addEventListener("click", () => openYtChannel(info.channelId, info.uploader));
    uploaderEl.replaceChildren(channelButton);
  }
  totTimeEl.textContent = fmtTime(duration);
  curTimeEl.textContent = "0:00";
  const stats = [];
  if (typeof info.views === "number") stats.push(new Intl.NumberFormat("hu-HU").format(info.views) + " megtekintés");
  if (/^\d{8}$/.test(info.uploadDate || "")) {
    const d = info.uploadDate;
    stats.push(new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)).toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }));
  }
  $("videoStats").textContent = stats.join(" • ");

  const defaults = window.appSettings || {};
  if (!editingListId) setFormat(defaults.default_format === "mp3" ? "mp3" : "mp4", false);
  audioLang = "";
  setupMediaOptions();
  updateQuality();
  refreshEstimate();
  updateEditorListButtons();
  window.playerHooks?.load(info);

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
  pendingPreviewSeek = null;
  cancelAnimationFrame(previewFrame);
  clearTimeout(clipEndTimer);
  releaseFrameSampler();
  for (const name of ["onloadedmetadata", "ondurationchange", "onloadeddata", "onerror", "onwaiting", "onplaying", "oncanplay"]) {
    igVideo[name] = null;
  }
  igVideo.pause();
  igVideo.hidden = true;
  igVideo.removeAttribute("src");
  igVideo.load();
}

function setupDirectPlayer(refresh = false, startAt = 0, autoplay = false) {
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
  previewWantPlay = autoplay;

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
    const streamUrl = API + info.streamUrl + (audioLang ? "?audio=" + encodeURIComponent(audioLang) : "");
    attachPreviewStream(igVideo, streamUrl, start, duration, hasAudio, stream.signal)
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
    if (previewWantPlay) playSelectedRange();
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
    if (previewWantPlay && igVideo.paused) playSelectedRange();
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
    if (audioLang && canStream()) {
      loadStream(startAt);
    } else if (info.directUrl) {
      mode = "direct";
      igVideo.hidden = false;
      if (startAt > 0) pendingPreviewSeek = startAt;
      igVideo.src = API + info.directUrl;
      waitForMedia(5000);
    } else if (canStream()) loadStream(startAt);
    else switchSource();
  }

  start();
  renderPlayhead(startAt);
}

// Hangsáv váltásakor az előnézet a választott nyelvvel, ugyanonnan folytatódik.
function reloadPreviewAudio() {
  if (!info || editor.hidden) return;
  const at = pendingPreviewSeek ?? igVideo.currentTime ?? 0;
  const playing = !igVideo.paused || previewWantPlay;
  setupDirectPlayer(false, at, playing);
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
  showView("landing");
  urlInput.focus();
});

function setPlayIcon(playing) {
  playPath.setAttribute("d", playing ? PAUSE_D : PLAY_D);
  playBtn.setAttribute("aria-label", playing ? "Szünet" : "Lejátszás");
}

function renderPlayhead(time) {
  if (duration > 0) playhead.style.left = Math.max(0, Math.min(100, time / duration * 100)) + "%";
  curTimeEl.textContent = fmtTrimTime(time);
  if (phBubble) phBubble.textContent = fmtTrimTime(time);
}

function pauseSelectedRange() {
  previewWantPlay = false;
  igVideo.pause();
  setPlayIcon(false);
}

function playSelectedRange() {
  if (!info || info.isLive) return;
  if (igVideo.hidden || igVideo.readyState < 2 || igVideo.seeking || pendingPreviewSeek !== null) {
    previewWantPlay = true;
    return;
  }
  if (duration > 0 && (igVideo.currentTime < selStart - 0.025 || igVideo.currentTime >= selEnd - 0.015)) {
    previewWantPlay = true;
    if (!seekTo(selStart, true) || igVideo.seeking) return;
  }

  previewWantPlay = false;
  const generation = previewGeneration;
  igVideo.play().catch(error => {
    if (generation !== previewGeneration || error.name === "AbortError") return;
    $("previewNotice").textContent = "Az előnézet nem indult el. Próbáld újra a lejátszást.";
    setPlayIcon(false);
  });
}

function checkPlaybackPosition() {
  if (igVideo.hidden || igVideo.readyState < 1 || pendingPreviewSeek !== null) return;
  let time = igVideo.currentTime;
  if (!igVideo.paused && duration > 0 && time >= selEnd - 0.012) {
    pauseSelectedRange();
    time = selEnd;
    igVideo.currentTime = Math.min(selEnd, igVideo.duration);
  }
  if (drag?.kind !== "seek") renderPlayhead(time);
}

function followPlaybackFrame() {
  checkPlaybackPosition();
  if (!igVideo.paused && !igVideo.ended) previewFrame = requestAnimationFrame(followPlaybackFrame);
}

function trackClipEnd() {
  clearTimeout(clipEndTimer);
  if (igVideo.paused || igVideo.ended || !(duration > 0)) return;
  const delay = Math.max(16, 1000 * (selEnd - igVideo.currentTime) / igVideo.playbackRate);
  clipEndTimer = setTimeout(() => {
    checkPlaybackPosition();
    trackClipEnd();
  }, delay);
}

for (const event of ["play", "pause", "ended", "ratechange"]) {
  igVideo.addEventListener(event, () => {
    cancelAnimationFrame(previewFrame);
    followPlaybackFrame();
    trackClipEnd();
    setPlayIcon(!igVideo.paused && !igVideo.ended);
  });
}
igVideo.addEventListener("seeked", () => {
  checkPlaybackPosition();
  trackClipEnd();
  if (previewWantPlay) playSelectedRange();
});
igVideo.addEventListener("timeupdate", () => {
  if (document.hidden || igVideo.paused) checkPlaybackPosition();
});

playBtn.addEventListener("click", () => {
  if (info?.isLive) return;
  if (previewWantPlay || !igVideo.paused) {
    pauseSelectedRange();
    return;
  }
  if (igVideo.error) { retryPreview?.(); return; }
  playSelectedRange();
  if (previewWantPlay && (igVideo.hidden || igVideo.readyState < 2)) {
    $("previewNotice").textContent = "Előkészítés után indul a lejátszás…";
  }
});

// --- formátum, minőség, hangsáv, felirat ----------------------------------------

let audioLang = "";               // kiválasztott hangsáv (üres = eredeti/alapértelmezett)
const langNames = new Intl.DisplayNames(["hu"], { type: "language" });

function languageName(code) {
  const base = String(code || "").replace(/-orig$/, "");
  try {
    const name = langNames.of(base);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : base;
  } catch { return base; }
}

function qualityTag(h) {
  return h >= 4320 ? "8K" : h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 1080 ? "Full HD" : h >= 720 ? "HD" : "";
}

function updateQuality() {
  const previous = qualitySelect.value;
  qualitySelect.innerHTML = "";
  const chips = $("qualityChips");
  chips.replaceChildren();
  let values;
  if (currentFormat === "mp3") {
    qualityLabel.textContent = "Hangminőség";
    values = MP3_BITRATES.map(br => ({ value: String(br), main: `${br}`, sub: "kbps" }));
  } else {
    qualityLabel.textContent = "Felbontás";
    let r = (info && info.resolutions) || [];
    if (!r.length) r = [1080, 720, 480, 360];
    values = r.map(h => ({ value: String(h), main: `${h}p`, sub: qualityTag(h) }));
  }
  const preferred = currentFormat === "mp3" ? "192" : String((window.appSettings || {}).default_quality || "1080");
  let chosen = values.find(v => v.value === previous)?.value;
  if (!chosen && currentFormat !== "mp3") {
    chosen = (values.find(v => Number(v.value) <= Number(preferred)) || values.at(-1))?.value;
  }
  chosen = chosen || values.find(v => v.value === preferred)?.value || values[0]?.value;
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v.value; o.textContent = v.main;
    qualitySelect.appendChild(o);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "q-chip";
    chip.role = "radio";
    chip.dataset.value = v.value;
    chip.innerHTML = `<strong>${escapeHtml(v.main)}</strong>${v.sub ? `<small>${escapeHtml(v.sub)}</small>` : ""}`;
    chip.addEventListener("click", () => setQuality(v.value));
    chips.appendChild(chip);
  }
  setQuality(chosen, false);
}

function setQuality(value, estimate = true) {
  qualitySelect.value = value;
  for (const chip of $("qualityChips").children) {
    const on = chip.dataset.value === value;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-checked", String(on));
  }
  if (estimate) refreshEstimate();
}

function setFormat(format, estimate = true) {
  currentFormat = format === "mp3" ? "mp3" : "mp4";
  formatToggle.querySelectorAll(".seg").forEach((x) => x.classList.toggle("active", x.dataset.format === currentFormat));
  $("subsMode").hidden = currentFormat === "mp3" || !$("subsSelect").value;
  if (estimate) { updateQuality(); refreshEstimate(); }
}

formatToggle.addEventListener("click", (e) => {
  const b = e.target.closest(".seg");
  if (b) setFormat(b.dataset.format);
});
qualitySelect.addEventListener("change", refreshEstimate);

function setupMediaOptions() {
  // Hangsávok (szinkronok) — csak ha több nyelv van
  const tracks = info?.audioTracks || [];
  const audioSelect = $("audioSelect");
  audioSelect.replaceChildren(...tracks.map(track => {
    const option = document.createElement("option");
    option.value = track.original ? "" : track.lang;
    option.textContent = languageName(track.lang) + (track.original ? " (eredeti)" : "");
    return option;
  }));
  $("audioBlock").hidden = tracks.length < 2;
  audioSelect.value = audioLang;

  // Feliratok: kézi feliratok + automatikus (eredeti nyelvű) + gépi fordítás
  const subsSelect = $("subsSelect");
  const options = [new Option("Nincs felirat", "")];
  for (const sub of info?.subtitles || []) options.push(new Option(languageName(sub.lang), "m:" + sub.lang));
  if (info?.captionsOrig) {
    options.push(new Option(languageName(info.captionsOrig) + " (automatikus)", "a:" + info.captionsOrig));
    const group = document.createElement("optgroup");
    group.label = "Gépi fordítás";
    const translated = (info.translate || []).filter(code => code !== info.captionsOrig)
      .map(code => new Option(languageName(code), "a:" + code))
      .sort((a, b) => a.text.localeCompare(b.text, "hu"));
    group.append(...translated);
    if (translated.length) options.push(group);
  }
  subsSelect.replaceChildren(...options);
  $("subsBlock").hidden = options.length < 2;
  $("subsMode").hidden = true;
}

function setAudioLang(lang, fromPlayer = false) {
  if (lang === audioLang) return;
  audioLang = lang || "";
  $("audioSelect").value = audioLang;
  refreshEstimate();
  if (!fromPlayer) window.playerHooks?.audioChanged(audioLang);
}

$("audioSelect").addEventListener("change", (event) => setAudioLang(event.target.value));
$("subsSelect").addEventListener("change", () => {
  $("subsMode").hidden = currentFormat === "mp3" || !$("subsSelect").value;
});
$("subsMode").addEventListener("click", (event) => {
  const button = event.target.closest(".seg");
  if (!button) return;
  for (const b of $("subsMode").children) b.classList.toggle("active", b === button);
});

function subtitleParams(params) {
  const value = $("subsSelect").value;
  if (!value || $("subsBlock").hidden) return;
  params.set("subs", value.slice(2));
  params.set("subs_auto", String(value.startsWith("a:")));
  params.set("subs_mode", currentFormat === "mp3" ? "srt" : ($("subsMode").querySelector(".active")?.dataset.mode || "embed"));
}

// Kézzel beírható vágási időpontok (pl. 1:23, 1:23,5 vagy 83.5)
function parseTimeInput(text) {
  const clean = String(text).trim().replace(",", ".");
  if (!clean) return NaN;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(clean)) return NaN;
  return clean.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

for (const [input, side] of [[$("startInput"), "l"], [$("endInput"), "r"]]) {
  const apply = () => {
    if (!(duration > 0)) return;
    const value = parseTimeInput(input.value);
    if (!Number.isFinite(value)) { layoutWindow(); return; }
    const gap = Math.min(0.1, duration);
    if (side === "l") selStart = Math.max(0, Math.min(selEnd - gap, value));
    else selEnd = Math.min(duration, Math.max(selStart + gap, value));
    layoutWindow();
    refreshEstimate();
    seekTo(side === "l" ? selStart : Math.max(selStart, selEnd - 2), true);
  };
  input.addEventListener("change", apply);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); apply(); input.blur(); } });
}
$("trimReset").addEventListener("click", () => {
  if (!(duration > 0)) return;
  selStart = 0;
  selEnd = duration;
  layoutWindow();
  refreshEstimate();
});

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
    $("startInput").value = $("endInput").value = "";
    tlWindow.style.left = "0"; tlWindow.style.width = "100%";
    dimLeft.style.width = dimRight.style.width = "0";
    return;
  }
  const w = timeline.clientWidth || 1;
  const left = (selStart / (duration || 1)) * w;
  const right = (selEnd / (duration || 1)) * w;
  tlWindow.style.left = left + "px";
  tlWindow.style.width = (right - left) + "px";
  tlWindow.classList.toggle("handles-close", right - left < 16);
  dimLeft.style.width = left + "px";
  dimRight.style.width = (w - right) + "px";
  bubbleL.textContent = startTimeEl.textContent = fmtTrimTime(selStart);
  bubbleR.textContent = endTimeEl.textContent = fmtTrimTime(selEnd);
  selectedLenEl.textContent = fmtTrimTime(selEnd - selStart);
  if (document.activeElement !== $("startInput")) $("startInput").value = fmtTrimTime(selStart);
  if (document.activeElement !== $("endInput")) $("endInput").value = fmtTrimTime(selEnd);
  $("trimReset").hidden = selStart < 0.01 && selEnd > duration - 0.01;

  const startLabel = placeTrimLabel(bubbleL, left, w);
  const endLabel = placeTrimLabel(bubbleR, right, w);
  timeline.classList.toggle("labels-stacked", startLabel.right + 5 > endLabel.left);
}

function placeTrimLabel(label, point, width) {
  const half = label.offsetWidth / 2;
  const center = Math.max(half, Math.min(width - half, point));
  label.style.left = center + "px";
  label.style.setProperty("--pointer-x", Math.max(4, Math.min(2 * half - 4, half + point - center)) + "px");
  return {left: center - half, right: center + half};
}

let drag = null;
let lastSeekT = -1;

function clientX(ev) { return ev.touches ? ev.touches[0].clientX : ev.clientX; }

function secAt(px) {
  const rect = timeline.getBoundingClientRect();
  const frac = (px - rect.left) / rect.width;
  return Math.max(0, Math.min(duration, frac * duration));
}

function seekTo(time, force = false) {
  renderPlayhead(time);
  if (seekPreview?.(time) || igVideo.hidden || igVideo.readyState < 1) {
    pendingPreviewSeek = time;
    return false;
  }
  pendingPreviewSeek = null;
  if (force || Math.abs(time - lastSeekT) > 0.03 || Math.abs(time - igVideo.currentTime) > 0.03) {
    igVideo.currentTime = time;
    lastSeekT = time;
  }
  return true;
}

function seekDuringPreview(time) {
  if (duration > 0 && (!igVideo.paused || previewWantPlay || drag?.wasPlaying)) {
    time = Math.max(selStart, Math.min(selEnd, time));
  }
  seekTo(time);
}

function startDrag(kind, ev) {
  if (!(duration > 0)) return;
  ev.preventDefault();
  if (kind !== "seek") pauseSelectedRange();
  if (kind === "l") handleL.focus({ preventScroll: true });
  if (kind === "r") handleR.focus({ preventScroll: true });
  drag = { kind, x0: clientX(ev), s0: selStart, e0: selEnd, wasPlaying: !igVideo.paused || previewWantPlay };
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", moveDrag);
  window.addEventListener("mouseup", endDrag);
  window.addEventListener("touchmove", moveDrag, { passive: false });
  window.addEventListener("touchend", endDrag);
  if (kind === "seek") { scrubbing(true); seekDuringPreview(secAt(clientX(ev))); }
}

function moveDrag(ev) {
  if (!drag) return;
  ev.preventDefault();
  if (drag.kind === "seek") { seekDuringPreview(secAt(clientX(ev))); return; }

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
    pauseSelectedRange();
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
let estimateSeq = 0;
async function refreshEstimate() {
  if (!info) return;
  const seq = ++estimateSeq;
  const p = new URLSearchParams({
    url: edUrl.textContent, format: currentFormat, quality: qualitySelect.value, source: currentTab,
    start: String(selStart), end: String(selEnd),
  });
  estimateSizeEl.textContent = "…";
  try {
    const res = await fetch(`${API}/api/estimate?` + p.toString());
    const data = await res.json();
    if (seq === estimateSeq) estimateSizeEl.textContent = res.ok ? "~ " + fmtSize(data.bytes) : "—";
  } catch { if (seq === estimateSeq) estimateSizeEl.textContent = "—"; }
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
  const isFull = !(duration > 0) || (selStart <= 0.01 && selEnd >= duration - 0.01);
  const p = new URLSearchParams({
    url: edUrl.textContent, format: currentFormat, quality: qualitySelect.value, source: currentTab,
  });
  if (!isFull) { p.set("start", String(selStart)); p.set("end", String(selEnd)); }
  if (audioLang && !$("audioBlock").hidden) p.set("audio_lang", audioLang);
  subtitleParams(p);

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
  if (it.audioLang) p.set("audio_lang", it.audioLang);
  if (it.subs) { p.set("subs", it.subs); p.set("subs_auto", String(!!it.subsAuto)); p.set("subs_mode", it.subsMode || "embed"); }
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

let jobsSeeded = false;
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

  if (!jobsSeeded) {
    // induláskor a már korábban kész (mentett) jobokról nem küldünk újra értesítést
    jobsSeeded = true;
    jobs.filter(j => j.status === "done" && j.saved).forEach(j => savedJobs.add(j.job_id));
  }
  for (const j of jobs) {
    if (j.status !== "done" || savedJobs.has(j.job_id)) continue;
    savedJobs.add(j.job_id);
    if (j.saved) {
      // automatikusan a letöltési mappába került → értesítés, galéria frissítése
      const label = j.kind === "edit" ? "Szerkesztés kész" : "Letöltve";
      toast(`${label}: ${j.title || j.filename}`, [
        { label: "Lejátszás", action: () => window.galleryHooks?.play(j.libraryId) },
        { label: "Mappában", action: () => revealLibrary(j.libraryId) },
      ], "success");
      if (j.warning) toast(j.warning, [], "error");
      window.galleryHooks?.refresh();
      if (j.job_id === activeJob) {
        dlText.textContent = "Mentve ✓";
        setTimeout(() => { progressBox.hidden = true; dlText.textContent = "Letöltés"; activeJob = null; }, 1800);
      }
    } else {
      queueSave(j.job_id);
    }
  }

  // az editor progress sávja az aktuális jobot tükrözi
  if (activeJob) {
    const cur = jobs.find((j) => j.job_id === activeJob);
    if (cur) updateEditorProgress(cur);
  }

  renderJobs(jobs);
  stopJobPollingIfIdle(jobs);
}

function revealLibrary(id) {
  if (id) fetch(`${API}/api/library/${id}/reveal`, { method: "POST" });
}
function openLibraryFile(id) {
  if (id) fetch(`${API}/api/library/${id}/open`, { method: "POST" });
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
  if (j.stage === "downloading" && j.speed) progressMeta.textContent = fmtSpeed(j.speed) + (j.eta ? ` · ${fmtTime(j.eta)}` : "");
  else if (j.stage === "processing") progressMeta.textContent = "feldolgozás…";
  else progressMeta.textContent = "";
}

// „Mindig rákérdez” módban a kész fájl mentése a natív Mentés másként ablakkal.
async function saveFinished(jobId) {
  const hasNative = window.pywebview && window.pywebview.api && window.pywebview.api.save_file;
  if (hasNative) {
    try {
      const r = await window.pywebview.api.save_file(jobId);
      if (r && r.ok) {
        if (jobId === activeJob) dlText.textContent = "Mentve ✓";
        toast("Mentve: " + r.path.split(/[\\/]/).pop(), [{ label: "Galéria", action: () => window.galleryHooks?.open() }], "success");
        window.galleryHooks?.refresh();
      } else if (r && r.error) toast(r.error, [], "error");
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
  if (j.status === "running" && j.stage === "processing") return "Feldolgozás… " + Math.round(j.progress) + "%";
  return {
    running: Math.round(j.progress) + "%", starting: "Indul…",
    processing: "Feldolgozás…", canceling: "Megszakítás…",
    done: j.saved ? "Kész ✓ · a Galériában" : "Kész ✓", error: "Hiba", canceled: "Megszakítva",
  }[j.status] || j.status;
}

function renderJobs(jobs) {
  jobsEmpty.hidden = jobs.length > 0;
  const seen = new Set();

  jobs.forEach((j, idx) => {
    seen.add(j.job_id);
    let c = _jobCards.get(j.job_id);
    if (!c) {
      const el = document.createElement("div");
      el.className = "job-card status-" + j.status;
      const thumb = j.thumbnail ? `${API}/api/thumb?url=` + encodeURIComponent(j.thumbnail) : "";
      const srcLabel = j.kind === "edit" ? "VÁGÁS" : ({ instagram: "IG", youtube: "YT", tiktok: "TikTok" }[j.source] || "WEB");
      el.innerHTML = `
        <div class="jc-thumb">${thumb ? `<img src="${thumb}" alt="" onerror="this.style.display='none'">` : ""}
          <span class="jc-badge ${j.source}">${j.kind === "edit" ? "" : sourceLogo(j.source)}${srcLabel}</span>
        </div>
        <div class="jc-body">
          <div class="jc-title">${escapeHtml(j.title || j.filename || "videó")}${j.origin === "ai" ? ' <span class="ai-tag">AI</span>' : ""}</div>
          <div class="jc-bar"><div class="jc-fill"></div></div>
          <div class="jc-meta"><span class="jc-stat"></span><span class="jc-fmt">${(j.format || "").toUpperCase()}${j.quality ? " · " + escapeHtml(j.quality) + (j.format === "mp3" ? "k" : "p") : ""}</span></div>
          <div class="jc-actions"></div>
        </div>
        <button class="jc-x">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6 16.9 4.3z"/></svg>
        </button>`;
      const x = el.querySelector(".jc-x");
      c = { el, fill: el.querySelector(".jc-fill"), stat: el.querySelector(".jc-stat"), x, meta: j,
            actions: el.querySelector(".jc-actions"), actionState: "" };
      el.querySelector(".jc-body").addEventListener("click", (e) => { if (!e.target.closest("button")) reopenFromJob(c.meta); });
      el.querySelector(".jc-thumb").addEventListener("click", () => reopenFromJob(c.meta));
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        if (x.dataset.active === "true") cancelJob(j.job_id);
        else dismissJob(j.job_id);
      });
      _jobCards.set(j.job_id, c);
    }
    if (jobsList.children[idx] !== c.el) {
      jobsList.insertBefore(c.el, jobsList.children[idx] || null);
    }
    c.el.className = "job-card status-" + j.status;
    const pct = j.status === "done" ? 100 : j.progress;
    c.fill.style.width = pct + "%";
    const speed = (j.status === "running" && j.speed && j.stage === "downloading") ? " · " + fmtSpeed(j.speed) : "";
    c.stat.textContent = statusText(j) + speed;
    const isActive = ["running", "starting", "canceling", "processing"].includes(j.status);
    c.x.dataset.active = String(isActive);
    c.x.title = isActive ? "Megszakítás" : "Eltávolítás a listából";
    c.meta = j;
    c.stat.title = j.error || "";
    if (j.status === "error") c.stat.textContent = j.error || "Sikertelen letöltés";
    const state = j.status === "done" ? (j.saved ? "saved" : "unsaved") : "";
    if (state !== c.actionState) {
      c.actionState = state;
      const buttons = state === "saved"
        ? [["Lejátszás", () => window.galleryHooks?.play(j.libraryId)], ["Megnyitás", () => openLibraryFile(j.libraryId)],
           ["Mappában", () => revealLibrary(j.libraryId)]]
        : state === "unsaved" ? [["Fájl mentése", () => queueSave(j.job_id)]] : [];
      c.actions.replaceChildren(...buttons.map(([label, action]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "jc-save";
        button.textContent = label;
        button.addEventListener("click", (e) => { e.stopPropagation(); action(); });
        return button;
      }));
    }
  });

  for (const [id, c] of _jobCards) {
    if (!seen.has(id)) { c.el.remove(); _jobCards.delete(id); }
  }
}

// egy folyamat kártyájára kattintva visszahozzuk a videót és a kijelölt vágást
async function reopenFromJob(j) {
  closeJobs();
  if (j.kind === "edit" || !j.url) {
    if (j.libraryId) window.galleryHooks?.play(j.libraryId);
    else window.galleryHooks?.open();
    return;
  }
  // a megfelelő tabra váltunk
  if (j.source !== currentTab) setTab(j.source === "other" ? "any" : j.source);
  // betöltjük az URL-t (ez beállítja az editort), majd ráállítjuk a vágást/minőséget
  if (!await loadFromUrl(j.url)) return;
  if (j.quality) {
    // formátum a fájlnévből: ha mp3, váltsunk
    const isMp3 = (j.format === "mp3");
    setFormat(isMp3 ? "mp3" : "mp4", false);
    updateQuality();
    setQuality(String(j.quality), false);
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
    url: edUrl.textContent,
    source: info.source || currentTab,
    title: info.title || "videó",
    thumbnail: info.thumbnail || "",
    format: currentFormat,
    quality: qualitySelect.value || "",
    start: trimmed ? selStart : 0,
    end: trimmed ? selEnd : dur,
    duration: dur,
    estBytes: 0,
    audioLang: $("audioBlock").hidden ? "" : audioLang,
    subs: $("subsSelect").value ? $("subsSelect").value.slice(2) : "",
    subsAuto: $("subsSelect").value.startsWith("a:"),
    subsMode: $("subsMode").querySelector(".active")?.dataset.mode || "embed",
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
          <span class="jc-badge ${it.source}">${sourceLogo(it.source)}${srcLabel}</span>
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
  setFormat(it.format === "mp3" ? "mp3" : "mp4", false);
  updateQuality();
  if (it.quality) setQuality(String(it.quality), false);
  if (it.audioLang) setAudioLang(it.audioLang);
  if (it.subs) {
    const value = (it.subsAuto ? "a:" : "m:") + it.subs;
    if ([...$("subsSelect").options].some(o => o.value === value)) {
      $("subsSelect").value = value;
      for (const b of $("subsMode").children) b.classList.toggle("active", b.dataset.mode === (it.subsMode || "embed"));
      $("subsMode").hidden = currentFormat === "mp3";
    }
  }
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

// Native chrome: Windows' own move/resize loop (Aero Snap, drag-to-top maximise,
// drag-down restore) through the native API; the pointer UI only starts it.
let nativeFrame = false;
async function enableNativeChrome() {
  const api = window.pywebview?.api;
  if (!api?.window_action) return;
  document.body.classList.add("native");
  $("windowControls").hidden = false;
  try {
    const state = await api.window_state?.();
    nativeFrame = !!state?.native;
    document.body.classList.toggle("native-frame", nativeFrame);
    document.body.classList.toggle("maximized", !!state?.maximized);
  } catch { /* older API */ }
}
window.addEventListener("pywebviewready", enableNativeChrome);
enableNativeChrome();
async function syncWindowState() {
  const state = await window.pywebview?.api?.window_state?.().catch(() => null);
  if (state) document.body.classList.toggle("maximized", !!state.maximized);
}
let windowStateTimer;
window.addEventListener("resize", () => { clearTimeout(windowStateTimer); windowStateTimer = setTimeout(syncWindowState, 120); });
async function windowAction(action) {
  const result = await window.pywebview?.api?.window_action(action);
  if (result) document.body.classList.toggle("maximized", !!result.maximized);
}
document.querySelectorAll("[data-window]").forEach(button => {
  button.addEventListener("click", () => windowAction(button.dataset.window));
});
const titlebarDrag = $("titlebarDrag");
titlebarDrag.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !nativeFrame) return;
  event.preventDefault();
  // A natív mozgatás elnyeli az egérfelengedést, ezért a dupla kattintást itt kezeljük.
  if (event.detail === 2) windowAction("maximize");
  else if (event.detail === 1) window.pywebview.api.begin_drag("caption");
});
titlebarDrag.addEventListener("dblclick", () => { if (!nativeFrame) windowAction("maximize"); });
if (!nativeFrame) titlebarDrag.classList.add("pywebview-drag-region");
window.addEventListener("pywebviewready", () => setTimeout(() => {
  if (nativeFrame) titlebarDrag.classList.remove("pywebview-drag-region");
}, 300));
$("resizeEdges").addEventListener("mousedown", (event) => {
  const edge = event.target.dataset.edge;
  if (!edge || event.button !== 0 || !nativeFrame) return;
  event.preventDefault();
  window.pywebview.api.begin_drag(edge);
});

// --- háttér-figyelés: AI által indított letöltések, jóváhagyások ---
const shownApprovals = new Map();
let lastLibraryRev = null;
async function pulse() {
  try {
    const data = await (await fetch(`${API}/api/pulse`, { cache: "no-store" })).json();
    if (data.active && !jobPoll) startJobPolling();
    if (lastLibraryRev !== null && data.library !== lastLibraryRev) window.galleryHooks?.refresh();
    lastLibraryRev = data.library;
    renderApprovals(data.approvals || []);
  } catch { /* the server restarts during updates */ }
}
setInterval(pulse, 1500);
pulse();

function renderApprovals(list) {
  const holder = $("approvals");
  const ids = new Set(list.map(x => x.id));
  for (const [id, el] of shownApprovals) {
    if (!ids.has(id)) { el.remove(); shownApprovals.delete(id); }
  }
  for (const item of list) {
    if (shownApprovals.has(item.id)) continue;
    const card = document.createElement("div");
    card.className = "approval-card";
    card.innerHTML = `
      <div class="approval-head"><span class="ai-tag">AI</span><strong>Engedélyt kér</strong></div>
      <p></p>
      <div class="approval-actions">
        <button type="button" class="btn-list" data-allow="false">Elutasítás</button>
        <button type="button" class="btn-primary" data-allow="true">Engedélyezés</button>
      </div>`;
    card.querySelector("p").textContent = item.summary;
    card.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-allow]");
      if (!button) return;
      card.classList.add("leaving");
      await fetch(`${API}/api/mcp/approve/${item.id}?allow=${button.dataset.allow}`, { method: "POST" }).catch(() => {});
      setTimeout(() => card.remove(), 200);
    });
    holder.appendChild(card);
    shownApprovals.set(item.id, card);
    if (document.hidden || !document.hasFocus()) window.pywebview?.api?.flash_window?.();
  }
}

// --- vágólap-figyelés: ha videólink van a vágólapon, felajánljuk a megnyitását ---
let lastClipboard = "";
async function checkClipboard() {
  if (landing.hidden) return;
  try {
    const native = window.pywebview?.api;
    const text = (native?.clipboard_text ? await native.clipboard_text() : await navigator.clipboard.readText())?.trim() || "";
    if (!text || text === lastClipboard || text.length > 2000 || !/^https?:\/\/\S+$/i.test(text)) return;
    lastClipboard = text;
    if (text === urlInput.value.trim()) return;
    const chip = $("clipChip");
    let host = "";
    try { host = new URL(text).hostname.replace(/^www\./, ""); } catch { return; }
    chip.textContent = `Link a vágólapon (${host}) — megnyitás`;
    chip.hidden = false;
    chip.onclick = () => { chip.hidden = true; urlInput.value = text; handleInput(); };
  } catch { /* clipboard unavailable */ }
}
window.addEventListener("focus", checkClipboard);
setTimeout(checkClipboard, 1200);

// --- link behúzása az ablakba ---
document.addEventListener("dragover", (event) => {
  if ([...event.dataTransfer.types].some(t => t === "text/uri-list" || t === "text/plain")) {
    event.preventDefault();
    document.body.classList.add("dropping");
  }
});
document.addEventListener("dragleave", (event) => { if (!event.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop", (event) => {
  document.body.classList.remove("dropping");
  const text = (event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain") || "").split("\n")[0].trim();
  if (!/^https?:\/\//i.test(text)) return;
  event.preventDefault();
  if (!editor.hidden || !$("gallery").hidden) { stopPreview(); showView("landing"); }
  urlInput.value = text;
  handleInput();
});

$("copyLinkBtn").addEventListener("click", () => copyText(edUrl.textContent, "Link másolva."));

const inputMode = document.documentElement.dataset;
document.addEventListener("pointerdown", () => { inputMode.interaction = "pointer"; }, true);
document.addEventListener("keydown", e => {
  if (e.key === "Tab") inputMode.interaction = "keyboard";
  const dialogOpen = document.querySelector("dialog[open]");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    if (dialogOpen) return;
    e.preventDefault(); closeList(); closeJobs(); stopPreview(); showView("landing");
    if (!channelProfile.hidden) setTab("youtube");
    urlInput.focus(); urlInput.select();
  }
  if (e.key === "Escape") {
    if (!$("contextMenu").hidden) { hideContextMenu(); return; }
    if (listPanel.classList.contains("open")) { closeList(); listBtn.focus(); }
    else if (jobsPanel.classList.contains("open")) { closeJobs(); jobsBtn.focus(); }
  }
  const panel = listPanel.classList.contains("open") ? listPanel : jobsPanel.classList.contains("open") ? jobsPanel : null;
  const editorShortcut = !editor.hidden && !panel && !dialogOpen && !e.defaultPrevented
    && !e.ctrlKey && !e.altKey && !e.metaKey
    && !e.target.closest("input, textarea, select, [contenteditable], [role='slider']");
  if (editorShortcut && e.code === "Space") {
    const keyboardButton = inputMode.interaction === "keyboard" && e.target.closest("button, a[href]");
    if (!keyboardButton || keyboardButton === playBtn) {
      e.preventDefault();
      if (!e.repeat) playBtn.click();
    }
  } else if (editorShortcut && duration > 0 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();
    const offset = e.key === "ArrowLeft" ? -5 : 5;
    seekDuringPreview(Math.max(0, Math.min(duration, (pendingPreviewSeek ?? igVideo.currentTime) + offset)));
  } else if (editorShortcut && e.key.toLowerCase() === "c") {
    e.preventDefault();
    window.playerHooks?.toggleCaptions();
  }
  if (e.key === "Tab" && panel) {
    const focusable = [...panel.querySelectorAll('button, input, select, [tabindex="0"]')].filter(x => !x.disabled && x.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
