"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Timeline from "./Timeline";
import {
  TRANSITION_LIST, transitionOf,
  MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION,
  MOTION_LIST, motionOf,
} from "../lib/transitions";
import { FX_LIST, fxOf, applyFx, fxSeed } from "../lib/imageEffects";
import {
  CAPTION_STYLE_LIST, CAPTION_SIZES, CAPTION_ANIMATION_LIST,
  captionCueAt, drawCaption, captionFontPx, captionLineHeightDefault, drawWatermark, drawCornerLogo,
} from "../lib/captions";
import { drawTextOverlays } from "../lib/textOverlay";
import { SFX_LIB, previewSfx, stopSfxPreviews } from "../lib/sfx";
import { VOICE_FX, buildVoiceFxNodes, sanitizeVoiceFx } from "../lib/voiceFx";


function tc(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t * 10) % 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${d}`;
}

// Editable version of the current time, e.g. 1:23.5
function toInputTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

// Accept "1:23", "1:23.5", "1:02:03", "83", "83.5" → seconds, or null if unparsable.
function parseTime(str) {
  const s = String(str).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  const hm = s.match(/^(\d+):(\d{1,2})(?:\.(\d))?$/);
  if (hm) return +hm[1] * 60 + +hm[2] + (hm[3] ? +hm[3] / 10 : 0);
  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d))?$/);
  if (hms) return +hms[1] * 3600 + +hms[2] * 60 + +hms[3] + (hms[4] ? +hms[4] / 10 : 0);
  return null;
}

function clock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Saved configuration presets ("Save Config" panel). Kept in localStorage so
// presets survive reloads and carry over between projects on the same machine.
const PRESET_KEY = "autoeditor.save-config-presets.v1";
function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// Downscale + PNG-encode an image URL into a small data URL so a preset can
// carry the logo itself (localStorage is capped, so keep it compact — a logo
// needs to stay crisp, but a 256px PNG is plenty at typical sizes). Returns
// null when the image fails to load or is too big to store.
const WATERMARK_MAX_PX = 256;
const WATERMARK_MAX_CHARS = 400000; // ~300 KB raw before base64
function encodeImageDataUrl(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, WATERMARK_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const data = c.toDataURL("image/png");
        resolve(data.length <= WATERMARK_MAX_CHARS ? data : null);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
// Reverse: turn a stored data URL back into a real File so both the browser and
// server (upload) render paths can use the restored logo. Returns null on failure.
function dataUrlToFile(dataUrl, fallbackName) {
  return fetch(dataUrl)
    .then((r) => r.blob())
    .then((blob) => new File([blob], fallbackName || "preset-logo.png", { type: blob.type || "image/png" }))
    .catch(() => null);
}

// Fade envelope for a BG clip at time t (seconds) within the clip, 0..duration.
function fadeGain(t, clip) {
  const dur = clip.duration || 0;
  const fi = clip.fadeIn || 0, fo = clip.fadeOut || 0;
  let g = 1;
  if (fi > 0 && t < fi) g *= Math.max(0, t / fi);
  if (fo > 0 && t > dur - fo) g *= Math.max(0, (dur - t) / fo);
  return g;
}

// Right-side tool panel, organised as a Clipchamp-style tablist.
const SIDE_TABS = [
  { id: "effects", icon: "✦", label: "Effects" },
  { id: "captions", icon: "©", label: "Captions" },
  { id: "audio", icon: "♪", label: "Audio" },
  { id: "overlay", icon: "▤", label: "Overlay" },
  { id: "export", icon: "⤓", label: "Export" },
];

export default function Editor({
  clips, imageEls, audioUrl, duration, peaks, dims,
  aspect, setAspect, fps, setFps,
  renderQuality = "full", setRenderQuality, renderDims,
  onRender, onCancel, busy, progress, outUrl, error, warnings,
  onWebCodecsTest, onWebCodecsCancel, wcBusy, wcProgress, wcPhase, wcAvailable, serverAvailable, wcEnabled, setWcEnabled,
  replaceImage, removeImage, fillGap, resizeBoundary,
  transitionsByName, transitionDuration, setTransition, applyTransitionAll, applyTransitionMix, setTransitionDuration,
  fadeIn, setFadeIn, fadeOut, setFadeOut,
  motionByName, setMotion, applyMotionAll, applyMotionAlternate, applyMotionMix, motionAmount, setMotionAmount,
  fxByName = {}, setFx, applyFxAll, applyFxMix, fxAmount, setFxAmount,
  videoInfoByName = {}, trimByName = {}, setTrim, volumeByName = {}, setVolume,
  fitByName = {}, setFit,
  trimEnd, setTrimEnd, exportDuration,
  undo, redo, canUndo, canRedo,
  captionCues, captionsOn, setCaptionsOn, captionStyle, setCaptionStyle,
  captionSize, setCaptionSize, captionLineHeight, setCaptionLineHeight,
  captionFontScale, setCaptionFontScale,
  captionAnimation, setCaptionAnimation,
  captionName, captionError, onCaptionFile,
  syncOn, setSyncOn, syncStatus, syncAligned,
  bgClips = [], selectedBg, uploadBg, addBgClip, moveBgClip, setBgVolume, updateBgClip, removeBgClip,
  bgOpen, setBgOpen,
  sfx = [], addSfx, moveSfx, setSfxVolume, removeSfx, uploadSfx, removeSfxUpload,
  selectedSound, setSelectedSound, sfxUploads = [], sfxOpen, setSfxOpen,
  sfxMaster = 1, setSfxMaster,
  voiceFx, setVoiceFx,
  voiceLevel = 1, setVoiceLevel,
  overlayUrl, overlayDuration,
  setOverlayFile, setOverlayUrl, setOverlayDuration,
  overlayOpacity, setOverlayOpacity,
  overlayBlendMode, setOverlayBlendMode,
  overlayLoop, setOverlayLoop,
  overlayEnabled, setOverlayEnabled,
  onOverlay,
  watermarkUrl,
  setWatermarkFile, setWatermarkUrl,
  watermarkSize, setWatermarkSize,
  watermarkX, setWatermarkX,
  watermarkY, setWatermarkY,
  watermarkOpacity, setWatermarkOpacity,
  watermarkEnabled, setWatermarkEnabled,
  onWatermark,
  logoUrl,
  setLogoFile, setLogoUrl,
  logoCorner, setLogoCorner,
  logoSize, setLogoSize,
  logoOpacity, setLogoOpacity,
  logoEnabled, setLogoEnabled,
  onLogo,
  textOverlays = [], addTextOverlay, updateTextOverlay, removeTextOverlay, replaceTextOverlays,
}) {
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const [fsOn, setFsOn] = useState(false);
  const toggleFullscreen = useCallback(() => {
    const el = viewerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen({ navigationUI: "hide" });
  }, []);
  useEffect(() => {
    const onFs = () => setFsOn(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const audioRef = useRef(null);
  // Voice-over effect live preview: the narration <audio> element is routed through
  // an AudioContext chain once the user applies an effect. vfxElSrc is created once
  // per element; the node chain after it is rebuilt on every change.
  const vfxCtxRef = useRef(null);       // AudioContext (lazily created on Apply)
  const vfxElSrcRef = useRef(null);     // MediaElementAudioSourceNode
  const vfxChainRef = useRef(null);     // live node chain of the current effect
  const bgAudioRefs = useRef(new Map()); // bg clip id -> <audio> element (preview playback)
  const overlayVideoRef = useRef(null); // overlay video element for preview
  const watermarkImgRef = useRef(null); // watermark image element for preview
  const fxBufRef = useRef(null); // offscreen canvas for the image-effect filter pass
  const watermarkInputRef = useRef(null);
  const logoImgRef = useRef(null);     // corner-logo image element for preview
  const logoInputRef = useRef(null);
  const rafRef = useRef(0);
  const fileInputRef = useRef(null);
  const capInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const bgInputRef = useRef(null);
  const sfxInputRef = useRef(null);
  const sfxAudioRefs = useRef(new Map()); // marker id -> <audio> element (preview playback)
  const sfxPrevRef = useRef(0);           // playhead time at the previous RAF frame, for crossing detection
  const sfxResolvedRef = useRef([]);      // latest resolved markers (read by the RAF loop)
  const bgClipsRef = useRef([]);          // latest BG clips (read by the RAF loop)
  const overlayInputRef = useRef(null);
  const pending = useRef(null); // gap-fill target name
  const trimEndRef = useRef(exportDuration);
  const vidRefs = useRef({});     // clip name -> offscreen <video> for live preview
  const drawRef = useRef(null);   // latest draw fn (so video 'seeked' can redraw)
  const timeRef = useRef(0);      // latest playhead time
  const modalVideoRef = useRef(null); // the trim scrubber <video> in the inspector
  const timelineScrollRef = useRef(null); // scroll container of the timeline, for skip-to-ends
  useEffect(() => { trimEndRef.current = exportDuration; }, [exportDuration]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds spent in the current render
  const [selectedCut, setSelectedCut] = useState(null); // selected clip name (drives transition)
  const [currentType, setCurrentType] = useState("fade");
  const [currentMotion, setCurrentMotion] = useState("dynamic"); // drives "Apply … to all" in Advanced Motion
  const [currentFx, setCurrentFx] = useState("none"); // drives "Apply … to all" in Image Effects
  const [warn4k, setWarn4k] = useState(false); // transient "4K is heavy" toast on quality select
  const warnTimer = useRef(null);
  // Transient toast for apply/clear actions ("Transition applied", "Mix cleared"…).
  const [flash, setFlash] = useState(null);
  const [flashWarn, setFlashWarn] = useState(false);
  const flashTimerRef = useRef(null);
  const flashNote = useCallback((msg, warn = false) => {
    setFlash(msg); setFlashWarn(!!warn);
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 2600);
  }, []);
  useEffect(() => () => {
    clearTimeout(warnTimer.current); clearTimeout(presetMsgTimer.current); clearTimeout(flashTimerRef.current);
  }, []);
  // Sound-effect previews are one-shots — silence any still playing on unmount.
  useEffect(() => () => stopSfxPreviews(), []);

  // Route the narration element through the AudioContext chain matching the applied
  // voice-over effect. Once routed, the element's audio ONLY flows through this
  // graph, so every rebuild ends at ctx.destination (an empty node list = passthrough).
  const applyLiveVoiceFx = useCallback(async (fx) => {
    const a = audioRef.current;
    const CtxCls = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!a || !CtxCls) return;
    let ctx = vfxCtxRef.current;
    if (!ctx) { ctx = new CtxCls(); vfxCtxRef.current = ctx; }
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch (_) {} }
    if (!vfxElSrcRef.current) {
      try { vfxElSrcRef.current = ctx.createMediaElementSource(a); }
      catch (_) { return; } // already routed by something else — leave the preview alone
    }
    // Swap the chain after the (permanent) element source.
    if (vfxChainRef.current) { try { vfxChainRef.current.disconnect(); } catch (_) {} vfxChainRef.current = null; }
    const nodes = buildVoiceFxNodes(ctx, fx);
    let prev = vfxElSrcRef.current;
    for (const n of nodes) { prev.connect(n); prev = n; }
    prev.connect(ctx.destination);
    vfxChainRef.current = { disconnect: () => { for (const n of nodes) { try { n.disconnect(); } catch (_) {} } } };
  }, []);

  // Re-sync the live preview whenever the applied effect or the voiceover changes.
  useEffect(() => {
    if (!audioUrl) return;
    if (vfxCtxRef.current || voiceFx) applyLiveVoiceFx(voiceFx).catch(() => {});
  }, [voiceFx, audioUrl, applyLiveVoiceFx]);

  // Voice-over master volume: scale the preview element directly. When the audio
  // is routed through the AudioContext (an effect is applied) the element's own
  // .volume still affects the MediaElementAudioSourceNode, so this works either way.
  useEffect(() => {
    const a = audioRef.current;
    if (a) a.volume = Math.max(0, Math.min(1, voiceLevel));
  }, [voiceLevel, audioUrl]);

  // Tear down the preview graph on unmount.
  useEffect(() => () => {
    if (vfxChainRef.current) { try { vfxChainRef.current.disconnect(); } catch (_) {} vfxChainRef.current = null; }
    if (vfxCtxRef.current) { try { vfxCtxRef.current.close(); } catch (_) {} vfxCtxRef.current = null; }
    vfxElSrcRef.current = null;
  }, []);

  // Voice Over Effect panel draft (effect + strength) — mirror of the applied value.
  const [vfxDraft, setVfxDraft] = useState({ effect: "none", strength: 50 });
  useEffect(() => {
    setVfxDraft({ effect: voiceFx ? voiceFx.effect : "none", strength: voiceFx ? voiceFx.strength : 50 });
  }, [voiceFx]);

  // Save Config panel: saved look presets (export + transitions + motion + fx +
  // fades + overlays + text), persisted in localStorage.
  const sideRef = useRef(null); // the scrolling <aside> — target of "↑ Back to top"
  const [sideTab, setSideTab] = useState("export");
  const presetMsgTimer = useRef(null);
  const [presets, setPresets] = useState(loadPresets);
  const [presetName, setPresetName] = useState("");
  const [presetMsg, setPresetMsg] = useState(null); // transient saved/applied note

  const persistPresets = useCallback((next) => {
    setPresets(next);
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)); } catch { /* storage full/blocked */ }
  }, []);

  const flashPresetMsg = useCallback((msg) => {
    setPresetMsg(msg);
    clearTimeout(presetMsgTimer.current);
    presetMsgTimer.current = setTimeout(() => setPresetMsg(null), 4500);
  }, []);

  // Snapshot the current look into a preset. Video overlay FILES stay session-only
  // blob URLs (too big for localStorage), but both overlay panels — the texture
  // layer and the watermark logo — get their image embedded as a compact PNG, so
  // applying the preset restores them without re-adding.
  const savePreset = useCallback(async () => {
    const name = presetName.trim();
    if (!name) { flashPresetMsg("Give the preset a name first."); return; }
    const config = {
      aspect, fps, renderQuality,
      transitionDuration,
      transitions: transitionsByName,
      motionAmount, motion: motionByName,
      fxAmount, fx: fxByName,
      fadeIn, fadeOut,
      overlayEnabled, overlayOpacity, overlayBlendMode, overlayLoop,
      watermarkEnabled, watermarkSize, watermarkX, watermarkY, watermarkOpacity,
      logoEnabled, logoCorner, logoSize, logoOpacity,
      voiceFx,
      textOverlays: (Array.isArray(textOverlays) ? textOverlays : []).map((o) => ({
        text: o.text, start: o.start, end: o.end, x: o.x, y: o.y, size: o.size, opacity: o.opacity, color: o.color,
      })),
    };
    if (watermarkEnabled && watermarkUrl) {
      const data = await encodeImageDataUrl(watermarkUrl);
      if (data) config.watermarkData = data;
    }
    if (logoEnabled && logoUrl) {
      const data = await encodeImageDataUrl(logoUrl);
      if (data) config.logoData = data;
    }
    // Overlay textures toothe video-overlay panel can hold an image (a logo/light
    // leak/grain still) — embed that too when it is one. Actual video files fail to
    // decode as an image and are simply left for manual re-adding.
    if (overlayEnabled && overlayUrl) {
      const data = await encodeImageDataUrl(overlayUrl);
      if (data) config.overlayData = data;
    }
    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}`,
      name,
      savedAt: Date.now(),
      config,
    };
    persistPresets([entry, ...presets.filter((p) => p.id !== entry.id)]);
    setPresetName("");
    flashPresetMsg(`Saved preset “${name}”.`);
  }, [presetName, presets, persistPresets, flashPresetMsg, aspect, fps, renderQuality,
      transitionDuration, transitionsByName, motionAmount, motionByName, fxAmount, fxByName,
      fadeIn, fadeOut, overlayEnabled, overlayUrl, overlayOpacity, overlayBlendMode, overlayLoop,
      watermarkEnabled, watermarkUrl, watermarkSize, watermarkX, watermarkY, watermarkOpacity,
      logoEnabled, logoUrl, logoCorner, logoSize, logoOpacity, voiceFx, textOverlays]);

  // Re-apply a saved preset to the current project. Per-clip transitions / motion /
  // effects are matched by clip name, so they only land on clips with the same names.
  const gotLogo = (c, key) => typeof c[key] === "string" && c[key].startsWith("data:image/");
  const gotWatermark = (c) => typeof c.watermarkData === "string" && c.watermarkData.startsWith("data:image/");
  const gotOverlay = (c) => typeof c.overlayData === "string" && c.overlayData.startsWith("data:image/");
  const applyPreset = useCallback(async (p) => {
    const c = (p && p.config) || {};
    if (c.aspect != null && setAspect) setAspect(c.aspect);
    if (c.fps != null && setFps) setFps(c.fps);
    if (c.renderQuality != null && setRenderQuality) setRenderQuality(c.renderQuality);
    if (c.transitionDuration != null && setTransitionDuration) setTransitionDuration(c.transitionDuration);
    for (const [name, type] of Object.entries(c.transitions || {})) setTransition(name, type);
    if (c.motionAmount != null && setMotionAmount) setMotionAmount(c.motionAmount);
    for (const [name, type] of Object.entries(c.motion || {})) setMotion(name, type);
    if (c.fxAmount != null && setFxAmount) setFxAmount(c.fxAmount);
    for (const [name, id] of Object.entries(c.fx || {})) setFx(name, id);
    if (c.fadeIn != null && setFadeIn) setFadeIn(c.fadeIn);
    if (c.fadeOut != null && setFadeOut) setFadeOut(c.fadeOut);
    if (c.overlayEnabled != null && setOverlayEnabled) setOverlayEnabled(!!c.overlayEnabled);
    if (c.overlayOpacity != null && setOverlayOpacity) setOverlayOpacity(c.overlayOpacity);
    if (c.overlayBlendMode != null && setOverlayBlendMode) setOverlayBlendMode(c.overlayBlendMode);
    if (c.overlayLoop != null && setOverlayLoop) setOverlayLoop(!!c.overlayLoop);
    if (c.watermarkEnabled != null && setWatermarkEnabled) setWatermarkEnabled(!!c.watermarkEnabled);
    if (c.watermarkSize != null && setWatermarkSize) setWatermarkSize(c.watermarkSize);
    if (c.watermarkX != null && setWatermarkX) setWatermarkX(c.watermarkX);
    if (c.watermarkY != null && setWatermarkY) setWatermarkY(c.watermarkY);
    if (c.watermarkOpacity != null && setWatermarkOpacity) setWatermarkOpacity(c.watermarkOpacity);
    // Restore the embedded logo itself so the preset brings back the overlay in
    // one click — no re-adding (rebuilt as a File so the server upload works too).
    if (gotWatermark(c) && setWatermarkFile && setWatermarkUrl) {
      const file = await dataUrlToFile(c.watermarkData, "preset-logo.png");
      if (file) {
        setWatermarkFile(file);
        setWatermarkUrl(c.watermarkData);
        setWatermarkEnabled(true);
      }
    }
    if (c.logoEnabled != null && setLogoEnabled) setLogoEnabled(!!c.logoEnabled);
    if (c.logoCorner != null && setLogoCorner) setLogoCorner(c.logoCorner);
    if (c.logoSize != null && setLogoSize) setLogoSize(c.logoSize);
    if (c.logoOpacity != null && setLogoOpacity) setLogoOpacity(c.logoOpacity);
    // Same for the corner-logo overlay when a preset embedded its image.
    if (gotLogo(c, "logoData") && setLogoFile && setLogoUrl) {
      const file = await dataUrlToFile(c.logoData, "preset-corner-logo.png");
      if (file) {
        setLogoFile(file);
        setLogoUrl(c.logoData);
        setLogoEnabled(true);
      }
    }
    // Same for the video-overlay panel when it held an image (logo/texture still).
    if (gotOverlay(c) && setOverlayFile && setOverlayUrl) {
      const file = await dataUrlToFile(c.overlayData, "preset-overlay.png");
      if (file) {
        setOverlayFile(file);
        setOverlayUrl(c.overlayData);
        setOverlayEnabled(true);
      }
    }
    if (c.voiceFx != null && setVoiceFx) setVoiceFx(sanitizeVoiceFx(c.voiceFx));
    if (c.textOverlays && Array.isArray(c.textOverlays) && replaceTextOverlays) {
      replaceTextOverlays(c.textOverlays.map((o, i) => ({
        ...o,
        id: crypto.randomUUID ? crypto.randomUUID() : `to-${Date.now()}-${i}`,
      })));
    }
    const overlayWaiting = (c.overlayEnabled && !gotOverlay(c)) || (c.watermarkEnabled && !gotWatermark(c)) || (c.logoEnabled && !gotLogo(c, "logoData"));
    flashPresetMsg(
      overlayWaiting ? `Applied preset “${p.name}”. Overlay files (if any) need re-adding.` : `Applied preset “${p.name}”.`
    );
  }, [setTransition, setMotion, setFx, setFadeIn, setFadeOut, setOverlayEnabled, setOverlayOpacity,
      setOverlayBlendMode, setOverlayLoop, setOverlayFile, setOverlayUrl,
      setWatermarkEnabled, setWatermarkSize, setWatermarkX,
      setWatermarkY, setWatermarkOpacity, setWatermarkFile, setWatermarkUrl,
      setLogoEnabled, setLogoCorner, setLogoSize, setLogoOpacity, setLogoFile, setLogoUrl,
      replaceTextOverlays, flashPresetMsg]);

  const deletePreset = useCallback((id) => {
    const gone = presets.find((p) => p.id === id);
    persistPresets(presets.filter((p) => p.id !== id));
    if (gone) flashPresetMsg(`Deleted preset “${gone.name}”.`);
  }, [presets, persistPresets, flashPresetMsg]);

  const backToTop = useCallback(() => {
    const sc = sideRef.current;
    if (sc && typeof sc.scrollTo === "function") sc.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Resolve each placed marker's source to a playable URL (library preset or upload).
  const sfxUrlFor = useCallback((src) => {
    if (!src) return null;
    if (src.kind === "lib") return src.file;
    const up = sfxUploads.find((u) => u.mediaId === src.mediaId);
    return up ? up.url : null;
  }, [sfxUploads]);
  const sfxResolved = useMemo(
    () => sfx.map((s) => ({ id: s.id, at: s.at, volume: s.volume, url: sfxUrlFor(s.src) })),
    [sfx, sfxUrlFor]
  );
  useEffect(() => { sfxResolvedRef.current = sfxResolved; }, [sfxResolved]);
  useEffect(() => { bgClipsRef.current = bgClips; }, [bgClips]);

  // One <audio> element per placed marker, reused across frames. Created lazily and
  // volume-scaled by the lane's master gain; removed when its marker disappears.
  useEffect(() => {
    const refs = sfxAudioRefs.current;
    const live = new Set(sfxResolved.map((s) => s.id));
    for (const [id, el] of [...refs]) {
      if (!live.has(id)) { try { el.pause(); el.src = ""; } catch (_) {} refs.delete(id); }
    }
    for (const s of sfxResolved) {
      let el = refs.get(s.id);
      if (el && el.dataset.url !== (s.url || "")) {
        try { el.pause(); el.src = ""; } catch (_) {}
        refs.delete(s.id); el = null;
      }
      if (!el && s.url) {
        el = new Audio(s.url);
        el.preload = "auto";
        el.dataset.url = s.url;
        refs.set(s.id, el);
      }
      if (el) el.volume = Math.max(0, Math.min(1, (s.volume == null ? 0.8 : s.volume) * sfxMaster));
    }
  }, [sfxResolved, sfxMaster]);

  // One <audio> element per BG clip, reused across frames; created lazily and
  // volume-scaled per clip, removed when the clip disappears.
  useEffect(() => {
    const refs = bgAudioRefs.current;
    const live = new Set(bgClips.map((c) => c.id));
    for (const [id, el] of [...refs]) {
      if (!live.has(id)) { try { el.pause(); el.src = ""; } catch (_) {} refs.delete(id); }
    }
    for (const c of bgClips) {
      let el = refs.get(c.id);
      if (el && el.dataset.url !== (c.url || "")) {
        try { el.pause(); el.src = ""; } catch (_) {}
        refs.delete(c.id); el = null;
      }
      if (!el && c.url) {
        el = new Audio(c.url);
        el.preload = "auto";
        el.dataset.url = c.url;
        refs.set(c.id, el);
      }
      if (el) el.volume = Math.max(0, Math.min(1, c.volume == null ? 0.8 : c.volume));
    }
  }, [bgClips]);

  const [inspect, setInspect] = useState(null);   // slot name open in the inspector
  const [dismissedWarn, setDismissedWarn] = useState(() => new Set()); // hidden warning texts
  const [timelineZoom, setTimelineZoom] = useState(1); // 0.5 to 4
  // On touch devices, accept="image/*"/"video/*" makes Android open Google Photos,
  // which renames files and breaks the timestamp. Dropping accept opens the Files
  // picker instead (keeps 0-04.mp4). onPick* still filter by type, so nothing bad
  // gets through. Same trick as Dropzone.
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    try { setCoarse(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch { /* ignore */ }
  }, []);
  const [pendFile, setPendFile] = useState(null);  // chosen replacement, not yet applied
  const [pendUrl, setPendUrl] = useState(null);
  const [mixMode, setMixMode] = useState(false); // Transitions panel in random-mix mode
  const [mixPicks, setMixPicks] = useState(() => new Set()); // ephemeral: chosen transitions for the random mix
  const toggleMix = useCallback((id) => {
    setMixPicks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const [mixMotionMode, setMixMotionMode] = useState(false);
  const [mixMotionPicks, setMixMotionPicks] = useState(() => new Set());
  const toggleMixMotion = useCallback((id) => {
    setMixMotionPicks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const [fxMixMode, setFxMixMode] = useState(false);
  const [fxMixPicks, setFxMixPicks] = useState(() => new Set());
  const toggleFxMix = useCallback((id) => {
    setFxMixPicks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const askAdd = useCallback((name) => {
    pending.current = name;
    if (fileInputRef.current) fileInputRef.current.click();
  }, []);

  const onPickFile = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (file && pending.current && fillGap) fillGap(pending.current, file);
    e.target.value = "";
    pending.current = null;
  }, [fillGap]);

  const onPickBg = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !file.type.startsWith("audio/")) return;
    if (uploadBg) await uploadBg(file);
  }, [uploadBg]);

  // Clip inspector: click a clip → preview → optionally pick a replacement,
  // preview it, then Apply (or Remove the image).
  const clearPend = useCallback(() => {
    setPendUrl((u) => { if (u) URL.revokeObjectURL(u); return null; });
    setPendFile(null);
  }, []);
  const openInspect = useCallback((name) => { clearPend(); setInspect(name); }, [clearPend]);
  const closeInspect = useCallback(() => { clearPend(); setInspect(null); }, [clearPend]);
  const onPickReplacement = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !(file.type.startsWith("image/") || file.type.startsWith("video/"))) return;
    setPendFile(file);
    setPendUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(file); });
  }, []);
  const applyReplacement = useCallback(() => {
    if (inspect && pendFile && replaceImage) replaceImage(inspect, pendFile);
    closeInspect();
  }, [inspect, pendFile, replaceImage, closeInspect]);
  const removeInspected = useCallback(() => {
    if (inspect && removeImage) removeImage(inspect);
    closeInspect();
  }, [inspect, removeImage, closeInspect]);

  useEffect(() => {
    if (!inspect) return;
    const onEsc = (e) => { if (e.key === "Escape") closeInspect(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [inspect, closeInspect]);

  const onPickCaption = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (file && onCaptionFile) onCaptionFile(file);
    e.target.value = "";
  }, [onCaptionFile]);

  // Keep one offscreen <video> per video clip so the preview can draw live frames
  // (not just the poster). Created/torn down as clips come and go.
  useEffect(() => {
    const map = vidRefs.current;
    for (const [name, info] of Object.entries(videoInfoByName)) {
      if (!map[name] && info && info.url) {
        const v = document.createElement("video");
        v.src = info.url; v.muted = true; v.playsInline = true; v.preload = "auto";
        const redraw = () => { if (drawRef.current) drawRef.current(timeRef.current); };
        v.addEventListener("seeked", redraw);
        v.addEventListener("loadeddata", redraw);
        map[name] = v;
      }
    }
    for (const name of Object.keys(map)) {
      if (!videoInfoByName[name]) { try { map[name].pause(); } catch { /* ignore */ } delete map[name]; }
    }
  }, [videoInfoByName]);

  // Where in the source video to show for a clip at playhead t: the trim in-point
  // plus elapsed × speed (fast-forward). Mirrors the render math in page.js.
  const videoParams = useCallback((name, slotDur) => {
    const info = videoInfoByName[name];
    if (!info) return null;
    const dur = info.duration || 0;
    // Default by length: longer-than-slot trims (1x), shorter fills the slot ("fit").
    const mode = fitByName[name] || (dur > slotDur ? "trim" : "fit");
    if (mode === "fit" && slotDur > 0 && dur > 0 && Math.abs(dur - slotDur) > 0.05) return { trimStart: 0, speed: dur / slotDur };
    return { trimStart: trimByName[name] || 0, speed: 1 };
  }, [videoInfoByName, fitByName, trimByName]);

  const draw = useCallback((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    let activeVideo = null; // clip name whose video should be playing this frame

    // Per-clip motion transform at time tt (gaps never animate). Progress is clamped so
    // an outgoing image keeps its end-of-clip transform through the transition.
    const transformAt = (ci, tt) => {
      const c = clips[ci];
      if (!c || c.gap) return { scale: 1, offsetX: 0, offsetY: 0, rotateX: 0, rotateY: 0 };
      const m = (motionByName && motionByName[c.name]) || "none";
      const motion = motionOf(m);
      const lp = Math.min(1, Math.max(0, (tt - c.start) / c.duration));
      const t = motion.getTransform(lp, motionAmount, W, H, ci);
      return {
        scale: t.scale,
        offsetX: t.offsetX || 0,
        offsetY: t.offsetY || 0,
        rotateX: t.rotateX || 0,
        rotateY: t.rotateY || 0,
      };
    };

    // Start/keep a clip's offscreen <video> playing in sync with the playhead and
    // mark it active (so it isn't paused). Returns the element to draw, or null if
    // it isn't a ready-to-draw video. Called both while a clip is showing AND
    // during the transition INTO it, so the video is already warm when revealed.
    const primeVideo = (c, tt, wantDraw) => {
      const vinfo = videoInfoByName[c.name];
      if (!vinfo) return null;
      const v = vidRefs.current[c.name];
      const pr = videoParams(c.name, c.duration);
      if (!v || !pr) return null;
      const srcTime = Math.min(vinfo.duration || 0, Math.max(0, pr.trimStart + (tt - c.start) * pr.speed));
      const clipVol = volumeByName[c.name] == null ? 0.5 : volumeByName[c.name];
      v.volume = Math.min(1, Math.max(0, clipVol));
      v.muted = clipVol <= 0;
      v.playbackRate = Math.min(16, Math.max(0.0625, pr.speed));
      if (v.paused) { try { v.currentTime = srcTime; } catch { /* ignore */ } v.play().catch(() => {}); }
      else if (Math.abs(v.currentTime - srcTime) > 0.6) { try { v.currentTime = srcTime; } catch { /* ignore */ } }
      activeVideo = c.name;
      return (wantDraw && v.readyState >= 2 && !v.seeking) ? v : null;
    };

    let fx = "";
    let fxName = null;
    if (clips.length) {
      let idx = clips.findIndex((c) => t >= c.start && t < c.start + c.duration);
      if (idx === -1) idx = clips.length - 1;
      const clip = clips[idx];
      fx = (fxByName && fxByName[clip.name]) || "none";
      fxName = clip.name;
      const type = idx > 0 ? (transitionsByName[clip.name] || "cut") : "cut";
      const tdur = type === "cut" ? 0 : Math.min(transitionDuration, clip.duration);

      if (idx > 0 && tdur > 0 && t < clip.start + tdur) {
        // Inside a transition: blend the previous image into this one, each at
        // its own current zoom so nothing snaps back to normal size.
        const p = Math.min(1, Math.max(0, (t - clip.start) / tdur));
        const fromT = transformAt(idx - 1, t);
        const toT = transformAt(idx, t);
        transitionOf(type).canvas(
          ctx, imageEls[clips[idx - 1].name] || null, imageEls[clip.name] || null, p, W, H,
          fromT.scale, toT.scale
        );
        ctx.globalAlpha = 1;
        // Warm up the incoming video during the transition so it's already
        // decoding/playing when it takes over — fixes the stall-then-smooth start.
        if (playing) primeVideo(clip, t, false);
      } else {
        // While PLAYING, draw live video frames (kept warm since the transition);
        // paused/scrubbing shows the still poster — seeking a paused, offscreen
        // video flashes black on many (mobile) browsers, so we don't seek it.
        let drawable = imageEls[clip.name];
        if (playing) { const vEl = primeVideo(clip, t, true); if (vEl) drawable = vEl; }
        const dw = (drawable && (drawable.videoWidth || drawable.naturalWidth)) || 0;
        const dh = (drawable && (drawable.videoHeight || drawable.naturalHeight)) || 0;
        if (drawable && dw && dh) {
          const tform = transformAt(idx, t);
          const baseScale = Math.min(W / dw, H / dh);
          const scale = baseScale * tform.scale;
          const w = dw * scale, h = dh * scale;
          // Apply transform: translate to center, rotate, translate back, then draw
          ctx.save();
          ctx.translate(W / 2 + tform.offsetX, H / 2 + tform.offsetY);
          if (tform.rotateX || tform.rotateY) {
            // Simulate 3D rotation with scale transform
            ctx.scale(1 - Math.abs(tform.rotateY), 1 - Math.abs(tform.rotateX));
          }
          ctx.drawImage(drawable, -w / 2, -h / 2, w, h);
          ctx.restore();
        }
      }
    }

    // Image effects: burn the clip's grade + overlays in under the overlay/captions.
    if (fx && fx !== "none" && fxAmount > 0) {
      let buf = fxBufRef.current;
      if (!buf || buf.W !== W || buf.H !== H) {
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        buf = { canvas: c, ctx: c.getContext("2d"), W, H };
        fxBufRef.current = buf;
      }
      applyFx(ctx, buf.ctx, fx, fxAmount, W, H, fxName ? fxSeed(fxName) : 0, Math.floor(t * 24));
    }

    // Only the clip under the playhead plays; pause every other clip's video.
    for (const [nm, v] of Object.entries(vidRefs.current)) {
      if (nm !== activeVideo && !v.paused) { try { v.pause(); } catch { /* ignore */ } }
    }

    // Draw overlay video (old film texture, etc.)
    if (overlayEnabled && overlayVideoRef.current && overlayUrl) {
      const ov = overlayVideoRef.current;
      if (ov.readyState >= 2 && !ov.seeking && ov.videoWidth && ov.videoHeight) {
        ctx.save();
        ctx.globalAlpha = overlayOpacity;
        ctx.globalCompositeOperation = overlayBlendMode;
        const ovW = ov.videoWidth, ovH = ov.videoHeight;
        const scale = Math.max(W / ovW, H / ovH); // cover
        const w = ovW * scale, h = ovH * scale;
        ctx.drawImage(ov, (W - w) / 2, (H - h) / 2, w, h);
        ctx.restore();
      }
    }

    // Captions burn in before the fades, so the fade dims them too.
    if (captionsOn && captionCues && captionCues.length) {
      const cue = captionCueAt(captionCues, t);
      if (cue) drawCaption(ctx, cue.text, W, H, captionStyle, captionFontPx(H, captionSize, captionFontScale), captionLineHeight, captionAnimation, t - cue.start, cue.end - cue.start);
    }

    // Timed text overlays (titles/labels) — same layer as WebCodecs + ffmpeg burn.
    if (Array.isArray(textOverlays) && textOverlays.length) drawTextOverlays(ctx, textOverlays, W, H, t);

    // Scene fades (opening / ending).
    if (fadeIn > 0 && t < fadeIn) {
      ctx.globalAlpha = Math.max(0, 1 - t / fadeIn);
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    }
    const outStart = exportDuration - fadeOut;
    if (fadeOut > 0 && t > outStart) {
      ctx.globalAlpha = Math.min(1, (t - outStart) / fadeOut);
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    }

    // Static image overlay (logo / watermark) on top of everything, like the render.
    const wImg = watermarkImgRef.current;
    if (watermarkEnabled && wImg && watermarkUrl) {
      drawWatermark(ctx, wImg, W, H, { size: watermarkSize, x: watermarkX, y: watermarkY, opacity: watermarkOpacity });
    }
    // Corner logo overlay — the very top-most layer, mirroring the render.
    const lImg = logoImgRef.current;
    if (logoEnabled && lImg && logoUrl) {
      drawCornerLogo(ctx, lImg, W, H, { corner: logoCorner, size: logoSize, opacity: logoOpacity });
    }
  }, [clips, imageEls, transitionsByName, transitionDuration, motionByName, motionAmount, fxByName, fxAmount,
      fadeIn, fadeOut, duration, exportDuration, playing, videoInfoByName, videoParams, volumeByName,
      captionsOn, captionCues, captionStyle, captionSize, captionLineHeight, captionFontScale, captionAnimation,
      overlayEnabled, overlayUrl, overlayOpacity, overlayBlendMode, overlayDuration,
      watermarkEnabled, watermarkUrl, watermarkSize, watermarkX, watermarkY, watermarkOpacity,
      logoEnabled, logoUrl, logoCorner, logoSize, logoOpacity,
      textOverlays]);

  useEffect(() => { drawRef.current = draw; }, [draw]);
  useEffect(() => { timeRef.current = time; }, [time]);
  useEffect(() => { draw(time); }, [time, draw]);
  useEffect(() => { setTime(0); }, [audioUrl]);

  // Elapsed render timer.
  useEffect(() => {
    if (!busy && !wcBusy) { setElapsed(0); return; }
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 250);
    return () => clearInterval(id);
  }, [busy, wcBusy]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const loop = () => {
      if (a.paused) return; // Only run when playing
      const end = trimEndRef.current;
      if (end > 0 && a.currentTime >= end) {
        a.pause();
        a.currentTime = end;
        setTime(end);
        return;
      }
      setTime(a.currentTime);
      // FX-lane sound effects: fire each marker once, the frame the playhead crosses it.
      const mainT = a.currentTime;
      const prevT = sfxPrevRef.current;
      sfxPrevRef.current = mainT;
      for (const s of sfxResolvedRef.current) {
        if (prevT <= s.at && mainT > s.at) {
          const el = sfxAudioRefs.current.get(s.id);
          if (el) { try { el.currentTime = 0; } catch (_) {} el.play().catch(() => {}); }
        }
      }
      // Sync BG clips to the main audio position.
      const mainTime = a.currentTime;
      for (const c of bgClipsRef.current) {
        const el = bgAudioRefs.current.get(c.id);
        if (!el) continue;
        const clipTime = mainTime - c.start;
        if (clipTime >= 0 && clipTime < c.duration) {
          const target = (c.offset || 0) + clipTime;
          if (Math.abs(el.currentTime - target) > 0.1) {
            try { el.currentTime = target; } catch (_) {}
          }
          el.volume = Math.max(0, Math.min(1, (c.volume == null ? 0.8 : c.volume) * fadeGain(clipTime, c)));
          if (el.paused) el.play().catch(() => {});
        } else if (!el.paused) {
          el.pause();
        }
      }
      // Sync overlay video
      if (overlayEnabled && overlayVideoRef.current && overlayUrl) {
        const ov = overlayVideoRef.current;
        const mainTime = a.currentTime;
        let overlayTime = mainTime % (overlayDuration || 1);
        if (Math.abs(ov.currentTime - overlayTime) > 0.1) {
          try { ov.currentTime = overlayTime; } catch (_) {}
        }
        if (ov.paused) ov.play().catch(() => {});
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      setPlaying(true);
      // Keep the voice-over effect preview graph audible (resume on the play gesture).
      if (vfxCtxRef.current && vfxCtxRef.current.state === "suspended") {
        try { vfxCtxRef.current.resume(); } catch (_) {}
      }
      // Start crossing detection from the current position (never retro-fire markers).
      sfxPrevRef.current = a.currentTime;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(loop);
    };
    const onStop = () => {
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
      setTime(a.currentTime);
      for (const el of sfxAudioRefs.current.values()) { if (!el.paused) { try { el.pause(); } catch (_) {} } }
      for (const el of bgAudioRefs.current.values()) { if (!el.paused) { try { el.pause(); } catch (_) {} } }
    };
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onStop);
    a.addEventListener("ended", onStop);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onStop);
      a.removeEventListener("ended", onStop);
      cancelAnimationFrame(rafRef.current);
    };
  }, [audioUrl, overlayEnabled, overlayUrl, overlayDuration, overlayLoop]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      // The narration element is routed through the AudioContext once an effect has
      // been applied, so make sure that context is audible when playback starts.
      if (vfxCtxRef.current && vfxCtxRef.current.state === "suspended") {
        try { vfxCtxRef.current.resume(); } catch (_) {}
      }
      a.play();
    } else a.pause();
  }, []);

  // Coalesce rapid scrub seeks: while a seek is still settling (slow for WAV),
  // remember the latest target and apply it on 'seeked', so the drag's release
  // position always wins instead of being dropped mid-seek.
  const pendingSeekRef = useRef(null);
  const seek = useCallback((t) => {
    const a = audioRef.current;
    if (!a) return;
    const c = Math.min(Math.max(t, 0), duration || t || 0);
    setTime(c);
    // A seek repositions the playhead: silence in-flight effects and rebase the
    // crossing detector so nothing fires for markers we skipped over.
    sfxPrevRef.current = c;
    for (const el of sfxAudioRefs.current.values()) { if (!el.paused) { try { el.pause(); } catch (_) {} } }
    if (a.seeking) pendingSeekRef.current = c;
    else {
      pendingSeekRef.current = null;
      try { a.currentTime = c; } catch (_) {}
      // Reposition BG clips that fall under the new playhead.
      for (const clip of bgClips) {
        const el = bgAudioRefs.current.get(clip.id);
        if (!el) continue;
        const clipTime = c - clip.start;
        if (clipTime >= 0 && clipTime < clip.duration) {
          try { el.currentTime = (clip.offset || 0) + clipTime; } catch (_) {}
        }
      }
    }
  }, [duration, bgClips]);

  const goToStart = useCallback(() => {
    const a = audioRef.current;
    if (a && !a.paused) { try { a.pause(); } catch (_) {} }
    seek(0);
    const el = timelineScrollRef.current;
    if (el) el.scrollTo({ left: 0, behavior: "smooth" });
  }, [seek]);

  const goToEnd = useCallback(() => {
    const a = audioRef.current;
    if (a && !a.paused) { try { a.pause(); } catch (_) {} }
    seek(exportDuration || duration || 0);
    const el = timelineScrollRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [seek, exportDuration, duration]);

  // Editable "time now" box: click to type a target time, Enter/blur to seek.
  const [timeDraft, setTimeDraft] = useState(null);
  const startEditTime = useCallback(() => setTimeDraft(toInputTime(time)), [time]);
  const commitEditTime = useCallback(() => {
    if (timeDraft == null) return;
    const t = parseTime(timeDraft);
    if (t != null && isFinite(t)) seek(t);
    setTimeDraft(null);
  }, [timeDraft, seek]);
  const cancelEditTime = useCallback(() => setTimeDraft(null), []);
  const onTimeDraftKey = useCallback((e) => {
    if (e.key === "Enter") commitEditTime();
    else if (e.key === "Escape") cancelEditTime();
  }, [commitEditTime, cancelEditTime]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onSeeked = () => {
      const p = pendingSeekRef.current;
      if (p != null) { pendingSeekRef.current = null; if (Math.abs(a.currentTime - p) > 0.02) { try { a.currentTime = p; } catch (_) {} } }
    };
    a.addEventListener("seeked", onSeeked);
    return () => a.removeEventListener("seeked", onSeeked);
  }, [audioUrl]);

// Scrubbing a *playing* WAV backward doesn't take — the seek fights live
  // playback and the release position is lost (MP3 settles fast enough to hide
  // this). So pause on grab, let the drag seek freely, then resume from the
  // release point once the pointer is up.
  const scrubResumeRef = useRef(false);
  const onScrubStart = useCallback(() => {
    const a = audioRef.current;
    scrubResumeRef.current = !!(a && !a.paused);
    if (a && !a.paused) { try { a.pause(); } catch (_) {} }
    // Pause BG clips
    for (const el of bgAudioRefs.current.values()) { if (!el.paused) { try { el.pause(); } catch (_) {} } }
    // Silence any in-flight sound effects while scrubbing.
    for (const el of sfxAudioRefs.current.values()) { if (!el.paused) { try { el.pause(); } catch (_) {} } }
  }, []);
  const onScrubEnd = useCallback(() => {
    const a = audioRef.current;
    // Rebase crossing detection at the release position (no retro-fire on resume).
    if (a) sfxPrevRef.current = a.currentTime;
    const wasPlaying = scrubResumeRef.current;
    scrubResumeRef.current = false;
    if (a && wasPlaying) a.play().catch(() => {});
    // Resume BG clips only when playback is actually resuming — a plain click on
    // the scrub strip repositions the playhead and must stay silent.
    if (a && wasPlaying) {
      for (const clip of bgClips) {
        const el = bgAudioRefs.current.get(clip.id);
        if (!el) continue;
        const clipTime = a.currentTime - clip.start;
        if (clipTime >= 0 && clipTime < clip.duration) {
          try { el.currentTime = (clip.offset || 0) + clipTime; el.play().catch(() => {}); } catch (_) {}
        }
      }
    }
  }, [bgClips]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      const meta = e.ctrlKey || e.metaKey || e.altKey;
      if (e.code === "Space") { e.preventDefault(); toggle(); }
      else if (meta) { /* let the browser/undo handles handle it */ }
      else if (e.code === "ArrowRight") { e.preventDefault(); seek(time + (e.shiftKey ? 5 : 1)); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); seek(time - (e.shiftKey ? 5 : 1)); }
      else if (e.key === "Home") { e.preventDefault(); seek(0); }
      else if (e.key === "End") { e.preventDefault(); goToEnd(); }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); setTimelineZoom(Math.min(4, timelineZoom + 0.5)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setTimelineZoom(Math.max(0.5, timelineZoom - 0.5)); }
      else if (e.key === "0") { e.preventDefault(); setTimelineZoom(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, time, goToEnd, toggleFullscreen, timelineZoom, setTimelineZoom]);

  const active = clips.find((c) => time >= c.start && time < c.start + c.duration) || clips[clips.length - 1];
  const badClips = useMemo(
    () => new Set(clips.filter((c) => c.duration <= 0.0001).map((c) => c.name)),
    [clips]
  );
  const imageClips = useMemo(() => clips.filter((c) => !c.gap), [clips]);
  const imageCount = imageClips.length;
  const gapCount = clips.length - imageCount;
  const activeIndex = active && !active.gap ? imageClips.indexOf(active) + 1 : 0;

  const selectClip = useCallback((name) => {
    setSelectedCut(name);
    setCurrentType(transitionsByName[name] || "cut");
    setCurrentMotion(motionByName[name] || "dynamic");
    setCurrentFx(fxByName[name] || "none");
  }, [transitionsByName, motionByName, fxByName]);

  const pickType = useCallback((type) => {
    setCurrentType(type);
    if (selectedCut) setTransition(selectedCut, type);
  }, [selectedCut, setTransition]);

  const pickMotion = useCallback((type) => {
    setCurrentMotion(type);
    if (selectedCut) setMotion(selectedCut, type);
  }, [selectedCut, setMotion]);

  const pickFx = useCallback((id) => {
    setCurrentFx(id);
    if (selectedCut) setFx(selectedCut, id);
  }, [selectedCut, setFx]);

  const selectedClip = selectedCut && clips.find((c) => c.name === selectedCut);
  const selectedIndex = selectedClip ? clips.indexOf(selectedClip) : -1;
  const selectedImageNum = selectedClip && !selectedClip.gap ? imageClips.indexOf(selectedClip) + 1 : 0;

  return (
    <section className="editor">
      <div className="main">
        <div className="viewer" ref={viewerRef}>
          <div className="viewer__frame">
            <canvas ref={canvasRef} width={dims.width} height={dims.height} className="viewer__canvas" />
          </div>

          <div className="transport">
            <div className="transport__end">
              {active && (
                <div className="nowclip">
                  <span className="nowclip__k">now</span>
                  {active.gap ? "empty gap" : `image ${activeIndex} / ${imageCount}`}
                </div>
              )}
            </div>
            <div className="transport__center">
              {timeDraft == null ? (
                <button
                  type="button"
                  className="time__now"
                  onClick={startEditTime}
                  data-tip="Jump to a time — type m:ss, Enter to seek"
                  aria-label={`Current time ${tc(time)}. Click to edit.`}
                >
                  {tc(time)}
                </button>
              ) : (
                <input
                  className="time__now time__now--edit"
                  type="text"
                  inputMode="numeric"
                  value={timeDraft}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setTimeDraft(e.target.value)}
                  onKeyDown={onTimeDraftKey}
                  onBlur={commitEditTime}
                  aria-label="Jump to time"
                />
              )}
              <button
                className="skip" onClick={goToStart}
                data-tip="Go to start" data-kbd="Home" aria-label="Go to start"
              >⏮</button>
              <button
                className="play" onClick={toggle}
                data-tip={playing ? "Pause" : "Play"} data-kbd="Space"
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? "❚❚" : "►"}
              </button>
              <button
                className="skip" onClick={goToEnd}
                data-tip="Go to end" data-kbd="End" aria-label="Go to end"
              >⏭</button>
              <span className="time__total">{tc(exportDuration)}</span>
            </div>
            <div className="transport__end transport__end--right">
              <div className="history">
                <button
                  className="hbtn" onClick={undo} disabled={!canUndo}
                  data-tip="Undo" data-kbd="Ctrl+Z" aria-label="Undo"
                >↺</button>
                <button
                  className="hbtn" onClick={redo} disabled={!canRedo}
                  data-tip="Redo" data-kbd="Ctrl+Shift+Z" aria-label="Redo"
                >↻</button>
              </div>
              <div className="history" style={{ marginLeft: 8 }}>
                <button
                  className="hbtn" onClick={() => setTimelineZoom(Math.max(0.5, timelineZoom - 0.5))}
                  data-tip="Zoom timeline out" data-kbd="-"
                >−</button>
                <span style={{ padding: '0 8px', fontSize: 11, minWidth: 36, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Math.round(timelineZoom * 100)}%</span>
                <button
                  className="hbtn" onClick={() => setTimelineZoom(Math.min(4, timelineZoom + 0.5))}
                  data-tip="Zoom timeline in" data-kbd="+"
                >+</button>
<button
  className="hbtn" onClick={() => setTimelineZoom(1)}
  data-tip="Reset timeline zoom" data-kbd="0"
>🔍</button>
              </div>
              <button
                className="hbtn" onClick={toggleFullscreen}
                data-tip={fsOn ? "Exit fullscreen" : "Fullscreen preview"} data-kbd="F"
                aria-label={fsOn ? "Exit fullscreen" : "Fullscreen preview"}
              >⛶</button>
            </div>
          </div>

          <audio ref={audioRef} src={audioUrl} hidden />
          <video
            ref={overlayVideoRef}
            src={overlayUrl}
            muted
            loop={overlayLoop}
            playsInline
            preload="auto"
            hidden
          />
          <img ref={watermarkImgRef} src={watermarkUrl} alt="" hidden />
          <img ref={logoImgRef} src={logoUrl} alt="" hidden />
        </div>

        {(() => {
          const shown = warnings.filter((w) => !dismissedWarn.has(w));
          if (!shown.length) return null;
          return (
            <div className="notes notes--compact">
              {shown.length > 1 && (
                <button
                  type="button" className="notes__clear"
                  onClick={() => setDismissedWarn(new Set(warnings))}
                >Dismiss all ({shown.length})</button>
              )}
              {shown.map((w) => (
                <div className="note note--dismissable" key={w}>
                  <span>{w}</span>
                  <button
                    type="button" className="note__x" aria-label="Dismiss"
                    onClick={() => setDismissedWarn((prev) => new Set(prev).add(w))}
                  >✕</button>
                </div>
              ))}
            </div>
          );
        })()}

        <Timeline
          clips={clips}
          imageEls={imageEls}
          duration={duration}
          time={time}
          peaks={peaks}
          activeName={active && active.name}
          badClips={badClips}
          transitionsByName={transitionsByName}
          motionByName={motionByName}
          selectedName={selectedCut}
          onSelect={selectClip}
          onSeek={seek}
          onScrubStart={onScrubStart}
          onScrubEnd={onScrubEnd}
          onOpen={openInspect}
          onAdd={askAdd}
          onResizeBoundary={resizeBoundary}
          trimEnd={trimEnd}
          onTrimChange={setTrimEnd}
          bgClips={bgClips}
          onBgAdd={addBgClip}
          onBgMove={moveBgClip}
          onBgTrim={updateBgClip}
          onBgOpen={setBgOpen}
          zoom={timelineZoom}
          scrollRef={timelineScrollRef}
          sfx={sfx}
          onSfxAdd={addSfx}
          onSfxMove={moveSfx}
          onSfxOpen={setSfxOpen}
        />
      </div>

      <aside className="side" ref={sideRef}>
        <div
          className="side__tabs"
          role="tablist"
          aria-label="Editor tools"
        >
          {SIDE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`side-tab-${t.id}`}
              aria-selected={sideTab === t.id}
              aria-controls={`side-panel-${t.id}`}
              className={`side__tab ${sideTab === t.id ? "is-on" : ""}`}
              onClick={() => setSideTab(t.id)}
              data-tip={t.label}
            >
              <span className="side__tab-ic">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div
          className={`side__group${sideTab === "export" ? "" : " is-off"}`}
          id="side-panel-export"
          role="tabpanel"
          aria-labelledby="side-tab-export"
          data-tab="export"
        >
        <div className="panel export">
          <h2 className="panel__h">Export</h2>

          <div className="ctrl-row">
            <label className="ctrl">
              <span className="ctrl__label">Aspect</span>
              <span className="selectwrap">
                <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                  <option value="16:9">16:9 — 1920×1080</option>
                  <option value="9:16">9:16 — 1080×1920</option>
                  <option value="auto">Auto — match</option>
                </select>
              </span>
            </label>
            <label className="ctrl">
              <span className="ctrl__label">FPS</span>
              <span className="selectwrap">
                <select value={fps} onChange={(e) => setFps(+e.target.value)}>
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </span>
            </label>
            <label className="ctrl">
              <span className="ctrl__label">Quality</span>
              <span className="selectwrap">
                <select value={renderQuality} onChange={(e) => {
                  const v = e.target.value;
                  setRenderQuality && setRenderQuality(v);
                  if (v === "4k") {
                    setWarn4k(true);
                    clearTimeout(warnTimer.current);
                    warnTimer.current = setTimeout(() => setWarn4k(false), 6500);
                  }
                }}>
                  <option value="full">Full — {dims.width}×{dims.height}</option>
                  <option value="720p">720p — faster</option>
                  <option value="4k">4K — UHD</option>
                </select>
              </span>
            </label>
          </div>

          <dl className="specs">
            <div className="spec"><dt>Resolution</dt><dd>{(renderDims || dims).width}×{(renderDims || dims).height}{renderQuality === "720p" ? " · faster" : renderQuality === "4k" ? " · UHD" : ""}</dd></div>
            <div className="spec"><dt>Images</dt><dd>{imageCount}</dd></div>
            <div className="spec spec--length">
              <dt>Length</dt>
              <dd>
                {tc(exportDuration)}
                {exportDuration < duration && (
                  <span className="spec__trim">trimmed from {tc(duration)}</span>
                )}
              </dd>
            </div>
          </dl>

          {gapCount > 0 && (
            <div className="note note--gap">
              {gapCount} empty {gapCount === 1 ? "gap" : "gaps"} render black — fill with the <b>+</b>.
            </div>
          )}

          {false && wcAvailable && serverAvailable && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8, opacity: (busy || wcBusy) ? 0.5 : 1 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, opacity: 0.85 }}>
                ⚡ Fast render <span className="cap-meta__name">{wcEnabled ? "· WebCodecs (GPU)" : "· ffmpeg (server)"}</span>
              </span>
              <button
                type="button"
                className={`cap-switch ${wcEnabled ? "is-on" : ""}`}
                onClick={() => setWcEnabled && setWcEnabled((v) => !v)}
                disabled={busy || wcBusy}
                aria-pressed={!!wcEnabled}
                aria-label="Fast GPU render (WebCodecs)"
                title="Render on the GPU via WebCodecs — faster for image-only projects (beta)"
              >
                <span className="cap-switch__box" />
              </button>
            </div>
          )}
          {!(busy || wcBusy) ? (
            (wcAvailable || serverAvailable) ? (
              <button
                className="render"
                onClick={wcAvailable ? onWebCodecsTest : onRender}
              >Render MP4</button>
            ) : (
              <div className="note">Rendering needs Chrome, Edge, or Safari 16.4+ (WebCodecs) in this browser.</div>
            )
          ) : (
            <>
              <button className="render render--busy" disabled>
                {wcBusy ? (wcPhase || "Rendering") : "Rendering"}… {Math.round((wcBusy ? wcProgress : progress) * 100)}%
              </button>
              <div className="progress"><i style={{ width: `${Math.round((wcBusy ? wcProgress : progress) * 100)}%` }} /></div>
              <div className="render-meta">
                <span>{clock(elapsed)} elapsed</span>
                {(wcBusy ? wcProgress : progress) > 0.03 && <span>~{clock(elapsed * (1 - (wcBusy ? wcProgress : progress)) / (wcBusy ? wcProgress : progress))} left</span>}
              </div>
              <button className="cancel" onClick={wcBusy ? onWebCodecsCancel : onCancel}>Cancel</button>
            </>
          )}
          {outUrl && <a className="download" href={outUrl} download="story.mp4">↓ Download MP4</a>}
          {error && <div className="note note--bad">{error}</div>}
        </div>

        <div className="panel save-config">
          <h2 className="panel__h">Save Config</h2>
          <div className="mini-h">Save the current look — export settings, transitions, motion, advanced motion, image effects, scene fades, video/image overlays and text overlays — as a preset, then re-apply it in one click.</div>

          <label className="trdur" style={{ marginTop: 8 }}>
            <span style={{ flexShrink: 0 }}>Preset name</span>
            <input
              type="text"
              value={presetName}
              placeholder="e.g. Cinematic 4K"
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") savePreset(); }}
              aria-label="Preset name"
            />
          </label>
          <button type="button" className="trall" onClick={savePreset} style={{ marginTop: 6 }}>
            Save current config as a preset
          </button>

          <div className="mini-h" style={{ marginTop: 12 }}>Saved presets — click to apply.</div>
          {presets.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {presets.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => applyPreset(p)}
                    title={`Apply “${p.name}”`}
                    style={{
                      flex: 1, minWidth: 0, textAlign: "left", font: "inherit", fontSize: 13,
                      color: "var(--text)", background: "var(--panel-2)", border: "1px solid var(--line)",
                      borderRadius: 9, padding: "7px 10px", cursor: "pointer", display: "flex",
                      alignItems: "center", gap: 8,
                    }}
                  >
                    <span
                      style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >{p.name}</span>
                    <span style={{ fontSize: 10.5, color: "var(--muted)", flexShrink: 0 }}>
                      {p.config && p.config.aspect && p.config.fps ? `${p.config.aspect} · ${p.config.fps}fps` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="mbtn mbtn--danger"
                    onClick={() => deletePreset(p.id)}
                    aria-label={`Delete preset ${p.name}`}
                    title="Delete preset"
                    style={{ flex: "0 0 auto", minWidth: 0, width: 34, padding: "8px 0", lineHeight: 1 }}
                  >✕</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="mini-h" style={{ marginTop: 6 }}>No presets yet — name one above and hit Save.</div>
          )}
          {presetMsg && <div className="note" role="status" style={{ marginTop: 10 }}>{presetMsg}</div>}
        </div>
        </div>

        <div
          className={`side__group${sideTab === "effects" ? "" : " is-off"}`}
          id="side-panel-effects"
          role="tabpanel"
          aria-labelledby="side-tab-effects"
          data-tab="effects"
        >
        <div className="panel transitions">
          <div className="transitions__head">
            <div className="transitions__titlerow">
              <span className="panel__h">Transitions</span>
              <button
                type="button"
                className={`cap-switch ${mixMode ? "is-on" : ""}`}
                onClick={() => setMixMode((v) => !v)}
                aria-pressed={mixMode}
                data-tip="Randomly apply a set of transitions across all cuts"
              >
                <span className="cap-switch__box" />
                Random mix
              </button>
            </div>
            <span className="transitions__target">
              {selectedIndex > 0
                ? `Into image ${selectedImageNum || "—"} · ${tc(selectedClip.start)}`
                : selectedIndex === 0
                  ? "First image — no incoming transition"
                  : "Tap a ◇ cut above to set its transition"}
            </span>
          </div>

          <div className="transitions__chips">
            {TRANSITION_LIST.map((tr) => {
              const on = mixMode ? mixPicks.has(tr.id) : currentType === tr.id;
              return (
                <button
                  key={tr.id}
                  type="button"
                  className={`trchip ${on ? "is-on" : ""}`}
                  onClick={() => (mixMode ? toggleMix(tr.id) : pickType(tr.id))}
                >
                  <span className="trchip__icon">{tr.icon}</span>{tr.label}
                </button>
              );
            })}
          </div>

          <label className="trdur">
            <span>Duration</span>
            <input
              type="range" min={MIN_TRANSITION_DURATION} max={MAX_TRANSITION_DURATION} step={0.05}
              value={transitionDuration}
              onChange={(e) => setTransitionDuration(+e.target.value)}
            />
            <span className="trdur__val">{transitionDuration.toFixed(2)}s</span>
          </label>

          {!mixMode ? (
            <button
              type="button" className="trall"
              onClick={() => {
                applyTransitionAll(currentType, clips.map((c) => c.name));
                flashNote(`Transition “${transitionOf(currentType).label}” applied to all cuts`);
              }}
            >
              Apply “{transitionOf(currentType).label}” to all cuts
            </button>
          ) : (
            <div className="trmix-foot">
              <span className="trmix-count">
                {mixPicks.size ? `Picked ${mixPicks.size}` : "All transitions"}
              </span>
              <span className="trmix-btns">
                <button
                  type="button" className="trall trmix-apply"
                  onClick={() => {
                    applyTransitionMix(
                      mixPicks.size ? [...mixPicks] : TRANSITION_LIST.filter((t) => t.id !== "cut").map((t) => t.id),
                      clips.map((c) => c.name),
                    );
                    flashNote("Random transition mix applied");
                  }}
                >
                  Apply random mix to video
                </button>
                <button
                  type="button" className="mbtn mbtn--danger trmix-clear"
                  onClick={() => {
                    setMixPicks(new Set());
                    applyTransitionAll("cut", clips.map((c) => c.name));
                    flashNote("All cuts reset to plain cut", true);
                  }}
                  title="Clear the applied random mix"
                >
                  Clear
                </button>
              </span>
            </div>
          )}

        </div>

        <div className="panel">
          <h2 className="panel__h">Motion — Ken Burns zoom</h2>
          <div className="mini-h">Click an image on the timeline to set its zoom. Set the depth, or apply to all here.</div>
          <label className="trdur">
            <span>Zoom depth</span>
            <input type="range" min={0.02} max={0.2} step={0.01} value={motionAmount}
              onChange={(e) => setMotionAmount(+e.target.value)} />
            <span className="trdur__val">{Math.round(motionAmount * 100)}%</span>
          </label>
          <div className="seg" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => { applyMotionAll("zoomin", imageClips.map((c) => c.name)); flashNote("Zoom in applied to all images"); }}>Zoom in all</button>
            <button type="button" onClick={() => { applyMotionAll("zoomout", imageClips.map((c) => c.name)); flashNote("Zoom out applied to all images"); }}>Zoom out all</button>
          </div>
          <div className="seg" style={{ marginTop: 6 }}>
            <button type="button" onClick={() => { applyMotionAlternate(imageClips.map((c) => c.name)); flashNote("Alternating zoom applied to all images"); }}>Alternate</button>
            <button type="button" onClick={() => { applyMotionAll("none", imageClips.map((c) => c.name)); flashNote("Motion cleared from all images", true); }}>Clear</button>
          </div>
        </div>

        <div className="panel">
          <div className="transitions__titlerow">
            <h2 className="panel__h">Advanced Motion Effects</h2>
            <button
              type="button"
              className={`cap-switch ${mixMotionMode ? "is-on" : ""}`}
              onClick={() => setMixMotionMode((v) => !v)}
              aria-pressed={mixMotionMode}
              data-tip="Randomly apply a set of motion effects across all images"
            >
              <span className="cap-switch__box" />
              Random mix
            </button>
          </div>
          <div className="mini-h" style={{ marginTop: 6 }}>
            {mixMotionMode
              ? "Pick the effects to mix, then apply them randomly across all images."
              : "Click an effect to pick it (applies to the selected clip), then use “Apply to all”."}
          </div>
          <div className="transitions__chips" style={{ marginTop: 8 }}>
            {MOTION_LIST.map((m) => {
              const on = mixMotionMode ? mixMotionPicks.has(m.id) : currentMotion === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`trchip ${on ? "is-on" : ""}`}
                  onClick={() => (mixMotionMode ? toggleMixMotion(m.id) : pickMotion(m.id))}
                  title={m.label}
                >
                  <span className="trchip__icon">{m.icon}</span>{m.label}
                </button>
              );
            })}
          </div>
          <label className="trdur" style={{ marginTop: 8 }}>
            <span>Intensity</span>
            <input type="range" min={0.02} max={0.3} step={0.01} value={motionAmount}
              onChange={(e) => setMotionAmount(+e.target.value)} />
            <span className="trdur__val">{Math.round(motionAmount * 100)}%</span>
          </label>
          {!mixMotionMode ? (
            <>
              <div className="seg" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => { applyMotionAll(currentMotion, imageClips.map((c) => c.name)); flashNote(`Motion “${motionOf(currentMotion).label}” applied to all images`); }}
                >
                  Apply “{motionOf(currentMotion).label}” to all
                </button>
              </div>
              <div className="seg" style={{ marginTop: 6 }}>
                <button type="button" onClick={() => { applyMotionAll("none", imageClips.map((c) => c.name)); flashNote("Motion cleared from all images", true); }}>Clear all</button>
              </div>
            </>
          ) : (
            <div className="trmix-foot">
              <span className="trmix-count">
                {mixMotionPicks.size ? `Picked ${mixMotionPicks.size}` : "All effects"}
              </span>
              <span className="trmix-btns">
                <button
                  type="button" className="trall trmix-apply"
                  onClick={() => {
                    applyMotionMix(
                      mixMotionPicks.size ? [...mixMotionPicks] : MOTION_LIST.filter((m) => m.id !== "none").map((m) => m.id),
                      imageClips.map((c) => c.name),
                    );
                    flashNote("Random motion mix applied");
                  }}
                >
                  Apply random mix to images
                </button>
                <button
                  type="button" className="mbtn mbtn--danger trmix-clear"
                  onClick={() => {
                    setMixMotionPicks(new Set());
                    applyMotionAll("none", imageClips.map((c) => c.name));
                    flashNote("Motion mix cleared from all images", true);
                  }}
                  title="Clear the applied random mix"
                >
                  Clear
                </button>
              </span>
            </div>
          )}

        </div>

        <div className="panel">
          <div className="transitions__titlerow">
            <h2 className="panel__h">Image Effects</h2>
            <button
              type="button"
              className={`cap-switch ${fxMixMode ? "is-on" : ""}`}
              onClick={() => setFxMixMode((v) => !v)}
              aria-pressed={fxMixMode}
              data-tip="Randomly apply a set of image effects across all images"
            >
              <span className="cap-switch__box" />
              Random mix
            </button>
          </div>
          <div className="mini-h" style={{ marginTop: 6 }}>
            {fxMixMode
              ? "Pick the effects to mix, then apply them randomly across all images."
              : "Click an effect to pick it (applies to the selected clip), then use “Apply to all”."}
          </div>
          <div className="transitions__chips" style={{ marginTop: 8 }}>
            {FX_LIST.map((f) => {
              const on = fxMixMode ? fxMixPicks.has(f.id) : currentFx === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`trchip ${on ? "is-on" : ""}`}
                  onClick={() => (fxMixMode ? toggleFxMix(f.id) : pickFx(f.id))}
                  title={f.label}
                >
                  <span className="trchip__icon">{f.icon}</span>{f.label}
                </button>
              );
            })}
          </div>
          <label className="trdur" style={{ marginTop: 8 }}>
            <span>Intensity</span>
            <input type="range" min={0} max={1} step={0.05} value={fxAmount}
              onChange={(e) => setFxAmount(+e.target.value)} />
            <span className="trdur__val">{Math.round(fxAmount * 100)}%</span>
          </label>
          {!fxMixMode ? (
            <>
              <div className="seg" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => { applyFxAll(currentFx, imageClips.map((c) => c.name)); flashNote(`Effect “${fxOf(currentFx).label}” applied to all images`); }}
                >
                  Apply “{fxOf(currentFx).label}” to all
                </button>
              </div>
              <div className="seg" style={{ marginTop: 6 }}>
                <button type="button" onClick={() => { applyFxAll("none", imageClips.map((c) => c.name)); flashNote("Effects cleared from all images", true); }}>Clear all</button>
              </div>
            </>
          ) : (
            <div className="trmix-foot">
              <span className="trmix-count">
                {fxMixPicks.size ? `Picked ${fxMixPicks.size}` : "All effects"}
              </span>
              <span className="trmix-btns">
                <button
                  type="button" className="trall trmix-apply"
                  onClick={() => {
                    applyFxMix(
                      fxMixPicks.size ? [...fxMixPicks] : FX_LIST.filter((f) => f.id !== "none").map((f) => f.id),
                      imageClips.map((c) => c.name),
                    );
                    flashNote("Random effect mix applied");
                  }}
                >
                  Apply random mix to images
                </button>
                <button
                  type="button" className="mbtn mbtn--danger trmix-clear"
                  onClick={() => {
                    setFxMixPicks(new Set());
                    applyFxAll("none", imageClips.map((c) => c.name));
                    flashNote("Effect mix cleared from all images", true);
                  }}
                  title="Clear the applied random mix"
                >
                  Clear
                </button>
              </span>
            </div>
          )}

        </div>

        <div className="panel">
          <h2 className="panel__h">Scene fades</h2>
          <div className="mini-h">Fade the opening and ending (video &amp; audio).</div>
          <label className="trdur">
            <span>Fade in</span>
            <input type="range" min={0} max={2} step={0.1} value={fadeIn} onChange={(e) => setFadeIn(+e.target.value)} />
            <span className="trdur__val">{fadeIn > 0 ? `${fadeIn.toFixed(1)}s` : "off"}</span>
          </label>
          <label className="trdur">
            <span>Fade out</span>
            <input type="range" min={0} max={2} step={0.1} value={fadeOut} onChange={(e) => setFadeOut(+e.target.value)} />
            <span className="trdur__val">{fadeOut > 0 ? `${fadeOut.toFixed(1)}s` : "off"}</span>
          </label>
        </div>
        </div>

        <div
          className={`side__group${sideTab === "captions" ? "" : " is-off"}`}
          id="side-panel-captions"
          role="tabpanel"
          aria-labelledby="side-tab-captions"
          data-tab="captions"
        >
        <div className="panel captions">
          <h2 className="panel__h">Captions</h2>
          {!(captionCues && captionCues.length) ? (
            <div className="cap-empty">
              <button type="button" className="cap-upload" onClick={() => capInputRef.current && capInputRef.current.click()}>
                <span className="cap-upload__i">⤒</span> Upload timestamped script
              </button>
              <p className="cap-hint">
                An <code>.srt</code>, <code>.vtt</code>, or timestamped <code>.txt</code> — inline
                markers like <code>(0:03)</code>, NoteGPT ranges, or <code>[0:03]</code> lines all
                work. Captions sync to the audio and burn into the MP4. Uploading a script also
                enables <b>Image↔narration sync</b>, which finds each line's real speech onset in
                the voiceover and snaps the matching image onto it — so images stay locked to what
                is actually spoken.
              </p>
              {captionError && <div className="note note--bad">{captionError}</div>}
            </div>
          ) : (
            <>
              <div className="cap-bar">
                <button
                  type="button"
                  className={`cap-switch ${captionsOn ? "is-on" : ""}`}
                  onClick={() => setCaptionsOn(!captionsOn)}
                  aria-pressed={captionsOn}
                >
                  <span className="cap-switch__box" />
                  {captionsOn ? "On" : "Off"}
                </button>
                <span className="cap-meta">
                  <span className="cap-meta__name">{captionName || "captions"}</span>
                  {captionCues.length} lines ·{" "}
                  <button type="button" className="cap-replace" onClick={() => capInputRef.current && capInputRef.current.click()}>replace</button>
                </span>
              </div>

              <div className="cap-bar" style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <button
                  type="button"
                  className={`cap-switch ${syncOn ? "is-on" : ""}`}
                  onClick={() => setSyncOn && setSyncOn((v) => !v)}
                  disabled={!!(syncStatus && syncStatus.decoding)}
                  aria-pressed={!!syncOn}
                  title="Find each line's real speech onset in the voiceover and snap the matching image onto it"
                >
                  <span className="cap-switch__box" />
                  Image↔narration sync
                </button>
                <span className="cap-meta">
                  <span className="cap-meta__name">
                    {syncStatus && syncStatus.decoding
                      ? "analysing voiceover…"
                      : syncOn
                        ? `${syncAligned || 0} image${syncAligned === 1 ? "" : "s"} moved to narration`
                        : "off — images keep filename timestamps"}
                  </span>
                </span>
              </div>
              {syncStatus && syncStatus.error && (
                <div className="note note--bad" style={{ marginTop: 8 }}>{syncStatus.error}</div>
              )}

              <div className="cap-body" aria-disabled={!captionsOn}>
                <div className="mini-h">Style</div>
                <div className="transitions__chips">
                  {CAPTION_STYLE_LIST.map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      className={`trchip ${captionStyle === st.id ? "is-on" : ""}`}
                      onClick={() => setCaptionStyle(st.id)}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                <div className="mini-h" style={{ marginTop: 12 }}>Entrance Animation</div>
                <div className="transitions__chips">
                  {CAPTION_ANIMATION_LIST.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`trchip ${captionAnimation === a.id ? "is-on" : ""}`}
                      onClick={() => setCaptionAnimation(a.id)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>

                <div className="mini-h" style={{ marginTop: 12 }}>Size</div>
                <div className="seg">
                  {[["sm", "Small"], ["md", "Medium"], ["lg", "Large"]].map(([id, lbl]) => (
                    <button
                      key={id}
                      type="button"
                      className={captionFontScale == null && captionSize === id ? "is-on" : ""}
                      onClick={() => { setCaptionSize(id); setCaptionFontScale && setCaptionFontScale(null); }}
                    >{lbl}</button>
                  ))}
                </div>

                <div className="mini-h cap-row" style={{ marginTop: 12 }}>
                  <span>Font size (fine-tune)</span>
                  {captionFontScale != null && (
                    <button type="button" className="cap-replace" onClick={() => setCaptionFontScale && setCaptionFontScale(null)}>
                      Reset
                    </button>
                  )}
                </div>
                <label className="trdur">
                  <input
                    type="range" min={0.03} max={0.10} step={0.002}
                    value={captionFontScale != null ? captionFontScale : (CAPTION_SIZES[captionSize] || CAPTION_SIZES.md)}
                    onChange={(e) => setCaptionFontScale && setCaptionFontScale(+e.target.value)}
                  />
                  <span className="trdur__val">
                    {Math.round((captionFontScale != null ? captionFontScale : (CAPTION_SIZES[captionSize] || CAPTION_SIZES.md)) * 1000) / 10}%
                  </span>
                </label>

                <div className="mini-h cap-row" style={{ marginTop: 12 }}>
                  <span>Line spacing (2-line captions)</span>
                  {captionLineHeight != null && (
                    <button type="button" className="cap-replace" onClick={() => setCaptionLineHeight && setCaptionLineHeight(null)}>
                      Reset
                    </button>
                  )}
                </div>
                <label className="trdur">
                  <input
                    type="range" min={1.0} max={2.2} step={0.05}
                    value={captionLineHeight != null ? captionLineHeight : captionLineHeightDefault(captionStyle)}
                    onChange={(e) => setCaptionLineHeight && setCaptionLineHeight(+e.target.value)}
                  />
                  <span className="trdur__val">
                    {(captionLineHeight != null ? captionLineHeight : captionLineHeightDefault(captionStyle)).toFixed(2)}×
                  </span>
                </label>
              </div>
              {captionError && <div className="note note--bad">{captionError}</div>}
            </>
          )}
        </div>
        </div>

        <div
          className={`side__group${sideTab === "audio" ? "" : " is-off"}`}
          id="side-panel-audio"
          role="tabpanel"
          aria-labelledby="side-tab-audio"
          data-tab="audio"
        >
        <div className="panel sound-effects">
          <h2 className="panel__h">Sound effects</h2>
          <div className="mini-h">
            Select a sound, then click the <b>FX</b> track to place it. Drag a marker
            to move it; click it to set volume or remove.
          </div>
          <div className="mini-h" style={{ marginTop: 12 }}>Master volume</div>
          <label className="trdur" style={{ marginTop: 0 }}>
            <span>Vol</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={sfxMaster}
              onChange={(e) => setSfxMaster && setSfxMaster(+e.target.value)}
            />
            <span className="trdur__val">{Math.round(sfxMaster * 100)}%</span>
          </label>
          <div className="mini-h" style={{ marginTop: 12 }}>Library</div>
          <div className="sfxlist">
            {SFX_LIB.map((s) => {
              const isOn = !!(selectedSound && selectedSound.url === s.file);
              return (
                <div key={s.id} className={`sfxrow${isOn ? " is-on" : ""}`}>
                  <button
                    type="button" className="sfxrow__play" title="Preview"
                    onClick={(e) => { e.stopPropagation(); previewSfx(s.file, 0.9 * sfxMaster); }}
                  >▶</button>
                  <button
                    type="button" className="sfxrow__name"
                    onClick={() => setSelectedSound && setSelectedSound({ name: s.label, url: s.file, src: { kind: "lib", file: s.file } })}
                  >{s.label}</button>
                </div>
              );
            })}
          </div>
          {sfxUploads.length > 0 && (
            <>
              <div className="mini-h" style={{ marginTop: 12 }}>Your uploads</div>
              <div className="sfxlist">
                {sfxUploads.map((u) => {
                  const isOn = !!(selectedSound && selectedSound.url === u.url);
                  return (
                    <div key={u.mediaId} className={`sfxrow${isOn ? " is-on" : ""}`}>
                      <button
                        type="button" className="sfxrow__play" title="Preview"
                        onClick={(e) => { e.stopPropagation(); previewSfx(u.url, 0.9 * sfxMaster); }}
                      >▶</button>
                      <button
                        type="button" className="sfxrow__name"
                        onClick={() => setSelectedSound && setSelectedSound({ name: u.label, url: u.url, src: { kind: "upload", mediaId: u.mediaId } })}
                      >{u.label}</button>
                      <button
                        type="button" className="sfxrow__del" title="Remove upload"
                        onClick={(e) => { e.stopPropagation(); removeSfxUpload && removeSfxUpload(u.mediaId); }}
                      >✕</button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <button
            type="button" className="trall" style={{ marginTop: 12 }}
            onClick={() => sfxInputRef.current && sfxInputRef.current.click()}
          >⤒ Upload .mp3 / .wav</button>
          <input
            ref={sfxInputRef} type="file" accept="audio/*,.mp3,.wav" hidden
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              e.target.value = "";
              if (f && uploadSfx) uploadSfx(f);
            }}
          />
        </div>

        <div className="panel audio-layers">
          <h2 className="panel__h">Background Music</h2>
          <div className="mini-h">Add an audio layer, then click the BG track on the timeline to place it. Drag clips to move, click one to set its volume.</div>
          <input
            type="file" accept="audio/*" hidden
            ref={bgInputRef}
            onChange={onPickBg}
          />
          <button
            type="button"
            className="trall"
            onClick={() => bgInputRef.current && bgInputRef.current.click()}
          >
            + Add Audio Layer
          </button>
          {selectedBg && (
            <div className="bg-ready" title="Click the BG lane on the timeline to place this audio">
              <span className="bg-ready__name">{selectedBg.name}</span>
              <span className="bg-ready__hint">Click the BG track to place</span>
            </div>
          )}
          {bgClips.length > 0 && (
            <div className="bg-list">
              {bgClips.map((clip) => {
                const maxFade = Math.max(0.1, Math.min(3, clip.duration / 2));
                return (
                <div key={clip.id} className="bg-list__item">
                  <div className="bg-list__row">
                    <button
                      type="button"
                      className="bg-list__name"
                      title="Open volume, fades and trim"
                      onClick={() => setBgOpen && setBgOpen(clip.id)}
                    >{clip.name}</button>
                    <span className="bg-list__meta">{clock(clip.start)} · {clip.duration.toFixed(1)}s</span>
                    <button
                      type="button" className="sfxrow__del" title="Remove"
                      onClick={(e) => { e.stopPropagation(); removeBgClip && removeBgClip(clip.id); }}
                    >✕</button>
                  </div>
                  <label className="bg-list__ctl" title="Clip volume">
                    <span>Vol</span>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={clip.volume}
                      onChange={(e) => setBgVolume && setBgVolume(clip.id, +e.target.value)}
                    />
                    <span className="bg-list__val">{Math.round(clip.volume * 100)}%</span>
                  </label>
                  <label className="bg-list__ctl" title="Fade in">
                    <span>In</span>
                    <input
                      type="range" min={0} max={maxFade} step={0.1}
                      value={Math.min(clip.fadeIn || 0, maxFade)}
                      onChange={(e) => updateBgClip && updateBgClip(clip.id, { fadeIn: +e.target.value })}
                    />
                    <span className="bg-list__val">{(clip.fadeIn || 0).toFixed(1)}s</span>
                  </label>
                  <label className="bg-list__ctl" title="Fade out">
                    <span>Out</span>
                    <input
                      type="range" min={0} max={maxFade} step={0.1}
                      value={Math.min(clip.fadeOut || 0, maxFade)}
                      onChange={(e) => updateBgClip && updateBgClip(clip.id, { fadeOut: +e.target.value })}
                    />
                    <span className="bg-list__val">{(clip.fadeOut || 0).toFixed(1)}s</span>
                  </label>
                </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="panel voice-fx">
          <h2 className="panel__h">Voice Over Effect</h2>
          <div className="mini-h">
            Enhance the narration before it is exported — bass, clarity, compression
            or a retro radio effect. The preview plays the effect live once applied.
          </div>
          <div className="mini-h" style={{ marginTop: 12 }}>Effect</div>
          <div className="sfxlist">
            <div className={`sfxrow${vfxDraft.effect === "none" ? " is-on" : ""}`}>
              <button
                type="button" className="sfxrow__name"
                onClick={() => setVfxDraft((d) => ({ ...d, effect: "none" }))}
              >None</button>
            </div>
            {VOICE_FX.map((e) => {
              const isOn = vfxDraft.effect === e.id;
              return (
                <div key={e.id} className={`sfxrow${isOn ? " is-on" : ""}`}>
                  <button
                    type="button" className="sfxrow__name"
                    onClick={() => setVfxDraft((d) => ({ ...d, effect: d.effect === e.id ? "none" : e.id }))}
                  >{e.label}</button>
                </div>
              );
            })}
          </div>
          {vfxDraft.effect !== "none" && (
            <>
              <div className="mini-h" style={{ marginTop: 12 }}>
                {(VOICE_FX.find((e) => e.id === vfxDraft.effect) || {}).desc}
              </div>
              <label className="trdur" style={{ marginTop: 8 }}>
                <span>Strength</span>
                <input
                  type="range" min={0} max={100} step={1}
                  value={vfxDraft.strength}
                  onChange={(e) => setVfxDraft((d) => ({ ...d, strength: +e.target.value }))}
                />
                <span className="trdur__val">{vfxDraft.strength}%</span>
              </label>
            </>
          )}
          <label className="trdur" style={{ marginTop: 8 }} title="Master volume of the voiceover narration">
            <span>Master volume</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={voiceLevel}
              onChange={(e) => setVoiceLevel && setVoiceLevel(+e.target.value)}
            />
            <span className="trdur__val">{Math.round(voiceLevel * 100)}%</span>
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button" className="mbtn mbtn--primary" style={{ flex: 1 }}
              onClick={() => {
                setVoiceFx && setVoiceFx(
                  vfxDraft.effect === "none" ? null : sanitizeVoiceFx(vfxDraft)
                );
                if (vfxDraft.effect === "none") flashNote("Voice effect removed", true);
                else flashNote(`Voice effect “${(VOICE_FX.find((e) => e.id === vfxDraft.effect) || {}).label || vfxDraft.effect}” applied`);
              }}
            >Apply</button>
            <button
              type="button" className="mbtn"
              onClick={() => setVfxDraft({
                effect: voiceFx ? voiceFx.effect : "none",
                strength: voiceFx ? voiceFx.strength : 50,
              })}
            >Cancel</button>
          </div>
        </div>
        </div>

        <div
          className={`side__group${sideTab === "overlay" ? "" : " is-off"}`}
          id="side-panel-overlay"
          role="tabpanel"
          aria-labelledby="side-tab-overlay"
          data-tab="overlay"
        >
        <div className="panel video-overlay">
          <h2 className="panel__h">Video Overlay</h2>
          <div className="mini-h">Add a texture overlay (e.g., old film, light leaks, grain) that plays over the entire video.</div>
          <input
            type="file" accept="video/*" hidden
            ref={overlayInputRef}
            onChange={(e) => onOverlay(e.target.files)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="trall"
              onClick={() => overlayInputRef.current && overlayInputRef.current.click()}
              disabled={overlayEnabled && !overlayUrl}
            >
              {overlayEnabled ? "Replace Overlay" : "+ Add Overlay Video"}
            </button>
            {overlayEnabled && (
              <button
                type="button"
                className="mbtn mbtn--danger"
                onClick={() => {
                  setOverlayEnabled(false);
                  setOverlayFile(null);
                  setOverlayUrl(null);
                  setOverlayDuration(0);
                }}
                style={{ padding: "6px 12px" }}
              >
                Remove
              </button>
            )}
          </div>
          {overlayEnabled && overlayUrl && (
            <div style={{ marginTop: 12 }}>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Opacity</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={overlayOpacity}
                  onChange={(e) => setOverlayOpacity(+e.target.value)}
                />
                <span className="trdur__val" style={{ fontSize: 11 }}>{Math.round(overlayOpacity * 100)}%</span>
              </label>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Blend Mode</span>
                <select
                  value={overlayBlendMode}
                  onChange={(e) => setOverlayBlendMode(e.target.value)}
                  style={{ flex: 1, minWidth: 140, marginLeft: 8, padding: "4px 8px", fontSize: 11 }}
                >
                  <option value="overlay">Overlay</option>
                  <option value="multiply">Multiply</option>
                  <option value="screen">Screen</option>
                  <option value="soft-light">Soft Light</option>
                  <option value="hard-light">Hard Light</option>
                  <option value="difference">Difference</option>
                  <option value="exclusion">Exclusion</option>
                </select>
              </label>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Loop</span>
                <input
                  type="checkbox"
                  checked={overlayLoop}
                  onChange={(e) => setOverlayLoop(e.target.checked)}
                  style={{ marginLeft: 8, width: 16, height: 16, accentColor: "var(--accent)" }}
                />
              </label>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                Duration: {overlayDuration.toFixed(1)}s {overlayLoop ? "(loops)" : "(plays once)"}
              </div>
            </div>
          )}
        </div>

        <div className="panel video-overlay">
          <h2 className="panel__h">Image Overlay</h2>
          <div className="mini-h">Overlay a logo or transparent PNG anywhere on the video — resize it and slide it around freely.</div>
          <input
            type="file" accept="image/*" hidden
            ref={watermarkInputRef}
            onChange={(e) => onWatermark(e.target.files)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="trall"
              onClick={() => watermarkInputRef.current && watermarkInputRef.current.click()}
              disabled={watermarkEnabled && !watermarkUrl}
            >
              {watermarkEnabled ? "Replace Image" : "+ Add Image Overlay"}
            </button>
            {watermarkEnabled && (
              <button
                type="button"
                className="mbtn mbtn--danger"
                onClick={() => {
                  setWatermarkEnabled(false);
                  setWatermarkFile(null);
                  setWatermarkUrl(null);
                }}
                style={{ padding: "6px 12px" }}
              >
                Remove
              </button>
            )}
          </div>
          {watermarkEnabled && watermarkUrl && (
            <div style={{ marginTop: 12 }}>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Size</span>
                <input
                  type="range" min={0.02} max={0.6} step={0.01}
                  value={watermarkSize}
                  onChange={(e) => setWatermarkSize(+e.target.value)}
                />
                <span className="trdur__val" style={{ fontSize: 11 }}>{Math.round(watermarkSize * 100)}%</span>
              </label>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>X position</span>
                <input
                  type="range" min={0} max={1} step={0.005}
                  value={watermarkX}
                  onChange={(e) => setWatermarkX(+e.target.value)}
                />
                <span className="trdur__val" style={{ fontSize: 11 }}>{Math.round(watermarkX * 100)}</span>
              </label>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Y position</span>
                <input
                  type="range" min={0} max={1} step={0.005}
                  value={watermarkY}
                  onChange={(e) => setWatermarkY(+e.target.value)}
                />
                <span className="trdur__val" style={{ fontSize: 11 }}>{Math.round(watermarkY * 100)}</span>
              </label>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Opacity</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={watermarkOpacity}
                  onChange={(e) => setWatermarkOpacity(+e.target.value)}
                />
                <span className="trdur__val" style={{ fontSize: 11 }}>{Math.round(watermarkOpacity * 100)}%</span>
              </label>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                The image stays inside the frame; X/Y position its center.
              </div>
            </div>
          )}

        </div>

        <div className="panel video-overlay">
          <h2 className="panel__h">Logo Overlay</h2>
          <div className="mini-h">Add a logo (e.g., your brand badge) fixed to one of the four corners of the video.</div>
          <input
            type="file" accept="image/*" hidden
            ref={logoInputRef}
            onChange={(e) => onLogo(e.target.files)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="trall"
              onClick={() => logoInputRef.current && logoInputRef.current.click()}
              disabled={logoEnabled && !logoUrl}
            >
              {logoEnabled ? "Replace Logo" : "+ Add Logo"}
            </button>
            {logoEnabled && (
              <button
                type="button"
                className="mbtn mbtn--danger"
                onClick={() => {
                  setLogoEnabled(false);
                  setLogoFile(null);
                  setLogoUrl(null);
                }}
                style={{ padding: "6px 12px" }}
              >
                Remove
              </button>
            )}
          </div>
          {logoEnabled && logoUrl && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                {[
                  ["tl", "Top left"], ["tr", "Top right"], ["bl", "Bottom left"], ["br", "Bottom right"],
                ].map(([val, lab]) => (
                  <button
                    key={val}
                    type="button"
                    className={`trchip ${logoCorner === val ? "is-on" : ""}`}
                    onClick={() => setLogoCorner(val)}
                    style={{ fontSize: 11, padding: "5px 10px" }}
                  >
                    {lab}
                  </button>
                ))}
              </div>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Size</span>
                <input
                  type="range" min={0.02} max={0.4} step={0.01}
                  value={logoSize}
                  onChange={(e) => setLogoSize(+e.target.value)}
                />
                <span className="trdur__val" style={{ fontSize: 11 }}>{Math.round(logoSize * 100)}%</span>
              </label>
              <label className="trdur" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 11 }}>Opacity</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={logoOpacity}
                  onChange={(e) => setLogoOpacity(+e.target.value)}
                />
                <span className="trdur__val" style={{ fontSize: 11 }}>{Math.round(logoOpacity * 100)}%</span>
              </label>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                The logo keeps its aspect ratio and stays inside the frame.
              </div>
            </div>
          )}
        </div>
        {/* --- Text overlays --- */}
        <div className="panel video-overlay">
          <h2 className="panel__h">Text overlays</h2>
          <div className="panel__body">
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
              Timed titles, labels, or call-outs layered over the video.
            </div>
            <button type="button" className="trall" onClick={addTextOverlay}>+ Add text overlay</button>

            {Array.isArray(textOverlays) && textOverlays.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
                {textOverlays.map((o) => (
                  <div key={o.id} className="text-overlay" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10 }}>
                    <div className="trdur" style={{ marginBottom: 6 }}>
                      <span style={{ width: 60 }}>Text</span>
                      <input
                        type="text" value={o.text}
                        placeholder="Overlay text"
                        onChange={(e) => updateTextOverlay(o.id, { text: e.target.value })}
                      />
                      <button type="button" onClick={() => removeTextOverlay(o.id)} aria-label="Remove text overlay"
                        title="Remove"
                        style={{ marginLeft: -4, border: 0, background: "none", cursor: "pointer", fontFamily: "system-ui", fontSize: 14, color: "var(--muted)", lineHeight: 1, padding: 0, alignSelf: "center", flexShrink: 0 }}>⊗</button>
                    </div>

                    <div className="trdur">
                      <span>Start</span>
                      <input type="text" value={o.start}
                        placeholder="Seconds"
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isNaN(v)) updateTextOverlay(o.id, { start: Math.min(Math.max(0, v), o.end) });
                        }} />
                      <b className="trdur__val">s</b>
                    </div>
                    <div className="trdur">
                      <span>End</span>
                      <input type="text" value={o.end}
                        placeholder="Seconds"
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isNaN(v)) updateTextOverlay(o.id, { end: Math.max(v, o.start) });
                        }} />
                      <b className="trdur__val">s</b>
                    </div>
                    <div className="trdur">
                      <span>X</span>
                      <input type="range" min={0} max={1} step={0.01} value={o.x}
                        onChange={(e) => updateTextOverlay(o.id, { x: +e.target.value })} />
                      <b className="trdur__val">{Math.round(o.x * 100)}%</b>
                    </div>
                    <div className="trdur">
                      <span>Y</span>
                      <input type="range" min={0} max={1} step={0.01} value={o.y}
                        onChange={(e) => updateTextOverlay(o.id, { y: +e.target.value })} />
                      <b className="trdur__val">{Math.round(o.y * 100)}%</b>
                    </div>
                    <div className="trdur">
                      <span>Size</span>
                      <input type="range" min={0.005} max={0.25} step={0.005} value={o.size}
                        onChange={(e) => updateTextOverlay(o.id, { size: +e.target.value })} />
                      <b className="trdur__val">{Math.round(o.size * 100)}%</b>
                    </div>
                    <div className="trdur">
                      <span>Opacity</span>
                      <input type="range" min={0} max={1} step={0.05} value={o.opacity}
                        onChange={(e) => updateTextOverlay(o.id, { opacity: +e.target.value })} />
                      <b className="trdur__val">{Math.round(o.opacity * 100)}%</b>
                    </div>
                    <div className="trdur">
                      <span>Color</span>
                      <input type="color" value={o.color}
                        onChange={(e) => updateTextOverlay(o.id, { color: e.target.value })} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                No text overlays yet.
              </div>
            )}
          </div>
        </div>
        </div>

        {(sideTab === "effects" || sideTab === "audio") && (
          <button
            type="button"
            className="trall totop"
            onClick={backToTop}
            style={{ position: "sticky", bottom: 0, zIndex: 5, marginTop: 0, boxShadow: "0 0 0 1px rgba(255,255,255,.03), 0 -6px 12px rgba(0,0,0,.35)", background: "var(--panel-2)" }}
            data-tip="Scroll back to the top of the side panel"
          >
            ↑ Back to top
          </button>
        )}
      </aside>

      <input
        ref={fileInputRef} type="file" accept={coarse ? undefined : "image/*,video/*"} hidden
        onChange={onPickFile}
      />
      <input
        ref={replaceInputRef} type="file" accept={coarse ? undefined : "image/*,video/*"} hidden
        onChange={onPickReplacement}
      />
      <input
        ref={capInputRef} type="file" accept=".srt,.vtt,.txt,text/plain" hidden
        onChange={onPickCaption}
      />

      {inspect && (() => {
        const insClip = clips.find((c) => c.name === inspect);
        const el = imageEls[inspect];
        const num = insClip ? imageClips.indexOf(insClip) + 1 : 0;
        const curUrl = pendUrl || (el && el.url);
        const pendIsVid = !!(pendFile && pendFile.type && pendFile.type.startsWith("video/"));
        const isVid = !!(el && el.isVideo) && !pendUrl;
        const vinfo = videoInfoByName[inspect] || {};
        const vol = volumeByName[inspect] == null ? 0.5 : volumeByName[inspect];
        const inPt = trimByName[inspect] || 0;
        const kind = isVid ? "Video" : "Image";
        const slotDur = (insClip && insClip.duration) || 0;
        const vdur = vinfo.duration || 0;
        const longer = !!(vdur && insClip && vdur > slotDur + 0.05);
        const shorter = !!(vdur && insClip && vdur < slotDur - 0.05);
        const diff = longer || shorter;
        // Default by length: longer clip trims (1x), shorter fills the slot (fit/slow).
        const fitMode = fitByName[inspect] || (longer ? "trim" : "fit");
        const speed = (diff && slotDur > 0) ? (vdur / slotDur) : 1;
        return (
          <div className="modal" role="dialog" aria-modal="true" onClick={closeInspect}>
            <div className="modal__card" onClick={(e) => e.stopPropagation()}>
              <div className="modal__head">
                <span className="modal__title">
                  {num ? `${kind} ${num} of ${imageCount}` : kind}
                  {insClip && <span className="modal__at"> · {tc(insClip.start)}</span>}
                </span>
                <button className="modal__x" onClick={closeInspect} aria-label="Close">✕</button>
              </div>

              <div className="modal__stage">
                {pendUrl ? (
                  // A chosen-but-not-applied replacement: a video needs a <video>,
                  // not an <img> (an <img> with a video URL just shows black).
                  pendIsVid
                    ? <video src={pendUrl} className="modal__stagevid" controls muted playsInline preload="metadata" />
                    : <img src={pendUrl} alt="" />
                ) : isVid && vinfo.url ? (
                  <video
                    ref={modalVideoRef} src={vinfo.url} className="modal__stagevid"
                    controls muted playsInline preload="metadata"
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      try { v.currentTime = inPt; } catch { /* ignore */ }
                      v.playbackRate = (diff && fitMode === "fit") ? Math.min(16, Math.max(0.0625, speed)) : 1;
                    }}
                  />
                ) : (curUrl && <img src={curUrl} alt="" />)}
                {pendUrl && <span className="modal__flag">New — not applied yet</span>}
              </div>
              <div className="modal__file">
                {pendFile ? pendFile.name : (el && el.fileName) || ""}
              </div>

              {insClip && !insClip.gap && (
                <div className="modal__motion">
                  <span className="modal__motion-label">Motion (Ken Burns zoom)</span>
                  <div className="seg">
                    {[["none", "None"], ["zoomin", "Zoom in"], ["zoomout", "Zoom out"]].map(([id, lbl]) => (
                      <button
                        key={id}
                        type="button"
                        className={((motionByName && motionByName[inspect]) || "none") === id ? "is-on" : ""}
                        onClick={() => setMotion && setMotion(inspect, id)}
                      >{lbl}</button>
                    ))}
                  </div>
                </div>
              )}

              {insClip && !insClip.gap && isVid && (
                <div className="modal__vid">
                  {diff && (
                    <div className="modal__fit">
                      <span className="modal__motion-label">
                        {longer ? "Clip is longer than its slot" : "Clip is shorter than its slot"} · {vinfo.duration.toFixed(1)}s clip, {insClip.duration.toFixed(1)}s slot
                      </span>
                      <div className="seg">
                        <button
                          type="button" className={fitMode === "fit" ? "is-on" : ""}
                          onClick={() => setFit && setFit(inspect, "fit")}
                        >Fit to slot</button>
                        <button
                          type="button" className={fitMode === "trim" ? "is-on" : ""}
                          onClick={() => setFit && setFit(inspect, "trim")}
                        >Trim (1×)</button>
                      </div>
                      {fitMode === "fit"
                        ? <span className="modal__hint">{longer
                            ? `Whole clip fast-forwarded at ${speed.toFixed(1)}× to fit the slot.`
                            : `Whole clip slowed to ${speed.toFixed(2)}× to fill the slot.`}</span>
                        : <span className="modal__hint">Plays at 1× — set a start point below;{longer ? " the rest is cut off." : " the last frame then holds to fill the slot."}</span>}
                    </div>
                  )}
                  {(!diff || fitMode === "trim") && (() => {
                    const dur = vinfo.duration || 0;
                    const remain = Math.max(0, dur - inPt);        // footage left from the start point
                    const playLen = Math.min(insClip.duration, remain); // real-time footage shown
                    const holdFor = Math.max(0, insClip.duration - remain); // seconds the last frame holds
                    return (
                      <div className="modal__trim">
                        <span className="modal__motion-label">Trim — drag the handle to set where the clip starts</span>
                        {/* Video-editor style trim bar: the fill shows the part that plays;
                            dragging the handle scrubs the preview above and sets the start. */}
                        <div className="trimbar">
                          <div
                            className="trimbar__fill"
                            style={{ left: `${dur ? (inPt / dur) * 100 : 0}%`, width: `${dur ? (playLen / dur) * 100 : 0}%` }}
                          />
                          <input
                            className="trimbar__range"
                            type="range" min={0} max={Math.max(0.1, dur)} step={0.05}
                            value={Math.min(inPt, Math.max(0.1, dur))}
                            onChange={(e) => {
                              const val = +e.target.value;
                              if (setTrim) setTrim(inspect, val);
                              if (modalVideoRef.current) { try { modalVideoRef.current.currentTime = val; } catch { /* ignore */ } }
                            }}
                          />
                        </div>
                        <span className="modal__hint">
                          Starts at {inPt.toFixed(1)}s of {dur.toFixed(1)}s · plays {playLen.toFixed(1)}s in a {insClip.duration.toFixed(1)}s slot
                        </span>
                        {holdFor > 0.05 && (
                          <span className="modal__hint modal__hint--warn">
                            Only {remain.toFixed(1)}s of footage left — the last frame holds for {holdFor.toFixed(1)}s to fill the slot.
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="modal__vol">
                    <span className="modal__motion-label">Clip audio volume</span>
                    <div className="modal__slider">
                      <input
                        type="range" min={0} max={1} step={0.05} value={vol}
                        onChange={(e) => setVolume && setVolume(inspect, +e.target.value)}
                      />
                      <span className="trdur__val">{Math.round(vol * 100)}%</span>
                    </div>
                    <span className="modal__hint">Plays under the voiceover. 0% = silent.</span>
                  </div>
                </div>
              )}

              {!pendUrl ? (
                <div className="modal__actions">
                  <button className="mbtn mbtn--primary" onClick={() => replaceInputRef.current && replaceInputRef.current.click()}>
                    Replace {isVid ? "video" : "image"}
                  </button>
                  <button className="mbtn mbtn--danger" onClick={removeInspected}>Remove from timeline</button>
                </div>
              ) : (
                <div className="modal__actions">
                  <button className="mbtn mbtn--primary" onClick={applyReplacement}>Apply replacement</button>
                  <button className="mbtn" onClick={() => replaceInputRef.current && replaceInputRef.current.click()}>Choose different</button>
                  <button className="mbtn mbtn--ghost" onClick={clearPend}>Cancel</button>
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {warn4k && (
        <div className="donetoast donetoast--warn" role="status" aria-live="polite" onClick={() => setWarn4k(false)}>
          <span className="donetoast__ok" aria-hidden="true">!</span>
          <span>4K render is heavy (~4× the pixels of 1080p) — expect much longer encodes and higher memory use; iOS/Safari long-render limits still apply</span>
        </div>
      )}
      {(() => {
        if (sfxOpen == null) return null;
        const s = sfx.find((x) => x.id === sfxOpen);
        if (!s) return null;
        return (
          <div className="modal" role="dialog" aria-modal="true" onClick={() => setSfxOpen && setSfxOpen(null)}>
            <div className="modal__card" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal__head">
                <span className="modal__title">
                  {s.name} <span className="modal__at">· {clock(s.at)}</span>
                </span>
                <button className="modal__x" onClick={() => setSfxOpen && setSfxOpen(null)} aria-label="Close">✕</button>
              </div>
              <div className="modal__vol">
                <span className="modal__motion-label">Volume</span>
                <div className="modal__slider">
                  <input
                    type="range" min={0} max={1} step={0.05} value={s.volume}
                    onChange={(e) => setSfxVolume && setSfxVolume(s.id, +e.target.value)}
                  />
                  <span className="trdur__val">{Math.round(s.volume * 100)}%</span>
                </div>
              </div>
              <div className="modal__actions" style={{ marginTop: 14 }}>
                <button
                  className="mbtn mbtn--danger"
                  onClick={() => { removeSfx && removeSfx(s.id); setSfxOpen && setSfxOpen(null); }}
                >Remove</button>
                <button className="mbtn" onClick={() => setSfxOpen && setSfxOpen(null)}>Done</button>
              </div>
            </div>
          </div>
        );
      })()}
      {(() => {
        if (bgOpen == null) return null;
        const c = bgClips.find((x) => x.id === bgOpen);
        if (!c) return null;
        const maxFade = Math.max(0.1, Math.min(3, c.duration / 2));
        return (
          <div className="modal" role="dialog" aria-modal="true" onClick={() => setBgOpen && setBgOpen(null)}>
            <div className="modal__card" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal__head">
                <span className="modal__title">
                  {c.name} <span className="modal__at">· {clock(c.start)}</span>
                </span>
                <button className="modal__x" onClick={() => setBgOpen && setBgOpen(null)} aria-label="Close">✕</button>
              </div>
              <div className="modal__vol">
                <span className="modal__motion-label">Volume</span>
                <div className="modal__slider">
                  <input
                    type="range" min={0} max={1} step={0.05} value={c.volume}
                    onChange={(e) => setBgVolume && setBgVolume(c.id, +e.target.value)}
                  />
                  <span className="trdur__val">{Math.round(c.volume * 100)}%</span>
                </div>
              </div>
              <div className="modal__vol">
                <span className="modal__motion-label">Fade in</span>
                <div className="modal__slider">
                  <input
                    type="range" min={0} max={maxFade} step={0.1} value={Math.min(c.fadeIn || 0, maxFade)}
                    onChange={(e) => updateBgClip && updateBgClip(c.id, { fadeIn: +e.target.value })}
                  />
                  <span className="trdur__val">{(c.fadeIn || 0).toFixed(1)}s</span>
                </div>
              </div>
              <div className="modal__vol">
                <span className="modal__motion-label">Fade out</span>
                <div className="modal__slider">
                  <input
                    type="range" min={0} max={maxFade} step={0.1} value={Math.min(c.fadeOut || 0, maxFade)}
                    onChange={(e) => updateBgClip && updateBgClip(c.id, { fadeOut: +e.target.value })}
                  />
                  <span className="trdur__val">{(c.fadeOut || 0).toFixed(1)}s</span>
                </div>
              </div>
              <div className="modal__actions" style={{ marginTop: 14 }}>
                <button
                  className="mbtn mbtn--danger"
                  onClick={() => { removeBgClip && removeBgClip(c.id); }}
                >Remove</button>
                <button className="mbtn" onClick={() => setBgOpen && setBgOpen(null)}>Done</button>
              </div>
            </div>
          </div>
        );
      })()}

      {flash && (
        <div
          className={`flashtoast${flashWarn ? " flashtoast--warn" : ""}`}
          role="status" aria-live="polite" onClick={() => setFlash(null)}
        >
          <span className="flashtoast__ok" aria-hidden="true">✓</span>
          <span>{flash}</span>
        </div>
      )}
    </section>
  );
}
