import { AppError } from '../errors';

/**
 * Spec 003 rule 3: a suggested link must answer. Sites that refuse bots (401/403/429) still exist and pass; 404, 410,
 * 5xx, timeouts and network errors do not.
 */
export async function assertReachable(url: string, fetcher: typeof fetch, timeoutMs = 5000): Promise<void> {
  const attempt = (method: 'HEAD' | 'GET') =>
    fetcher(url, { method, redirect: 'follow', headers: { 'user-agent': 'ipl-contribute (+https://github.com/InternetPublicLibrary/contribute)' }, signal: AbortSignal.timeout(timeoutMs) });
  let status: number;
  try {
    let response = await attempt('HEAD');
    if (response.status === 405 || response.status === 501) response = await attempt('GET');
    status = response.status;
  } catch {
    status = 0;
  }
  if ((status >= 200 && status < 400) || [401, 403, 429].includes(status)) return;
  throw new AppError('VALIDATION_FAILED', 'The link does not answer. Check the address and try again.', { fields: ['url'], status });
}
