# dsh-plugin-agnes-image

Image generation tools for the DeepSeek Harness (DSH) desktop agent, backed by **Agnes Image 2.5 Flash**.

| Tool | Purpose |
|---|---|
| `agnes_text2img` | Text-to-image: one prompt, one PNG saved into the session working directory |
| `agnes_img2img` | Image-to-image / multi-reference composition: 1-6 references as local paths, public HTTPS URLs, or `data:` URIs |

The model receives a path, pixel size, and byte size — never a base64 blob. Call the built-in `read_image` with that path to show it in chat, or `present` to deliver it as a file.

> 中文: [README.md](README.md)

## What it does

- Calls `POST https://apihub.agnes-ai.com/v1/images/generations` and **downloads** the result immediately, because the returned URL is a temporary direct link.
- Reads the real PNG/JPEG/WebP header for dimensions instead of guessing.
- Never overwrites: an existing `art.png` makes the next file `art-2.png`.
- Size tiers `1K/2K/3K/4K` x ratios `1:1 / 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2 / 21:9`, matching the documented native sizes (2K at 16:9 is 2624x1472, not 1920x1080).
- Failures carry the next step: 401 points at `AGNES_API_KEY`, 429 says to lower concurrency, 400 says the engine takes no seed, negative prompt, or `n > 1`.
- Parameters the engine rejects are absent from the tool schema, so the model cannot waste a call on them.

## Install

From the desktop app: **Settings → Plugins → Add plugin**, paste:

```
https://github.com/neil-ji/dsh-plugin-agnes-image
```

Or install a local checkout through `plugin_manager install_bundle "<path-to-checkout>"`.

## API key

No key ships with this repository. Either:

1. Set `AGNES_API_KEY` in the Harness process environment and restart it.
2. Add `apiKey: sk-...` to the `agnes-image` row in the profile's `cordis.patch.yml`.

Without a key the tool refuses to send anything and says exactly that.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `""` | Explicit key, highest priority; never commit it |
| `apiKeyEnv` | `AGNES_API_KEY` | Environment variable to read |
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

No build step; plain ESM on Node built-ins.

```bash
npm test   # 28 cases: request shape, error mapping, deadlines/cancellation, encoding, saving, paths
```

Tests run against a local mock HTTP server, so they need neither a key nor network access.

## Privacy

- No secrets in code, docs, or examples.
- The key is read from config/environment and never logged; `Bearer ...` is redacted in errors.
- Network traffic happens only on a tool call: one generation request and one image download.
- Generated files land in the session working directory (default `agnes-output/`).

## License

MIT © 2026 Neil Ji. The Agnes API and model belong to their owners; this repository only wraps the HTTP endpoint.
