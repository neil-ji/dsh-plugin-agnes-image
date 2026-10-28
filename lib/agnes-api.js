/**
 * Agnes Image 2.5 Flash HTTP client.
 *
 * The endpoint takes a single JSON POST and answers either a temporary URL or
 * an inline base64 payload. Everything the API rejects loudly is kept out of
 * the request: `response_format` lives in `extra_body` (a top-level value is
 * ignored), reference images live in `extra_body.image` as an array, and the
 * model accepts neither `n > 1` nor seeds.
 */

/** Default generation endpoint from the reference documentation. */
export const DEFAULT_ENDPOINT = 'https://apihub.agnes-ai.com/v1/images/generations';

/** One failure from this client, with the HTTP status when one exists. */
export class AgnesApiError extends Error {
  /**
   * @param {string} message - safe, user-facing description.
   * @param {{ status?: number, code?: string, retryable?: boolean, cause?: unknown }} [options] - classification.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgnesApiError';
    this.status = options.status;
    this.code = options.code ?? 'AGNES_ERROR';
    this.retryable = options.retryable === true;
  }
}

/**
 * Build the exact request body the endpoint expects.
 * @param {{ model: string, prompt: string, size: string, ratio: string, images?: string[], responseFormat?: 'url' | 'b64_json' }} input
 *   - canonical request fields.
 * @returns {Record<string, unknown>} the JSON body.
 */
export function buildRequestBody({ model, prompt, size, ratio, images = [], responseFormat = 'url' }) {
  const extraBody = { response_format: responseFormat };
  if (images.length > 0) extraBody.image = [...images];
  return { model, prompt, size, ratio, extra_body: extraBody };
}

/**
 * Turn an API error payload into one actionable message.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - parsed JSON body, when it parsed.
 * @returns {{ code: string, message: string, retryable: boolean }} classification.
 */
export function describeApiFailure(status, payload) {
  const apiMessage = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
    ? redact(payload.error.message).trim()
    : '';
  const detail = apiMessage === '' ? '' : `: ${apiMessage}`;

  if (status === 401 || status === 403) {
    return {
      code: 'AGNES_UNAUTHORIZED',
      message: `Agnes rejected the API key (HTTP ${status}${detail}). Set AGNES_API_KEY for the Harness process, or the plugin's apiKey config, then start a new session.`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: 'AGNES_RATE_LIMITED',
      message: `Agnes is rate limiting this key (HTTP 429${detail}). Wait a few seconds and retry with fewer parallel calls.`,
      retryable: true,
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return {
      code: 'AGNES_BAD_REQUEST',
      message: `Agnes rejected the request (HTTP ${status}${detail}). Check the prompt, size tier, ratio, and reference images; the endpoint accepts no seed, negative prompt, or n > 1.`,
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      code: 'AGNES_SERVER_ERROR',
      message: `Agnes returned a server error (HTTP ${status}${detail}). This is usually transient; retry once.`,
      retryable: true,
    };
  }
  return {
    code: 'AGNES_HTTP_ERROR',
    message: `Agnes returned HTTP ${status}${detail}.`,
    retryable: status >= 500,
  };
}

/**
 * Remove a bearer token from text that may end up in a tool result.
 * @param {string} text - arbitrary text.
 * @returns {string} the same text with any Bearer credential masked.
 */
export function redact(text) {
  return String(text).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
}

/**
 * POST one generation request.
 * @param {{
 *   endpoint: string,
 *   apiKey: string,
 *   body: Record<string, unknown>,
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   fetchImpl?: typeof fetch,
 * }} input - request inputs.
 * @returns {Promise<{ url?: string, b64?: string, taskId?: string, created?: number, revisedPrompt?: string }>}
 *   the first image entry of the response.
 */
export async function requestGeneration({ endpoint, apiKey, body, signal, timeoutMs, fetchImpl = fetch }) {
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
    timeoutMessage: `Agnes did not answer within ${Math.round(timeoutMs / 1000)}s. Generation normally takes 11-60s; retry, or lower the size tier.`,
    fetchImpl,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const failure = describeApiFailure(response.status, payload);
    throw new AgnesApiError(failure.message, {
      status: response.status,
      code: failure.code,
      retryable: failure.retryable,
    });
  }

  const entry = isRecord(payload) && Array.isArray(payload.data) ? payload.data[0] : undefined;
  if (!isRecord(entry)) {
    throw new AgnesApiError('Agnes answered without an image entry in `data`. The request may have been accepted but produced nothing; retry once.', {
      code: 'AGNES_EMPTY_RESPONSE',
      retryable: true,
    });
  }

  const url = typeof entry.url === 'string' && entry.url !== '' ? entry.url : undefined;
  const b64 = typeof entry.b64_json === 'string' && entry.b64_json !== '' ? entry.b64_json : undefined;
  if (url === undefined && b64 === undefined) {
    throw new AgnesApiError('Agnes returned neither `url` nor `b64_json` for the generated image.', {
      code: 'AGNES_EMPTY_RESPONSE',
      retryable: true,
    });
  }

  return {
    ...(url === undefined ? {} : { url }),
    ...(b64 === undefined ? {} : { b64 }),
    ...(typeof payload.task_id === 'string' ? { taskId: payload.task_id } : {}),
    ...(typeof payload.created === 'number' ? { created: payload.created } : {}),
    ...(typeof entry.revised_prompt === 'string' ? { revisedPrompt: entry.revised_prompt } : {}),
  };
}

/**
 * Materialize the generated image bytes from a URL answer or a base64 answer.
 * URLs are temporary direct links, so this runs immediately after generation.
 * @param {{
 *   source: { url?: string, b64?: string },
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   maxBytes: number,
 *   fetchImpl?: typeof fetch,
 * }} input - download inputs.
 * @returns {Promise<{ bytes: Uint8Array, mediaType: string | undefined, origin: 'url' | 'base64' }>}
 *   the encoded image and its declared media type.
 */
export async function readGeneratedImage({ source, signal, timeoutMs, maxBytes, fetchImpl = fetch }) {
  if (source.b64 !== undefined) {
    const bytes = Buffer.from(source.b64, 'base64');
    if (bytes.byteLength === 0) {
      throw new AgnesApiError('Agnes returned an empty base64 payload.', { code: 'AGNES_EMPTY_IMAGE', retryable: true });
    }
    if (bytes.byteLength > maxBytes) {
      throw new AgnesApiError(`The generated image is ${bytes.byteLength} bytes, above the ${maxBytes} byte limit. Lower the size tier.`, {
        code: 'AGNES_IMAGE_TOO_LARGE',
        retryable: false,
      });
    }
    return { bytes, mediaType: undefined, origin: 'base64' };
  }

  if (source.url === undefined) {
    throw new AgnesApiError('Agnes returned no downloadable image reference.', { code: 'AGNES_EMPTY_RESPONSE', retryable: true });
  }

  const response = await fetchWithDeadline(source.url, { method: 'GET', headers: { accept: 'image/*' } }, {
    signal,
    timeoutMs,
    timeoutMessage: `Downloading the generated image timed out after ${Math.round(timeoutMs / 1000)}s. The temporary URL expires quickly, so generate again rather than retrying the download.`,
    fetchImpl,
  });

  if (!response.ok) {
    throw new AgnesApiError(`Downloading the generated image failed (HTTP ${response.status}). The Agnes URL is temporary and may already have expired; generate again.`, {
      status: response.status,
      code: 'AGNES_DOWNLOAD_FAILED',
      retryable: true,
    });
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AgnesApiError(`The generated image is ${declaredLength} bytes, above the ${maxBytes} byte limit. Lower the size tier.`, {
      code: 'AGNES_IMAGE_TOO_LARGE',
      retryable: false,
    });
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new AgnesApiError('The generated image download was empty.', { code: 'AGNES_EMPTY_IMAGE', retryable: true });
  }
  if (bytes.byteLength > maxBytes) {
    throw new AgnesApiError(`The generated image is ${bytes.byteLength} bytes, above the ${maxBytes} byte limit. Lower the size tier.`, {
      code: 'AGNES_IMAGE_TOO_LARGE',
      retryable: false,
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return {
    bytes,
    mediaType: mediaType.startsWith('image/') ? mediaType : undefined,
    origin: 'url',
  };
}

/**
 * Fetch with a deadline and caller cancellation folded into one signal.
 * @param {string} target - URL.
 * @param {RequestInit} init - fetch options without `signal`.
 * @param {{ signal?: AbortSignal, timeoutMs: number, timeoutMessage: string, fetchImpl: typeof fetch }} options
 *   - deadline and transport.
 * @returns {Promise<Response>} the response, before body consumption.
 */
async function fetchWithDeadline(target, init, { signal, timeoutMs, timeoutMessage, fetchImpl }) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new AgnesApiError(timeoutMessage, { code: 'AGNES_TIMEOUT', retryable: true }));
  }, timeoutMs);
  timer.unref?.();

  try {
    return await fetchImpl(target, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof Error) throw reason;
      throw new AgnesApiError('The Agnes request was cancelled.', { code: 'AGNES_ABORTED' });
    }
    throw new AgnesApiError(`Could not reach the Agnes API: ${redact(error instanceof Error ? error.message : String(error))}`, {
      code: 'AGNES_NETWORK',
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
