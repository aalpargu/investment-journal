export const SHARED_PORTFOLIO_USER_ID = 'shared-primary-portfolio';
export const PRIMARY_ALLOWED_EMAIL = 'owner@example.com';

const ALLOWED_EMAILS = new Set([
  PRIMARY_ALLOWED_EMAIL,
  'second-owner@example.com',
  'third-owner@example.com',
]);

export function normalizeEmail(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

export function isAllowedEmail(value: string | null | undefined): boolean {
  const email = normalizeEmail(value);
  return ALLOWED_EMAILS.has(email);
}
