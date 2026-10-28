import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  AgnesApiError,
  buildRequestBody,
  describeApiFailure,
  readGeneratedImage,
  redact,
  requestGeneration,
} from '../lib/agnes-api.js';
import { makePng, startMockServer } from './helpers.mjs';

const PNG = makePng(3, 2);

describe('buildRequestBody', () => {
  test('puts response_format and reference images inside extra_body', () => {
    const body = buildRequestBody({
      model: 'agnes-image-2.5-flash',
      prompt: 'a red apple',
      size: '1K',
      ratio: '1:1',
      images: ['data:image/png;base64,AAAA', 'https://example.com/ref.png'],
    });

    assert.equal(body.model, 'agnes-image-2.5-flash');
    assert.equal(body.prompt, 'a red apple');
    assert.deepEqual(body.extra_body, {
      response_format: 'url',
      image: ['data:image/png;base64,AAAA', 'https://example.com/ref.png'],
    });
    assert.equal('response_format' in body, false, 'top-level response_format is ignored by the API');
    assert.equal('image' in body, false, 'top-level image is rejected by the API');
  });

  test('omits extra_body.image for text-to-image', () => {
    const body = buildRequestBody({ model: 'm', prompt: 'p', size: '2K', ratio: '16:9' });
    assert.deepEqual(body.extra_body, { response_format: 'url' });
  });
});

describe('describeApiFailure', () => {
  test('maps 401 to an actionable key message without the key', () => {
    const failure = describeApiFailure(401, { error: { message: 'Invalid token (request id: abc)' } });
    assert.equal(failure.code, 'AGNES_UNAUTHORIZED');
    assert.match(failure.message, /AGNES_API_KEY/);
    assert.match(failure.message, /Invalid token/);
    assert.equal(failure.retryable, false);
  });

  test('maps 429 and 5xx to retryable failures', () => {
    assert.equal(describeApiFailure(429, undefined).retryable, true);
    assert.equal(describeApiFailure(503, undefined).retryable, true);
    assert.equal(describeApiFailure(400, { error: { message: 'steps is not supported' } }).retryable, false);
  });
});

describe('redact', () => {
  test('masks a bearer credential', () => {
    assert.equal(redact('Authorization: Bearer sk-secret-value'), 'Authorization: Bearer <redacted>');
  });
});

describe('requestGeneration', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;

  before(async () => {
    server = await startMockServer((request, response, body) => {
      if (request.url === '/generate/timeout') {
        // Intentionally never answer: the client deadline must fire.
        return;
      }
      if (request.url === '/generate/unauthorized') {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { message: 'Invalid token', type: 'invalid_request' } }));
        return;
      }
      if (request.url === '/generate/empty') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        created: 1780000000,
        task_id: 'task_123',
        data: [{ url: `${serverOrigin()}/image.png`, b64_json: null, revised_prompt: null }],
      }));
      void body;
    });
  });

  after(async () => {
    await server.close();
  });

  function serverOrigin() {
    return server.origin;
  }

  test('posts the documented body and reads the image entry', async () => {
    const result = await requestGeneration({
      endpoint: `${server.origin}/generate`,
      apiKey: 'sk-test',
      body: buildRequestBody({ model: 'agnes-image-2.5-flash', prompt: 'p', size: '1K', ratio: '1:1' }),
      timeoutMs: 5_000,
    });

    assert.equal(result.url, `${server.origin}/image.png`);
    assert.equal(result.taskId, 'task_123');

    const observed = server.requests.at(-1);
    assert.equal(observed.method, 'POST');
    assert.equal(observed.headers.authorization, 'Bearer sk-test');
    assert.equal(observed.headers['content-type'], 'application/json');
    const parsed = JSON.parse(observed.body);
    assert.deepEqual(parsed.extra_body, { response_format: 'url' });
  });

  test('turns a 401 into AGNES_UNAUTHORIZED', async () => {
    await assert.rejects(
      requestGeneration({
        endpoint: `${server.origin}/generate/unauthorized`,
        apiKey: 'sk-test',
        body: { model: 'm', prompt: 'p' },
        timeoutMs: 5_000,
      }),
      (error) => {
        assert.ok(error instanceof AgnesApiError);
        assert.equal(error.code, 'AGNES_UNAUTHORIZED');
        assert.equal(error.status, 401);
        return true;
      },
    );
  });

  test('turns an empty data array into AGNES_EMPTY_RESPONSE', async () => {
    await assert.rejects(
      requestGeneration({
        endpoint: `${server.origin}/generate/empty`,
        apiKey: 'sk-test',
        body: { model: 'm', prompt: 'p' },
        timeoutMs: 5_000,
      }),
      (error) => error.code === 'AGNES_EMPTY_RESPONSE',
    );
  });

  test('enforces the client deadline', async () => {
    const started = Date.now();
    await assert.rejects(
      requestGeneration({
        endpoint: `${server.origin}/generate/timeout`,
        apiKey: 'sk-test',
        body: { model: 'm', prompt: 'p' },
        timeoutMs: 80,
      }),
      (error) => error.code === 'AGNES_TIMEOUT' && error.retryable === true,
    );
    assert.ok(Date.now() - started >= 60, 'the deadline must actually wait');
  });

  test('forwards caller cancellation', async () => {
    const controller = new AbortController();
    const pending = requestGeneration({
      endpoint: `${server.origin}/generate/timeout`,
      apiKey: 'sk-test',
      body: { model: 'm', prompt: 'p' },
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort(new Error('user cancelled'));
    await assert.rejects(pending, /user cancelled/);
  });
});

describe('readGeneratedImage', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;

  before(async () => {
    server = await startMockServer((request, response) => {
      if (request.url === '/image.png') {
        response.setHeader('content-type', 'image/png');
        response.setHeader('content-length', String(PNG.length));
        response.end(PNG);
        return;
      }
      if (request.url === '/missing.png') {
        response.statusCode = 404;
        response.end('gone');
        return;
      }
      response.statusCode = 500;
      response.end('unexpected');
    });
  });

  after(async () => {
    await server.close();
  });

  test('downloads bytes and reports the declared media type', async () => {
    const image = await readGeneratedImage({
      source: { url: `${server.origin}/image.png` },
      timeoutMs: 5_000,
      maxBytes: 1024 * 1024,
    });
    assert.equal(image.origin, 'url');
    assert.equal(image.mediaType, 'image/png');
    assert.deepEqual(Buffer.from(image.bytes), PNG);
  });

  test('decodes base64 answers', async () => {
    const image = await readGeneratedImage({
      source: { b64: PNG.toString('base64') },
      timeoutMs: 5_000,
      maxBytes: 1024 * 1024,
    });
    assert.equal(image.origin, 'base64');
    assert.deepEqual(Buffer.from(image.bytes), PNG);
  });

  test('refuses an expired download URL', async () => {
    await assert.rejects(
      readGeneratedImage({
        source: { url: `${server.origin}/missing.png` },
        timeoutMs: 5_000,
        maxBytes: 1024 * 1024,
      }),
      (error) => error.code === 'AGNES_DOWNLOAD_FAILED' && error.status === 404,
    );
  });

  test('refuses payloads above the byte limit', async () => {
    await assert.rejects(
      readGeneratedImage({
        source: { b64: PNG.toString('base64') },
        timeoutMs: 5_000,
        maxBytes: 16,
      }),
      (error) => error.code === 'AGNES_IMAGE_TOO_LARGE',
    );
  });
});
