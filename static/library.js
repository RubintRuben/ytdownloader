// library.js — letöltési galéria: rács, kijelölés, lejátszó, szerkesztés, törlés.
(() => {
  const view = $("gallery");
  const grid = $("galleryGrid");
  const empty = $("galleryEmpty");
  const bar = $("selectionBar");
  const viewer = $("viewer");
  const viewerVideo = $("viewerVideo");
  const viewerArt = $("viewerArt");
  let items = [];
  let shown = [];
  let kind = "all";
  const selected = new Set();
  let anchorId = null;          // shift-kattintásos tartomány kezdőpontja
  let viewerIndex = -1;
  let loaded = false;
  let refreshTimer;
  const cards = new Map();

  const dateFmt = new Intl.DateTimeFormat("hu-HU", { year: "numeric", month: "short", day: "numeric" });

  async function load() {
    try {
      const data = await (await fetch(`${API}/api/library`, { cache: "no-store" })).json();
      items = data.items || [];
      loaded = true;
      $("galleryBadge").textContent = String(items.length);
      $("galleryBadge").hidden = !items.length;
      for (const id of [...selected]) if (!items.some(x => x.id === id)) selected.delete(id);
      if (!view.hidden) render();
    } catch { /* újrapróbáljuk a következő frissítéskor */ }
  }

  function filtered() {
    const query = $("galleryFilter").value.trim().toLocaleLowerCase("hu");
    let list = items.filter(x => (kind === "all" || (kind === "audio") === (x.format === "mp3"))
      && (!query || `${x.title} ${x.file}`.toLocaleLowerCase("hu").includes(query)));
    const sort = $("gallerySort").value;
    const by = {
      new: (a, b) => b.created - a.created, old: (a, b) => a.created - b.created,
      name: (a, b) => a.title.localeCompare(b.title, "hu"), size: (a, b) => (b.size || 0) - (a.size || 0),
      length: (a, b) => (b.duration || 0) - (a.duration || 0),
    }[sort];
    return list.sort(by);
  }

  function render() {
    shown = filtered();
    const total = items.reduce((sum, x) => sum + (x.size || 0), 0);
    $("galleryMeta").textContent = items.length ? `${items.length} fájl · ${fmtSize(total)}` : "";
    empty.hidden = shown.length > 0;
    if (!items.length) empty.querySelector("p").textContent = "Még nincs letöltött fájl. Amit letöltesz, itt jelenik meg.";
    else if (!shown.length) empty.querySelector("p").textContent = "Nincs a szűrésnek megfelelő fájl.";
    const keep = new Set();
    shown.forEach((item, index) => {
      keep.add(item.id);
      let card = cards.get(item.id);
      if (!card || card.dataset.rev !== String(item.size) + item.title) {
        card?.remove();
        card = makeCard(item);
        cards.set(item.id, card);
      }
      card.classList.toggle("selected", selected.has(item.id));
      if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] || null);
    });
    for (const [id, card] of cards) if (!keep.has(id)) { card.remove(); cards.delete(id); }
    updateBar();
  }

  function makeCard(item) {
    const card = document.createElement("article");
    card.className = "g-card" + (item.format === "mp3" ? " audio" : "");
    card.dataset.id = item.id;
    card.dataset.rev = String(item.size) + item.title;
    card.tabIndex = 0;
    const thumb = item.hasThumb ? `${API}/api/library/${item.id}/thumb` : (item.thumbnail ? thumbUrl(item.thumbnail) : "");
    const cut = item.end > item.start && item.start + item.end > 0 ? `<span class="g-tag">✂ ${fmtTime(item.start)}–${fmtTime(item.end)}</span>` : "";
    card.innerHTML = `
      <div class="g-thumb">
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <span class="g-fallback">${item.format === "mp3" ? "♪" : "▶"}</span>
        <button type="button" class="g-select" aria-label="Kijelölés" title="Kijelölés"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>
        <span class="g-format">${escapeHtml(item.format.toUpperCase())}${item.height && item.format !== "mp3" ? " · " + item.height + "p" : ""}</span>
        ${item.duration ? `<span class="yt-badge">${fmtTime(item.duration)}</span>` : ""}
        <span class="g-play"><svg viewBox="0 0 24 24" width="30" height="30"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></span>
      </div>
      <div class="g-meta">
        <div class="g-text">
          <h3 title="${escapeHtml(item.file)}">${escapeHtml(item.title)}</h3>
          <p>${fmtSize(item.size)} · ${dateFmt.format(new Date(item.created * 1000))} ${cut}</p>
        </div>
        <button type="button" class="g-more yt-more" aria-label="Műveletek">${ICON_MORE}</button>
      </div>`;
    card.addEventListener("click", (event) => {
      if (event.target.closest(".g-more")) { event.stopPropagation(); openMenu(event.target.closest(".g-more"), item); return; }
      if (event.target.closest(".g-select") || selected.size || event.ctrlKey || event.shiftKey) {
        toggle(item.id, event.shiftKey);
        return;
      }
      play(item.id);
    });
    card.addEventListener("dblclick", (event) => { if (!event.target.closest("button")) openFile(item.id); });
    card.addEventListener("contextmenu", (event) => { event.preventDefault(); openMenu(card.querySelector(".g-more"), item); });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") play(item.id);
      if (event.key === " ") { event.preventDefault(); toggle(item.id, event.shiftKey); }
    });
    return card;
  }

  function toggle(id, range) {
    if (range && anchorId) {
      const ids = shown.map(x => x.id);
      const [a, b] = [ids.indexOf(anchorId), ids.indexOf(id)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) ids.slice(a, b + 1).forEach(x => selected.add(x));
    } else if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchorId = id;
    for (const [cid, card] of cards) card.classList.toggle("selected", selected.has(cid));
    updateBar();
  }

  function updateBar() {
    bar.hidden = selected.size === 0;
    view.classList.toggle("selecting", selected.size > 0);
    const bytes = items.filter(x => selected.has(x.id)).reduce((sum, x) => sum + (x.size || 0), 0);
    $("selectionCount").textContent = `${selected.size} kijelölve · ${fmtSize(bytes)}`;
  }

  function openMenu(anchor, item) {
    showContextMenu(anchor, [
      { label: "Lejátszás", action: () => play(item.id) },
      { label: "Megnyitás külső lejátszóban", action: () => openFile(item.id) },
      { label: "Megjelenítés a mappában", action: () => revealLibrary(item.id) },
      { label: "Vágás és átalakítás…", action: () => openEdit(item) },
      { label: "Átnevezés…", action: () => rename(item) },
      { label: selected.has(item.id) ? "Kijelölés megszüntetése" : "Kijelölés", action: () => toggle(item.id) },
      item.url && { label: "Forrás megnyitása a szerkesztőben", action: () => { close(); loadFromUrl(item.url); } },
      { label: "Törlés", danger: true, action: () => remove([item.id]) },
    ].filter(Boolean));
  }

  function openFile(id) { openLibraryFile(id); }

  async function rename(item) {
    const title = prompt("Új fájlnév:", item.title);
    if (!title || title.trim() === item.title) return;
    try { await postJSON(`${API}/api/library/${item.id}/rename`, { title: title.trim() }); await load(); }
    catch (error) { toast(error.message, [], "error"); }
  }

  function confirmDialog(title, text, yes = "Törlés") {
    const dialog = $("confirmDialog");
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmYes").textContent = yes;
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true }));
  }

  async function remove(ids) {
    if (!ids.length) return;
    const names = items.filter(x => ids.includes(x.id)).map(x => x.title);
    const ok = await confirmDialog(ids.length === 1 ? "Fájl törlése" : `${ids.length} fájl törlése`,
      (ids.length === 1 ? `„${names[0]}”` : `${names.slice(0, 3).map(n => `„${n}”`).join(", ")}${names.length > 3 ? ` és még ${names.length - 3}` : ""}`)
      + " a Lomtárba kerül, onnan visszaállítható.");
    if (!ok) return;
    try {
      const result = await postJSON(`${API}/api/library/delete`, { ids });
      result.removed.forEach(id => selected.delete(id));
      if (result.removed.length < ids.length) toast("Néhány fájlt nem sikerült törölni (lehet, hogy használatban van).", [], "error");
      else toast(result.removed.length === 1 ? "A fájl a Lomtárba került." : `${result.removed.length} fájl a Lomtárba került.`);
      if (viewer.open && !items.some(x => x.id === shown[viewerIndex]?.id && !ids.includes(x.id))) closeViewer();
      await load();
    } catch (error) { toast(error.message, [], "error"); }
  }

  // --- szerkesztés (vágás / átméretezés / MP3) ---
  let editing = null;
  function openEdit(item) {
    editing = item;
    $("editName").textContent = item.file;
    $("editStart").value = "";
    $("editEnd").value = "";
    $("editHeight").value = "0";
    $("editFormat").value = item.format === "mp3" ? "mp3" : "mp4";
    $("editFormat").querySelector('[value="mp4"]').disabled = item.format === "mp3";
    $("editReplace").checked = false;
    $("editDialog").showModal();
  }
  $("editCancel").addEventListener("click", () => $("editDialog").close());
  $("editForm").addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "ok" || !editing) return;
    const start = $("editStart").value.trim() ? parseTimeInput($("editStart").value) : 0;
    const end = $("editEnd").value.trim() ? parseTimeInput($("editEnd").value) : 0;
    if (!Number.isFinite(start) || !Number.isFinite(end) || (end && end <= start)) {
      event.preventDefault();
      toast("Érvénytelen időpont. Példa: 1:05 vagy 65,5", [], "error");
      return;
    }
    try {
      await postJSON(`${API}/api/library/${editing.id}/edit`, {
        start, end, height: Number($("editHeight").value), format: $("editFormat").value, replace: $("editReplace").checked,
      });
      startJobPolling();
      toast("A szerkesztés elindult.", [{ label: "Letöltések", action: openJobs }]);
    } catch (error) { toast(error.message, [], "error"); }
  });

  // --- lejátszó ---
  function play(id) {
    if (!loaded) { load().then(() => play(id)); return; }
    if (view.hidden) open();
    shown = shown.length ? shown : filtered();
    viewerIndex = shown.findIndex(x => x.id === id);
    if (viewerIndex < 0) { shown = filtered(); viewerIndex = shown.findIndex(x => x.id === id); }
    if (viewerIndex < 0) return;
    showInViewer();
    if (!viewer.open) viewer.showModal();
  }

  function showInViewer() {
    const item = shown[viewerIndex];
    if (!item) return;
    $("viewerTitle").textContent = item.title;
    const audio = item.format === "mp3";
    viewerArt.hidden = !audio;
    viewer.classList.toggle("audio", audio);
    if (audio) viewerArt.src = item.hasThumb ? `${API}/api/library/${item.id}/thumb` : thumbUrl(item.thumbnail);
    viewerVideo.src = `${API}/api/library/${item.id}/file`;
    viewerVideo.play().catch(() => {});
    $("viewerPrev").disabled = viewerIndex <= 0;
    $("viewerNext").disabled = viewerIndex >= shown.length - 1;
  }

  function closeViewer() {
    viewerVideo.pause();
    viewerVideo.removeAttribute("src");
    viewerVideo.load();
    if (viewer.open) viewer.close();
  }
  viewer.addEventListener("close", () => { viewerVideo.pause(); viewerVideo.removeAttribute("src"); viewerVideo.load(); });
  viewer.addEventListener("click", (event) => { if (event.target === viewer) closeViewer(); });
  $("viewerClose").addEventListener("click", closeViewer);
  $("viewerPrev").addEventListener("click", () => { if (viewerIndex > 0) { viewerIndex--; showInViewer(); } });
  $("viewerNext").addEventListener("click", () => { if (viewerIndex < shown.length - 1) { viewerIndex++; showInViewer(); } });
  $("viewerReveal").addEventListener("click", () => revealLibrary(shown[viewerIndex]?.id));
  $("viewerExternal").addEventListener("click", () => { viewerVideo.pause(); openFile(shown[viewerIndex]?.id); });
  viewer.addEventListener("keydown", (event) => {
    if (event.target.closest("input")) return;
    if (event.key === "ArrowRight" && event.altKey) $("viewerNext").click();
    if (event.key === "ArrowLeft" && event.altKey) $("viewerPrev").click();
    if (event.key === "PageDown") $("viewerNext").click();
    if (event.key === "PageUp") $("viewerPrev").click();
  });

  // --- nézet nyitása / eszközsor ---
  function open() {
    closeList(); closeJobs(); stopPreview();
    showView("gallery");
    render();
    load();
  }
  function close() { showView("landing"); }

  $("galleryBtn").addEventListener("click", () => view.hidden ? open() : close());
  $("galleryFilter").addEventListener("input", render);
  $("gallerySort").addEventListener("change", render);
  $("galleryKind").addEventListener("click", (event) => {
    const button = event.target.closest(".seg");
    if (!button) return;
    kind = button.dataset.kind;
    for (const b of $("galleryKind").children) b.classList.toggle("active", b === button);
    render();
  });
  $("galleryOpenFolder").addEventListener("click", () => fetch(`${API}/api/library/folder/open`, { method: "POST" }));
  $("selAll").addEventListener("click", () => { shown.forEach(x => selected.add(x.id)); render(); });
  $("selClear").addEventListener("click", () => { selected.clear(); render(); });
  $("selDelete").addEventListener("click", () => remove([...selected]));
  $("selReveal").addEventListener("click", () => revealLibrary([...selected][0]));
  document.addEventListener("keydown", (event) => {
    if (view.hidden || document.querySelector("dialog[open]") || event.target.closest("input, textarea, select")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); shown.forEach(x => selected.add(x.id)); render(); }
    if (event.key === "Delete" && selected.size) { event.preventDefault(); remove([...selected]); }
    if (event.key === "Escape" && selected.size) { selected.clear(); render(); }
  });

  window.galleryHooks = {
    open,
    play,
    refresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 250); },
  };
  load();
})();
