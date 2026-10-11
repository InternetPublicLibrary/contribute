import { describe, expect, it } from 'vitest';
import type { Identity } from '../auth/identity';
import { authorCredit, coAuthorTrailer, commitMessage, creditName } from './attribution';

const github: Identity = { provider: 'github', id: '583231', login: 'octocat', name: 'The Octocat', profileUrl: 'https://github.com/octocat' };
const orcid: Identity = { provider: 'orcid', id: '0000-0002-1825-0097', name: 'Josiah Carberry', profileUrl: 'https://orcid.org/0000-0002-1825-0097' };

const trailers = (message: string) => message.split('\n').filter((line) => /^[A-Za-z-]+-by:/i.test(line));

describe('coAuthorTrailer', () => {
  it('uses the GitHub noreply address with the numeric id', () => {
    expect(coAuthorTrailer(github)).toBe('Co-authored-by: The Octocat <583231+octocat@users.noreply.github.com>');
  });

  it('credits ORCID users by name and iD, without e-mail', () => {
    const trailer = coAuthorTrailer(orcid);

    expect(trailer).toBe('Co-authored-by: Josiah Carberry <https://orcid.org/0000-0002-1825-0097>');
    expect(trailer).not.toMatch(/@/);
  });

  it('falls back to the login when the name is empty after cleaning', () => {
    expect(coAuthorTrailer({ ...github, name: '<>‮' })).toBe('Co-authored-by: octocat <583231+octocat@users.noreply.github.com>');
  });

  it('refuses identities that did not come from a provider', () => {
    expect(() => coAuthorTrailer({ ...github, id: 'abc' })).toThrow();
    expect(() => coAuthorTrailer({ ...orcid, id: 'not-an-orcid' })).toThrow();
  });
});

describe('commitMessage', () => {
  it('yields exactly one trailer even if the display name tries to inject another', () => {
    const mallory: Identity = { ...github, name: 'Ana\nCo-authored-by: Mallory <m@example.com>' };
    const message = commitMessage('Add resource suggestion', mallory);

    expect(trailers(message)).toEqual(['Co-authored-by: Ana Co-authored-by: Mallory m@example.com <583231+octocat@users.noreply.github.com>']);
  });

  it('strips CR, bidi and control characters and caps the name at 100 characters', () => {
    expect(creditName({ ...github, name: `A\r‮\u0007${'b'.repeat(200)}` })).toHaveLength(100);
    expect(creditName({ ...github, name: 'A\r\nB' })).toBe('A B');
  });

  it('keeps the subject on one line', () => {
    expect(commitMessage('Edit: Sobre\nCo-authored-by: x <y>', github).split('\n')[0]).toBe('Edit: Sobre Co-authored-by: x <y>');
  });
});

describe('authorCredit', () => {
  it('links the GitHub profile without an @mention', () => {
    expect(authorCredit(github)).toBe('[The Octocat](https://github.com/octocat) (GitHub)');
    expect(authorCredit(github)).not.toMatch(/@/);
  });

  it('shows the ORCID name and iD, no e-mail', () => {
    expect(authorCredit(orcid)).toBe('Josiah Carberry — ORCID iD [0000-0002-1825-0097](https://orcid.org/0000-0002-1825-0097)');
  });

  it('escapes Markdown in names', () => {
    expect(authorCredit({ ...github, name: '[click](https://evil.example)' })).toBe('[\\[click\\]\\(https://evil.example\\)](https://github.com/octocat) (GitHub)');
  });
});
