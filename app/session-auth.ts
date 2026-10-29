import { headers } from 'next/headers';
import { PRIMARY_ALLOWED_EMAIL } from '@/lib/access';

export type PortfolioUser = {
  userId: string;
  displayName: string;
  email: string;
};

const VERIFIED_HEADER = 'x-portfolio-access-verified';
const EMAIL_HEADER = 'x-portfolio-authenticated-email';

export async function getPortfolioUser(): Promise<PortfolioUser | null> {
  const requestHeaders = await headers();
  const hostname = (requestHeaders.get('host') || '').split(':', 1)[0].toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return {
      userId: 'local-preview',
      displayName: PRIMARY_ALLOWED_EMAIL,
      email: PRIMARY_ALLOWED_EMAIL,
    };
  }

  if (requestHeaders.get(VERIFIED_HEADER) !== '1') return null;
  const email = requestHeaders.get(EMAIL_HEADER)?.trim().toLowerCase() || '';
  if (!email) return null;
  return { userId: email, displayName: email, email };
}
