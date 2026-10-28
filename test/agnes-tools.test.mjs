import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { createToolDefinitions } from '../lib/agnes-tools.js';
import { imageDimensions, sniffMediaType } from '../lib/agnes-files.js';
import { resolveConfig } from '../lib/config.js';
import { makePng, startMockServer } from './helpers.mjs';

const PNG = makePng(3, 2);
const workspaces = [];

/** @type {Awaited<ReturnType<typeof startMockServer>>} */
let server;
/** @type {string} */
let workspace;
/** @type {Array<Record<string, unknown>>} */
let tools;

function configFor(overrides = {}) {
  return resolveConfig({
    apiKey: 'sk-test-key',
    endpoint: `${server.origin}/v1/images/generations`,
    outputDir: 'agnes-output',
    timeoutMs: 5_000,
    downloadTimeoutMs: 5_000,
    ...overrides,
  });
}

const exec = { agent: {}, signal: new AbortController().signal };

/** The most recent generation POST, ignoring the image download that follows it. */
function lastApiRequest() {
  const request = [...server.requests].reverse()
    .find((entry) => entry.method === 'POST' && entry.url === '/v1/images/generations');
  assert.ok(request, 'a generation request was sent');
  return request;
}

before(async () => {
  server = await startMockServer((request, response, body) => {
    if (request.method === 'GET' && request.url === '/out.png') {
      response.setHeader('content-type', 'image/png');
      response.end(PNG);
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/images/generations') {
      if (body.includes('cancel me')) return; // leave the request hanging for the cancellation test
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        created: 1780000000,
        task_id: 'task_abc',
        data: [{ url: `${server.origin}/out.png`, b64_json: null, revised_prompt: null }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
});

after(async () => {
  await server.close();
  await Promise.all(workspaces.map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agnes-tools-'));
  workspaces.push(workspace);
  tools = createToolDefinitions({ config: configFor(), resolveCwd: async () => workspace });
});

describe('config', () => {
  test('fills documented defaults', () => {
    const config = resolveConfig({});
    assert.equal(config.model, 'agnes-image-2.5-flash');
    assert.equal(config.defaultSize, '2K');
    assert.equal(config.defaultRatio, '1:1');
    assert.equal(config.outputDir, 'agnes-output');
    assert.equal(config.maxReferenceImages, 6);
  });

  test('rejects an unknown size tier and a bad endpoint', () => {
    assert.throws(() => resolveConfig({ defaultSize: '8K' }), /defaultSize must be one of/);
    assert.throws(() => resolveConfig({ endpoint: 'ftp://example.com' }), /endpoint must be an http\(s\) URL/);
  });
});

describe('agnes_text2img', () => {
  test('generates, saves, and reports a PNG', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_text2img');
    const value = await tool.execute({ prompt: 'a red apple on a white background' }, exec);

    assert.equal(value.ok, true);
    assert.equal(value.model, 'agnes-image-2.5-flash');
    assert.equal(value.size, '2K');
    assert.equal(value.ratio, '1:1');
    assert.equal(value.width, 3);
    assert.equal(value.height, 2);
    assert.equal(value.bytes, PNG.length);
    assert.equal(value.taskId, 'task_abc');
    assert.ok(value.path.startsWith(workspace), 'the file lands in the session working directory');
    assert.ok(value.path.includes('agnes-output'), 'the default output directory is used');
    assert.equal(value.path.endsWith('.png'), true);

    const saved = await readFile(value.path);
    assert.deepEqual(saved, PNG);
    assert.equal(sniffMediaType(saved), 'image/png');
    assert.deepEqual(imageDimensions(saved, 'image/png'), { width: 3, height: 2 });

    const request = lastApiRequest();
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'agnes-image-2.5-flash');
    assert.equal(body.prompt, 'a red apple on a white background');
    assert.equal(body.size, '2K');
    assert.equal(body.ratio, '1:1');
    assert.deepEqual(body.extra_body, { response_format: 'url' });
    assert.equal(request.headers.authorization, 'Bearer sk-test-key');
  });

  test('honors size, ratio, and a requested path', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_text2img');
    const value = await tool.execute({
      prompt: 'wide banner',
      size: '1K',
      ratio: '16:9',
      path: join('renders', 'banner.png'),
    }, exec);

    assert.equal(value.size, '1K');
    assert.equal(value.ratio, '16:9');
    assert.equal(value.path, join(workspace, 'renders', 'banner.png'));

    const body = JSON.parse(lastApiRequest().body);
    assert.equal(body.size, '1K');
    assert.equal(body.ratio, '16:9');
  });

  test('never overwrites an existing file', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_text2img');
    const first = await tool.execute({ prompt: 'one', path: 'same.png' }, exec);
    const second = await tool.execute({ prompt: 'two', path: 'same.png' }, exec);

    assert.equal(first.path, join(workspace, 'same.png'));
    assert.equal(second.path, join(workspace, 'same-2.png'));
  });

  test('defaults to a timestamped file inside a trailing-separator directory', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_text2img');
    const value = await tool.execute({ prompt: 'folder', path: 'shots/' }, exec);
    assert.equal(value.path.startsWith(join(workspace, 'shots')), true);
    assert.match(value.path, /agnes-\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
  });

  test('fails clearly without an API key', async () => {
    const config = resolveConfig({ endpoint: `${server.origin}/v1/images/generations`, apiKeyEnv: 'AGNES_TEST_MISSING_KEY' });
    const tool = createToolDefinitions({ config, resolveCwd: async () => workspace })
      .find((definition) => definition.name === 'agnes_text2img');

    const callsBefore = server.requests.length;
    await assert.rejects(tool.execute({ prompt: 'x' }, exec), /No Agnes API key is configured/);
    assert.equal(server.requests.length, callsBefore, 'no request is sent without a key');
  });

  test('rejects an empty prompt and an invalid size before calling the API', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_text2img');
    const callsBefore = server.requests.length;
    await assert.rejects(tool.execute({ prompt: '   ' }, exec), /prompt must be a non-empty string/);
    await assert.rejects(tool.execute({ prompt: 'x', size: '8K' }, exec), /size must be one of/);
    assert.equal(server.requests.length, callsBefore);
  });

  test('renders the saved path and read_image hint', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_text2img');
    const value = await tool.execute({ prompt: 'render text' }, exec);
    const content = tool.output.render({}, value);

    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /3x2/);
    assert.match(content[0].text, /read_image/);
    assert.ok(content[0].text.includes(value.path));
  });

  test('propagates cancellation', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_text2img');
    const controller = new AbortController();
    const pending = tool.execute({ prompt: 'cancel me' }, { agent: {}, signal: controller.signal });
    controller.abort(new Error('cancelled by test'));
    await assert.rejects(pending, /cancelled by test/);
  });
});

describe('agnes_img2img', () => {
  test('sends a local reference image as a data URI', async () => {
    const referencePath = join(workspace, 'reference.png');
    await writeFile(referencePath, PNG);

    const tool = tools.find((entry) => entry.name === 'agnes_img2img');
    const value = await tool.execute({
      prompt: 'keep the character, redraw as a sword attack',
      images: ['reference.png'],
      size: '2K',
      ratio: '16:9',
    }, exec);

    assert.deepEqual(value.sourceImages, ['reference.png']);

    const body = JSON.parse(lastApiRequest().body);
    assert.equal(body.extra_body.image.length, 1);
    assert.equal(body.extra_body.image[0], `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(body.extra_body.response_format, 'url');
  });

  test('passes public URLs through untouched', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_img2img');
    const url = 'https://example.com/assets/character.png';
    const value = await tool.execute({ prompt: 'compose', images: [url] }, exec);

    assert.deepEqual(value.sourceImages, [url]);
    const body = JSON.parse(lastApiRequest().body);
    assert.deepEqual(body.extra_body.image, [url]);
  });

  test('accepts an inline data URI', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_img2img');
    const dataUri = `data:image/png;base64,${PNG.toString('base64')}`;
    const value = await tool.execute({ prompt: 'inline', images: [dataUri] }, exec);

    assert.deepEqual(value.sourceImages, ['inline data URI']);
    const body = JSON.parse(lastApiRequest().body);
    assert.deepEqual(body.extra_body.image, [dataUri]);
  });

  test('rejects missing files, unsupported schemes, and too many references', async () => {
    const tool = tools.find((entry) => entry.name === 'agnes_img2img');
    await assert.rejects(tool.execute({ prompt: 'x', images: ['missing.png'] }, exec), /Reference image not found/);
    await assert.rejects(tool.execute({ prompt: 'x', images: ['file:///secret.png'] }, exec), /unsupported scheme/);
    await assert.rejects(
      tool.execute({ prompt: 'x', images: Array.from({ length: 7 }, () => 'https://example.com/a.png') }, exec),
      /at most 6 reference images/,
    );
  });
});
