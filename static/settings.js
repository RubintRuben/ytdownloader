(() => {
  const themes = {
    dark: ["Sötét", "Palaszürke, mentazöld"],
    light: ["Világos", "Törtfehér, mélyzöld"],
    aurora: ["Auróra", "Éjkék, türkiz fény"],
    ocean: ["Óceán", "Mélytenger, kobalt"],
    ember: ["Parázs", "Meleg grafit, réz"],
    orchid: ["Orchidea", "Szilva, levendula"],
    graphite: ["Grafit", "Fekete, ezüst"]
  };
  const dialog = $("settingsDialog");
  const grid = $("themeGrid");
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
  let changedTheme = false;
  let updatePoll;
  let checkInterval;
  let native;

  for (const [key, [name, description]] of Object.entries(themes)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-tile";
    button.dataset.value = key;
    const swatch = document.createElement("span");
    swatch.className = "theme-swatch";
    swatch.dataset.theme = key;
    swatch.setAttribute("aria-hidden", "true");
    swatch.innerHTML = "<i></i><b></b><em></em>";
    const caption = document.createElement("span");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = name;
    detail.textContent = description;
    caption.append(title, detail);
    button.append(swatch, caption);
    button.addEventListener("click", () => {
      changedTheme = true;
      applyTheme(key);
      native?.set_theme(key).catch(console.error);
    });
    grid.append(button);
  }

  function applyTheme(key) {
    if (!Object.hasOwn(themes, key)) key = "dark";
    document.documentElement.dataset.theme = key;
    try { localStorage.setItem(storageKey, key); } catch { /* Native settings can persist independently. */ }
    for (const button of grid.children) {
      button.setAttribute("aria-pressed", String(button.dataset.value === key));
    }
  }

  function openSettings() {
    closeList();
    closeJobs();
    if (!dialog.open) dialog.showModal();
  }

  $("settingsBtn").addEventListener("click", openSettings);
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });

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
    access.hidden = data.state === "source";
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
    openSettings();
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

  async function connectNativeSettings() {
    if (native || !window.pywebview?.api?.update_status) return;
    native = window.pywebview.api;
    try {
      const selected = await native.theme();
      if (selected && !changedTheme) applyTheme(selected);
      else if (changedTheme) await native.set_theme(document.documentElement.dataset.theme);
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
