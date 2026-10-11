import { describe, expect, it } from 'vitest';
import { assertPlainText, assertResourceUrl, scanPageEdit } from './safety';

describe('assertPlainText', () => {
  it('accepts plain text with accents, line breaks and symbols like < in prose', () => {
    expect(() => assertPlainText({ name: 'Ação & Reação', description: 'Linha 1\nLinha 2 — 3 < 5' })).not.toThrow();
  });

  it.each([
    ['<img src=x onerror=alert(1)>'],
    ['<script>alert(1)</script>'],
    ['</p><b>x'],
    ['< img src=x>'],
    ['bidi ‮evil'],
    ['nul \u0000 byte'],
  ])('rejects %j with 422', (description) => {
    expect(() => assertPlainText({ description })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, details: { fields: ['description'] } }));
  });
});

describe('assertResourceUrl', () => {
  it.each(['https://www.kaggle.com/learn', 'https://pt.khanacademy.org/'])('accepts %s', (url) => {
    expect(() => assertResourceUrl(url)).not.toThrow();
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'http://example.org/',
    'https://user:pass@example.org/',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://exa mple.org/',
    '//example.org/',
    'not a url',
  ])('rejects %s with 422', (url) => {
    expect(() => assertResourceUrl(url)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
  });
});

const page = (body: string, front = 'layout: info\ntitle: Sobre\npermalink: /pt-BR/sobre/') => `---\n${front}\n---\n${body}\n`;
const problems = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { details?: { problems?: unknown } }).details?.problems;
  }
  return undefined;
};

describe('scanPageEdit', () => {
  const original = page('# Sobre\n\nA IPL é uma biblioteca.');

  it('accepts a plain Markdown edit', () => {
    expect(scanPageEdit(original, page('# Sobre\n\nA IPL é uma biblioteca pública.'), 'markdown')).toEqual({ containsHtml: false });
  });

  it('rejects <script> with its line number', () => {
    const proposed = page('# Sobre\n\nA IPL é uma biblioteca.\n<script>alert(1)</script>');

    expect(() => scanPageEdit(original, proposed, 'markdown')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
    expect(problems(() => scanPageEdit(original, proposed, 'markdown'))).toEqual([{ line: 9, reason: 'disallowed tag <script>' }]);
  });

  it('rejects an on*= attribute', () => {
    expect(problems(() => scanPageEdit(original, page('# Sobre\n\n<sup onmouseover="x()">1</sup>'), 'markdown'))).toContainEqual({ line: 8, reason: 'event handler attribute' });
  });

  it.each([
    '[clique](javascript:alert(1))',
    '![x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
  ])('rejects the script link %s', (link) => {
    expect(problems(() => scanPageEdit(original, page(`# Sobre\n\n${link}`), 'markdown'))).toContainEqual({ line: 8, reason: 'script or data URL' });
  });

  it('accepts allow-listed inline HTML and flags it for review', () => {
    expect(scanPageEdit(original, page('# Sobre\n\nAperte <kbd>Ctrl</kbd>+<kbd>K</kbd>, H<sub>2</sub>O, x<sup>2</sup><br>'), 'markdown')).toEqual({ containsHtml: true });
  });

  it('rejects other HTML in Markdown pages', () => {
    expect(problems(() => scanPageEdit(original, page('# Sobre\n\n<div class="x">oi</div>'), 'markdown'))).toContainEqual({ line: 8, reason: 'HTML tag <div> is not allowed in Markdown pages' });
  });

  it('allows tags inside fenced code blocks of Markdown pages', () => {
    expect(scanPageEdit(original, page('# Sobre\n\n```html\n<div>exemplo</div>\n```'), 'markdown')).toEqual({ containsHtml: false });
  });

  it('judges only the lines an HTML page edit adds', () => {
    const html = page('<div class="hero">\n  <p>Texto antigo</p>\n</div>');
    const edited = page('<div class="hero">\n  <p>Texto novo</p>\n</div>');

    expect(scanPageEdit(html, edited, 'html')).toEqual({ containsHtml: false });
    expect(problems(() => scanPageEdit(html, page('<div class="hero">\n  <p>Texto</p>\n  <iframe src="https://x"></iframe>\n</div>'), 'html'))).toEqual([{ line: 8, reason: 'disallowed tag <iframe>' }]);
  });

  it('rejects new Liquid tags', () => {
    expect(problems(() => scanPageEdit(original, page('# Sobre\n\n{% include_relative ../../.github/CODEOWNERS %}'), 'markdown'))).toContainEqual({ line: 8, reason: 'Liquid tag' });
  });

  it.each([
    ['permalink', 'layout: info\ntitle: Sobre\npermalink: /pt-BR/'],
    ['layout', 'layout: default\ntitle: Sobre\npermalink: /pt-BR/sobre/'],
    ['redirect_to', 'layout: info\ntitle: Sobre\npermalink: /pt-BR/sobre/\nredirect_to: https://evil.example'],
  ])('rejects a change to %s in front matter', (key, front) => {
    expect(problems(() => scanPageEdit(original, page('# Sobre\n\nA IPL é uma biblioteca.', front), 'markdown'))).toEqual([
      { line: 1, reason: `front matter ${key} cannot be changed` },
    ]);
  });

  it('allows changing the title', () => {
    expect(() => scanPageEdit(original, page('# Sobre\n\nA IPL é uma biblioteca.', 'layout: info\ntitle: Sobre a IPL\npermalink: /pt-BR/sobre/'), 'markdown')).not.toThrow();
  });
});
