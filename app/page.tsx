import { getChatGPTUser, chatGPTSignInPath, chatGPTSignOutPath } from './chatgpt-auth';
export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getChatGPTUser();
  if (!user) return (
    <main className="access-shell"><section className="access-card">
      <div className="access-mark">◔</div>
      <p className="access-eyebrow">YATIRIM DEFTERİM · ÖRNEK PORTFÖY</p>
      <h1>Portföyünü tek yerde takip et.</h1>
      <p>İşlemleri, açık ve kapanmış pozisyonları, harcamaları ve analiz ekranlarını örnek verilerle dene. Değişikliklerin yalnızca kendi deneme hesabında saklanır.</p>
      <a className="access-button" href={chatGPTSignInPath('/')} target="_top">Örnek portföyü aç</a>
      <p>Kurulum gerekmez. ChatGPT hesabınla giriş yapabilirsin.</p>
      <p style={{ fontSize: '0.85rem' }}>AI ile görsel okuma ve Telegram bağlantısı bu ortamda henüz yapılandırılmadı.</p>
    </section></main>
  );
  return <main className="demo-shell">
    <aside className="demo-notice" aria-label="Örnek ortam bilgisi">
      <span><strong>Örnek portföy</strong> · Kayıtlar temsilidir; bu hesapta özgürce düzenleyebilirsin.</span>
      <a href={chatGPTSignOutPath('/')} target="_top">Çıkış</a>
    </aside>
    <iframe className="app-frame" src="/release-v14.17/index.html" title="Yatırım Defterim — Örnek portföy" />
  </main>;
}
