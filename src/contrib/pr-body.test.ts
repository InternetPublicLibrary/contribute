import { describe, expect, it } from 'vitest';
import type { Identity } from '../auth/identity';
import { escapeUserText, MAX_BODY, renderPullRequestBody } from './pr-body';

const identity: Identity = { provider: 'github', id: '583231', login: 'octocat', name: 'The Octocat', profileUrl: 'https://github.com/octocat' };
const base = { kind: 'edit' as const, identity, pageUrl: 'https://ipl.better-web.org/pt-BR/sobre/', path: 'sobre.html' };

/** GitHub turns these into notifications, links or issue closings. */
const MENTION = /(^|[^\w])@[A-Za-z0-9]/;
const REFERENCE = /(^|[^\w])#\d|[\w.-]+\/[\w.-]+#\d/;
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*:?\s*(#|[\w.-]+\/[\w.-]+#|https?:\/\/)/i;

describe('renderPullRequestBody', () => {
  it('renders a multi-line summary as one quoted block, never as table rows', () => {
    const body = renderPullRequestBody({ ...base, summary: 'Linha 1\r\n| a | b |\n|---|---|\nLinha 3' });

    expect(body).toMatchInlineSnapshot(`
      "### Page edit

      - **Page:** https://ipl.better-web.org/pt-BR/sobre/
      - **File:** \`sobre.html\`
      - **Contributor:** [The Octocat](https://github.com/octocat) (GitHub)

      **Summary**

      > Linha 1
      > \\| a \\| b \\|
      > \\|---\\|---\\|
      > Linha 3

      ---
      Opened by IPL contribute for a signed-in reader. Review the diff: merge to publish, close to decline.
      <!-- contribute-identity:github:583231 -->"
    `);
  });

  it('produces no mention, issue reference or closing keyword from reader text', () => {
    const body = renderPullRequestBody({ ...base, summary: '@octocat please review. Fixes #1, closes InternetPublicLibrary/pt-BR#3, resolves https://github.com/o/r/issues/2' });
    const quoted = body.split('\n').filter((line) => line.startsWith('>')).join('\n');

    expect(quoted).not.toMatch(MENTION);
    expect(quoted).not.toMatch(REFERENCE);
    expect(quoted).not.toMatch(CLOSING);
  });

  it('keeps HTML and links as text', () => {
    const escaped = escapeUserText('<img src=x onerror=alert(1)> [click](https://evil.example) www.evil.example');

    expect(escaped).not.toMatch(/<img/);
    expect(escaped).not.toMatch(/\]\(/);
    expect(escaped).not.toMatch(/https:\/\//);
    expect(escaped).not.toMatch(/www\./);
  });

  it('rejects a 100 000-character summary with 422', () => {
    expect(() => renderPullRequestBody({ ...base, summary: 'x'.repeat(100_000) })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
  });

  it('never exceeds 60 000 characters', () => {
    const fields = Object.fromEntries(Array.from({ length: 40 }, (_v, index) => [`field${index}`, 'y'.repeat(1990)]));

    expect(() => renderPullRequestBody({ ...base, kind: 'suggestion', summary: 'x'.repeat(2000), fields })).toThrow(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
    expect(renderPullRequestBody({ ...base, summary: 'x'.repeat(2000) }).length).toBeLessThan(MAX_BODY);
  });

  it('quotes suggestion fields and flags inline HTML for reviewers', () => {
    const body = renderPullRequestBody({ ...base, kind: 'suggestion', fields: { Name: 'Kaggle', Description: 'Cursos @kaggle' }, containsHtml: true });

    expect(body).toContain('### Resource suggestion');
    expect(body).toContain('**Name**\n\n> Kaggle');
    expect(body).toContain('This edit adds inline HTML');
    expect(body.split('\n').filter((line) => line.startsWith('> ')).join('\n')).not.toMatch(MENTION);
  });

  it('contains no external links besides the IPL page and the contributor profile', () => {
    const links = renderPullRequestBody({ ...base, summary: 'see https://evil.example' }).match(/https?:\/\/[^\s)]+/g);

    expect(links).toEqual(['https://ipl.better-web.org/pt-BR/sobre/', 'https://github.com/octocat']);
  });
});
