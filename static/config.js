// A frontend és az API ugyanazon a helyi szerveren fut (egy URL), ezért ez üres marad.
window.API_BASE = "";

// Every state-changing request carries this header; the local server rejects
// cross-site form posts that cannot set it.
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("X-Downloader", "1");
      init = { ...init, headers };
    }
    return nativeFetch(input, init);
  };
  window.postJSON = (url, body) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "A művelet nem sikerült.");
    return data;
  });
})();
