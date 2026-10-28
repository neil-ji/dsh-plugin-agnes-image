/**
 * dsh-plugin-agnes-image — image generation tools for the DSH agent.
 *
 * Host half: validate the plugin row once, register two global tools, and give
 * the tools a key resolver bound to the DSH credential seam. The credential is
 * re-read per call (`ctx.credentials.resolve`), matching how the built-in LLM
 * providers resolve their API keys, so a key saved in Settings → Agnes 生图 is
 * live on the next tool call without a restart.
 *
 * Browser half: `client.js` contributes the Settings section that writes that
 * credential; it never reads a stored value back.
 */

import { resolveAgnesKey } from './lib/agnes-key.js';
import { createToolDefinitions } from './lib/agnes-tools.js';
import { resolveConfig } from './lib/config.js';

/** Stable Loader identity used by cordis.patch.yml. */
export const name = 'agnes-image';

/** The tools registry must exist before this plugin can register its tools. */
export const inject = ['tools'];

/**
 * Register the Agnes tools for every agent in this profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - the Loader row's config value.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const definitions = createToolDefinitions({
    config: resolved,
    resolveCwd: (exec) => resolveCwd(ctx, exec),
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials');
      const lookup = await resolveAgnesKey({
        config: resolved,
        ...(credentials === undefined ? {} : { credentials }),
      });
      return lookup.key;
    },
  });

  for (const definition of definitions) ctx.tools.register(definition);

  ctx.logger?.debug?.(
    `agnes-image: registered ${definitions.map((definition) => definition.name).join(', ')} `
    + `(model ${resolved.model}, output ${resolved.outputDir}, credential ${resolved.credentialRef})`,
  );
}

/**
 * Resolve the directory generated files belong in.
 *
 * The session's working directory is the anchor for relative output paths, so
 * an agent that switched directories writes where the user is looking. The
 * `workingDirectory` service is optional here: a profile without it still gets
 * a usable plugin instead of an activation failure.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ agent?: unknown, signal?: AbortSignal }} exec - the tool execution.
 * @returns {Promise<string>} an absolute directory.
 */
async function resolveCwd(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory');
  if (workingDirectory === undefined) return process.cwd();
  if (exec.agent === undefined) return workingDirectory.defaultDirectory ?? process.cwd();
  return workingDirectory.ensure(exec.agent, exec.signal);
}
