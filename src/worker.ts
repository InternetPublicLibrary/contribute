import { Hono } from 'hono';
import type { Env } from './env';
import { authRoutes } from './auth/routes';
import { contributionRoutes } from './contrib/routes';
import { AppError, handleError, handleNotFound } from './errors';
import { branchCleanup } from './branch-cleanup';
import { legacyEntryRoute } from './legacy-entry';
import { webhookRoute } from './webhook';

export const app = new Hono<{ Bindings: Env }>();

app.onError(handleError);
app.notFound(handleNotFound);

app.get('/', (c) =>
  c.json({
    service: 'contribute',
    description: 'Internet Public Library contribution service',
    environment: c.env.ENVIRONMENT,
  }),
);

app.post('/v3/entry/github/:owner/:repo/:branch/:property', legacyEntryRoute());
// Upstream's other versions and services (v1/v2 entries, GitLab, connect, encrypt, OAuth) are retired (#18).
const retired = () => {
  throw new AppError('GONE', 'This upstream Staticman route is retired.');
};
for (const prefix of ['/v1/entry', '/v1/connect', '/v2/entry', '/v2/connect', '/v2/encrypt', '/v2/auth', '/v3/entry', '/v3/connect', '/v3/encrypt', '/v3/auth']) {
  app.all(`${prefix}/*`, retired);
}
app.route('/v1', authRoutes());
app.route('/v1', contributionRoutes());
app.post('/v1/webhook', webhookRoute({ pull_request: branchCleanup() }));

export default app;
