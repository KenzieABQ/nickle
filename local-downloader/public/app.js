'use strict';

(() => {
  // -------------------------------------------------------------------------
  // Elements
  // -------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  const el = {
    notices: $('notices'),
    form: $('analyze-form'),
    urlInput: $('url-input'),
    urlField: document.querySelector('.url-field'),
    urlError: $('url-error'),
    analyzeBtn: $('analyze-btn'),
    skeleton: $('skeleton'),
    result: $('result'),
    thumb: $('media-thumb'),
    durationBadge: $('media-duration-badge'),
    title: $('media-title'),
    byline: $('media-byline'),
    formats: $('media-formats'),
    configPanel: $('config-panel'),
    qualityField: $('quality-field'),
    audioField: $('audio-field'),
    outputHint: $('output-hint'),
    downloadBtn: $('download-btn'),
    progressPanel: $('progress-panel'),
    progressStatus: $('progress-status'),
    progressPercent: $('progress-percent'),
    progressBar: $('progress-bar'),
    progressFill: $('progress-fill'),
    progressDetail: $('progress-detail'),
    cancelBtn: $('cancel-btn'),
    donePanel: $('done-panel'),
    doneFilename: $('done-filename'),
    doneSize: $('done-size'),
    doneNotice: $('done-notice'),
    doneError: $('done-error'),
    revealBtn: $('reveal-btn'),
    openBtn: $('open-btn'),
    againBtn: $('again-btn'),
    errorPanel: $('error-panel'),
    errorMessage: $('error-message'),
    retryBtn: $('retry-btn'),
    statusDot: $('status-dot'),
    statusText: $('status-text'),
    openFolderBtn: $('open-folder-btn'),
  };

  const SERVER_UNREACHABLE = "Can't reach the local server. Make sure it is still running (npm start), then reload this page.";
  const QUALITY_VALUES = ['1080', '720', '480', '360'];
  const STORAGE_KEY = 'local-downloader:active';

  const state = {
    tools: null,
    analysis: null,
    job: null,
    events: null,
    eventErrors: 0,
    completeTimer: null,
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(SERVER_UNREACHABLE, 0, 'unreachable');
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = (data && data.error) || 'Something went wrong. See the terminal for details.';
      throw new ApiError(message, response.status, data && data.code);
    }
    return data;
  }

  /** Mirrors the server-side check so obvious mistakes fail instantly. */
  function normalizeUrl(value) {
    let candidate = String(value || '').trim();
    if (!candidate || candidate.length > 2048 || /\s/.test(candidate)) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (!url.hostname || (!url.hostname.includes('.') && url.hostname !== 'localhost')) return null;
      if (url.username || url.password) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const total = Math.round(seconds);
    if (total < 60) return `${total}s left`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m < 60) return s ? `${m}m ${s}s left` : `${m}m left`;
    return `${Math.floor(m / 60)}h ${m % 60}m left`;
  }

  function selectedValue(name) {
    const input = document.querySelector(`input[name="${name}"]:checked`);
    return input ? input.value : null;
  }

  function setChecked(name, value) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }

  function showPanel(panel) {
    for (const p of [el.configPanel, el.progressPanel, el.donePanel, el.errorPanel]) {
      p.hidden = p !== panel;
    }
  }

  function saveSession() {
    try {
      if (state.job && state.analysis) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId: state.job.id, analysis: state.analysis }));
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Storage may be unavailable; resuming after reload is a nicety.
    }
  }

  // -------------------------------------------------------------------------
  // Tool status
  // -------------------------------------------------------------------------

  function renderNotice(kind, title, body, action) {
    const notice = document.createElement('div');
    notice.className = `notice notice-${kind}`;
    const content = document.createElement('div');
    content.className = 'notice-body';
    const strong = document.createElement('span');
    strong.className = 'notice-title';
    strong.textContent = title;
    content.append(strong);
    if (body) content.append(document.createTextNode(body));
    notice.append(content);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-text';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      notice.append(button);
    }
    el.notices.append(notice);
  }

  function renderTools() {
    el.notices.replaceChildren();
    const tools = state.tools;
    const recheck = { label: 'Check again', onClick: () => loadStatus() };

    if (!tools) {
      renderNotice('error', "Can't reach the local server.", 'Make sure it is still running (npm start), then reload this page.', { label: 'Retry', onClick: () => loadStatus() });
      el.statusDot.className = 'dot err';
      el.statusText.textContent = 'Server offline';
    } else {
      if (!tools.ytdlp.installed) {
        renderNotice('error', tools.messages.ytdlp, ' See the README for install steps.', recheck);
      }
      if (!tools.ffmpeg.installed) {
        renderNotice('warning', tools.messages.ffmpeg, ' Downloads are disabled until it is available.', recheck);
      }
      const parts = [
        tools.ytdlp.installed ? `yt-dlp ${tools.ytdlp.version || ''}`.trim() : 'yt-dlp missing',
        tools.ffmpeg.installed ? `ffmpeg ${tools.ffmpeg.version || ''}`.trim() : 'ffmpeg missing',
      ];
      el.statusText.textContent = parts.join('  ·  ');
      el.statusDot.className = `dot ${!tools.ytdlp.installed ? 'err' : !tools.ffmpeg.installed ? 'warn' : 'ok'}`;
    }
    updateControls();
  }

  async function loadStatus() {
    try {
      state.tools = await api('/api/status');
    } catch {
      state.tools = null;
    }
    renderTools();
  }

  function toolsReady(tool) {
    return Boolean(state.tools && state.tools[tool] && state.tools[tool].installed);
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  function isJobActive() {
    return Boolean(state.job && ['preparing', 'downloading', 'processing'].includes(state.job.state));
  }

  function updateControls() {
    const active = isJobActive();
    const analyzing = el.analyzeBtn.classList.contains('is-loading');
    el.analyzeBtn.disabled = analyzing || active || !toolsReady('ytdlp');
    el.urlInput.disabled = active;
    el.downloadBtn.disabled = active || !state.analysis || !toolsReady('ytdlp') || !toolsReady('ffmpeg');
    updateHint();
  }

  function updateHint() {
    if (!state.analysis) return;
    if (state.tools && !toolsReady('ffmpeg')) {
      el.outputHint.textContent = 'Install ffmpeg to enable downloads.';
      return;
    }
    const mode = selectedValue('mode');
    if (mode === 'audio') {
      el.outputHint.textContent = selectedValue('audioFormat') === 'm4a'
        ? 'M4A (AAC), saved to the downloads folder'
        : 'MP3, highest quality VBR, saved to the downloads folder';
    } else {
      const quality = selectedValue('quality');
      el.outputHint.textContent = quality === 'best'
        ? 'Highest available resolution, MP4 (H.264) that plays in QuickTime'
        : `Up to ${quality}p, MP4 (H.264) that plays in QuickTime`;
    }
  }

  function updateModeFields() {
    const mode = selectedValue('mode');
    el.qualityField.hidden = mode !== 'video';
    el.audioField.hidden = mode !== 'audio';
    updateHint();
  }

  function setAnalyzing(on) {
    el.analyzeBtn.classList.toggle('is-loading', on);
    el.analyzeBtn.querySelector('.btn-label').textContent = on ? 'Analyzing' : 'Analyze';
    el.skeleton.hidden = !on;
    updateControls();
  }

  function showUrlError(message) {
    el.urlError.textContent = message;
    el.urlError.hidden = false;
    el.urlField.classList.add('is-invalid');
  }

  function clearUrlError() {
    el.urlError.hidden = true;
    el.urlError.textContent = '';
    el.urlField.classList.remove('is-invalid');
  }

  // -------------------------------------------------------------------------
  // Analyze
  // -------------------------------------------------------------------------

  async function analyze(event) {
    event.preventDefault();
    if (isJobActive() || el.analyzeBtn.classList.contains('is-loading')) return;
    clearUrlError();

    const url = normalizeUrl(el.urlInput.value);
    if (!url) {
      showUrlError('Please enter a valid URL.');
      el.urlInput.focus();
      return;
    }

    resetResult();
    setAnalyzing(true);
    try {
      const info = await api('/api/analyze', { method: 'POST', body: { url } });
      state.analysis = info;
      renderResult(info);
    } catch (err) {
      if (err.code === 'ytdlp_missing') loadStatus();
      showUrlError(err.message);
    } finally {
      setAnalyzing(false);
    }
  }

  function resetResult() {
    closeEvents();
    clearTimeout(state.completeTimer);
    state.analysis = null;
    state.job = null;
    saveSession();
    el.result.hidden = true;
    el.thumb.hidden = true;
    el.thumb.removeAttribute('src');
    showPanel(el.configPanel);
    updateControls();
  }

  function renderResult(info) {
    el.title.textContent = info.title;
    el.title.title = info.title;

    const byline = [info.uploader, formatDuration(info.duration), info.site && !['Generic', 'HTML5MediaEmbed'].includes(info.site) ? info.site : null]
      .filter(Boolean);
    el.byline.replaceChildren();
    byline.forEach((text, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '·';
        el.byline.append(sep);
      }
      el.byline.append(document.createTextNode(text));
    });

    const duration = formatDuration(info.duration);
    el.durationBadge.textContent = duration || '';
    el.durationBadge.hidden = !duration;

    const mediaCard = el.thumb.closest('.media-card');
    el.thumb.hidden = true;
    mediaCard.classList.toggle('no-thumb', !info.thumbnail && !duration);
    if (info.thumbnail) {
      el.thumb.onload = () => { el.thumb.hidden = false; };
      el.thumb.onerror = () => {
        el.thumb.hidden = true;
        if (!duration) mediaCard.classList.add('no-thumb');
      };
      el.thumb.src = info.thumbnail;
    }

    // Available qualities.
    el.formats.replaceChildren();
    const tags = (info.resolutions || []).slice(0, 8).map((r) => `${r}p`);
    if (info.hasVideo && tags.length === 0) tags.push('Video');
    if (info.hasAudio) tags.push('Audio');
    for (const text of tags) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = text;
      el.formats.append(tag);
    }

    // Enable only the options this media can actually provide.
    const videoInput = document.querySelector('input[name="mode"][value="video"]');
    const audioInput = document.querySelector('input[name="mode"][value="audio"]');
    videoInput.disabled = !info.hasVideo;
    audioInput.disabled = !info.hasAudio;
    if (!info.hasVideo) audioInput.checked = true;
    else if (!info.hasAudio) videoInput.checked = true;

    for (const value of QUALITY_VALUES) {
      const input = document.querySelector(`input[name="quality"][value="${value}"]`);
      const available = Boolean(info.maxResolution) && info.maxResolution >= Number(value) * 0.9;
      input.disabled = !available;
      input.closest('.seg').title = available ? '' : 'Not available for this media';
      if (!available && input.checked) setChecked('quality', 'best');
    }

    updateModeFields();
    showPanel(el.configPanel);
    el.result.hidden = false;
    updateControls();
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  async function startDownload() {
    if (!state.analysis || isJobActive()) return;
    const body = {
      url: state.analysis.url,
      mode: selectedValue('mode'),
      quality: selectedValue('quality') || 'best',
      audioFormat: selectedValue('audioFormat') || 'mp3',
    };

    el.downloadBtn.disabled = true;
    renderProgress({ state: 'preparing', percent: 0 });
    showPanel(el.progressPanel);

    try {
      const job = await api('/api/download', { method: 'POST', body });
      state.job = job;
      saveSession();
      renderJob(job);
      subscribe(job.id);
    } catch (err) {
      if (err.code === 'ytdlp_missing' || err.code === 'ffmpeg_missing') loadStatus();
      showError(err.message);
    } finally {
      updateControls();
    }
  }

  function subscribe(jobId) {
    closeEvents();
    state.eventErrors = 0;
    const source = new EventSource(`/api/download/${encodeURIComponent(jobId)}/events`);
    state.events = source;

    source.onmessage = (event) => {
      state.eventErrors = 0;
      let snapshot;
      try {
        snapshot = JSON.parse(event.data);
      } catch {
        return;
      }
      state.job = snapshot;
      renderJob(snapshot);
      if (!isJobActive()) {
        closeEvents();
        saveSession();
      }
    };

    source.onerror = () => {
      state.eventErrors += 1;
      // The browser reconnects on its own; give up after repeated failures
      // or when the server refused the stream outright.
      if (source.readyState === EventSource.CLOSED || state.eventErrors >= 5) {
        closeEvents();
        recoverJob(jobId);
      }
    };
  }

  async function recoverJob(jobId) {
    try {
      const snapshot = await api(`/api/download/${encodeURIComponent(jobId)}`);
      state.job = snapshot;
      renderJob(snapshot);
      if (isJobActive()) setTimeout(() => subscribe(jobId), 1500);
    } catch (err) {
      state.job = null;
      saveSession();
      showError(err.code === 'unreachable' ? SERVER_UNREACHABLE : err.message);
    }
  }

  function closeEvents() {
    if (state.events) {
      state.events.close();
      state.events = null;
    }
  }

  function renderJob(job) {
    clearTimeout(state.completeTimer);
    switch (job.state) {
      case 'preparing':
      case 'downloading':
      case 'processing':
        renderProgress(job);
        showPanel(el.progressPanel);
        break;
      case 'complete':
        // Let the bar reach the end before switching to the summary.
        renderProgress(job);
        if (!el.progressPanel.hidden) {
          state.completeTimer = setTimeout(() => renderDone(job), 650);
        } else {
          renderDone(job);
        }
        break;
      case 'cancelled':
        state.job = null;
        saveSession();
        showPanel(el.configPanel);
        el.outputHint.textContent = 'Download cancelled.';
        setTimeout(updateHint, 2500);
        break;
      case 'error':
        state.job = null;
        saveSession();
        showError(job.error);
        break;
      default:
        break;
    }
    updateControls();
  }

  const STATUS_LABELS = {
    preparing: 'Preparing...',
    downloading: 'Downloading...',
    processing: 'Processing...',
    complete: 'Complete',
  };

  function renderProgress(job) {
    const cancelling = job.detail === 'Cancelling';
    // A re-encode for QuickTime reports its own progress.
    const converting = job.state === 'processing' && Number.isFinite(job.convertPercent);
    el.progressStatus.textContent = cancelling
      ? 'Cancelling...'
      : converting ? 'Converting...' : STATUS_LABELS[job.state] || 'Working...';

    const percent = Math.max(0, Math.min(100, Number(converting ? job.convertPercent : job.percent) || 0));
    const shown = job.state === 'complete' ? 100 : percent;
    el.progressPercent.textContent = `${Math.floor(shown)}%`;
    el.progressFill.style.transform = `scaleX(${shown / 100})`;
    el.progressBar.setAttribute('aria-valuenow', String(Math.floor(shown)));

    const indeterminate = job.state === 'preparing' || (job.state === 'processing' && !converting);
    el.progressBar.classList.toggle('is-indeterminate', indeterminate);
    el.progressBar.classList.toggle('is-complete', job.state === 'complete');

    const details = [];
    if (job.state === 'preparing') {
      details.push('Fetching stream information');
    } else if (job.state === 'downloading') {
      if (job.detail) details.push(job.detail);
      const done = formatBytes(job.downloadedBytes);
      const total = formatBytes(job.totalBytes);
      if (done && total) details.push(`${done} of ${total}`);
      else if (done) details.push(`${done} downloaded`);
      const speed = formatBytes(job.speed);
      if (speed) details.push(`${speed}/s`);
      const eta = formatEta(job.eta);
      if (eta) details.push(eta);
    } else if (job.state === 'processing') {
      details.push(job.detail || 'Processing with ffmpeg');
    } else if (job.state === 'complete') {
      details.push('Saved to the downloads folder');
    }
    el.progressDetail.textContent = details.join('  ·  ');

    el.cancelBtn.hidden = job.state === 'complete';
    el.cancelBtn.disabled = cancelling || !state.job;
  }

  function renderDone(job) {
    el.doneFilename.textContent = job.filename || 'Downloaded file';
    el.doneFilename.title = job.filename || '';
    el.doneSize.textContent = formatBytes(job.fileSize) || '';
    el.doneNotice.textContent = job.notice || '';
    el.doneNotice.hidden = !job.notice;
    el.doneError.hidden = true;
    el.revealBtn.disabled = false;
    el.openBtn.disabled = false;
    showPanel(el.donePanel);
  }

  function showError(message) {
    el.errorMessage.textContent = message || 'Something went wrong. See the terminal for details.';
    showPanel(el.errorPanel);
    updateControls();
  }

  async function cancelDownload() {
    if (!state.job) return;
    el.cancelBtn.disabled = true;
    try {
      const snapshot = await api(`/api/download/${encodeURIComponent(state.job.id)}/cancel`, { method: 'POST' });
      state.job = snapshot;
      renderJob(snapshot);
    } catch (err) {
      el.cancelBtn.disabled = false;
      el.progressDetail.textContent = err.message;
    }
  }

  async function openFile(action, button) {
    if (!state.job) return;
    el.doneError.hidden = true;
    button.disabled = true;
    try {
      await api(`/api/download/${encodeURIComponent(state.job.id)}/${action}`, { method: 'POST' });
    } catch (err) {
      el.doneError.textContent = err.message;
      el.doneError.hidden = false;
    } finally {
      setTimeout(() => { button.disabled = false; }, 600);
    }
  }

  function newDownload() {
    resetResult();
    el.urlInput.value = '';
    clearUrlError();
    el.urlInput.focus();
  }

  async function openDownloadsFolder() {
    el.openFolderBtn.disabled = true;
    try {
      await api('/api/open-downloads', { method: 'POST' });
    } catch (err) {
      el.notices.querySelectorAll('.notice-transient').forEach((n) => n.remove());
      renderNotice('warning', err.message, '');
      const notice = el.notices.lastElementChild;
      notice.classList.add('notice-transient');
      setTimeout(() => notice.remove(), 5000);
    } finally {
      setTimeout(() => { el.openFolderBtn.disabled = false; }, 600);
    }
  }

  /** Re-attach to a download that was running before the page reloaded. */
  async function resumeSession() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (!saved || !saved.jobId || !saved.analysis) return;
    try {
      const snapshot = await api(`/api/download/${encodeURIComponent(saved.jobId)}`);
      state.analysis = saved.analysis;
      el.urlInput.value = saved.analysis.url;
      renderResult(saved.analysis);
      state.job = snapshot;
      el.progressPanel.hidden = true;
      renderJob(snapshot);
      if (isJobActive()) subscribe(snapshot.id);
    } catch {
      state.job = null;
      saveSession();
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  el.form.addEventListener('submit', analyze);
  el.urlInput.addEventListener('input', () => {
    if (!el.urlError.hidden) clearUrlError();
  });
  el.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      el.urlInput.value = '';
      clearUrlError();
    }
  });

  document.querySelectorAll('input[name="mode"], input[name="quality"], input[name="audioFormat"]').forEach((input) => {
    input.addEventListener('change', updateModeFields);
  });

  el.downloadBtn.addEventListener('click', startDownload);
  el.cancelBtn.addEventListener('click', cancelDownload);
  el.retryBtn.addEventListener('click', () => {
    state.job = null;
    showPanel(el.configPanel);
    updateControls();
  });
  el.revealBtn.addEventListener('click', () => openFile('reveal', el.revealBtn));
  el.openBtn.addEventListener('click', () => openFile('open', el.openBtn));
  el.againBtn.addEventListener('click', newDownload);
  el.openFolderBtn.addEventListener('click', openDownloadsFolder);

  window.addEventListener('beforeunload', closeEvents);

  loadStatus().then(resumeSession);
  el.urlInput.focus();
})();
