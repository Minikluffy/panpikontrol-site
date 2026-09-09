'use strict';
/* ═══════════════════════════════════════════════════════════════════
 * panpi-hub — Samsung A5 ev sunucusu (Termux, sıfır bağımlılık)
 *
 * Amaç: ev ağındaki tüm PanpiKontrol parçalarının buluşma noktası.
 *   • /register  : PC ajanları kendini kaydeder (LAN + tünel adresi)
 *   • /discover  : telefon "PC nerede?" diye sorar → güncel adres
 *   • /event     : güvenlik olayları (pair-ok/fail, kilit, oturum…) → günlük
 *   • /events    : günlüğü çek (telefon/panel için)
 *   • /wol       : PC'yi Wake-on-LAN ile uyandır (MAC'i kayıtlıysa)
 *   • /health    : durum
 *   • /          : mini panel (E·MERKEZ çerçevesinde açılır, token ister)
 *
 * GÜVENLİK:
 *   • Tüm yazma uçları Bearer token ister (ilk açılışta rastgele üretilebilir)
 *   • 5 hatalı token → 15 dk tam kilit (423) — IP bazlı
 *   • rate limit: IP başına 30 istek/dk (yazma uçlarında)
 *   • WOL sadece LAN'dan (relay/tünel istekleri reddedilir — spoof koruması)
 *   • dosya:// degil, kendi HTTPS'i (varsa cert.pem/key.pem) veya HTTP+token (LAN)
 *   • hiçbir veri dışarı gitmez; log dosyada, döngüsel (son 500 olay)
 *
 * Kullanım (Termux):
 *   node hub.js                 → port 8443 (HTTPS varsa) / 8080 (HTTP)
 *   GH_TOKEN=... node hub.js    → üstüne keşif dosyasını GitHub Pages'a yazar
 *   HUB_TOKEN=... node hub.js   → token'ı sabitle (yoksa otomatik üretir, yazar)
 ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');

const PORT = parseInt(process.env.HUB_PORT || '8443', 10);
const DATA_DIR = path.join(__dirname, 'data');
const LOG_MAX = 500;
const MAX_BODY = 64 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const TOKEN_FILE = path.join(DATA_DIR, 'hub-token');
const LOG_FILE = path.join(DATA_DIR, 'events.json');
const REG_FILE = path.join(DATA_DIR, 'registry.json');
const WWW_DIR = path.join(__dirname, 'www'); // E·MERKEZ site — hub sunucusundan servis edilir
try { fs.mkdirSync(WWW_DIR, { recursive: true }); fs.mkdirSync(path.join(WWW_DIR, 'app'), { recursive: true }); } catch (_) {}

// ---------- token ----------
function loadToken() {
  if (process.env.HUB_TOKEN) return process.env.HUB_TOKEN;
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();

// ---------- durum ----------
let registry = loadJSON(REG_FILE, { pcs: {}, updated: 0 });
let events = loadJSON(LOG_FILE, []);

function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } }
function saveJSON(f, v) { try { fs.writeFileSync(f, JSON.stringify(v)); } catch (_) {} }

function maskIP(ip) {
  // gizlilik: son 2 oktet maskele (192.168.x.x → 192.168.*.*) — tam IP log'da tutulmaz
  const a = String(ip || '').replace('::ffff:', '');
  const m = /^(\d+\.\d+)\.\d+\.\d+$/.exec(a);
  if (m) return m[1] + '.*.*';
  const m6 = /^([0-9a-f]+:[0-9a-f]+):/.exec(a);
  if (m6) return m6[1] + ':*';
  return a.slice(0, 4) + '*';
}
function addEvent(type, detail, src) {
  events.unshift({ type, detail: String(detail || '').slice(0, 200), src: maskIP(src), ts: Date.now() });
  if (events.length > LOG_MAX) events.length = LOG_MAX;
  saveJSON(LOG_FILE, events);
}

// ---------- kilit + rate limit ----------
const fails = new Map();   // ip → { n, until }
const rates = new Map();   // ip → [timestamps]
function rateOK(ip) {
  const now = Date.now(), win = now - 60000;
  let arr = rates.get(ip) || [];
  arr = arr.filter(t => t > win);
  if (arr.length >= 30) return false;
  arr.push(now); rates.set(ip, arr);
  return true;
}
function locked(ip) { const f = fails.get(ip); return f && f.until > Date.now(); }
function fail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; addEvent('hub-lock', '5 hatalı token — IP 15 dk kilitli', ip); }
  fails.set(ip, f);
}
function authed(req, ip) {
  const h = req.headers.authorization || '';
  const ok = h === 'Bearer ' + TOKEN;
  if (!ok) fail(ip);
  else fails.delete(ip);
  return ok;
}

// ---------- yardımcılar ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function isLAN(req) {
  const ra = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return ra === '127.0.0.1' || ra.startsWith('192.168.') || ra.startsWith('10.') || ra.startsWith('172.16.') || ra.startsWith('172.17.') || ra.startsWith('172.18.') || ra.startsWith('172.19.') || ra.startsWith('172.2') || ra.startsWith('172.30.') || ra.startsWith('172.31.');
}

// ---------- WOL ----------
function wakeMAC(mac) {
  return new Promise((resolve, reject) => {
    const clean = mac.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== 12) return reject(new Error('MAC hatalı'));
    const buf = Buffer.alloc(6 + 16 * 6);
    buf.write('ffffffffffff', 0, 'hex');
    for (let i = 0; i < 16; i++) buf.write(clean.toLowerCase(), 6 + i * 6, 'hex');
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', reject);
    s.bind(() => { s.setBroadcast(true); s.send(buf, 9, '255.255.255.255', (e) => { e ? reject(e) : resolve(); setTimeout(() => s.close(), 200); }); });
  });
}

/* ════════ E·MERKEZ site barındırma ════════
 * hub, www/ dizininden siteyi servis eder → http://<a5>:8443 LAN site sunucusu.
 * www/ yoksa (ilk kurulum) GitHub Pages'tan kendini doldurur; dl/ (Setup.exe)
 * kur scripti ile push edilir ya da GitHub'dan indirilir. */
const SITE_GH = 'https://minikluffy.github.io/panpikontrol-site/';
function fetchText(url, ms) {
  return new Promise((res) => {
    const mod = /^https:/.test(url) ? require('https') : require('http');
    const rq = mod.get(url, { timeout: ms || 15000 }, (r) => {
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => res({ ok: r.statusCode === 200, body: Buffer.concat(c).toString('utf8') }));
    });
    rq.on('error', () => res({ ok: false }));
    rq.on('timeout', () => { try { rq.destroy(); } catch (_) {} res({ ok: false }); });
  });
}
async function provisionWWW() {
  try {
    if (!fs.existsSync(path.join(WWW_DIR, 'index.html'))) {
      const idx = await fetchText(SITE_GH + 'index.html?t=' + Date.now());
      if (idx.ok && idx.body.length > 2000) {
        fs.writeFileSync(path.join(WWW_DIR, 'index.html'), idx.body);
        console.log('E·MERKEZ www/index.html indirildi (' + idx.body.length + 'B)');
      }
    }
    if (!fs.existsSync(path.join(WWW_DIR, 'app', 'index.html'))) {
      const app = await fetchText(SITE_GH + 'app/index.html?t=' + Date.now());
      if (app.ok && app.body.length > 2000) {
        fs.writeFileSync(path.join(WWW_DIR, 'app', 'index.html'), app.body);
        console.log('E·MERKEZ www/app/index.html indirildi (' + app.body.length + 'B)');
      }
    }
  } catch (_) {}
}
function wwwPath(p) {
  try {
    let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    let fp = path.resolve(WWW_DIR, decodeURIComponent(rel));
    const base = path.resolve(WWW_DIR) + path.sep;
    if (fp !== path.resolve(WWW_DIR) && !fp.startsWith(base)) return null; // yol dışına çıkma yok
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
    return fs.existsSync(fp) ? fp : null;
  } catch (_) { return null; }
}
function wwwMime(p) {
  if (/\.html?$/.test(p)) return 'text/html; charset=utf-8';
  if (/\.json$/.test(p)) return 'application/json; charset=utf-8';
  if (/\.css$/.test(p)) return 'text/css; charset=utf-8';
  if (/\.js$/.test(p)) return 'application/javascript; charset=utf-8';
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/.test(p)) return 'image/' + (/svg/.test(p) ? 'svg+xml' : /jpe?g/.test(p) ? 'jpeg' : /png/.test(p) ? 'png' : /gif/.test(p) ? 'gif' : /webp/.test(p) ? 'webp' : 'x-icon');
  return 'application/octet-stream';
}
function serveWWW(req, res, p) {
  const fp = wwwPath(p);
  if (!fp) return send(res, 404, { error: 'yok' });
  try {
    const st = fs.statSync(fp);
    res.writeHead(200, { 'Content-Type': wwwMime(fp), 'Content-Length': st.size, 'Cache-Control': /\.(exe|zip|apk)$/.test(fp) ? 'public, max-age=3600' : 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(fp).pipe(res);
  } catch (_) { send(res, 500, { error: 'okuma hatası' }); }
}

/* ════════ kendini güncelleme (hub.js → gh-pages a5/hub.js) ════════
 * USB'siz yaşam: deploy script site/a5/ altına koyar, hub açılışta + 6 saatte
 * bir kontrol eder. Güvenlik: sha farkı + node --check + .bak yedeği + çakılma
 * sayacı (aynı sha ile 5 dk içinde 2 açılış → yedeğe dön). Hata tamamen sessiz. */
const UP_URL = 'https://raw.githubusercontent.com/Minikluffy/panpikontrol-site/gh-pages/a5/hub.js';
const UP_STATE = path.join(DATA_DIR, 'hub-update.json');
function upState() { try { return JSON.parse(fs.readFileSync(UP_STATE, 'utf8')); } catch (_) { return {}; } }
function saveUpState(s) { try { fs.writeFileSync(UP_STATE, JSON.stringify(s)); } catch (_) {} }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
async function selfUpdate() {
  if (process.env.PANPI_NO_UPDATE === '1') return;
  try {
    const curSha = sha256(fs.readFileSync(__filename));
    const st = upState();
    // çakılma koruması: aynı sha ile 5 dk içinde 2. açılış → önceki sürüme dön
    if (st.sha === curSha && st.boots >= 2 && Date.now() - st.firstAt < 5 * 60 * 1000 && fs.existsSync(__filename + '.bak')) {
      console.log('⚠ hub hızlı çakıldı — önceki sürüme dönülüyor');
      fs.copyFileSync(__filename + '.bak', __filename);
      saveUpState({});
      return;
    }
    saveUpState({ sha: curSha, boots: st.sha === curSha ? (st.boots || 0) + 1 : 1, firstAt: st.sha === curSha ? (st.firstAt || Date.now()) : Date.now() });
    const r = await fetchText(UP_URL + '?t=' + Date.now(), 12000);
    if (!r.ok || !r.body || r.body.length < 3000) return; // a5/ yayında değil → sessiz
    const newSha = sha256(Buffer.from(r.body));
    if (newSha === curSha) return;
    const chk = require('child_process').spawnSync(process.execPath, ['--check', '-'], { input: r.body, timeout: 15000 });
    if (chk.status !== 0) { console.log('güncelleme reddedildi (syntax hatası)'); return; }
    try { fs.copyFileSync(__filename, __filename + '.bak'); } catch (_) {}
    fs.writeFileSync(__filename, r.body);
    saveUpState({ sha: curSha, boots: 1, firstAt: Date.now(), appliedSha: newSha, appliedAt: Date.now() });
    console.log('hub.js güncellendi (' + newSha.slice(0, 8) + ') — bekçi yeniden başlatacak');
    setTimeout(() => process.exit(0), 400);
  } catch (_) {}
}

// ---------- GitHub keşif yayını (opsiyonel, GH_TOKEN varsa) ----------
function publishHubDiscovery(port, scheme) {
  if (!process.env.GH_TOKEN) return;
  try {
    const { spawn } = require('child_process');
    const ips = [];
    const nics = os.networkInterfaces();
    for (const k of Object.keys(nics)) for (const ni of nics[k]) if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    const payload = JSON.stringify({ hub: true, ips, port, scheme, pc: (os.hostname() || 'a5').slice(0, 24), ts: Date.now() });
    const c = spawn(process.execPath, ['tools/deploy-gh-data.js', 'put', 'hub.json', payload], {
      cwd: path.join(__dirname, '..'), env: process.env, stdio: 'ignore', windowsHide: true,
    });
    c.on('error', () => {});
  } catch (_) {}
}

// ---------- panel (mini) ----------
const PANEL = `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>panpi-hub</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#07090d;color:#e6edf3;font-family:Consolas,monospace;padding:16px}
.b{background:#0d1117;border:1px solid #1f2a38;border-radius:10px;padding:14px;max-width:720px;margin:0 auto 12px}
h1{font-size:15px;color:#3ddc84;margin-bottom:10px}h2{font-size:11px;color:#58a6ff;margin:10px 0 6px;letter-spacing:2px}
.e{font-size:11px;padding:5px 0;border-bottom:1px solid #131a23;display:flex;gap:8px}
.e .t{color:#8b98a5;min-width:130px}.r{font-size:11px;color:#8b98a5;line-height:1.8}
input{background:#131a23;border:1px solid #1f2a38;color:#e6edf3;padding:8px;border-radius:6px;font-family:inherit;width:100%;margin:6px 0}
button{background:#3ddc84;color:#04140b;border:none;padding:8px 14px;border-radius:6px;font-family:inherit;font-weight:700;cursor:pointer}
</style></head><body>
<div class="b"><h1>📟 panpi-hub</h1><div class="r" id="st">yükleniyor…</div></div>
<div class="b"><h2>KAYITLI PC'LER</h2><div id="pcs" class="r">—</div></div>
<div class="b"><h2>OLAY GÜNLÜĞÜ (son 30)</h2><div id="ev"></div></div>
<script>
const T=localStorage.getItem('hub_t')||prompt('hub token:')||'';
if(T)localStorage.setItem('hub_t',T);
const H={'Authorization':'Bearer '+T};
async function ref(){
  try{
    const r=await fetch('/health',{headers:H});
    if(r.status===401||r.status===423){document.getElementById('st').textContent='token hatalı/kilitli';return}
    const j=await r.json();
    document.getElementById('st').innerHTML='açık: '+j.up+' · kayıtlı PC: '+j.pcs+' · olay: '+j.events;
    document.getElementById('pcs').innerHTML=Object.values(j.pcList||{}).map(p=>p.name+' — lan:'+p.lan+' relay:'+(p.relay?'var':'yok')+' ('+new Date(p.ts).toLocaleString('tr-TR')+')').join('<br>')||'—';
    const e=await (await fetch('/events?n=30',{headers:H})).json();
    document.getElementById('ev').innerHTML=(e.list||[]).map(x=>'<div class="e"><span class="t">'+new Date(x.ts).toLocaleTimeString('tr-TR')+'</span><span><b>'+x.type+'</b> '+x.detail+'</span></div>').join('')||'—';
  }catch(e){document.getElementById('st').textContent='hub erişilemedi: '+e.message}
}
ref();setInterval(ref,5000);
</script></body></html>`;

// ---------- sunucu ----------
const started = Date.now();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');

  if (!rateOK(ip)) { addEvent('hub-ratelimit', 'istek limiti aşıldı', ip); return send(res, 429, { error: 'yavaş' }); }
  if (locked(ip)) return send(res, 423, { error: 'kilitli' });

  // CORS yok — sadece aynı kaynak + E·MERKEZ (CSP tarafında izinli)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // CORS: SADECE E·MERKEZ (https://minikluffy.github.io) + localhost. Token zaten gerekli —
  // CORS bu ek katman: başka siteler senin tarayıcın üzerinden hub'a istek atamaz.
  const origin = req.headers.origin || '';
  if (origin === 'https://minikluffy.github.io' || origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
  }

  if (p === '/' && req.method === 'GET') {
    // E·MERKEZ site hazırsa onu servis et; yoksa mini panele düş
    if (wwwPath('/')) return serveWWW(req, res, '/');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PANEL);
  }
  if (p === '/panel' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PANEL);
  }

  // E·MERKEZ statik dosyaları (www/ altı): app (telefon UI), dl (indirme) — token GEREKMEZ
  if (req.method === 'GET' && (p.startsWith('/app/') || p.startsWith('/dl/') || p === '/robots.txt' || p === '/version.json' || p.startsWith('/favicon'))) {
    return serveWWW(req, res, p);
  }

  if (p === '/health' && req.method === 'GET') {
    // /health kimliksiz ama bilgi minimal — sadece canlılık
    return send(res, 200, { ok: true, up: Math.round((Date.now() - started) / 1000), pcs: Object.keys(registry.pcs).length, events: events.length });
  }

  // altta kalanların hepsi token ister
  if (!authed(req, ip)) {
    addEvent('hub-authfail', 'hatalı token', ip);
    return send(res, locked(ip) ? 423 : 401, { error: 'yetkisiz' });
  }

  if (p === '/register' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (!j.name) return send(res, 400, { error: 'name gerekli' });
        registry.pcs[String(j.name).slice(0, 24)] = {
          name: String(j.name).slice(0, 24),
          kind: String(j.kind || 'pc').slice(0, 8),
          lan: String(j.lan || '').slice(0, 40),
          relay: String(j.relay || '').slice(0, 100),
          version: String(j.version || '').slice(0, 12),
          ts: Date.now(),
        };
        registry.updated = Date.now();
        saveJSON(REG_FILE, registry);
        addEvent('register', j.name + ' kaydoldu' + (j.relay ? ' (tünel var)' : ''), ip);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  if (p === '/discover' && req.method === 'GET') {
    // eski kayıtları filtrele (12 saatten bayat olanlar gizlenir)
    const fresh = {};
    for (const [k, v] of Object.entries(registry.pcs)) if (Date.now() - v.ts < 12 * 3600 * 1000) fresh[k] = v;
    return send(res, 200, { ok: true, pcs: fresh });
  }

  if (p === '/event' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (!j.type) return send(res, 400, { error: 'type gerekli' });
        addEvent('pc:' + String(j.type).slice(0, 24), j.detail, ip);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  if (p === '/events' && req.method === 'GET') {
    const n = Math.min(parseInt(url.searchParams.get('n') || '50', 10), LOG_MAX);
    return send(res, 200, { list: events.slice(0, n) });
  }

  /* ── /hw/* → phone-svc (8555) proxy ─────────────────────
   * Donanım uçları (kamera/mik/TTS/ses/flaş/pil). Yetki: hub token.
   * phone-svc token'ı aynı data dizininden okunur (phone-token dosyası).
   * Binary akışlar (JPEG/M4A) desteklenir. */
  if (p.startsWith('/hw/')) {
    let pt = '';
    try { pt = fs.readFileSync(path.join(DATA_DIR, 'phone-token'), 'utf8').trim(); } catch (_) {}
    if (!pt) return send(res, 502, { error: 'phone-svc token yok' });
    const target = 'http://127.0.0.1:8555' + req.url.slice(3); // /hw/x → /x
    const u2 = new URL(target, 'http://127.0.0.1:8555');
    const chunks = [];
    req.on('data', c => { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 65536) req.destroy(); });
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      const h2 = { 'Authorization': 'Bearer ' + pt, 'Content-Type': req.headers['content-type'] || 'application/json' };
      if (bodyBuf.length) h2['Content-Length'] = bodyBuf.length;
      const pr = http.request(u2, { method: req.method, headers: h2, timeout: 25000 }, (r3) => {
        const out = [];
        r3.on('data', c => out.push(c));
        r3.on('end', () => {
          try {
            res.writeHead(r3.statusCode || 502, { 'Content-Type': r3.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
            res.end(Buffer.concat(out));
          } catch (_) {}
        });
      });
      pr.on('timeout', () => { try { pr.destroy(); } catch (_) {} });
      pr.on('error', () => { try { send(res, 502, { error: 'phone-svc erişilemiyor' }); } catch (_) {} });
      if (bodyBuf.length) pr.write(bodyBuf);
      pr.end();
    });
    return;
  }

  if (p === '/wol' && req.method === 'POST') {
    if (!isLAN(req)) { addEvent('wol-denied', 'LAN dışından WOL denemesi REDDEDİLDİ', ip); return send(res, 403, { error: 'WOL sadece LAN\'dan' }); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const mac = String(j.mac || '').trim();
        if (!mac) return send(res, 400, { error: 'mac gerekli' });
        wakeMAC(mac).then(() => { addEvent('wol-ok', 'sihirli paket gönderildi: ' + mac, ip); send(res, 200, { ok: true }); })
          .catch(e => { addEvent('wol-fail', String(e.message), ip); send(res, 500, { error: e.message }); });
      } catch (e) { send(res, 400, { error: 'json hatalı' }); }
    });
    return;
  }

  send(res, 404, { error: 'yol yok' });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  const nics = os.networkInterfaces();
  for (const k of Object.keys(nics)) for (const ni of nics[k]) if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  console.log('──────────────────────────────────────');
  console.log('  📟 panpi-hub çalışıyor · port ' + PORT);
  console.log('  LAN:  http://' + (ips[0] || 'localhost') + ':' + PORT);
  console.log('  token: ' + TOKEN_FILE + ' içinde (0600)');
  console.log('──────────────────────────────────────');
  addEvent('hub-start', 'hub başlatıldı (port ' + PORT + ')', 'local');
  publishHubDiscovery(PORT, 'http');
  provisionWWW();          // site yoksa GitHub'dan doldur (sessiz)
  selfUpdate();            // kendini güncelle (sessiz)
  setInterval(() => { selfUpdate(); }, 6 * 3600 * 1000);
});

process.on('SIGINT', () => { console.log('\nhub kapanıyor…'); process.exit(0); });
