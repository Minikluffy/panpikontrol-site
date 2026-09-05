# 📟 Samsung A5 Ev Sunucusu — Mimari ve Uygulama Planı

> Amaç: evdeki Samsung A5'i 7/24 açık **hafif sunucuya** çevirmek. Üç iş yapacak:
> **1) Keşif** (hangi PC nerede), **2) Güvenlik olayları** (kim bağlandı, kim reddedildi), **3) Köprü** (cihazların birbirini bulması).
> Tümü Termux üzerinde, root'suz, ücretsiz, PanpiKontrol'ün uçtan uca şifre mantığıyla uyumlu.

---

## 0) Gerçekçi beklentiler (A5 donanımı)

| Yapabilir ✓ | Yapamaz / önerilmez ✗ |
|---|---|
| Keşif servisi (JSON, saniyede birkaç istek) | Video/ekran akışı relay'i (ısınır, pil yer) |
| Olay günlüğü + küçük web paneli | Ağır şifreli proxy (AES sürekli = CPU doruk) |
| Bildirim dağıtımı (ntfy köprüsü) | Veritabanı sunucusu (büyür, RAM'e sığmaz) |
| İki PC arasında buluşma noktası (signal) | Aylarca kesintisiz şarj (pil şişme riski) |

**Sonuç:** A5'e "hafif, kritik, düşük trafik" işler ver. Ağır iş PC'de kalır.

---

## 1) Mimari

```
[Telefonun] ──4G/5G──> (Cloudflare tüneli) ──┐
     │                                        │
 [Ev Wi-Fi] ────────────────────> [ 📟 A5 SUNUCU :8443 ]
                                        │  • KEŞİF: "PC şu anda 192.168.1.6:4849 + tünel X"
                                        │  • OLAYLAR: eşleştirme/kilit/oturum günlüğü
                                        │  • BİLDİRİM: kritik olayda telefona anında push
                                        │  • PANEL: mini web sayfası (şifreli)
                                  [ 💻 PC ajan :4849 ]
```

### Rol 1 — KEŞİF (en değerli parça)
- PC ajanı her açılışta (ve tünel adresi her değiştiğinde) A5'e kaydını yazar:
  `POST /register { pcName, lanAddr, relayUrl, version, ts }` (token'lı)
- Telefon uygulaması bağlanmadan önce A5'e sorar: `GET /discover?pc=jav4s`
  → güncel LAN + tünel adresi. GitHub Pages'teki JSON'dan farkı: **özel** (repoya git geçmişi düşmez), **anında** (deploy beklemez), **internetsiz de çalışır** (ev içinde Wi-Fi var, internet olmasa yeter).
- A5 kapalıysa: telefon mevcut davranışa döner (GitHub Pages + elle). Kesinti = sıfır risk.

### Rol 2 — GÜVENLİK OLAYLARI
- Ajan olayları A5'e iletir: `POST /event { type, detail, ts }`
  Olay tipleri: `pair-ok`, `pair-fail`, `lockdown`, `session-open`, `session-close`, `update`, `relay-change`
- A5 günlüğü tutar (son 1000 olay, eskiyi siler), mini panelde gösterir.
- **Kritik olay** (pair-fail ×3, lockdown, tanıdık olmayan cihaz) → telefona anında bildirim (ntfy.sh, ücretsiz).

### Rol 3 — KÖPRÜ
- İleride 2. PC eklenirse: iki ajan da A5'e kaydolur, birbirini A5 üzerinden bulur
  (dosya aktarımı, ortak pano, "bu PC'yi uyanık tut" komutları). A5 sadece buluşma noktası — trafik kendisinden geçmez.

---

## 2) Uygulama aşamaları (her "devam et"te bir sonraki)

**Aşama 0 — Hazırlık (elle, 10 dk)**
1. A5'in modelini/Android sürümünü öğren: Ayarlar → Telefon hakkında
   (Android **7+** → güncel Termux; **5/6** → eski Termux APK'sı, plan aynı)
2. Modemden A5'e **sabit IP rezervi** (DHCP rezervasyon, ör. `192.168.1.50`)
3. Fabrika sıfırlama önerilir (eski hesapların/uygulamaların kalıntısı kalmasın)
4. Google hesabını çıkar ya da guest modda tut — sunucu telefon "temiz" olmalı

**Aşama 1 — Termux temeli**
1. Termux'u F-Droid'den kur (Play Store sürümü eski/bozuk — F-Droid şart)
2. `pkg update && pkg install nodejs-lts openssh termux-services nano`
3. `termux-wake-lock` (uykuya dalmayı engeller) + Ayarlar → Pil → Termux için **pil optimizasyonunu kapat**
4. `sshd` aç (yerel ağdan yönetim için): `passwd` + `sshd` — PC'den `ssh -p 8022` ile bağlanılır

**Aşama 2 — Sunucu çekirdeği (`panpi-hub`)**
1. Sıfır bağımlılık Node sunucu (PanpiKontrol ajanıyla aynı felsefe):
   - HTTPS (kendinden imzalı, parmak izi cihazlara sabitlenir) veya LAN'da HTTP+token
   - `/register`, `/discover`, `/event`, `/events`, `/health`
   - Token: ilk kurulumda ekranda üretilir, PC'ye ve telefona girilir
2. Otomatik başlatma: **Termux:Boot** eklentisi + `~/.termux/boot/start-hub.sh`
3. Watchdog: 30 sn'de bir `/health` kendini kontrol, düşerse yeniden başlat

**Aşama 3 — Keşif entegrasyonu (PanpiKontrol tarafı)**
1. `pc/agent.js`: açılışta + relay değişiminde `register` (A5 yoksa sessizce atlar, 3 deneme)
2. `phone/index.html`: bağlantı öncesi `discover` sorgusu (kayıtlı A5 adresi varsa)
3. QR'lara A5 adresi gömülmez — A5 adresi telefonla **bir kez** elle girilir (az hareket, çok güven)

**Aşama 4 — Olay entegrasyonu**
1. Ajanın mevcut güvenlik noktalarına tek satır hook: lockdown, pair-ok/fail, session aç/kapa
2. A5: günlük rotasyonu (son 1000), `/events?since=` ile panel/telefon çekimi

**Aşama 5 — Bildirimler**
1. Telefona **ntfy** uygulaması kur, ücretsiz rastgele kanal aç (örn. `panpi-emin-<rastgele>`)
2. A5 kritik olayda ntfy'ye POST yollar → telefon anında bildirim alır
3. Ayarlanabilir eşik: her pair-fail bildirim yapmaz; 3+ veya lockdown bildirir

**Aşama 6 — Sertleştirme**
1. Sadece LAN dinle (isteğe bağlı ayrı cloudflared tüneli, kendi token'ıyla — modemden port açma **yasak**)
2. Olay günlüğü şifreli saklama (aynı AES-GCM yaklaşımı), kaba kuvvet kilidi (5 hata → 15 dk)
3. SD karta haftalık otomatik yedek (config + günlük)
4. Isı/pil izleme: `termux-battery-status` → sıcaklık/pil %'si panelde; %15 altında bildirim

---

## 3) Güvenlik ilkeleri (PanpiKontrol ile aynı damar)

- **Modemden hiçbir port açılmaz.** Dış erişim gerekirse A5 kendi cloudflared tünelini açar (giden bağlantı).
- Her uç nokta token ister; 5 hatalı denemede kilitleme (PC ajanındaki mantığın aynısı).
- Parmak izi sabitleme: kendi imzalı sertifikada telefon/PC sertifikayı ilk bağlanışta pinler.
- A5'te root yok, tek amaçlı Termux, gereksiz paket yok.
- Günlükler cihazda; ntfy'ye yalnızca olay tipi + cihaz adı gider (IP/adres sızmaz).

---

## 4) Süreklilik notları (eski telefonda 7/24)

- **Şarj:** sürekli şarjda pil şişebilir. Pratik çözüm: günde bir kez %40'a düşür-full döngüsü zorlamak yerine, pil %15 altına inerse (elektrik kesintisi) ntfy bildirimi — asıl risk veri kaybı değil, kesinti haberidir.
- **Isı:** LAN servisleri hafif; kılıftan çıkar, dik konumda havalanan yerde durur.
- **Ekran:** kapalı kalır; "yan düğme kilidi" açık, Wi-Fi hep açık, uçak modu kapalı.
- **Yeniden başlatma:** elektrik kesintisinden sonra A5 açılınca Termux:Boot hub'ı otomatik başlatır (pin kilidi açıksa dikkat — ayarlardan "şifre yok, evde kalır" önerilir).

---

## 5) Aşama 1-2 hızlı komut özeti (kura geçince)

```bash
pkg update -y && pkg install nodejs-lts openssh termux-services -y
termux-wake-lock
mkdir -p ~/panpi-hub && cd ~/panpi-hub
# index.js buraya (Aşama 2'de yazılır)
node index.js &
# boot:
mkdir -p ~/.termux/boot
echo 'termux-wake-lock; cd ~/panpi-hub && node index.js >> hub.log 2>&1' > ~/.termux/boot/start-hub.sh
chmod +x ~/.termux/boot/start-hub.sh
```

---

*Bu plan "Görev Panosu"ndaki "Samsung A5'i ev sunucusu yap" görevinin çıktısıdır.*
*Uygulamaya başlamak için: "Aşama 1'den başla" veya "Aşama 2'nin index.js'ini yaz".*
