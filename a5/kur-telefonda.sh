#!/bin/bash
# panpi-hub + panpi-phone ADB otomasyonu — telefon USB'ye takılınca çalıştırılır
# Kullanım: bash kur-telefonda.sh
set -u
ADB="/c/Users/emin-/AppData/Local/Android/Sdk/platform-tools/adb.exe"
DIR="$(cd "$(dirname "$0")" && pwd)"
PH=/sdcard/Download
HUB_IP=""

echo "— telefon bekleniyor —"
"$ADB" wait-for-device
echo "— cihaz: —"
"$ADB" devices | tail -2

# 1) dosyaları telefona it
"$ADB" shell mkdir -p $PH 2>/dev/null
"$ADB" push "$DIR/hub.js" $PH/hub.js
"$ADB" push "$DIR/phone-svc.js" $PH/phone-svc.js
"$ADB" push "$DIR/a5-remote.js" $PH/a5-remote.js
"$ADB" push "$DIR/bekci.sh" $PH/bekci.sh
"$ADB" push "$DIR/start-all.sh" $PH/start-all.sh
"$ADB" push "$DIR/termux-kur.sh" $PH/termux-kur.sh
# E·MERKEZ site (www) — hub bu dizini LAN site sunucusu olarak servis eder
"$ADB" shell mkdir -p $PH/panpi-www/app 2>/dev/null
"$ADB" push "$DIR/../site/index.html" $PH/panpi-www/index.html 2>/dev/null && echo "  www/index.html itildi" || echo "  uyarı: site/index.html yok"
"$ADB" push "$DIR/../site/app/index.html" $PH/panpi-www/app/index.html 2>/dev/null && echo "  www/app/index.html itildi" || echo "  uyarı: site/app/index.html yok"
echo "— dosyalar itildi (hub, phone-svc, a5-remote, bekci, start-all, www) —"

# 2) Termux:API uygulamasını kur (mikrofon/kamera/hoparlör komutları için)
APK="$DIR/apk/termux-api.apk"
if [ -f "$APK" ]; then
  "$ADB" install -r "$APK" 2>&1 | tail -1
else
  echo "uyarı: termux-api.apk bulunamadı — indir: https://f-droid.org/repo/com.termux.api_1002.apk"
fi

# 3) izinler (Termux + Termux:API)
for pkg in com.termux com.termux.api; do
  "$ADB" shell pm grant $pkg android.permission.READ_EXTERNAL_STORAGE 2>/dev/null
  "$ADB" shell pm grant $pkg android.permission.WRITE_EXTERNAL_STORAGE 2>/dev/null
  "$ADB" shell pm grant $pkg android.permission.RECORD_AUDIO 2>/dev/null && echo "  $pkg: mikrofon izni ✓"
  "$ADB" shell pm grant $pkg android.permission.CAMERA 2>/dev/null && echo "  $pkg: kamera izni ✓"
done
"$ADB" shell pm grant com.termux.api android.permission.POST_NOTIFICATIONS 2>/dev/null
echo "— izinler verildi —"

# 4) Termux'u aç (ilk açılış bootstrap çıkarımı yapar — ~1-3 dk)
"$ADB" shell input keyevent KEYCODE_WAKEUP
"$ADB" shell am start -n com.termux/.app.TermuxActivity
echo "— bootstrap için 40 sn bekleme —"
sleep 40

# 5) ekranı uyanık tut (USB'de asla uyumasın)
"$ADB" shell settings put global stay_on_while_plugged_in 7 2>/dev/null

# 6) termux'a komut diz (terminal ön planda — input text ile)
"$ADB" shell input text 'bash% /sdcard/Download/termux-kur.sh% >% kurulum.log% 2>&1'
"$ADB" shell input keyevent 66
echo "— kurulum komutu yazıldı, servislerin ayağa kalkması bekleniyor —"

# 7) hub + phone + remote canlanana kadar yokla (en fazla 12 dk)
HUB_OK=no
PHONE_OK=no
REMOTE_OK=no
for i in $(seq 1 144); do
  sleep 5
  if [ "$HUB_OK" = no ] && curl -s -m 3 http://192.168.1.3:8443/health 2>/dev/null | grep -q '"ok":true'; then
    HUB_OK=yes; HUB_IP=192.168.1.3
    echo "═══ HUB CANLI ✓ (deneme $i) ═══"
  fi
  if [ "$PHONE_OK" = no ] && curl -s -m 3 http://192.168.1.3:8555/health 2>/dev/null | grep -q '"ok":true'; then
    PHONE_OK=yes
    echo "═══ PHONE-SVC CANLI ✓ (mik/kamera/hoparlör) (deneme $i) ═══"
  fi
  if [ "$REMOTE_OK" = no ] && curl -s -m 3 http://192.168.1.3:8556/health 2>/dev/null | grep -q '"ok":true'; then
    REMOTE_OK=yes
    echo "═══ A5-REMOTE CANLI ✓ (ekran izleme — root gerekir) (deneme $i) ═══"
  fi
  [ "$HUB_OK" = yes ] && [ "$PHONE_OK" = yes ] && break
done

# 8) kablosuz ADB — artık USB'siz yönetim
"$ADB" shell input keyevent KEYCODE_WAKEUP
"$ADB" tcpip 5555 >/dev/null 2>&1 && echo "— kablosuz ADB açıldı: adb connect 192.168.1.3:5555 —"

echo ""
echo "═══ SONUÇ ═══"
echo "  HUB   : $HUB_OK   → http://$HUB_IP:8443"
echo "  PHONE : $PHONE_OK → http://$HUB_IP:8555 (mik/kamera/hoparlör)"
echo "  REMOTE: $REMOTE_OK → http://$HUB_IP:8556 (ekran izleme — root gerekir)"
if [ "$HUB_OK" = no ] && [ "$PHONE_OK" = no ]; then
  echo "— servisler canlanmadı — telefonda Termux'u aç, 'cat kurulum.log' diye bak —"
  exit 1
fi
exit 0