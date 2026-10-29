import type { Metadata, Viewport } from 'next';
import './globals.css';

const siteOrigin = process.env.PUBLIC_SITE_ORIGIN || 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  applicationName: 'Yatırım Defterim',
  title: 'Yatırım Defterim',
  description: 'Cihazlar arasında eşitlenen kişisel portföy yönetim uygulaması',
  manifest: '/legacy/manifest.json',
  icons: {
    icon: '/legacy/icons/icon.svg',
    apple: '/legacy/icons/icon-192.png',
  },
  appleWebApp: {
    capable: true,
    title: 'Yatırım Defterim',
    statusBarStyle: 'black-translucent',
  },
  openGraph: {
    type: 'website',
    url: siteOrigin,
    siteName: 'Yatırım Defterim',
    title: 'Yatırım Defterim',
    description: 'Portföyün, her cihazda seninle.',
    images: [{ url: `${siteOrigin}/og.png`, width: 1743, height: 909, alt: 'Yatırım Defterim — Portföyün, her cihazda seninle.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Yatırım Defterim',
    description: 'Portföyün, her cihazda seninle.',
    images: [`${siteOrigin}/og.png`],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#10141d',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
