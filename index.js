/**
 * dsh-plugin-agnes-image — image generation tools for the DSH agent.
 *
 * The plugin is deliberately tiny on the Host side: it validates its row's
 * config once, registers two global tools, and lets the tools service own
 * visibility, argument validation, timeouts, and result materialization.
 *
 * Why plain JavaScript without a build step: the whole surface is Node's
 * `fetch`, `node:fs/promises`, and raw JSON-Schema tool definitions, so a
 * linked checkout runs exactly the files that are published.
 */

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
  });

  for (const definition of definitions) ctx.tools.register(definition);

  ctx.logger?.debug?.(
    `agnes-image: registered ${definitions.map((definition) => definition.name).join(', ')} `
    + `(model ${resolved.model}, output ${resolved.outputDir})`,
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
