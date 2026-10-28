/**
 * The two video tools.
 *
 * `agnes_video` creates an asynchronous task and, by default, waits for it;
 * `agnes_video_status` continues or inspects a task by id. Both share the same
 * download-and-save path, so a task finished by either tool lands identically.
 *
 * Flash constraints are enforced here before the request leaves the Host:
 * fixed 720P, 4-12 seconds, at most 5 reference images, at most 3 reference
 * audios, no reference videos, and only public HTTPS media URLs (the API
 * fetches media itself, so a local file cannot be referenced).
 */

import { buildVideoRequest, createVideoTask, downloadVideo, queryVideoTask } from './agnes-video-api.js';
import { formatBytes, resolveOutputTarget, writeOutputFile } from './agnes-files.js';
import { missingKeyMessage } from './agnes-key.js';
import { VIDEO_MODES, VIDEO_RATIOS, VIDEO_SECONDS } from './config.js';

/** Reference-image cap of the Flash model. */
const MAX_REFERENCE_IMAGES = 5;

/** Reference-audio cap of the Flash model. */
const MAX_REFERENCE_AUDIOS = 3;

/** Result fields shared by both tools; optional fields appear only when known. */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', const: true },
    status: { type: 'string' },
    pending: { type: 'boolean' },
    videoId: { type: 'string' },
    taskId: { type: 'string' },
    model: { type: 'string' },
    prompt: { type: 'string' },
    mode: { type: 'string' },
    seconds: { type: 'string' },
    aspectRatio: { type: 'string' },
    progress: { type: 'integer' },
    path: { type: 'string' },
    bytes: { type: 'integer' },
    mediaType: { type: 'string' },
    elapsedMs: { type: 'integer' },
    next: { type: 'string' },
  },
  required: ['ok', 'status', 'videoId', 'model', 'progress'],
});

/**
 * Build both video tool definitions for one plugin activation.
 * @param {{
 *   config: import('./config.js').DEFAULT_CONFIG,
 *   resolveCwd: (exec: { agent?: unknown, signal?: AbortSignal }) => Promise<string>,
 *   resolveApiKey: () => Promise<string>,
 * }} options - plugin wiring; `resolveApiKey` re-reads the credential seam per call.
 * @returns {Array<Record<string, unknown>>} registry-ready definitions.
 */
export function createVideoToolDefinitions({ config, resolveCwd, resolveApiKey }) {
  const timeoutMs = config.videoWaitMs + config.timeoutMs + config.videoDownloadTimeoutMs + 30_000;

  const video = {
    name: 'agnes_video',
    description: [
      'Generate one short video with Agnes Video 2.5 Flash (720P, 4-12 seconds), wait for it, download the MP4, and return its path and byte size.',
      'Modes: text (prompt only), keyframe (first_frame and/or last_frame image URLs), reference (up to 5 image URLs and 3 audio URLs).',
      'Reference media must be public HTTPS URLs — the API fetches them itself, so local files and data URIs cannot be used; reference videos are not supported by Flash.',
      'The task is asynchronous: when it is not finished within the wait budget, the result is pending with a videoId — call agnes_video_status with that id to continue.',
      'Describe subject and scene, action, camera language, visual style, and sound; keep the prompt concrete.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'What happens in the video. Order the description as subject and scene, action and change, camera language, visual style, then sound or rhythm.',
        },
        mode: {
          type: 'string',
          enum: VIDEO_MODES,
          description: 'text: prompt only. keyframe: control first and/or last frame. reference: use image or audio references. Defaults to text.',
        },
        seconds: {
          type: 'string',
          enum: VIDEO_SECONDS,
          description: `Video duration in seconds as a string. Defaults to ${config.videoDefaultSeconds}.`,
        },
        aspect_ratio: {
          type: 'string',
          enum: VIDEO_RATIOS,
          description: `Frame aspect ratio. Defaults to ${config.videoDefaultAspectRatio}. 720P output sizes: 21:9 1680x720, 16:9 1280x704, 4:3 960x720, 1:1 720x720, 3:4 720x960, 9:16 720x1280.`,
        },
        seed: {
          type: 'integer',
          description: 'Optional random seed (0-2147483647); a repeated seed improves reproducibility.',
        },
        first_frame: {
          type: 'string',
          description: 'keyframe mode: public HTTPS URL of the first frame. Provide this, last_frame, or both.',
        },
        last_frame: {
          type: 'string',
          description: 'keyframe mode: public HTTPS URL of the last frame.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: `reference mode: up to ${MAX_REFERENCE_IMAGES} public HTTPS image URLs. In the prompt, refer to them as <Picture 1>, <Picture 2>...`,
        },
        audios: {
          type: 'array',
          items: { type: 'string' },
          description: `reference mode: up to ${MAX_REFERENCE_AUDIOS} public HTTPS audio URLs. In the prompt, refer to them as <Audio 1>, <Audio 2>...`,
        },
        path: {
          type: 'string',
          description: `Optional output path for the MP4. Relative paths resolve against the session working directory; a trailing separator means "inside this directory with the default name". Defaults to the plugin outputDir (${config.outputDir}) with a timestamped name.`,
        },
        wait: {
          type: 'boolean',
          description: `Wait up to ${Math.round(config.videoWaitMs / 1000)}s for completion and download the file. Set false to return the videoId immediately and poll with agnes_video_status. Defaults to true.`,
        },
      },
      required: ['prompt'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    timeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => createVideo({ config, resolveCwd, resolveApiKey, exec, args }),
  };

  const status = {
    name: 'agnes_video_status',
    description: [
      'Check, continue waiting for, and download an Agnes video task created by agnes_video.',
      'Polls until the task is completed or failed, or until the wait budget expires; when completed it downloads the MP4 to the session working directory and returns the path.',
      'Use the videoId returned by agnes_video. A failed task reports the API error message.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        videoId: {
          type: 'string',
          description: 'The videoId returned by agnes_video (for example video_...).',
        },
        path: {
          type: 'string',
          description: 'Optional output path for the MP4 when the task has completed. Defaults to the plugin outputDir with a timestamped name.',
        },
        wait: {
          type: 'boolean',
          description: `Wait up to ${Math.round(config.videoWaitMs / 1000)}s for completion. Set false for a single progress check. Defaults to true.`,
        },
      },
      required: ['videoId'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    timeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => checkVideo({ config, resolveCwd, resolveApiKey, exec, args }),
  };

  return [video, status];
}

/**
 * Render one video result as model-facing text.
 * @param {unknown} _args - the call arguments, unused.
 * @param {Record<string, unknown>} value - the validated tool value.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
function renderResult(_args, value) {
  const seconds = typeof value.elapsedMs === 'number' ? `${(value.elapsedMs / 1000).toFixed(1)}s` : 'unknown time';
  if (value.status === 'completed' && typeof value.path === 'string') {
    return [{
      type: 'text',
      text: [
        `Generated a ${value.seconds ?? '?'}s ${value.aspectRatio ?? ''} video (${formatBytes(value.bytes)}) with ${value.model} in ${seconds}.`,
        `Path: ${value.path}`,
        'Open it from the file preview, or deliver it with present.',
      ].join('\n'),
    }];
  }
  return [{
    type: 'text',
    text: [
      `Video task ${value.videoId} is ${value.status} (${value.progress}%) after ${seconds}.`,
      value.next ?? 'Check it again with agnes_video_status and the same videoId.',
    ].join('\n'),
  }];
}

/**
 * Create one video task and optionally wait for it.
 * @param {{
 *   config: import('./config.js').DEFAULT_CONFIG,
 *   resolveCwd: (exec: { agent?: unknown, signal?: AbortSignal }) => Promise<string>,
 *   resolveApiKey: () => Promise<string>,
 *   exec: { agent?: unknown, signal?: AbortSignal },
 *   args: Record<string, unknown>,
 * }} input - call inputs.
 * @returns {Promise<Record<string, unknown>>} the tool value.
 */
async function createVideo({ config, resolveCwd, resolveApiKey, exec, args }) {
  const apiKey = await resolveApiKey();
  if (apiKey === '') throw new Error(missingKeyMessage(config.credentialRef));

  const prompt = requireText(args.prompt, 'prompt');
  const mode = args.mode === undefined ? 'text' : requireChoice(args.mode, VIDEO_MODES, 'mode');
  const seconds = args.seconds === undefined
    ? config.videoDefaultSeconds
    : requireChoice(args.seconds, VIDEO_SECONDS, 'seconds');
  const aspectRatio = args.aspect_ratio === undefined
    ? config.videoDefaultAspectRatio
    : requireChoice(args.aspect_ratio, VIDEO_RATIOS, 'aspect_ratio');
  const seed = args.seed === undefined ? undefined : requireSeed(args.seed);

  const firstFrame = args.first_frame === undefined ? undefined : requirePublicMedia(args.first_frame, 'first_frame');
  const lastFrame = args.last_frame === undefined ? undefined : requirePublicMedia(args.last_frame, 'last_frame');
  const images = mediaList(args.images, 'images', MAX_REFERENCE_IMAGES);
  const audios = mediaList(args.audios, 'audios', MAX_REFERENCE_AUDIOS);

  validateMode({ mode, firstFrame, lastFrame, images, audios });

  const cwd = await resolveCwd(exec);
  const startedAt = Date.now();

  const task = await createVideoTask({
    endpoint: config.videoEndpoint,
    apiKey,
    body: buildVideoRequest({
      model: config.videoModel,
      prompt,
      mode,
      seconds,
      aspectRatio,
      seed,
      firstFrame,
      lastFrame,
      images,
      audios,
    }),
    timeoutMs: config.timeoutMs,
    signal: exec.signal,
  });

  const base = {
    videoId: task.videoId,
    ...(task.taskId === undefined ? {} : { taskId: task.taskId }),
    model: config.videoModel,
    prompt,
    mode,
    seconds: task.seconds ?? seconds,
    aspectRatio,
  };

  const wantsWait = args.wait !== false;
  if (!wantsWait) {
    return pendingResult({
      base,
      status: task.status,
      progress: task.progress,
      startedAt,
      next: `Call agnes_video_status with videoId "${task.videoId}" to check progress and download the video.`,
    });
  }

  return finishVideo({
    config,
    apiKey,
    cwd,
    requestedPath: args.path,
    signal: exec.signal,
    startedAt,
    base,
    deadline: startedAt + config.videoWaitMs,
    firstSnapshot: { status: task.status, progress: task.progress },
  });
}

/**
 * Continue an existing video task.
 * @param {{
 *   config: import('./config.js').DEFAULT_CONFIG,
 *   resolveCwd: (exec: { agent?: unknown, signal?: AbortSignal }) => Promise<string>,
 *   resolveApiKey: () => Promise<string>,
 *   exec: { agent?: unknown, signal?: AbortSignal },
 *   args: Record<string, unknown>,
 * }} input - call inputs.
 * @returns {Promise<Record<string, unknown>>} the tool value.
 */
async function checkVideo({ config, resolveCwd, resolveApiKey, exec, args }) {
  const apiKey = await resolveApiKey();
  if (apiKey === '') throw new Error(missingKeyMessage(config.credentialRef));

  const videoId = requireText(args.videoId, 'videoId');
  const cwd = await resolveCwd(exec);
  const startedAt = Date.now();
  const base = { videoId, model: config.videoModel };

  if (args.wait === false) {
    const snapshot = await queryVideoTask({
      queryEndpoint: config.videoQueryEndpoint,
      apiKey,
      videoId,
      model: config.videoModel,
      timeoutMs: config.timeoutMs,
      signal: exec.signal,
    });
    if (snapshot.status === 'failed') throw taskFailure(base, snapshot);
    if (snapshot.status === 'completed') {
      return saveCompleted({ config, cwd, requestedPath: args.path, snapshot, base, startedAt, signal: exec.signal });
    }
    return pendingResult({
      base,
      status: snapshot.status,
      progress: snapshot.progress,
      startedAt,
      next: `Still ${snapshot.status}. Call agnes_video_status again with videoId "${videoId}".`,
    });
  }

  return finishVideo({
    config,
    apiKey,
    cwd,
    requestedPath: args.path,
    signal: exec.signal,
    startedAt,
    base,
    deadline: startedAt + config.videoWaitMs,
  });
}

/**
 * Poll until the task ends or the wait budget expires, then download or report.
 * @param {{
 *   config: import('./config.js').DEFAULT_CONFIG,
 *   apiKey: string,
 *   cwd: string,
 *   requestedPath: unknown,
 *   signal?: AbortSignal,
 *   startedAt: number,
 *   base: Record<string, unknown>,
 *   deadline: number,
 *   firstSnapshot?: { status: string, progress: number },
 * }} input - polling inputs.
 * @returns {Promise<Record<string, unknown>>} the tool value.
 */
async function finishVideo({ config, apiKey, cwd, requestedPath, signal, startedAt, base, deadline, firstSnapshot }) {
  let snapshot = firstSnapshot ?? { status: 'queued', progress: 0 };

  while (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
    if (Date.now() >= deadline) break;
    await delay(config.videoPollIntervalMs, signal);
    snapshot = await queryVideoTask({
      queryEndpoint: config.videoQueryEndpoint,
      apiKey,
      videoId: String(base.videoId),
      model: String(base.model),
      timeoutMs: config.timeoutMs,
      signal,
    });
  }

  if (snapshot.status === 'failed') throw taskFailure(base, snapshot);
  if (snapshot.status === 'completed') {
    return saveCompleted({ config, cwd, requestedPath, snapshot, base, startedAt, signal });
  }

  return pendingResult({
    base,
    status: snapshot.status,
    progress: snapshot.progress,
    startedAt,
    next: `Call agnes_video_status with videoId "${String(base.videoId)}" to keep waiting; the video is still ${snapshot.status}.`,
  });
}

/**
 * Download a completed video and write it next to the session.
 * @param {{
 *   config: import('./config.js').DEFAULT_CONFIG,
 *   cwd: string,
 *   requestedPath: unknown,
 *   snapshot: { url?: string, seconds?: string, progress: number, status: string },
 *   base: Record<string, unknown>,
 *   startedAt: number,
 *   signal?: AbortSignal,
 * }} input - completion inputs.
 * @returns {Promise<Record<string, unknown>>} the tool value.
 */
async function saveCompleted({ config, cwd, requestedPath, snapshot, base, startedAt, signal }) {
  if (snapshot.url === undefined) {
    throw new Error(`Agnes reports video ${String(base.videoId)} completed but returned no download URL. Check it again with agnes_video_status; if it persists, generate a new clip.`);
  }

  const media = await downloadVideo({
    url: snapshot.url,
    timeoutMs: config.videoDownloadTimeoutMs,
    maxBytes: config.maxVideoBytes,
    signal,
  });
  const target = resolveOutputTarget({
    cwd,
    requested: typeof requestedPath === 'string' ? requestedPath : undefined,
    outputDir: config.outputDir,
    extension: media.extension,
    prefix: 'agnes-video',
  });
  const savedPath = await writeOutputFile(target, media.bytes);

  return {
    ok: true,
    status: 'completed',
    videoId: String(base.videoId),
    ...(base.taskId === undefined ? {} : { taskId: String(base.taskId) }),
    model: String(base.model),
    ...(base.prompt === undefined ? {} : { prompt: String(base.prompt) }),
    ...(base.mode === undefined ? {} : { mode: String(base.mode) }),
    seconds: typeof base.seconds === 'string' ? base.seconds : snapshot.seconds ?? '?',
    ...(base.aspectRatio === undefined ? {} : { aspectRatio: String(base.aspectRatio) }),
    progress: 100,
    path: savedPath,
    bytes: media.bytes.byteLength,
    mediaType: media.mediaType,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Build the pending tool value.
 * @param {{ base: Record<string, unknown>, status: string, progress: number, startedAt: number, next: string }} input
 *   - pending facts.
 * @returns {Record<string, unknown>} the tool value.
 */
function pendingResult({ base, status, progress, startedAt, next }) {
  return {
    ok: true,
    status,
    pending: true,
    videoId: String(base.videoId),
    ...(base.taskId === undefined ? {} : { taskId: String(base.taskId) }),
    model: String(base.model),
    ...(base.prompt === undefined ? {} : { prompt: String(base.prompt) }),
    ...(base.mode === undefined ? {} : { mode: String(base.mode) }),
    ...(base.seconds === undefined ? {} : { seconds: String(base.seconds) }),
    ...(base.aspectRatio === undefined ? {} : { aspectRatio: String(base.aspectRatio) }),
    progress,
    elapsedMs: Date.now() - startedAt,
    next,
  };
}

/** Build the one failure a `failed` task produces. */
function taskFailure(base, snapshot) {
  const detail = snapshot.error === undefined ? '' : `: ${snapshot.error}`;
  return new Error(`Agnes failed to generate video ${String(base.videoId)}${detail}. Adjust the prompt or media references and try again.`);
}

/**
 * Reject a mode/media combination the API refuses before the request is sent.
 * @param {{ mode: string, firstFrame?: string, lastFrame?: string, images: string[], audios: string[] }} input
 *   - mode and media.
 * @returns {void}
 */
function validateMode({ mode, firstFrame, lastFrame, images, audios }) {
  const hasKeyframes = firstFrame !== undefined || lastFrame !== undefined;
  const hasReferences = images.length > 0 || audios.length > 0;

  if (mode === 'text' && (hasKeyframes || hasReferences)) {
    throw new Error('agnes: mode "text" accepts no media; use keyframe (first_frame/last_frame) or reference (images/audios)');
  }
  if (mode === 'keyframe') {
    if (!hasKeyframes) throw new Error('agnes: mode "keyframe" requires first_frame, last_frame, or both');
    if (hasReferences) throw new Error('agnes: mode "keyframe" accepts no images or audios');
  }
  if (mode === 'reference' && !hasReferences) {
    throw new Error('agnes: mode "reference" requires at least one image or audio URL');
  }
}

/**
 * Normalize an optional media array of public URLs.
 * @param {unknown} value - the argument.
 * @param {string} field - argument name.
 * @param {number} max - the API's cap.
 * @returns {string[]} the validated URLs.
 */
function mediaList(value, field, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`agnes: ${field} must be an array of public HTTPS URLs`);
  if (value.length > max) throw new Error(`agnes: ${field} accepts at most ${max} URLs on the Flash model`);
  return value.map((entry, index) => requirePublicMedia(entry, `${field}[${index}]`));
}

/**
 * Require one publicly reachable media URL.
 * @param {unknown} value - candidate.
 * @param {string} field - argument name for the message.
 * @returns {string} the URL.
 */
function requirePublicMedia(value, field) {
  const url = requireText(value, field);
  if (/^data:/i.test(url)) {
    throw new Error(`agnes: ${field} must be a public HTTPS URL; the video API fetches media itself and cannot read data URIs`);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`agnes: ${field} must be a public HTTPS URL; local paths cannot be uploaded by the video API`);
  }
  return url;
}

/**
 * Require one non-empty string argument.
 * @param {unknown} value - candidate.
 * @param {string} field - argument name for the message.
 * @returns {string} the trimmed value.
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`agnes: ${field} must be a non-empty string`);
  return value.trim();
}

/**
 * Require one value from a closed set.
 * @param {unknown} value - candidate.
 * @param {readonly string[]} allowed - accepted values.
 * @param {string} field - argument name for the message.
 * @returns {string} the value.
 */
function requireChoice(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`agnes: ${field} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }
  return value;
}

/**
 * Require an optional seed inside the API's integer range.
 * @param {unknown} value - candidate.
 * @returns {number} the seed.
 */
function requireSeed(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error('agnes: seed must be an integer between 0 and 2147483647');
  }
  return value;
}

/**
 * Sleep, honoring caller cancellation.
 * @param {number} ms - delay.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
