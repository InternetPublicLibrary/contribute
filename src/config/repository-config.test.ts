import { describe, expect, it } from 'vitest';
import { parsePropertyConfig } from './repository-config';

const yaml = (block: string) => `comments:\n${block.replace(/^/gm, '  ')}\n`;
const minimal = 'allowedFields: [name, message]\nformat: yaml\npath: _data/comments';

describe('parsePropertyConfig', () => {
  it('reads a minimal block with defaults', () => {
    expect(parsePropertyConfig(yaml(minimal), 'comments')).toEqual({
      allowedFields: ['name', 'message'],
      requiredFields: [],
      format: 'yaml',
      path: '_data/comments',
      filename: '',
      extension: '',
      commitMessage: 'Add contribution',
      pullRequestBody: '',
      generatedFields: {},
      transforms: {},
    });
  });

  it('accepts yml as an alias of yaml', () => {
    expect(parsePropertyConfig(yaml(minimal.replace('yaml', 'yml')), 'comments').format).toBe('yaml');
  });

  it('reports a missing block as CONFIG_MISSING', () => {
    expect(() => parsePropertyConfig(yaml(minimal), 'reviews')).toThrow(
      expect.objectContaining({ code: 'CONFIG_MISSING', details: { property: 'reviews' } }),
    );
  });

  it('lists every missing required option', () => {
    expect(() => parsePropertyConfig(yaml('requiredFields: []'), 'comments')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID', details: { property: 'comments', missing: ['allowedFields', 'format', 'path'] } }),
    );
  });

  it('rejects invalid YAML with CONFIG_INVALID instead of crashing', () => {
    expect(() => parsePropertyConfig('comments: [unclosed', 'comments')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('rejects an unknown format', () => {
    expect(() => parsePropertyConfig(yaml(minimal.replace('yaml', 'xml')), 'comments')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID', details: { option: 'format', value: 'xml' } }),
    );
  });

  it('rejects the md5 transform: no e-mail is collected', () => {
    expect(() => parsePropertyConfig(yaml(`${minimal}\ntransforms:\n  email: md5`), 'comments')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID', details: { option: 'transforms', field: 'email', transforms: ['md5'] } }),
    );
  });

  it.each(['akismet:\n  enabled: true', 'reCaptcha:\n  enabled: true', 'notifications:\n  enabled: true', 'auth:\n  required: true'])(
    'rejects removed features when enabled (%s)',
    (option) => {
      expect(() => parsePropertyConfig(yaml(`${minimal}\n${option}`), 'comments')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    },
  );

  it('accepts removed features when they are explicitly disabled', () => {
    expect(() => parsePropertyConfig(yaml(`${minimal}\nakismet:\n  enabled: false\nauth:\n  required: false`), 'comments')).not.toThrow();
  });

  it('parses generated fields and multiple transforms per field', () => {
    const config = parsePropertyConfig(
      yaml(`${minimal}
generatedFields:
  date:
    type: date
    options:
      format: timestamp-seconds
  slug:
    type: slugify
    options:
      field: name
  layout: comment
transforms:
  name: [upcase, downcase]`),
      'comments',
    );

    expect(config.generatedFields).toEqual({
      date: { type: 'date', format: 'timestamp-seconds' },
      slug: { type: 'slugify', field: 'name' },
      layout: { type: 'value', value: 'comment' },
    });
    expect(config.transforms).toEqual({ name: ['upcase', 'downcase'] });
  });

  it('rejects user generated fields, which came from per-entry OAuth', () => {
    expect(() =>
      parsePropertyConfig(yaml(`${minimal}\ngeneratedFields:\n  author:\n    type: user\n    options:\n      property: login`), 'comments'),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', details: expect.objectContaining({ field: 'author' }) }));
  });

  it('requires required fields to be allowed', () => {
    expect(() => parsePropertyConfig(yaml(`${minimal}\nrequiredFields: [email]`), 'comments')).toThrow(
      expect.objectContaining({ details: { property: 'comments', fields: ['email'] } }),
    );
  });

  it('requires a frontmatterContent field for the frontmatter format', () => {
    expect(() => parsePropertyConfig(yaml(minimal.replace('yaml', 'frontmatter')), 'comments')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });
});
