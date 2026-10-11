import { load } from 'js-yaml';
import { AppError } from '../errors';

/**
 * Per-form rules read from `contribute.yml` (or upstream's `staticman.yml`) in the target repository (spec 001).
 * Only what the Worker supports is kept; options of removed features are rejected instead of silently ignored.
 */
export type FileFormat = 'yaml' | 'json' | 'frontmatter';
export type TransformName = 'upcase' | 'downcase' | 'frontmatterContent';
export type DateFormat = 'iso8601' | 'timestamp' | 'timestamp-seconds';

export type GeneratedField =
  | { type: 'date'; format: DateFormat }
  | { type: 'slugify'; field: string }
  | { type: 'value'; value: string | number | boolean };

export interface PropertyConfig {
  allowedFields: string[];
  requiredFields: string[];
  format: FileFormat;
  path: string;
  filename: string;
  extension: string;
  commitMessage: string;
  pullRequestBody: string;
  generatedFields: Record<string, GeneratedField>;
  transforms: Record<string, TransformName[]>;
}

export const CONFIG_FILES = ['contribute.yml', 'staticman.yml'] as const;

const TRANSFORMS: readonly string[] = ['upcase', 'downcase', 'frontmatterContent'];
const DATE_FORMATS: readonly string[] = ['iso8601', 'timestamp', 'timestamp-seconds'];

/** Upstream options for features that do not exist here (spec 001 §4, issue #17). */
const REMOVED_OPTIONS = ['akismet', 'reCaptcha', 'notifications', 'githubAuth', 'gitlabAuth', 'auth'];

const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError('CONFIG_INVALID', message, details);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function stringList(block: Record<string, unknown>, key: string): string[] {
  const value = block[key] ?? [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw invalid(`\`${key}\` must be a list of field names.`, { option: key });
  }
  return value.map((item: string) => item.trim());
}

function optionalString(block: Record<string, unknown>, key: string, fallback: string): string {
  const value = block[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw invalid(`\`${key}\` must be a string.`, { option: key });
  return value;
}

function parseFormat(value: unknown): FileFormat {
  const format = typeof value === 'string' ? value.toLowerCase() : '';
  if (format === 'yml' || format === 'yaml') return 'yaml';
  if (format === 'json' || format === 'frontmatter') return format;
  throw invalid('`format` must be one of yaml, json or frontmatter.', { option: 'format', value });
}

function parseGeneratedFields(value: unknown): Record<string, GeneratedField> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalid('`generatedFields` must be a map.', { option: 'generatedFields' });

  const result: Record<string, GeneratedField> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string' || typeof spec === 'number' || typeof spec === 'boolean') {
      result[name] = { type: 'value', value: spec };
      continue;
    }
    if (!isRecord(spec)) throw invalid(`Generated field \`${name}\` is not supported.`, { option: 'generatedFields', field: name });
    const options = isRecord(spec.options) ? spec.options : {};
    if (spec.type === 'date') {
      const format = options.format ?? 'iso8601';
      if (typeof format !== 'string' || !DATE_FORMATS.includes(format)) {
        throw invalid(`Generated field \`${name}\` has an unknown date format.`, { option: 'generatedFields', field: name });
      }
      result[name] = { type: 'date', format: format as DateFormat };
    } else if (spec.type === 'slugify' && typeof options.field === 'string') {
      result[name] = { type: 'slugify', field: options.field };
    } else {
      // `user`/`github` generated fields came from upstream's per-entry OAuth, replaced by sessions (spec 002).
      throw invalid(`Generated field \`${name}\` has an unsupported type.`, { option: 'generatedFields', field: name, type: spec.type });
    }
  }
  return result;
}

function parseTransforms(value: unknown): Record<string, TransformName[]> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalid('`transforms` must be a map.', { option: 'transforms' });

  const result: Record<string, TransformName[]> = {};
  for (const [field, names] of Object.entries(value)) {
    const list = ([] as unknown[]).concat(names);
    const unknown = list.filter((name) => typeof name !== 'string' || !TRANSFORMS.includes(name));
    if (unknown.length) {
      // md5 and encrypt are rejected on purpose: no e-mail is collected (issue #17).
      throw invalid(`Unsupported transform for \`${field}\`.`, { option: 'transforms', field, transforms: unknown });
    }
    result[field] = list as TransformName[];
  }
  return result;
}

/** Parse the YAML text of a config file and return the block for one form (`property`). */
export function parsePropertyConfig(text: string, property: string): PropertyConfig {
  let document: unknown;
  try {
    document = load(text);
  } catch (error) {
    throw invalid('The configuration file is not valid YAML.', { reason: (error as Error).message.split('\n')[0] });
  }
  if (!isRecord(document)) throw invalid('The configuration file must be a YAML map.');

  const block = document[property];
  if (block === undefined) throw new AppError('CONFIG_MISSING', `The configuration has no \`${property}\` block.`, { property });
  if (!isRecord(block)) throw invalid(`The \`${property}\` block must be a map.`, { property });

  const missing = ['allowedFields', 'format', 'path'].filter((key) => block[key] === undefined);
  if (missing.length) throw invalid('The configuration is missing required options.', { property, missing });

  const removed = REMOVED_OPTIONS.filter((key) => isRecord(block[key]) && block[key].enabled !== false && block[key].required !== false);
  if (removed.length) throw invalid('The configuration enables features this service does not provide.', { property, removed });

  const config: PropertyConfig = {
    allowedFields: stringList(block, 'allowedFields'),
    requiredFields: stringList(block, 'requiredFields'),
    format: parseFormat(block.format),
    path: optionalString(block, 'path', ''),
    filename: optionalString(block, 'filename', ''),
    extension: optionalString(block, 'extension', ''),
    commitMessage: optionalString(block, 'commitMessage', 'Add contribution'),
    pullRequestBody: optionalString(block, 'pullRequestBody', ''),
    generatedFields: parseGeneratedFields(block.generatedFields),
    transforms: parseTransforms(block.transforms),
  };

  const notAllowed = config.requiredFields.filter((field) => !config.allowedFields.includes(field));
  if (notAllowed.length) throw invalid('Required fields must also be allowed fields.', { property, fields: notAllowed });
  if (config.format === 'frontmatter' && !Object.values(config.transforms).some((names) => names.includes('frontmatterContent'))) {
    throw invalid('The frontmatter format needs one field with the `frontmatterContent` transform.', { property });
  }
  return config;
}
