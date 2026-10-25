(function () {
  'use strict';

  const STORE_KEY = 'partyaccess.list.v1';
  const PREFIX = 'PARTY:';
  const RESULT_HOLD_MS = 2500;   // how long a result stays on screen before scanning resumes

  const $ = (id) => document.getElementById(id);
  const els = {
    home: $('home'), scan: $('scan'), fileInput: $('file-input'), btnStart: $('btn-start'),
    btnStop: $('btn-stop'), msg: $('msg'), countPill: $('count-pill'), listInfo: $('list-info'),
    video: $('video'), canvas: $('canvas'), result: $('result'), scanInfo: $('scan-info'),
    sessionCount: $('session-count')
  };

  let codes = null;          // Map<token, name>
  let meta = { event: '', count: 0 };
  let stream = null;
  let scanning = false;
  let holdUntil = 0;
  let admitted = 0;
  let rafId = null;

  // ---------- list storage (per phone, localStorage; falls back to memory if blocked) ----------
  let memoryStore = null;
  function saveList(text) {
    memoryStore = text;
    try { localStorage.setItem(STORE_KEY, text); } catch (e) { /* private mode: keep in memory only */ }
  }
  function readList() {
    try { return localStorage.getItem(STORE_KEY) || memoryStore; } catch (e) { return memoryStore; }
  }

  function parseList(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.codes)) throw new Error('File is not a guest list.');
    const map = new Map();
    for (const c of data.codes) {
      if (c && typeof c.t === 'string' && c.t.length >= 8) map.set(c.t, String(c.n || ''));
    }
    if (map.size === 0) throw new Error('The list contains no codes.');
    return { map, meta: { event: String(data.event || ''), count: map.size } };
  }

  function applyList(parsed) {
    codes = parsed.map;
    meta = parsed.meta;
    els.countPill.textContent = meta.count + ' guests';
    els.listInfo.textContent = (meta.event ? meta.event + ' — ' : '') + meta.count + ' codes loaded on this phone.';
    els.btnStart.disabled = false;
    els.msg.textContent = '';
  }

  // ---------- validation (pure function, used by the camera loop and by tests) ----------
  function checkPayload(text) {
    if (!codes) return { ok: false, reason: 'No guest list loaded' };
    if (typeof text !== 'string' || !text.startsWith(PREFIX)) return { ok: false, reason: 'Not a party code' };
    const token = text.slice(PREFIX.length);
    if (!codes.has(token)) return { ok: false, reason: 'Code not on the list' };
    return { ok: true, name: codes.get(token) };
  }
  window.__partyaccess = { checkPayload, parseList, applyList };

  // ---------- UI ----------
  function showResult(kind, big, name) {
    els.result.className = kind;
    els.result.innerHTML = '';
    const b = document.createElement('div'); b.className = 'big'; b.textContent = big;
    const n = document.createElement('div'); n.className = 'name'; n.textContent = name || '';
    els.result.append(b, n);
    holdUntil = Date.now() + RESULT_HOLD_MS;
    if (navigator.vibrate) navigator.vibrate(kind === 'valid' ? 80 : [150, 80, 150]);
    beep(kind === 'valid');
  }

  let audioCtx = null;
  function beep(ok) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = ok ? 880 : 220; g.gain.value = 0.2;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + (ok ? 0.15 : 0.4));
    } catch (e) { /* no audio, that's fine */ }
  }

  // ---------- camera ----------
  async function startCamera() {
    els.msg.textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.msg.textContent = 'This browser blocks the camera for local files. Try opening the file in Chrome, or use the hosted version.';
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (e) {
      els.msg.textContent = 'Camera not available. Allow camera access for this site and try again.';
      return false;
    }
    els.video.srcObject = stream;
    await els.video.play();
    return true;
  }

  function stopCamera() {
    scanning = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    els.video.srcObject = null;
  }

  function tick() {
    if (!scanning) return;
    rafId = requestAnimationFrame(tick);
    const v = els.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    if (Date.now() < holdUntil) return;

    const ctx = els.canvas.getContext('2d', { willReadFrequently: true });
    // downscale for speed; QR codes are big enough at this size
    const w = Math.min(640, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
    els.canvas.width = w; els.canvas.height = h;
    ctx.drawImage(v, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (!code) return;

    const r = checkPayload(code.data);
    if (r.ok) {
      admitted += 1;
      els.sessionCount.textContent = admitted + ' admitted';
      showResult('valid', 'VALID', r.name);
    } else {
      showResult('invalid', 'NOT ON LIST', r.reason);
    }
  }

  async function startScan() {
    if (!codes) return;
    els.home.classList.add('hidden');
    els.scan.classList.remove('hidden');
    els.scanInfo.textContent = meta.event || 'Guest list';
    showResult('idle', 'READY', 'Point the camera at a QR code');
    const ok = await startCamera();
    if (!ok) { backHome(); return; }
    scanning = true;
    holdUntil = 0;
    rafId = requestAnimationFrame(tick);
  }

  function backHome() {
    stopCamera();
    els.scan.classList.add('hidden');
    els.home.classList.remove('hidden');
  }

  // ---------- events ----------
  els.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseList(text);
      saveList(text);
      applyList(parsed);
    } catch (err) {
      els.msg.textContent = 'Could not load this file: ' + err.message;
    }
    e.target.value = '';
  });
  els.btnStart.addEventListener('click', startScan);
  els.btnStop.addEventListener('click', backHome);

  // Restore the list saved on this phone (works with no internet)
  (function restore() {
    if (window.EMBEDDED_LIST) {   // single-file build: the guest list is baked into this file
      try { applyList(parseList(JSON.stringify(window.EMBEDDED_LIST))); return; } catch (e) { /* fall through */ }
    }
    const text = readList();
    if (!text) return;
    try { applyList(parseList(text)); } catch (e) { /* ignore a corrupt saved copy */ }
  })();

  // Service worker: caches the app so it opens with no internet
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
