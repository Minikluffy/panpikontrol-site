#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════
# panpi-hub + panpi-phone — Termux tek komut kurulum
# Kullanım (Termux'ta):
#   bash termux-kur.sh
# Ne yapar:
#   1) nodejs + termux-services + termux-api kurar
#   2) hub.js + phone-svc.js dosyalarını ~/panpi-hub'a kopyalar
#   3) termux-wake-lock + pil optimizasyonu hatırlatması
#   4) Termux:Boot için otomatik başlatma scripti yazar (hub + phone)
#   5) ikisini de başlatır, token'ı ekrana basar
# ═══════════════════════════════════════════════════════════
set -e
echo "═══ panpi-hub + panpi-phone kurulumu başlıyor ═══"

echo "[1/6] paketler…"
pkg update -y -q 2>/dev/null || pkg update -y
pkg install -y nodejs-lts termux-services termux-api -q 2>/dev/null || pkg install -y nodejs-lts termux-services termux-api

echo "[2/6] dosyalar…"
mkdir -p ~/panpi-hub
SRC="$(cd "$(dirname "$0")" && pwd)"
cp -f "$SRC/hub.js" ~/panpi-hub/hub.js 2>/dev/null || { echo "  hub.js yanında değil — zaten kurulu mu bakılıyor"; [ -f ~/panpi-hub/hub.js ] || { echo "HATA: hub.js bulunamadı"; exit 1; }; }
cp -f "$SRC/phone-svc.js" ~/panpi-hub/phone-svc.js 2>/dev/null || { echo "  phone-svc.js yanında değil"; [ -f ~/panpi-hub/phone-svc.js ] || echo "  uyarı: phone-svc yok (mikrofon/kamera devre dışı)"; }
cp -f "$SRC/a5-remote.js" ~/panpi-hub/a5-remote.js 2>/dev/null || { echo "  a5-remote.js yanında değil"; [ -f ~/panpi-hub/a5-remote.js ] || echo "  uyarı: a5-remote yok (ekran izleme/kontrol devre dışı)"; }
cp -f "$SRC/bekci.sh" ~/panpi-hub/bekci.sh 2>/dev/null || echo "  uyarı: bekci.sh yok"
# E·MERKEZ site — hub www/ dizininden LAN'da site sunucusu olur
if [ -d "$SRC/panpi-www" ]; then
  mkdir -p ~/panpi-hub/www/app
  cp -f "$SRC/panpi-www/index.html" ~/panpi-hub/www/index.html 2>/dev/null && echo "  www/index.html kopyalandı"
  cp -f "$SRC/panpi-www/app/index.html" ~/panpi-hub/www/app/index.html 2>/dev/null
fi
mkdir -p ~/panpi-hub/data

# Termux:API Android uygulaması zip içindeyse kurulum sihirbazını aç
# (kullanıcı tek dokunuşla İZİN VER'e basar — mikrofon/kamera/hoparlör bununla çalışır)
if [ -f "$SRC/apk/termux-api.apk" ]; then
  cp -f "$SRC/apk/termux-api.apk" ~/panpi-hub/termux-api.apk
  echo "  → Termux:API APK'si hazır — kurulum sihirbazı açılıyor, TEK DOKUNUŞ: İzin Ver"
  (sleep 2; termux-open ~/panpi-hub/termux-api.apk) &
elif [ ! -d /data/data/com.termux.api ]; then
  echo "  uyarı: Termux:API uygulaması yok — mik/kamera çalışmaz."
  echo "  indir: https://f-droid.org/repo/com.termux.api_1002.apk"
fi

echo "[3/6] wake-lock…"
command -v termux-wake-lock >/dev/null && termux-wake-lock || echo "  termux-api yok — pil optimizasyonunu elle kapat: Ayarlar > Uygulamalar > Termux > Pil > Kısıtlama yok"

echo "[4/6] otomatik başlatma (Termux:Boot)…"
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/panpi-hub.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
sleep 10
cd ~/panpi-hub
nohup node hub.js >> hub.log 2>&1 &
nohup node phone-svc.js >> phone.log 2>&1 &
nohup node a5-remote.js >> a5-remote.log 2>&1 &
nohup bash bekci.sh >> bekci.log 2>&1 &
EOF
chmod +x ~/.termux/boot/panpi-hub.sh
echo "  boot scripti yazıldı (Termux:Boot kuruluysa açılışta otomatik + bekçi)"

echo "[5/6] ilk başlatma…"
pkill -f 'node hub.js' 2>/dev/null || true
pkill -f 'node phone-svc.js' 2>/dev/null || true
pkill -f 'node a5-remote.js' 2>/dev/null || true
sleep 1
cd ~/panpi-hub
nohup node hub.js >> hub.log 2>&1 &
sleep 2
nohup node phone-svc.js >> phone.log 2>&1 &
nohup node a5-remote.js >> a5-remote.log 2>&1 &
sleep 3

HUB_OK=no
if curl -s -m 3 http://127.0.0.1:8443/health | grep -q '"ok":true'; then HUB_OK=yes; fi
PHONE_OK=no
if curl -s -m 3 http://127.0.0.1:8555/health | grep -q '"ok":true'; then PHONE_OK=yes; fi
REMOTE_OK=no
if curl -s -m 3 http://127.0.0.1:8556/health | grep -q '"ok":true'; then REMOTE_OK=yes; fi

echo "[6/6] sonuç:"
if [ "$HUB_OK" = yes ] || [ "$PHONE_OK" = yes ]; then
  TOKEN=$(cat data/hub-token 2>/dev/null || cat data/phone-token 2>/dev/null || echo "")
  LANIP=$(ifconfig 2>/dev/null | grep -oE 'inet (192|10|172)[^ ]*' | head -1 | cut -d' ' -f2)
  echo ""
  echo "═══ HUB    : $HUB_OK  (http://$LANIP:8443) ═══"
  echo "═══ PHONE  : $PHONE_OK (http://$LANIP:8555 — mik/kamera/hoparlör) ═══"
  echo "═══ REMOTE : $REMOTE_OK (http://$LANIP:8556 — ekran izle + dokunmatik kontrol, root gerekir) ═══"
  echo "  token : $TOKEN"
  echo "  (bu token'ı E·MERKEZ'deki A5 uygulamasına ve PC ajanına gireceksin)"
  [ "$PHONE_OK" = no ] && echo "  ipucu: phone-svc için Termux:API APK'si kurulu olmalı — kur-telefonda.sh halleder"
  [ "$REMOTE_OK" = no ] && echo "  ipucu: ekran kontrolü için A5'te ROOT (SuperSU) gerekli — a5-remote loguna bak"
else
  echo "hata: servisler başlamadı — loglar:"
  tail -10 hub.log 2>/dev/null
  tail -10 phone.log 2>/dev/null
  exit 1
fi