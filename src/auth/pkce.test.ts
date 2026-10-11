import { describe, expect, it } from 'vitest';
import { codeChallenge, randomToken } from './pkce';

describe('PKCE', () => {
  it('computes the RFC 7636 appendix B S256 challenge', async () => {
    await expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates 256-bit URL-safe verifiers that differ every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));

    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
