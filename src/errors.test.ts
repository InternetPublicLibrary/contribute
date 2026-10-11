import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AppError, ERROR_STATUS, type ErrorCode, gitHubError, handleError, handleNotFound, readJsonObject } from './errors';
import { app } from './worker';

function probeApp() {
  const probe = new Hono();
  probe.onError(handleError);
  probe.notFound(handleNotFound);
  probe.get('/throw/:code', (c) => {
    throw new AppError(c.req.param('code') as ErrorCode, 'probe', { field: 'x' });
  });
  probe.get('/crash', () => {
    throw new TypeError('secret internal detail');
  });
  probe.post('/json', async (c) => c.json(await readJsonObject(c.req.raw)));
  return probe;
}

describe('error shape', () => {
  it.each(Object.entries(ERROR_STATUS))('%s is returned as status %i with the shared body', async (code, status) => {
    const response = await probeApp().request(`/throw/${code}`);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: { code, message: 'probe', details: { field: 'x' } },
      requestId: expect.any(String),
    });
  });

  it('turns unexpected exceptions into INTERNAL without leaking their message', async () => {
    const response = await probeApp().request('/crash');
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain('"code":"INTERNAL"');
    expect(body).not.toContain('secret internal detail');
  });

  it('answers unknown routes with NOT_FOUND in the same shape', async () => {
    const response = await app.request('/nowhere');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('uses the Cloudflare ray id as request id when present', async () => {
    const response = await probeApp().request('/throw/FORBIDDEN', { headers: { 'cf-ray': 'abc123-GRU' } });

    expect(await response.json()).toMatchObject({ requestId: 'abc123-GRU' });
  });

  it('sends Retry-After when the error carries one', async () => {
    const probe = new Hono();
    probe.onError(handleError);
    probe.get('/', () => {
      throw new AppError('RATE_LIMITED', 'slow down', undefined, 120);
    });
    const response = await probe.request('/');

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('120');
  });
});

describe('readJsonObject', () => {
  const post = (body: string, type = 'application/json') =>
    probeApp().request('/json', { method: 'POST', body, headers: { 'content-type': type } });

  it('rejects malformed JSON with 400, not 500', async () => {
    const response = await post('{"name": ');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
  });

  it.each(['[]', 'null', '"text"', '42'])('rejects the non-object body %s with 400', async (body) => {
    expect((await post(body)).status).toBe(400);
  });

  it('rejects other content types with 415', async () => {
    expect((await post('name=x', 'application/x-www-form-urlencoded')).status).toBe(415);
  });

  it('returns the parsed object', async () => {
    expect(await (await post('{"name":"IPL"}')).json()).toEqual({ name: 'IPL' });
  });
});

describe('gitHubError', () => {
  it('reports a revoked installation token as GITHUB_AUTH, not as a config error', async () => {
    const error = await gitHubError(Response.json({ message: 'Bad credentials' }, { status: 401 }), 'get contents');

    expect(error).toMatchObject({ code: 'GITHUB_AUTH', status: 502, details: { githubStatus: 401, githubMessage: 'Bad credentials' } });
  });

  it('reports a 422 whose body is not JSON without throwing', async () => {
    const error = await gitHubError(new Response('<html>Unprocessable</html>', { status: 422 }), 'create ref');

    expect(error).toMatchObject({ code: 'GITHUB_ERROR', status: 502, details: { githubMessage: '<html>Unprocessable</html>' } });
  });

  it('turns a secondary rate limit into 503 with Retry-After', async () => {
    const response = Response.json(
      { message: 'You have exceeded a secondary rate limit.' },
      { status: 403, headers: { 'retry-after': '90' } },
    );

    expect(await gitHubError(response, 'create pull request')).toMatchObject({ code: 'GITHUB_UNAVAILABLE', status: 503, retryAfter: 90 });
  });

  it('derives Retry-After from the primary rate-limit reset time', async () => {
    const reset = Math.floor(Date.now() / 1000) + 300;
    const response = new Response('{}', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    });
    const error = await gitHubError(response, 'get ref');

    expect(error.code).toBe('GITHUB_UNAVAILABLE');
    expect(error.retryAfter).toBeGreaterThan(290);
  });

  it('keeps an ordinary 403 (missing permission) as GITHUB_ERROR', async () => {
    const error = await gitHubError(Response.json({ message: 'Resource not accessible by integration' }, { status: 403 }), 'put contents');

    expect(error.code).toBe('GITHUB_ERROR');
  });
});
