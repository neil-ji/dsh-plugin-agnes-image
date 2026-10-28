import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { buildVideoRequest, describeVideoFailure, downloadVideo } from '../lib/agnes-video-api.js';
import { sniffVideoContainer } from '../lib/agnes-files.js';
import { resolveConfig } from '../lib/config.js';
import { createVideoToolDefinitions } from '../lib/video-tools.js';
import { makePng, startMockServer } from './helpers.mjs';

const PNG = makePng(3, 2);
const MP4 = (() => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('isom', 8, 'ascii');
  bytes.write('isomiso2mp41', 12, 'ascii');
  return bytes;
})();

const workspaces = [];
const pollCounts = new Map();

/** @type {Awaited<ReturnType<typeof startMockServer>>} */
let server;
/** @type {string} */
let workspace;
/** @type {ReturnType<typeof createVideoToolDefinitions>} */
let tools;

function configFor(overrides = {}) {
  return resolveConfig({
    apiKey: 'sk-test-key',
    videoEndpoint: `${server.origin}/v1/videos`,
    videoQueryEndpoint: `${server.origin}/agnesapi`,
    outputDir: 'agnes-output',
    timeoutMs: 5_000,
    videoWaitMs: 3_000,
    videoPollIntervalMs: 100,
    videoDownloadTimeoutMs: 5_000,
    ...overrides,
  });
}

function rebuild(overrides) {
  const definitions = createVideoToolDefinitions({
    config: configFor(overrides),
    resolveCwd: async () => workspace,
    resolveApiKey: async () => 'sk-test-key',
  });
  return definitions;
}

function toolNamed(name, overrides) {
  return rebuild(overrides).find((definition) => definition.name === name);
}

const exec = { agent: {}, signal: new AbortController().signal };

function lastCreate() {
  const request = [...server.requests].reverse()
    .find((entry) => entry.method === 'POST' && entry.url === '/v1/videos');
  assert.ok(request, 'a create request was sent');
  return JSON.parse(request.body);
}

before(async () => {
  server = await startMockServer((request, response, body) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/v1/videos') {
      const parsed = JSON.parse(body);
      if (parsed.prompt === 'force 400') {
        response.statusCode = 400;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ detail: 'size must be 720P' }));
        return;
      }
      const suffix = parsed.prompt === 'fail task' ? 'fail' : parsed.prompt === 'stuck task' ? 'stuck' : `${server.requests.length}`;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        id: `task_${suffix}`,
        task_id: `task_${suffix}`,
        video_id: `video_${suffix}`,
        object: 'video',
        model: parsed.model,
        status: 'queued',
        progress: 0,
        created_at: 1786900000,
        seconds: parsed.seconds ?? '5',
        size: '720P',
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/agnesapi') {
      const videoId = url.searchParams.get('video_id') ?? '';
      const model = url.searchParams.get('model_name');
      if (model !== 'agnes-video-2.5-flash') {
        response.statusCode = 400;
        response.end(JSON.stringify({ detail: 'missing model_name' }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (videoId.includes('fail')) {
        response.end(JSON.stringify({ status: 'failed', progress: 100, error: { message: 'Invalid reference media' } }));
        return;
      }
      if (videoId.includes('stuck')) {
        response.end(JSON.stringify({ status: 'in_progress', progress: 42 }));
        return;
      }
      const count = pollCounts.get(videoId) ?? 0;
      pollCounts.set(videoId, count + 1);
      if (count === 0) {
        response.end(JSON.stringify({ status: 'in_progress', progress: 57 }));
        return;
      }
      response.end(JSON.stringify({
        status: 'completed',
        progress: 100,
        url: `${server.origin}/video.mp4`,
        seconds: '4',
        size: '720P',
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/video.mp4') {
      response.setHeader('content-type', 'video/mp4');
      response.end(MP4);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/not-video.mp4') {
      response.setHeader('content-type', 'image/png');
      response.end(PNG);
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
  workspace = await mkdtemp(join(tmpdir(), 'agnes-video-'));
  workspaces.push(workspace);
  pollCounts.clear();
  server.requests.length = 0;
  tools = rebuild();
});

describe('buildVideoRequest', () => {
  test('builds a text task with the fixed 720P tier', () => {
    const body = buildVideoRequest({
      model: 'agnes-video-2.5-flash',
      prompt: 'a city street after rain',
      mode: 'text',
      seconds: '5',
      aspectRatio: '16:9',
    });
    assert.deepEqual(body, {
      model: 'agnes-video-2.5-flash',
      prompt: 'a city street after rain',
      mode: 'text',
      size: '720P',
      seconds: '5',
      aspect_ratio: '16:9',
    });
  });

  test('includes only the media a mode owns', () => {
    const keyframe = buildVideoRequest({
      model: 'm', prompt: 'p', mode: 'keyframe', firstFrame: 'https://a/f.png', images: ['https://a/x.png'],
    });
    assert.equal(keyframe.first_frame, 'https://a/f.png');
    assert.equal('images' in keyframe, false, 'keyframe mode never sends reference images');

    const reference = buildVideoRequest({
      model: 'm', prompt: 'p', mode: 'reference', firstFrame: 'https://a/f.png',
      images: ['https://a/1.png'], audios: ['https://a/1.mp3'],
    });
    assert.equal('first_frame' in reference, false, 'reference mode never sends keyframes');
    assert.deepEqual(reference.images, ['https://a/1.png']);
    assert.deepEqual(reference.audios, ['https://a/1.mp3']);
  });
});

describe('video config and errors', () => {
  test('fills video defaults', () => {
    const config = resolveConfig({});
    assert.equal(config.videoModel, 'agnes-video-2.5-flash');
    assert.equal(config.videoDefaultSeconds, '5');
    assert.equal(config.videoDefaultAspectRatio, '16:9');
    assert.equal(config.videoWaitMs, 180_000);
    assert.equal(config.maxVideoBytes, 256 * 1024 * 1024);
  });

  test('rejects an invalid video duration or endpoint', () => {
    assert.throws(() => resolveConfig({ videoDefaultSeconds: '20' }), /videoDefaultSeconds must be one of/);
    assert.throws(() => resolveConfig({ videoEndpoint: 'ftp://x' }), /videoEndpoint must be an http\(s\) URL/);
  });

  test('surfaces the Flash 400 detail', () => {
    const failure = describeVideoFailure(400, { detail: 'images length must not exceed 5' });
    assert.match(failure.message, /images length must not exceed 5/);
    assert.equal(failure.retryable, false);
  });
});

describe('agnes_video', () => {
  test('creates, polls, downloads, and saves an MP4', async () => {
    const tool = toolNamed('agnes_video');
    const value = await tool.execute({
      prompt: 'a neon city street after rain, slow dolly forward',
      seconds: '4',
      aspect_ratio: '16:9',
    }, exec);

    assert.equal(value.status, 'completed');
    assert.equal(value.videoId.startsWith('video_'), true);
    assert.equal(value.seconds, '4');
    assert.equal(value.progress, 100);
    assert.equal(value.mediaType, 'video/mp4');
    assert.ok(value.path.startsWith(workspace), 'saved inside the session working directory');
    assert.ok(value.path.includes('agnes-output'));
    assert.match(value.path, /agnes-video-\d{8}-\d{6}-[0-9a-f]{4}\.mp4$/);
    assert.deepEqual(await readFile(value.path), MP4);
    assert.equal(sniffVideoContainer(await readFile(value.path)), 'video/mp4');

    const body = lastCreate();
    assert.equal(body.model, 'agnes-video-2.5-flash');
    assert.equal(body.mode, 'text');
    assert.equal(body.size, '720P');
    assert.equal(body.seconds, '4');
    assert.equal(body.aspect_ratio, '16:9');
    assert.equal('images' in body, false);
    const create = server.requests.find((entry) => entry.method === 'POST' && entry.url === '/v1/videos');
    assert.equal(create.headers.authorization, 'Bearer sk-test-key');
  });

  test('returns a pending result when the wait budget expires', async () => {
    const tool = toolNamed('agnes_video', { videoWaitMs: 200, videoPollIntervalMs: 100 });
    const value = await tool.execute({ prompt: 'stuck task' }, exec);

    assert.equal(value.pending, true);
    assert.equal(value.status, 'in_progress');
    assert.equal(value.videoId, 'video_stuck');
    assert.equal('path' in value, false, 'a pending task has no file');
    assert.match(value.next, /agnes_video_status/);
  });

  test('wait:false returns immediately without downloading', async () => {
    const tool = toolNamed('agnes_video');
    const value = await tool.execute({ prompt: 'queued only', wait: false }, exec);

    assert.equal(value.pending, true);
    assert.equal(value.status, 'queued');
    assert.equal('path' in value, false);
    assert.match(value.next, /agnes_video_status/);
    assert.equal(server.requests.some((entry) => entry.url === '/video.mp4'), false);
  });

  test('reports a failed task as an error', async () => {
    const tool = toolNamed('agnes_video');
    await assert.rejects(tool.execute({ prompt: 'fail task' }, exec), /Invalid reference media/);
  });

  test('surfaces a create-time HTTP 400', async () => {
    const tool = toolNamed('agnes_video');
    await assert.rejects(tool.execute({ prompt: 'force 400' }, exec), /size must be 720P/);
  });

  test('validates modes and media before any request', async () => {
    const tool = toolNamed('agnes_video');
    const before = server.requests.length;

    await assert.rejects(tool.execute({ prompt: 'x', mode: 'text', images: ['https://a/x.png'] }, exec), /mode "text" accepts no media/);
    await assert.rejects(tool.execute({ prompt: 'x', mode: 'keyframe' }, exec), /requires first_frame, last_frame, or both/);
    await assert.rejects(tool.execute({ prompt: 'x', mode: 'reference' }, exec), /requires at least one image or audio/);
    await assert.rejects(tool.execute({ prompt: 'x', mode: 'reference', images: ['local.png'] }, exec), /public HTTPS URL/);
    await assert.rejects(tool.execute({ prompt: 'x', mode: 'reference', images: ['data:image/png;base64,AAAA'] }, exec), /public HTTPS URL/);
    await assert.rejects(
      tool.execute({ prompt: 'x', mode: 'reference', images: Array.from({ length: 6 }, () => 'https://a/x.png') }, exec),
      /at most 5 URLs/,
    );
    await assert.rejects(
      tool.execute({ prompt: 'x', mode: 'reference', audios: Array.from({ length: 4 }, () => 'https://a/x.mp3') }, exec),
      /at most 3 URLs/,
    );
    assert.equal(server.requests.length, before, 'no request leaves the Host for invalid combinations');
  });

  test('sends reference images and audios in the request body', async () => {
    const tool = toolNamed('agnes_video');
    const value = await tool.execute({
      prompt: 'use <Picture 1> as the character and follow <Audio 1>',
      mode: 'reference',
      images: ['https://example.com/character.png'],
      audios: ['https://example.com/music.mp3'],
    }, exec);

    assert.equal(value.status, 'completed');
    const body = lastCreate();
    assert.equal(body.mode, 'reference');
    assert.deepEqual(body.images, ['https://example.com/character.png']);
    assert.deepEqual(body.audios, ['https://example.com/music.mp3']);
  });

  test('rejects a non-video download instead of saving it', async () => {
    await assert.rejects(
      downloadVideo({ url: `${server.origin}/not-video.mp4`, timeoutMs: 5_000, maxBytes: 1_000_000 }),
      /not an MP4 or WebM video/,
    );
  });
});

describe('agnes_video_status', () => {
  test('polls a task to completion and downloads it', async () => {
    const tool = toolNamed('agnes_video_status');
    const value = await tool.execute({ videoId: 'video_manual' }, exec);

    assert.equal(value.status, 'completed');
    assert.equal(value.videoId, 'video_manual');
    assert.equal(value.path.endsWith('.mp4'), true);
    assert.deepEqual(await readFile(value.path), MP4);
  });

  test('wait:false reports progress without a file', async () => {
    const tool = toolNamed('agnes_video_status');
    const value = await tool.execute({ videoId: 'video_stuck', wait: false }, exec);

    assert.equal(value.pending, true);
    assert.equal(value.status, 'in_progress');
    assert.equal(value.progress, 42);
    assert.equal('path' in value, false);
  });

  test('reports a failed task as an error', async () => {
    const tool = toolNamed('agnes_video_status');
    await assert.rejects(tool.execute({ videoId: 'video_fail' }, exec), /Invalid reference media/);
  });
});

describe('video result rendering', () => {
  test('renders the saved path for a completed clip', async () => {
    const tool = toolNamed('agnes_video');
    const value = await tool.execute({ prompt: 'render text', seconds: '4' }, exec);
    const content = tool.output.render({}, value);
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /Generated a 4s/);
    assert.ok(content[0].text.includes(value.path));
    assert.match(content[0].text, /present/);
  });

  test('renders the pending hint for an unfinished clip', async () => {
    const tool = toolNamed('agnes_video', { videoWaitMs: 200, videoPollIntervalMs: 100 });
    const value = await tool.execute({ prompt: 'stuck task' }, exec);
    const content = tool.output.render({}, value);
    assert.match(content[0].text, /agnes_video_status/);
  });
});
