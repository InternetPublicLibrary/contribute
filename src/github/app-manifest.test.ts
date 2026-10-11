import { describe, expect, it } from 'vitest';
import manifestText from '../../docs/github/app-manifest.json?raw';
import rulesetText from '../../docs/github/ruleset-default-branch.json?raw';

const manifest = JSON.parse(manifestText) as { default_permissions: Record<string, string>; default_events: string[] };
const ruleset = JSON.parse(rulesetText) as { bypass_actors: unknown[]; rules: { type: string; parameters?: Record<string, unknown> }[] };

describe('GitHub App least privilege (issue #13)', () => {
  it('asks only for contents, pull requests and metadata', () => {
    expect(manifest.default_permissions).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read' });
  });

  it('subscribes only to the events the webhook handles', () => {
    expect(manifest.default_events.sort()).toEqual(['installation', 'pull_request']);
  });

  it('protects the default branch with code-owner review and no bypass actors', () => {
    expect(ruleset.bypass_actors).toEqual([]);
    expect(ruleset.rules).toContainEqual(expect.objectContaining({ type: 'pull_request', parameters: expect.objectContaining({ require_code_owner_review: true }) }));
    expect(ruleset.rules.map((rule) => rule.type)).toEqual(expect.arrayContaining(['deletion', 'non_fast_forward']));
  });
});
