import { dump, load } from 'js-yaml';
import { AppError } from '../errors';
import { isLanguage, isResourceType, type Language, type ResourceType } from './topics';

/**
 * POST /v1/suggestions body (issue #7). Exactly these keys; anything else is a 400 that names the keys, so clients stay
 * honest and nobody can add fields to the library's data files.
 */
export interface Suggestion {
  lang: Language;
  topicPath: string;
  type: ResourceType;
  name: string;
  url: string;
  description: string;
  access?: Access;
  language?: string;
  organization?: string;
}

export const ACCESS = ['free', 'freemium', 'paid'] as const;
export type Access = (typeof ACCESS)[number];

const REQUIRED = ['lang', 'topicPath', 'type', 'name', 'url', 'description'] as const;
const OPTIONAL = ['access', 'language', 'organization'] as const;
const MAX_LENGTH: Record<string, number> = { topicPath: 300, name: 200, url: 2048, description: 1000, language: 35, organization: 200 };
/** Set by the service (credit goes in the commit trailer and PR body, spec 003 rule 4), never by the client. */
export const SERVER_FIELDS = ['author', 'contributor', 'submittedBy', 'date', 'added', 'id', '_id'];
const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** The entry written to `_data/<lang>/…/<type>.yaml`: the IPLibrary-website spec 002 schema, nothing more. */
export interface ResourceEntry {
  name: string;
  url: string;
  description: string;
  language?: string;
  access?: Access;
  organization?: string;
}

export function parseSuggestion(body: Record<string, unknown>): Suggestion {
  const keys = Object.keys(body);
  const server = keys.filter((key) => SERVER_FIELDS.includes(key));
  if (server.length) throw new AppError('UNKNOWN_FIELDS', 'These fields are set by the service.', { fields: server });
  const unknown = keys.filter((key) => !(REQUIRED as readonly string[]).includes(key) && !(OPTIONAL as readonly string[]).includes(key));
  if (unknown.length) throw new AppError('UNKNOWN_FIELDS', 'The suggestion contains unknown fields.', { fields: unknown });

  const notText = keys.filter((key) => typeof body[key] !== 'string');
  if (notText.length) throw new AppError('VALIDATION_FAILED', 'Every field must be text.', { fields: notText });

  const values = Object.fromEntries(keys.map((key) => [key, (body[key] as string).normalize('NFC').trim()])) as Record<string, string>;
  const missing = REQUIRED.filter((key) => !values[key]);
  if (missing.length) throw new AppError('VALIDATION_FAILED', 'Required fields are missing or empty.', { fields: missing });

  const tooLong = keys.filter((key) => (values[key]?.length ?? 0) > (MAX_LENGTH[key] ?? Infinity));
  if (tooLong.length) throw new AppError('VALIDATION_FAILED', 'Some fields are too long.', { fields: tooLong, limits: MAX_LENGTH });

  const invalid: string[] = [];
  if (!isLanguage(values.lang)) invalid.push('lang');
  if (!isResourceType(values.type)) invalid.push('type');
  if (values.access && !(ACCESS as readonly string[]).includes(values.access)) invalid.push('access');
  if (values.language && !BCP47.test(values.language)) invalid.push('language');
  if (invalid.length) throw new AppError('VALIDATION_FAILED', 'Some fields have invalid values.', { fields: invalid });

  const suggestion: Suggestion = {
    lang: values.lang as Language,
    topicPath: values.topicPath ?? '',
    type: values.type as ResourceType,
    name: values.name ?? '',
    url: values.url ?? '',
    description: values.description ?? '',
  };
  // Optional fields that are empty after trimming are omitted from the data file.
  if (values.access) suggestion.access = values.access as Access;
  if (values.language) suggestion.language = values.language;
  if (values.organization) suggestion.organization = values.organization;
  return suggestion;
}

export function toEntry(suggestion: Suggestion): ResourceEntry {
  const entry: ResourceEntry = { name: suggestion.name, url: suggestion.url, description: suggestion.description };
  if (suggestion.language) entry.language = suggestion.language;
  if (suggestion.access) entry.access = suggestion.access;
  if (suggestion.organization) entry.organization = suggestion.organization;
  return entry;
}

const isPlaceholder = (entry: unknown) =>
  !!entry && typeof entry === 'object' && typeof (entry as { url?: unknown }).url === 'string' && /example\.com/i.test((entry as { url: string }).url);

/** Compare URLs without scheme case, host case, default port, trailing slash or fragment. */
export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/+$/, '').toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

/**
 * Add one entry to a resource file. Existing text (comments, order, formatting) is kept and the entry is appended as
 * YAML produced by the serializer; files that only hold placeholders or `[]` are rewritten. A URL already listed is a
 * 409, so reviewers never see duplicates.
 */
export function appendEntry(existing: string | null, entry: ResourceEntry): string {
  const serialized = dump([entry], { lineWidth: -1, noRefs: true });
  if (existing === null || existing.trim() === '') return serialized;

  let entries: unknown;
  try {
    entries = load(existing);
  } catch {
    throw new AppError('CONFIG_INVALID', 'The resource file is not valid YAML; a maintainer must fix it first.');
  }
  if (entries === null || entries === undefined) entries = [];
  if (!Array.isArray(entries)) throw new AppError('CONFIG_INVALID', 'The resource file is not a list.');

  const wanted = canonicalUrl(entry.url);
  if (entries.some((item) => item && typeof item === 'object' && canonicalUrl(String((item as { url?: unknown }).url ?? '')) === wanted)) {
    throw new AppError('CONFLICT', 'This resource is already listed for the topic.', { url: entry.url });
  }

  const real = entries.filter((item) => !isPlaceholder(item));
  if (real.length === 0) return serialized;
  if (real.length !== entries.length || /^\s*\[\s*\]\s*$/m.test(existing)) {
    return dump([...real, entry], { lineWidth: -1, noRefs: true });
  }
  return `${existing.replace(/\s*$/, '')}\n${serialized}`;
}
