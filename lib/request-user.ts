export type RequestIdentity = { userId: string; accountUserId: string; email: string; local: boolean };

// Sites supplies these headers after sign-in. No personal-deployment identity is accepted.
export function getRequestIdentity(request: Request): RequestIdentity | null {
  const userId = request.headers.get('oai-authenticated-user-id')?.trim();
  const email = request.headers.get('oai-authenticated-user-email')?.trim();
  if (!userId || !email) return null;
  return { userId, accountUserId: userId, email, local: false };
}
export function getRequestUserId(request: Request): string | null {
  return getRequestIdentity(request)?.userId || null;
}
