# D1 ve JSON yedekleri

Bu klasordaki betikler, uretim D1 veritabanini uygulamadan ve GitHub deposundan bagimsiz olarak OneDrive'a yedekler.

## Yedek duzeni

- Her gun 02:15: `gunluk-json` klasorune okunabilir JSON yedegi.
- Her pazar 02:30: `haftalik-sql` klasorune sema ve veriyi iceren tam SQL yedegi.
- Her yedegin yaninda ayni adli `.sha256` butunluk dosyasi bulunur.
- Sonuclar ve hatalar `gunlukler/yedekleme.log` dosyasina yazilir; portfoy verisi loga yazilmaz.
- Yarim kalan disari aktarmalar `.hazirlaniyor` altinda tutulur ve basarisiz calisma sonunda temizlenir.
- Eski yedekler otomatik silinmez.
- Arka plan gorevleri, Windows Node 24 kapanis hatasindan etkilenmemek icin proje icindeki SHA-256 dogrulanmis Node 22 LTS kopyasini kullanir.
- Cloudflare API belirteci Git'e veya OneDrive'a yazilmaz. `.secrets` altinda Windows kullanicisina bagli DPAPI sifrelemesiyle saklanir.
- SQL yedegi D1'in sema ve satirlarini salt okunur sorgularla alarak geri yuklenebilir SQLite SQL dosyasi uretir; token yalniz `D1 Read` yetkisinde kalir.
- Geri yukleme testi her ay ilk uygun calismada en yeni SQL yedegini gecici bir SQLite veritabanina yukler; hash, SQLite butunlugu, portfoy semasi, islemler ve takip listesi dogrulanir.
- Yeni uzun vadeli yapida islemler, takip listesi, kapanmis pozisyonlar, gunluk goruntuler, gecmis, notlar ve teknik uyarilar ayri tablolardadir. Test, guncel portfoyu bu tablolardan yeniden kurarak hem SQL hem JSON yedegini dogrular.
- `portfolio_transaction_audit` tablosu islem ekleme, degistirme ve silme olaylarini saklar; normal portfoy revizyonu temizligi bu denetim kayitlarini silmez.
- Test basariliysa ayni ay tekrar calismaz. Basarisiz veya bilgisayar kapaliysa ertesi gun 03:00'te yeniden dener.
- Gecici test veritabani silinir; hassas veri icermeyen son rapor `gunlukler/son-geri-yukleme-testi.json` dosyasinda kalir.

Varsayilan hedef: `%OneDrive%\Yatirim Defterim Yedekleri`

## Elle calistirma

Proje kokunde:

```powershell
npm run backup:all
```

Yalniz JSON veya SQL icin:

```powershell
npm run backup:json
npm run backup:sql
npm run backup:verify
```

Cloudflare'da yalniz `D1 Read` iznine sahip bir API belirteci olusturun ve bir kez kaydedin:

```powershell
npm run backup:token
```

## Otomatik gorevler

```powershell
npm run backup:install
```

Bu komut gerekli tasinabilir Node 22 LTS kopyasini resmi `nodejs.org` arsivinden indirir, resmi SHA-256 listesiyle dogrular ve uc gorevi kurar. Gorevler oturum acik oldugunda calisir. Bilgisayar planlanan saatte kapaliysa veya uykudaysa, gorev bir sonraki uygun anda baslatilir.

## Dogrulama

Bir yedegin butunluk degerini kontrol etmek icin:

```powershell
Get-FileHash -Algorithm SHA256 "yedek-dosyasi.json"
```

Cikan deger, yanindaki `.sha256` dosyasindaki degerle ayni olmalidir.
