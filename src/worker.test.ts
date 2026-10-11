import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { app } from './worker';

describe('GET /', () => {
  it('identifies the service and its environment', async () => {
    const response = await app.request('/', {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: 'contribute',
      description: 'Internet Public Library contribution service',
      environment: 'development',
    });
  });
});
