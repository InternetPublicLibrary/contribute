import type { Identity } from '../auth/identity';
import { AppError } from '../errors';
import { authorCredit } from './attribution';

/**
 * Pull request bodies (issue #8). One fixed template; reader text only inside a quote, escaped so it cannot format the
 * page, mention people, reference or close issues. File content never goes in the body — the diff shows it.
 */
export const MAX_SUMMARY = 2000;
export const MAX_BODY = 60_000;
const JOINER = '⁠';

/** Escape reader text for a Markdown quote: no HTML, no links, no mentions, no issue references or closing keywords. */
export function escapeUserText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]()#!|~])/g, '\\$1')
    .replace(/@/g, `@${JOINER}`)
    .replace(/:\/\//g, `:${JOINER}//`)
    .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}${JOINER}.`)
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi, (word) => `${word.slice(0, 1)}${JOINER}${word.slice(1)}`)
    .replace(/(\d)/g, (digit, _d, offset: number, whole: string) => (whole[offset - 1] === '#' ? `${JOINER}${digit}` : digit));
}

/** Every line of the text inside a Markdown quote, so line breaks never become structure. */
export function quote(text: string): string {
  return escapeUserText(text)
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

export interface BodyInput {
  kind: 'edit' | 'suggestion';
  identity: Identity;
  /** IPL page the contribution is about (built from validated values). */
  pageUrl: string;
  /** Repository path of the changed file. */
  path: string;
  summary?: string;
  /** Suggestion fields shown to reviewers, each quoted. */
  fields?: Record<string, string | undefined>;
  containsHtml?: boolean;
}

/** Hidden marker that lets GET /v1/contributions and the webhook find a person's pull requests. */
export const identityMarker = (identity: Identity) => `<!-- contribute-identity:${identity.provider}:${identity.id} -->`;

export function renderPullRequestBody(input: BodyInput): string {
  const summary = (input.summary ?? '').replace(/\r\n?/g, '\n').trim();
  if (summary.length > MAX_SUMMARY) {
    throw new AppError('VALIDATION_FAILED', `The summary is longer than ${MAX_SUMMARY} characters.`, { fields: ['summary'] });
  }

  const lines = [
    input.kind === 'edit' ? '### Page edit' : '### Resource suggestion',
    '',
    `- **Page:** ${input.pageUrl}`,
    `- **File:** \`${input.path.replace(/`/g, '')}\``,
    `- **Contributor:** ${authorCredit(input.identity)}`,
    '',
  ];
  if (summary) lines.push('**Summary**', '', quote(summary), '');
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    if (value) lines.push(`**${name}**`, '', quote(value), '');
  }
  if (input.containsHtml) lines.push('> [!WARNING]', '> This edit adds inline HTML. Check it before merging.', '');
  lines.push(
    '---',
    'Opened by IPL contribute for a signed-in reader. Review the diff: merge to publish, close to decline.',
    identityMarker(input.identity),
  );

  const body = lines.join('\n');
  if (body.length > MAX_BODY) throw new AppError('PAYLOAD_TOO_LARGE', 'The contribution text is too long.');
  return body;
}
