// Native ffmpeg render — a faithful port of the frontend's lib/ffmpegRender.js.
// The filter strings are identical; only the FS/process handling differs.
import { spawn, execFile } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";
import { xfadeName, MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION } from "./transitions.js";
import { buildCaptionBurn, buildTextOverlayBurn, CAPTION_FONT } from "./captions.js";
import { voiceFxFilterString } from "../lib/voiceFx.js";

// Crash-safe module dir: import.meta.url works in ESM (dev); in the bundled/SEA
// build it's empty, so fall back to cwd (prod overrides the paths via env anyway).
let MODULE_DIR;
try { MODULE_DIR = path.dirname(fileURLToPath(import.meta.url)); }
catch { MODULE_DIR = process.cwd(); }
// Resolve ffmpeg + font so the app works whether launched by start.bat (env set)
// OR by double-clicking the exe (files sit next to the exe) OR from source (dev).
// Priority: explicit env > next to the exe > dev defaults.
const EXE_DIR = path.dirname(process.execPath);
const nextToExe = (name) => path.join(EXE_DIR, name);
// Bundled ffmpeg is "ffmpeg.exe" on Windows, "ffmpeg" on macOS/Linux.
const FF_BIN = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const FFMPEG = process.env.FFMPEG_PATH
  || (existsSync(nextToExe(FF_BIN)) ? nextToExe(FF_BIN) : ffmpegStatic);
const FONT_SRC = process.env.CAPTION_FONT_PATH
  || (existsSync(nextToExe("caption.ttf")) ? nextToExe("caption.ttf") : path.join(MODULE_DIR, "assets", "caption.ttf"));

// ---------- pure: build the ffmpeg argument array ----------

function vfChain(width, height, fps) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
}

// A still (no-zoom) clip stream: scale/pad to the canvas.
function stillStream(i, width, height, fps) {
  return `[${i}:v]${vfChain(width, height, fps)}[v${i}]`;
}

// Clips backed by a video file (vs a still image) are detected by extension —
// the upload keeps the original extension, so paths tell us the kind.
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
const isVideoPath = (p) => !!p && VIDEO_RE.test(p);

// atempo only takes 0.5–2.0 per instance, so chain it for larger speed-ups AND
// slow-downs (audio equivalent of setpts video speed). Returns "" for ~1x.
function atempoChain(speed) {
  let s = speed;
  const parts = [];
  if (!(s > 0) || Math.abs(s - 1) < 1e-4) return "";
  while (s > 2.0001) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5 - 1e-9) { parts.push("atempo=0.5"); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

// A video clip stream. The input is seeked to the trim in-point with -ss, so
// here we normalise to the canvas, optionally speed it up so the whole clip fits
// the slot (`speed` > 1 = fast-forward, via setpts), clone the last frame to fill
// any slot still longer than the footage (tpad), cut to exactly `span`, and reset
// PTS. With motion, an animated Ken Burns zoom is layered on (zoompan d=1).
function videoStream(i, W, H, fps, span, motionType, amount, speed = 1) {
  const S = span.toFixed(3);
  // speed > 1 fast-forwards, speed < 1 slows down (both via setpts) so the whole
  // clip fills its slot. tpad clone still backstops any residual short footage.
  const changed = speed > 0 && Math.abs(speed - 1) > 0.001;
  const spd = changed ? `,setpts=(PTS-STARTPTS)/${speed.toFixed(4)}` : "";
  const base = `[${i}:v]${vfChain(W, H, fps)}${spd},` +
    `tpad=stop_mode=clone:stop_duration=${S},trim=duration=${S},setpts=PTS-STARTPTS`;
  if (!motionType || motionType === "none") {
    // Re-timebase to CFR after a speed change so downstream xfade/encode stay clean.
    return `${base}${changed ? `,fps=${fps}` : ""}[v${i}]`;
  }
  const FR = Math.max(2, Math.round(span * fps));
  const A = amount.toFixed(4);
  const z = motionType === "zoomout" ? `1+${A}-(on/${FR - 1})*${A}` : `1+(on/${FR - 1})*${A}`;
  const PW = Math.round(W * ZOOM_SS), PH = Math.round(H * ZOOM_SS);
  return `${base},scale=${PW}:${PH}:flags=bicubic,` +
    `zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},` +
    `format=yuv420p[v${i}]`;
}

// A Ken Burns zoom stream: one image frame expanded to `frames` output frames by
// zoompan (d=frames — the smooth form; looping with d=1 is what causes the shake).
// The source is supersampled first so zoompan's integer crop rounding stays
// sub-pixel and doesn't jitter. Only zoom clips pay this cost, not the whole encode.
// The supersample factor drives most of zoom's CPU/RAM cost, so it's tunable:
// RENDER_ZOOM_SS (default 3 = smoothest; phones set 2 to stay responsive).
const ZOOM_SS = Math.max(1, Math.min(3, parseFloat(process.env.RENDER_ZOOM_SS || "3")));
function zoomStream(i, W, H, fps, motionType, amount, frames) {
  const A = amount.toFixed(4);
  const FR = Math.max(2, frames);
  const z = motionType === "zoomout" ? `1+${A}-(on/${FR - 1})*${A}` : `1+(on/${FR - 1})*${A}`;
  const M = ZOOM_SS;
  const PW = Math.round(W * M), PH = Math.round(H * M);
  const pre = `[${i}:v]scale=${PW}:${PH}:force_original_aspect_ratio=decrease,` +
    `pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const zp = `zoompan=z='${z}':d=${FR}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`;
  return `${pre},${zp},format=yuv420p[v${i}]`;
}
function fadeVideo(fadeIn, fadeOut, total) {
  const parts = [];
  if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) parts.push(`fade=t=out:st=${Math.max(0, total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  return parts;
}
function fadeAudio(fadeIn, fadeOut, total) {
  const parts = [];
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) parts.push(`afade=t=out:st=${Math.max(0, total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  return parts;
}

// Canvas `globalCompositeOperation` names → ffmpeg blend `all_mode` names.
function ffBlendMode(mode) {
  return ({ "soft-light": "softlight", "hard-light": "hardlight" }[mode] || mode || "overlay");
}

// Composite the overlay texture under `last`. Emulates the frontend preview:
// the clip is used as the base, the texture is cover-filled to WxH, and blended
// with the chosen mode + opacity. Include an overlay input (`-stream_loop -1` for
// looped textures) in `inputs`. Returns the updated `parts`/`last` and the input
// index of the overlay so callers can pass `-i` correctly.
function overlayChain({ parts, last, overlayIdx, width, height, blendMode = "overlay", opacity = 0.3 }) {
  parts.push(
    `[${last}]format=rgba,scale=${width}:${height}[ovbase];` +
    `[${overlayIdx}:v]format=rgba,scale=${width}:${height}[ovsrc];` +
    `[ovbase][ovsrc]blend=all_mode=${ffBlendMode(blendMode)}:all_opacity=${opacity}[ovmix]`,
  );
  return "ovmix";
}

// A static image overlay (logo / watermark): the image keeps its aspect ratio, is
// scaled to at most `size` × the smaller canvas edge (never upscaled) and placed
// with its CENTER at (x*W, y*H), clamped so it stays fully on-screen; `opacity`
// scales its alpha. Applied LAST (on top of captions and fades) so it is always
// visible. Adds the watermark image as a new input whose index is `markIdx`.
function watermarkChain({ parts, last, markIdx, width, height, size = 0.15, x = 0.8, y = 0.88, opacity = 0.9 }) {
  const f = (v, d) => (isFinite(+v) ? Math.min(1, Math.max(0, +v)) : d);
  const cap = Math.max(1, Math.round(Math.min(width, height) * Math.min(1, Math.max(0.01, isFinite(+size) ? +size : 0.15))));
  const X = f(x, 0.8);
  const Y = f(y, 0.88);
  const A = f(opacity, 0.9);
  // Center the logo at (X*W, Y*H); clip() keeps it inside the frame when the
  // center would push an edge off-screen. Subtracting overlay_w/2 turns the
  // clamped center into the overlay's top-left x.
  const cx = `clip(${X.toFixed(4)}*main_w,overlay_w/2,main_w-overlay_w/2)-overlay_w/2`;
  const cy = `clip(${Y.toFixed(4)}*main_h,overlay_h/2,main_h-overlay_h/2)-overlay_h/2`;
  parts.push(
    `[${last}]format=rgba[wmBase];` +
    `[${markIdx}:v]scale=w='min(${cap},iw)':h='min(${cap},ih)':force_original_aspect_ratio=decrease:flags=lanczos,` +
    `format=rgba,colorchannelmixer=aa=${A.toFixed(3)}[wmLogo];` +
    `[wmBase][wmLogo]overlay=x='${cx}':y='${cy}'[wmMix];` +
    `[wmMix]format=yuv420p[vwm]`,
  );
  return "vwm";
}

// A logo anchored to one of the four corners: aspect kept, scaled to at most
// `size` × the smaller canvas edge (never upscaled), inset by `margin` × the
// corresponding edge, drawn at `opacity` alpha. `corner` ∈ "tl"|"tr"|"bl"|"br".
// Like the watermark, applied LAST (on top of captions + fades). Adds the logo as
// a new input whose index is `logoIdx`.
function cornerChain({ parts, last, logoIdx, width, height, corner = "br", size = 0.12, opacity = 0.9, margin = 0.04 }) {
  const f = (v, d) => (isFinite(+v) ? Math.min(1, Math.max(0, +v)) : d);
  const cap = Math.max(1, Math.round(Math.min(width, height) * Math.min(1, Math.max(0.01, isFinite(+size) ? +size : 0.12))));
  const A = f(opacity, 0.9);
  const m = f(margin, 0.04);
  const c = String(corner || "br").toLowerCase();
  const mx = (m * width).toFixed(2);
  const my = (m * height).toFixed(2);
  const cx = c === "tl" || c === "bl" ? mx : `main_w-overlay_w-${mx}`;
  const cy = c === "tl" || c === "tr" ? my : `main_h-overlay_h-${my}`;
  parts.push(
    `[${last}]format=rgba[lgBase];` +
    `[${logoIdx}:v]scale=w='min(${cap},iw)':h='min(${cap},ih)':force_original_aspect_ratio=decrease:flags=lanczos,` +
    `format=rgba,colorchannelmixer=aa=${A.toFixed(3)}[lgLogo];` +
    `[lgBase][lgLogo]overlay=x='${cx}':y='${cy}'[lgMix];` +
    `[lgMix]format=yuv420p[vlg]`,
  );
  return "vlg";
}

// Video codec args per encoder. Hardware encoders (qsv/nvenc/amf) offload the
// H.264 encode to the GPU and are far faster than CPU libx264.
function videoCodecArgs(encoder) {
  switch (encoder) {
    case "h264_qsv":   return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"];
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-pix_fmt", "yuv420p"];
    case "h264_amf":   return ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23", "-qp_b", "23"];
    // Android's on-device hardware encoder (same silicon CapCut/KineMaster use).
    // It takes a bitrate, not -crf, and negotiates its own input pixel format.
    case "h264_mediacodec": return ["-c:v", "h264_mediacodec", "-b:v", "8M"];
    default:           return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
  }
}

// The video filtergraph is written to a file and read with -filter_script:v /
// -filter_complex_script, NOT passed on the command line. With captions there's
// one drawtext per line, so the graph can exceed the OS command-line length
// limit (Windows ~32k → spawn ENAMETOOLONG). Reading from a file avoids that.
function concatArgs({ audioName, width, height, fps, fadeIn, fadeOut, total, capChain, encoder, voiceFx, voiceLevel = 1 }, filterFiles) {
  const vf = [vfChain(width, height, fps), ...(capChain ? [capChain] : []), ...fadeVideo(fadeIn, fadeOut, total)].join(",");
  filterFiles.push({ name: "vf.txt", text: vf });
  // The voiceover is the only audio stream in concat mode, so -af both carries the
  // voice-over effect and the fades.
  const voVolNum = Math.max(0, Math.min(1, voiceLevel == null ? 1 : +voiceLevel));
  const voVol = voVolNum === 1 ? [] : [`volume=${voVolNum.toFixed(3)}`];
  const af = [...voVol, ...(voiceFxFilterString(voiceFx) ? [voiceFxFilterString(voiceFx)] : []), ...fadeAudio(fadeIn, fadeOut, total)];
  const args = ["-f", "concat", "-safe", "0", "-i", "concat.txt", "-i", audioName, "-filter_script:v", "vf.txt"];
  if (af.length) args.push("-af", af.join(","));
  args.push(
    ...videoCodecArgs(encoder),
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", "output.mp4",
  );
  return args;
}

// The transition duration before clip k (a "cut"/none is a single-frame instant).
function transitionDur(transitions, transitionDuration, k, frame) {
  return (!transitions || !transitions[k] || transitions[k] === "cut")
    ? frame : Math.min(MAX_TRANSITION_DURATION, Math.max(MIN_TRANSITION_DURATION, transitionDuration));
}
// Build the per-clip video inputs + filtergraph (scale/zoompan per clip, then the
// xfade chain) for a list of clips whose `.start` is relative to THIS chain's t=0.
// Returns { inputs, parts, last } — `last` is the composited video label. Shared by
// the single-pass render and by each segment of a segmented render.
function buildVideoChain(clips, paths, { width, height, fps, transitions, transitionDuration, motions, motionAmount = 0.08, trims, speeds }) {
  const n = clips.length;
  const frame = 1 / fps;
  const tdur = (k) => transitionDur(transitions, transitionDuration, k, frame);
  const tname = (k) => xfadeName(transitions && transitions[k]);
  const motTypes = clips.map((c, i) => (c.gap ? "none" : (motions && motions[i]) || "none"));
  const inputs = [];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const span = (i < n - 1 ? clips[i].duration + tdur(i + 1) : clips[i].duration) + 2 * frame;
    if (isVideoPath(paths[i]) && !clips[i].gap) {
      const inSec = Math.max(0, (trims && +trims[i]) || 0);
      const spd = speeds && +speeds[i] > 0 ? +speeds[i] : 1;
      inputs.push("-ss", inSec.toFixed(3), "-i", paths[i]);
      parts.push(videoStream(i, width, height, fps, span, motTypes[i], motionAmount, spd));
    } else if (motTypes[i] === "none") {
      inputs.push("-loop", "1", "-t", span.toFixed(3), "-i", paths[i]);
      parts.push(stillStream(i, width, height, fps));
    } else {
      inputs.push("-i", paths[i]);
      parts.push(zoomStream(i, width, height, fps, motTypes[i], motionAmount, Math.round(span * fps)));
    }
  }
  let last = "v0";
  for (let k = 1; k < n; k++) {
    const out = k === n - 1 ? "vx" : `x${k}`;
    parts.push(`[${last}][v${k}]xfade=transition=${tname(k)}:duration=${tdur(k).toFixed(3)}:offset=${clips[k].start.toFixed(3)}[${out}]`);
    last = out;
  }
  return { inputs, parts, last };
}

// Filter prefix for one SFX/BG clip: BG clips carry a trim in-point + play length
// and optional fades; plain FX markers omit all of them (whole file, no envelope).
function sfxClipFilters(s) {
  let out = "";
  if (Number.isFinite(s.offset) || Number.isFinite(s.duration)) {
    out = `atrim=start=${(s.offset || 0).toFixed(3)}`;
    if (Number.isFinite(s.duration)) out += `:duration=${(+s.duration).toFixed(3)}`;
    out += ",asetpts=PTS-STARTPTS,";
  }
  const fin = +s.fadeIn || 0, fout = +s.fadeOut || 0;
  if (fin > 0) out += `afade=t=in:st=0:d=${fin.toFixed(3)},`;
  if (fout > 0 && Number.isFinite(s.duration)) {
    out += `afade=t=out:st=${Math.max(0, (+s.duration) - fout).toFixed(3)}:d=${fout.toFixed(3)},`;
  }
  return out;
}

function graphArgs({ clips, paths, audioName, width, height, fps, transitions, transitionDuration, motions, motionAmount = 0.08, trims, volumes, speeds, audible, fadeIn, fadeOut, total, capChain, textChain = "", encoder, overlayName = null, overlayDuration = 0, overlayOpacity = 0.3, overlayBlendMode = "overlay", overlayLoop = true, overlayEnabled = false, watermarkName = null, watermarkSize = 0.15, watermarkX = 0.8, watermarkY = 0.88, watermarkOpacity = 0.9, watermarkEnabled = false, logoName = null, logoCorner = "br", logoSize = 0.12, logoOpacity = 0.9, logoEnabled = false, sfxClips = [], voiceFx, voiceLevel = 1 }, filterFiles) {
  const n = clips.length;
  const { inputs, parts, last: vEnd } = buildVideoChain(clips, paths, { width, height, fps, transitions, transitionDuration, motions, motionAmount, trims, speeds });
  let last = vEnd;
  let overlayInputs = [];
  if (overlayEnabled && overlayName) {
    const ovIdx = n + 1; // after `n` audio inputs; the overlay is added after audio
    if (overlayLoop) overlayInputs = ["-stream_loop", "-1", "-i", overlayName];
    else overlayInputs = ["-i", overlayName];
    last = overlayChain({ parts, last, overlayIdx: ovIdx, width, height, blendMode: overlayBlendMode, opacity: overlayOpacity });
  }
  if (capChain) { parts.push(`[${last}]${capChain}[vcap]`); last = "vcap"; }
  if (textChain) { parts.push(`[${last}]${textChain}[vtxt]`); last = "vtxt"; }
  const vf = fadeVideo(fadeIn, fadeOut, total);
  if (vf.length) { parts.push(`[${last}]${vf.join(",")}[vf]`); last = "vf"; }
  // Static image overlay on top of everything (above captions and fades).
  let wmInputs = [];
  if (watermarkEnabled && watermarkName) {
    const wmIdx = n + 1 + (overlayEnabled && overlayName ? 1 : 0); // after audio + texture overlay
    wmInputs = ["-i", watermarkName];
    last = watermarkChain({ parts, last, markIdx: wmIdx, width, height, size: watermarkSize, x: watermarkX, y: watermarkY, opacity: watermarkOpacity });
  }
  // Corner logo, above the watermark (it is the very top-most layer).
  let lgInputs = [];
  if (logoEnabled && logoName) {
    const lgIdx = n + 1 + (overlayEnabled && overlayName ? 1 : 0) + (watermarkEnabled && watermarkName ? 1 : 0);
    lgInputs = ["-i", logoName];
    last = cornerChain({ parts, last, logoIdx: lgIdx, width, height, corner: logoCorner, size: logoSize, opacity: logoOpacity });
  }

  // Audio: the voiceover is input n. Any video clip with a volume above 0 (and an
  // actual audio track) is delayed to its slot, volume-scaled, and summed in — so
  // the clip's own sound plays under the narration. amix normalize=0 keeps levels.
  // FX-lane sound effects arrive after the video/overlay/watermark inputs and are
  // mixed in the same pass, each delayed to its marker time.
  const af = fadeAudio(fadeIn, fadeOut, total);
  const vAudio = [];
  for (let i = 0; i < n; i++) {
    const vol = volumes ? +volumes[i] : 0;
    if (isVideoPath(paths[i]) && !clips[i].gap && vol > 0 && (!audible || audible[i])) {
      const startMs = Math.round(clips[i].start * 1000);
      const lbl = `ea${i}`;
      // Speed the audio to match a fast-forwarded clip (atempo), then cut to slot.
      const spd = speeds && +speeds[i] > 0 ? +speeds[i] : 1;
      const at = Math.abs(spd - 1) > 0.001 ? `${atempoChain(spd)},` : "";
      parts.push(`[${i}:a]${at}atrim=duration=${clips[i].duration.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `volume=${vol.toFixed(3)},adelay=${startMs}|${startMs}[${lbl}]`);
      vAudio.push(`[${lbl}]`);
    }
  }
  const sfxBase = n + 1 + (overlayEnabled && overlayName ? 1 : 0) + (watermarkEnabled && watermarkName ? 1 : 0) + (logoEnabled && logoName ? 1 : 0);
  for (let k = 0; k < sfxClips.length; k++) {
    const s = sfxClips[k];
    const startMs = Math.round((s.at || 0) * 1000);
    const vol = Math.max(0, Math.min(1, s.volume == null ? 0.8 : +s.volume));
    const lbl = `sfx${k}`;
    const clip = sfxClipFilters(s);
    parts.push(`[${sfxBase + k}:a]${clip}volume=${vol.toFixed(3)},adelay=${startMs}|${startMs}[${lbl}]`);
    vAudio.push(`[${lbl}]`);
  }
  let amap;
  // Voice-over master volume, then the effect chain on input n (the narration)
  // before it feeds the mix.
  const voVolNum = Math.max(0, Math.min(1, voiceLevel == null ? 1 : +voiceLevel));
  const voPre = voVolNum === 1 ? "" : `volume=${voVolNum.toFixed(3)},`;
  const vfx = voiceFxFilterString(voiceFx);
  if (voPre || vfx) parts.push(`[${n}:a]${voPre}${vfx}[vfx]`);
  const vo = vfx ? "[vfx]" : `[${n}:a]`;
  if (vAudio.length) {
    parts.push(`${vo}${vAudio.join("")}amix=inputs=${vAudio.length + 1}:normalize=0:dropout_transition=0[amx]`);
    if (af.length) { parts.push(`[amx]${af.join(",")}[aout]`); amap = "[aout]"; }
    else amap = "[amx]";
  } else {
    if (af.length) { parts.push(`${vo}${af.join(",")}[aout]`); amap = "[aout]"; }
    else amap = vfx ? "[vfx]" : `${n}:a`;
  }

  const sfxInputs = sfxClips.flatMap((s) => ["-i", s.path]);
  filterFiles.push({ name: "fc.txt", text: parts.join(";") });
  return [
    ...inputs, "-i", audioName, ...overlayInputs, ...wmInputs, ...lgInputs, ...sfxInputs,
    "-filter_complex_script", "fc.txt",
    "-map", `[${last}]`, "-map", amap,
    "-t", total.toFixed(3),
    ...videoCodecArgs(encoder),
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "output.mp4",
  ];
}

// Pure: build the ffmpeg argument array for a render, plus `filterFiles` — the
// filtergraph text to write into the job dir (referenced via -filter_script).
// Graph-path renders open every clip as a simultaneous input, so a huge timeline
// exhausts the OS (file descriptors / memory) mid-filtergraph — notably on macOS
// (default 256 fds). Above this many clips we render in segments and stitch them.
const SEGMENT_MAX = Math.max(10, parseInt(process.env.RENDER_SEGMENT_MAX || "60", 10) || 60);

// Final pass for a segmented render: concat the finished segment videos with STREAM COPY
// (no video re-encode — this is the speed win), and mux the audio (voiceover + each audible
// clip's sound) in one cheap audio-only encode. The segments already have their transitions,
// captions and fades baked in, so the joined video is just copied through. `concatName` is a
// concat-demuxer list file; `audioFc` an optional filter_complex script for the audio mix.
// Returns { args, text } (text = "" when the audio needs no filtergraph).
function buildConcatAudioArgs({ audioName, audioClips, sfxClips = [], fadeIn, fadeOut, total, voiceFx, voiceLevel = 1 }, concatName, audioFc) {
  // input 0 = concat video, input 1 = voiceover, audible clip audio follows.
  const parts = [], vAudio = [], audioInputs = [];
  let ai = 2;
  for (const ac of audioClips) {
    audioInputs.push("-ss", ac.trim.toFixed(3), "-i", ac.path);
    const idx = ai++;
    const startMs = Math.round(ac.start * 1000);
    const at = Math.abs(ac.speed - 1) > 0.001 ? `${atempoChain(ac.speed)},` : "";
    parts.push(`[${idx}:a]${at}atrim=duration=${ac.duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${ac.vol.toFixed(3)},adelay=${startMs}|${startMs}[ea${ac.i}]`);
    vAudio.push(`[ea${ac.i}]`);
  }
  for (let k = 0; k < sfxClips.length; k++) {
    const s = sfxClips[k];
    audioInputs.push("-i", s.path);
    const idx = ai++;
    const startMs = Math.round((s.at || 0) * 1000);
    const vol = Math.max(0, Math.min(1, s.volume == null ? 0.8 : +s.volume));
    const clip = sfxClipFilters(s);
    parts.push(`[${idx}:a]${clip}volume=${vol.toFixed(3)},adelay=${startMs}|${startMs}[sfx${k}]`);
    vAudio.push(`[sfx${k}]`);
  }
  const af = fadeAudio(fadeIn, fadeOut, total);
  let amap;
  // Voice-over master volume, then the effect chain on input 1 (the narration),
  // applied before the mix.
  const voVolNum = Math.max(0, Math.min(1, voiceLevel == null ? 1 : +voiceLevel));
  const voPre = voVolNum === 1 ? "" : `volume=${voVolNum.toFixed(3)},`;
  const vfx = voiceFxFilterString(voiceFx);
  if (voPre || vfx) parts.push(`[1:a]${voPre}${vfx}[vfx]`);
  const vo = vfx ? "[vfx]" : `[1:a]`;
  if (vAudio.length) {
    parts.push(`${vo}${vAudio.join("")}amix=inputs=${vAudio.length + 1}:normalize=0:dropout_transition=0[amx]`);
    if (af.length) { parts.push(`[amx]${af.join(",")}[aout]`); amap = "[aout]"; } else amap = "[amx]";
  } else if (af.length) {
    parts.push(`${vo}${af.join(",")}[aout]`); amap = "[aout]";
  } else {
    amap = vfx ? "[vfx]" : "1:a";
  }
  const args = [
    "-f", "concat", "-safe", "0", "-i", concatName,
    "-i", audioName, ...audioInputs,
    ...(parts.length ? ["-filter_complex_script", audioFc] : []),
    "-map", "0:v", "-c:v", "copy",
    "-map", amap, "-c:a", "aac", "-b:a", "192k",
    "-t", total.toFixed(3),
    "-movflags", "+faststart", "output.mp4",
  ];
  return { args, text: parts.join(";") };
}

// A multi-pass plan built for SPEED on long timelines. Each chunk is rendered as a
// FINAL-quality, self-contained segment video (its own transitions, captions and fades
// baked in), then the segments are concatenated with stream-copy and the audio muxed once.
// Every clip is encoded EXACTLY once — no near-lossless intermediate and no second
// full-timeline re-encode (that double-encode is what made long renders take hours).
// Chunk boundaries are placed at CUT points so the copy-concat has no visible seam; if no
// cut appears within a hard cap, a boundary is forced (that one crossfade becomes a cut).
function buildSegmentedPlan(spec, io) {
  const { clips, width, height, fps = 30, transitions, transitionDuration = 0.4, motions, motionAmount = 0.08, trims, volumes, speeds, fadeIn = 0, fadeOut = 0,
    captions, captionStyle = "classic", captionSize = "md", captionLineHeight, captionFontScale, captionAnimation = "none",
    textOverlays,
    voiceFx, voiceLevel = 1,
    overlayDuration = 0, overlayOpacity = 0.3, overlayBlendMode = "overlay", overlayLoop = true, overlayEnabled = false,
    watermarkSize = 0.15, watermarkX = 0.8, watermarkY = 0.88, watermarkOpacity = 0.9, watermarkEnabled = false,
    logoCorner = "br", logoSize = 0.12, logoOpacity = 0.9, logoEnabled = false } = spec;
  const { paths, audioName, encoder = "libx264", audible, overlayName = null, watermarkName = null, logoName = null, sfxClips = [] } = io;
  const n = clips.length;
  const frame = 1 / fps;
  const tdur = (k) => transitionDur(transitions, transitionDuration, k, frame);
  const hasCaps = Array.isArray(captions) && captions.length > 0;

  // Fixed SEGMENT_MAX chunks — bounds how many inputs each pass opens (same as before).
  // Each segment boundary becomes a plain CUT so the finished segments can be stream-copy
  // concatenated; the only thing lost is a crossfade that fell exactly on a boundary
  // (a handful across a whole video), which reads as a hard cut instead.
  const chunks = [];
  for (let c = 0; c < n; c += SEGMENT_MAX) chunks.push([c, Math.min(c + SEGMENT_MAX - 1, n - 1)]);

  const passes = [], segFiles = [], segOff = [];
  const clipMeta = new Array(n); // per clip: which segment + its rebased in-segment start
  let acc = 0;
  chunks.forEach(([clo, chi], s) => {
    // Rebase this chunk's clip starts to t=0 and compute its exact (frame-snapped) duration.
    let start = 0; const segClips = [];
    for (let i = clo; i <= chi; i++) {
      segClips.push({ ...clips[i], start });
      clipMeta[i] = { seg: s, rebased: start };
      start += clips[i].duration - (i < chi ? tdur(i + 1) : 0);
    }
    const segDur = Math.round(start * fps) / fps;
    segOff[s] = acc; acc += segDur; // cut boundaries → segments just abut, no overlap
    const slice = (a) => (Array.isArray(a) ? a.slice(clo, chi + 1) : a);
    const { inputs, parts, last: vEnd } = buildVideoChain(segClips, slice(paths), {
      width, height, fps, transitions: slice(transitions), transitionDuration, motions: slice(motions), motionAmount, trims: slice(trims), speeds: slice(speeds),
    });
    let last = vEnd;
    let overlayInputs = [];
    // Overlay texture under everything else, applied per segment (loops from t=0).
    if (overlayEnabled && overlayName) {
      const ovIdx = segClips.length; // segment renders have no audio input (see "-an")
      if (overlayLoop) overlayInputs = ["-stream_loop", "-1", "-i", overlayName];
      else overlayInputs = ["-i", overlayName];
      last = overlayChain({ parts, last, overlayIdx: ovIdx, width, height, blendMode: overlayBlendMode, opacity: overlayOpacity });
    }
    const capFiles = [];
    // Per-segment captions: cues overlapping [A,B) shifted to segment-local time. A unique
    // file prefix keeps each segment's textfiles from colliding in the shared job dir.
    if (hasCaps) {
      const A = segOff[s], B = segOff[s] + segDur, segCues = [];
      for (const c of captions) {
        if (c.end <= A || c.start >= B) continue;
        segCues.push({ ...c, start: Math.max(0, c.start - A), end: Math.min(segDur, c.end - A) });
      }
      if (segCues.length) {
        const { filter, files } = buildCaptionBurn(segCues, captionStyle, width, height, captionSize, captionLineHeight, captionFontScale, captionAnimation, `s${s}_`);
        parts.push(`[${last}]${filter}[vcap]`); last = "vcap";
        for (const f of files) capFiles.push(f);
      }
    }
    // Per-segment text overlays, burned like captions (rebased to segment time).
    if (Array.isArray(textOverlays) && textOverlays.length) {
      const A = segOff[s], B = segOff[s] + segDur, segTexts = [];
      for (const it of textOverlays) {
        if ((it.end ?? Number.MAX_SAFE_INTEGER) <= A || (it.start ?? 0) >= B) continue;
        segTexts.push({ ...it, start: Math.max(0, (it.start ?? 0) - A), end: Math.min(segDur, (it.end ?? segDur) - A) });
      }
      if (segTexts.length) {
        const { filter, files } = buildTextOverlayBurn(segTexts, width, height, `s${s}_`);
        parts.push(`[${last}]${filter}[vtxt]`); last = "vtxt";
        for (const f of files) capFiles.push(f);
      }
    }
    // Fades belong only at the true ends of the whole video: fade-in on the first segment,
    // fade-out on the last.
    const segVf = fadeVideo(s === 0 ? fadeIn : 0, s === chunks.length - 1 ? fadeOut : 0, segDur);
    if (segVf.length) { parts.push(`[${last}]${segVf.join(",")}[vf]`); last = "vf"; }
    // Static image overlay (logo / watermark), applied per segment so it survives
    // the stream-copy join. Like the graph path it is the top-most layer.
    let wmInputs = [];
    if (watermarkEnabled && watermarkName) {
      const wmIdx = segClips.length + (overlayEnabled && overlayName ? 1 : 0);
      wmInputs = ["-i", watermarkName];
      last = watermarkChain({ parts, last, markIdx: wmIdx, width, height, size: watermarkSize, x: watermarkX, y: watermarkY, opacity: watermarkOpacity });
    }
    // Corner logo, above the watermark.
    let lgInputs = [];
    if (logoEnabled && logoName) {
      const lgIdx = segClips.length + (overlayEnabled && overlayName ? 1 : 0) + (watermarkEnabled && watermarkName ? 1 : 0);
      lgInputs = ["-i", logoName];
      last = cornerChain({ parts, last, logoIdx: lgIdx, width, height, corner: logoCorner, size: logoSize, opacity: logoOpacity });
    }
    const fc = `fc_s${s}.txt`, out = `seg${s}.mp4`;
    const args = [...inputs, ...overlayInputs, ...wmInputs, ...lgInputs, "-filter_complex_script", fc, "-map", `[${last}]`, "-an", ...videoCodecArgs(encoder), "-r", String(fps), "-t", segDur.toFixed(3), out];
    passes.push({ name: `segment ${s + 1}/${chunks.length}`, args, filterFiles: [{ name: fc, text: parts.join(";") }, ...capFiles], output: out, total: segDur });
    segFiles.push(out);
  });

  const audioClips = [];
  for (let i = 0; i < n; i++) {
    const vol = volumes ? +volumes[i] : 0;
    if (isVideoPath(paths[i]) && !clips[i].gap && vol > 0 && (!audible || audible[i])) {
      // Place each clip's audio at its RECONSTRUCTED output time (segment offset + in-segment
      // start), not the original timeline — so it tracks its own frames.
      const m = clipMeta[i] || { seg: 0, rebased: clips[i].start };
      const outStart = (segOff[m.seg] || 0) + m.rebased;
      audioClips.push({ i, path: paths[i], trim: Math.max(0, (trims && +trims[i]) || 0), speed: speeds && +speeds[i] > 0 ? +speeds[i] : 1, vol, start: outStart, duration: clips[i].duration });
    }
  }

  const vidTotal = acc; // video length = summed segment durations (cut boundaries add no overlap)
  const concatTxt = segFiles.map((f) => `file '${f}'`).join("\n") + "\n";
  const audioFc = "fc_audio.txt";
  const { args, text } = buildConcatAudioArgs({ audioName, audioClips, sfxClips, fadeIn, fadeOut, total: vidTotal, voiceFx, voiceLevel }, "segs.txt", audioFc);
  const joinFiles = [{ name: "segs.txt", text: concatTxt }];
  if (text) joinFiles.push({ name: audioFc, text });
  passes.push({ name: "join (copy)", args, filterFiles: joinFiles, output: "output.mp4", total: vidTotal });
  return { mode: "segmented", total: vidTotal, passes };
}

// spec: { clips, width, height, fps, transitions, transitionDuration, fadeIn, fadeOut }
// io:   { paths: string[] (per-clip basenames), audioName, capChain, encoder }
export function buildRenderPlan(spec, io) {
  const { clips, width, height, fps = 30, transitions, transitionDuration = 0.4, motions, motionAmount = 0.08, trims, volumes, speeds, fadeIn = 0, fadeOut = 0,
    voiceFx, voiceLevel = 1,
    overlayDuration = 0, overlayOpacity = 0.3, overlayBlendMode = "overlay", overlayLoop = true, overlayEnabled = false,
    watermarkSize = 0.15, watermarkX = 0.8, watermarkY = 0.88, watermarkOpacity = 0.9, watermarkEnabled = false,
    logoCorner = "br", logoSize = 0.12, logoOpacity = 0.9, logoEnabled = false } = spec;
  const { paths, audioName, capChain = "", textChain = "", encoder = "libx264", audible, overlayName = null, watermarkName = null, logoName = null, sfxClips = [] } = io;
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  const hasTransition = Array.isArray(transitions) && clips.length >= 2 &&
    transitions.some((t, i) => i > 0 && t && t !== "cut");
  // Per-clip zoom also needs the filter-graph path (concat can't zoom per clip).
  const hasMotion = Array.isArray(motions) &&
    motions.some((m, i) => m && m !== "none" && clips[i] && !clips[i].gap);
  // Video clips always need the filter-graph path (trim/fit/zoom/audio-mix).
  const hasVideo = Array.isArray(paths) &&
    paths.some((p, i) => isVideoPath(p) && clips[i] && !clips[i].gap);
  // Overlay needs a second input → always the filter-graph path.
  const hasOverlay = !!overlayEnabled && !!overlayName;
  // A static image overlay also needs a second input → always the filter-graph
  // path (a watermark-only, all-images timeline would otherwise use concat).
  const hasWatermark = !!watermarkEnabled && !!watermarkName;
  // A corner logo is another second input → always the filter-graph path.
  const hasLogo = !!logoEnabled && !!logoName;
  // FX-lane sound effects can only be mixed in the filter-graph path (concat has
  // no per-marker audio inputs), so their presence also forces the graph.
  const hasSfx = Array.isArray(sfxClips) && sfxClips.length > 0;
  const useGraph = hasTransition || hasMotion || hasVideo || hasOverlay || hasWatermark || hasLogo || hasSfx;
  // Big graph timelines are split into segments + a join to dodge the OS limits.
  if (useGraph && clips.length > SEGMENT_MAX) return buildSegmentedPlan(spec, io);
  const common = { clips, paths, audioName, width, height, fps, fadeIn, fadeOut, total, capChain, textChain, encoder,
    voiceFx, voiceLevel,
    overlayName, overlayDuration, overlayOpacity, overlayBlendMode, overlayLoop, overlayEnabled,
    watermarkName, watermarkSize, watermarkX, watermarkY, watermarkOpacity, watermarkEnabled,
    logoName, logoCorner, logoSize, logoOpacity, logoEnabled, sfxClips };
  const filterFiles = [];
  const args = useGraph
    ? graphArgs({ ...common, transitions, transitionDuration, motions, motionAmount, trims, volumes, speeds, audible }, filterFiles)
    : concatArgs(common, filterFiles);
  return { mode: useGraph ? "graph" : "concat", total, args, filterFiles };
}

// Probe which H.264 encoder to use: try each hardware encoder with a tiny test
// encode and pick the first that actually runs; fall back to CPU libx264. This
// keeps rendering working on any machine (no GPU, old drivers, etc.).
// On Android (Termux node reports platform "android") try the on-device
// MediaCodec hardware encoder first — that's what keeps CapCut/KineMaster from
// pegging the CPU. Desktops keep their GPU encoders.
const ENCODER_CANDIDATES = process.platform === "android"
  ? ["h264_mediacodec"]
  : ["h264_nvenc", "h264_qsv", "h264_amf"];

function testEncoder(enc) {
  // Encode a few real frames to a temp MP4 (more representative than -f null,
  // which some hardware encoders reject even though real encodes succeed).
  const out = path.join(os.tmpdir(), `svprobe-${process.pid}-${enc}.mp4`);
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      ["-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.3:r=15",
        "-c:v", enc, "-frames:v", "3", "-f", "mp4", "-y", out],
      { timeout: 20000 },
      (err) => { fs.rm(out, { force: true }).catch(() => {}); resolve(!err); },
    );
  });
}

export async function detectEncoder() {
  // Escape hatch: force a specific encoder (e.g. RENDER_ENCODER=libx264 if the
  // hardware one produces a bad/failed render). Skips probing entirely.
  if (process.env.RENDER_ENCODER) return process.env.RENDER_ENCODER;
  for (const enc of ENCODER_CANDIDATES) {
    // eslint-disable-next-line no-await-in-loop
    if (await testEncoder(enc)) return enc;
  }
  return "libx264";
}

// ---------- I/O + process ----------

// Does this media file carry an audio track? Probe with ffmpeg (`-i` with no
// output exits non-zero but prints the stream table to stderr) so we never map a
// missing [i:a] stream — which would abort the whole render. ffprobe isn't always
// bundled (ffmpeg-static ships only ffmpeg), so we parse ffmpeg's own output.
function probeHasAudio(dir, file) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", "-i", file], { cwd: dir, timeout: 15000 }, (_err, _out, stderr) => {
      resolve(/Stream #\d+:\d+.*: Audio:/i.test(stderr || ""));
    });
  });
}

// Generate a solid black frame for gap clips using ffmpeg's lavfi color source.
function makeBlack(dir, width, height) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}`,
      "-frames:v", "1", "-y", "black.png",
    ], { cwd: dir }, (err) => (err ? reject(err) : resolve()));
  });
}

// Lay out the job dir. `fileMap` maps upload fieldname -> filename already written
// into `dir` by multer (image fields keyed by clip name, plus "audio").
// Returns { paths, audioName, capChain } for buildRenderPlan.
export async function writeInputs(dir, spec, fileMap) {
  const { clips, width, height, captions, captionStyle = "classic", captionSize = "md", captionLineHeight, captionFontScale, captionAnimation = "none", textOverlays } = spec;

  const audioName = fileMap["audio"];
  const overlayName = fileMap["overlay"] || null;
  const watermarkName = fileMap["watermark"] || null;
  const logoName = fileMap["logo"] || null;
  const needBlack = clips.some((c) => c.gap);
  if (needBlack) await makeBlack(dir, width, height);

  const paths = clips.map((c) => (c.gap ? "black.png" : fileMap[c.name]));

  // Concat file list (used only when there are no transitions; harmless otherwise).
  let concat = "";
  for (let i = 0; i < clips.length; i++) {
    concat += `file '${paths[i]}'\nduration ${clips[i].duration}\n`;
    if (i === clips.length - 1) concat += `file '${paths[i]}'\n`;
  }
  await fs.writeFile(path.join(dir, "concat.txt"), concat);

  let capChain = "", textChain = "";
  if (Array.isArray(captions) && captions.length || Array.isArray(textOverlays) && textOverlays.length) {
    await fs.copyFile(FONT_SRC, path.join(dir, CAPTION_FONT));
  }
  if (Array.isArray(captions) && captions.length) {
    const { filter, files } = buildCaptionBurn(captions, captionStyle, width, height, captionSize, captionLineHeight, captionFontScale, captionAnimation);
    for (const f of files) await fs.writeFile(path.join(dir, f.name), f.text);
    capChain = filter;
  }
  if (Array.isArray(textOverlays) && textOverlays.length) {
    const { filter, files } = buildTextOverlayBurn(textOverlays, width, height);
    for (const f of files) await fs.writeFile(path.join(dir, f.name), f.text);
    textChain = filter;
  }

  // Which video clips actually have audio (so we only mix real streams in).
  const audible = await Promise.all(clips.map((c, i) =>
    (c.gap || !isVideoPath(paths[i])) ? Promise.resolve(false) : probeHasAudio(dir, paths[i])));

  // SFX-lane markers and BG-lane music clips both arrive as `sfx` entries, each
  // uploaded under a `sfx_<id>` field. Resolve them to on-disk paths for mixing.
  const sfxClips = (Array.isArray(spec.sfx) ? spec.sfx : [])
    .map((s) => ({
      id: s.id, path: fileMap[`sfx_${s.id}`], at: s.at, volume: s.volume,
      offset: s.offset, duration: s.duration, fadeIn: s.fadeIn, fadeOut: s.fadeOut,
    }))
    .filter((s) => s.path);

  return { paths, audioName, capChain, textChain, audible, overlayName, watermarkName, logoName, sfxClips };
}

// Parse ffmpeg -progress output → fraction in [0,1].
function parseProgress(chunk, total) {
  const s = chunk.toString();
  let us = null;
  const mUs = [...s.matchAll(/out_time_us=(\d+)/g)].pop();
  if (mUs) us = +mUs[1];
  else {
    const mT = [...s.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
    if (mT) us = ((+mT[1]) * 3600 + (+mT[2]) * 60 + parseFloat(mT[3])) * 1e6;
  }
  if (us == null || !(total > 0)) return null;
  return Math.min(1, (us / 1e6) / total);
}

// Spawn native ffmpeg. Returns { proc, done } where done resolves to the output
// path on success. onProgress(fraction) is called as encoding advances.
// opts.threads caps encoder + filter threads (so a phone doesn't peg every core
// and overheat); opts.nice runs it at low OS priority (so the phone stays
// responsive — foreground apps get CPU first). Both are best-effort.
export function runRender(dir, args, total, onProgress, opts = {}) {
  const output = opts.output || "output.mp4";
  const threads = opts.threads > 0 ? opts.threads : 0;
  let a = [...args];
  if (threads) {
    // Encoder threads: insert before the output filename (an output option).
    const oi = a.lastIndexOf(output);
    if (oi >= 0) a.splice(oi, 0, "-threads", String(threads));
    // Filter threads: global options.
    a = ["-filter_complex_threads", String(threads), "-filter_threads", String(threads), ...a];
  }
  a = [...a, "-progress", "pipe:1", "-nostats", "-y"];
  // Low priority keeps the phone usable during a render (Unix only).
  let cmd = FFMPEG, cmdArgs = a;
  if (opts.nice != null && process.platform !== "win32") {
    cmd = "nice"; cmdArgs = ["-n", String(opts.nice), FFMPEG, ...a];
  }
  const proc = spawn(cmd, cmdArgs, { cwd: dir });
  let stderr = "";
  proc.stdout.on("data", (buf) => {
    const p = parseProgress(buf, total);
    if (p != null && onProgress) onProgress(p);
  });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(path.join(dir, output));
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
  return { proc, done };
}
