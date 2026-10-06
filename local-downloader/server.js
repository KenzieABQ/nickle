'use strict';

/**
 * Local Downloader — local-only backend.
 *
 * Serves the static frontend and exposes a small JSON API that runs yt-dlp
 * (and, through yt-dlp, ffmpeg) on this computer. The server binds to the
 * loopback interface only and is never meant to be exposed to a network.
 */

const express = require('express');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const PORT = parsePort(process.env.PORT, 3210);
const APP_URL = `http://localhost:${PORT}`;
// `--open` (used by `npm start` and the launchers) opens the app in the browser.
const OPEN_BROWSER = process.argv.includes('--open');
const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const TEMP_ROOT = path.join(DOWNLOADS_DIR, '.tmp');

const ANALYZE_TIMEOUT_MS = 90 * 1000;
const MAX_ACTIVE_DOWNLOADS = 3;
const JOB_TTL_MS = 60 * 60 * 1000;
const ANALYSIS_TTL_MS = 60 * 60 * 1000;
const MAX_ANALYSES = 200;
const MAX_URL_LENGTH = 2048;
const MAX_JSON_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const THUMBNAIL_TIMEOUT_MS = 15 * 1000;
const EMIT_INTERVAL_MS = 120;

const VIDEO_QUALITIES = new Set(['best', '1080', '720', '480', '360']);
const AUDIO_FORMATS = new Set(['mp3', 'm4a']);
const MODES = new Set(['video', 'audio']);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THUMBNAIL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const RESOLUTION_TIERS = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];

const MESSAGES = {
  ytdlpMissing: 'yt-dlp was not found. Install yt-dlp and restart the app.',
  ffmpegMissing: 'ffmpeg was not found. Install ffmpeg for video/audio processing.',
  invalidUrl: 'Please enter a valid URL.',
  retrieveFailed:
    'Unable to retrieve this media. Check the URL and make sure you have permission to download it.',
  downloadFailed:
    'The download failed. Check the URL and make sure you have permission to download it.',
  invalidRequest: 'The request was not valid. Reload the page and try again.',
  notFound: 'This download is no longer available. Start a new one.',
  internal: 'Something went wrong. See the terminal for details.',
};

const POSTPROCESSOR_LABELS = {
  Merger: 'Merging video and audio',
  ExtractAudio: 'Converting audio',
  VideoConvertor: 'Converting video',
  VideoRemuxer: 'Remuxing video',
  Metadata: 'Writing metadata',
  EmbedThumbnail: 'Embedding thumbnail',
  MoveFiles: 'Finalizing',
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function parsePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

function log(scope, message) {
  console.log(`[${timestamp()}] ${scope.padEnd(9)} ${message}`);
}

function logError(scope, message, detail) {
  console.error(`[${timestamp()}] ${scope.padEnd(9)} ${message}`);
  if (detail) {
    const text = String(detail).trim();
    if (text) console.error(text.replace(/^/gm, '            | '));
  }
}

function toNumber(value) {
  if (value === undefined || value === null || value === '' || value === 'NA') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  // Strip control characters; the frontend renders everything as text.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/** Forwards rejected promises from async route handlers to the error handler. */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendError(res, status, message, code) {
  res.status(status).json({ error: message, code: code || 'error' });
}

/** Splits a readable stream into lines (handles \n, \r\n and bare \r). */
function readLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r\n|\n|\r/);
    buffer = lines.pop();
    for (const line of lines) if (line) onLine(line);
  });
  stream.on('end', () => {
    if (buffer) onLine(buffer);
    buffer = '';
  });
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Returns a normalized http(s) URL or null. The URL is only ever passed to
 * yt-dlp as a single argv entry after "--", so it can never be interpreted
 * as an option or shell syntax.
 */
function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let candidate = input.trim();
  if (!candidate || candidate.length > MAX_URL_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(candidate)) return null;
  // Allow "example.com/video" by assuming https.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  // Embedded credentials are not supported (no authentication by design).
  if (parsed.username || parsed.password) return null;
  if (parsed.href.length > MAX_URL_LENGTH) return null;
  return parsed.href;
}

// ---------------------------------------------------------------------------
// Dependency detection
// ---------------------------------------------------------------------------

function childEnv() {
  // Ask Python-based tools for UTF-8 output so non-ASCII filenames survive.
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

function probe(bin, args, parseVersion) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    } catch (err) {
      resolve({ installed: false, version: null, reason: err.code || err.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (output.length < 16384) output += chunk;
    });
    child.stderr.resume();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ installed: false, version: null, reason: err.code || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ installed: true, version: parseVersion(output) });
      else resolve({ installed: false, version: null, reason: `exited with code ${code}` });
    });
  });
}

let dependencyState = null;
let dependencyCheck = null;

async function checkDependencies() {
  const [ytdlp, ffmpeg] = await Promise.all([
    probe(YTDLP_BIN, ['--version'], (out) => out.trim().split(/\s+/)[0] || null),
    probe(FFMPEG_BIN, ['-version'], (out) => (out.match(/ffmpeg version (\S+)/i) || [])[1] || null),
  ]);
  dependencyState = { ytdlp, ffmpeg, checkedAt: Date.now() };
  return dependencyState;
}

/**
 * Returns the cached dependency state. If something was missing, re-check
 * (at most every few seconds) so installing a tool is picked up without
 * guesswork.
 */
async function getDependencies() {
  const state = dependencyState;
  const allPresent = state && state.ytdlp.installed && state.ffmpeg.installed;
  if (state && (allPresent || Date.now() - state.checkedAt < 3000)) return state;
  if (!dependencyCheck) {
    dependencyCheck = checkDependencies().finally(() => {
      dependencyCheck = null;
    });
  }
  return dependencyCheck;
}

function markMissing(tool) {
  if (dependencyState && dependencyState[tool]) {
    dependencyState[tool] = { installed: false, version: null, reason: 'not found' };
    dependencyState.checkedAt = Date.now();
  }
}

/** Arguments shared by every yt-dlp invocation. */
function ytdlpBaseArgs() {
  const args = [
    // Ignore user/system config files so behaviour is predictable and no
    // unexpected options (cookies, exec hooks, proxies) are picked up.
    '--ignore-config',
    '--no-playlist',
    '--encoding',
    'utf-8',
  ];
  if (process.env.FFMPEG_PATH) args.push('--ffmpeg-location', FFMPEG_BIN);
  return args;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

function friendlyYtDlpError(stderr, context) {
  const text = String(stderr || '').toLowerCase();
  const has = (...needles) => needles.some((n) => text.includes(n));

  if (has('ffmpeg not found', 'ffprobe and ffmpeg not found', 'ffmpeg is not installed', 'ffprobe/avprobe and ffmpeg/avconv not found')) {
    return MESSAGES.ffmpegMissing;
  }
  if (has('is not a valid url')) return MESSAGES.invalidUrl;
  if (has('drm protected', 'drm-protected', 'this video is drm')) {
    return 'This media is DRM-protected and cannot be downloaded.';
  }
  if (has('private video', 'sign in to confirm', 'login required', 'log in to', 'requires authentication',
    'members-only', 'join this channel', 'age-restricted', 'confirm your age', 'premium')) {
    return 'This media requires signing in or verification. Only publicly accessible media you have permission to download is supported.';
  }
  if (has('unsupported url')) {
    return 'This website is not supported. Check the URL and make sure you have permission to download it.';
  }
  if (has('requested format is not available', 'no video formats found')) {
    return context === 'download'
      ? 'The selected quality is not available for this media. Try "Best available".'
      : MESSAGES.retrieveFailed;
  }
  if (has('getaddrinfo', 'name or service not known', 'nodename nor servname', 'temporary failure in name resolution',
    'network is unreachable', 'connection refused', 'connection reset', 'timed out', 'unable to connect')) {
    return 'Could not connect to the website. Check your internet connection and try again.';
  }
  if (has('no space left on device', 'disk full')) {
    return 'There is not enough disk space to save this file.';
  }
  if (has('permission denied', 'errno 13', 'access is denied')) {
    return 'The downloads folder is not writable. Check its permissions and try again.';
  }
  if (has('is live', 'live event', 'premieres in')) {
    return 'Live streams and upcoming premieres are not supported.';
  }
  return context === 'download' ? MESSAGES.downloadFailed : MESSAGES.retrieveFailed;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    } catch (err) {
      resolve({ spawnError: err });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_JSON_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', (err) => finish({ spawnError: err }));
    child.on('close', (code) => {
      finish({
        code,
        timedOut,
        overflow,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Media analysis
// ---------------------------------------------------------------------------

const analyses = new Map();

function pruneAnalyses() {
  const now = Date.now();
  for (const [id, entry] of analyses) {
    if (now - entry.createdAt > ANALYSIS_TTL_MS) analyses.delete(id);
  }
  while (analyses.size > MAX_ANALYSES) {
    analyses.delete(analyses.keys().next().value);
  }
}

/** Works out whether a yt-dlp format carries video and/or audio. */
function classifyFormat(format) {
  if (format.format_note === 'storyboard' || format.ext === 'mhtml') return { video: false, audio: false };
  const vKnown = typeof format.vcodec === 'string';
  const aKnown = typeof format.acodec === 'string';
  if (!vKnown && !aKnown) {
    // Direct files often have no codec info: assume a muxed file unless
    // yt-dlp already decided it is audio-only.
    const audioOnly = format.video_ext === 'none' && format.audio_ext && format.audio_ext !== 'none';
    return { video: !audioOnly, audio: true };
  }
  return {
    video: vKnown ? format.vcodec !== 'none' : Boolean(format.height || format.width),
    audio: aKnown ? format.acodec !== 'none' : true,
  };
}

/** The "p" number of a format: the smaller side, so vertical video works. */
function shortSide(format) {
  const w = toNumber(format.width);
  const h = toNumber(format.height);
  if (w && h) return Math.min(w, h);
  return h || null;
}

function tierFor(side) {
  for (const tier of RESOLUTION_TIERS) if (side >= tier * 0.9) return tier;
  return Math.round(side);
}

function pickThumbnail(info) {
  const candidates = [];
  if (typeof info.thumbnail === 'string') candidates.push(info.thumbnail);
  if (Array.isArray(info.thumbnails)) {
    for (let i = info.thumbnails.length - 1; i >= 0; i -= 1) {
      const t = info.thumbnails[i];
      if (t && typeof t.url === 'string') candidates.push(t.url);
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {
      // try the next one
    }
  }
  return null;
}

function summarizeInfo(info, url) {
  const formats = Array.isArray(info.formats) && info.formats.length ? info.formats : [info];
  let hasVideo = false;
  let hasAudio = false;
  let maxResolution = 0;
  const tiers = new Set();

  for (const format of formats) {
    if (!format || typeof format !== 'object') continue;
    const kind = classifyFormat(format);
    if (kind.video) {
      hasVideo = true;
      const side = shortSide(format);
      if (side) {
        maxResolution = Math.max(maxResolution, side);
        tiers.add(tierFor(side));
      }
    }
    if (kind.audio) hasAudio = true;
  }

  const id = crypto.randomUUID();
  const thumbnailUrl = pickThumbnail(info);
  pruneAnalyses();
  analyses.set(id, { url, thumbnailUrl, thumbnail: null, createdAt: Date.now() });

  const duration = toNumber(info.duration);
  return {
    id,
    url,
    title: cleanText(info.title, 300) || 'Untitled',
    uploader: cleanText(info.uploader || info.channel || info.creator || info.artist || info.uploader_id, 120),
    duration: duration && duration > 0 ? Math.round(duration) : null,
    site: cleanText(info.extractor_key || info.extractor, 60),
    thumbnail: thumbnailUrl ? `/api/thumbnail/${id}` : null,
    hasVideo,
    hasAudio,
    maxResolution: maxResolution || null,
    resolutions: [...tiers].sort((a, b) => b - a),
  };
}

// ---------------------------------------------------------------------------
// Download jobs
// ---------------------------------------------------------------------------

const jobs = new Map();

function activeJobCount() {
  let count = 0;
  for (const job of jobs.values()) if (job.child) count += 1;
  return count;
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.child && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function snapshot(job) {
  return {
    id: job.id,
    state: job.state,
    detail: job.detail,
    percent: job.percent,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    eta: job.eta,
    filename: job.filename,
    fileSize: job.fileSize,
    notice: job.notice,
    convertPercent: job.convertPercent,
    error: job.error,
  };
}

function emitUpdate(job, force) {
  const now = Date.now();
  if (force || now - job.lastEmit >= EMIT_INTERVAL_MS) {
    if (job.emitTimer) clearTimeout(job.emitTimer);
    job.emitTimer = null;
    job.lastEmit = now;
    job.emitter.emit('update', snapshot(job));
  } else if (!job.emitTimer) {
    job.emitTimer = setTimeout(() => emitUpdate(job, true), EMIT_INTERVAL_MS - (now - job.lastEmit));
  }
}

const PROGRESS_TEMPLATE = [
  '[ldprog] %(progress.status)s',
  '%(progress.downloaded_bytes)s',
  '%(progress.total_bytes)s',
  '%(progress.total_bytes_estimate)s',
  '%(progress.speed)s',
  '%(progress.eta)s',
  '%(progress.fragment_index)s',
  '%(progress.fragment_count)s',
  '%(info.format_id)s',
].join('|');

const H264 = "[vcodec~='^(avc|h264)']";
const AAC = "[acodec~='^(mp4a|aac)']";
const VIDEO_FORMAT_SELECTOR = [
  `bv*${H264}+ba${AAC}`,
  `bv*${H264}+ba`,
  `b${H264}`,
  'bv*+ba',
  'b',
].join('/');

function buildDownloadArgs(job) {
  const args = [
    ...ytdlpBaseArgs(),
    '--playlist-items', '1',
    '--newline',
    '--progress',
    '--no-mtime',
    // Produce names that are valid on every OS (no reserved characters).
    '--windows-filenames',
    // Finished files land in downloads/, intermediate files in a per-job
    // temp folder that is removed afterwards.
    '-P', `home:${DOWNLOADS_DIR}`,
    '-P', `temp:${job.tempDir}`,
    '--progress-template', `download:${PROGRESS_TEMPLATE}`,
    '--progress-template', 'postprocess:[ldpp] %(progress.status)s|%(progress.postprocessor)s',
    '--print', 'video:[ldfmt] %(format_id)s|%(requested_formats.:.{format_id,filesize,filesize_approx,tbr,vcodec})j',
    '--print', 'after_move:[ldfile] %(filepath)s',
  ];

  if (job.mode === 'video') {
    // Prefer H.264 video with AAC audio (plays in QuickTime and everywhere),
    // at the highest resolution up to the chosen quality. Sites without
    // H.264 fall back to the best stream, which convertForCompatibility()
    // turns into H.264/AAC afterwards.
    const sort = job.quality === 'best' ? 'res,ext:mp4:m4a' : `res:${job.quality},ext:mp4:m4a`;
    args.push(
      '-f', VIDEO_FORMAT_SELECTOR,
      '-S', sort,
      '--merge-output-format', 'mp4',
      '-o', '%(title).150B (%(height&{}p|video)s) [%(id)s].%(ext)s',
    );
  } else {
    const isMp3 = job.audioFormat === 'mp3';
    args.push(
      '-f', isMp3 ? 'ba/b' : 'ba[ext=m4a]/ba/b',
      '-x',
      '--audio-format', job.audioFormat,
      '--audio-quality', isMp3 ? '0' : '192K',
      '--embed-metadata',
      '-o', '%(title).150B [%(id)s].%(ext)s',
    );
  }

  args.push('--', job.url);
  return args;
}

function setupParts(job, payload) {
  const sep = payload.indexOf('|');
  const formatId = sep === -1 ? payload : payload.slice(0, sep);
  let requested = [];
  try {
    requested = JSON.parse(payload.slice(sep + 1));
  } catch {
    requested = [];
  }

  let parts;
  if (Array.isArray(requested) && requested.length > 0) {
    parts = requested.map((f) => ({
      id: String(f.format_id),
      kind: f.vcodec && f.vcodec !== 'none' ? 'video' : 'audio',
      size: toNumber(f.filesize) || toNumber(f.filesize_approx),
      tbr: toNumber(f.tbr),
    }));
  } else {
    parts = [{ id: formatId, kind: job.mode === 'audio' ? 'audio' : 'video', size: null, tbr: null }];
  }

  // Weight each stream by its size (or bitrate) so overall progress moves
  // smoothly across the video and audio downloads.
  const bySize = parts.every((p) => p.size);
  const byRate = parts.every((p) => p.tbr);
  for (const part of parts) {
    part.weight = bySize ? part.size : byRate ? part.tbr : 1;
    part.fraction = 0;
    part.downloaded = 0;
    part.total = bySize ? part.size : null;
    part.done = false;
  }
  job.parts = parts;
}

function handleProgress(job, payload) {
  const [status, downloaded, total, estimate, speed, eta, fragIndex, fragCount, formatId] = payload.split('|');

  if (job.parts.length === 0) {
    job.parts = [{ id: formatId, kind: job.mode, weight: 1, fraction: 0, downloaded: 0, total: null, done: false }];
  }
  let index = job.parts.findIndex((p) => p.id === formatId);
  if (index === -1) index = Math.max(0, job.parts.findIndex((p) => !p.done));
  const part = job.parts[index];

  const downloadedBytes = toNumber(downloaded);
  const totalBytes = toNumber(total) || toNumber(estimate);
  if (downloadedBytes !== null) part.downloaded = downloadedBytes;
  if (totalBytes) part.total = totalBytes;

  if (status === 'finished') {
    part.done = true;
    part.fraction = 1;
    if (downloadedBytes) part.total = downloadedBytes;
  } else if (downloadedBytes !== null && totalBytes) {
    part.fraction = clamp(downloadedBytes / totalBytes, 0, 1);
  } else {
    const fi = toNumber(fragIndex);
    const fc = toNumber(fragCount);
    if (fi !== null && fc) part.fraction = clamp(fi / fc, 0, 1);
  }

  const totalWeight = job.parts.reduce((sum, p) => sum + p.weight, 0) || 1;
  const overall = job.parts.reduce((sum, p) => sum + p.weight * p.fraction, 0) / totalWeight;
  // Size estimates wobble; never let the bar move backwards.
  job.percent = Math.max(job.percent || 0, Math.min(100, Math.round(overall * 1000) / 10));

  job.downloadedBytes = job.parts.reduce((sum, p) => sum + (p.downloaded || 0), 0);
  job.totalBytes = job.parts.every((p) => p.total) ? job.parts.reduce((sum, p) => sum + p.total, 0) : null;
  job.speed = status === 'finished' ? null : toNumber(speed);
  job.eta = status === 'finished' ? null : toNumber(eta);

  job.state = 'downloading';
  job.detail = job.parts.length > 1
    ? `${part.kind === 'video' ? 'Video' : 'Audio'} stream, ${index + 1} of ${job.parts.length}`
    : null;
  emitUpdate(job, status === 'finished');
}

function handlePostprocess(job, payload) {
  const [status, name] = payload.split('|');
  if (status !== 'started') return;
  job.state = 'processing';
  job.percent = 100;
  job.speed = null;
  job.eta = null;
  job.detail = POSTPROCESSOR_LABELS[name] || (name && name.startsWith('Fixup') ? 'Fixing up the file' : 'Processing');
  emitUpdate(job, true);
}

function handleJobLine(job, line, source) {
  if (line.startsWith('[ldprog] ')) return handleProgress(job, line.slice(9));
  if (line.startsWith('[ldpp] ')) return handlePostprocess(job, line.slice(7));
  if (line.startsWith('[ldfmt] ')) return setupParts(job, line.slice(8));
  if (line.startsWith('[ldfile] ')) {
    job.filepath = line.slice(9).trim();
    return undefined;
  }
  if (source === 'stderr') {
    job.stderrTail.push(line);
    if (job.stderrTail.length > 60) job.stderrTail.shift();
  }
  log(`yt-dlp`, `${job.id.slice(0, 8)} ${line}`);
  return undefined;
}

// --- Filenames -------------------------------------------------------------

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Makes a filename safe on every common filesystem. */
function sanitizeFilename(name) {
  const rawExt = path.extname(name);
  const ext = /^\.[a-z0-9]{1,10}$/i.test(rawExt) ? rawExt.toLowerCase() : '';
  let stem = rawExt ? name.slice(0, -rawExt.length) : name;
  stem = stem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (!stem) stem = 'download';
  if (RESERVED_WINDOWS_NAMES.test(stem)) stem = `_${stem}`;
  return `${stem}${ext}`;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate) && i < 1000; i += 1) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

function realDownloadsDir() {
  try {
    return fs.realpathSync(DOWNLOADS_DIR);
  } catch {
    return DOWNLOADS_DIR;
  }
}

/** True only for an existing regular file directly inside downloads/. */
function isSafeDownloadPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return false;
  }
  const relative = path.relative(realDownloadsDir(), real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (relative.includes(path.sep) || relative.includes('/')) return false;
  try {
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

function finalizeFile(job) {
  let filePath = job.filepath;
  if (!isSafeDownloadPath(filePath)) {
    logError('download', `${job.id.slice(0, 8)} output file not found or outside downloads/: ${filePath || '(none reported)'}`);
    return false;
  }

  const currentName = path.basename(filePath);
  const safeName = sanitizeFilename(currentName);
  if (safeName !== currentName) {
    const target = uniquePath(path.dirname(filePath), safeName);
    try {
      fs.renameSync(filePath, target);
      filePath = target;
    } catch (err) {
      logError('download', `could not rename "${currentName}"`, err.message);
    }
  }

  job.filepath = fs.realpathSync(filePath);
  job.filename = path.basename(job.filepath);
  job.fileSize = fs.statSync(job.filepath).size;
  return true;
}

function removeTempDir(job) {
  fs.rm(job.tempDir, { recursive: true, force: true }, (err) => {
    if (err) logError('cleanup', `could not remove ${job.tempDir}`, err.message);
  });
}

function startJob(job) {
  const args = buildDownloadArgs(job);
  fs.mkdirSync(job.tempDir, { recursive: true });
  log('download', `${job.id.slice(0, 8)} ${job.mode === 'video' ? `video/${job.quality}` : `audio/${job.audioFormat}`} ${job.url}`);

  let child;
  try {
    child = spawn(YTDLP_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv(),
      cwd: DOWNLOADS_DIR,
    });
  } catch (err) {
    failJob(job, err.code === 'ENOENT' ? MESSAGES.ytdlpMissing : MESSAGES.internal, err.message);
    return;
  }
  job.child = child;

  readLines(child.stdout, (line) => handleJobLine(job, line, 'stdout'));
  readLines(child.stderr, (line) => handleJobLine(job, line, 'stderr'));

  child.on('error', (err) => {
    if (err.code === 'ENOENT') markMissing('ytdlp');
    job.child = null;
    removeTempDir(job);
    failJob(job, err.code === 'ENOENT' ? MESSAGES.ytdlpMissing : MESSAGES.internal, err.message);
  });

  child.on('close', (code, signal) => {
    if (!job.child) return; // already handled by 'error'
    job.child = null;
    removeTempDir(job);

    if (job.cancelled) {
      job.state = 'cancelled';
      job.detail = null;
      job.finishedAt = Date.now();
      log('download', `${job.id.slice(0, 8)} cancelled`);
      emitUpdate(job, true);
      return;
    }

    if (code === 0 && finalizeFile(job)) {
      completeJob(job).catch((err) => failJob(job, MESSAGES.internal, err.stack));
      return;
    }

    const stderr = job.stderrTail.join('\n');
    const message = code === 0
      ? 'The download finished, but the file could not be found in the downloads folder.'
      : friendlyYtDlpError(stderr, 'download');
    if (message === MESSAGES.ffmpegMissing) markMissing('ffmpeg');
    failJob(job, message, `yt-dlp exited with code ${code}${signal ? ` (signal ${signal})` : ''}\n${stderr}`);
  });

  job.state = 'preparing';
  emitUpdate(job, true);
}

async function completeJob(job) {
  if (job.mode === 'video') await convertForCompatibility(job);
  if (job.cancelled) {
    // Remove the unconverted file, unless it existed before this job
    // (yt-dlp reuses existing files without downloading anything).
    if (job.downloadedBytes && isSafeDownloadPath(job.filepath)) fs.rmSync(job.filepath, { force: true });
    job.state = 'cancelled';
    job.detail = null;
    job.finishedAt = Date.now();
    log('download', `${job.id.slice(0, 8)} cancelled during conversion`);
    emitUpdate(job, true);
    return;
  }
  job.state = 'complete';
  job.detail = null;
  job.percent = 100;
  job.speed = null;
  job.eta = null;
  job.finishedAt = Date.now();
  log('download', `${job.id.slice(0, 8)} complete: ${job.filename}`);
  emitUpdate(job, true);
}

function failJob(job, message, detail) {
  if (job.state === 'error') return;
  job.state = 'error';
  job.error = message;
  job.detail = null;
  job.speed = null;
  job.eta = null;
  job.finishedAt = Date.now();
  logError('download', `${job.id.slice(0, 8)} failed: ${message}`, detail);
  emitUpdate(job, true);
}

// ---------------------------------------------------------------------------
// QuickTime compatibility
// ---------------------------------------------------------------------------

// QuickTime (and iPhone/iPad, Windows Photos, most TVs) play H.264 or HEVC
// video with AAC/MP3/ALAC audio in MP4. Many sites serve their best streams
// as VP9/AV1 with Opus, which needs converting.
const COMPATIBLE_AUDIO = new Set(['aac', 'mp3', 'alac']);

/** Reads the codecs of a media file from `ffmpeg -i` output. */
function probeMedia(file) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(FFMPEG_BIN, ['-hide_banner', '-nostdin', '-i', file], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (output.length < 256 * 1024) output += chunk;
    });
    child.on('error', () => resolve(null));
    // ffmpeg exits non-zero here ("no output file"); the stream info is what we want.
    child.on('close', () => {
      const lines = output.split(/\r?\n/);
      const find = (type) => {
        const line = lines.find((l) => /Stream #\S+/.test(l) && l.includes(`: ${type}: `) && !l.includes('attached pic'));
        if (!line) return null;
        const codec = (line.match(new RegExp(`${type}: ([A-Za-z0-9_]+)`)) || [])[1];
        return codec ? { codec: codec.toLowerCase(), line } : null;
      };
      const d = output.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve({
        video: find('Video'),
        audio: find('Audio'),
        duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
      });
    });
  });
}

function planConversion(info, ext) {
  const { video, audio } = info;
  const unsupportedH264 = /10le|12le|high 10|high 4:4:4|high 4:2:2|yuv444|yuv422/i;

  let videoArgs;
  if (video.codec === 'h264' && !unsupportedH264.test(video.line)) {
    videoArgs = ['-c:v', 'copy'];
  } else if (video.codec === 'hevc' && !/yuv4(44|22)/i.test(video.line)) {
    // HEVC plays in QuickTime when tagged hvc1; this is a fast copy.
    videoArgs = /\bhvc1\b/.test(video.line) ? ['-c:v', 'copy'] : ['-c:v', 'copy', '-tag:v', 'hvc1'];
  } else {
    videoArgs = [
      '-c:v', 'libx264', '-preset', 'faster', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    ];
  }
  const audioArgs = !audio || COMPATIBLE_AUDIO.has(audio.codec)
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '192k'];

  const reencode = videoArgs[1] !== 'copy' || audioArgs[1] !== 'copy';
  const needed = reencode || videoArgs.includes('-tag:v') || ext !== '.mp4';
  return { needed, reencode, videoArgs, audioArgs };
}

const CONVERT_FAILED_NOTICE = 'Saved, but it could not be converted for QuickTime. It will play in VLC or IINA.';

/**
 * Makes sure a finished video plays in QuickTime. Files that are already
 * H.264/HEVC + AAC in MP4 are left untouched. Never throws: if conversion
 * fails, the original file is kept and the user gets a note.
 */
async function convertForCompatibility(job) {
  const info = await probeMedia(job.filepath);
  if (!info || !info.video) {
    if (!info) log('convert', `${job.id.slice(0, 8)} could not inspect ${job.filename}; leaving it as is`);
    return;
  }

  const ext = path.extname(job.filepath).toLowerCase();
  const plan = planConversion(info, ext);
  log('convert', `${job.id.slice(0, 8)} video=${info.video.codec} audio=${info.audio ? info.audio.codec : 'none'} ${ext}`);
  if (!plan.needed) return;

  const label = plan.reencode ? 'Converting for QuickTime' : 'Preparing for QuickTime';
  job.state = 'processing';
  job.detail = label;
  job.convertPercent = plan.reencode && info.duration ? 0 : null;
  emitUpdate(job, true);

  fs.mkdirSync(job.tempDir, { recursive: true });
  const tempOut = path.join(job.tempDir, 'converted.mp4');
  const args = [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', job.filepath,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...plan.videoArgs,
    ...plan.audioArgs,
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    tempOut,
  ];

  log('convert', `${job.id.slice(0, 8)} ${plan.reencode ? 're-encoding to H.264/AAC' : 'remuxing to MP4'}`);
  const result = await new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, stderr: err.message });
      return;
    }
    job.child = child; // lets Cancel and shutdown stop the conversion
    readLines(child.stdout, (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && job.convertPercent !== null) {
        job.convertPercent = Math.round(clamp(Number(m[1]) / 1e6 / info.duration, 0, 1) * 1000) / 10;
        emitUpdate(job, false);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 32 * 1024) stderr += chunk;
    });
    child.on('error', (err) => resolve({ ok: false, stderr: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, stderr }));
  });
  job.child = null;
  job.convertPercent = null;

  if (job.cancelled || !result.ok) {
    removeTempDir(job);
    if (!job.cancelled) {
      logError('convert', `${job.id.slice(0, 8)} conversion failed; keeping the original file`, result.stderr);
      job.notice = CONVERT_FAILED_NOTICE;
    }
    return;
  }

  try {
    const stem = path.basename(job.filepath, path.extname(job.filepath));
    // Same title, id and quality means the same video, so replacing is safe.
    const target = path.join(path.dirname(job.filepath), `${stem}.mp4`);
    fs.renameSync(tempOut, target);
    if (target !== job.filepath) fs.rmSync(job.filepath, { force: true });
    job.filepath = fs.realpathSync(target);
    job.filename = path.basename(job.filepath);
    job.fileSize = fs.statSync(job.filepath).size;
    if (plan.reencode) job.notice = 'Converted to H.264 so it plays in QuickTime.';
    log('convert', `${job.id.slice(0, 8)} done: ${job.filename}`);
  } catch (err) {
    logError('convert', `${job.id.slice(0, 8)} could not replace the original file`, err.message);
    job.notice = CONVERT_FAILED_NOTICE;
  } finally {
    removeTempDir(job);
  }
}

// ---------------------------------------------------------------------------
// Opening files with the operating system
// ---------------------------------------------------------------------------

function openWithSystem(action, target) {
  let command;
  let args;
  const options = { stdio: 'ignore', detached: true };

  if (process.platform === 'darwin') {
    command = 'open';
    args = action === 'reveal' ? ['-R', target] : [target];
  } else if (process.platform === 'win32') {
    command = 'explorer.exe';
    // Windows paths cannot contain double quotes, so quoting here is safe.
    args = action === 'reveal' ? [`/select,"${target}"`] : [`"${target}"`];
    options.windowsVerbatimArguments = true;
  } else {
    command = 'xdg-open';
    args = [action === 'reveal' ? path.dirname(target) : target];
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, options);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (err) reject(err);
      else resolve();
    };
    // Launchers exit quickly; if one is still running after a moment the
    // file manager / app has started.
    const timer = setTimeout(() => done(), 2500);
    child.on('error', (err) => done(err));
    child.on('exit', (code) => {
      // explorer.exe returns 1 even on success.
      if (code === 0 || process.platform === 'win32') done();
      else done(new Error(`${command} exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

// Only answer requests addressed to this machine (blocks DNS rebinding) and
// reject state-changing requests coming from other websites.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      if (!originHost || !ALLOWED_HOSTS.has(originHost)) {
        sendError(res, 403, 'Requests from other websites are not allowed.', 'forbidden');
        return;
      }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      sendError(res, 403, 'Requests from other websites are not allowed.', 'forbidden');
      return;
    }
  }
  next();
});

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
});

app.use(express.json({ limit: '16kb' }));

// --- Status ----------------------------------------------------------------

app.get('/api/status', asyncRoute(async (req, res) => {
  const deps = await getDependencies();
  res.set('Cache-Control', 'no-store').json({
    ytdlp: { installed: deps.ytdlp.installed, version: deps.ytdlp.version },
    ffmpeg: { installed: deps.ffmpeg.installed, version: deps.ffmpeg.version },
    messages: {
      ytdlp: deps.ytdlp.installed ? null : MESSAGES.ytdlpMissing,
      ffmpeg: deps.ffmpeg.installed ? null : MESSAGES.ffmpegMissing,
    },
  });
}));

// --- Analyze ---------------------------------------------------------------

app.post('/api/analyze', asyncRoute(async (req, res) => {
  const url = normalizeUrl(req.body && req.body.url);
  if (!url) return sendError(res, 400, MESSAGES.invalidUrl, 'invalid_url');

  const deps = await getDependencies();
  if (!deps.ytdlp.installed) return sendError(res, 503, MESSAGES.ytdlpMissing, 'ytdlp_missing');

  log('analyze', url);
  const args = [
    ...ytdlpBaseArgs(),
    '--flat-playlist',
    '--skip-download',
    '--dump-single-json',
    '--no-warnings',
    '--',
    url,
  ];
  const result = await runCapture(YTDLP_BIN, args, ANALYZE_TIMEOUT_MS);

  if (result.spawnError) {
    if (result.spawnError.code === 'ENOENT') {
      markMissing('ytdlp');
      return sendError(res, 503, MESSAGES.ytdlpMissing, 'ytdlp_missing');
    }
    logError('analyze', 'could not start yt-dlp', result.spawnError.stack);
    return sendError(res, 500, MESSAGES.internal, 'internal');
  }
  if (result.timedOut) {
    logError('analyze', `timed out after ${ANALYZE_TIMEOUT_MS / 1000}s`, result.stderr);
    return sendError(res, 504, 'Retrieving media information took too long. Check your connection and try again.', 'timeout');
  }
  if (result.overflow) {
    logError('analyze', 'yt-dlp output exceeded the size limit');
    return sendError(res, 422, MESSAGES.retrieveFailed, 'retrieve_failed');
  }
  if (result.code !== 0) {
    logError('analyze', `yt-dlp exited with code ${result.code}`, result.stderr);
    return sendError(res, 422, friendlyYtDlpError(result.stderr, 'analyze'), 'retrieve_failed');
  }

  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch (err) {
    logError('analyze', 'could not parse yt-dlp output', err.message);
    return sendError(res, 422, MESSAGES.retrieveFailed, 'retrieve_failed');
  }
  if (!info || typeof info !== 'object') return sendError(res, 422, MESSAGES.retrieveFailed, 'retrieve_failed');

  if (info._type === 'playlist' || info._type === 'multi_video') {
    return sendError(res, 422, 'This link points to a playlist. Paste a link to a single video instead.', 'playlist');
  }
  if (info.is_live || info.live_status === 'is_live') {
    return sendError(res, 422, 'Live streams are not supported. Try again after the stream has ended.', 'live');
  }
  if (info.live_status === 'is_upcoming') {
    return sendError(res, 422, 'This stream or premiere has not started yet.', 'upcoming');
  }

  const summary = summarizeInfo(info, url);
  if (!summary.hasVideo && !summary.hasAudio) {
    return sendError(res, 422, MESSAGES.retrieveFailed, 'no_formats');
  }
  log('analyze', `ok: "${summary.title}" (${summary.resolutions.map((r) => `${r}p`).join(', ') || 'no video'})`);
  return res.json(summary);
}));

// --- Thumbnails (proxied so the page only ever talks to localhost) --------

app.get('/api/thumbnail/:id', asyncRoute(async (req, res) => {
  const entry = isValidId(req.params.id) ? analyses.get(req.params.id) : null;
  if (!entry || !entry.thumbnailUrl) return res.status(404).end();

  if (!entry.thumbnail) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), THUMBNAIL_TIMEOUT_MS);
    try {
      const upstream = await fetch(entry.thumbnailUrl, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LocalDownloader/1.0)',
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        },
      });
      const type = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const declared = Number(upstream.headers.get('content-length'));
      if (!upstream.ok || !THUMBNAIL_TYPES.has(type) || declared > MAX_THUMBNAIL_BYTES) {
        log('thumbnail', `skipped (${upstream.status} ${type || 'unknown type'})`);
        return res.status(404).end();
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > MAX_THUMBNAIL_BYTES) return res.status(404).end();
      entry.thumbnail = { type, body };
    } catch (err) {
      log('thumbnail', `could not fetch thumbnail: ${err.message}`);
      return res.status(404).end();
    } finally {
      clearTimeout(timer);
    }
  }

  return res
    .set({ 'Content-Type': entry.thumbnail.type, 'Cache-Control': 'private, max-age=3600' })
    .send(entry.thumbnail.body);
}));

// --- Download --------------------------------------------------------------

app.post('/api/download', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const url = normalizeUrl(body.url);
  if (!url) return sendError(res, 400, MESSAGES.invalidUrl, 'invalid_url');

  const mode = MODES.has(body.mode) ? body.mode : null;
  const quality = body.quality === undefined ? 'best' : String(body.quality);
  const audioFormat = body.audioFormat === undefined ? 'mp3' : String(body.audioFormat);
  if (!mode || !VIDEO_QUALITIES.has(quality) || !AUDIO_FORMATS.has(audioFormat)) {
    return sendError(res, 400, MESSAGES.invalidRequest, 'invalid_options');
  }

  const deps = await getDependencies();
  if (!deps.ytdlp.installed) return sendError(res, 503, MESSAGES.ytdlpMissing, 'ytdlp_missing');
  if (!deps.ffmpeg.installed) return sendError(res, 503, MESSAGES.ffmpegMissing, 'ffmpeg_missing');

  pruneJobs();
  if (activeJobCount() >= MAX_ACTIVE_DOWNLOADS) {
    return sendError(res, 429, 'Too many downloads are running. Wait for one to finish and try again.', 'busy');
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    url,
    mode,
    quality,
    audioFormat,
    tempDir: path.join(TEMP_ROOT, id),
    state: 'preparing',
    detail: null,
    percent: 0,
    downloadedBytes: null,
    totalBytes: null,
    speed: null,
    eta: null,
    filename: null,
    fileSize: null,
    notice: null,
    convertPercent: null,
    filepath: null,
    error: null,
    parts: [],
    stderrTail: [],
    cancelled: false,
    child: null,
    createdAt: Date.now(),
    finishedAt: null,
    emitter: new EventEmitter(),
    lastEmit: 0,
    emitTimer: null,
  };
  job.emitter.setMaxListeners(20);
  jobs.set(id, job);

  try {
    startJob(job);
  } catch (err) {
    failJob(job, MESSAGES.internal, err.stack);
  }
  return res.status(202).json(snapshot(job));
}));

function getJob(req, res) {
  const job = isValidId(req.params.id) ? jobs.get(req.params.id) : null;
  if (!job) sendError(res, 404, MESSAGES.notFound, 'not_found');
  return job;
}

app.get('/api/download/:id', (req, res) => {
  const job = getJob(req, res);
  if (job) res.set('Cache-Control', 'no-store').json(snapshot(job));
});

// Server-sent events stream with live progress for one job.
app.get('/api/download/:id/events', (req, res) => {
  const job = getJob(req, res);
  if (!job) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(snapshot(job));

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  job.emitter.on('update', send);
  req.on('close', () => {
    clearInterval(heartbeat);
    job.emitter.off('update', send);
  });
});

app.post('/api/download/:id/cancel', (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  if (job.child) {
    job.cancelled = true;
    job.detail = 'Cancelling';
    emitUpdate(job, true);
    job.child.kill();
  }
  res.json(snapshot(job));
});

async function handleOpen(req, res, action) {
  const job = getJob(req, res);
  if (!job) return;
  if (job.state !== 'complete' || !isSafeDownloadPath(job.filepath)) {
    sendError(res, 404, 'The file is no longer in the downloads folder.', 'file_missing');
    return;
  }
  try {
    await openWithSystem(action, job.filepath);
    res.json({ ok: true });
  } catch (err) {
    logError('open', `could not ${action} ${job.filepath}`, err.message);
    sendError(res, 500, 'Your system could not open the file browser. The file is in the downloads folder.', 'open_failed');
  }
}

app.post('/api/download/:id/reveal', asyncRoute((req, res) => handleOpen(req, res, 'reveal')));
app.post('/api/download/:id/open', asyncRoute((req, res) => handleOpen(req, res, 'open')));

app.post('/api/open-downloads', asyncRoute(async (req, res) => {
  try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    // Opening the folder itself: "open" on a directory shows it.
    await openWithSystem('open', DOWNLOADS_DIR);
    res.json({ ok: true });
  } catch (err) {
    logError('open', 'could not open downloads folder', err.message);
    sendError(res, 500, 'Your system could not open the downloads folder.', 'open_failed');
  }
}));

app.use('/api', (req, res) => sendError(res, 404, 'Not found.', 'not_found'));

// --- Static frontend -------------------------------------------------------

app.use(express.static(PUBLIC_DIR, {
  dotfiles: 'ignore',
  index: 'index.html',
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// Last-resort error handler: log details, never send stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return sendError(res, 400, MESSAGES.invalidRequest, 'bad_json');
  if (err && err.type === 'entity.too.large') return sendError(res, 413, MESSAGES.invalidRequest, 'too_large');
  logError('server', `${req.method} ${req.originalUrl} failed`, err && err.stack);
  if (res.headersSent) return res.end();
  return sendError(res, 500, MESSAGES.internal, 'internal');
});

// ---------------------------------------------------------------------------
// Startup & shutdown
// ---------------------------------------------------------------------------

function printBanner(deps) {
  const line = (label, value) => console.log(`  ${label.padEnd(11)} ${value}`);
  console.log('');
  console.log('  Local Downloader');
  console.log('  ' + '-'.repeat(44));
  line('Running at', APP_URL);
  line('Downloads', DOWNLOADS_DIR);
  line('yt-dlp', deps.ytdlp.installed ? deps.ytdlp.version || 'installed' : 'NOT FOUND - install it, then restart');
  line('ffmpeg', deps.ffmpeg.installed ? deps.ffmpeg.version || 'installed' : 'NOT FOUND - install it, then restart');
  console.log('');
  if (!deps.ytdlp.installed) console.log(`  ${MESSAGES.ytdlpMissing}`);
  if (!deps.ffmpeg.installed) console.log(`  ${MESSAGES.ffmpegMissing}`);
  if (!deps.ytdlp.installed || !deps.ffmpeg.installed) console.log('  See README.md for setup instructions.\n');
  console.log('  Local only: listening on 127.0.0.1.');
  console.log('  Keep this window open while you use the app. Close it (or press Ctrl+C) to stop.\n');
}

function openBrowser() {
  openWithSystem('open', APP_URL).catch((err) => {
    log('browser', `could not open a browser automatically (${err.message}). Open ${APP_URL} yourself.`);
  });
}

/** True when the app on this port is already a running Local Downloader. */
async function isAlreadyRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    return Boolean(data && data.ytdlp && data.ffmpeg);
  } catch {
    return false;
  }
}

async function start() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  // Leftovers from an interrupted session are partial files only.
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });

  const deps = await checkDependencies();
  const server = app.listen(PORT, HOST, () => {
    printBanner(deps);
    if (OPEN_BROWSER) openBrowser();
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (await isAlreadyRunning()) {
        // Launched twice: reuse the running app instead of failing.
        console.log(`\n  Local Downloader is already running at ${APP_URL}\n`);
        if (OPEN_BROWSER) {
          await openWithSystem('open', APP_URL).catch(() => {});
        }
        process.exit(0);
      }
      console.error(`\n  Port ${PORT} is already in use by another program. Close it or start with a different port:`);
      console.error(`  PORT=4000 npm start   (Windows PowerShell: $env:PORT=4000; npm start)\n`);
    } else {
      console.error('\n  Could not start the server:', err.message, '\n');
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  Stopping. Cancelling active downloads...');
    for (const job of jobs.values()) {
      if (job.child) {
        job.cancelled = true;
        job.child.kill();
      }
    }
    server.close();
    setTimeout(() => {
      try {
        fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
      } catch {
        // ignore
      }
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Closing the terminal window sends SIGHUP (also emitted on Windows).
  process.on('SIGHUP', shutdown);
}

start().catch((err) => {
  console.error('Failed to start Local Downloader:', err);
  process.exit(1);
});
