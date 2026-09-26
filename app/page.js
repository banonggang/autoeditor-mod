"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./globals.css";
import { parseTimestampName } from "../lib/timestamp";
import { buildTimeline, trimClips, LEAD_IN } from "../lib/timeline";
import { computeVoiceOnsets, syncClipsToVoiceover, alignedClipCount } from "../lib/syncAudio";
import { resolveDimensions, capTo720, upTo4K } from "../lib/dimensions";
import { getAudioDuration, getMediaDuration } from "../lib/audio";
import { getWaveformPeaks, waveBucketCount } from "../lib/waveform";
import { renderVideo, cancelRender, getActiveRender, reconnectRender, probeBackend } from "../lib/serverRender";
import { renderWebCodecs, webCodecsCanRender, pickRenderProfile, startKeepAwake, crfTargetBitrate } from "../lib/webcodecsRender";
import { DEFAULT_TRANSITION_DURATION, mixTransitions } from "../lib/transitions";
import { parseTranscript } from "../lib/captions";
import { makeTextOverlay, drawTextOverlays, textOverlayFontPx } from "../lib/textOverlay";
import { sanitizeVoiceFx } from "../lib/voiceFx";
import QuickTour from "../components/QuickTour";

import Dropzone from "../components/Dropzone";
import Editor from "../components/Editor";
import ProjectsHome from "../components/ProjectsHome";
import { DialogHost, showAlert, showPrompt } from "../components/Dialog";
import {
  requestPersist, storageEstimate, listProjects, getProject, saveProject,
  renameProject, deleteProject, getMedia, syncMedia, newId, getMeta, setMeta,
} from "../lib/projectStore";

// Match a media file by MIME type, falling back to the extension when the
// browser reports an empty type (drag-drop and some pickers can do this for
// video files) so .mp4/.png/.wav still make it onto the timeline.
const MEDIA_EXT = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "jfif", "tif", "tiff"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi", "ts", "mts", "m2ts", "3gp", "3g2", "ogv"],
  audio: ["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "wma"],
};
const isMediaFile = (f, cats = ["image", "video"]) => {
  const type = (f.type || "").toLowerCase();
  if (cats.some((c) => type.startsWith(`${c}/`))) return true;
  const ext = (f.name || "").split(".").pop().toLowerCase();
  return cats.some((c) => MEDIA_EXT[c] && MEDIA_EXT[c].includes(ext));
};

function loadImageEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { img.url = url; img.fileName = file.name; resolve(img); };
    img.src = url;
  });
}

// Load a video clip as a still-poster Image (so the timeline/canvas draw it just
// like a photo) while carrying the video's URL + duration for the trim scrubber
// and export. img.url = poster (drawable), img.videoUrl = the actual video.
function loadVideoEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const finish = (posterSrc, w, h, dur) => {
      const img = new Image();
      img.onload = () => {
        img.url = posterSrc; img.fileName = file.name;
        img.isVideo = true; img.videoUrl = url; img.videoDuration = dur || 0;
        resolve(img);
      };
      img.onerror = () => { // poster failed — resolve a bare marker so it still imports
        img.url = null; img.fileName = file.name; img.isVideo = true;
        img.videoUrl = url; img.videoDuration = dur || 0; resolve(img);
      };
      img.src = posterSrc || url;
    };
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.playsInline = true; v.src = url;
    v.onloadeddata = () => {
      const grab = () => {
        try {
          const c = document.createElement("canvas");
          c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720;
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          finish(c.toDataURL("image/jpeg", 0.82), c.width, c.height, v.duration);
        } catch { finish(null, v.videoWidth, v.videoHeight, v.duration); }
      };
      v.onseeked = grab;
      try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { grab(); }
    };
    v.onerror = () => finish(null, 0, 0, 0);
  });
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Run an async fn over items with a concurrency limit. Loading 250 large images
// (or opening 250 IndexedDB reads) all at once spikes memory/CPU and freezes the
// tab; a small limit keeps it fast without the freeze.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// Undo/redo over one composition snapshot. Object URLs are intentionally never
// revoked, so an undone snapshot still points at a live image.
function useHistory(initial) {
  const [hist, setHist] = useState({ past: [], present: initial, future: [] });
  const commit = useCallback((updater) => {
    setHist((h) => {
      const next = typeof updater === "function" ? updater(h.present) : updater;
      if (next === h.present) return h;
      return { past: [...h.past, h.present], present: next, future: [] };
    });
  }, []);
  const undo = useCallback(() => setHist((h) => {
    if (!h.past.length) return h;
    const prev = h.past[h.past.length - 1];
    return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
  }), []);
  const redo = useCallback(() => setHist((h) => {
    if (!h.future.length) return h;
    const nxt = h.future[0];
    return { past: [...h.past, h.present], present: nxt, future: h.future.slice(1) };
  }), []);
  const reset = useCallback((present) => setHist({ past: [], present, future: [] }), []);
  return [
    hist.present, commit,
    { undo, redo, canUndo: hist.past.length > 0, canRedo: hist.future.length > 0, reset },
  ];
}

// A slot is one point on the timeline: { id, seconds, file, img, empty }.
// Empty slots are placeholders (a removed image or the lead-in you filled out).
export default function Home() {
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [peaks, setPeaks] = useState([]);
  // Voice-over effect: { effect, strength } applied to the narration in preview
  // and both export paths (null = none). See lib/voiceFx.js.
  const [voiceFx, setVoiceFx] = useState(null);
  // Voice-over master volume (0–1): scales the narration in preview and export.
  const [voiceLevel, setVoiceLevel] = useState(1);
  // Background-music (BG) lane: uploaded audio placed on the timeline, each clip
  // movable with its own waveform and volume. Replaces the old multi-layer system.
  // Each: { id, name, file, url, start, duration, peaks, volume }
  const [bgClips, setBgClips] = useState([]);
  const [selectedBg, setSelectedBg] = useState(null); // { name, file, url, duration, peaks } ready to place
  const [bgOpen, setBgOpen] = useState(null); // clip id open in the edit modal
  const bgIdRef = useRef(1);
  // Sound effects placed on the timeline's FX lane (library presets or uploads).
  // Each: { id, name, src, at, volume } where src is { kind:"lib", file } or
  // { kind:"upload", mediaId }. sfxUploads holds the decoded blob for uploads.
  const [sfx, setSfx] = useState([]);
  const [sfxUploads, setSfxUploads] = useState([]); // { mediaId, label, url, _file }
  const [selectedSound, setSelectedSound] = useState(null); // { name, url, src } to place next
  const [sfxOpen, setSfxOpen] = useState(null); // id of the marker open in the edit modal
  // Master gain for the whole FX lane (0–1), applied on top of each marker's volume
  // in the preview and both export paths.
  const [sfxMaster, setSfxMaster] = useState(1);
  // Video overlay (e.g., old film texture)
  const [overlayFile, setOverlayFile] = useState(null);
  const [overlayUrl, setOverlayUrl] = useState(null);
  const [overlayDuration, setOverlayDuration] = useState(0);
  const [overlayOpacity, setOverlayOpacity] = useState(0.3);
  const [overlayBlendMode, setOverlayBlendMode] = useState("overlay"); // overlay, multiply, screen, soft-light
  const [overlayLoop, setOverlayLoop] = useState(true);
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  // Static image overlay (logo / watermark): a transparent PNG placed anywhere,
  // with manual size / X / Y / opacity controls.
  const [watermarkFile, setWatermarkFile] = useState(null);
  const [watermarkUrl, setWatermarkUrl] = useState(null);
  const [watermarkSize, setWatermarkSize] = useState(0.15); // fraction of the smaller canvas edge
  const [watermarkX, setWatermarkX] = useState(0.8);   // center position, fraction of width (0-1)
  const [watermarkY, setWatermarkY] = useState(0.88);  // center position, fraction of height (0-1)
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.9);
  const [watermarkEnabled, setWatermarkEnabled] = useState(false);
  // Corner logo overlay (logo / badge fixed to one of the four corners), with
  // corner position + opacity controls.
  const [logoFile, setLogoFile] = useState(null);
  const [logoUrl, setLogoUrl] = useState(null);
  const [logoCorner, setLogoCorner] = useState("br"); // "tl" | "tr" | "bl" | "br"
  const [logoSize, setLogoSize] = useState(0.12);      // fraction of the smaller canvas edge
  const [logoOpacity, setLogoOpacity] = useState(0.9);
  const [logoEnabled, setLogoEnabled] = useState(false);
  const [aspect, setAspect] = useState("16:9");
  const [fps, setFps] = useState(30);
  const [renderQuality, setRenderQuality] = useState("full"); // "full" | "720p"
  const [transitionDuration, setTransitionDuration] = useState(DEFAULT_TRANSITION_DURATION);
  const [fadeIn, setFadeIn] = useState(0.5);          // opening fade seconds (0 = off)
  const [fadeOut, setFadeOut] = useState(0.6);        // ending fade seconds (0 = off)
  const [motionByName, setMotionByName] = useState({}); // clip name -> zoomin | zoomout
  const [motionAmount, setMotionAmount] = useState(0.08); // Ken Burns zoom depth (0–0.2)
  const [fxByName, setFxByName] = useState({});        // clip name -> image effect id (lib/imageEffects)
  const [fxAmount, setFxAmount] = useState(0.5);       // image effect intensity (0–1)
  const [trimByName, setTrimByName] = useState({});   // video clip name -> in-point seconds
  const [volumeByName, setVolumeByName] = useState({}); // video clip name -> 0..1 (default 0.5)
  const [fitByName, setFitByName] = useState({});     // video clip name -> "fit" (fast-fwd, default) | "trim" (1x)
  const [trimEnd, setTrimEnd] = useState(0); // export end point (0 = untrimmed / full audio)
  const [captionRaw, setCaptionRaw] = useState(null); // uploaded transcript text
  const [captionName, setCaptionName] = useState(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [textOverlays, setTextOverlays] = useState([]);
  // Image ↔ narration auto-sync: snap each image to its line's ACTUAL speech onset
  // in the voiceover (see lib/syncAudio.js) instead of trusting filename timestamps.
  const [syncOn, setSyncOn] = useState(false);
  const [syncOnsets, setSyncOnsets] = useState(null); // [{ cueStart, onset|null }]
  const [syncStatus, setSyncStatus] = useState({ decoding: false, error: null, detected: 0, total: 0 });
  const [captionStyle, setCaptionStyle] = useState("classic");
  const [captionSize, setCaptionSize] = useState("md");
  const [captionLineHeight, setCaptionLineHeight] = useState(null); // null = per-style default
  const [captionFontScale, setCaptionFontScale] = useState(null);   // null = use the size preset
  const [captionAnimation, setCaptionAnimation] = useState("none"); // caption entrance animation (preview == render)
  const [importing, setImporting] = useState(null);   // { done, total } while decoding imports
  const [importNote, setImportNote] = useState(null);  // transient "skipped X files" toast
  const importNoteTimerRef = useRef(0);
  const [built, setBuilt] = useState(false);          // committed images to the timeline?
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outUrl, setOutUrl] = useState(null);
  const [error, setError] = useState(null);
  // A render that was already running when this tab loaded (e.g. reopened after
  // closing the browser mid-render). Shown as a banner and reconnected to.
  const [resume, setResume] = useState(null); // { busy, progress, url, error }
  // Projects: everything is stored client-side in IndexedDB (see lib/projectStore).
  const [view, setView] = useState("list");            // "list" (projects grid) | "editor"
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null); // { id, name, createdAt }
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [loadingProject, setLoadingProject] = useState(false);
  const saveRef = useRef(null);
  const idRef = useRef(0);
  const nextId = () => `s${idRef.current++}`;

  // Composition (undoable): slots + per-clip transition choices, snapshotted together.
  const [doc, commitDoc, { undo, redo, canUndo, canRedo, reset: resetDoc }] =
    useHistory({ slots: [], transitionsByName: {} });
  const { slots, transitionsByName } = doc;

  const onAudio = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;
    setError(null);
    try {
      const d = await getAudioDuration(file);
      setAudioFile(file);
      setAudioUrl(URL.createObjectURL(file));
      setAudioDuration(d);
      getWaveformPeaks(file, 1000).then(setPeaks);
    } catch (e) { setError(e.message); }
  }, []);

  const onOverlay = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;
    setError(null);
    try {
      const d = await getMediaDuration(file);
      setOverlayFile(file);
      setOverlayUrl(URL.createObjectURL(file));
      setOverlayDuration(d);
      setOverlayEnabled(true);
    } catch (e) { setError(e.message); }
  }, []);

  const addTextOverlay = useCallback(() => setTextOverlays((p) => [...p, makeTextOverlay(crypto.randomUUID ? crypto.randomUUID() : `to-${Date.now()}`)]), []);
  const updateTextOverlay = useCallback((id, patch) => setTextOverlays((p) => p.map((o) => (o.id === id ? { ...o, ...patch } : o))), []);
  const removeTextOverlay = useCallback((id) => setTextOverlays((p) => p.filter((o) => o.id !== id)), []);
  // Replace the whole overlay list at once (used when a saved config preset is applied).
  const replaceTextOverlays = useCallback((list) => setTextOverlays(list), []);

  const onWatermark = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;
    setError(null);
    setWatermarkFile(file);
    setWatermarkUrl(URL.createObjectURL(file));
    setWatermarkEnabled(true);
  }, []);

  const onLogo = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;
    setError(null);
    setLogoFile(file);
    setLogoUrl(URL.createObjectURL(file));
    setLogoEnabled(true);
  }, []);

  // --- Background music (BG lane) -------------------------------------------
  // Pick a file: read its duration + a dense waveform, then hold it as the pending
  // clip. A click on the BG lane drops a copy where the pointer is.
  const uploadBg = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    try {
      const d = await getAudioDuration(file);
      const peaks = await getWaveformPeaks(file, waveBucketCount(d));
      setSelectedBg({ name: file.name, file, url: URL.createObjectURL(file), duration: d, peaks });
    } catch (e) { setError(e.message); }
  }, []);

  const addBgClip = useCallback((at) => {
    if (!selectedBg) return;
    const id = `bg${bgIdRef.current++}`;
    setBgClips((prev) => [...prev, {
      id,
      name: selectedBg.name,
      file: selectedBg.file,
      url: URL.createObjectURL(selectedBg.file),
      start: Math.max(0, +at || 0),
      sourceDuration: selectedBg.duration,
      offset: 0,
      duration: selectedBg.duration,
      fadeIn: 0,
      fadeOut: 0,
      peaks: selectedBg.peaks,
      volume: 0.8,
    }]);
  }, [selectedBg]);

  const moveBgClip = useCallback((id, start) => {
    setBgClips((prev) => prev.map((c) => (c.id === id ? { ...c, start: Math.max(0, +start || 0) } : c)));
  }, []);

  const setBgVolume = useCallback((id, v) => {
    setBgClips((prev) => prev.map((c) => (c.id === id ? { ...c, volume: Math.min(1, Math.max(0, +v || 0)) } : c)));
  }, []);

  // Update a BG clip: trim (`offset`/`duration`), volume, or fades.
  const updateBgClip = useCallback((id, updates) => {
    setBgClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  }, []);

  const removeBgClip = useCallback((id) => {
    setBgClips((prev) => {
      const c = prev.find((x) => x.id === id);
      if (c && c.url) { try { URL.revokeObjectURL(c.url); } catch (_) {} }
      return prev.filter((x) => x.id !== id);
    });
    setBgOpen((o) => (o === id ? null : o));
  }, []);

  // --- Sound effects (FX lane) ----------------------------------------------
  const addSfx = useCallback((at) => {
    if (!selectedSound) return;
    setSfx((prev) => [...prev, {
      id: crypto.randomUUID ? crypto.randomUUID() : `sfx-${Date.now()}`,
      name: selectedSound.name,
      src: selectedSound.src,
      at: Math.max(0, +at || 0),
      volume: 0.8,
    }]);
  }, [selectedSound]);

  const moveSfx = useCallback((id, at) => {
    setSfx((prev) => prev.map((s) => (s.id === id ? { ...s, at: Math.max(0, +at || 0) } : s)));
  }, []);

  const setSfxVolume = useCallback((id, v) => {
    setSfx((prev) => prev.map((s) => (s.id === id ? { ...s, volume: Math.min(1, Math.max(0, +v || 0)) } : s)));
  }, []);

  const removeSfx = useCallback((id) => {
    setSfx((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const uploadSfx = useCallback((file) => {
    if (!file) return;
    const mediaId = `sfx-${newId()}`;
    const url = URL.createObjectURL(file);
    const label = file.name.replace(/\.[^.]+$/, "") || "sound";
    setSfxUploads((prev) => [...prev, { mediaId, label, url, _file: file }]);
    setSelectedSound({ name: label, url, src: { kind: "upload", mediaId } });
  }, []);

  // Delete an uploaded sound: drop the stored file, any placed markers that used
  // it (library presets are untouched), and clear it from the "place next" pick.
  const removeSfxUpload = useCallback((mediaId) => {
    setSfxUploads((prev) => {
      const up = prev.find((u) => u.mediaId === mediaId);
      if (up && up.url) { try { URL.revokeObjectURL(up.url); } catch (_) {} }
      return prev.filter((u) => u.mediaId !== mediaId);
    });
    setSfx((prev) => prev.filter((s) => !(s.src && s.src.kind === "upload" && s.src.mediaId === mediaId)));
    setSelectedSound((sel) => (sel && sel.src && sel.src.kind === "upload" && sel.src.mediaId === mediaId ? null : sel));
  }, []);

  // Resolve a placed sound's source to a playable/decodable URL.
  const resolveSfxUrl = useCallback((src) => {
    if (!src) return null;
    if (src.kind === "lib") return src.file;
    const up = sfxUploads.find((u) => u.mediaId === src.mediaId);
    return up ? up.url : null;
  }, [sfxUploads]);

  const sfxResolved = useMemo(
    () => sfx.map((s) => ({ id: s.id, at: s.at, volume: Math.max(0, Math.min(1, (s.volume == null ? 0.8 : s.volume) * sfxMaster)), url: resolveSfxUrl(s.src) })),
    [sfx, sfxMaster, resolveSfxUrl]
  );

  // BG clips mix exactly like sound effects (start + volume), so exports can reuse
  // the same render path by folding them into the sfx list.
  const bgResolved = useMemo(
    () => bgClips.filter((c) => c.url).map((c) => ({
      id: `bg_${c.id}`, at: c.start, volume: c.volume, url: c.url,
      offset: c.offset || 0, duration: c.duration,
      fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
    })),
    [bgClips]
  );
  const mixedAudio = useMemo(() => [...sfxResolved, ...bgResolved], [sfxResolved, bgResolved]);

  // Import images, merged by timestamp: a file whose timestamp matches an
  // existing slot fills/replaces it; otherwise it becomes a new slot.
  const addImages = useCallback(async (fileList) => {
    const all = Array.from(fileList).filter((f) => isMediaFile(f));
    // Files whose names contain whitespace (e.g. "0-01 2.jpg") can't be mapped
    // to a timestamp reliably — skip them and say so instead of importing as untimed.
    const files = all.filter((f) => !/\s/.test(f.name));
    const skipped = all.length - files.length;
    if (skipped) {
      setImportNote(`Skipped ${skipped} file${skipped > 1 ? "s" : ""} — filenames can't contain spaces.`);
      clearTimeout(importNoteTimerRef.current);
      importNoteTimerRef.current = setTimeout(() => setImportNote(null), 6000);
    }
    if (!files.length) return;
    // Guard against the same file arriving twice (a double file-picker, or a
    // folder drop that lists a file twice): one identical file = one timeline
    // entry. Files without a parseable timestamp would otherwise each get their
    // own slot and show up as duplicates.
    const seen = new Set();
    const unique = files.filter((f) => {
      const key = `${f.name}:${f.size}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Decoding many files (esp. video posters) takes a few seconds with no UI —
    // show live "loaded X of N" progress, ticking up as each file finishes.
    setImporting({ done: 0, total: unique.length });
    try {
      const loaded = await Promise.all(
        unique.map(async (f) => {
          const isVid = (f.type && f.type.startsWith("video/")) || /\.(mp4|m4v|mov|webm|mkv|avi|ts|mts|m2ts|3gp|3g2|ogv)$/i.test(f.name);
          const img = isVid ? await loadVideoEl(f) : await loadImageEl(f);
          setImporting((p) => (p ? { ...p, done: p.done + 1 } : p));
          return { file: f, seconds: parseTimestampName(f.name), img };
        })
      );
      commitDoc((d) => {
      const next = d.slots.map((s) => ({ ...s }));
      for (const { file, seconds, img } of loaded) {
        const slot = seconds != null ? next.find((s) => s.seconds === seconds) : null;
        if (slot) {
          slot.file = file; slot.img = img; slot.empty = false;
        } else {
          next.push({ id: nextId(), seconds, file, img, empty: false });
        }
      }
      return { ...d, slots: next };
      });
    } finally {
      setImporting(null);
    }
  }, [commitDoc]);

  // Swap the image/video in one slot, keeping its timestamp.
  const replaceImage = useCallback(async (id, file) => {
    if (!file || !isMediaFile(file)) return;
    const isVid = (file.type && file.type.startsWith("video/")) || /\.(mp4|m4v|mov|webm|mkv|avi|ts|mts|m2ts|3gp|3g2|ogv)$/i.test(file.name);
    const img = isVid ? await loadVideoEl(file) : await loadImageEl(file);
    commitDoc((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.id === id ? { ...s, file, img, empty: false } : s)),
    }));
  }, [commitDoc]);

  // Discard a staged image entirely (used in the pre-build import tray).
  const discardImage = useCallback((id) => {
    commitDoc((d) => ({ ...d, slots: d.slots.filter((s) => s.id !== id) }));
  }, [commitDoc]);

  // Removing an image turns its slot into a placeholder — neighbours don't move.
  const removeImage = useCallback((id) => {
    commitDoc((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.id === id ? { ...s, file: null, img: null, empty: true } : s)),
    }));
  }, [commitDoc]);

  // Fill a gap. LEAD_IN adds a new slot at 0; otherwise fill the empty slot.
  const fillGap = useCallback(async (name, file) => {
    if (!file) return;
    const isVid = file.type.startsWith("video/");
    if (!isVid && !file.type.startsWith("image/")) return;
    const img = isVid ? await loadVideoEl(file) : await loadImageEl(file);
    commitDoc((d) => {
      if (name === LEAD_IN) {
        return { ...d, slots: [...d.slots, { id: nextId(), seconds: 0, file, img, empty: false }] };
      }
      return { ...d, slots: d.slots.map((s) => (s.id === name ? { ...s, file, img, empty: false } : s)) };
    });
  }, [commitDoc]);

  // Roll edit: move the boundary between an image and the next clip by setting
  // the next clip's slot start. buildTimeline re-derives both durations; total
  // length and every other slot are untouched. One commit = one undo step.
  const resizeBoundary = useCallback((id, seconds) => {
    commitDoc((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.id === id ? { ...s, seconds: +seconds.toFixed(3) } : s)),
    }));
  }, [commitDoc]);

  // Read an uploaded transcript; parsing happens in a memo below so it re-syncs
  // if the audio length changes.
  const onCaptionFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      setCaptionRaw(text);
      setCaptionName(file.name);
      setCaptionsOn(true);
      setSyncOn(true);
    } catch (e) { setError(e.message || String(e)); }
  }, []);
  const captionParse = useMemo(
    () => (captionRaw ? parseTranscript(captionRaw, audioDuration) : { cues: [], error: null }),
    [captionRaw, audioDuration]
  );
  const captionCues = captionParse.cues;
  const captionError = captionParse.error;

  // Decode the voiceover once and find each line's real speech onset. Runs when
  // sync is on AND we have both the audio and a parsed script. Decoding a long
  // voiceover is streamed and memory-safe (see voiceSource.js); we keep only the
  // per-line onset list afterwards.
  useEffect(() => {
    if (!syncOn || !audioFile || !Array.isArray(captionCues) || !captionCues.length) {
      setSyncOnsets(null);
      return;
    }
    let alive = true;
    setSyncStatus((s) => ({ decoding: true, error: null, detected: 0, total: captionCues.length }));
    computeVoiceOnsets(audioFile, captionCues)
      .then((onsets) => {
        if (!alive) return;
        setSyncOnsets(onsets);
        setSyncStatus({
          decoding: false,
          error: null,
          detected: onsets ? onsets.filter((o) => o.onset != null).length : 0,
          total: captionCues.length,
        });
      })
      .catch((e) => {
        if (!alive) return;
        setSyncOnsets(null);
        setSyncStatus({ decoding: false, error: (e && e.message) || String(e), detected: 0, total: captionCues.length });
      });
    return () => { alive = false; };
  }, [syncOn, audioFile, captionCues]);

  // On load, reconnect to a render that's still running on the server.
  useEffect(() => {
    let alive = true;
    (async () => {
      const active = await getActiveRender();
      if (!alive || !active) return;
      setResume({ busy: true, progress: (active.percent || 0) / 100, url: null, error: null });
      try {
        const blob = await reconnectRender(active.jobId, (p) => {
          if (alive) setResume((r) => (r ? { ...r, progress: p } : r));
        });
        if (alive) setResume({ busy: false, progress: 1, url: URL.createObjectURL(blob), error: null });
      } catch (e) {
        if (alive) setResume({ busy: false, progress: 0, url: null, error: e.message || String(e) });
      }
    })();
    return () => { alive = false; };
  }, []);

  const setTransition = useCallback((name, type) => {
    commitDoc((d) => ({ ...d, transitionsByName: { ...d.transitionsByName, [name]: type } }));
  }, [commitDoc]);
  const applyTransitionAll = useCallback((type, clipNames) => {
    commitDoc((d) => {
      const next = {};
      // Skip the first clip — it has no incoming cut.
      for (let i = 1; i < clipNames.length; i++) next[clipNames[i]] = type;
      return { ...d, transitionsByName: next };
    });
  }, [commitDoc]);

  const setMotion = useCallback((name, type) => {
    setMotionByName((prev) => ({ ...prev, [name]: type }));
  }, []);
  const setTrim = useCallback((name, seconds) => {
    setTrimByName((prev) => ({ ...prev, [name]: Math.max(0, +seconds || 0) }));
  }, []);
  const setVolume = useCallback((name, vol) => {
    setVolumeByName((prev) => ({ ...prev, [name]: Math.min(1, Math.max(0, +vol || 0)) }));
  }, []);
  const setFit = useCallback((name, mode) => {
    setFitByName((prev) => ({ ...prev, [name]: mode }));
  }, []);
  const applyMotionAll = useCallback((type, names) => {
    setMotionByName(() => { const next = {}; for (const n of names) next[n] = type; return next; });
  }, []);
  const applyMotionAlternate = useCallback((names) => {
    setMotionByName(() => {
      const next = {};
      names.forEach((n, i) => { next[n] = i % 2 === 0 ? "zoomin" : "zoomout"; });
      return next;
    });
  }, []);
  const setFx = useCallback((name, id) => {
    setFxByName((prev) => ({ ...prev, [name]: id }));
  }, []);
  const applyFxAll = useCallback((id, names) => {
    setFxByName(() => { const next = {}; for (const n of names) next[n] = id; return next; });
  }, []);
  const applyMotionMix = useCallback((picks, names) => {
    const assigned = mixTransitions(picks, names.length);
    setMotionByName(() => { const next = {}; names.forEach((n, i) => { next[n] = assigned[i]; }); return next; });
  }, []);
  const applyFxMix = useCallback((picks, names) => {
    const assigned = mixTransitions(picks, names.length);
    setFxByName(() => { const next = {}; names.forEach((n, i) => { next[n] = assigned[i]; }); return next; });
  }, []);
  // Random mix: assign each cut a transition drawn randomly from `picks`
  // (no back-to-back repeats). One commit = one undo step.
  const applyTransitionMix = useCallback((picks, clipNames) => {
    const cutNames = clipNames.slice(1); // first image has no incoming transition
    const assigned = mixTransitions(picks, cutNames.length);
    commitDoc((d) => {
      const next = {};
      cutNames.forEach((name, i) => { next[name] = assigned[i]; });
      return { ...d, transitionsByName: next };
    });
  }, [commitDoc]);

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const items = useMemo(
    () => slots.map((s) => ({
      name: s.id, seconds: s.seconds, empty: s.empty,
      label: (s.img && s.img.fileName) || (s.file && s.file.name) || s.id,
    })),
    [slots]
  );
  // Images and videos are uploaded on separate maps (the backend tells them apart
  // by extension anyway, but this keeps the client render spec explicit).
  const imagesByName = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.file && !(s.img && s.img.isVideo)) m[s.id] = s.file;
    return m;
  }, [slots]);
  const videosByName = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.file && s.img && s.img.isVideo) m[s.id] = s.file;
    return m;
  }, [slots]);
  // Video URL + duration per clip, for the trim scrubber in the inspector.
  const videoInfoByName = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.img && s.img.isVideo) {
      m[s.id] = { url: s.img.videoUrl, duration: s.img.videoDuration || 0 };
    }
    return m;
  }, [slots]);
  const imageEls = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.img) m[s.id] = s.img;
    return m;
  }, [slots]);
  const imageCount = useMemo(() => slots.filter((s) => !s.empty && s.img).length, [slots]);

  // Staged thumbnails for the pre-build import tray, ordered by timestamp
  // (files with no parseable timestamp sort last and are flagged).
  const tray = useMemo(
    () => slots
      .filter((s) => !s.empty && s.img)
      .map((s) => ({ id: s.id, url: s.img.url, name: s.img.fileName || (s.file && s.file.name) || "", seconds: s.seconds }))
      .sort((a, b) => (a.seconds == null ? Infinity : a.seconds) - (b.seconds == null ? Infinity : b.seconds)),
    [slots]
  );

  const sample = useMemo(() => {
    const imaged = slots
      .filter((s) => !s.empty && s.img && s.seconds != null)
      .sort((a, b) => a.seconds - b.seconds);
    const el = imaged[0] && imaged[0].img;
    return el ? { width: el.naturalWidth, height: el.naturalHeight } : null;
  }, [slots]);

  const dims = useMemo(() => resolveDimensions(aspect, sample), [aspect, sample]);
  // The resolution actually exported: capped to 720p when the faster option is on,
// upscaled to 4K (UHD) when that's chosen.
  const renderDims = useMemo(
    () => (renderQuality === "720p" ? capTo720(dims) : renderQuality === "4k" ? upTo4K(dims) : dims),
    [renderQuality, dims]
  );

  // On mobile (touch), default to the lighter settings — ~2x faster, far less
  // CPU/RAM load (which also helps avoid Termux connection drops). Runs once.
  useEffect(() => {
    try {
      if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
        setRenderQuality("720p");
        setFps(24);
      }
    } catch { /* ignore */ }
  }, []);
  const { clips, warnings } = useMemo(() => {
    const base = buildTimeline(items, audioDuration);
    const warnings = [...base.warnings];
    const hasCues = Array.isArray(captionCues) && captionCues.length > 0;
    if (syncOn && audioFile && !hasCues) {
      warnings.push("Image↔narration sync needs the timestamped script — upload it in Captions.");
    }
    if (syncOn && audioFile && hasCues && !syncOnsets) {
      warnings.push("Image↔narration sync: analysing the voiceover…");
    }
    if (syncOn && syncOnsets) {
      return { clips: syncClipsToVoiceover(base.clips, syncOnsets), warnings };
    }
    return { clips: base.clips, warnings };
  }, [items, audioDuration, syncOn, syncOnsets, captionCues]);

  // How many images were actually moved by the sync (UI status) — recomputed
  // against the unsynced timeline so the number reflects real changes.
  const syncAligned = useMemo(() => {
    if (!syncOn || !Array.isArray(syncOnsets) || !syncOnsets.length) return 0;
    return alignedClipCount(buildTimeline(items, audioDuration).clips, syncOnsets);
  }, [syncOn, syncOnsets, items, audioDuration]);

  // A new voiceover resets any prior trim to the full length.
  useEffect(() => { setTrimEnd(audioDuration); }, [audioDuration]);

  const exportDuration = trimEnd > 0 ? Math.min(trimEnd, audioDuration) : audioDuration;

  const ready = audioFile && clips.length > 0;
  const showEditor = built && ready;

  // --- Quick tour: auto-open on the first ever visit to the editor, plus a
  // manual "Quick tour" button in the top bar to replay it. The "seen" flag is
  // stored BOTH in localStorage and in the IndexedDB project store (getMeta/
  // setMeta), so the tour can't come back just because localStorage was cleared
  // or the app was closed mid-tour (closing it only marked it seen on dismiss).
  const [tourOpen, setTourOpen] = useState(false);
  const tourAutoRef = useRef(false);
  const markTourSeen = useCallback(() => {
    try { localStorage.setItem("ae.tour.seen", "1"); } catch (_) {}
    setMeta("tour.seen", true);
  }, []);
  const closeTour = useCallback(() => {
    markTourSeen();
    setTourOpen(false);
  }, [markTourSeen]);
  useEffect(() => {
    if (!showEditor || tourAutoRef.current) return;
    tourAutoRef.current = true;
    const show = async () => {
      let seen = false;
      try { seen = !!localStorage.getItem("ae.tour.seen"); } catch (_) {}
      if (!seen) seen = !!(await getMeta("tour.seen"));
      if (seen) return;
      // Mark it seen the moment it opens — even if the app is closed while the
      // tour is up it never auto-fires again (replay stays via the top-bar
      // "Quick tour" button).
      markTourSeen();
      setTourOpen(true);
    };
    show();
  }, [showEditor, markTourSeen]);

  // --- Projects: client-side persistence (IndexedDB) ------------------------
  // On launch, ask for durable storage and load the saved projects list.
  useEffect(() => {
    (async () => {
      try {
        await requestPersist();
        setProjects(await listProjects());
        setStorage(await storageEstimate());
      } catch (_) {}
    })();
  }, []);

  const resetAllState = useCallback(() => {
    // Touch devices default to lighter 720p / 24fps (less CPU/RAM) for new projects.
    let coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (_) {}
    setAudioFile(null); setAudioUrl(null); setAudioDuration(0); setPeaks([]);
    setBgClips((prev) => {
      prev.forEach((c) => { if (c.url) { try { URL.revokeObjectURL(c.url); } catch (_) {} } });
      return [];
    });
    setSelectedBg((prev) => {
      if (prev && prev.url) { try { URL.revokeObjectURL(prev.url); } catch (_) {} }
      return null;
    });
    setBgOpen(null); bgIdRef.current = 1;
    setSfx([]); setSfxUploads([]); setSelectedSound(null); setSfxOpen(null); setSfxMaster(1);
    setVoiceFx(null);
    setOverlayFile(null); setOverlayUrl(null); setOverlayDuration(0);
    setOverlayOpacity(0.3); setOverlayBlendMode("overlay"); setOverlayLoop(true); setOverlayEnabled(false);
    setWatermarkFile(null); setWatermarkUrl(null); setWatermarkEnabled(false);
    setWatermarkSize(0.15); setWatermarkX(0.8); setWatermarkY(0.88); setWatermarkOpacity(0.9);
    setAspect("16:9"); setFps(coarse ? 24 : 30); setRenderQuality(coarse ? "720p" : "full");
    setTransitionDuration(DEFAULT_TRANSITION_DURATION); setFadeIn(0.5); setFadeOut(0.6);
    setMotionByName({}); setMotionAmount(0.08); setTrimByName({}); setVolumeByName({}); setFitByName({});
    setFxByName({}); setFxAmount(0.5);
    setTrimEnd(0);
    setCaptionRaw(null); setCaptionName(null); setCaptionsOn(false); setCaptionStyle("classic");
    setSyncOn(false); setSyncOnsets(null); setSyncStatus({ decoding: false, error: null, detected: 0, total: 0 });
    setCaptionSize("md"); setCaptionLineHeight(null); setCaptionFontScale(null);
    setError(null); setOutUrl(null); setProgress(0);
    idRef.current = 0;
    resetDoc({ slots: [], transitionsByName: {} });
    setBuilt(false);
  }, [resetDoc]);

  const newProject = useCallback(() => {
    resetAllState();
    setCurrentProject({ id: newId(), name: "Untitled project", createdAt: Date.now() });
    setView("editor");
  }, [resetAllState]);

  // A small JPEG thumbnail from the first image, stored with the project.
  const makeThumb = useCallback(() => {
    const s = slots.find((x) => !x.empty && x.img);
    const img = s && s.img;
    if (!img) return null;
    try {
      const iw = img.naturalWidth || img.videoWidth || 320;
      const ih = img.naturalHeight || img.videoHeight || 180;
      const W = 320, H = Math.max(1, Math.round((W * ih) / iw));
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      c.getContext("2d").drawImage(img, 0, 0, W, H);
      return c.toDataURL("image/jpeg", 0.7);
    } catch (_) { return (img.url && String(img.url).startsWith("data:")) ? img.url : null; }
  }, [slots]);

  // Serialize the edit state (no media bytes) for the projects store.
  const buildProjectData = useCallback(() => ({
    v: 1,
    settings: { aspect, fps, renderQuality, transitionDuration, fadeIn, fadeOut, motionAmount, fxAmount, trimEnd },
    maps: { motionByName, fxByName, trimByName, volumeByName, fitByName },
    captions: { captionRaw, captionName, captionsOn, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation },
    transitionsByName,
    slots: slots.map((s) => ({
      id: s.id, seconds: s.seconds, empty: !!s.empty,
      fileName: s.file ? s.file.name : (s.img && s.img.fileName) || null,
      isVideo: !!(s.img && s.img.isVideo),
    })),
    audioName: audioFile ? audioFile.name : null,
    bgClips: bgClips.map((c) => ({
      id: c.id, name: c.name, start: c.start, duration: c.duration, volume: c.volume,
      offset: c.offset || 0, sourceDuration: c.sourceDuration || c.duration,
      fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
    })),
    sfx: sfx.map((s) => ({ id: s.id, name: s.name, src: s.src, at: s.at, volume: s.volume })),
    sfxUploads: sfxUploads.map((u) => ({ mediaId: u.mediaId, label: u.label })),
    sfxMaster,
    voiceFx,
    voiceLevel,
    idCounter: idRef.current,
    built,
  }), [aspect, fps, renderQuality, transitionDuration, fadeIn, fadeOut, motionAmount, fxAmount, trimEnd,
      motionByName, fxByName, trimByName, volumeByName, fitByName,
      captionRaw, captionName, captionsOn, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation,
      transitionsByName, slots, audioFile, bgClips, sfx, sfxUploads, sfxMaster, voiceFx, voiceLevel, built]);

  const saveCurrent = useCallback(async () => {
    const proj = currentProject;
    if (!proj || loadingProject) return; // never save a half-loaded project
    try {
      const rec = {
        id: proj.id, name: proj.name, createdAt: proj.createdAt || Date.now(),
        thumb: makeThumb(), durationSec: exportDuration, clipCount: clips.length,
        data: buildProjectData(),
      };
      await saveProject(rec);
      const wanted = new Map();
      if (audioFile) wanted.set("audio", audioFile);
      for (const s of slots) if (!s.empty && s.file) wanted.set(s.id, s.file);
      for (const c of bgClips) if (c.file) wanted.set(c.id, c.file);
      for (const u of sfxUploads) if (u._file) wanted.set(u.mediaId, u._file);
      await syncMedia(proj.id, wanted);
      try { setStorage(await storageEstimate()); } catch (_) {}
    } catch (_) { /* storage full or unavailable — keep editing */ }
  }, [currentProject, loadingProject, makeThumb, exportDuration, clips.length, buildProjectData, audioFile, slots, bgClips, sfxUploads]);
  saveRef.current = saveCurrent;

  // Debounced autosave whenever the composition changes.
  useEffect(() => {
    if (view !== "editor" || !currentProject || loadingProject) return;
    const t = setTimeout(() => { if (saveRef.current) saveRef.current(); }, 1200);
    return () => clearTimeout(t);
  }, [view, currentProject, loadingProject, slots, transitionsByName, aspect, fps, renderQuality, transitionDuration,
      fadeIn, fadeOut, motionByName, motionAmount, trimByName, volumeByName, fitByName, trimEnd,
      captionRaw, captionName, captionsOn, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation,
      audioFile, bgClips, sfx, sfxUploads, sfxMaster, built]);

  const openProject = useCallback(async (id) => {
    const rec = await getProject(id);
    if (!rec) return;
    const d = rec.data || {};
    // Open the editor shell right away with a loader; media loads in the background.
    // (loadingProject guards autosave so this cleared state is never saved back.)
    resetAllState();
    setCurrentProject({ id: rec.id, name: rec.name, createdAt: rec.createdAt });
    setLoadingProject(true);
    setView("editor");
    try {
      // Decode the audio and ALL slot media in parallel — 100+ images loading
      // one-by-one is what made opening slow.
      const audioP = (async () => {
        if (!d.audioName) return null;
        const blob = await getMedia(id, "audio");
        if (!blob) return null;
        const file = new File([blob], d.audioName, { type: blob.type || "audio/mpeg" });
        let dur = 0; try { dur = await getAudioDuration(file); } catch (_) {}
        return { file, dur };
      })();
      const slotsP = mapLimit(d.slots || [], 12, async (sm) => {
        if (sm.empty) return { id: sm.id, seconds: sm.seconds, file: null, img: null, empty: true };
        const blob = await getMedia(id, sm.id);
        if (!blob) return { id: sm.id, seconds: sm.seconds, file: null, img: null, empty: true };
        const file = new File([blob], sm.fileName || sm.id, { type: blob.type || (sm.isVideo ? "video/mp4" : "image/png") });
        const img = sm.isVideo ? await loadVideoEl(file) : await loadImageEl(file);
        return { id: sm.id, seconds: sm.seconds, file, img, empty: false };
      });
      const [audio, newSlots] = await Promise.all([audioP, slotsP]);
      // Commit the loaded project.
      if (audio) {
        setAudioFile(audio.file); setAudioUrl(URL.createObjectURL(audio.file));
        setAudioDuration(audio.dur);
        getWaveformPeaks(audio.file, waveBucketCount(audio.dur)).then(setPeaks).catch(() => {});
      }
      // Background-music clips (migrate any legacy audio layers by flattening their clips).
      const bgMeta = d.bgClips || (d.audioLayers || []).flatMap((al) => al.clips || []);
      const bgLoaded = (await Promise.all(bgMeta.map(async (c) => {
        const blob = await getMedia(id, c.id);
        if (!blob) return null;
        const file = new File([blob], c.name || `${c.id}.mp3`, { type: blob.type || "audio/mpeg" });
        const url = URL.createObjectURL(file);
        let dur = c.sourceDuration || 0; if (!dur) { try { dur = await getAudioDuration(file); } catch (_) {} }
        const peaks = await getWaveformPeaks(file, waveBucketCount(dur)).catch(() => []);
        return {
          id: c.id, name: c.name || "audio", file, url, start: c.start ?? 0,
          sourceDuration: dur, offset: c.offset || 0,
          duration: c.duration || dur, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
          peaks, volume: c.volume ?? 0.8,
        };
      }))).filter(Boolean);
      setBgClips(bgLoaded);
      bgIdRef.current = bgLoaded.reduce((m, c) => Math.max(m, parseInt(String(c.id).replace(/\D/g, ""), 10) || 0), 0) + 1;
      setSelectedBg(null);
      setBgOpen(null);
      // Uploaded sound effects, then the placed markers that reference them.
      const sfxUps = (await Promise.all((d.sfxUploads || []).map(async (u) => {
        const blob = await getMedia(id, u.mediaId);
        if (!blob) return null;
        const file = new File([blob], `${u.label || "sound"}.mp3`, { type: blob.type || "audio/mpeg" });
        return { mediaId: u.mediaId, label: u.label || "sound", url: URL.createObjectURL(file), _file: file };
      }))).filter(Boolean);
      setSfxUploads(sfxUps);
      setSfx(d.sfx || []);
      setSelectedSound(null);
      setSfxOpen(null);
      setSfxMaster(d.sfxMaster ?? 1);
      setVoiceFx(sanitizeVoiceFx(d.voiceFx));
      setVoiceLevel(Math.max(0, Math.min(1, d.voiceLevel == null ? 1 : +d.voiceLevel)));
      resetDoc({ slots: newSlots, transitionsByName: d.transitionsByName || {} });
      const st = d.settings || {};
      setAspect(st.aspect ?? "16:9"); setFps(st.fps ?? 30); setRenderQuality(st.renderQuality ?? "full");
      setTransitionDuration(st.transitionDuration ?? DEFAULT_TRANSITION_DURATION);
      setFadeIn(st.fadeIn ?? 0.5); setFadeOut(st.fadeOut ?? 0.6);
      setMotionAmount(st.motionAmount ?? 0.08); setTrimEnd(st.trimEnd ?? 0);
      setFxAmount(st.fxAmount ?? 0.5);
      const mp = d.maps || {};
      setMotionByName(mp.motionByName || {}); setTrimByName(mp.trimByName || {});
      setVolumeByName(mp.volumeByName || {}); setFitByName(mp.fitByName || {});
      setFxByName(mp.fxByName || {});
      const cp = d.captions || {};
      setCaptionRaw(cp.captionRaw ?? null); setCaptionName(cp.captionName ?? null);
      setCaptionsOn(!!cp.captionsOn); setCaptionStyle(cp.captionStyle ?? "classic");
      setSyncOn(!!cp.captionRaw); setSyncOnsets(null);
      setSyncStatus({ decoding: false, error: null, detected: 0, total: 0 });
      setCaptionSize(cp.captionSize ?? "md"); setCaptionLineHeight(cp.captionLineHeight ?? null);
      setCaptionFontScale(cp.captionFontScale ?? null);
      setCaptionAnimation(cp.captionAnimation ?? "none");
      idRef.current = d.idCounter || newSlots.length;
      setBuilt(!!d.built);
    } finally { setLoadingProject(false); }
  }, [resetDoc, resetAllState]);

  // navigator.storage.estimate() lags behind an IndexedDB delete/write, so re-poll
  // a few times to catch the freed/added space without needing a manual refresh.
  const refreshStorage = useCallback(() => {
    const tick = async () => { try { setStorage(await storageEstimate()); } catch (_) {} };
    tick();
    setTimeout(tick, 500);
    setTimeout(tick, 1500);
    setTimeout(tick, 3000);
  }, []);

  const [savingBack, setSavingBack] = useState(false);
  const backToProjects = useCallback(async () => {
    setSavingBack(true);
    try { if (saveRef.current) await saveRef.current(); } catch (_) {}
    setSavingBack(false);
    setProjects(await listProjects());
    refreshStorage();
    setView("list");
  }, [refreshStorage]);

  const onRenameProject = useCallback(async (id, name) => {
    await renameProject(id, name);
    setCurrentProject((p) => (p && p.id === id ? { ...p, name } : p));
    setProjects(await listProjects());
  }, []);
  const onDeleteProject = useCallback(async (id) => {
    await deleteProject(id);
    setProjects(await listProjects());
    refreshStorage();
  }, [refreshStorage]);
  const renameCurrent = useCallback(async () => {
    if (!currentProject) return;
    const name = await showPrompt("Rename project", {
      title: "Rename project", defaultValue: currentProject.name || "Untitled project", okText: "Rename",
    });
    if (name && name.trim()) onRenameProject(currentProject.id, name.trim());
  }, [currentProject, onRenameProject]);

  const cancelRef = useRef(false);
  const onCancel = useCallback(() => {
    cancelRef.current = true;
    cancelRender();
    setBusy(false);
    setProgress(0);
  }, []);
  const wcCancelRef = useRef(false);
  const onWebCodecsCancel = useCallback(() => { wcCancelRef.current = true; }, []);

  const onRender = useCallback(async () => {
    cancelRef.current = false;
    setBusy(true); setError(null); setOutUrl(null); setProgress(0);
    try {
      const exportClips = trimClips(clips, exportDuration);
      const transitions = exportClips.map((c) => transitionsByName[c.name] || "cut");
      const motions = exportClips.map((c) => motionByName[c.name] || "none");
      const fx = exportClips.map((c) => fxByName[c.name] || "none");
      // Per-clip video params (parallel to exportClips). Images get 0/1/none.
      // Default depends on length: a clip LONGER than its slot trims (1x + in-point,
      // extra cut off); a clip SHORTER slows to fill the slot ("fit"). An explicit
      // fitByName choice overrides the default.
      const modeOf = (c) => {
        const info = videoInfoByName[c.name];
        if (!info) return "fit";
        return fitByName[c.name] || ((info.duration || 0) > (c.duration || 0) ? "trim" : "fit");
      };
      const trims = exportClips.map((c) =>
        (videoInfoByName[c.name] && modeOf(c) === "trim") ? (trimByName[c.name] || 0) : 0);
      const speeds = exportClips.map((c) => {
        const info = videoInfoByName[c.name];
        if (!info) return 1;
        const dur = info.duration || 0, slot = c.duration || 0;
        return (modeOf(c) === "fit" && slot > 0 && dur > 0 && Math.abs(dur - slot) > 0.05) ? +(dur / slot).toFixed(4) : 1;
      });
      const volumes = exportClips.map((c) =>
        Object.prototype.hasOwnProperty.call(videosByName, c.name)
          ? (volumeByName[c.name] == null ? 0.5 : volumeByName[c.name]) : 0);
      const captions = captionsOn && captionCues.length ? captionCues : null;
      const blob = await renderVideo({
        clips: exportClips, imagesByName, videosByName, audioFile,
        width: renderDims.width, height: renderDims.height, fps,
        transitions, transitionDuration, motions, motionAmount, fx, fxAmount, trims, volumes, speeds, fadeIn, fadeOut,
        captions, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation,
        sfx: mixedAudio,
        voiceFx,
        voiceLevel,
        overlayFile, overlayUrl, overlayDuration, overlayOpacity, overlayBlendMode, overlayLoop, overlayEnabled,
        watermarkFile, watermarkUrl, watermarkSize, watermarkX, watermarkY, watermarkOpacity, watermarkEnabled,
        logoFile, logoUrl, logoCorner, logoSize, logoOpacity, logoEnabled,
        textOverlays,
        onProgress: setProgress,
      });
      setOutUrl(URL.createObjectURL(blob));
    } catch (e) {
      if (!cancelRef.current) setError(e.message || String(e));
    } finally {
      if (!cancelRef.current) setBusy(false);
    }
  }, [clips, exportDuration, imagesByName, videosByName, audioFile, renderDims, fps, transitionsByName, transitionDuration,
      motionByName, motionAmount, fxByName, fxAmount, trimByName, volumeByName, fitByName, videoInfoByName, fadeIn, fadeOut,
      captionsOn, captionCues, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation, mixedAudio,
      voiceFx, voiceLevel,
      overlayFile, overlayUrl, overlayDuration, overlayOpacity, overlayBlendMode, overlayLoop, overlayEnabled,
      watermarkFile, watermarkUrl, watermarkSize, watermarkX, watermarkY, watermarkOpacity, watermarkEnabled,
      logoFile, logoUrl, logoCorner, logoSize, logoOpacity, logoEnabled,
      textOverlays]);

  // --- SPIKE: WebCodecs GPU render (video-only, no audio). Proves the pipeline. ---
  const [wcBusy, setWcBusy] = useState(false);
  const [wcProgress, setWcProgress] = useState(0);
  const [wcPhase, setWcPhase] = useState("Rendering");
  const [doneMsg, setDoneMsg] = useState(null);       // transient "render complete" toast
  const doneTimerRef = useRef(0);
  const flashDone = useCallback((msg) => {
    setDoneMsg(msg);
    clearTimeout(doneTimerRef.current);
    doneTimerRef.current = setTimeout(() => setDoneMsg(null), 6000);
  }, []);
  const [wcOk, setWcOk] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(false); // ffmpeg backend reachable?
  const [wcEnabled, setWcEnabled] = useState(true); // WebCodecs on by default (desktop)
  const [wcProfile, setWcProfile] = useState(null); // resolved render profile (mp4)
  const [renderChecked, setRenderChecked] = useState(false); // capability probes done
  useEffect(() => {
    let alive = true;
    (async () => {
      const [wc, srv] = await Promise.all([
        webCodecsCanRender().catch(() => false),
        probeBackend().catch(() => false),
      ]);
      if (!alive) return;
      setWcOk(wc); setServerAvailable(srv); setRenderChecked(true);
    })();
    return () => { alive = false; };
  }, []);
  // No way to export in this browser: no H.264 WebCodecs and no render backend.
  const cantRender = renderChecked && !wcOk && !serverAvailable;
  // Resolve the output profile up front (recomputed when size/fps change) so the
  // Save dialog and filename use the right extension without an await after click.
  useEffect(() => {
    let alive = true;
    if (!wcOk) { setWcProfile(null); return; }
    pickRenderProfile(renderDims.width, renderDims.height, fps, crfTargetBitrate(renderDims.width, renderDims.height, fps))
      .then((p) => { if (alive) setWcProfile(p); }).catch(() => { if (alive) setWcProfile(null); });
    return () => { alive = false; };
  }, [wcOk, renderDims.width, renderDims.height, fps]);
  const onWebCodecsTest = useCallback(async () => {
    wcCancelRef.current = false;
    const logs = []; // diagnostics — shown in the failure dialog
    const profile = wcProfile;
    if (!profile) {
      showAlert("This browser can't encode video. Use Chrome, Edge, or Safari 16.4+.", { title: "Fast render unavailable" });
      return;
    }
    const fileName = `${((currentProject && currentProject.name) || "autoeditor").replace(/[^\w.-]+/g, "_") || "autoeditor"}.mp4`;
    // The renderer muxes into a chunked buffer (no single-ArrayBuffer size limit),
    // so large videos download normally — no save dialog / File System API needed.
    const writable = null;
    setWcBusy(true); setWcProgress(0); setWcPhase("Rendering");
    // Play inaudible audio for the duration so a backgrounded tab keeps rendering
    // at full speed (started here, inside the click gesture, so it's allowed).
    const stopKeepAwake = startKeepAwake();
    try {
      const exportClips = trimClips(clips, exportDuration);
      const transitions = exportClips.map((c) => transitionsByName[c.name] || "cut");
      const motions = exportClips.map((c) => motionByName[c.name] || "none");
      const fx = exportClips.map((c) => fxByName[c.name] || "none");
      // Per-clip video params (parallel to exportClips), same rule as the ffmpeg
      // path: long clip → trim (1x + in-point), short clip → fit (slow to fill).
      const modeOf = (c) => {
        const info = videoInfoByName[c.name];
        if (!info) return "fit";
        return fitByName[c.name] || ((info.duration || 0) > (c.duration || 0) ? "trim" : "fit");
      };
      const trims = exportClips.map((c) =>
        (videoInfoByName[c.name] && modeOf(c) === "trim") ? (trimByName[c.name] || 0) : 0);
      const speeds = exportClips.map((c) => {
        const info = videoInfoByName[c.name];
        if (!info) return 1;
        const dur = info.duration || 0, slot = c.duration || 0;
        return (modeOf(c) === "fit" && slot > 0 && dur > 0 && Math.abs(dur - slot) > 0.05) ? +(dur / slot).toFixed(4) : 1;
      });
      const volumes = exportClips.map((c) =>
        Object.prototype.hasOwnProperty.call(videosByName, c.name)
          ? (volumeByName[c.name] == null ? 0.5 : volumeByName[c.name]) : 0);
      // Request the full 8 Mbps. The renderer decides the effective rate: a streamed
      // (to-disk) output keeps it, while an in-memory output is capped to a memory-safe
      // rate for long videos — it makes that call because only it knows whether streaming
      // actually engaged (see renderWebCodecs).
      const bitrate = crfTargetBitrate(renderDims.width, renderDims.height, fps);
      const blob = await renderWebCodecs(
        {
          clips: exportClips, width: renderDims.width, height: renderDims.height, fps, bitrate, profile,
          transitions, transitionDuration, motions, motionAmount, fx, fxAmount, audioFile,
          videosByName, trims, speeds, volumes,
          cues: captionsOn && captionCues.length ? captionCues : null,
          captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation,
          sfx: mixedAudio,
          voiceFx,
          voiceLevel,
          overlayFile, overlayUrl, overlayDuration, overlayOpacity, overlayBlendMode, overlayLoop, overlayEnabled,
          watermarkFile, watermarkUrl, watermarkSize, watermarkX, watermarkY, watermarkOpacity, watermarkEnabled,
          logoFile, logoUrl, logoCorner, logoSize, logoOpacity, logoEnabled,
        },
        imagesByName,
        (frac, phase) => { setWcProgress(frac); if (phase) setWcPhase(phase); },
        () => wcCancelRef.current,
        logs,
        writable,
      );
      // Audio can be dropped without failing the whole render (e.g. an unsupported
      // codec/rate) — the video still saves. Surface that clearly so a silent, soundless
      // file isn't a surprise.
      const audioIssue = logs.find((l) => /audio failed|produced no audio/i.test(l));
      // If this device's encoder couldn't do the requested 4K/1080p, the profile
      // fell back to a smaller size — tell the user instead of quietly exporting
      // at the wrong resolution.
      const resIssue = (profile && (profile.width < renderDims.width || profile.height < renderDims.height))
        ? ` — ${profile.width}×${profile.height} (this device's encoder limits the size)`
        : "";
      if (blob) { // in-memory result → download; a streamed render is already on disk
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        flashDone(`${audioIssue ? "Downloaded “" + fileName + "” — no audio" : "Downloaded “" + fileName + "”"}${resIssue}`);
      } else { // streamed straight to the file the user chose — no browser download
        flashDone(`${audioIssue ? "Saved “" + fileName + "” — no audio" : "Saved to “" + fileName + "”"}${resIssue}`);
      }
      if (audioIssue) {
        showAlert("Your video was created, but the audio couldn’t be added, so the file has no sound.",
          { title: "Video saved without audio", details: `${audioIssue}\n\nThis usually means an unusual audio format. Try re-exporting the voiceover as a standard 48 kHz WAV or MP3 and render again.` });
      }
    } catch (e) {
      if (writable) { try { await writable.abort(); } catch (_) {} } // discard partial file
      if (!(e && e.cancelled)) {
        const details = [
          `Error: ${e && e.message ? e.message : String(e)}`,
          "",
          "— render log —",
          ...logs,
          "",
          "— environment —",
          `resolution: ${renderDims.width}x${renderDims.height} @ ${fps}fps`,
          `userAgent: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`,
          e && e.stack ? `\nstack:\n${e.stack}` : "",
        ].join("\n");
        // WebKit's (Safari / any iOS browser) video encoder gives up on long encodes
        // with "Encoding task did not complete" (then "not configured"). It's a browser
        // limit — Chromium handles it — so point the user there instead of a generic error.
        const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
        const isIOS = /iPad|iPhone|iPod/.test(ua);
        const isMacSafari = /Macintosh/.test(ua) && / Version\/.*Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg/.test(ua);
        const msg = (e && e.message ? e.message : "").toLowerCase();
        const encoderGaveUp = msg.includes("not configured") || msg.includes("did not complete") || logs.some((l) => /did not complete/i.test(l));
        if (isIOS && encoderGaveUp) {
          // Every browser on iPhone/iPad is WebKit, so "use Chrome on iPhone" wouldn't help.
          showAlert("This video is too long for an iPhone or iPad to finish encoding — every browser on iOS shares the same limit. Please render on a computer (Chrome or Edge) or an Android phone, or export a shorter / lower-resolution video.",
            { title: "Render long videos on a computer", details });
        } else if (isMacSafari && encoderGaveUp) {
          showAlert("Safari couldn’t finish this render — its video encoder gives up on long videos. Please render in Google Chrome or Microsoft Edge on this Mac (or export a shorter / lower-resolution video).",
            { title: "Use Chrome or Edge for long renders", details });
        } else {
          showAlert("The Fast render failed. Copy the details below if you want to report it.",
            { title: "Fast render failed", details });
        }
      }
    } finally {
      stopKeepAwake();
      setWcBusy(false);
      setWcProgress(0);
      setWcPhase("Rendering");
    }
  }, [clips, exportDuration, transitionsByName, motionByName, fxByName, imagesByName, renderDims, fps, transitionDuration, motionAmount, fxAmount, audioFile,
      videosByName, videoInfoByName, fitByName, trimByName, volumeByName, currentProject, flashDone, wcProfile,
      captionsOn, captionCues, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation,
      mixedAudio, voiceFx, voiceLevel,
      overlayFile, overlayUrl, overlayDuration, overlayOpacity, overlayBlendMode, overlayLoop, overlayEnabled,
      watermarkFile, watermarkUrl, watermarkSize, watermarkX, watermarkY, watermarkOpacity, watermarkEnabled,
      logoFile, logoUrl, logoCorner, logoSize, logoOpacity, logoEnabled]);

  // Browser can't export video (no H.264 WebCodecs, no render backend) — block the
  // whole app; there's no point letting them create projects they can't render.
  if (cantRender) {
    return (
      <main className="unsupported">
        <div className="unsupported__card">
          <img className="unsupported__logo" src="/logo.svg" width="52" height="52" alt="" />
          <h1 className="unsupported__h">Open in Chrome, Edge, or Safari</h1>
          <p className="unsupported__p">
            <span className="unsupported__brand">AutoEditor Mod</span> exports video using your
            browser’s built-in video encoder — which this browser doesn’t have.
          </p>
          <p className="unsupported__p">
            Please open this site in <b>Google Chrome</b>, <b>Microsoft Edge</b>, or <b>Safari 16.4+</b>
            {" "}to create and export your videos. (Firefox isn’t supported.)
          </p>
        </div>
      </main>
    );
  }

  if (view === "list") {
    return (
      <>
        <DialogHost />
        <ProjectsHome
          projects={projects}
          onNew={newProject}
          onOpen={openProject}
          onRename={onRenameProject}
          onDelete={onDeleteProject}
          storage={storage}
        />
      </>
    );
  }

  return (
    <>
    <DialogHost />
    <main className="app">
      {doneMsg && (
        <div className="donetoast" role="status" aria-live="polite" onClick={() => setDoneMsg(null)}>
          <span className="donetoast__ok" aria-hidden="true">✓</span>
          <span>Render complete — {doneMsg}</span>
        </div>
      )}
      {savingBack && (
        <div className="importing" role="status" aria-live="polite">
          <span className="importing__spin" aria-hidden="true" />
          Saving project…
        </div>
      )}
      <div className={`projbar${showEditor ? "" : " projbar--onboard"}`}>
        <div className="projbar__id">
          <button className="brand__back" onClick={backToProjects} title="Back to your projects">←</button>
          <button className="brand__proj" onClick={renameCurrent} title="Rename project">
            {currentProject ? (currentProject.name || "Untitled project") : "AutoEditor"}
          </button>
        </div>
        <div className="bar__io">
          <button
            type="button"
            className="tourbtn"
            onClick={() => setTourOpen(true)}
            data-tip="Replay the quick tour"
            aria-label="Quick tour"
          >
            <span className="tourbtn__ic" aria-hidden="true">?</span>
            <span>Quick tour</span>
          </button>
          <Dropzone
            compact accept="audio/*" onFiles={onAudio} icon="♪"
            title="Import voiceover" filled={!!audioFile}
            filledLabel={audioFile ? audioFile.name : ""}
          />
          <Dropzone
            compact multiple accept="image/*,video/*" onFiles={addImages} icon="▦"
            title="Add media" filled={imageCount > 0}
            filledLabel={imageCount ? `${imageCount} clips` : ""}
          />
        </div>
      </div>

      {resume && (
        <div className={`resume${resume.url ? " resume--done" : resume.error ? " resume--bad" : ""}`}>
          {resume.busy && (
            <span className="resume__msg">
              <span className="resume__spin" aria-hidden="true" />
              A render is still running… {Math.round(resume.progress * 100)}%
            </span>
          )}
          {resume.url && (
            <span className="resume__msg">
              Your video finished rendering.
              <a className="resume__dl" href={resume.url} download="autoeditor.mp4">Download</a>
            </span>
          )}
          {resume.error && <span className="resume__msg">Last render failed: {resume.error}</span>}
          {!resume.busy && (
            <button className="resume__x" onClick={() => setResume(null)} aria-label="Dismiss">✕</button>
          )}
        </div>
      )}

      {importing && (
        <div className="importing" role="status" aria-live="polite">
          <span className="importing__spin" aria-hidden="true" />
          Loading media… {importing.done} / {importing.total}
        </div>
      )}
      {importNote && (
        <div className="importing importing--note" role="status" aria-live="polite" onClick={() => setImportNote(null)}>
          {importNote}
        </div>
      )}

      <div className="content">
      {loadingProject ? (
        <div className="projload">
          <span className="projload__spin" aria-hidden="true" />
          <span className="projload__txt">Loading project…</span>
        </div>
      ) : !showEditor ? (
        <section className="onboard">
          <h1 className="onboard__h">Sync your images to a voiceover, automatically.</h1>
          <p className="onboard__p">
            Name each image or video clip with the second it appears — <code>0-03.png</code> or
            <code>0-03.mp4</code> cuts in at 0:03 — then import them with your voiceover. Video clips
            can be trimmed, zoomed, and their sound mixed under the narration. Review everything below,
            then build the timeline. Everything runs on your device. Nothing is uploaded.
          </p>

          <div className="onboard__zones">
            <Dropzone
              accept="audio/*" onFiles={onAudio} icon="♪"
              title="Voiceover audio"
              hint="One MP3 or WAV — sets the total length"
              filled={!!audioFile}
              filledLabel={audioFile ? audioFile.name : ""}
            />
            <Dropzone
              multiple accept="image/*,video/*" onFiles={addImages} icon="▦"
              title={tray.length ? "Add more media" : "Storyboard images & video"}
              hint="Images or video clips, named by timestamp (0-00, 0-06…). Drop files or whole folders — even several at once."
              filled={false}
            />
          </div>

          {tray.length > 0 && (
            <div className="tray">
              <div className="tray__head">
                <span className="tray__count">{tray.length} image{tray.length > 1 ? "s" : ""} imported</span>
                <span className="tray__sub">ordered by timestamp — hover to remove</span>
              </div>
              <div className="tray__grid">
                {tray.map((t) => (
                  <div key={t.id} className={`thumb${t.seconds == null ? " thumb--notime" : ""}`} title={t.name}>
                    <img src={t.url} alt="" />
                    <span className="thumb__time">{t.seconds != null ? fmtTime(t.seconds) : "no time"}</span>
                    <button className="thumb__x" title="Remove this image" onClick={() => discardImage(t.id)}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {imageCount > 0 && warnings.length > 0 && (
            <div className="notes">{warnings.map((w, i) => <div className="note" key={i}>{w}</div>)}</div>
          )}
          {error && <div className="note note--bad">{error}</div>}

          <div className="build-row">
            <button
              className="render build"
              disabled={!audioFile || tray.length === 0 || clips.length === 0}
              onClick={() => setBuilt(true)}
            >
              Build timeline →
            </button>
            <span className="build-hint">
              {tray.length === 0
                ? "Import your storyboard images to begin."
                : !audioFile
                  ? "Add a voiceover to build the timeline."
                  : `${tray.length} image${tray.length > 1 ? "s" : ""} · ready to build`}
            </span>
          </div>
        </section>
      ) : (
        <Editor
          clips={clips} imageEls={imageEls} audioUrl={audioUrl}
          duration={audioDuration} peaks={peaks} dims={dims}
          aspect={aspect} setAspect={setAspect} fps={fps} setFps={setFps}
          renderQuality={renderQuality} setRenderQuality={setRenderQuality} renderDims={renderDims}
          onWebCodecsTest={onWebCodecsTest} onWebCodecsCancel={onWebCodecsCancel}
          wcBusy={wcBusy} wcProgress={wcProgress} wcPhase={wcPhase} wcAvailable={wcOk} serverAvailable={serverAvailable}
          wcEnabled={wcEnabled} setWcEnabled={setWcEnabled}
          onRender={onRender} onCancel={onCancel} busy={busy} progress={progress}
          outUrl={outUrl} error={error} warnings={warnings}
          replaceImage={replaceImage} removeImage={removeImage} fillGap={fillGap}
          resizeBoundary={resizeBoundary}
          transitionsByName={transitionsByName} transitionDuration={transitionDuration}
          setTransition={setTransition} applyTransitionAll={applyTransitionAll}
          applyTransitionMix={applyTransitionMix}
          setTransitionDuration={setTransitionDuration}
          fadeIn={fadeIn} setFadeIn={setFadeIn}
          fadeOut={fadeOut} setFadeOut={setFadeOut}
          motionByName={motionByName} setMotion={setMotion}
          applyMotionAll={applyMotionAll} applyMotionAlternate={applyMotionAlternate} applyMotionMix={applyMotionMix}
          motionAmount={motionAmount} setMotionAmount={setMotionAmount}
          fxByName={fxByName} setFx={setFx} applyFxAll={applyFxAll} applyFxMix={applyFxMix}
          fxAmount={fxAmount} setFxAmount={setFxAmount}
          videoInfoByName={videoInfoByName}
          trimByName={trimByName} setTrim={setTrim}
          volumeByName={volumeByName} setVolume={setVolume}
          fitByName={fitByName} setFit={setFit}
          trimEnd={exportDuration} setTrimEnd={setTrimEnd} exportDuration={exportDuration}
          undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo}
          captionCues={captionCues} captionsOn={captionsOn} setCaptionsOn={setCaptionsOn}
          captionStyle={captionStyle} setCaptionStyle={setCaptionStyle}
          captionAnimation={captionAnimation} setCaptionAnimation={setCaptionAnimation}
          captionSize={captionSize} setCaptionSize={setCaptionSize}
          captionLineHeight={captionLineHeight} setCaptionLineHeight={setCaptionLineHeight}
          captionFontScale={captionFontScale} setCaptionFontScale={setCaptionFontScale}
          captionName={captionName} captionError={captionError} onCaptionFile={onCaptionFile}
          syncOn={syncOn} setSyncOn={setSyncOn}
          syncStatus={syncStatus} syncAligned={syncAligned}
          bgClips={bgClips} selectedBg={selectedBg} uploadBg={uploadBg}
          addBgClip={addBgClip} moveBgClip={moveBgClip} setBgVolume={setBgVolume}
          updateBgClip={updateBgClip}
          removeBgClip={removeBgClip} bgOpen={bgOpen} setBgOpen={setBgOpen}
          sfx={sfx} addSfx={addSfx} moveSfx={moveSfx} setSfxVolume={setSfxVolume}
          removeSfx={removeSfx} uploadSfx={uploadSfx} removeSfxUpload={removeSfxUpload}
          selectedSound={selectedSound} setSelectedSound={setSelectedSound}
          sfxUploads={sfxUploads} sfxOpen={sfxOpen} setSfxOpen={setSfxOpen}
          sfxMaster={sfxMaster} setSfxMaster={setSfxMaster}
          voiceFx={voiceFx} setVoiceFx={setVoiceFx}
          voiceLevel={voiceLevel} setVoiceLevel={setVoiceLevel}
          overlayUrl={overlayUrl} overlayDuration={overlayDuration}
          setOverlayFile={setOverlayFile} setOverlayUrl={setOverlayUrl}
          setOverlayDuration={setOverlayDuration}
          overlayOpacity={overlayOpacity} setOverlayOpacity={setOverlayOpacity}
          overlayBlendMode={overlayBlendMode} setOverlayBlendMode={setOverlayBlendMode}
          overlayLoop={overlayLoop} setOverlayLoop={setOverlayLoop}
          overlayEnabled={overlayEnabled} setOverlayEnabled={setOverlayEnabled}
          onOverlay={onOverlay}
          watermarkUrl={watermarkUrl}
          setWatermarkFile={setWatermarkFile} setWatermarkUrl={setWatermarkUrl}
          watermarkSize={watermarkSize} setWatermarkSize={setWatermarkSize}
          watermarkX={watermarkX} setWatermarkX={setWatermarkX}
          watermarkY={watermarkY} setWatermarkY={setWatermarkY}
          watermarkOpacity={watermarkOpacity} setWatermarkOpacity={setWatermarkOpacity}
          watermarkEnabled={watermarkEnabled} setWatermarkEnabled={setWatermarkEnabled}
          logoUrl={logoUrl}
          setLogoFile={setLogoFile} setLogoUrl={setLogoUrl}
          logoCorner={logoCorner} setLogoCorner={setLogoCorner}
          logoSize={logoSize} setLogoSize={setLogoSize}
          logoOpacity={logoOpacity} setLogoOpacity={setLogoOpacity}
          logoEnabled={logoEnabled} setLogoEnabled={setLogoEnabled}
          onLogo={onLogo}
          textOverlays={textOverlays}
          addTextOverlay={addTextOverlay}
          updateTextOverlay={updateTextOverlay}
          removeTextOverlay={removeTextOverlay}
          replaceTextOverlays={replaceTextOverlays}
          onWatermark={onWatermark}
        />
      )}
      </div>
    </main>
    <QuickTour open={tourOpen} onClose={closeTour} />
    </>
  );
}
