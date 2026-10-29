import { isAllowedEmail, PRIMARY_ALLOWED_EMAIL, SHARED_PORTFOLIO_USER_ID } from '@/lib/access';

export type RequestIdentity = {
  userId: string;
  accountUserId: string;
  email: string;
  local: boolean;
};

export function getRequestIdentity(request: Request): RequestIdentity | null {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return {
      userId: 'local-preview',
      accountUserId: 'local-preview',
      email: PRIMARY_ALLOWED_EMAIL,
      local: true,
    };
  }

  if (request.headers.get('x-portfolio-access-verified') !== '1') return null;
  const email = request.headers.get('x-portfolio-authenticated-email')?.trim().toLowerCase() || '';
  if (!isAllowedEmail(email)) return null;
  const accountUserId = email;
  return { userId: SHARED_PORTFOLIO_USER_ID, accountUserId, email, local: false };
}

export function getRequestUserId(request: Request): string | null {
  return getRequestIdentity(request)?.userId || null;
}
