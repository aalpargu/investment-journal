# Yatırım Defterim

Yatırım işlemlerimi, harcamalarımı ve karar notlarımı tek yerde takip etmek için geliştirdiğim uygulama. BIST ve ABD varlıklarında açık ve kapanmış pozisyonları işlem kayıtlarından hesaplar.

[Örnek portföyü dene](https://investment-journal-demo-alpargu.flowydream.chatgpt.site) · [English and setup](README.md)

Canlı örneği kullanmak için kurulum gerekmez. ChatGPT hesabıyla giriş yapan her ziyaretçiye ayrı temsili portföy açılır. Kayıt ekleme, düzenleme, silme, takip listesi, harcamalar, finansal takvim, analiz ekranları, içe/dışa aktarma ve kayıt geçmişi aynı uygulama arayüzünde bulunur.

**AI ile görsel okuma ve Telegram bağlantıları bu ortamda henüz yapılandırılmadı.** İlgili ekranlarda kısa açıklama var; bu bağlantılar daha sonra eklenecek. Diğer özellikleri denemek için API anahtarı veya bot kurmak gerekmez.

## Veri ayrımı

Örnekteki işlemler ve tutarlar temsilidir. Geliştiricinin gerçek portföyü, veritabanı, yedekleri ve kişisel hizmet anahtarları bu yayına bağlı değildir. Ziyaretçilerin kayıtları hem sunucuda hem tarayıcı deposunda hesap bazında ayrılır. İlk kayıtlar yalnızca bir kez oluşturulur; sonraki girişlerde yapılan düzenlemeler korunur.

## Teknoloji ve doğrulama

React/TypeScript, JavaScript portföy arayüzü, vinext/Vite, Cloudflare Workers, D1 ve Drizzle. Ayrıntılı kaynak haritası, yerel çalıştırma ve test komutları [İngilizce rehberde](README.md).

29 Ekim 2026 kontrolünde mevcut testler, hesap ayrımı için HTTP kontrolleri, TypeScript ve üretim derlemesi geçti. BIST/ABD fiyat çağrısı da başarılıydı. Demo için tam görsel/cihaz kontrolü henüz tamamlanmadı; AI ve Telegram bağlantı testleri sonraya bırakıldı.
