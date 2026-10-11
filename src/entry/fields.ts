import { dump } from 'js-yaml';
import type { PropertyConfig } from '../config/repository-config';
import { AppError } from '../errors';
import { formatDate, slugify } from '../text';

export type FieldValue = string | number | boolean;
export type Fields = Record<string, FieldValue>;

/**
 * Validate submitted form fields against the config (ported from upstream `_validateFields`, made strict):
 * unknown fields are rejected even when empty (upstream let empty ones through), values must be strings,
 * strings are trimmed, required fields must be non-empty and empty optional fields are dropped.
 */
export function validateFields(input: Record<string, unknown>, config: PropertyConfig): Record<string, string> {
  const unknown = Object.keys(input).filter((field) => !config.allowedFields.includes(field));
  if (unknown.length) {
    throw new AppError('UNKNOWN_FIELDS', 'The entry contains fields that are not allowed.', { fields: unknown });
  }

  const notText = Object.keys(input).filter((field) => typeof input[field] !== 'string');
  if (notText.length) {
    throw new AppError('VALIDATION_FAILED', 'Field values must be text.', { fields: notText });
  }

  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(input as Record<string, string>)) {
    const trimmed = value.trim();
    if (trimmed !== '') fields[field] = trimmed;
  }

  const missing = config.requiredFields.filter((field) => fields[field] === undefined);
  if (missing.length) {
    throw new AppError('VALIDATION_FAILED', 'Required fields are missing.', { fields: missing });
  }
  return fields;
}

function createDate(format: 'iso8601' | 'timestamp' | 'timestamp-seconds', now: Date): string | number {
  if (format === 'timestamp') return now.getTime();
  if (format === 'timestamp-seconds') return Math.floor(now.getTime() / 1000);
  return now.toISOString();
}

/** Add server-generated fields; they are applied last, so a submitted field can never override them. */
export function applyGeneratedFields(fields: Record<string, string>, config: PropertyConfig, now: Date): Fields {
  const generated = new Map<string, FieldValue | undefined>();
  for (const [name, spec] of Object.entries(config.generatedFields)) {
    if (spec.type === 'date') generated.set(name, createDate(spec.format, now));
    else if (spec.type === 'value') generated.set(name, spec.value);
    else generated.set(name, fields[spec.field] === undefined ? undefined : slugify(fields[spec.field] ?? ''));
  }
  const submitted = Object.entries(fields).filter(([name]) => !generated.has(name));
  const added = [...generated].filter((entry): entry is [string, FieldValue] => entry[1] !== undefined);
  return Object.fromEntries([...submitted, ...added]);
}

/** Apply the configured transforms in order (upcase, downcase; frontmatterContent only marks the body field). */
export function applyTransforms(fields: Fields, config: PropertyConfig): Fields {
  const result: Fields = { ...fields };
  for (const [field, names] of Object.entries(config.transforms)) {
    const value = result[field];
    if (value === undefined || value === '') continue;
    for (const name of names) {
      if (name === 'upcase') result[field] = String(result[field]).toUpperCase();
      if (name === 'downcase') result[field] = String(result[field]).toLowerCase();
    }
  }
  return result;
}

/** Serialise the entry with a serializer, never by string templating. */
export function createFile(fields: Fields, config: PropertyConfig): string {
  if (config.format === 'json') return `${JSON.stringify(fields, null, 2)}\n`;
  if (config.format === 'yaml') return dump(fields, { lineWidth: -1 });

  const contentField = Object.keys(config.transforms).find((field) => config.transforms[field]?.includes('frontmatterContent'));
  const attributes = Object.fromEntries(Object.entries(fields).filter(([name]) => name !== contentField));
  const content = contentField === undefined ? '' : String(fields[contentField] ?? '');
  return `---\n${dump(attributes, { lineWidth: -1 })}---\n${content}\n`;
}

export interface PlaceholderContext {
  fields: Fields;
  options: Record<string, string>;
  id: string;
  now: Date;
}

/**
 * Resolve `{fields.x}`, `{options.x}`, `{@id}`, `{@timestamp}` and `{@date:FORMAT}`.
 * `slugValues` slugifies values that come from the submission, so they can never add `/` or `..` to a path.
 */
export function resolvePlaceholders(template: string, context: PlaceholderContext, slugValues = false): string {
  return template.replace(/\{([^{}]*)\}/g, (_match, property: string) => {
    if (property === '@id') return context.id;
    if (property === '@timestamp') return String(context.now.getTime());
    if (property.startsWith('@date:')) return formatDate(context.now, property.slice('@date:'.length));

    const [scope, key] = property.split(/\.(.*)/s, 2) as [string, string | undefined];
    const source = scope === 'fields' ? context.fields : scope === 'options' ? context.options : undefined;
    const value = source && key !== undefined && Object.hasOwn(source, key) ? String(source[key]) : '';
    return slugValues ? slugify(value) : value;
  });
}

const EXTENSIONS = { yaml: 'yml', json: 'json', frontmatter: 'md' } as const;

/** Path of the new entry file: `<path>/<filename>.<extension>`, with the entry id as default file name. */
export function newFilePath(config: PropertyConfig, context: PlaceholderContext): string {
  const filename = config.filename ? resolvePlaceholders(config.filename, context, true) : context.id;
  const directory = resolvePlaceholders(config.path, context, true).replace(/^\/+|\/+$/g, '');
  const extension = config.extension || EXTENSIONS[config.format];
  const path = `${directory ? `${directory}/` : ''}${filename || context.id}.${extension}`;

  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..') || segments[0] === '.github') {
    throw new AppError('CONFIG_INVALID', 'The configured path does not resolve to a safe file path.', { path });
  }
  return path;
}
