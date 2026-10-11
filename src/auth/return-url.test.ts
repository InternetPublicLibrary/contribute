import { describe, expect, it } from 'vitest';
import { resolveReturnUrl } from './return-url';

const ORIGINS = ['https://ipl.better-web.org'];
const HOME = 'https://ipl.better-web.org/';

describe('resolveReturnUrl', () => {
  it.each([
    'https://evil.example',
    '//evil.example',
    '///evil.example',
    'https://ipl.better-web.org@evil.example',
    'https://user:pass@ipl.better-web.org/',
    'https:\\evil.example',
    'https:/\\evil.example',
    'https://ipl.better-web.org\\@evil.example',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://ipl.better-web.org.evil.example',
    'https://evil.example/?https://ipl.better-web.org',
    'http://ipl.better-web.org/',
    'https://ipl.better-web.org:8443/',
    '/en-US/',
    'https://ipl.better-web.org/\nLocation: https://evil.example',
    ' https://evil.example',
    'https://ipl.better-web.org%2F@evil.example',
    '',
  ])('falls back to the site home for %j', (input) => {
    expect(resolveReturnUrl(input, ORIGINS)).toBe(HOME);
  });

  it.each([
    ['https://ipl.better-web.org/en-US/computing/', 'https://ipl.better-web.org/en-US/computing/'],
    ['https://ipl.better-web.org/pt-BR/ciência/?q=1#top', 'https://ipl.better-web.org/pt-BR/ci%C3%AAncia/?q=1#top'],
    ['https://IPL.better-web.org/x', 'https://ipl.better-web.org/x'],
  ])('keeps the IPL page %s', (input, expected) => {
    expect(resolveReturnUrl(input, ORIGINS)).toBe(expected);
  });

  it('never echoes a rejected input', () => {
    expect(resolveReturnUrl('https://evil.example/phish', ORIGINS)).not.toContain('evil');
  });

  it('takes the allow-list from configuration (staging and production differ)', () => {
    const staging = ['https://staging.ipl.better-web.org'];

    expect(resolveReturnUrl('https://ipl.better-web.org/en-US/', staging)).toBe('https://staging.ipl.better-web.org/');
    expect(resolveReturnUrl('https://staging.ipl.better-web.org/en-US/', staging)).toBe('https://staging.ipl.better-web.org/en-US/');
  });

  it('accepts http://localhost only when it is configured (development)', () => {
    expect(resolveReturnUrl('http://localhost:4000/en-US/', ['http://localhost:4000'])).toBe('http://localhost:4000/en-US/');
    expect(resolveReturnUrl('http://localhost:4000/en-US/', ORIGINS)).toBe(HOME);
  });
});
