(() => {
  const animatedThemes = {
    blackhole: ["Fekete lyuk", "Akkréciós korong, fénygörbülés"],
    deepsea: ["Mélytenger", "Fénysugarak, buborékok, moszat"],
    rain: ["Eső", "Esőcseppek az ablakon, villámlás"],
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
  const allThemes = { ...animatedThemes, ...themes, custom: ["Saját háttér", ""] };
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
  let settings = window.appSettings = {};

  function tile(key, [name, description], container, animated) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-tile" + (animated ? " animated" : "");
    button.dataset.value = key;
    const swatch = document.createElement("span");
    swatch.className = "theme-swatch";
    swatch.dataset.theme = key;
    swatch.setAttribute("aria-hidden", "true");
    swatch.innerHTML = animated ? "<i></i><b></b><em></em><s></s>" : "<i></i><b></b><em></em>";
    const caption = document.createElement("span");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = name;
    detail.textContent = description;
    caption.append(title, detail);
    button.append(swatch, caption);
    button.addEventListener("click", () => {
      changedTheme = true;
      applyTheme(key, true);
    });
    container.append(button);
  }
  for (const [key, value] of Object.entries(animatedThemes)) tile(key, value, $("animatedThemeGrid"), true);
  for (const [key, value] of Object.entries(themes)) tile(key, value, $("themeGrid"), false);

  function applyTheme(key, saveNative = false) {
    themePreference = Object.hasOwn(allThemes, key) ? key : "dark";
    const effective = themePreference === "custom" && !settings.background ? "dark" : themePreference;
    const resolved = effective === "auto" ? (systemDark.matches ? "dark" : "light") : effective;
    document.documentElement.dataset.theme = resolved;
    const iconTheme = { blackhole: "graphite", deepsea: "ocean", rain: "aurora", custom: "dark" }[resolved] || resolved;
    const icon = "theme-icons/" + iconTheme + ".ico";
    $("appFavicon").href = icon;
    for (const img of document.querySelectorAll("[data-app-icon]")) img.src = icon;
    try { localStorage.setItem(storageKey, themePreference); } catch { /* Native storage works independently. */ }
    for (const button of document.querySelectorAll(".theme-tile")) {
      button.setAttribute("aria-pressed", String(button.dataset.value === themePreference));
    }
    $("useCustomBg").setAttribute("aria-pressed", String(themePreference === "custom"));
    window.backgroundEngine?.apply(resolved, settings);
    if (native) {
      const chosen = themePreference;
      nativeThemeTask = nativeThemeTask.catch(console.error).then(async () => {
        if (saveNative) await native.set_theme(chosen);
        await native.set_theme_icon?.(resolved);
      });
    }
  }

  systemDark.addEventListener("change", () => {
    if (themePreference === "auto") applyTheme("auto");
  });

  // --- beállítás-fülek ---
  function showPane(name) {
    for (const tab of dialog.querySelectorAll("[role=tab]")) tab.setAttribute("aria-selected", String(tab.dataset.pane === name));
    for (const pane of dialog.querySelectorAll(".settings-pane")) pane.hidden = pane.dataset.pane !== name;
    if (name === "ai") loadMcp();
  }
  dialog.querySelector(".settings-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (tab) showPane(tab.dataset.pane);
  });

  function openSettings(pane) {
    closeList();
    closeJobs();
    if (pane) showPane(pane);
    if (!dialog.open) dialog.showModal();
  }
  window.openSettings = openSettings;

  $("settingsBtn").addEventListener("click", () => openSettings());
  $("aiIndicator").addEventListener("click", () => openSettings("ai"));
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });

  // --- alkalmazás-beállítások (letöltés, AI, háttér) ---
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
    for (const b of $("animQuality").children) b.classList.toggle("active", b.dataset.value === settings.animations);
    $("defaultFormat").value = settings.default_format || "mp4";
    $("defaultQuality").value = String(settings.default_quality || "1080");
    $("bgDim").value = settings.background_dim ?? 55;
    const preview = $("customBgPreview");
    $("useCustomBg").hidden = !settings.background;
    if (settings.background) {
      const url = `${API}/api/background?v=${encodeURIComponent(settings.background)}${settings._bust || ""}`;
      preview.innerHTML = settings.background_kind === "video"
        ? `<video src="${url}" muted autoplay loop playsinline></video>` : `<img src="${url}" alt="">`;
    } else preview.innerHTML = "<span>Nincs kiválasztva</span>";
    const ai = $("aiIndicator");
    ai.hidden = settings.mcp_mode === "off";
    ai.classList.toggle("full", settings.mcp_mode === "full");
    $("aiIndicatorText").textContent = settings.mcp_mode === "full" ? "AI · teljes" : "AI · engedéllyel";
  }

  async function loadSettings() {
    try {
      settings = window.appSettings = Object.assign(window.appSettings, await (await fetch(`${API}/api/settings`)).json());
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

  $("saveMode").addEventListener("click", (e) => { const b = e.target.closest("[data-value]"); if (b) update({ save_mode: b.dataset.value }); });
  $("mcpMode").addEventListener("click", (e) => { const b = e.target.closest("[data-value]"); if (b) update({ mcp_mode: b.dataset.value }).then(loadMcp); });
  $("animQuality").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-value]");
    if (!b) return;
    await update({ animations: b.dataset.value });
    applyTheme(themePreference);
  });
  $("defaultFormat").addEventListener("change", (e) => update({ default_format: e.target.value }));
  $("defaultQuality").addEventListener("change", (e) => update({ default_quality: e.target.value }));
  let dimTimer;
  $("bgDim").addEventListener("input", (e) => {
    document.documentElement.style.setProperty("--bg-dim", String(e.target.value / 100));
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => update({ background_dim: Number(e.target.value) }), 300);
  });
  $("chooseFolder").addEventListener("click", async () => {
    if (!native?.pick_folder) { toast("A mappa választása az asztali alkalmazásban érhető el.", [], "error"); return; }
    const folder = await native.pick_folder();
    if (folder) { settings.download_dir = folder; renderSettings(); }
  });
  $("openFolder").addEventListener("click", () => fetch(`${API}/api/library/folder/open`, { method: "POST" }));
  $("pickBackground").addEventListener("click", async () => {
    if (!native?.pick_background) { toast("A háttér választása az asztali alkalmazásban érhető el.", [], "error"); return; }
    const result = await native.pick_background();
    if (result?.error) { toast(result.error, [], "error"); return; }
    if (result?.ok) {
      Object.assign(settings, result.settings, { _bust: "&t=" + Date.now() });
      renderSettings();
      changedTheme = true;
      applyTheme("custom", true);
    }
  });
  $("useCustomBg").addEventListener("click", () => { changedTheme = true; applyTheme("custom", true); });

  // --- MCP / AI ---
  async function loadMcp() {
    try {
      const cfg = await (await fetch(`${API}/api/mcp/config`)).json();
      const quote = (s) => /\s/.test(s) ? `"${s}"` : s;
      $("mcpCodeCmd").textContent = `claude mcp add downloader -- ${[cfg.command, ...cfg.args].map(quote).join(" ")}`;
      $("mcpDesktopJson").textContent = JSON.stringify({ mcpServers: { downloader: { command: cfg.command, args: cfg.args } } }, null, 2);
      $("mcpHttp").textContent = cfg.url
        ? `URL: ${cfg.url}\nAuthorization: Bearer ${cfg.token}\n\nclaude mcp add --transport http downloader ${cfg.url} --header "Authorization: Bearer ${cfg.token}"`
        : "Az alkalmazás indulása után jelenik meg.";
      const log = $("mcpLog");
      const statusNames = { ok: "kész", denied: "elutasítva", error: "hiba" };
      log.replaceChildren(...(cfg.log?.length ? cfg.log.map(entry => {
        const li = document.createElement("li");
        li.className = entry.status;
        li.textContent = `${new Date(entry.time * 1000).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" })} · ${entry.summary} · ${statusNames[entry.status] || entry.status}`;
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
  try { applyTheme(localStorage.getItem(storageKey)); } catch { applyTheme("dark"); }
  loadSettings();

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
