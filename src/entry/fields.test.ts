import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { PropertyConfig } from '../config/repository-config';
import { applyGeneratedFields, applyTransforms, createFile, newFilePath, type PlaceholderContext, resolvePlaceholders, validateFields } from './fields';

const config = (overrides: Partial<PropertyConfig> = {}): PropertyConfig => ({
  allowedFields: ['name', 'message', 'url'],
  requiredFields: ['name', 'message'],
  format: 'yaml',
  path: '_data/comments',
  filename: '',
  extension: '',
  commitMessage: 'Add contribution',
  pullRequestBody: '',
  generatedFields: {},
  transforms: {},
  ...overrides,
});

const now = new Date(Date.UTC(2026, 9, 11, 8, 5, 9, 123));
const context = (overrides: Partial<PlaceholderContext> = {}): PlaceholderContext => ({
  fields: { name: 'Ana Souza', message: 'Olá' },
  options: { slug: 'my-page' },
  id: '01J9ZK3Y',
  now,
  ...overrides,
});

describe('validateFields', () => {
  it('returns trimmed fields and drops empty optional ones', () => {
    expect(validateFields({ name: '  Ana ', message: 'Hi\n', url: '   ' }, config())).toEqual({ name: 'Ana', message: 'Hi' });
  });

  it('rejects a field that is not allowed', () => {
    expect(() => validateFields({ name: 'Ana', message: 'Hi', layout: 'x' }, config())).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_FIELDS', status: 400, details: { fields: ['layout'] } }),
    );
  });

  it('rejects a field that is not allowed even when it is empty (upstream let it through)', () => {
    expect(() => validateFields({ name: 'Ana', message: 'Hi', honeypot: '' }, config())).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_FIELDS', details: { fields: ['honeypot'] } }),
    );
  });

  it('rejects a required field that is missing or only whitespace', () => {
    expect(() => validateFields({ name: '   ' }, config())).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, details: { fields: ['name', 'message'] } }),
    );
  });

  it('rejects non-text values', () => {
    expect(() => validateFields({ name: 'Ana', message: { nested: true } }, config())).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', details: { fields: ['message'] } }),
    );
  });
});

describe('applyGeneratedFields', () => {
  it('returns the fields unchanged without generated fields', () => {
    expect(applyGeneratedFields({ name: 'Ana' }, config(), now)).toEqual({ name: 'Ana' });
  });

  it.each([
    ['iso8601', '2026-10-11T08:05:09.123Z'],
    ['timestamp', now.getTime()],
    ['timestamp-seconds', Math.floor(now.getTime() / 1000)],
  ] as const)('creates a %s date', (format, expected) => {
    expect(applyGeneratedFields({}, config({ generatedFields: { date: { type: 'date', format } } }), now)).toEqual({ date: expected });
  });

  it('slugifies another field and adds static values', () => {
    const generated = config({ generatedFields: { slug: { type: 'slugify', field: 'name' }, layout: { type: 'value', value: 'comment' } } });

    expect(applyGeneratedFields({ name: 'Ação Ótima' }, generated, now)).toEqual({ name: 'Ação Ótima', slug: 'acao-otima', layout: 'comment' });
  });

  it('never lets a submitted field override a generated one', () => {
    const generated = config({ allowedFields: ['date'], generatedFields: { date: { type: 'date', format: 'iso8601' } } });

    expect(applyGeneratedFields({ date: '1999-01-01' }, generated, now)).toEqual({ date: '2026-10-11T08:05:09.123Z' });
  });
});

describe('applyTransforms', () => {
  it('returns the fields unchanged without transforms', () => {
    expect(applyTransforms({ name: 'Ana' }, config())).toEqual({ name: 'Ana' });
  });

  it('applies the transforms of each field in order', () => {
    const transforms = config({ transforms: { name: ['upcase'], message: ['upcase', 'downcase'] } });

    expect(applyTransforms({ name: 'Ana', message: 'Olá' }, transforms)).toEqual({ name: 'ANA', message: 'olá' });
  });
});

describe('createFile', () => {
  const fields = { name: 'Ana', message: 'Linha 1\nLinha 2' };

  it('writes JSON', () => {
    expect(JSON.parse(createFile(fields, config({ format: 'json' })))).toEqual(fields);
  });

  it('writes YAML that round-trips', () => {
    expect(load(createFile(fields, config()))).toEqual(fields);
  });

  it('writes front matter with the content field as the body', () => {
    const output = createFile(fields, config({ format: 'frontmatter', transforms: { message: ['frontmatterContent'] } }));

    expect(output).toBe('---\nname: Ana\n---\nLinha 1\nLinha 2\n');
  });

  it('keeps YAML-significant text as data', () => {
    const tricky = { name: 'x: y\n- z', message: '---' };

    expect(load(createFile(tricky, config()))).toEqual(tricky);
  });
});

describe('resolvePlaceholders', () => {
  it('returns a string without placeholders unchanged', () => {
    expect(resolvePlaceholders('comments', context())).toBe('comments');
  });

  it('replaces fields, options and special placeholders', () => {
    expect(resolvePlaceholders('{options.slug}/{fields.name}/{@id}/{@timestamp}', context())).toBe(
      `my-page/Ana Souza/01J9ZK3Y/${now.getTime()}`,
    );
  });

  it('replaces date placeholders in UTC', () => {
    expect(resolvePlaceholders('{@date:YYYY-MM-DD}T{@date:HH:mm:ss}', context())).toBe('2026-10-11T08:05:09');
  });

  it('resolves unknown values to an empty string', () => {
    expect(resolvePlaceholders('[{fields.missing}][{other.x}]', context())).toBe('[][]');
  });

  it('flattens submitted values so they cannot inject commit trailers or lines', () => {
    const fields = { name: 'Ana\nCo-authored-by: Mallory <m@example.com>\r\n\u202Eevil' };

    expect(resolvePlaceholders('Add comment by {fields.name}', context({ fields }))).toBe(
      'Add comment by Ana Co-authored-by: Mallory <m@example.com> evil',
    );
  });

  it('never expands placeholders that appear inside submitted values', () => {
    expect(resolvePlaceholders('{fields.name}', context({ fields: { name: '{@id} {options.slug}' } }))).toBe('{@id} {options.slug}');
  });

  it('slugifies submitted values when asked, so they cannot add path segments', () => {
    expect(resolvePlaceholders('{fields.name}', context({ fields: { name: '../../.github/x' } }), true)).toBe('github-x');
  });
});

describe('newFilePath', () => {
  it('uses the entry id and the format extension by default', () => {
    expect(newFilePath(config(), context())).toBe('_data/comments/01J9ZK3Y.yml');
  });

  it('uses the configured filename and extension', () => {
    expect(newFilePath(config({ filename: 'entry-{@timestamp}', extension: 'yaml' }), context())).toBe(`_data/comments/entry-${now.getTime()}.yaml`);
  });

  it('removes leading and trailing slashes from the path', () => {
    expect(newFilePath(config({ path: '/_data/comments/' }), context())).toBe('_data/comments/01J9ZK3Y.yml');
  });

  it('resolves placeholders in path and filename', () => {
    expect(newFilePath(config({ path: '_data/{options.slug}', filename: '{fields.name}' }), context())).toBe('_data/my-page/ana-souza.yml');
  });

  it.each([['frontmatter', 'md'], ['json', 'json'], ['yaml', 'yml']] as const)('uses .%s → .%s', (format, extension) => {
    expect(newFilePath(config({ format }), context())).toBe(`_data/comments/01J9ZK3Y.${extension}`);
  });

  it('refuses configured paths that escape the repository or touch .github', () => {
    expect(() => newFilePath(config({ path: '../outside' }), context())).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => newFilePath(config({ path: '.github/workflows' }), context())).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('keeps non-Latin text in file names', () => {
    expect(newFilePath(config({ filename: '{fields.name}' }), context({ fields: { name: '评论 测试' } }))).toBe('_data/comments/评论-测试.yml');
  });
});
