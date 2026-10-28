# dsh-plugin-agnes-image

Image generation tools for the DeepSeek Harness (DSH) desktop agent, backed by **Agnes Image 2.5 Flash**.

| Tool | Purpose |
|---|---|
| `agnes_text2img` | Text-to-image: one prompt, one PNG saved into the session working directory |
| `agnes_img2img` | Image-to-image / multi-reference composition: 1-6 references as local paths, public HTTPS URLs, or `data:` URIs |

The API key no longer needs an environment variable: paste it in **Settings → Agnes Image**. It goes into the DSH credential store — the same seam the built-in model providers use — is write-only, and takes effect on the next generation.

The model receives a path, pixel size, and byte size — never a base64 blob. Call the built-in `read_image` with that path to show it in chat, or `present` to deliver it as a file.

> **Unofficial plugin.** This is a community wrapper around the Agnes image HTTP API and is not affiliated with Agnes.
> It requires a DSH desktop build with the `tools` service, the `read_image` tool, and the credential service.

> 中文: [README.md](README.md)

## What it does

- Calls `POST https://apihub.agnes-ai.com/v1/images/generations` and **downloads** the result immediately, because the returned URL is a temporary direct link.
- Reads the real PNG/JPEG/WebP header for dimensions instead of guessing.
- Never overwrites: an existing `art.png` makes the next file `art-2.png`.
- Size tiers `1K/2K/3K/4K` x ratios `1:1 / 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2 / 21:9`, matching the documented native sizes (2K at 16:9 is 2624x1472, not 1920x1080).
- Failures carry the next step: 401 points at the Settings page, 429 says to lower concurrency, 400 says the engine takes no seed, negative prompt, or `n > 1`.
- Parameters the engine rejects are absent from the tool schema, so the model cannot waste a call on them.
- The Settings page shows credential state (configured / missing / source), saves a key, toggles visibility, and removes it with a two-step confirmation.

## Install

From the desktop app: **Settings → Plugins → Add plugin**, paste:

```
https://github.com/neil-ji/dsh-plugin-agnes-image
```

Or install a local checkout through `plugin_manager install_bundle "<path-to-checkout>"`.

## Configure the key: Settings → Agnes Image

1. Open **Settings → Agnes Image**.
2. Paste the API key and click **Save** (the field is masked; **Show** reveals the draft).
3. The status dot turns green and reads *Configured*. **The next generation uses it — no restart.**

Security and storage:

- The key is written to the **local DSH credential store** (`~/.dsh/.credentials.yaml`, reference `AGNES_API_KEY`), the same mechanism the built-in model providers use.
- The UI is **write-only**: the credential service returns redacted facts only (configured / source / writable), so a stored key is never read back into the browser and the input always starts empty.
- It never appears in plugin configuration, `cordis.patch.yml`, the repository, the session log, or a tool result.
- Resolution order: an explicit `apiKey` in the plugin row (unattended deployments only) → the credential store → the environment variable with the same name.
  **The environment variable still works**; it is simply no longer the only entry point.
- Removal: click **Remove**, then **Confirm removal**; an unconfirmed click resets after five seconds.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `credentialRef` | `AGNES_API_KEY` | Credential reference: the Settings page writes it, every generation reads it |
| `apiKey` | `""` | Explicit key, highest priority; CI and unattended deployments only — never commit it |
| `endpoint` | `https://apihub.agnes-ai.com/v1/images/generations` | Generation endpoint |
| `model` | `agnes-image-2.5-flash` | Model name |
| `defaultSize` | `2K` | Tier used when `size` is omitted |
| `defaultRatio` | `1:1` | Ratio used when `ratio` is omitted |
| `outputDir` | `agnes-output` | Default output directory, relative to the session cwd |
| `maxReferenceImages` | `6` | Reference image cap |
| `timeoutMs` | `240000` | Generation request timeout |
| `downloadTimeoutMs` | `120000` | Image download timeout |
| `maxInputBytes` | `16 MiB` | Per-reference image limit |
| `maxOutputBytes` | `64 MiB` | Per-output image limit |

## Tool arguments

Shared: `prompt` (required), `size`, `ratio`, `path` (optional output path, resolved against the session cwd; a trailing separator means "use the default name inside this directory").

`agnes_img2img` also requires `images`: an array of local image paths (PNG/JPEG/GIF/WebP, converted to data URIs), public HTTPS URLs, or `data:image/...;base64,...` URIs. Reference 1 dominates the result; multi-image composition suits subject + product, not pose control — describe poses in the prompt.

## Engine limits

- No seed: the same prompt never reproduces the same image.
- One image per call; `n` must be 1. Call again for more (3 concurrent calls are fine).
- No negative prompt, steps, or guidance scale — those return 400.
- No alpha channel: output is RGB PNG, so transparency needs post-processing.
- `response_format` belongs in `extra_body`; reference images belong in `extra_body.image` as an array.
- 4K and some ratio combinations are not officially verified; lower the tier on failure.

## Development

No build step; plain ESM on Node built-ins. The browser half is a loader fragment that only requires `react`.

```bash
npm test   # 41 cases: request shape, key resolution, error mapping, deadlines, saving, paths (Windows drive letters included), settings page
```

The Host tests run against a local mock endpoint; the client test evaluates the real fragment with a stub React and a fake credential seam. Neither needs network access or a key.

```
index.js              plugin entry: config, tools, credential resolver wiring
client.js             Settings page (settings.section): save / remove / status
lib/agnes-api.js      request body, HTTP, error mapping, download
lib/agnes-files.js    format sniffing, dimensions, paths, safe writes
lib/agnes-key.js      key resolution (config -> credential store -> environment)
lib/agnes-tools.js    the two tool definitions and shared executor
lib/config.js         config normalization
```

## Privacy

- No secrets in code, docs, or examples; the Settings page only writes to the local credential store.
- A stored key is never echoed, logged, or placed in an error message (`Bearer ...` is redacted).
- The key is re-resolved on every call, so rotating it needs no restart and never uses a stale value.
- Network traffic happens only on a tool call: one generation request and one image download.
- Generated files land in the session working directory (default `agnes-output/`).

## License

MIT © 2026 Neil Ji. The Agnes API and model belong to their owners; this repository only wraps the HTTP endpoint.
