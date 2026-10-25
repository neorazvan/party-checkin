(function () {
  'use strict';

  const LIST_KEY = 'partyaccess.list.v1';
  const LOG_KEY = 'partyaccess.log.v2';
  const PHONE_KEY = 'partyaccess.phone.v1';
  const PREFIX = 'PARTY:';
  const SAME_CODE_GAP_MS = 1500;  // a code must leave the camera view this long before it counts again
  const FRAME_INTERVAL_MS = 100;  // ~10 frames per second is plenty and saves battery

  const $ = (id) => document.getElementById(id);
  const els = {
    home: $('home'), scan: $('scan'), fileInput: $('file-input'), btnStart: $('btn-start'),
    btnStop: $('btn-stop'), btnExport: $('btn-export'), btnClear: $('btn-clear'), msg: $('msg'),
    countPill: $('count-pill'), listInfo: $('list-info'), logPill: $('log-pill'), logInfo: $('log-info'),
    btnView: $('btn-view'), listview: $('listview'), rows: $('rows'), listSummary: $('list-summary'),
    listSearch: $('list-search'), btnListBack: $('btn-list-back'),
    phoneName: $('phone-name'), video: $('video'), canvas: $('canvas'), result: $('result'),
    scanInfo: $('scan-info'), sessionCount: $('session-count')
  };

  let codes = null;                 // Map<token, {id, name}>
  let meta = { event: '', count: 0 };
  let log = {};                     // token -> { c: count, f: firstISO, l: lastISO }
  let stream = null, scanning = false, rafId = null, lastFrame = 0;
  let lastKey = null, lastSeenAt = 0;
  let clearArmedUntil = 0;

  // ---------- storage (localStorage; memory fallback if the browser blocks it) ----------
  const memory = {};
  function store(key, value) {
    memory[key] = value;
    try { localStorage.setItem(key, value); } catch (e) { /* keep in memory */ }
  }
  function load(key) {
    try { const v = localStorage.getItem(key); if (v !== null) return v; } catch (e) { /* ignore */ }
    return memory[key] || null;
  }
  function saveLog() { store(LOG_KEY, JSON.stringify(log)); }

  // ---------- guest list ----------
  function parseList(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.codes)) throw new Error('File is not a guest list.');
    const map = new Map();
    data.codes.forEach((c, idx) => {
      if (c && typeof c.t === 'string' && c.t.length >= 8) {
        map.set(c.t, { id: c.i !== undefined ? c.i : idx + 1, name: String(c.n || '') });
      }
    });
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

  // ---------- scan log ----------
  function logTotals() {
    let people = 0, scans = 0;
    for (const t in log) { people += 1; scans += log[t].c; }
    return { people, scans };
  }

  function refreshLogUi() {
    const t = logTotals();
    els.logPill.textContent = t.people + (t.people === 1 ? ' person' : ' people');
    els.logInfo.textContent = t.scans === 0 ? 'Nothing scanned yet.' : t.scans + ' valid scans in total on this phone.';
    els.sessionCount.textContent = t.people + (t.people === 1 ? ' person' : ' people') + ' · ' + t.scans + ' scans';
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function localStamp(iso) {
    const d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function timeOnly(iso) { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function phoneLabel() { return (els.phoneName.value || '').trim() || 'Phone'; }

  // ---------- on-screen list of who has been scanned ----------
  function renderList() {
    const q = (els.listSearch.value || '').trim().toLowerCase();
    const entries = [];
    for (const token in log) {
      const g = codes && codes.get(token);
      entries.push({ id: g ? g.id : '', name: g ? g.name : '(code not in current list)', c: log[token].c, f: log[token].f, l: log[token].l });
    }
    entries.sort((a, b) => (a.l < b.l ? 1 : a.l > b.l ? -1 : 0));   // most recent first
    const t = logTotals();
    els.listSummary.textContent = t.people + (t.people === 1 ? ' person' : ' people') + ' · ' + t.scans + ' scans';
    els.rows.innerHTML = '';
    const shown = entries.filter((e) => !q || e.name.toLowerCase().includes(q));
    if (shown.length === 0) {
      const p = document.createElement('p'); p.className = 'muted';
      p.textContent = entries.length === 0 ? 'Nobody scanned yet.' : 'No match.';
      els.rows.append(p);
      return;
    }
    shown.forEach((e) => {
      const item = document.createElement('div'); item.className = 'item';
      const left = document.createElement('div');
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = e.name;
      const sub = document.createElement('div'); sub.className = 'sub';
      sub.textContent = (e.id !== '' ? '#' + e.id + ' · ' : '') + 'first ' + timeOnly(e.f) + (e.c > 1 ? ' · last ' + timeOnly(e.l) : '');
      left.append(nm, sub);
      const ct = document.createElement('div'); ct.className = 'ct' + (e.c > 1 ? ' multi' : '');
      ct.textContent = '×' + e.c;
      item.append(left, ct);
      els.rows.append(item);
    });
  }
  function showList() { els.home.classList.add('hidden'); els.listview.classList.remove('hidden'); renderList(); }
  function hideList() { els.listview.classList.add('hidden'); els.home.classList.remove('hidden'); }

  function csvCell(v) {
    const s = String(v === undefined || v === null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv() {
    const phone = phoneLabel();
    const rows = [];
    for (const token in log) {
      const g = codes && codes.get(token);
      rows.push({ id: g ? g.id : '', name: g ? g.name : '(code not in current list)',
                  c: log[token].c, f: log[token].f, l: log[token].l });
    }
    rows.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
    const lines = ['id,name,scan_count,first_scan,last_scan,phone'];
    rows.forEach((r) => lines.push([r.id, r.name, r.c, localStamp(r.f), localStamp(r.l), phone].map(csvCell).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function exportFileName() {
    const d = new Date();
    const safe = phoneLabel().replace(/[^A-Za-z0-9_-]+/g, '_');
    return 'scans_' + safe + '_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
           pad(d.getHours()) + pad(d.getMinutes()) + '.csv';
  }

  function exportLog() {
    const t = logTotals();
    if (t.scans === 0) { els.msg.textContent = 'Nothing to export yet.'; return; }
    const csv = buildCsv(), name = exportFileName();
    // Android app: save straight into the Downloads folder through the native bridge
    if (window.AndroidBridge && typeof window.AndroidBridge.saveFile === 'function') {
      const ok = window.AndroidBridge.saveFile(name, csv);
      els.msg.style.color = ok ? 'var(--ok)' : 'var(--bad)';
      els.msg.textContent = ok ? 'Saved to the Downloads folder: ' + name : 'Could not save the file.';
      return;
    }
    // Browser: normal file download
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    els.msg.style.color = 'var(--ok)';
    els.msg.textContent = 'Exported ' + name + ' (check the Downloads folder).';
  }

  function clearLog() {
    // two-tap confirmation (no confirm() dialog, which some webviews swallow)
    if (Date.now() > clearArmedUntil) {
      clearArmedUntil = Date.now() + 4000;
      els.btnClear.textContent = 'Tap again to erase the whole log';
      els.btnClear.classList.add('danger');
      setTimeout(disarmClear, 4000);
      return;
    }
    log = {}; saveLog(); disarmClear(); refreshLogUi();
    els.msg.style.color = 'var(--ok)'; els.msg.textContent = 'Scan log cleared.';
  }
  function disarmClear() {
    clearArmedUntil = 0;
    els.btnClear.textContent = 'Clear scan log';
    els.btnClear.classList.remove('danger');
  }

  // ---------- validation + counting ----------
  function checkPayload(text) {
    if (!codes) return { ok: false, reason: 'No guest list loaded' };
    if (typeof text !== 'string' || !text.startsWith(PREFIX)) return { ok: false, reason: 'Not a party code' };
    const token = text.slice(PREFIX.length);
    const g = codes.get(token);
    if (!g) return { ok: false, reason: 'Code not on the list' };
    return { ok: true, token, name: g.name, id: g.id };
  }

  // Called for every QR code the camera sees. Returns what was shown, or null if ignored as a repeat frame.
  function onDetect(text, now) {
    now = now === undefined ? Date.now() : now;
    const sameAsBefore = text === lastKey && (now - lastSeenAt) < SAME_CODE_GAP_MS;
    lastKey = text; lastSeenAt = now;
    if (sameAsBefore) return null;   // still the same code held in front of the camera

    const r = checkPayload(text);
    if (!r.ok) {
      showResult('invalid', 'NOT ON LIST', r.reason);
      return { kind: 'invalid' };
    }
    const iso = new Date(now).toISOString();
    const entry = log[r.token];
    if (entry) { entry.c += 1; entry.l = iso; } else { log[r.token] = { c: 1, f: iso, l: iso }; }
    saveLog(); refreshLogUi();
    const e = log[r.token];
    if (e.c === 1) {
      showResult('valid', 'VALID', r.name, 'Scan 1');
      return { kind: 'valid', count: 1 };
    }
    showResult('repeat', 'ALREADY SCANNED', r.name, 'Scanned ' + e.c + ' times · first at ' + timeOnly(e.f));
    return { kind: 'repeat', count: e.c };
  }

  window.__partyaccess = { checkPayload, parseList, applyList, onDetect, buildCsv, getLog: () => log };

  // ---------- result display ----------
  let audioCtx = null;
  function beep(freq, len) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = 0.2;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + len);
    } catch (e) { /* no audio */ }
  }

  function showResult(kind, big, name, extra) {
    els.result.className = kind;
    els.result.innerHTML = '';
    const b = document.createElement('div'); b.className = 'big'; b.textContent = big;
    const n = document.createElement('div'); n.className = 'name'; n.textContent = name || '';
    els.result.append(b, n);
    if (extra) {
      const x = document.createElement('div'); x.className = 'name'; x.style.fontSize = '1.05rem'; x.textContent = extra;
      els.result.append(x);
    }
    if (kind === 'valid') { if (navigator.vibrate) navigator.vibrate(80); beep(880, 0.15); }
    else if (kind === 'repeat') { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); beep(520, 0.3); }
    else if (kind === 'invalid') { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); beep(220, 0.4); }
  }

  // ---------- camera ----------
  async function startCamera() {
    els.msg.textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.msg.style.color = 'var(--bad)';
      els.msg.textContent = 'This browser blocks the camera for local files. Use the hosted version or the Android app.';
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (e) {
      els.msg.style.color = 'var(--bad)';
      els.msg.textContent = 'Camera not available (' + (e && e.name ? e.name : 'error') + '). Allow camera access and try again.';
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

  function tick(ts) {
    if (!scanning) return;
    rafId = requestAnimationFrame(tick);
    if (ts - lastFrame < FRAME_INTERVAL_MS) return;
    lastFrame = ts;
    const v = els.video;
    if (v.readyState < 2 || !v.videoWidth) return;

    const ctx = els.canvas.getContext('2d', { willReadFrequently: true });
    const w = Math.min(640, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
    els.canvas.width = w; els.canvas.height = h;
    ctx.drawImage(v, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (code) onDetect(code.data);
  }

  async function startScan() {
    if (!codes) return;
    els.home.classList.add('hidden');
    els.scan.classList.remove('hidden');
    els.scanInfo.textContent = (meta.event || 'Guest list') + ' · ' + phoneLabel();
    showResult('idle', 'READY', 'Point the camera at a QR code');
    lastKey = null; lastSeenAt = 0;
    const ok = await startCamera();
    if (!ok) { backHome(); return; }
    scanning = true;
    rafId = requestAnimationFrame(tick);
  }

  function backHome() {
    stopCamera();
    els.scan.classList.add('hidden');
    els.home.classList.remove('hidden');
    refreshLogUi();
  }

  // ---------- events ----------
  els.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseList(text);
      store(LIST_KEY, text);
      applyList(parsed);
      els.msg.style.color = 'var(--ok)';
      els.msg.textContent = 'Guest list loaded.';
    } catch (err) {
      els.msg.style.color = 'var(--bad)';
      els.msg.textContent = 'Could not load this file: ' + err.message;
    }
    e.target.value = '';
  });
  els.btnStart.addEventListener('click', startScan);
  els.btnStop.addEventListener('click', backHome);
  els.btnExport.addEventListener('click', exportLog);
  els.btnView.addEventListener('click', showList);
  els.btnListBack.addEventListener('click', hideList);
  els.listSearch.addEventListener('input', renderList);
  els.btnClear.addEventListener('click', clearLog);
  els.phoneName.addEventListener('input', () => store(PHONE_KEY, els.phoneName.value));

  // ---------- restore state saved on this phone ----------
  (function restore() {
    const savedPhone = load(PHONE_KEY);
    if (savedPhone) els.phoneName.value = savedPhone;
    try { const t = load(LOG_KEY); if (t) log = JSON.parse(t) || {}; } catch (e) { log = {}; }
    refreshLogUi();

    if (window.EMBEDDED_LIST) {   // single-file / APK build: guest list baked into the file
      try { applyList(parseList(JSON.stringify(window.EMBEDDED_LIST))); return; } catch (e) { /* fall through */ }
    }
    const text = load(LIST_KEY);
    if (!text) return;
    try { applyList(parseList(text)); } catch (e) { /* ignore a corrupt saved copy */ }
  })();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
