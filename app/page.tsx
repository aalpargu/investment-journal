import Link from 'next/link';
import { getPortfolioUser } from '@/app/session-auth';
import { isAllowedEmail } from '@/lib/access';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getPortfolioUser();
  if (!user || !isAllowedEmail(user.email)) {
    return (
      <main className="access-shell">
        <section className="access-card">
          <div className="access-mark">◔</div>
          <p className="access-eyebrow">ÖZEL PORTFÖY</p>
          <h1>Bu hesap için erişim yok</h1>
          <p>
            {user
              ? <><strong>{user.email}</strong> izin verilen hesaplardan biri değil.</>
              : <>Google oturumu doğrulanamadı.</>}
          </p>
          <Link className="access-button" href="/logout" target="_top">Farklı hesapla giriş yap</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="app-frame-shell">
      <iframe
        className="app-frame"
        src="/release-v14.17/index.html"
        title="Yatırım Defterim"
      />
    </main>
  );
}
