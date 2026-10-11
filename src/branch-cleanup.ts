import { loadSettings } from './config/environment';
import { AppError, log } from './errors';
import { gitHubAppFromEnv } from './github/client';
import { deleteBranch } from './github/repository';
import { releaseContribution } from './contrib/limits';
import type { WebhookHandler } from './webhook';

/** Branches created by the service; nothing else is ever deleted. */
export const CONTRIBUTION_BRANCH_PREFIX = 'contribute/';

interface PullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    body?: string | null;
    head?: { ref?: string; repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

/**
 * `pull_request.closed` → delete the contribution branch (issue #14). Idempotent: a branch already removed (for
 * example by "Automatically delete head branches") is success. Failures are logged and acknowledged with 2xx on
 * purpose: GitHub redelivery would only repeat the same failure, and a leftover branch is harmless.
 */
export function branchCleanup(fetcher?: typeof fetch): WebhookHandler {
  return async (delivery, c) => {
    const { action, pull_request: pull } = delivery.payload as PullRequestPayload;
    if (action !== 'closed' || !pull) return { status: 'ignored', reason: 'not a closed pull request' };
    // Free the contributor's open-PR slot (issue #6), whatever happens to the branch.
    const baseName = pull.base?.repo?.full_name ?? '';
    if (baseName && pull.number) await releaseContribution(c.env.CONTRIBUTE_KV, pull.body, `${baseName}#${pull.number}`);

    const ref = pull.head?.ref ?? '';
    const head = pull.head?.repo?.full_name ?? '';
    const base = pull.base?.repo?.full_name ?? '';
    if (!ref.startsWith(CONTRIBUTION_BRANCH_PREFIX)) return { status: 'ignored', reason: 'not a contribution branch' };
    if (!head || head !== base) return { status: 'ignored', reason: 'branch from another repository' };

    const settings = loadSettings(c.env);
    const repository = Object.values(settings.repositories).find(({ owner, repo }) => `${owner}/${repo}`.toLowerCase() === base.toLowerCase());
    if (!repository) return { status: 'ignored', reason: 'not a configured content repository' };

    try {
      const result = await deleteBranch(gitHubAppFromEnv(c.env, fetcher), repository, ref);
      return { status: result, branch: ref, pullRequest: pull.number ?? null };
    } catch (error) {
      log('warn', c, { cleanup: 'failed', delivery: delivery.id, branch: ref, code: error instanceof AppError ? error.code : 'INTERNAL' });
      return { status: 'cleanup-failed', branch: ref };
    }
  };
}
