import type { Context } from 'hono';
import { loadSettings } from './config/environment';
import { parsePropertyConfig } from './config/repository-config';
import { applyGeneratedFields, applyTransforms, createFile, newFilePath, type PlaceholderContext, resolvePlaceholders, validateFields } from './entry/fields';
import type { Env } from './env';
import { AppError } from './errors';
import { gitHubAppFromEnv } from './github/client';
import { proposeChange } from './github/pull-requests';
import { defaultBranch, readRepositoryConfig } from './github/repository';

/**
 * POST /v3/entry/github/:owner/:repo/:branch/:property — upstream Staticman's entry flow, kept for parity (spec 001).
 * Differences from upstream: off unless LEGACY_ENTRY_ROUTE=on and never in production (it is anonymous, issue #6);
 * `:branch` is ignored (the default branch is used, #19); always a pull request (ADR 0003); no md5, no encrypted
 * fields and no e-mail (#17); only configured content repositories.
 */
export const LEGACY_OPTIONS = ['slug', 'parent'];
const EMAIL_FIELD = /^e-?mail(address)?$|email/i;

type Bracketed = { fields: Record<string, unknown>; options: Record<string, unknown> };

/** Read `fields[x]` / `options[y]` from a form, or `{ fields, options }` from JSON. */
async function readEntry(request: Request): Promise<Bracketed> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('application/json')) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError('INVALID_JSON', 'The request body is not valid JSON.');
    }
    const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
    const parsed = record(body);
    return { fields: record(parsed.fields), options: record(parsed.options) };
  }
  if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const entry: Bracketed = { fields: {}, options: {} };
    for (const [key, value] of form) {
      const match = /^(fields|options)\[([^\]]+)\]$/.exec(key);
      if (!match?.[1] || !match[2]) throw new AppError('UNKNOWN_FIELDS', 'Use fields[name] and options[name] keys.', { fields: [key] });
      entry[match[1] as keyof Bracketed][match[2]] = typeof value === 'string' ? value : '';
    }
    return entry;
  }
  throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the entry as a form or as application/json.');
}

function entryId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function legacyEntryRoute(fetcher?: typeof fetch) {
  return async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    if (c.env.ENVIRONMENT === 'production' || c.env.LEGACY_ENTRY_ROUTE !== 'on') {
      throw new AppError('GONE', 'The anonymous entry API is retired; use the signed-in /v1 API.');
    }
    const { owner = '', repo = '', property = '' } = c.req.param();
    const settings = loadSettings(c.env);
    const repository = Object.values(settings.repositories).find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase());
    if (!repository) throw new AppError('FORBIDDEN', `${owner}/${repo} is not a content repository of this service.`);

    const { fields: rawFields, options: rawOptions } = await readEntry(c.req.raw);
    const unknownOptions = Object.keys(rawOptions).filter((option) => !LEGACY_OPTIONS.includes(option));
    if (unknownOptions.length) throw new AppError('UNKNOWN_FIELDS', 'The entry contains options that are not supported.', { options: unknownOptions });
    const emailFields = Object.keys(rawFields).filter((field) => EMAIL_FIELD.test(field));
    if (emailFields.length) {
      throw new AppError('VALIDATION_FAILED', 'E-mail addresses are not collected by this service.', { fields: emailFields });
    }
    const options = Object.fromEntries(Object.entries(rawOptions).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : '']));

    const github = gitHubAppFromEnv(c.env, fetcher);
    const base = await defaultBranch(github, c.env.CONTRIBUTE_KV, repository);
    const configFile = await readRepositoryConfig(github, repository, base);
    const config = parsePropertyConfig(configFile.content, property);

    const now = new Date();
    const id = entryId();
    const validated = validateFields(rawFields, config);
    const fields = applyTransforms(applyGeneratedFields(validated, config, now), config);
    const context: PlaceholderContext = { fields: validated, options, id, now };
    const path = newFilePath(config, context);

    const pullRequest = await proposeChange(github, {
      repository,
      base,
      branch: `contribute/${id}`,
      path,
      content: createFile({ _id: id, ...(options.parent ? { _parent: options.parent } : {}), ...fields }, config),
      message: resolvePlaceholders(config.commitMessage, context),
      title: `Contribution: ${property}`.slice(0, 120),
      body: [config.pullRequestBody.trim(), `New \`${property}\` entry: \`${path}\`.`].filter(Boolean).join('\n\n'),
    });
    return c.json({ success: true, fields, pullRequest });
  };
}
