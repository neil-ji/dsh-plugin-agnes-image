/**
 * Agnes Video 2.5 Flash client.
 *
 * Unlike image generation this API is asynchronous: `POST /v1/videos` queues a
 * task and returns a `video_id`, a status endpoint reports progress, and only a
 * `completed` task carries a download URL. Flash fixes `size` to `"720P"`, takes
 * at most 5 reference images and 3 reference audios, and rejects reference
 * videos outright.
 */

import { AgnesApiError, fetchWithDeadline, redact } from './agnes-api.js';
import { sniffVideoContainer } from './agnes-files.js';
import { VIDEO_SIZE } from './config.js';

/** Default create endpoint. */
export const DEFAULT_VIDEO_ENDPOINT = 'https://apihub.agnes-ai.com/v1/videos';

/** Default status endpoint. */
export const DEFAULT_VIDEO_QUERY_ENDPOINT = 'https://apihub.agnes-ai.com/agnesapi';

/**
 * Build the exact create-task body.
 *
 * Media fields are only present for the mode that owns them: the API rejects a
 * request that mixes `mode` with another mode's fields.
 * @param {{
 *   model: string,
 *   prompt: string,
 *   mode: 'text' | 'keyframe' | 'reference',
 *   seconds?: string,
 *   aspectRatio?: string,
 *   seed?: number,
 *   firstFrame?: string,
 *   lastFrame?: string,
 *   images?: string[],
 *   audios?: string[],
 * }} input - canonical request fields.
 * @returns {Record<string, unknown>} the JSON body.
 */
export function buildVideoRequest({ model, prompt, mode, seconds, aspectRatio, seed, firstFrame, lastFrame, images = [], audios = [] }) {
  const body = { model, prompt, mode, size: VIDEO_SIZE };
  if (seconds !== undefined) body.seconds = seconds;
  if (aspectRatio !== undefined) body.aspect_ratio = aspectRatio;
  if (seed !== undefined) body.seed = seed;
  if (mode === 'keyframe') {
    if (firstFrame !== undefined) body.first_frame = firstFrame;
    if (lastFrame !== undefined) body.last_frame = lastFrame;
  }
  if (mode === 'reference') {
    if (images.length > 0) body.images = images;
    if (audios.length > 0) body.audios = audios;
  }
  return body;
}

/**
 * Turn a create/status HTTP failure into one actionable message.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - parsed JSON body, when it parsed.
 * @returns {{ code: string, message: string, retryable: boolean }} classification.
 */
export function describeVideoFailure(status, payload) {
  const detail = isRecord(payload) && typeof payload.detail === 'string'
    ? redact(payload.detail).trim()
    : isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
      ? redact(payload.error.message).trim()
      : '';
  const suffix = detail === '' ? '' : `: ${detail}`;

  if (status === 401 || status === 403) {
    return {
      code: 'AGNES_UNAUTHORIZED',
      message: `Agnes rejected the API key (HTTP ${status}${suffix}). Save a valid key in Settings → Agnes 生图, then retry.`,
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      code: 'AGNES_VIDEO_NOT_FOUND',
      message: `Agnes does not know that video id (HTTP 404${suffix}). Use the videoId returned when the task was created.`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: 'AGNES_RATE_LIMITED',
      message: `Agnes is rate limiting this key (HTTP 429${suffix}). Wait a few seconds and poll again.`,
      retryable: true,
    };
  }
  if (status === 400 || status === 422) {
    return {
      code: 'AGNES_BAD_REQUEST',
      message: `Agnes rejected the video request (HTTP ${status}${suffix}). The Flash model accepts size 720P, seconds "4"-"12", at most 5 reference images, at most 3 reference audios, and no reference videos.`,
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      code: 'AGNES_SERVER_ERROR',
      message: `Agnes returned a server error (HTTP ${status}${suffix}). This is usually transient; retry the status check once.`,
      retryable: true,
    };
  }
  return {
    code: 'AGNES_HTTP_ERROR',
    message: `Agnes returned HTTP ${status}${suffix}.`,
    retryable: status >= 500,
  };
}

/**
 * Create one video task.
 * @param {{
 *   endpoint: string,
 *   apiKey: string,
 *   body: Record<string, unknown>,
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   fetchImpl?: typeof fetch,
 * }} input - request inputs.
 * @returns {Promise<{ videoId: string, taskId?: string, status: string, progress: number, seconds?: string, size?: string }>}
 *   the queued task.
 */
export async function createVideoTask({ endpoint, apiKey, body, signal, timeoutMs, fetchImpl = fetch }) {
  const response = await fetchWithDeadline(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  }, {
    signal,
    timeoutMs,
    timeoutMessage: `Agnes did not accept the video task within ${Math.round(timeoutMs / 1000)}s. Retry the create call.`,
    fetchImpl,
  });

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    const failure = describeVideoFailure(response.status, payload);
    throw new AgnesApiError(failure.message, {
      status: response.status,
      code: failure.code,
      retryable: failure.retryable,
    });
  }

  const videoId = isRecord(payload) && typeof payload.video_id === 'string'
    ? payload.video_id
    : isRecord(payload) && typeof payload.id === 'string' ? payload.id : undefined;
  if (videoId === undefined || videoId === '') {
    throw new AgnesApiError('Agnes accepted the video task but returned no `video_id`, so progress cannot be queried. Retry the create call.', {
      code: 'AGNES_EMPTY_RESPONSE',
      retryable: true,
    });
  }

  return {
    videoId,
    ...(isRecord(payload) && typeof payload.task_id === 'string' ? { taskId: payload.task_id } : {}),
    status: isRecord(payload) && typeof payload.status === 'string' ? payload.status : 'queued',
    progress: isRecord(payload) && typeof payload.progress === 'number' ? payload.progress : 0,
    ...(isRecord(payload) && typeof payload.seconds === 'string' ? { seconds: payload.seconds } : {}),
    ...(isRecord(payload) && typeof payload.size === 'string' ? { size: payload.size } : {}),
  };
}

/**
 * Query one video task.
 * @param {{
 *   queryEndpoint: string,
 *   apiKey: string,
 *   videoId: string,
 *   model: string,
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   fetchImpl?: typeof fetch,
 * }} input - query inputs.
 * @returns {Promise<{
 *   status: 'queued' | 'in_progress' | 'completed' | 'failed' | string,
 *   progress: number,
 *   url?: string,
 *   error?: string,
 *   seconds?: string,
 *   size?: string,
 * }>} the task snapshot.
 */
export async function queryVideoTask({ queryEndpoint, apiKey, videoId, model, signal, timeoutMs, fetchImpl = fetch }) {
  const target = new URL(queryEndpoint);
  target.searchParams.set('video_id', videoId);
  target.searchParams.set('model_name', model);

  const response = await fetchWithDeadline(target.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  }, {
    signal,
    timeoutMs,
    timeoutMessage: `Agnes did not answer the video status check within ${Math.round(timeoutMs / 1000)}s. Poll again with agnes_video_status.`,
    fetchImpl,
  });

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    const failure = describeVideoFailure(response.status, payload);
    throw new AgnesApiError(failure.message, {
      status: response.status,
      code: failure.code,
      retryable: failure.retryable,
    });
  }

  const error = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
    ? redact(payload.error.message)
    : undefined;

  return {
    status: isRecord(payload) && typeof payload.status === 'string' ? payload.status : 'in_progress',
    progress: isRecord(payload) && typeof payload.progress === 'number' ? payload.progress : 0,
    ...(isRecord(payload) && typeof payload.url === 'string' && payload.url !== '' ? { url: payload.url } : {}),
    ...(error === undefined ? {} : { error }),
    ...(isRecord(payload) && typeof payload.seconds === 'string' ? { seconds: payload.seconds } : {}),
    ...(isRecord(payload) && typeof payload.size === 'string' ? { size: payload.size } : {}),
  };
}

/**
 * Download a completed video and verify it really is a video container.
 * @param {{
 *   url: string,
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   maxBytes: number,
 *   fetchImpl?: typeof fetch,
 * }} input - download inputs.
 * @returns {Promise<{ bytes: Uint8Array, mediaType: string, extension: string }>} the encoded video.
 */
export async function downloadVideo({ url, signal, timeoutMs, maxBytes, fetchImpl = fetch }) {
  const response = await fetchWithDeadline(url, { method: 'GET', headers: { accept: 'video/*' } }, {
    signal,
    timeoutMs,
    timeoutMessage: `Downloading the generated video timed out after ${Math.round(timeoutMs / 1000)}s. The result URL may have expired; rerun the generation.`,
    fetchImpl,
  });

  if (!response.ok) {
    throw new AgnesApiError(`Downloading the generated video failed (HTTP ${response.status}). The Agnes result URL may have expired; generate again.`, {
      status: response.status,
      code: 'AGNES_DOWNLOAD_FAILED',
      retryable: true,
    });
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AgnesApiError(`The generated video is ${declaredLength} bytes, above the ${maxBytes} byte limit. Shorten the clip.`, {
      code: 'AGNES_VIDEO_TOO_LARGE',
      retryable: false,
    });
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new AgnesApiError('The generated video download was empty.', { code: 'AGNES_EMPTY_VIDEO', retryable: true });
  }
  if (bytes.byteLength > maxBytes) {
    throw new AgnesApiError(`The generated video is ${bytes.byteLength} bytes, above the ${maxBytes} byte limit. Shorten the clip.`, {
      code: 'AGNES_VIDEO_TOO_LARGE',
      retryable: false,
    });
  }

  const container = sniffVideoContainer(bytes);
  if (container === undefined) {
    throw new AgnesApiError('The downloaded file is not an MP4 or WebM video, so it was not saved. Retry the generation.', {
      code: 'AGNES_NOT_A_VIDEO',
      retryable: true,
    });
  }

  return { bytes, mediaType: container, extension: container === 'video/webm' ? '.webm' : '.mp4' };
}

/** Parse a JSON body without throwing on an empty or malformed answer. */
function parseJson(text) {
  try {
    return text === '' ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
