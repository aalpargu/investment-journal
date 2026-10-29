import vinextHandler from 'vinext/server/fetch-handler';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

type WorkerEnv = Cloudflare.Env & {
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  SESSION_SECRET?: string;
  DESKTOP_SYNC_SECRET?: string;
  MONITOR_ALERT_SECRET?: string;
};

const VERIFIED_HEADER = 'x-portfolio-access-verified';
const AUTHENTICATED_EMAIL_HEADER = 'x-portfolio-authenticated-email';
const DESKTOP_KEY_HEADER = 'x-portfolio-desktop-key';
const MONITOR_KEY_HEADER = 'x-portfolio-monitor-key';
const SESSION_COOKIE = 'portfolio_session';
const LOGIN_NONCE_COOKIE = 'portfolio_login_nonce';
const SESSION_AUDIENCE = 'yatirim-defterim';
const PRIMARY_EMAIL = 'owner@example.com';
const ALLOWED_EMAILS = new Set([
  PRIMARY_EMAIL,
  'second-owner@example.com',
  'third-owner@example.com',
]);
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function legalPage(kind: 'privacy' | 'terms'): Response {
  const privacy = kind === 'privacy';
  const title = privacy ? 'Gizlilik Politikası' : 'Kullanım Koşulları';
  const content = privacy
    ? `<p>Yatırım Defterim, yalnızca yetkilendirilmiş kullanıcıların kişisel portföy verilerini cihazları arasında eşitlemek için kullanılır.</p>
       <h2>İşlenen bilgiler</h2>
       <p>Google ile giriş sırasında hesabın e-posta adresi, hesabın izin listesinde olup olmadığını doğrulamak için işlenir. Portföy kayıtları Cloudflare D1 veritabanında saklanır.</p>
       <h2>Paylaşım ve kullanım</h2>
       <p>Veriler reklam, profil oluşturma veya satış amacıyla kullanılmaz. Uygulamanın çalışması için zorunlu Google kimlik doğrulama ve Cloudflare barındırma hizmetleri dışında üçüncü taraflarla paylaşılmaz.</p>
       <h2>Erişim ve silme</h2>
       <p>Verilerine erişmek veya verilerinin silinmesini istemek için <a href="mailto:owner@example.com">owner@example.com</a> adresine başvurabilirsin.</p>`
    : `<p>Yatırım Defterim, sınırlı sayıda yetkili kullanıcı için hazırlanmış kişisel bir portföy takip aracıdır.</p>
       <h2>Kullanım</h2>
       <p>Uygulamaya yalnızca izin verilen Google hesaplarıyla erişilebilir. Kullanıcılar kendi hesaplarının ve cihazlarının güvenliğinden sorumludur.</p>
       <h2>Finansal bilgi</h2>
       <p>Uygulamadaki hesaplamalar, fiyatlar ve özetler bilgilendirme amaçlıdır; yatırım tavsiyesi değildir. Finansal kararlar kullanıcıya aittir.</p>
       <h2>Hizmet</h2>
       <p>Hizmet kişisel kullanım için olduğu gibi sunulur. Bakım, güvenlik veya teknik nedenlerle erişim geçici olarak sınırlandırılabilir.</p>`;
  const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Yatırım Defterim</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#070b14;color:#e8eefb;font:16px/1.65 system-ui,sans-serif}main{width:min(92vw,760px);margin:64px auto;padding:36px;border:1px solid #24304a;border-radius:22px;background:#101827}h1{margin:0 0 24px;font-size:30px}h2{margin:28px 0 8px;font-size:19px}p{color:#bdc8dc}a{color:#7dd3fc}.meta{font-size:14px;color:#8492aa}.nav{margin-top:34px;padding-top:20px;border-top:1px solid #24304a}
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p class="meta">Son güncelleme: 5 Eylül 2026</p>
    ${content}
    <p class="nav"><a href="/login">Giriş sayfasına dön</a> · <a href="/${privacy ? 'terms' : 'privacy'}">${privacy ? 'Kullanım Koşulları' : 'Gizlilik Politikası'}</a></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try {
      result.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // Ignore malformed cookies instead of turning an unauthenticated request into a 500.
    }
  }
  return result;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function sessionEmail(request: Request, secret: string): Promise<string> {
  const token = cookies(request).get(SESSION_COOKIE);
  if (!token || secret.length < 32) return '';
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      audience: SESSION_AUDIENCE,
      algorithms: ['HS256'],
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return ALLOWED_EMAILS.has(email) ? email : '';
  } catch {
    return '';
  }
}

async function sameSecret(received: string, expected: string): Promise<boolean> {
  if (!received || expected.length < 32) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function loginPage(clientId: string, nonce: string): Response {
  const config = JSON.stringify({ clientId, nonce }).replaceAll('<', '\\u003c');
  const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Yatırım Defterim — Giriş</title>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b14;color:#eef2ff;font:16px/1.5 system-ui,sans-serif}.card{width:min(92vw,430px);padding:36px;border:1px solid #24304a;border-radius:22px;background:#101827;box-shadow:0 24px 70px #0008}.mark{font-size:42px;color:#7dd3fc}h1{margin:12px 0 8px;font-size:28px}p{margin:0 0 24px;color:#aab6cf}.button{min-height:44px}.error{min-height:24px;margin-top:18px;color:#fda4af;font-size:14px}
  </style>
</head>
<body>
  <main class="card">
    <div class="mark">◔</div>
    <h1>Yatırım Defterim</h1>
    <p>Özel portföyünü açmak için yetkili Google hesabını seç.</p>
    <div id="google-button" class="button"></div>
    <div id="error" class="error" role="alert"></div>
    <p style="margin:18px 0 0;font-size:13px"><a style="color:#7dd3fc" href="/privacy">Gizlilik</a> · <a style="color:#7dd3fc" href="/terms">Koşullar</a></p>
  </main>
  <script>
    const auth = ${config};
    window.onload = () => {
      google.accounts.id.initialize({
        client_id: auth.clientId,
        nonce: auth.nonce,
        callback: async ({ credential }) => {
          const error = document.getElementById('error');
          error.textContent = '';
          const response = await fetch('/auth/google', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential }),
          });
          if (response.ok) location.replace('/');
          else error.textContent = (await response.json().catch(() => null))?.error || 'Giriş tamamlanamadı.';
        },
      });
      google.accounts.id.renderButton(document.getElementById('google-button'), {
        type: 'standard', theme: 'filled_blue', size: 'large', width: 350, text: 'continue_with', locale: 'tr',
      });
    };
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; style-src 'unsafe-inline'; img-src https://*.googleusercontent.com data:; base-uri 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Set-Cookie': cookie(LOGIN_NONCE_COOKIE, nonce, 600),
    },
  });
}

async function completeGoogleLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() || '';
  const sessionSecret = env.SESSION_SECRET?.trim() || '';
  const expectedNonce = cookies(request).get(LOGIN_NONCE_COOKIE) || '';
  if (!clientId || sessionSecret.length < 32 || !expectedNonce) {
    return Response.json({ error: 'Giriş yapılandırması tamamlanmadı.' }, { status: 503 });
  }
  try {
    const body = await request.json<{ credential?: unknown }>();
    const credential = typeof body.credential === 'string' ? body.credential : '';
    if (!credential || credential.length > 8192) throw new Error('Invalid credential');
    const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      audience: clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      algorithms: ['RS256'],
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (payload.nonce !== expectedNonce || payload.email_verified !== true || !ALLOWED_EMAILS.has(email)) {
      return Response.json({ error: 'Bu Google hesabının portföye erişim izni yok.' }, { status: 403 });
    }
    const session = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secretKey(sessionSecret));
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, session, 604800));
    headers.append('Set-Cookie', cookie(LOGIN_NONCE_COOKIE, '', 0));
    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch {
    return Response.json({ error: 'Google oturumu doğrulanamadı.' }, { status: 403 });
  }
}

export default {
  async fetch(request, env, context): Promise<Response> {
    const url = new URL(request.url);
    const clientId = env.GOOGLE_CLIENT_ID?.trim() || '';
    const sessionSecret = env.SESSION_SECRET?.trim() || '';

    if (url.pathname === '/login' && request.method === 'GET') {
      if (!clientId) return Response.json({ error: 'Google giriş istemcisi henüz yapılandırılmadı.' }, { status: 503 });
      return loginPage(clientId, crypto.randomUUID().replaceAll('-', ''));
    }
    if (url.pathname === '/auth/google' && request.method === 'POST') {
      return completeGoogleLogin(request, env);
    }
    if (url.pathname === '/logout' && request.method === 'GET') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/login', 'Set-Cookie': cookie(SESSION_COOKIE, '', 0), 'Cache-Control': 'no-store' },
      });
    }
    if (request.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/terms')) {
      return legalPage(url.pathname === '/privacy' ? 'privacy' : 'terms');
    }

    const headers = new Headers(request.headers);
    const desktopKey = headers.get(DESKTOP_KEY_HEADER) || '';
    const monitorKey = headers.get(MONITOR_KEY_HEADER) || '';
    headers.delete(VERIFIED_HEADER);
    headers.delete(AUTHENTICATED_EMAIL_HEADER);
    headers.delete(DESKTOP_KEY_HEADER);
    headers.delete(MONITOR_KEY_HEADER);

    let email = await sessionEmail(request, sessionSecret);
    if (!email && await sameSecret(desktopKey, env.DESKTOP_SYNC_SECRET?.trim() || '')) email = PRIMARY_EMAIL;
    const monitorAuthorized = url.pathname === '/api/monitor-alert'
      && request.method === 'POST'
      && await sameSecret(monitorKey, env.MONITOR_ALERT_SECRET?.trim() || '');
    if (!email && monitorAuthorized) email = PRIMARY_EMAIL;
    if (!email) {
      if (request.method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
        return Response.redirect(new URL('/login', url), 302);
      }
      return Response.json({ error: 'Oturum açmanız gerekiyor.' }, { status: 401 });
    }

    const oldReleaseEntry = url.pathname.match(/^\/release-v([^/]+)(?:\/(?:index\.html)?)?$/);
    if (request.method === 'GET' && oldReleaseEntry && oldReleaseEntry[1] !== '14.17') {
      const currentUrl = new URL('/', url);
      currentUrl.searchParams.set('release', '14.17');
      return Response.redirect(currentUrl, 302);
    }

    if (request.method === 'GET' && url.pathname === '/api/release') {
      return Response.json({ version: '14.17', releasePath: '/release-v14.17/index.html' }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    headers.set(VERIFIED_HEADER, '1');
    headers.set(AUTHENTICATED_EMAIL_HEADER, email);
    const forwardedRequest = new Request(request, { headers });
    if (
      request.method === 'GET'
      && (
        url.pathname.startsWith('/_next/static/')
        || url.pathname.startsWith('/legacy/')
        || url.pathname.startsWith('/release-v')
        || url.pathname === '/og.png'
        || url.pathname === '/vinext-client-entry-manifest.json'
      )
    ) {
      const assetResponse = await env.ASSETS.fetch(forwardedRequest);
      return url.pathname.endsWith('/index.html') ? noStore(assetResponse) : assetResponse;
    }
    const response = await vinextHandler.fetch(forwardedRequest, env, context);
    return request.method === 'GET' && request.headers.get('accept')?.includes('text/html') ? noStore(response) : response;
  },
} satisfies ExportedHandler<WorkerEnv>;
