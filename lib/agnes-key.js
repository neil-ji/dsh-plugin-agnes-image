/**
 * API-key resolution, following the built-in provider mechanism.
 *
 * A provider resolves its key through `ctx.credentials.resolve(ref)` on every
 * operation. That seam reads the provider-managed store first (the same store
 * the Models settings page writes through `credentials.set`) and then ambient
 * fallbacks such as the process environment, so a key saved in Settings takes
 * effect on the next tool call without restarting the Harness.
 *
 * Precedence used here, highest first:
 *   1. an explicit `apiKey` in the plugin row (automation and CI only),
 *   2. the DSH credential store / environment behind `credentialRef`,
 *   3. the process environment read directly (when no credentials service is
 *      composed in this deployment).
 *
 * The value is returned to the caller only; nothing here logs it or puts it in
 * a tool result.
 */

/**
 * Resolve the key one generation should use.
 * @param {{
 *   config: { apiKey: string, credentialRef: string },
 *   credentials?: { resolve: (ref: string) => Promise<{ value: string, source?: string } | undefined> },
 *   env?: NodeJS.ProcessEnv,
 * }} input - normalized config, the optional credential seam, and an environment.
 * @returns {Promise<{ key: string, source: 'config' | 'credential' | 'env' | 'missing' }>}
 *   the trimmed key and where it came from; never throws for an absent seam.
 */
export async function resolveAgnesKey({ config, credentials, env = process.env }) {
  const explicit = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (explicit !== '') return { key: explicit, source: 'config' };

  const ref = config.credentialRef;

  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref);
      const value = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
      if (value !== '') return { key: value, source: 'credential' };
    } catch {
      // A broken or absent store must fall through to the ambient layer rather
      // than fail the tool call before it starts.
    }
  }

  const ambient = typeof env?.[ref] === 'string' ? env[ref].trim() : '';
  if (ambient !== '') return { key: ambient, source: 'env' };

  return { key: '', source: 'missing' };
}

/**
 * The message shown when no key is configured anywhere.
 * @param {string} credentialRef - the reference the Settings page writes.
 * @returns {string} actionable text naming the UI entry and the fallback.
 */
export function missingKeyMessage(credentialRef) {
  return [
    'No Agnes API key is configured.',
    'Open Settings → Agnes 生图 and save a key there (it is stored in the DSH credential store),',
    `or set the ${credentialRef} environment variable for the Harness process.`,
    'Refusing to call the API without a key.',
  ].join(' ');
}
