# Site, esitleme ve yedek izleme

Bu sistem ana Cloudflare Workers adresini, D1 portfoy kaydinin okunabilirligini, gunluk JSON yedegini, haftalik SQL yedegini ve aylik geri yukleme raporunu kontrol eder.

## Davranis

- Kontrol Windows'ta 15 dakikada bir ve oturum acildiginda calisir.
- Gecici kesintiler icin ilk hatada mesaj gonderilmez. Ayni sorun iki kez arka arkaya gorulurse Telegram uyarisi gonderilir.
- Uyari verilen sorun duzelince bir kez duzelme mesaji gonderilir.
- Telegram bot tokeni sunucudaki mevcut sifreli ayarda kalir ve bilgisayara ikinci kez kopyalanmaz. Yerel izleyici yalnizca bildirim gonderme uc noktasina ait rastgele anahtari `.secrets` klasorunde Windows DPAPI ile saklar.
- Cloudflare Workers Logs aciktir. Istekler, hatalar ve yakalanmamis istisnalar Cloudflare panelindeki **Workers & Pages → yatirim-defterim → Observability** bolumunden incelenebilir.
- Bilgisayar kapaliyken yerel kontrol calisamaz. Oturum acildiginda gorev yeniden baslar ve gecikmis yedekleri algilar.

## Kurulum

Sunucu ile yerel izleyici arasindaki bildirim anahtarini olusturun:

```powershell
npm run monitor:secret
```

Ardindan gorevi kurun:

```powershell
npm run monitor:install
```

Bu islem bot tokenini okumaz veya disari aktarmaz. Kurulum mevcut uygulama Telegram ayariyla bir deneme mesaji gonderir ve gorevi hemen baslatir.

## Elle kontrol

Telegram mesaji gondermeden durum raporu almak icin:

```powershell
npm run monitor:test
```

Normal izleme calismasini elle baslatmak icin:

```powershell
npm run monitor:run
```

Varsayilan eskime sinirlari gunluk JSON icin 36 saat, haftalik SQL icin 204 saat ve geri yukleme testi icin 40 gundur. Durum ve gunluk dosyalari `.secrets/monitor-state.json` ile `.secrets/monitor.log` altinda tutulur.
