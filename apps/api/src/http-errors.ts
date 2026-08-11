export type PublicClientError = {
  statusCode: number;
  code: 'rate_limited' | 'request_error';
};

export function publicClientError(error: unknown): PublicClientError | null {
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode) || statusCode < 400 || statusCode >= 500) return null;
  return { statusCode, code: statusCode === 429 ? 'rate_limited' : 'request_error' };
}
