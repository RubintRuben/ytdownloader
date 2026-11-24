(() => {
  const animatedThemes = {
    blackhole: ["Fekete lyuk", "Csillagos üveg, a kurzor fényt görbít"],
    minecraft: ["Minecraft", "Pixeles felület, kattintásra kockatörés"],
    rain: ["Eső", "Párás üveg, amit a kurzor letöröl"],
  };
  const themes = {
    dark: ["Sötét", "Éjkék, ibolya"],
    light: ["Világos", "Krémszín, indigó"],
    auto: ["Automatikus", "A Windows megjelenése"],
    aurora: ["Auróra", "Éjkék, türkiz fény"],
    ocean: ["Óceán", "Mélytenger, kobalt"],
    ember: ["Parázs", "Meleg grafit, réz"],
    orchid: ["Orchidea", "Szilva, levendula"],
    graphite: ["Grafit", "Fekete, ezüst"],
  };
  const ACCENTS = ["", "#ff5d73", "#ff9f43", "#ffd166", "#7bd88f", "#38d9c4", "#4cc9f0", "#7aa2ff", "#b197fc", "#f783ac", "#ffffff"];
  const SURFACES = ["", "#101018", "#0c1622", "#0b1f1a", "#1d1410", "#1c1024", "#141414", "#22252e"];
  const AI_SETUP = {
    claude: { name: "Claude", label: "Claude Code · parancs (Claude Desktop: lent a JSON)", kind: "claude" },
    openai: { name: "OpenAI", label: "Codex CLI · parancs", kind: "codex" },
    gemini: { name: "Gemini", label: "Gemini CLI · parancs", kind: "gemini" },
    kimi: { name: "Kimi", label: "Kimi Code CLI · parancs", kind: "kimi" },
    grok: { name: "Grok", label: "Grok Build · ~/.grok/config.toml", kind: "grok" },
    deepseek: { name: "DeepSeek", label: "DeepSeek Harness · MCP-kliens beállítás (JSON)", kind: "json" },
  };
  window.AI_SETUP = AI_SETUP;
  const dialog = $("settingsDialog");
  const statusEl = $("updateStatus");
  const versionEl = $("currentVersion");
  const sidebarVersion = $("sidebarVersion");
  const checkButton = $("checkUpdate");
  const installButton = $("installUpdate");
  const shortcut = $("updateShortcut");
  const progress = $("updateProgress");
  const access = $("updateAccess");
  const tokenInput = $("updateToken");
  const removeToken = $("removeUpdateToken");
  const storageKey = "downloader.theme";
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  let themePreference = "dark";
  let changedTheme = false;
  let nativeThemeTask = Promise.resolve();
  let updatePoll;
  let checkInterval;
  let native;
  let settings = window.appSettings = { custom_themes: [] };
  const videoStatus = {};

  // --- téma-csempék ---------------------------------------------------------------
  function tile(key, [name, description], container, kind) {
    const button = document.createElement("div");
    button.className = "theme-tile" + (kind === "animated" ? " animated" : "");
    button.dataset.value = key;
    button.tabIndex = 0;
    button.setAttribute("role", "button");
    const swatch = document.createElement("span");
    swatch.className = "theme-swatch";
    swatch.dataset.theme = key;
    swatch.setAttribute("aria-hidden", "true");
    swatch.innerHTML = kind === "animated" ? `<video muted loop playsinline preload="none"></video><img alt="" hidden>` : "<i></i><b></b><em></em>";
    const caption = document.createElement("span");
    caption.className = "tile-caption";
    caption.innerHTML = `<strong></strong><small></small>`;
    caption.querySelector("strong").textContent = name;
    caption.querySelector("small").textContent = description;
    button.append(swatch, caption);
    if (kind === "animated") {
      const tools = document.createElement("span");
      tools.className = "tile-tools";
      tools.innerHTML = `<button type="button" data-act="video" title="Saját videó vagy Wallpaper Engine háttér ehhez a témához">Saját háttér…</button>
        <button type="button" data-act="reset" title="Vissza a beépített háttérre" hidden>Alap</button>`;
      button.append(tools);
      const status = document.createElement("em");
      status.className = "tile-status";
      button.append(status);
    }
    const choose = (event) => {
      if (event.target.closest("[data-act]")) return;
      changedTheme = true;
      applyTheme(key, true);
    };
    button.addEventListener("click", choose);
    button.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(e); } });
    button.addEventListener("click", async (event) => {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (act === "video") {
        showContextMenu(event.target.closest("[data-act]"), [
          { label: "Wallpaper Engine háttér…", action: () => openWallpaperEngine(key) },
          { label: "Videó vagy project.json fájl…", action: async () => {
            if (!native?.pick_theme_video) { toast("Ez az asztali alkalmazásban érhető el.", [], "error"); return; }
            const result = await native.pick_theme_video(key);
            if (result?.error) toast(result.error, [], "error");
            if (result?.ok) { updateVideoTile(key, result.status); pollVideo(key); if (themePreference === key) applyTheme(key); }
          } },
        ]);
      } else if (act === "reset") {
        const status = await postJSON(`${API}/api/theme-video/${key}/reset`).catch(() => null);
        if (status) { updateVideoTile(key, status); pollVideo(key); }
      }
    });
    container.append(button);
    return button;
  }
  for (const [key, value] of Object.entries(animatedThemes)) tile(key, value, $("animatedThemeGrid"), "animated");
  for (const [key, value] of Object.entries(themes)) tile(key, value, $("themeGrid"), "classic");

  function updateVideoTile(scene, status) {
    videoStatus[scene] = status;
    const tileEl = document.querySelector(`.theme-tile[data-value="${scene}"]`);
    if (!tileEl || !status) return;
    const label = tileEl.querySelector(".tile-status");
    label.textContent = status.state === "ready" ? (status.custom ? ({ scene: "Wallpaper Engine scene", web: "Wallpaper Engine web" }[status.kind] || "Saját videó") : "")
      : status.state === "downloading" ? `Letöltés ${status.progress || 0}%`
      : status.state === "processing" ? "Előkészítés…" : status.state === "error" ? "Nem érhető el" : "Első használatkor letöltődik";
    tileEl.querySelector('[data-act="reset"]').hidden = !status.custom;
    const video = tileEl.querySelector("video");
    const still = tileEl.querySelector(".theme-swatch img");
    if (status.state === "ready" && (status.kind === "scene" || status.kind === "web")) {
      still.src = `${API}/api/theme-video/${scene}/files/${status.kind === "scene" ? "layer0.jpg" : "preview.jpg"}?v=${status.version || 0}`;
      still.onerror = () => { if (status.kind === "scene" && !still.src.includes("layer0.png")) still.src = `${API}/api/theme-video/${scene}/files/layer0.png?v=${status.version || 0}`; };
      still.hidden = false;
      video.hidden = true;
      renderCredits();
      return;
    }
    still.hidden = true;
    video.hidden = status.kind === "procedural";
    if (status.state === "ready" && video && !video.dataset.v && status.kind === "video") {
      video.dataset.v = "1";
      video.src = `${API}/api/theme-video/${scene}?v=${status.version || 0}`;
    }
    if (status.state === "ready" && video && video.dataset.v && status.version && !video.src.includes(`v=${status.version}`)) {
      video.src = `${API}/api/theme-video/${scene}?v=${status.version}`;
    }
    renderCredits();
  }
  window.addEventListener("theme-video-status", (e) => updateVideoTile(e.detail.scene, e.detail));
  function pollVideo(scene) {
    setTimeout(async () => {
      const status = await fetch(`${API}/api/theme-video/${scene}/status`).then(r => r.json()).catch(() => null);
      updateVideoTile(scene, status);
      if (status && ["downloading", "processing"].includes(status.state)) pollVideo(scene);
      else if (status?.state === "ready" && themePreference === scene) applyTheme(scene);
    }, 1500);
  }
  async function loadVideoStatuses() {
    for (const scene of Object.keys(animatedThemes)) {
      updateVideoTile(scene, await fetch(`${API}/api/theme-video/${scene}/status`).then(r => r.json()).catch(() => null));
    }
  }
  function renderCredits() {
    const list = $("themeCredits");
    list.replaceChildren(...Object.keys(animatedThemes).map(scene => {
      const s = videoStatus[scene];
      const li = document.createElement("li");
      if (!s) return li;
      li.textContent = s.custom ? `${animatedThemes[scene][0]}: saját háttér (${s.custom})`
        : s.url ? `${animatedThemes[scene][0]}: „${s.title}” – ${s.author} (${s.license}), ${s.url}`
        : `${animatedThemes[scene][0]}: ${s.title}`;
      return li;
    }));
  }
  // előnézet csak a megnyitott beállításokban fut
  dialog.addEventListener("close", () => document.querySelectorAll(".theme-tile video").forEach(v => v.pause()));
  function playPreviews() { document.querySelectorAll(".theme-tile video[src]").forEach(v => v.play().catch(() => {})); }

  // --- saját témák -------------------------------------------------------------------
  function renderCustomThemes() {
    const grid = $("customThemeGrid");
    grid.replaceChildren();
    for (const theme of settings.custom_themes || []) {
      const el = document.createElement("div");
      el.className = "theme-tile custom-tile";
      el.dataset.value = "custom:" + theme.id;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      const kindLabel = { image: "Kép", video: "Videó", web: "Web" }[theme.kind] || "";
      el.innerHTML = `
        <span class="theme-swatch custom">${theme.hasThumb ? `<img src="${API}/api/custom-themes/${theme.id}/thumb" alt="">` : ""}
          <i class="kind">${kindLabel}${theme.source ? " · WE" : ""}</i>
          ${theme.accent ? `<b class="accent-dot" style="background:${theme.accent}"></b>` : ""}
          ${theme.sound && theme.kind !== "image" ? `<b class="sound-dot" title="Hanggal">♪</b>` : ""}</span>
        <span class="tile-caption"><strong></strong><small></small></span>
        <span class="tile-actions">
          <button type="button" data-act="edit" title="Szerkesztés" aria-label="Szerkesztés"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 17.3V20h2.7l8-8-2.7-2.7-8 8zM19.7 7.6a1 1 0 0 0 0-1.4l-1.9-1.9a1 1 0 0 0-1.4 0l-1.5 1.5 3.3 3.3z"/></svg></button>
          <button type="button" data-act="delete" title="Törlés" aria-label="Törlés"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4-6.3-6.3-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>
        </span>`;
      el.querySelector("strong").textContent = theme.name;
      el.querySelector("small").textContent = theme.source || (theme.kind === "video" ? "Saját videó" : theme.kind === "web" ? "Web-háttér" : "Saját kép");
      el.addEventListener("click", (event) => {
        const act = event.target.closest("[data-act]")?.dataset.act;
        if (act === "edit") openEditor(theme);
        else if (act === "delete") deleteTheme(theme);
        else { changedTheme = true; applyTheme("custom:" + theme.id, true); }
      });
      grid.append(el);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "theme-tile add-tile";
    add.innerHTML = `<span class="plus">+</span><span class="tile-caption"><strong>Új háttér</strong><small>Kép, videó, Wallpaper Engine</small></span>`;
    add.addEventListener("click", () => showContextMenu(add, [
      { label: "Kép vagy videó…", action: pickBackground },
      { label: "Wallpaper Engine háttér…", action: openWallpaperEngine },
    ]));
    grid.append(add);
    markActive();
  }

  async function loadCustomThemes() {
    try {
      settings.custom_themes = (await (await fetch(`${API}/api/custom-themes`)).json()).themes || [];
    } catch { settings.custom_themes = []; }
    renderCustomThemes();
  }

  async function pickBackground() {
    if (!native?.pick_background) { toast("Ez az asztali alkalmazásban érhető el.", [], "error"); return; }
    const result = await native.pick_background();
    if (result?.error) { toast(result.error, [], "error"); return; }
    if (result?.ok) await added(result.theme);
  }

  async function added(theme) {
    await loadCustomThemes();
    changedTheme = true;
    applyTheme("custom:" + theme.id, true);
    openEditor(settings.custom_themes.find(t => t.id === theme.id) || theme);
  }

  async function deleteTheme(theme) {
    const ok = await confirmBox("Háttér törlése", `„${theme.name}” törlődik az appból (az eredeti fájlod megmarad).`);
    if (!ok) return;
    await postJSON(`${API}/api/custom-themes/${theme.id}/delete`).catch(() => {});
    if (themePreference === "custom:" + theme.id) applyTheme("dark", true);
    await loadCustomThemes();
  }

  function confirmBox(title, text) {
    const box = $("confirmDialog");
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmYes").textContent = "Törlés";
    box.returnValue = "";
    box.showModal();
    return new Promise(resolve => box.addEventListener("close", () => resolve(box.returnValue === "yes"), { once: true }));
  }

  // --- saját téma szerkesztője ---
  let editing = null, editingBefore = null;
  function swatches(holder, values, current, onPick) {
    holder.replaceChildren(...values.map(value => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (value ? "" : " auto") + (value === current ? " active" : "");
      b.title = value ? value : "Automatikus (a háttérből)";
      if (value) b.style.background = value; else b.textContent = "A";
      b.addEventListener("click", () => { onPick(value); swatches(holder, values, value, onPick); });
      return b;
    }), (() => {
      const input = document.createElement("input");
      input.type = "color";
      input.title = "Egyéni szín";
      input.value = current || "#888888";
      input.className = "swatch custom-color" + (current && !values.includes(current) ? " active" : "");
      input.addEventListener("input", () => onPick(input.value));
      input.addEventListener("change", () => swatches(holder, values, input.value, onPick));
      return input;
    })());
  }
  function preview() {
    if (!editing) return;
    const idx = settings.custom_themes.findIndex(t => t.id === editing.id);
    if (idx >= 0) settings.custom_themes[idx] = { ...settings.custom_themes[idx], ...editing };
    changedTheme = true;
    applyTheme("custom:" + editing.id);
  }
  function openEditor(theme) {
    editing = { ...theme };
    editingBefore = { ...theme };
    $("teName").value = theme.name;
    $("teDim").value = theme.dim ?? 45;
    $("teSound").checked = !!theme.sound;
    $("teVolume").value = theme.volume ?? 60;
    $("teSoundRow").hidden = theme.kind === "image";
    $("teSource").textContent = theme.kind === "web" ? "Wallpaper Engine web-háttér: elkülönítve fut, megkapja az egérmozgást és a saját beállításait." : "";
    $("tePreview").innerHTML = theme.hasThumb ? `<img src="${API}/api/custom-themes/${theme.id}/thumb" alt="">` : "";
    const accentPick = (v) => { editing.accent = v; preview(); };
    const surfacePick = (v) => { editing.surface = v; preview(); };
    swatches($("teAccent"), ACCENTS, theme.accent || "", accentPick);
    swatches($("teSurface"), SURFACES, theme.surface || "", surfacePick);
    preview();
    $("themeEditor").showModal();
  }
  $("teDim").addEventListener("input", (e) => { if (editing) { editing.dim = Number(e.target.value); preview(); } });
  $("teSound").addEventListener("change", (e) => { if (editing) { editing.sound = e.target.checked; preview(); } });
  $("teVolume").addEventListener("input", (e) => { if (editing) { editing.volume = Number(e.target.value); preview(); } });
  $("teName").addEventListener("input", (e) => { if (editing) editing.name = e.target.value; });
  $("teCancel").addEventListener("click", () => {
    if (editingBefore) {
      const idx = settings.custom_themes.findIndex(t => t.id === editingBefore.id);
      if (idx >= 0) settings.custom_themes[idx] = editingBefore;
      applyTheme(themePreference);
    }
    editing = null;
    $("themeEditor").close();
  });
  $("teDelete").addEventListener("click", async () => {
    const theme = editingBefore;
    $("themeEditor").close();
    editing = null;
    if (theme) await deleteTheme(theme);
  });
  $("themeEditorForm").addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "ok" || !editing) return;
    const theme = editing;
    editing = null;
    try {
      await postJSON(`${API}/api/custom-themes/${theme.id}`, {
        name: theme.name, accent: theme.accent, surface: theme.surface, dim: theme.dim, sound: theme.sound, volume: theme.volume,
      });
      await loadCustomThemes();
      changedTheme = true;
      applyTheme("custom:" + theme.id, true);
    } catch (error) { toast(error.message, [], "error"); }
  });

  // --- Wallpaper Engine böngésző ---
  async function openWallpaperEngine(targetScene) {
    const grid = $("weGrid");
    $("weTitle").textContent = targetScene ? `Wallpaper Engine háttér – ${animatedThemes[targetScene][0]} téma` : "Wallpaper Engine hátterek";
    grid.innerHTML = `<p class="pane-hint">Keresés a Steam-könyvtárakban…</p>`;
    $("weDialog").showModal();
    try {
      const items = (await (await fetch(`${API}/api/wallpaper-engine`)).json()).items || [];
      if (!items.length) { grid.innerHTML = `<p class="pane-hint">Nem találtam telepített Wallpaper Engine hátteret. A „Másik mappa” gombbal kiválaszthatod a project.json fájlt.</p>`; return; }
      grid.replaceChildren(...items.map(item => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "we-card" + (item.full ? "" : " limited");
        card.disabled = !item.supported;
        const type = { video: "Videó", web: "Web", scene: "Scene" }[item.type] || item.type;
        card.innerHTML = `<span class="we-thumb">${item.preview ? `<img src="${API}/api/wallpaper-engine/preview?path=${encodeURIComponent(item.preview)}" alt="" loading="lazy">` : ""}
          <i>${escapeHtml(type)}${item.full ? "" : " · csak előnézet"}</i></span><strong></strong>`;
        card.querySelector("strong").textContent = item.title;
        card.addEventListener("click", async () => {
          card.classList.add("busy");
          $("weStatus").textContent = "Importálás…";
          try {
            if (targetScene) {
              const status = await postJSON(`${API}/api/theme-video/${targetScene}/wallpaper`, { path: item.path });
              $("weDialog").close();
              $("weStatus").textContent = "";
              updateVideoTile(targetScene, status);
              pollVideo(targetScene);
              changedTheme = true;
              applyTheme(targetScene, true);
              return;
            }
            const theme = await postJSON(`${API}/api/wallpaper-engine/import`, { path: item.path });
            $("weDialog").close();
            $("weStatus").textContent = "";
            await added(theme);
          } catch (error) {
            $("weStatus").textContent = error.message;
            card.classList.remove("busy");
          }
        });
        return card;
      }));
    } catch {
      grid.innerHTML = `<p class="pane-hint">A keresés nem sikerült.</p>`;
    }
  }
  $("weClose").addEventListener("click", () => $("weDialog").close());
  $("weBrowse").addEventListener("click", async () => { $("weDialog").close(); await pickBackground(); });
  window.openWallpaperEngine = openWallpaperEngine;

  // --- téma alkalmazása ---
  function markActive() {
    for (const button of document.querySelectorAll(".theme-tile[data-value]")) {
      button.setAttribute("aria-pressed", String(button.dataset.value === themePreference));
    }
  }
  function knownTheme(key) {
    if (typeof key !== "string") return false;
    if (key === "deepsea") return false;
    if (key.startsWith("custom:")) return true;   // a lista később töltődik be
    return Object.hasOwn(animatedThemes, key) || Object.hasOwn(themes, key);
  }
  function applyTheme(key, saveNative = false) {
    themePreference = knownTheme(key) ? key : "dark";
    const customExists = !themePreference.startsWith("custom:") ||
      (settings.custom_themes || []).some(t => "custom:" + t.id === themePreference);
    const effective = customExists ? themePreference : "dark";
    const resolved = effective === "auto" ? (systemDark.matches ? "dark" : "light") : effective;
    const cssTheme = resolved.startsWith("custom:") ? "custom" : resolved;
    document.documentElement.dataset.theme = cssTheme;
    const iconTheme = { blackhole: "graphite", minecraft: "aurora", rain: "ocean", custom: "dark" }[cssTheme] || cssTheme;
    const icon = "theme-icons/" + iconTheme + ".ico";
    $("appFavicon").href = icon;
    for (const img of document.querySelectorAll("[data-app-icon]")) img.src = icon;
    try { localStorage.setItem(storageKey, themePreference); } catch { /* Native storage works independently. */ }
    markActive();
    window.backgroundEngine?.apply(resolved, settings);
    if (native) {
      const chosen = themePreference;
      nativeThemeTask = nativeThemeTask.catch(console.error).then(async () => {
        if (saveNative) await native.set_theme(chosen);
        await native.set_theme_icon?.(cssTheme);
      });
    }
  }
  window.applyTheme = applyTheme;

  systemDark.addEventListener("change", () => {
    if (themePreference === "auto") applyTheme("auto");
  });

  // --- beállítás-fülek ---
  function showPane(name) {
    for (const tab of dialog.querySelectorAll("[role=tab][data-pane]")) tab.setAttribute("aria-selected", String(tab.dataset.pane === name));
    for (const pane of dialog.querySelectorAll(".settings-pane")) pane.hidden = pane.dataset.pane !== name;
    if (name === "ai") loadMcp();
    if (name === "look") { playPreviews(); loadVideoStatuses(); }
  }
  dialog.querySelector(".settings-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (tab) showPane(tab.dataset.pane);
  });

  function openSettings(pane) {
    closeList();
    closeJobs();
    if (!dialog.open) dialog.showModal();
    showPane(pane || dialog.querySelector('[role=tab][aria-selected="true"]')?.dataset.pane || "look");
  }
  window.openSettings = openSettings;

  $("settingsBtn").addEventListener("click", () => openSettings());
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });

  // --- alkalmazás-beállítások ---
  function choose(container, value) {
    for (const b of container.children) {
      const on = b.dataset.value === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  function renderSettings() {
    $("downloadDir").textContent = settings.download_dir || "";
    choose($("saveMode"), settings.save_mode);
    choose($("mcpMode"), settings.mcp_mode);
    choose($("animQuality"), settings.animations);
    $("defaultFormat").value = settings.default_format || "mp4";
    $("defaultQuality").value = String(settings.default_quality || "1080");
    $("bgDim").value = settings.background_dim ?? 35;
    $("sceneEffects").checked = settings.scene_effects !== false;
    window.dispatchEvent(new CustomEvent("app-settings", { detail: settings }));
  }

  async function loadSettings() {
    try {
      Object.assign(settings, await (await fetch(`${API}/api/settings`)).json());
      await loadCustomThemes();
      renderSettings();
      applyTheme(themePreference);
    } catch { /* offline preview */ }
  }

  async function update(changes) {
    try {
      Object.assign(settings, await postJSON(`${API}/api/settings`, changes));
      renderSettings();
    } catch (error) { toast(error.message, [], "error"); }
  }
  window.updateAppSettings = update;

  $("saveMode").addEventListener("click", (e) => { const b = e.target.closest("[data-value]"); if (b) update({ save_mode: b.dataset.value }); });
  $("mcpMode").addEventListener("click", (e) => { const b = e.target.closest("[data-value]"); if (b) update({ mcp_mode: b.dataset.value }).then(loadMcp); });
  $("animQuality").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-value]");
    if (!b) return;
    await update({ animations: b.dataset.value });
    applyTheme(themePreference);
  });
  $("sceneEffects").addEventListener("change", async (e) => { await update({ scene_effects: e.target.checked }); applyTheme(themePreference); });
  $("defaultFormat").addEventListener("change", (e) => update({ default_format: e.target.value }));
  $("defaultQuality").addEventListener("change", (e) => update({ default_quality: e.target.value }));
  let dimTimer;
  $("bgDim").addEventListener("input", (e) => {
    if (!themePreference.startsWith("custom:")) document.documentElement.style.setProperty("--bg-dim", String(e.target.value / 100));
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => update({ background_dim: Number(e.target.value) }), 300);
  });
  $("chooseFolder").addEventListener("click", async () => {
    if (!native?.pick_folder) { toast("A mappa választása az asztali alkalmazásban érhető el.", [], "error"); return; }
    const folder = await native.pick_folder();
    if (folder) { settings.download_dir = folder; renderSettings(); }
  });
  $("openFolder").addEventListener("click", () => fetch(`${API}/api/library/folder/open`, { method: "POST" }));

  // --- MCP / AI: csatlakoztatás AI-onként ---
  let mcpConfig = null, pickedAi = "claude";
  function snippet(ai) {
    if (!mcpConfig) return "";
    const quote = (s) => /\s/.test(s) ? `"${s}"` : s;
    const cmd = [mcpConfig.command, ...mcpConfig.args].map(quote).join(" ");
    const json = JSON.stringify({ mcpServers: { downloader: { command: mcpConfig.command, args: mcpConfig.args } } }, null, 2);
    const toml = `[mcp_servers.downloader]\ncommand = ${JSON.stringify(mcpConfig.command)}\nargs = ${JSON.stringify(mcpConfig.args)}`;
    return {
      claude: `claude mcp add downloader -- ${cmd}\n\n# Claude Desktop – claude_desktop_config.json:\n${json}`,
      codex: `codex mcp add downloader -- ${cmd}`,
      gemini: `gemini mcp add downloader ${cmd}`,
      kimi: `kimi mcp add --transport stdio downloader -- ${cmd}`,
      grok: `grok mcp add downloader -- ${cmd}\n\n# vagy ~/.grok/config.toml:\n${toml}`,
      json,
    }[AI_SETUP[ai].kind];
  }
  function renderAiPicker() {
    $("aiPicker").replaceChildren(...Object.entries(AI_SETUP).map(([ai, info]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(ai === pickedAi));
      b.innerHTML = `<img src="ai/${ai}.png" alt=""><span>${info.name}</span>`;
      b.addEventListener("click", () => { pickedAi = ai; renderAiPicker(); });
      return b;
    }));
    $("mcpSnippetLabel").textContent = AI_SETUP[pickedAi].label;
    $("mcpSnippet").textContent = snippet(pickedAi);
  }
  async function loadMcp() {
    try {
      mcpConfig = await (await fetch(`${API}/api/mcp/config`)).json();
      renderAiPicker();
      $("mcpHttp").textContent = mcpConfig.url
        ? `URL: ${mcpConfig.url}\nAuthorization: Bearer ${mcpConfig.token}`
        : "Az alkalmazás indulása után jelenik meg.";
      const log = $("mcpLog");
      const statusNames = { ok: "kész", denied: "elutasítva", error: "hiba" };
      log.replaceChildren(...(mcpConfig.log?.length ? mcpConfig.log.map(entry => {
        const li = document.createElement("li");
        li.className = entry.status;
        const logo = AI_SETUP[entry.ai] ? `<img src="ai/${entry.ai}.png" alt="">` : "";
        li.innerHTML = logo + "<span></span>";
        li.querySelector("span").textContent = `${new Date(entry.time * 1000).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" })} · ${entry.summary} · ${statusNames[entry.status] || entry.status}`;
        return li;
      }) : [Object.assign(document.createElement("li"), { className: "muted", textContent: "Még nem volt AI-művelet." })]));
    } catch { /* offline */ }
  }
  dialog.addEventListener("click", (event) => {
    const button = event.target.closest(".copy-btn");
    if (button) copyText($(button.dataset.copy).textContent, "Másolva a vágólapra.");
  });
  $("mcpResetToken").addEventListener("click", async () => {
    await fetch(`${API}/api/mcp/token/reset`, { method: "POST" });
    loadMcp();
    toast("Új token készült. Frissítsd a HTTP-kapcsolatot az AI-kliensben.");
  });

  // --- frissítések ---
  function renderUpdate(data) {
    if (data.version) versionEl.textContent = sidebarVersion.textContent = "v" + data.version;
    const messages = {
      idle: "Frissítések keresése…",
      checking: "Frissítések keresése…",
      current: "Nincs elérhető újabb kiadás.",
      access_required: "A GitHub-kiadásokhoz hozzáférést kell beállítani.",
      available: "Elérhető a v" + data.available + " verzió.",
      downloading: "Frissítés letöltése · " + data.progress + "%",
      ready: "Az alkalmazás a letöltések befejezése és mentése után újraindul.",
      restarting: "Telepítés és újraindítás…",
      source: "Az automatikus frissítés a Windows EXE-kiadásban érhető el.",
      check_error: "A frissítések ellenőrzése sikertelen. Próbáld újra.",
      install_error: "A frissítés sikertelen. Ellenőrizd a kapcsolatot és az alkalmazás mappájának írási jogát."
    };
    statusEl.textContent = messages[data.state] || "";
    const busy = ["checking", "downloading", "ready", "restarting"].includes(data.state);
    const canInstall = Boolean(data.available) && !busy;
    checkButton.hidden = data.state === "source";
    checkButton.disabled = busy;
    installButton.hidden = !canInstall;
    shortcut.hidden = !canInstall;
    if (canInstall) shortcut.textContent = "Frissítés · v" + data.available;
    progress.hidden = data.state !== "downloading";
    progress.value = data.progress || 0;
    access.hidden = data.state !== "access_required";
    if ("storedToken" in data) removeToken.hidden = !data.storedToken;
  }

  async function check() {
    renderUpdate({ state: "checking" });
    try { renderUpdate(await native.check_update()); }
    catch { renderUpdate({ state: "check_error" }); }
  }

  async function pollUpdate() {
    try {
      let data = await native.update_status();
      if (data.state === "ready") data = await native.finish_update();
      renderUpdate(data);
      if (["downloading", "ready"].includes(data.state)) updatePoll = setTimeout(pollUpdate, 850);
    } catch {
      renderUpdate({ state: "install_error" });
    }
  }

  async function install() {
    openSettings("about");
    clearTimeout(updatePoll);
    try {
      renderUpdate(await native.start_update());
      pollUpdate();
    } catch {
      renderUpdate({ state: "install_error" });
    }
  }

  async function saveToken(value) {
    const message = $("updateAccessStatus");
    try {
      if (!await native.save_update_token(value)) {
        message.textContent = "A mentés sikertelen. Ellenőrizd a tokent, vagy várd meg a frissítés végét.";
        return;
      }
      tokenInput.value = "";
      message.textContent = value ? "A token mentve." : "A token törölve.";
      check();
    } catch {
      message.textContent = "A GitHub-hozzáférést nem sikerült menteni.";
    }
  }

  $("updateAccessForm").addEventListener("submit", event => {
    event.preventDefault();
    if (tokenInput.value.trim()) saveToken(tokenInput.value);
  });
  removeToken.addEventListener("click", () => saveToken(""));
  checkButton.addEventListener("click", check);
  installButton.addEventListener("click", install);
  shortcut.addEventListener("click", install);
  try {
    const stored = localStorage.getItem(storageKey);
    applyTheme(stored === "deepsea" ? "minecraft" : stored);
  } catch { applyTheme("dark"); }
  loadSettings();
  loadVideoStatuses();

  async function connectNativeSettings() {
    if (native || !window.pywebview?.api?.update_status) return;
    native = window.pywebview.api;
    try {
      const selected = await native.theme();
      if (selected && !changedTheme) applyTheme(selected);
      else applyTheme(themePreference, changedTheme);
      const data = await native.update_status();
      renderUpdate(data);
      if (data.state !== "source") {
        check();
        checkInterval = setInterval(check, 45 * 60 * 1000);
      }
    } catch {
      renderUpdate({ state: "check_error" });
    }
  }

  window.addEventListener("pywebviewready", connectNativeSettings);
  connectNativeSettings();
  window.addEventListener("pagehide", () => {
    clearTimeout(updatePoll);
    clearInterval(checkInterval);
  });
  fetch(API + "/api/version").then(response => response.json()).then(data => {
    if (!native) renderUpdate({ ...data, state: "source" });
  }).catch(() => {});
})();
