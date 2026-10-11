import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { assertWriteAllowed, requireSession, type Session } from '../auth/session';
import { loadSettings, type Settings } from '../config/environment';
import type { Env } from '../env';
import { AppError, readJsonObject } from '../errors';
import { assertContributionAllowed, assertIpAllowed, recordContribution } from './limits';
import { type GitHubApp, gitHubAppFromEnv, type RepositoryRef } from '../github/client';
import { proposeChange } from '../github/pull-requests';
import { defaultBranch, readFile, type RepositoryFile } from '../github/repository';
import { commitMessage } from './attribution';
import { contributionBranch, newContributionId } from './branches';
import { contributionLabels, pageTitle, pullRequestTitle } from './labels';
import { type PageSource, pageSource } from './pages';
import { identityMarker, renderPullRequestBody } from './pr-body';
import { assertReachable } from './reachability';
import { scanPageEdit } from './safety';
import { appendEntry, parseSuggestion, toEntry } from './suggestion';
import { loadMenu, type MenuNode, resolveTopic, resourceFilePath } from './topics';

export interface ContributionDeps {
  /** GitHub API transport (tests inject a fake). */
  fetch?: typeof fetch;
  /** Transport for checking that suggested links answer (tests inject a fake). */
  probe?: typeof fetch;
}

type AppContext = Context<{ Bindings: Env }>;
export const MAX_EDIT_BYTES = 256 * 1024;
/** Edit bodies carry the whole page; suggestions are small. */
const MAX_EDIT_BODY = MAX_EDIT_BYTES + 16 * 1024;
const MAX_SUGGESTION_BODY = 16 * 1024;
const SHA = /^[0-9a-f]{40}$/;

const repoName = ({ owner, repo }: RepositoryRef) => `${owner}/${repo}`;

function strictKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AppError('UNKNOWN_FIELDS', 'The request contains unknown fields.', { fields: unknown });
}

async function findSource(github: GitHubApp, kv: KVNamespace, page: PageSource): Promise<{ file: RepositoryFile | null; branch: string }> {
  const branch = await defaultBranch(github, kv, page.repository);
  for (const candidate of page.candidates) {
    const file = await readFile(github, page.repository, candidate, branch);
    if (file) return { file, branch };
  }
  return { file: null, branch };
}

function menuHasPath(nodes: MenuNode[], path: string): boolean {
  return nodes.some((node) => node.path === path || menuHasPath(node.children ?? [], path));
}

/** A page with no source file: generated from the menu (409, edit the data instead) or unknown (404). */
async function missingSource(github: GitHubApp, kv: KVNamespace, settings: Settings, page: PageSource): Promise<AppError> {
  const website = settings.repositories.website;
  if (website && menuHasPath(await loadMenu(github, kv, website, page.lang), page.pagePath)) {
    return new AppError('CONFLICT', 'This page is generated from the library menu and cannot be edited here.', { reason: 'GENERATED_PAGE' });
  }
  return new AppError('NOT_FOUND', 'No source file was found for this page.');
}

/** Keep the file's line endings and final-newline convention, so the diff shows only the reader's change. */
export function matchLineEndings(original: string, proposed: string): string {
  let text = proposed.replace(/\r\n?/g, '\n');
  const endsWithNewline = /\n$/.test(original);
  text = endsWithNewline ? text.replace(/\n*$/, '\n') : text.replace(/\n+$/, '');
  return original.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

/** Writes: a session, an IPL origin with the CSRF token, the per-IP limit, then the identity's deny-list and caps. */
async function writeSession(c: AppContext, settings: Settings): Promise<Session> {
  const session = await requireSession(c);
  assertWriteAllowed(c, session, settings.allowedOrigins);
  await assertIpAllowed(c);
  await assertContributionAllowed(c, session.identity);
  return session;
}

export function contributionRoutes(deps: ContributionDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const github = (c: AppContext) => gitHubAppFromEnv(c.env, deps.fetch);
  const probe = deps.probe ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  for (const path of ['/source', '/edits', '/suggestions', '/contributions']) {
    routes.use(path, async (c, next) =>
      cors({
        origin: (origin) => (loadSettings(c.env).allowedOrigins.includes(origin) ? origin : null),
        credentials: true,
        allowHeaders: ['content-type', 'x-csrf-token'],
        allowMethods: ['GET', 'POST'],
      })(c, next),
    );
  }

  routes.get('/source', async (c) => {
    await requireSession(c);
    const settings = loadSettings(c.env);
    const page = pageSource(c.req.query('url'), settings);
    const app = github(c);
    const { file, branch } = await findSource(app, c.env.CONTRIBUTE_KV, page);
    if (!file) throw await missingSource(app, c.env.CONTRIBUTE_KV, settings, page);
    return c.json({ repository: repoName(page.repository), path: file.path, branch, content: file.content, sha: file.sha });
  });

  routes.post('/edits', async (c) => {
    const settings = loadSettings(c.env);
    const session = await writeSession(c, settings);
    const body = await readJsonObject(c.req.raw, MAX_EDIT_BODY);
    strictKeys(body, ['url', 'content', 'sha', 'summary']);
    const { url, content, sha, summary } = body;
    const invalid = [
      typeof url !== 'string' && 'url',
      (typeof content !== 'string' || content === '') && 'content',
      (typeof sha !== 'string' || !SHA.test(sha)) && 'sha',
      (typeof summary !== 'string' || summary.trim() === '') && 'summary',
    ].filter((field): field is string => Boolean(field));
    if (invalid.length) throw new AppError('VALIDATION_FAILED', 'Some fields are missing or invalid.', { fields: invalid });
    if (new TextEncoder().encode(content as string).length > MAX_EDIT_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'The page is too large to edit here.');

    const page = pageSource(url, settings);
    const app = github(c);
    const { file: current, branch } = await findSource(app, c.env.CONTRIBUTE_KV, page);
    if (!current) throw await missingSource(app, c.env.CONTRIBUTE_KV, settings, page);
    // Optimistic concurrency: the reader edited the version with this sha; anything newer wins and is returned.
    if (current.sha !== sha) {
      throw new AppError('STALE_SHA', 'The page changed while you were editing it.', { content: current.content, sha: current.sha });
    }

    const proposed = matchLineEndings(current.content, content as string);
    if (proposed === current.content) throw new AppError('VALIDATION_FAILED', 'The edit does not change the page.', { fields: ['content'] });
    const scan = scanPageEdit(current.content, proposed, current.path.endsWith('.md') ? 'markdown' : 'html');

    const identity = session.identity;
    const pageUrl = `${new URL(url as string).origin}${page.pagePath}`;
    try {
      const pullRequest = await proposeChange(app, {
        repository: page.repository,
        base: branch,
        branch: contributionBranch(newContributionId()),
        path: current.path,
        content: proposed,
        sha: current.sha,
        message: commitMessage(`Edit ${current.path}`, identity),
        title: pullRequestTitle('edit', pageTitle(current.content, current.path)),
        body: renderPullRequestBody({ kind: 'edit', identity, pageUrl, path: current.path, summary: summary as string, containsHtml: scan.containsHtml }),
        labels: contributionLabels({ kind: 'edit', lang: page.lang, containsHtml: scan.containsHtml }),
      });
      await recordContribution(c.env.CONTRIBUTE_KV, identity, `${repoName(page.repository)}#${pullRequest.number}`);
      return c.json({ pullRequest }, 201);
    } catch (error) {
      // The default branch moved between our read and the commit.
      if (error instanceof AppError && error.details?.githubStatus === 409) {
        throw new AppError('STALE_SHA', 'The page changed while you were editing it. Reload and try again.');
      }
      throw error;
    }
  });

  routes.post('/suggestions', async (c) => {
    const settings = loadSettings(c.env);
    const session = await writeSession(c, settings);
    const suggestion = parseSuggestion(await readJsonObject(c.req.raw, MAX_SUGGESTION_BODY));
    const website = settings.repositories.website;
    if (!website) throw new AppError('NOT_CONFIGURED', 'No website repository is configured.');

    const app = github(c);
    const topic = resolveTopic(await loadMenu(app, c.env.CONTRIBUTE_KV, website, suggestion.lang), suggestion.lang, suggestion.topicPath);
    const path = resourceFilePath(topic, suggestion.type);
    await assertReachable(suggestion.url, probe);

    const branch = await defaultBranch(app, c.env.CONTRIBUTE_KV, website);
    const existing = await readFile(app, website, path, branch);
    const content = appendEntry(existing?.content ?? null, toEntry(suggestion));
    const identity = session.identity;
    const pullRequest = await proposeChange(app, {
      repository: website,
      base: branch,
      branch: contributionBranch(newContributionId()),
      path,
      content,
      ...(existing ? { sha: existing.sha } : {}),
      message: commitMessage(`Suggest ${suggestion.name} for ${topic.title}`, identity),
      title: pullRequestTitle('suggestion', suggestion.name),
      body: renderPullRequestBody({
        kind: 'suggestion',
        identity,
        pageUrl: `${c.req.header('origin') ?? ''}${topic.path}`,
        path,
        fields: { Name: suggestion.name, Link: suggestion.url, Description: suggestion.description, Access: suggestion.access, Organization: suggestion.organization },
      }),
      labels: contributionLabels({ kind: 'suggestion', lang: suggestion.lang, topic: topic.categorySegment }),
    });
    await recordContribution(c.env.CONTRIBUTE_KV, identity, `${repoName(website)}#${pullRequest.number}`);
    return c.json({ pullRequest }, 201);
  });

  routes.get('/contributions', async (c) => {
    const session = await requireSession(c);
    const settings = loadSettings(c.env);
    const repositories = Object.values(settings.repositories);
    const first = repositories[0];
    if (!first) return c.json({ contributions: [] });
    const marker = identityMarker(session.identity).replace(/^<!-- | -->$/g, '');
    const query = [`"${marker}"`, 'in:body', 'is:pr', ...new Set(repositories.map((r) => `repo:${repoName(r)}`))].join(' ');
    const result = await github(c).request<{ items: { number: number; title: string; html_url: string; state: string; repository_url: string; pull_request?: { merged_at: string | null } }[] }>(
      first,
      'GET',
      `/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=50`,
      'search contributions',
    );
    return c.json({
      contributions: result.items.map((item) => ({
        repository: item.repository_url.split('/repos/')[1] ?? '',
        number: item.number,
        title: item.title,
        url: item.html_url,
        state: item.pull_request?.merged_at ? 'merged' : item.state,
      })),
    });
  });

  return routes;
}
