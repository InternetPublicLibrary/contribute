import { load } from 'js-yaml';
import { AppError } from '../errors';

/**
 * Content safety for contributions (issue #3). Code-owner review stays the backstop; these rules make the obvious
 * attacks impossible to submit and point reviewers at anything unusual.
 */

const TAG = /<\s*\/?\s*[A-Za-z!?]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const BIDI = /[‪-‮⁦-⁩‎‏؜]/;

/** Suggestion text (name, description, …) is plain text: no tags, control characters (other than \n) or bidi controls. */
export function assertPlainText(fields: Record<string, string | undefined>): void {
  const bad = Object.entries(fields)
    .filter(([, value]) => value !== undefined && (TAG.test(value) || CONTROL.test(value.replace(/\r?\n/g, '')) || BIDI.test(value)))
    .map(([field]) => field);
  if (bad.length) throw new AppError('VALIDATION_FAILED', 'Use plain text only: no HTML tags or control characters.', { fields: bad });
}

/** A resource link must be a public https URL (rejects javascript:, data:, vbscript:, credentials and odd hosts). */
export function assertResourceUrl(value: string, field = 'url'): void {
  let url: URL | undefined;
  try {
    url = /[\s\\\p{Cc}]/u.test(value) ? undefined : new URL(value);
  } catch {
    url = undefined;
  }
  const ok = url && url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') && !/^[\d.]+$/.test(url.hostname);
  if (!ok) throw new AppError('VALIDATION_FAILED', 'The link must be a public https:// address.', { fields: [field] });
}

export interface EditProblem {
  line: number;
  reason: string;
}

export interface EditScan {
  /** Allowed inline HTML was added (reviewers get a `contains-html` label). */
  containsHtml: boolean;
}

/** Inline HTML a Markdown page edit may add. */
export const ALLOWED_TAGS = ['kbd', 'sup', 'sub', 'br'];
const DANGEROUS_TAGS = ['script', 'iframe', 'object', 'embed', 'style', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'svg', 'math', 'template', 'frame', 'frameset', 'applet', 'noscript', 'portal'];
/** Front matter that decides where and how the page is published. */
export const PROTECTED_FRONT_MATTER = ['permalink', 'layout', 'redirect_from', 'redirect_to', 'lang', 'published'];

/** A numeric entity outside Unicode is left as written (fromCodePoint would throw). */
const codePoint = (match: string, value: number) => (Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match);

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex: string) => codePoint(match, parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (match, dec: string) => codePoint(match, Number(dec)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;|&newline;/gi, '');
}

function frontMatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match?.[1]) return {};
  try {
    const value = load(match[1]);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return { __invalid__: true };
  }
}

/** Lines of `proposed` that are new or changed compared with `original` (by content), with 1-based numbers. */
function addedLines(original: string, proposed: string): { line: number; text: string }[] {
  const before = new Map<string, number>();
  for (const line of original.split(/\r?\n/)) before.set(line, (before.get(line) ?? 0) + 1);
  const added: { line: number; text: string }[] = [];
  proposed.split(/\r?\n/).forEach((text, index) => {
    const count = before.get(text) ?? 0;
    if (count > 0) before.set(text, count - 1);
    else added.push({ line: index + 1, text });
  });
  return added;
}

/**
 * Scan a page edit. Only lines the edit adds or changes are judged, so existing page HTML is not re-litigated.
 * Always rejected in added lines: dangerous tags, `on*=` handlers, `javascript:`/`data:`/`vbscript:` URLs (also
 * entity-encoded) and new Liquid tags. Markdown pages may add only ALLOWED_TAGS. Publishing front matter may not change.
 * Throws 422 with the offending line numbers.
 */
export function scanPageEdit(original: string, proposed: string, kind: 'markdown' | 'html'): EditScan {
  const problems: EditProblem[] = [];
  let containsHtml = false;
  let inFence = false;

  const lines = proposed.split(/\r?\n/);
  const fences = new Set<number>();
  lines.forEach((text, index) => {
    if (kind === 'markdown' && /^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      fences.add(index + 1);
    } else if (inFence) fences.add(index + 1);
  });

  const added = addedLines(original, proposed);
  const addedNumbers = new Set(added.map(({ line }) => line));

  // Event handlers are found per tag over the whole text, so a tag split across lines cannot hide one.
  const lineAt = (offset: number) => proposed.slice(0, offset).split(/\r?\n/).length;
  for (const tag of proposed.matchAll(/<\s*[A-Za-z][\w-]*\b[^>]*>/g)) {
    const start = tag.index;
    const handler = /\bon[a-z]+\s*=/i.exec(decodeEntities(tag[0]));
    if (!handler) continue;
    const first = lineAt(start);
    const last = lineAt(start + tag[0].length);
    const touched = Array.from({ length: last - first + 1 }, (_v, index) => first + index).filter((line) => addedNumbers.has(line));
    if (touched.length) problems.push({ line: touched[0] ?? first, reason: 'event handler attribute' });
  }

  for (const { line, text } of added) {
    const decoded = decodeEntities(text);
    // Only where a URL is expected (Markdown link or definition, HTML URL attribute, autolink), so prose such as
    // "JavaScript: The Good Parts" or "Open data: portals" is fine.
    if (/(?:\]\(|\]:|(?:href|src|action|formaction|xlink:href|poster|background)=|<)["']?(?:javascript|vbscript|data):/i.test(decoded.replace(/\s+/g, ''))) {
      problems.push({ line, reason: 'script or data URL' });
    }
    if (/\{%|\{\{/.test(text)) problems.push({ line, reason: 'Liquid tag' });

    const tags = [...decoded.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9-]*)/g)].map((match) => (match[1] ?? '').toLowerCase());
    const dangerous = tags.filter((tag) => DANGEROUS_TAGS.includes(tag));
    if (dangerous.length) problems.push({ line, reason: `disallowed tag <${dangerous[0]}>` });
    else if (kind === 'markdown' && !fences.has(line) && tags.length) {
      const outside = tags.filter((tag) => !ALLOWED_TAGS.includes(tag));
      if (outside.length) problems.push({ line, reason: `HTML tag <${outside[0]}> is not allowed in Markdown pages` });
      else containsHtml = true;
    } else if (kind === 'markdown' && !fences.has(line) && /<!--/.test(decoded)) {
      problems.push({ line, reason: 'HTML comment' });
    }
  }

  const before = frontMatter(original);
  const after = frontMatter(proposed);
  const changed = PROTECTED_FRONT_MATTER.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if ('__invalid__' in after) problems.push({ line: 1, reason: 'front matter is not valid YAML' });
  else if (changed.length) problems.push({ line: 1, reason: `front matter ${changed.join(', ')} cannot be changed` });

  if (problems.length) {
    throw new AppError('VALIDATION_FAILED', 'The edit contains content that is not allowed.', { problems: problems.sort((a, b) => a.line - b.line) });
  }
  return { containsHtml };
}
