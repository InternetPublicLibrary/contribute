import { Hono } from 'hono';
import type { Env } from './env';

export const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) =>
  c.json({
    service: 'contribute',
    description: 'Internet Public Library contribution service',
    environment: c.env.ENVIRONMENT,
  }),
);

export default app;
