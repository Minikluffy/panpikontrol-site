'use strict';
/*
 * PanpiKontrol — A5 Uzaktan Kontrol Servisi (Termux, Samsung A5 / Android 7)
 * ==========================================================================
 *  Telefonun EKRANINI yayınlar + DOKUNMATİK/TUŞ komutlarını uygular.
 *  Root'lu cihazda `su` kullanır (SuperSU kuruluysa) — root yoksa ekran/input
 *  çalışmaz ama /health ve /info yine cevap verir (dürüst hata döner).
 *
 *  Kimlik: hub.js ile AYNI token (data/hub-token) — site A5 paneli bu token'ı
 *  zaten biliyor, ayrı eşleştirme yok.
 *
 *  Uçlar:
 *    GET  /health        → {ok, up, rooted}
 *    GET  /info          → model, android, ekran, pil, wifi ip
 *    GET  /screen        → PNG (su -c screencap -p) — root şart, 501 değilse
 *    POST /input         → {type:'tap'|'swipe'|'text'|'key', ...} — root şart
 *
 *  Başlat:  node a5-remote.js            (port 8555 + 1 = 8556)
 *           PORT=8556 node a5-remote.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '8556', 10);
const ROOT_DIR = __dirname;
const TOKEN_FILE = path.join(ROOT_DIR, 'data', 'hub-token');
const UP_AT = Date.now();

// ---------------- yardımcılar ----------------
function log(...a) { console.log(new Date().toISOString().slice(11, 19), '[a5-remote]', ...a); }

function hubToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
}
function authOk(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const tok = m ? m[1].trim() : '';
  const real = hubToken();
  if (!real || !tok) return false;
  // sabit zaman karşılaştırması
  if (tok.length !== real.length) return false;
  let d = 0;
  for (let i = 0; i < tok.length; i++) d |= tok.charCodeAt(i) ^ real.charCodeAt(i);
  return d === 0;
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}
function readBody(req, max) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}
function su(cmd, cb) {
  // su -c 'cmd' → çıktı Buffer olarak cb(err, stdout, stderr)
  // encoding:'buffer' ŞART — aksi halde screencap PNG'si utf8 decode ile bozulur
  execFile('su', ['-c', cmd], { maxBuffer: 32 * 1024 * 1024, timeout: 15000, encoding: 'buffer' }, cb);
}
function rooted() { return new Promise((r) => { su('id -u', (e, out) => r(!e && String(out || '').trim() === '0')); }); }

// ---------------- ekran ----------------
let lastFrame = null, lastFrameAt = 0;
function captureScreen(cb) {
  const now = Date.now();
  if (lastFrame && now - lastFrameAt < 400) { cb(null, lastFrame); return; } // 400ms önbellek — yükü keser
  su('screencap -p', (err, out) => {
    if (err) { cb(err, null); return; }
    if (!out || out.length < 1000) { cb(new Error('ekran alınamadı (çıktı yok)'), null); return; }
    lastFrame = out; lastFrameAt = now;
    cb(null, out);
  });
}

// ---------------- input ----------------
function inputCmd(cmd, res) {
  su(cmd, (err) => {
    if (err) {
      const msg = String(err && err.message || err || 'input komutu başarısız');
      if (/not found|permission|denied/i.test(msg)) return sendJSON(res, 501, { error: 'root yok veya input aracı yok — SuperSU kurulu mu?', detail: msg });
      return sendJSON(res, 500, { error: msg });
    }
    sendJSON(res, 200, { ok: true });
  });
}
function sanitizeText(t) {
  // input text tek tırnak içinde verilir — tırnak/özel karakterleri temizle
  return String(t || '').replace(/'/g, '').replace(/[^\x20-\x7EçğıöşüÇĞİÖŞÜ]/g, '').slice(0, 200);
}
async function handleInput(req, res, j) {
  const type = String(j.type || '');
  const x = Math.round(Number(j.x)); const y = Math.round(Number(j.y));
  const x2 = Math.round(Number(j.x2)); const y2 = Math.round(Number(j.y2));
  const dur = Math.max(0, Math.min(60000, Number(j.dur) || 0));
  const keyMap = {
    home: 3, back: 4, recents: 187, power: 26, menu: 82, enter: 66,
    volup: 24, voldown: 25, mute: 164, camera: 27, search: 84, tab: 61,
    del: 67, space: 62, esc: 111,
  };
  if (type === 'tap') {
    if (isNaN(x) || isNaN(y)) return sendJSON(res, 400, { error: 'x,y gerekli' });
    return inputCmd(`input tap ${x} ${y}`, res);
  }
  if (type === 'swipe') {
    if (isNaN(x) || isNaN(y) || isNaN(x2) || isNaN(y2)) return sendJSON(res, 400, { error: 'x,y,x2,y2 gerekli' });
    return inputCmd(`input swipe ${x} ${y} ${x2} ${y2} ${dur || 250}`, res);
  }
  if (type === 'text') {
    const t = sanitizeText(j.text);
    if (!t) return sendJSON(res, 400, { error: 'text boş' });
    return inputCmd(`input text '${t}'`, res);
  }
  if (type === 'key') {
    const k = String(j.key || '').toLowerCase();
    const code = /^\d+$/.test(k) ? Number(k) : keyMap[k];
    if (!code) return sendJSON(res, 400, { error: 'key bilinmiyor: ' + j.key });
    return inputCmd(`input keyevent ${code}`, res);
  }
  sendJSON(res, 400, { error: 'type: tap|swipe|text|key' });
}

// ---------------- bilgi ----------------
async function collectInfo() {
  const info = { model: '', android: '', screen: '', battery: '', ip: '' };
  try { info.model = fs.readFileSync('/system/build.prop', 'utf8').match(/ro\.product\.model=(\S+)/)?.[1] || ''; } catch (_) {}
  try { info.android = fs.readFileSync('/system/build.prop', 'utf8').match(/ro\.build\.version\.release=(\S+)/)?.[1] || ''; } catch (_) {}
  try { info.screen = (await new Promise((r) => su('wm size', (e, o) => r(e ? '' : String(o || '').trim())))).replace('Physical size: ', ''); } catch (_) {}
  try { info.battery = (await new Promise((r) => su('dumpsys battery', (e, o) => r(e ? '' : String(o || '')))))?.match(/level: (\d+)/)?.[1] || ''; } catch (_) {}
  try { info.ip = (await new Promise((r) => su('ip -4 addr show wlan0', (e, o) => r(e ? '' : String(o || ''))))).match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] || ''; } catch (_) {}
  return info;
}

// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end(); }
  if (url === '/health') {
    const root = await rooted();
    return sendJSON(res, 200, { ok: true, up: Math.floor((Date.now() - UP_AT) / 1000), rooted: root, port: PORT });
  }
  if (!authOk(req)) return sendJSON(res, 401, { error: 'hub token gerekli (Authorization: Bearer)' });
  if (url === '/info') {
    const i = await collectInfo();
    return sendJSON(res, 200, { ok: true, ...i });
  }
  if (req.method === 'GET' && url === '/screen') {
    captureScreen((err, png) => {
      if (err) return sendJSON(res, 501, { error: 'ekran alınamadı — root (SuperSU) kurulu mu?', detail: String(err && err.message || err) });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(png);
    });
    return;
  }
  if (req.method === 'POST' && url === '/input') {
    const body = await readBody(req, 65536);
    let j = {}; try { j = JSON.parse(body); } catch (_) { return sendJSON(res, 400, { error: 'JSON gerekli' }); }
    if (!(await rooted())) return sendJSON(res, 501, { error: 'root yok — SuperSU kurulu değil, ekran/input kapalı' });
    return handleInput(req, res, j);
  }
  sendJSON(res, 404, { error: 'bilinmeyen uç — /health /info /screen /input' });
});

server.listen(PORT, '0.0.0.0', () => {
  log('A5 uzaktan kontrol açık: :' + PORT + ' (root: ' + (fs.existsSync(TOKEN_FILE) ? 'token var' : 'TOKEN YOK — hub.js ilk açılışta üretir') + ')');
});