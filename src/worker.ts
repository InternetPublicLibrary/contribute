import { Hono } from 'hono';
import type { Env } from './env';
import { handleError, handleNotFound } from './errors';
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

app.post('/v1/webhook', webhookRoute({}));

export default app;
