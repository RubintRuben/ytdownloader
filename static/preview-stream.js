// Append fragmented MP4 incrementally. Keep only a small playback window in memory.
function previewMime(hasAudio) {
  return 'video/mp4; codecs="avc1.42C01F' + (hasAudio ? ', mp4a.40.2' : '') + '"';
}

async function attachPreviewStream(video, url, start, duration, hasAudio, signal) {
  const source = new MediaSource();
  const objectUrl = URL.createObjectURL(source);
  signal.addEventListener("abort", () => URL.revokeObjectURL(objectUrl), { once: true });
  const wait = (target, event) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const listeners = new AbortController();
    const options = { once: true, signal: listeners.signal };
    const finish = (error) => { listeners.abort(); error ? reject(error) : resolve(); };
    target.addEventListener(event, () => finish(), options);
    target.addEventListener("error", () => finish(new Error("Preview stream could not be decoded")), options);
    signal.addEventListener("abort", () => finish(signal.reason), options);
  });

  const opened = wait(source, "sourceopen");
  video.src = objectUrl;
  await opened;
  const buffer = source.addSourceBuffer(previewMime(hasAudio));
  if (duration > 0) source.duration = duration;
  buffer.timestampOffset = start;

  const response = await fetch(url + "?start=" + start.toFixed(3), { signal, cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("Preview stream unavailable");
  const reader = response.body.getReader();
  let positioned = false;
  try {
    while (!signal.aborted) {
      const cutoff = video.currentTime - 25;
      if (buffer.buffered.length && cutoff > buffer.buffered.start(0) + 15) {
        buffer.remove(0, cutoff);
        await wait(buffer, "updateend");
      }
      if (positioned && buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - video.currentTime > 22) {
        await new Promise(resolve => setTimeout(resolve, 220));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer.appendBuffer(value);
      await wait(buffer, "updateend");
      if (!positioned && buffer.buffered.length) {
        positioned = true;
        const firstFrame = buffer.buffered.start(0);
        if (start || firstFrame > 0.005) {
          video.currentTime = Math.min(buffer.buffered.end(0) - 0.001, firstFrame + 0.02);
        }
      }
    }
    if (!signal.aborted) {
      if (!positioned) throw new Error("Empty preview stream");
      if (duration > 0 && buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) < duration - 2) {
        throw new Error("Preview stream stopped before the end");
      }
      source.endOfStream();
    }
  } finally {
    try { await reader.cancel(); } catch { /* Closing a replaced stream also aborts its request. */ }
  }
}
