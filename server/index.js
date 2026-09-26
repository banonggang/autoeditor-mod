import express from "express";
import cors from "cors";
import multer from "multer";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRenderPlan, writeInputs, runRender, detectEncoder } from "./render.js";

// Crash-safe module dir (see render.js): ESM in dev, cwd in the bundled .exe.
let MODULE_DIR;
try { MODULE_DIR = path.dirname(fileURLToPath(import.meta.url)); }
catch { MODULE_DIR = process.cwd(); }
// When shipped, ffmpeg.exe/out sit next to the exe — used to self-locate assets
// so double-clicking the exe works (not just start.bat), and to auto-open the
// browser in that case.
const EXE_DIR = path.dirname(process.execPath);
// Bundled ffmpeg is "ffmpeg.exe" on Windows, "ffmpeg" on macOS/Linux.
const FF_BIN = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const PACKAGED = fssync.existsSync(path.join(EXE_DIR, FF_BIN));
// A finished render is auto-saved to OUTPUT_DIR (in addition to the browser
// download), so a render always lands on disk even if the browser was
// refreshed/closed at the finish moment. Termux's start.sh sets it explicitly;
// everywhere else (packaged desktop app AND dev-from-source) it defaults to
// <Downloads>/AutoEditor. Set OUTPUT_DIR yourself to override the folder.
function defaultOutputDir() {
  const home = os.homedir();
  const dl = path.join(home, "Downloads");
  const base = fssync.existsSync(dl) ? dl : home;
  return path.join(base, "AutoEditor");
}
const OUTPUT_DIR = process.env.OUTPUT_DIR || defaultOutputDir();
// Resource limits so a render doesn't hog the machine (mostly for phones/Termux).
// RENDER_THREADS caps ffmpeg's thread count (0/unset = ffmpeg's default = all cores);
// RENDER_NICE runs ffmpeg at that OS priority on Unix (0=normal … 19=lowest).
const RENDER_THREADS = Math.max(0, parseInt(process.env.RENDER_THREADS || "0", 10) || 0);
const RENDER_NICE = process.env.RENDER_NICE != null && process.env.RENDER_NICE !== ""
  ? parseInt(process.env.RENDER_NICE, 10) : null;
// Job temp dirs live in the OS temp folder, NOT under the project (which may be
// inside OneDrive/Dropbox and lock files during sync).
const TMP = path.join(os.tmpdir(), "autoeditor-render");

// Best-effort recursive delete — never let a locked/synced file crash a render.
function rmrf(p) {
  try { fssync.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
// Static frontend (the Next.js `out/` export). In the shipped app the backend
// serves the UI itself, so it's same-origin; in dev the frontend runs separately.
const FRONTEND_DIR = process.env.FRONTEND_DIR
  || (fssync.existsSync(path.join(EXE_DIR, "out", "index.html")) ? path.join(EXE_DIR, "out") : path.join(MODULE_DIR, "..", "out"));

fssync.mkdirSync(TMP, { recursive: true });
// Startup sweep: clear any stale job dirs from a previous run (best-effort).
for (const d of fssync.readdirSync(TMP)) rmrf(path.join(TMP, d));

const jobs = new Map(); // id -> { dir, proc, total, progress, status, outPath, error, listeners:Set }
let activeJobId = null;  // the single render allowed to run at a time (phones can't do two)
const clearActive = (id) => { if (activeJobId === id) activeJobId = null; };

// Pick the fastest working H.264 encoder once at startup (hardware if available,
// else CPU libx264). Renders still fall back per-job if a hardware encode fails.
// FORCE_ENCODER (e.g. "libx264") overrides detection.
let ENCODER = "libx264";
if (process.env.FORCE_ENCODER) {
  ENCODER = process.env.FORCE_ENCODER;
  console.log(`Video encoder: ${ENCODER} (forced)`);
} else {
  detectEncoder().then((e) => {
    ENCODER = e;
    console.log(`Video encoder: ${e}${e === "libx264" ? " (CPU)" : " (GPU / hardware)"}`);
  });
}

const app = express();
app.use(cors({ origin: ORIGIN }));

// Per-request job dir, created before multer writes uploads into it.
function newJob(req, _res, next) {
  const id = crypto.randomUUID();
  const dir = path.join(TMP, id);
  fssync.mkdirSync(dir, { recursive: true });
  req.jobId = id;
  req.jobDir = dir;
  next();
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, req.jobDir),
  // image fields are keyed by clip name; audio by "audio". Keep a safe basename.
  filename: (_req, file, cb) => {
    const safe = String(file.fieldname).replace(/[^a-zA-Z0-9_-]/g, "_");
    const ext = (file.originalname.match(/\.([a-z0-9]+)$/i) || [, "bin"])[1].toLowerCase();
    cb(null, `${safe}.${ext}`);
  },
});
const upload = multer({ storage });

function broadcast(job, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.listeners) res.write(data);
}

function endListeners(job) {
  for (const r of job.listeners) r.end();
  job.listeners.clear();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Check in-flight renders without the browser, e.g. from another Termux
// session:  curl localhost:4000/status
app.get("/status", (_req, res) => {
  res.json([...jobs.entries()].map(([id, j]) => ({
    id, status: j.status, percent: Math.round(j.progress * 100),
  })));
});

// The one render currently running (for the UI to reconnect to after a reload).
app.get("/active", (_req, res) => {
  const j = activeJobId && jobs.get(activeJobId);
  if (j && j.status === "running") return res.json({ jobId: activeJobId, percent: Math.round(j.progress * 100) });
  res.json({ jobId: null });
});

// Refuse a second render while one is running — phones can't handle two.
function oneAtATime(req, res, next) {
  const cur = activeJobId && jobs.get(activeJobId);
  if (cur && cur.status === "running") {
    rmrf(req.jobDir);
    return res.status(409).json({ error: "A render is already in progress.", jobId: activeJobId, percent: Math.round(cur.progress * 100) });
  }
  next();
}

app.post("/render", newJob, oneAtATime, upload.any(), async (req, res) => {
  try {
    const spec = JSON.parse(req.body.spec);
    const fileMap = {};
    for (const f of req.files) fileMap[f.fieldname] = f.filename;

    const { paths, audioName, capChain, textChain, audible, overlayName, watermarkName, logoName, sfxClips } = await writeInputs(req.jobDir, spec, fileMap);

    const job = {
      dir: req.jobDir, proc: null, total: 0,
      progress: 0, status: "running", outPath: null, error: null, listeners: new Set(),
      _loggedPct: -5,
    };
    jobs.set(req.jobId, job);
    activeJobId = req.jobId;
    console.log("Render started — you can close the browser; it keeps rendering here.");

    // Render with the chosen encoder; if a hardware encode fails on this machine,
    // retry once with CPU libx264 so it always produces a valid video.
    // A plan is one or more passes (a big graph timeline is split into segment
    // passes + a join pass). Run them in order; aggregate progress by frame count.
    const launch = async (encoder) => {
      let plan;
      try { plan = buildRenderPlan(spec, { paths, audioName, capChain, textChain, encoder, audible, overlayName, watermarkName, logoName, sfxClips }); }
      catch (e) { job.status = "error"; job.error = String(e.message || e); broadcast(job, { error: job.error }); endListeners(job); clearActive(req.jobId); return; }
      const passes = plan.passes || [{ args: plan.args, filterFiles: plan.filterFiles, output: "output.mp4", total: plan.total }];
      const grand = passes.reduce((s, p) => s + (p.total || 0), 0) || 1;
      job.total = plan.total;
      let base = 0; // frames finished in prior passes
      try {
        for (const pass of passes) {
          // Write this pass's filtergraph(s) to disk (read via -filter_complex_script,
          // avoiding over-long command lines when captions add many drawtext filters).
          for (const f of pass.filterFiles) fssync.writeFileSync(path.join(req.jobDir, f.name), f.text);
          const passTotal = pass.total || 0;
          const { proc, done } = runRender(req.jobDir, pass.args, passTotal, (p) => {
            const overall = (base + p * passTotal) / grand;
            job.progress = overall;
            broadcast(job, { progress: overall });
            const pct = Math.floor(overall * 100);
            if (pct >= job._loggedPct + 5) { job._loggedPct = pct; console.log(`Rendering… ${pct}%`); }
          }, { threads: RENDER_THREADS, nice: RENDER_NICE, output: pass.output });
          job.proc = proc;
          await done;
          if (job.status === "cancelled") return;
          base += passTotal;
        }
      } catch (err) {
        if (job.status === "cancelled") return;
        if (encoder !== "libx264") {
          console.warn(`Encoder ${encoder} failed — falling back to libx264. ${String(err.message || err).split("\n")[0]}`);
          job.progress = 0; job._loggedPct = -5;
          broadcast(job, { progress: 0 });
          return launch("libx264");
        }
        job.status = "error"; job.error = String(err.message || err);
        console.error("Render failed: " + job.error.split("\n")[0]);
        broadcast(job, { error: job.error });
        endListeners(job);
        clearActive(req.jobId);
        return;
      }

      // All passes succeeded — the last one produced output.mp4.
      const outPath = path.join(req.jobDir, "output.mp4");
      job.status = "done"; job.progress = 1;
      // Auto-save to a real folder (mobile: survives closing the browser).
      let saved = null;
      if (OUTPUT_DIR) {
        try {
          fssync.mkdirSync(OUTPUT_DIR, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          saved = path.join(OUTPUT_DIR, `autoeditor-${stamp}-${req.jobId.slice(0, 6)}.mp4`);
          fssync.copyFileSync(outPath, saved);
          console.log("Saved video to " + saved);
        } catch (e) { console.warn("Could not save to OUTPUT_DIR: " + e.message); saved = null; }
      }
      job.outPath = saved || outPath; // serve the saved copy if we made one
      job.saved = saved;
      broadcast(job, { progress: 1 });
      broadcast(job, { done: true, saved });
      endListeners(job);
      clearActive(req.jobId);
    };
    launch(ENCODER);

    res.json({ jobId: req.jobId });
  } catch (err) {
    rmrf(req.jobDir);
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get("/render/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ progress: job.progress })}\n\n`);
  if (job.status === "done") { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); return res.end(); }
  if (job.status === "error") { res.write(`data: ${JSON.stringify({ error: job.error })}\n\n`); return res.end(); }
  job.listeners.add(res);
  req.on("close", () => job.listeners.delete(res));
});

app.get("/render/:id/file", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.outPath) return res.status(404).end();
  res.sendFile(job.outPath, (err) => {
    if (!err) {
      // Clean up after the browser has the bytes.
      setTimeout(() => {
        rmrf(job.dir);
        jobs.delete(req.params.id);
      }, 1000);
    }
  });
});

app.post("/render/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  job.status = "cancelled";
  if (job.proc) { try { job.proc.kill("SIGKILL"); } catch { /* already gone */ } }
  endListeners(job);
  rmrf(job.dir);
  jobs.delete(req.params.id);
  clearActive(req.params.id);
  res.json({ ok: true });
});

// Serve the built static UI (if present) after the API routes, so the app is
// reachable at the same origin as the render endpoints.
if (fssync.existsSync(FRONTEND_DIR)) app.use(express.static(FRONTEND_DIR));

// Open the user's default browser once the server is up (only when launched via
// start.bat, which sets OPEN_BROWSER=1 — never during tests).
// Fire-and-forget a command; never let a missing binary crash us. spawn emits
// an async 'error' event (not a throw) when the command is absent, so we MUST
// attach an error listener or Node treats it as unhandled and exits.
function spawnQuiet(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.on("error", () => { /* command not installed — ignore */ });
    p.unref();
  } catch { /* ignore */ }
}

function openBrowser(url) {
  if (process.platform === "win32") spawnQuiet("cmd", ["/c", "start", "", url]);
  else if (process.platform === "darwin") spawnQuiet("open", [url]);
  else spawnQuiet("xdg-open", [url]);
}

app.listen(PORT, () => {
  console.log(`AutoEditor running on http://localhost:${PORT}`);
  if (OUTPUT_DIR) console.log(`Finished videos are also saved to: ${OUTPUT_DIR}`);
  console.log("Keep this window open. Close it (or press Ctrl+C) to stop the app.");
  // Auto-open when launched via start.bat (OPEN_BROWSER=1) or by double-clicking
  // the packaged exe. OPEN_BROWSER=0 disables it.
  const wantOpen = process.env.OPEN_BROWSER === "0"
    ? false
    : (process.env.OPEN_BROWSER === "1" || PACKAGED);
  if (wantOpen) openBrowser(`http://localhost:${PORT}`);
});
