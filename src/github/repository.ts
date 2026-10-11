import { CONFIG_FILES } from '../config/repository-config';
import { AppError } from '../errors';
import { contentsPath, type GitHubApp, type RepositoryRef, repoPath } from './client';
import { base64ToUtf8 } from './encoding';

const DEFAULT_BRANCH_TTL_S = 60 * 60;

/** The repository's default branch from the API, cached for an hour; requests never choose the branch (issue #19). */
export async function defaultBranch(github: GitHubApp, kv: KVNamespace, repository: RepositoryRef): Promise<string> {
  const cacheKey = `gh:default-branch:${repository.owner}/${repository.repo}`.toLowerCase();
  const cached = await kv.get(cacheKey);
  if (cached) return cached;
  const { default_branch: branch } = await github.request<{ default_branch: string }>(repository, 'GET', repoPath(repository), 'get repository');
  await kv.put(cacheKey, branch, { expirationTtl: DEFAULT_BRANCH_TTL_S });
  return branch;
}

export interface RepositoryFile {
  path: string;
  sha: string;
  content: string;
}

/** Read a UTF-8 file at a ref; null when it does not exist. */
export async function readFile(github: GitHubApp, repository: RepositoryRef, path: string, ref: string): Promise<RepositoryFile | null> {
  const file = await github.requestOrNull<{ type: string; sha: string; content?: string; encoding?: string }>(
    repository,
    'GET',
    `${repoPath(repository)}/contents/${contentsPath(path)}?ref=${encodeURIComponent(ref)}`,
    'read file',
  );
  if (!file) return null;
  if (file.type !== 'file' || file.encoding !== 'base64' || file.content === undefined) {
    throw new AppError('CONFIG_INVALID', `${path} is not a regular file.`, { path });
  }
  return { path, sha: file.sha, content: base64ToUtf8(file.content) };
}

/** `contribute.yml` from the default branch, falling back to upstream's `staticman.yml`. */
export async function readRepositoryConfig(github: GitHubApp, repository: RepositoryRef, branch: string): Promise<RepositoryFile> {
  for (const name of CONFIG_FILES) {
    const file = await readFile(github, repository, name, branch);
    if (file) return file;
  }
  throw new AppError('CONFIG_MISSING', `${repository.owner}/${repository.repo} has no contribute.yml.`, {
    repository: `${repository.owner}/${repository.repo}`,
  });
}
