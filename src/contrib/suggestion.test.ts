import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { appendEntry, parseSuggestion, type ResourceEntry, toEntry } from './suggestion';

const valid = {
  lang: 'pt-BR',
  topicPath: '/pt-BR/computacao/ciencia-de-dados/',
  type: 'learn',
  name: 'Curso de Ciência de Dados',
  url: 'https://www.example.org/curso',
  description: 'Curso gratuito em português.',
};

/** The checks of IPLibrary-website test/resources_data_test.rb (spec 002), applied to a generated file. */
function websiteValidator(text: string): string[] {
  const problems: string[] = [];
  const entries = load(text);
  if (!Array.isArray(entries)) return ['not a list'];
  if (text.includes('example.com')) problems.push('placeholder');
  entries.forEach((entry: Record<string, unknown>, index) => {
    for (const key of ['name', 'url', 'description']) if (!String(entry[key] ?? '').trim()) problems.push(`[${index}] missing ${key}`);
    if (!String(entry.url ?? '').startsWith('https://')) problems.push(`[${index}] not https`);
  });
  const urls = entries.map((entry: Record<string, unknown>) => entry.url);
  if (new Set(urls).size !== urls.length) problems.push('duplicate url');
  return problems;
}

describe('parseSuggestion', () => {
  it('accepts the documented fields and trims them', () => {
    expect(parseSuggestion({ ...valid, name: '  Curso  ', access: 'free', language: 'pt-BR', organization: ' USP ' })).toEqual({
      ...valid,
      name: 'Curso',
      access: 'free',
      language: 'pt-BR',
      organization: 'USP',
    });
  });

  it('rejects an extra key and names it', () => {
    expect(() => parseSuggestion({ ...valid, layout: 'x' })).toThrow(expect.objectContaining({ code: 'UNKNOWN_FIELDS', status: 400, details: { fields: ['layout'] } }));
  });

  it.each(['author', 'date', 'contributor', 'id'])('rejects the server field %s supplied by the client', (field) => {
    expect(() => parseSuggestion({ ...valid, [field]: 'Mallory' })).toThrow(expect.objectContaining({ code: 'UNKNOWN_FIELDS', details: { fields: [field] } }));
  });

  it('rejects a name made of whitespace with 422', () => {
    expect(() => parseSuggestion({ ...valid, name: '   ' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, details: { fields: ['name'] } }));
  });

  it('lists every missing required field', () => {
    expect(() => parseSuggestion({ lang: 'pt-BR' })).toThrow(
      expect.objectContaining({ details: { fields: ['topicPath', 'type', 'name', 'url', 'description'] } }),
    );
  });

  it('rejects values that are not text', () => {
    expect(() => parseSuggestion({ ...valid, name: ['a'] })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', details: { fields: ['name'] } }));
  });

  it.each([
    [{ lang: 'fr-FR' }, ['lang']],
    [{ type: 'videos' }, ['type']],
    [{ access: 'cheap' }, ['access']],
    [{ language: 'Portuguese!' }, ['language']],
  ])('rejects invalid enum values %j', (override, fields) => {
    expect(() => parseSuggestion({ ...valid, ...override })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', details: { fields } }));
  });

  it('rejects overlong fields', () => {
    expect(() => parseSuggestion({ ...valid, description: 'x'.repeat(1001) })).toThrow(expect.objectContaining({ details: expect.objectContaining({ fields: ['description'] }) }));
  });

  it('omits empty optional fields from the entry', () => {
    expect(toEntry(parseSuggestion({ ...valid, access: '', organization: '  ' }))).toEqual({ name: valid.name, url: valid.url, description: valid.description });
  });
});

describe('appendEntry', () => {
  const entry: ResourceEntry = { name: 'Curso: "Dados" #1', url: 'https://www.example.org/curso', description: 'Linha com: dois pontos\ne quebra.', access: 'free' };

  it('creates a new file that the website validator accepts', () => {
    const text = appendEntry(null, entry);

    expect(load(text)).toEqual([entry]);
    expect(websiteValidator(text)).toEqual([]);
  });

  it('keeps existing text and comments and appends the entry', () => {
    const existing = '# Curadoria revisada\n- name: Kaggle\n  url: https://www.kaggle.com/\n  description: Competições.\n';
    const text = appendEntry(existing, entry);

    expect(text.startsWith(existing.trimEnd())).toBe(true);
    expect(load(text)).toEqual([{ name: 'Kaggle', url: 'https://www.kaggle.com/', description: 'Competições.' }, entry]);
    expect(websiteValidator(text)).toEqual([]);
  });

  it('replaces generated placeholders', () => {
    const placeholder = '# Placeholder - Add resources here\n- name: "Example Resource"\n  url: "https://example.com"\n  description: "Add a description here."\n';
    const text = appendEntry(placeholder, entry);

    expect(load(text)).toEqual([entry]);
    expect(websiteValidator(text)).toEqual([]);
  });

  it('rewrites an empty list', () => {
    expect(load(appendEntry('# Not applicable yet\n[]\n', entry))).toEqual([entry]);
  });

  it('rejects a URL already listed (ignoring case, trailing slash and fragment) with 409', () => {
    const existing = '- name: Curso\n  url: https://WWW.example.org/curso/#top\n  description: x\n';

    expect(() => appendEntry(existing, entry)).toThrow(expect.objectContaining({ code: 'CONFLICT', status: 409 }));
  });

  it('refuses to touch a file that is not a YAML list', () => {
    expect(() => appendEntry('name: x\n', entry)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => appendEntry('- [unclosed', entry)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('writes YAML-significant text as data, never as structure', () => {
    const tricky: ResourceEntry = { name: '- injected: true', url: 'https://a.example/', description: "x\n- name: evil\n  url: https://evil.example\n" };

    expect(load(appendEntry(null, tricky))).toEqual([tricky]);
  });
});
