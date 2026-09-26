// Talks to the local render backend (server/). Exposes the same renderVideo /
// cancelRender surface the old in-browser ffmpeg.wasm module had, so page.js is
// unchanged apart from its import. Assets are POSTed to the backend, progress
// streams back over SSE, and the finished MP4 is returned as a Blob.
//
// BASE is empty by default (same origin — the backend serves this static UI).
// For dev (frontend on :3000, backend on :4000) set NEXT_PUBLIC_RENDER_URL.
const BASE = process.env.NEXT_PUBLIC_RENDER_URL || "";

// Is the ffmpeg render backend reachable? On a static host (e.g. Vercel) there is
// no /status endpoint, so this resolves false and the app runs WebCodecs-only.
export async function probeBackend() {
  try {
    const r = await fetch(`${BASE}/status`, { cache: "no-store" });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && typeof j === "object");
  } catch (_) { return false; }
}

let _job = null; // { jobId, es } for the in-flight render, so cancel can reach it

// Fetch a resolved SFX url (a library preset under /sfx or an upload's blob URL)
// into a File so it can ride along in the multipart body like every other asset.
function sfxExt(type, url) {
  const sub = (type || "").split("/")[1] || "";
  const clean = sub.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (clean) return clean === "mpeg" ? "mp3" : clean;
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url || "");
  return m ? m[1].toLowerCase() : "mp3";
}
async function sfxUrlToFile(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load a sound effect (${res.status})`);
  const blob = await res.blob();
  return new File([blob], `${name}.${sfxExt(blob.type, url)}`, { type: blob.type || "audio/mpeg" });
}

// Attach to a job's progress, then fetch the finished MP4 as a Blob. Shared by a
// fresh render and by reconnecting to one already running.
//
// Mobile-resilient: on Termux the SSE stream drops whenever Android throttles or
// freezes the app (screen lock, tab backgrounded). Instead of failing on the
// first drop, we (a) keep an SSE stream for smooth progress but silently reopen
// it when it errors, and (b) run an independent /status poll that survives drops
// — each poll is a fresh request, so it recovers automatically when Termux wakes.
// We only give up after a long, sustained outage. The render keeps running on the
// server the whole time (and auto-saves to a folder), so a wobble never loses it.
async function awaitJobBlob(jobId, onProgress) {
  await new Promise((resolve, reject) => {
    let es = null;
    let pollTimer = null;
    let settled = false;
    let netFails = 0;   // consecutive failed status polls (server unreachable)
    let missing = 0;    // consecutive polls where the job wasn't listed
    let sawJob = false;

    const cleanup = () => {
      if (es) { try { es.close(); } catch { /* noop */ } es = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
    const succeed = () => { if (settled) return; settled = true; cleanup(); _job = null; resolve(); };
    const failWith = (msg) => { if (settled) return; settled = true; cleanup(); _job = null; reject(new Error(msg)); };

    const openSSE = () => {
      try {
        es = new EventSource(`${BASE}/render/${jobId}/events`);
        _job = { jobId, es };
        es.onmessage = (ev) => {
          let d; try { d = JSON.parse(ev.data); } catch { return; }
          if (d.progress != null && onProgress) onProgress(d.progress);
          if (d.done) succeed();
          if (d.error) failWith(d.error);
        };
        // Don't fail on SSE error — close it; the poller keeps us alive and will
        // reopen the stream when the server is reachable again.
        es.onerror = () => { try { es.close(); } catch { /* noop */ } es = null; };
      } catch { es = null; }
    };

    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const r = await fetch(`${BASE}/status`, { cache: "no-store" });
        if (!r.ok) throw new Error("bad status");
        const arr = await r.json();
        netFails = 0;
        const job = Array.isArray(arr) ? arr.find((j) => j.id === jobId) : null;
        if (job) {
          sawJob = true; missing = 0;
          if (onProgress && job.percent != null) onProgress(job.percent / 100);
          if (job.status === "done") return succeed();
          if (job.status === "error") return failWith("Render failed on the server");
        } else if (sawJob && ++missing >= 3) {
          // Job finished and was cleaned up (or the server restarted). Assume done
          // and let the file fetch below confirm.
          return succeed();
        }
        if (!es) openSSE(); // reopen the stream after a drop
      } catch {
        netFails++;
        if (netFails >= 150) failWith("Lost connection to the render server"); // ~5 min unreachable
      }
    }, 2000);

    openSSE();
  });

  const fileRes = await fetch(`${BASE}/render/${jobId}/file`);
  _job = null;
  if (!fileRes.ok) throw new Error("Render finished but the file could not be fetched");
  return await fileRes.blob();
}

// The render currently running on the server (or null). Lets the UI reconnect
// after a reload / on reopening the tab.
export async function getActiveRender() {
  try {
    const r = await fetch(`${BASE}/active`);
    const a = await r.json();
    return a && a.jobId ? a : null;
  } catch { return null; }
}

// Reconnect to an already-running render and resolve with its finished Blob.
export function reconnectRender(jobId, onProgress) {
  return awaitJobBlob(jobId, onProgress);
}

export async function renderVideo(opts) {
  const {
    clips, imagesByName, videosByName = {}, audioFile, width, height, fps = 30,
    transitions, transitionDuration = 0.4, motions, motionAmount = 0.08,
    trims, volumes, speeds,
    fadeIn = 0, fadeOut = 0,
    captions = null, captionStyle = "classic", captionSize = "md", captionLineHeight, captionFontScale, captionAnimation = "none",
    audioLayers = [],
    sfx = [],
    voiceFx = null,
    voiceLevel = 1,
    overlayFile = null, overlayUrl = null, overlayDuration = 0, overlayOpacity = 0.3, overlayBlendMode = "overlay", overlayLoop = true, overlayEnabled = false,
    watermarkFile = null, watermarkUrl = null, watermarkSize = 0.15, watermarkX = 0.8, watermarkY = 0.88, watermarkOpacity = 0.9, watermarkEnabled = false,
    logoFile = null, logoUrl = null, logoCorner = "br", logoSize = 0.12, logoOpacity = 0.9, logoEnabled = false,
    onProgress,
  } = opts;

  const spec = {
    clips, width, height, fps,
    transitions, transitionDuration, motions, motionAmount, trims, volumes, speeds, fadeIn, fadeOut,
    captions, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation,
    audioLayers,
    sfx: sfx.map((s) => ({ id: s.id, at: s.at, volume: s.volume })),
    voiceFx: voiceFx || null,
    voiceLevel: Math.max(0, Math.min(1, +voiceLevel || 1)),
    overlayDuration, overlayOpacity, overlayBlendMode, overlayLoop, overlayEnabled,
    watermarkSize, watermarkX, watermarkY, watermarkOpacity, watermarkEnabled,
    logoCorner, logoSize, logoOpacity, logoEnabled,
  };

  // One render at a time: bail early (before uploading) if the server is busy.
  const active = await getActiveRender();
  if (active) throw new Error("A render is already in progress. Please wait for it to finish, then try again.");

  const fd = new FormData();
  fd.append("spec", JSON.stringify(spec));
  fd.append("audio", audioFile, audioFile.name);
  // Overlay video
  if (overlayEnabled && overlayFile) {
    fd.append("overlay", overlayFile, overlayFile.name);
  }
  // Image overlay (logo / watermark)
  if (watermarkEnabled && watermarkFile) {
    fd.append("watermark", watermarkFile, watermarkFile.name);
  }
  // Corner logo overlay
  if (logoEnabled && logoFile) {
    fd.append("logo", logoFile, logoFile.name);
  }
  // Each image/video is a field keyed by its clip name; gap clips have no file
  // and the backend renders them black. The backend tells image from video by the
  // uploaded file's extension.
  for (const [name, file] of Object.entries(imagesByName)) fd.append(name, file, file.name);
  for (const [name, file] of Object.entries(videosByName)) fd.append(name, file, file.name);
  // Additional audio layers with clips
  for (const layer of audioLayers) {
    for (const clip of layer.clips || []) {
      if (clip.file) fd.append(`layerclip_${clip.id}`, clip.file, clip.file.name);
    }
  }
  // Sound effects on the FX lane: upload each marker's resolved url under a field
  // keyed by its id, so the backend can place it at `at` with its own volume.
  for (const s of sfx) {
    if (!s.url) continue;
    const file = await sfxUrlToFile(s.url, `sfx-${s.id}`);
    fd.append(`sfx_${s.id}`, file, file.name);
  }

  let res;
  try {
    res = await fetch(`${BASE}/render`, { method: "POST", body: fd });
  } catch {
    throw new Error("Render server not reachable — is it running?");
  }
  if (res.status === 409) {
    throw new Error("A render is already in progress. Please wait for it to finish, then try again.");
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `Render request failed (${res.status})`);
  }
  const { jobId } = await res.json();
  return await awaitJobBlob(jobId, onProgress);
}

export function cancelRender() {
  if (!_job) return;
  const { jobId, es } = _job;
  try { es.close(); } catch { /* already closed */ }
  fetch(`${BASE}/render/${jobId}/cancel`, { method: "POST" }).catch(() => {});
  _job = null;
}
