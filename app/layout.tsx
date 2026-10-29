import type { Metadata, Viewport } from 'next';
import './globals.css';

const siteOrigin = 'https://investment-journal-demo-alpargu.flowydream.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  applicationName: 'Yatırım Defterim — Örnek Portföy',
  title: 'Yatırım Defterim — Örnek Portföy',
  description: 'Yatırım Defterim uygulamasını örnek portföyle inceleyin.',
  manifest: '/release-v14.17/manifest.json',
  icons: {
    icon: '/release-v14.17/icons/icon.svg',
    apple: '/release-v14.17/icons/icon-192.png',
  },
  appleWebApp: {
    capable: true,
    title: 'Yatırım Defterim — Örnek Portföy',
    statusBarStyle: 'black-translucent',
  },
  openGraph: {
    type: 'website',
    url: siteOrigin,
    siteName: 'Yatırım Defterim — Örnek Portföy',
    title: 'Yatırım Defterim — Örnek Portföy',
    description: 'Portföyün, her cihazda seninle.',
    images: [{ url: `${siteOrigin}/og.png`, width: 1743, height: 909, alt: 'Yatırım Defterim — Portföyün, her cihazda seninle.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Yatırım Defterim — Örnek Portföy',
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
