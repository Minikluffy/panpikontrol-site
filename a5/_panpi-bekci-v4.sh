#!/system/bin/sh
# PanpiKontrol root bekçisi v4 — 20 sn servis kontrolü + ayarlanabilir gece modu
NT="/data/data/com.termux/files/usr/bin/node"
LIB="/data/data/com.termux/files/usr/lib"
H="/data/data/com.termux/files/home/panpi-hub"
GM="/data/data/com.termux/files/home/panpi-hub/data/gece-modu"
NF="/data/data/com.termux/files/home/panpi-hub/data/gece-modu.saat"
while true; do
  export LD_LIBRARY_PATH="$LIB" HOME="/data/data/com.termux/files/home"
  cd "$H" || { sleep 20; continue; }
  for svc in hub.js phone-svc.js a5-remote.js; do
    pgrep -f "node $svc" >/dev/null 2>&1 || "$NT" "$svc" >> "${svc%.js}.log" 2>&1 &
  done
  # gece modu saatleri (dosya yoksa 0-7)
  ONH=0; OFFH=7
  if [ -f "$NF" ]; then
    P=$(cat "$NF" 2>/dev/null | tr -d '\r')
    ONH=$(echo "$P" | cut -d' ' -f1); OFFH=$(echo "$P" | cut -d' ' -f2)
    case "$ONH" in ''|*[!0-9]*) ONH=0;; esac
    case "$OFFH" in ''|*[!0-9]*) OFFH=7;; esac
    [ "$ONH" -gt 23 ] && ONH=0
    [ "$OFFH" -gt 23 ] && OFFH=7
  fi
  H2=$(date +%H)
  INNIGHT=0
  if [ "$ONH" -le "$OFFH" ]; then
    [ "$H2" -ge "$ONH" ] && [ "$H2" -lt "$OFFH" ] && INNIGHT=1
  else
    # gece yarısını saran aralık (örn 22-7)
    { [ "$H2" -ge "$ONH" ] || [ "$H2" -lt "$OFFH" ]; } && INNIGHT=1
  fi
  if [ "$INNIGHT" = 1 ]; then
    if [ ! -f "$GM" ]; then
      PT=$(cat data/phone-token 2>/dev/null)
      if [ -n "$PT" ]; then
        curl -s -m 5 -X POST -H "Authorization: Bearer $PT" http://127.0.0.1:8555/sec/off >/dev/null 2>&1
        curl -s -m 5 -X POST -H "Authorization: Bearer $PT" http://127.0.0.1:8555/cam-live/stop >/dev/null 2>&1
      fi
      touch "$GM"
      echo "$(date) gece modu ($ONH-$OFFH): kamera+guvenlik kapatildi" >> bekci.log
    fi
  else
    if [ -f "$GM" ]; then rm -f "$GM"; echo "$(date) gece modu bitti ($ONH-$OFFH)" >> bekci.log; fi
  fi
  sleep 20
done
