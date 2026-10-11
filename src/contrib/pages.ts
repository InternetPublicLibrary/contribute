import type { Settings } from '../config/environment';
import { AppError } from '../errors';
import type { RepositoryRef } from '../github/client';
import { isLanguage, type Language } from './topics';

export interface PageSource {
  lang: Language;
  repository: RepositoryRef;
  /** Files that may hold the page, in lookup order. */
  candidates: string[];
  pagePath: string;
}

const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * Map an IPL page URL to its content repository and the files that may hold it (issue #11). Only allowed IPL origins
 * and the language prefixes of configured repositories are accepted; every segment must be a plain name.
 */
export function pageSource(input: unknown, settings: Settings): PageSource {
  const invalid = () => new AppError('VALIDATION_FAILED', 'url must be the address of an IPL page.', { fields: ['url'] });
  if (typeof input !== 'string' || input.length > 2048 || /[\\\p{Cc}\s]/u.test(input)) throw invalid();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid();
  }
  if (url.username || url.password || !settings.allowedOrigins.includes(url.origin)) throw invalid();

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).normalize('NFC');
  } catch {
    throw invalid();
  }
  const [lang, ...segments] = decoded.split('/').filter(Boolean);
  if (!isLanguage(lang)) throw new AppError('NOT_FOUND', 'Only en-US and pt-BR pages can be edited.');
  const repository = settings.repositories[lang];
  if (!repository) throw new AppError('NOT_FOUND', `No content repository is configured for ${lang}.`);
  if (decoded.includes('//') || !segments.every((segment) => SEGMENT.test(segment) && segment !== '..' && !segment.startsWith('.'))) {
    throw invalid();
  }

  const base = segments.join('/');
  const candidates = base
    ? [`${base}/index.html`, `${base}/index.md`, `${base}.html`, `${base}.md`]
    : ['index.html', 'index.md'];
  return { lang, repository, candidates, pagePath: `/${lang}/${base ? `${base}/` : ''}` };
}
