import { AppError } from '../errors';
import { assertResourceUrl } from './safety';

const MAX_REDIRECTS = 3;

/**
 * Spec 003 rule 3: a suggested link must answer. Sites that refuse bots (401/403/429) still exist and pass; 404, 410,
 * 5xx, timeouts and network errors do not. Redirects are followed by hand and every hop must again be a public https
 * address, so a link cannot bounce the probe to http, localhost or an IP address.
 */
export async function assertReachable(url: string, fetcher: typeof fetch, timeoutMs = 5000): Promise<void> {
  const unreachable = (status: number) =>
    new AppError('VALIDATION_FAILED', 'The link does not answer. Check the address and try again.', { fields: ['url'], status });
  const attempt = (target: string, method: 'HEAD' | 'GET') =>
    fetcher(target, {
      method,
      redirect: 'manual',
      headers: { 'user-agent': 'ipl-contribute (+https://github.com/InternetPublicLibrary/contribute)' },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertResourceUrl(target);
    let response: Response;
    try {
      response = await attempt(target, 'HEAD');
      if (response.status === 405 || response.status === 501) response = await attempt(target, 'GET');
    } catch {
      throw unreachable(0);
    }
    const status = response.status;
    if (status >= 300 && status < 400 && response.headers.has('location')) {
      target = new URL(response.headers.get('location') ?? '', target).href;
      continue;
    }
    if ((status >= 200 && status < 300) || [401, 403, 429].includes(status)) return;
    throw unreachable(status);
  }
  throw unreachable(310);
}
