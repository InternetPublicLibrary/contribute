import type { Identity } from '../auth/identity';
import { singleLine } from '../text';

/**
 * Credit built only from the verified session identity (issue #16, ADR 0003). The commit author is the App; people
 * are credited by a single trailer and by the PR body. No request field takes part in any of this.
 */

/** Display name safe for a trailer: one line, no `<`, `>`, control or bidi characters, at most 100 characters. */
export function creditName(identity: Identity): string {
  const cleaned = singleLine(identity.name, 100).replace(/[<>]/g, '').trim();
  return cleaned || identity.login || identity.id;
}

const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export function coAuthorTrailer(identity: Identity): string {
  if (identity.provider === 'github') {
    if (!/^\d+$/.test(identity.id) || !identity.login || !GITHUB_LOGIN.test(identity.login)) throw new Error('Invalid GitHub identity');
    return `Co-authored-by: ${creditName(identity)} <${identity.id}+${identity.login}@users.noreply.github.com>`;
  }
  if (!ORCID_ID.test(identity.id)) throw new Error('Invalid ORCID identity');
  // No e-mail is collected: the ORCID iD URL is the identifier (ADR 0003).
  return `Co-authored-by: ${creditName(identity)} <https://orcid.org/${identity.id}>`;
}

/** Commit message: a one-line subject (≤ 72 characters), a blank line and exactly one trailer. */
export function commitMessage(subject: string, identity: Identity): string {
  return `${singleLine(subject, 72)}\n\n${coAuthorTrailer(identity)}\n`;
}

/** Markdown credit for the PR body: name and profile link; GitHub logins are linked, not @mentioned. */
export function authorCredit(identity: Identity): string {
  // Escape Markdown, and break `@` and `://` with a word joiner so a display name can neither mention people nor
  // become a link.
  const name = creditName(identity)
    .replace(/[[\]()*_`\\|#!~<>]/g, '\\$&')
    .replace(/@/g, '@\u2060')
    .replace(/:\/\//g, ':\u2060//')
    .replace(/\bwww\./gi, 'www\u2060.');
  if (identity.provider === 'github') return `[${name}](https://github.com/${identity.login ?? ''}) (GitHub)`;
  return `${name} — ORCID iD [${identity.id}](https://orcid.org/${identity.id})`;
}
