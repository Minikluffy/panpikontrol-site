'use strict';
/*
 * ═══════════════════════════════════════════════════════════════════
 * panpi-phone — Telefon donanım servisi (mikrofon/kamera/hoparlör)
 * Samsung A5 (Termux içinde) üzerinde çalışır, root GEREKMEZ.
 *
 * • Termux:API uygulaması + termux-api paketi şart (kurulum scripti halleder)
 * • Port: 8555 (LAN içi) — token korumalı, kilitli, hız sınırlı
 * • Tüm komutlar termux-api aracılığıyla: mic kayıt, kamera foto,
 *   TTS (hoparlör), medya oynatma, ses seviyesi, flaş, titreşim, pil
 * • Hub'a kendini kaydeder → PC/telefon "telefon nerede?" diye bulur
 * ═══════════════════════════════════════════════════════════════════
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = process.env.HOME || process.env.TERMUX_HOME || '/data/data/com.termux/files/home';
const DATA_DIR = path.join(HOME, 'panpi-hub', 'data');
/* Termux:API uygulaması (com.termux.api) Termux'un data dizinine yazamıyor
 * (farklı UID) → medya dosyaları /sdcard/panpi-media staging'ine yazılır,
 * sonra buraya taşınır. Direct /data yazma denemesi 'Permission denied'. */
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const STAGE_DIR = '/sdcard/panpi-media';
const TOKEN_FILE = path.join(DATA_DIR, 'phone-token');
const HUB_TOKEN_FILE = path.join(DATA_DIR, 'hub-token');
const REG_FILE = path.join(DATA_DIR, 'phone-reg.json');
const PORT = 8555;

for (const d of [DATA_DIR, MEDIA_DIR, STAGE_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }

const started = Date.now();
let token = '';
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}
if (!token) {
  token = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

/* kilit + hız sınırı (hub ile aynı damar) */
const failMap = new Map();
const hitMap = new Map();
function locked(ip) {
  const e = failMap.get(ip);
  return e && e.until > Date.now();
}
function authed(req, ip) {
  const a = req.headers.authorization || '';
  return a === 'Bearer ' + token;
}
function noteFail(ip) {
  const e = failMap.get(ip) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= 5) { e.until = Date.now() + 15 * 60 * 1000; e.n = 0; }
  failMap.set(ip, e);
}
function limited(ip) {
  const h = hitMap.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - h.t > 60000) { h.n = 0; h.t = Date.now(); }
  h.n++;
  hitMap.set(ip, h);
  return h.n > 120;
}
function lanIP() {
  try {
    const out = require('child_process').execSync('ifconfig 2>/dev/null || ip -4 addr 2>/dev/null', { timeout: 2000 }).toString();
    const m = out.match(/inet (?:addr:)?(192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)[0-9.]+/g) || [];
    const ip = m.map(s => s.replace(/inet\s*|addr:/g, '')).find(i => i !== '127.0.0.1');
    if (ip) return ip;
  } catch (_) {}
  return '';
}

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(b);
}
/* termux-api komut çalıştır (sessiz, timeout'lu)
 * Not: süreç root bekçi tarafından başlatıldığında PATH'te Termux yok →
 * komutlar mutlak yol + Termux env ile çalıştırılır. */
const TUX_BIN = '/data/data/com.termux/files/usr/bin';
const TUX_ENV = {
  PATH: TUX_BIN + ':/system/bin',
  PREFIX: '/data/data/com.termux/files/usr',
  HOME: HOME,
  LD_LIBRARY_PATH: '/data/data/com.termux/files/usr/lib',
  TMPDIR: '/data/data/com.termux/files/usr/tmp',
  TERMUX__ROOTFS: '/data/data/com.termux/files',
};
function tuxCmd(cmd) { return cmd.startsWith('termux-') ? path.join(TUX_BIN, cmd) : cmd; }

function run(cmd, args, timeout = 15000) {
  return new Promise(res => {
    execFile(tuxCmd(cmd), args, { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...TUX_ENV } }, (err, stdout, stderr) => {
      if (err) return res({ ok: false, err: String(err.message || err).slice(0, 200), out: String(stdout).slice(0, 400), errOut: String(stderr).slice(0, 400) });
      res({ ok: true, out: String(stdout).slice(0, 4000), errOut: String(stderr).slice(0, 400) });
    });
  });
}
/* termux-microphone-record arka planda kaydetmeye devam eder →
 * dosya boyutu oturana kadar bekle (max ms), sonra döndür. */
function waitStaged(p, maxMs = 12000) {
  return new Promise(res => {
    const t0 = Date.now();
    let last = -1, stable = 0;
    const iv = setInterval(() => {
      let sz = 0;
      try { sz = fs.statSync(p).size; } catch (_) {}
      if (sz > 32 && sz === last) { stable++; if (stable >= 2) { clearInterval(iv); return res(true); } }
      else stable = 0;
      last = sz;
      if (Date.now() - t0 > maxMs) { clearInterval(iv); return res(fs.existsSync(p)); }
    }, 600);
  });
}

function runBg(cmd, args) {
  try {
    const p = execFile(tuxCmd(cmd), args, { detached: true, stdio: 'ignore', env: { ...process.env, ...TUX_ENV } });
    p.unref();
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e).slice(0, 200) }; }
}

let recording = false;

/* Canlı kamera akışı + güvenlik modu (modül seviyesi — request handler içinde
 * tanımlanırsa HER istekte sıfırlanır; bu hatayı iki kez yaptık, bir daha yok). */
const camLive = { running: false, which: 0, buf: null, ts: 0, err: null };
const secGuard = { on: false, threshold: 8, lastAvg: -1, lastEvent: 0, hits: 0, cooldownMs: 30000 };
async function camLoop() {
  while (camLive.running) {
    const staged = path.join(STAGE_DIR, 'live.jpg');
    const r = await run('termux-camera-photo', ['-c', String(camLive.which), staged], 15000);
    if (camLive.running) {
      try {
        if (r.ok && fs.existsSync(staged) && fs.statSync(staged).size > 1024) {
          camLive.buf = fs.readFileSync(staged);
          camLive.ts = Date.now();
          camLive.err = null;
        } else camLive.err = (r.err || 'kare alınamadı').slice(0, 120);
      } catch (e) { camLive.err = String(e).slice(0, 120); }
    }
    await new Promise(r2 => setTimeout(r2, 200));
  }
  try { fs.unlinkSync(path.join(STAGE_DIR, 'live.jpg')); } catch (_) {}
}

function serveFile(res, name) {
  const p = path.join(MEDIA_DIR, path.basename(name));
  if (!fs.existsSync(p)) return send(res, 404, { error: 'yok' });
  const ct = /\.(jpe?g|png)$/i.test(p) ? 'image/jpeg' : /\.(m4a|aac|mp3)$/i.test(p) ? 'audio/mp4' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct, 'Content-Length': fs.statSync(p).size, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/health') return send(res, 200, { ok: true, name: 'panpi-phone', v: 1, up: Math.round((Date.now() - started) / 1000), recording });

  /* token isteyenler — kilitli IP her şeyi reddedilir (doğru token bile) */
  if (locked(ip)) return send(res, 423, { error: 'kilitli' });
  if (!authed(req, ip)) {
    noteFail(ip);
    return send(res, 401, { error: 'yetkisiz' });
  }
  if (limited(ip)) return send(res, 429, { error: 'hız sınırı' });

  /* ── MİKROFON ─────────────────────────────────────────── */
  if (p === '/mic/start' && req.method === 'POST') {
    if (recording) return send(res, 409, { error: 'zaten kayıtta' });
    recording = true;
    runBg('termux-microphone-record', ['-f', path.join(STAGE_DIR, 'mic-live.m4a')]);
    return send(res, 200, { ok: true, msg: 'kayıt başladı' });
  }
  if (p === '/mic/stop' && req.method === 'POST') {
    recording = false;
    await run('termux-microphone-record', ['-q']);
    const staged = path.join(STAGE_DIR, 'mic-live.m4a');
    const f = path.join(MEDIA_DIR, 'mic-live.m4a');
    try { if (fs.existsSync(staged)) fs.copyFileSync(staged, f); } catch (_) {}
    return send(res, 200, { ok: true, file: fs.existsSync(f) ? 'mic-live.m4a' : null });
  }
  if (p === '/mic/snap' && req.method === 'POST') {
    // kısa kayıt: secs saniye sonra otomatik durur
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const secs = Math.min(Math.max(parseInt(j.secs || '5', 10), 1), 60);
        const name = 'mic-' + Date.now() + '.m4a';
        const staged = path.join(STAGE_DIR, name);
        const r = await run('termux-microphone-record', ['-f', staged, '-l', String(secs)], (secs + 8) * 1000);
        if (!r.ok) return send(res, 500, { error: 'mic hatası', err: r.err, out: r.out });
        await waitStaged(staged, (secs + 8) * 1000);
        const full = path.join(MEDIA_DIR, name);
        try { if (fs.existsSync(staged)) fs.copyFileSync(staged, full); } catch (_) {}
        return send(res, 200, { ok: true, file: fs.existsSync(full) ? name : null });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  /* ── KAMERA ───────────────────────────────────────────── */
  if (p === '/cam-live/start' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        camLive.which = String(j.cam || 'back').toLowerCase().startsWith('front') ? 1 : 0;
        if (!camLive.running) { camLive.running = true; camLoop(); }
        return send(res, 200, { ok: true, which: camLive.which });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }
  if (p === '/cam-live/stop' && req.method === 'POST') {
    camLive.running = false;
    return send(res, 200, { ok: true });
  }

  /* ── GÜVENLİK MODU: hareket algılama → foto + hub olayı ──
   * Kaba diferansiyel: iki ardışık karenin boyut farkı eşiği aşarsa hareket var.
   * Eşik 0..100 (varsayılan 8). secGuard modül seviyesinde (yukarıda). */
  function frameAvg(buf) {
    // JPEG'i bytes toplamına göre kaba ölç: parlaklık yerine byte-length delta da
    // sahne değişimini (ışık/hareket) yakalar; decode'dan 10x ucuz.
    return buf.length / 1024; // KB
  }
  setInterval(() => {
    if (!secGuard.on || !camLive.running || !camLive.buf) return;
    const cur = frameAvg(camLive.buf);
    if (secGuard.lastAvg >= 0) {
      const delta = Math.abs(cur - secGuard.lastAvg) / Math.max(1, secGuard.lastAvg) * 100;
      if (delta >= secGuard.threshold && Date.now() - secGuard.lastEvent > secGuard.cooldownMs) {
        secGuard.lastEvent = Date.now();
        secGuard.hits++;
        const name = 'sec-' + Date.now() + '.jpg';
        try {
          fs.copyFileSync(camLive.buf ? path.join(STAGE_DIR, 'live.jpg') : '', path.join(MEDIA_DIR, name));
        } catch (_) {
          try { fs.writeFileSync(path.join(MEDIA_DIR, name), camLive.buf); } catch (_) {}
        }
        // hub'a olay (token dosyadan)
        try {
          const ht = fs.readFileSync(HUB_TOKEN_FILE, 'utf8').trim();
          const data = JSON.stringify({ type: 'motion', detail: 'delta%' + delta.toFixed(1) + ' kare:' + name, from: 'a5' });
          require('http').request({ host: '127.0.0.1', port: 8443, path: '/event', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ht, 'content-length': Buffer.byteLength(data) } }).on('error', () => {}).end(data);
        } catch (_) {}
      }
    }
    secGuard.lastAvg = cur;
  }, 4000);
  if (p === '/cam-live' && req.method === 'GET') {
    if (!camLive.buf || Date.now() - camLive.ts > 15000) {
      return send(res, 503, { error: 'akış yok', err: camLive.err, running: camLive.running });
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': camLive.buf.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(camLive.buf);
  }
  if (p === '/sec/on' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        secGuard.on = true;
        if (j.threshold != null) secGuard.threshold = Math.min(Math.max(Number(j.threshold) || 8, 1), 100);
        if (!camLive.running) { camLive.which = 0; camLive.running = true; camLoop(); }
        return send(res, 200, { ok: true, sec: true, threshold: secGuard.threshold });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }
  if (p === '/sec/off' && req.method === 'POST') {
    secGuard.on = false;
    return send(res, 200, { ok: true, sec: false });
  }
  if (p === '/sec/status' && req.method === 'GET') {
    return send(res, 200, { ok: true, on: secGuard.on, threshold: secGuard.threshold, hits: secGuard.hits, lastEvent: secGuard.lastEvent, camRunning: camLive.running });
  }

  /* ── GECE MODU SAATLERİ (root bekçi bu dosyayı okur) ──── */
  const NIGHT_FILE = path.join(DATA_DIR, 'gece-modu.saat');
  if (p === '/night' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 256) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const on = Math.min(Math.max(parseInt(j.on, 10) || 0, 0), 23);
        const off = Math.min(Math.max(parseInt(j.off, 10) || 7, 0), 23);
        fs.writeFileSync(NIGHT_FILE, on + ' ' + off);
        return send(res, 200, { ok: true, on: on, off: off });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }
  if (p === '/night' && req.method === 'GET') {
    let txt = '0 7';
    try { txt = fs.readFileSync(NIGHT_FILE, 'utf8').trim(); } catch (_) {}
    const m = /^(\d{1,2})\s+(\d{1,2})$/.exec(txt);
    return send(res, 200, { ok: true, on: m ? +m[1] : 0, off: m ? +m[2] : 7 });
  }
  if (p === '/cam' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const which = String(j.cam || 'back').toLowerCase().startsWith('front') ? 1 : 0;
        const name = 'photo-' + Date.now() + '.jpg';
        const staged = path.join(STAGE_DIR, name);
        const r = await run('termux-camera-photo', ['-c', String(which), staged], 20000);
        const full = path.join(MEDIA_DIR, name);
        try { if (fs.existsSync(staged)) fs.copyFileSync(staged, full); } catch (_) {}
        if (!fs.existsSync(full)) return send(res, 500, { error: 'kamera hatası', err: r.err, out: r.out });
        return send(res, 200, { ok: true, file: name });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  /* ── HOPARLÖR / SES ───────────────────────────────────── */
  if (p === '/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const text = String(j.text || '').slice(0, 500);
        if (!text) return send(res, 400, { error: 'text gerekli' });
        const r = await run('termux-tts-speak', [text]);
        return r.ok ? send(res, 200, { ok: true }) : send(res, 500, { error: 'tts hatası', err: r.err });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }
  if (p === '/play' && req.method === 'POST') {
    // telefonda mutlak dosya yolu (örn: /sdcard/Music/sarki.mp3)
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const file = String(j.path || '').slice(0, 500);
        if (!file.startsWith('/')) return send(res, 400, { error: 'mutlak yol gerekli' });
        const r = await run('termux-media-player', ['play', file], 8000);
        return r.ok ? send(res, 200, { ok: true }) : send(res, 500, { error: 'oynatma hatası', err: r.err, out: r.out });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }
  if (p === '/vol' && req.method === 'GET') {
    const r = await run('termux-volume', ['music']);
    let level = -1;
    const m = r.out.match(/volume:\s*(\d+)/);
    if (m) level = parseInt(m[1], 10);
    return send(res, 200, { ok: true, level, raw: r.out.trim() });
  }
  if (p === '/vol' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 256) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const lvl = parseInt(j.level, 10);
        if (isNaN(lvl) || lvl < 0 || lvl > 15) return send(res, 400, { error: 'level 0-15' });
        const r = await run('termux-volume', ['music', String(lvl)]);
        return r.ok ? send(res, 200, { ok: true, level: lvl }) : send(res, 500, { error: r.err });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  /* ── FLAŞ / TİTREŞİM ──────────────────────────────────── */
  if (p === '/flash' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 256) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const on = !!j.on;
        const r = await run('termux-torch', [on ? 'on' : 'off'], 5000);
        return r.ok ? send(res, 200, { ok: true, on }) : send(res, 500, { error: r.err });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }
  if (p === '/vibrate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 256) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const ms = Math.min(Math.max(parseInt(j.ms || '300', 10), 0), 10000);
        const r = await run('termux-vibrate', ['-d', String(ms)], 12000);
        return r.ok ? send(res, 200, { ok: true, ms }) : send(res, 500, { error: r.err });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  /* ── DURUM ────────────────────────────────────────────── */
  if (p === '/status' && req.method === 'GET') {
    const bat = await run('termux-battery-status');
    let b = {};
    try { b = JSON.parse(bat.out); } catch (_) {}
    const wifi = await run('termux-wifi-connectioninfo');
    let w = {};
    try { w = JSON.parse(wifi.out); } catch (_) {}
    return send(res, 200, {
      ok: true,
      battery: { level: b.percentage ?? -1, charging: b.status === 'CHARGING', plugged: b.plugged },
      wifi: { ssid: w.ssid || '', ip: w.ip || lanIP(), rssi: w.rssi ?? null },
      recording,
    });
  }

  /* ── DOSYALAR (foto/kayıt paylaşımı) ───────────────────── */
  if (p === '/files' && req.method === 'GET') {
    const list = fs.readdirSync(MEDIA_DIR).filter(f => !f.startsWith('.')).sort().reverse().slice(0, 50);
    return send(res, 200, { ok: true, files: list });
  }
  if (p.startsWith('/file/') && req.method === 'GET') {
    return serveFile(res, decodeURIComponent(p.slice(6)));
  }

  /* ── HUB KAYDI ─────────────────────────────────────────── */
  if (p === '/register' && req.method === 'POST') {
    let hubUrl = '';
    try { hubUrl = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'phone-reg.json'), 'utf8')).hub || ''; } catch (_) {}
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        if (j.hub) {
          hubUrl = String(j.hub).replace(/\/+$/, '');
          fs.writeFileSync(REG_FILE, JSON.stringify({ hub: hubUrl }));
        }
        if (hubUrl) {
          fetch(hubUrl + '/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (() => { try { return fs.readFileSync(HUB_TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; } })() },
            body: JSON.stringify({ name: 'A5-TELEFON', lan: (lanIP() || '') + ':' + PORT, kind: 'phone' }),
          }).catch(() => {});
        }
        return send(res, 200, { ok: true, hub: hubUrl, lan: lanIP() + ':' + PORT });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  send(res, 404, { error: 'bilinmeyen yol: ' + p });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('panpi-phone dinliyor: 0.0.0.0:' + PORT);
  console.log('LAN: http://' + lanIP() + ':' + PORT);
  console.log('token: ' + token);
  // hub'a otomatik kayıt (kayıtlı hub varsa)
  try {
    const reg = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
    if (reg.hub) {
      fetch(reg.hub + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (() => { try { return fs.readFileSync(HUB_TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; } })() },
        body: JSON.stringify({ name: 'A5-TELEFON', lan: lanIP() + ':' + PORT, kind: 'phone' }),
      }).catch(() => {});
    }
  } catch (_) {}
});