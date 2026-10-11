# The IPL contribute GitHub App

The Worker writes to GitHub **only** as this App (spec 001, issue #18). Its private key lives in a Worker secret, so
a leaked key is the main risk; this page keeps that risk small (issue #13).

## Permissions (least privilege)

Source of truth: [`app-manifest.json`](app-manifest.json). The installed App must match it.

| Permission | Level | Why |
| --- | --- | --- |
| Contents | write | create `contribute/*` branches and commit the proposed file |
| Pull requests | write | open the pull request, add labels |
| Metadata | read | mandatory for every App |

**Never granted:** Workflows (a contribution can never change CI), Administration (cannot change rulesets or
settings), Members, Secrets, Actions, Environments, Issues, Discussions. Webhook events: `pull_request`,
`installation`.

Check the installed App against the manifest (prints the granted permissions):

```bash
gh api /orgs/InternetPublicLibrary/installations --jq '.installations[] | select(.app_slug=="ipl-contribute") | .permissions'
```

## Installation

Install on these repositories only: `en-US`, `pt-BR`, `IPLibrary-website` (production) and `contribute-sandbox`
(development and staging). Never "All repositories".

## Default branches are not writable by the App

Each content repository has the ruleset in [`ruleset-default-branch.json`](ruleset-default-branch.json): changes to the
default branch need a pull request with a code-owner approval, no force pushes or deletion, and **no bypass actors** —
the App is not in a bypass list. Apply it (a repository admin):

```bash
for repo in en-US pt-BR IPLibrary-website contribute-sandbox; do
  gh api -X POST "repos/InternetPublicLibrary/$repo/rulesets" --input docs/github/ruleset-default-branch.json
done
```

Enable **Settings → General → Automatically delete head branches** on the same repositories (issue #14).

### Manual check (after installing on the sandbox)

With an installation token, a direct write to the default branch must fail:

```bash
# TOKEN = an installation token of the App for contribute-sandbox
curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/InternetPublicLibrary/contribute-sandbox/contents/probe.txt \
  -d '{"message":"probe","content":"cHJvYmU=","branch":"main"}'
# expected: 409 / 422 "Repository rule violations found" — and no commit on main
```

Record the date and result of this check in the deployment notes when the App or the rulesets change.

## Private key rotation

1. GitHub → Settings → Developer settings → GitHub Apps → IPL contribute → **Generate a private key**.
2. Convert to PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in new.pem -out new.pkcs8.pem`.
3. `npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging < new.pkcs8.pem`; check a contribution on staging.
4. Same for `--env production`.
5. Delete the old key on GitHub; securely delete the local `.pem` files.
6. If the old key may have leaked: also rotate `GITHUB_WEBHOOK_SECRET` and review the App's recent activity
   (`gh api /orgs/InternetPublicLibrary/audit-log` or the repositories' activity).

Rotate at least yearly and whenever someone with access to the secret leaves.
