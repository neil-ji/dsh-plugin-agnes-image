# dsh-plugin-agnes-image

Generation tools for the DeepSeek Harness (DSH) desktop agent: **text-to-image, image-to-image, and text-to-video**, backed by **Agnes Image / Video 2.5 Flash**.

| Tool | Purpose |
|---|---|
| `agnes_text2img` | Text-to-image: one prompt, one PNG saved into the session working directory |
| `agnes_img2img` | Image-to-image / multi-reference composition: 1-6 references as local paths, public HTTPS URLs, or `data:` URIs |
| `agnes_video` | Text-to-video, keyframe control, or media references: 4-12 s at 720P; polls and downloads the MP4 |
| `agnes_video_status` | Continue waiting for or inspect a video task, downloading the MP4 when it completes |

The API key is pasted in **Settings → Agnes Image** and stored in the DSH credential store — the same seam the built-in model providers use. It is write-only and shared by the image and video tools.

The model receives a path, media facts, and byte size — never a base64 blob. Call the built-in `read_image` to show an image, or `present` to deliver any generated file.

> **Unofficial plugin.** This is a community wrapper around the Agnes HTTP APIs and is not affiliated with Agnes.

> 中文: [README.md](README.md)

## Images

- Calls `POST /v1/images/generations` and **downloads** the result immediately, because the returned URL is a temporary direct link.
- Reads the real PNG/JPEG/WebP header for dimensions instead of guessing.
- Never overwrites: an existing `art.png` makes the next file `art-2.png`.
- Size tiers `1K/2K/3K/4K` x ratios `1:1 / 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2 / 21:9`.
- Parameters the engine rejects (seed, negative prompt, steps, `n > 1`) are absent from the tool schema.

## Video

Agnes video is **asynchronous**: create a task, poll by `video_id`, then download from `url`.

- Model `agnes-video-2.5-flash`, resolution fixed at **720P**, duration `"4"`-`"12"` seconds, `n` fixed at 1.
- Modes:
  - `text`: prompt only;
  - `keyframe`: `first_frame` and/or `last_frame` control the opening and closing composition;
  - `reference`: up to 5 image URLs and 3 audio URLs, referenced in the prompt as `<Picture 1>`, `<Audio 1>`.
- **Reference media must be public HTTPS URLs** — Agnes fetches it itself, so local files and data URIs cannot be used; Flash also rejects reference videos.
- The tool waits up to 3 minutes by default. An unfinished task returns `pending` with a `videoId`; call `agnes_video_status` to continue. `wait: false` returns the id immediately.
- Completed downloads are verified as MP4/WebM by their header before saving, and never overwrite an existing file.

720P frame sizes:

| ratio | pixels |
|---|---|
| 21:9 | 1680x720 |
| 16:9 | 1280x704 |
| 4:3 | 960x720 |
| 1:1 | 720x720 |
| 3:4 | 720x960 |
| 9:16 | 720x1280 |

Pricing: currently **$0/second** for 720P; prices can change.

## Install

From the desktop app: **Settings → Plugins → Add plugin**, paste:

```
https://github.com/neil-ji/dsh-plugin-agnes-image
```

Or install a local checkout through `plugin_manager install_bundle "<path-to-checkout>"`.

## Configure the key: Settings → Agnes Image

1. Open **Settings → Agnes Image**.
2. Paste the API key and click **Save** (the field is masked; **Show** reveals the draft).
3. The status dot turns green. The next image or video generation uses it — no restart.

Security:

- The key is stored in the local **DSH credential store** (`~/.dsh/.credentials.yaml`, reference `AGNES_API_KEY`).
- The UI is **write-only**: only redacted facts come back (configured / writable), so a stored key is never read into the browser.
- It never appears in plugin configuration, `cordis.patch.yml`, the repository, the session log, or a tool result.
- Resolution order: `apiKey` config (CI only) → credential store → environment variable.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `credentialRef` | `AGNES_API_KEY` | Credential reference |
| `apiKey` | `""` | Explicit key, highest priority; never commit |
| `endpoint` | `.../v1/images/generations` | Image endpoint |
| `model` | `agnes-image-2.5-flash` | Image model |
| `defaultSize` / `defaultRatio` | `2K` / `1:1` | Image defaults |
| `outputDir` | `agnes-output` | Output directory, relative to the session cwd |
| `maxReferenceImages` | `6` | img2img reference cap |
| `timeoutMs` / `downloadTimeoutMs` | `240000` / `120000` | Per-request timeouts |
| `maxInputBytes` / `maxOutputBytes` | `16 MiB` / `64 MiB` | Image size limits |
| `videoEndpoint` | `.../v1/videos` | Create-task endpoint |
| `videoQueryEndpoint` | `.../agnesapi` | Status endpoint |
| `videoModel` | `agnes-video-2.5-flash` | Video model |
| `videoDefaultSeconds` | `"5"` | Default duration |
| `videoDefaultAspectRatio` | `16:9` | Default aspect ratio |
| `videoPollIntervalMs` | `2000` | Poll interval |
| `videoWaitMs` | `180000` | Max wait per tool call |
| `videoDownloadTimeoutMs` | `120000` | Download timeout |
| `maxVideoBytes` | `256 MiB` | Per-video limit |

## Engine limits

**Images**

- No seed: the same prompt never reproduces the same image.
- One image per call; no negative prompt, steps, or guidance scale; no alpha channel.

**Video**

- Flash is 720P only; any other `size` returns 400.
- 4-12 seconds; `n` must be 1; reference videos are rejected (`videos is not supported`).
- At most 5 reference images and 3 reference audios, all publicly reachable URLs.
- Judge completion by `status` and `url`; `internal_status` is not authoritative.
- Exceeding `videoWaitMs` returns `pending` without cancelling the task; poll with `agnes_video_status`.

## Development

No build step; plain ESM on Node built-ins. The browser half is a loader fragment that only requires `react`.

```bash
npm test   # 59 cases: image request shape/errors/saving, key resolution, settings page, video task/poll/download/validation
```

The Host tests run against local mock endpoints; the client test evaluates the real fragment with a stub React and a fake credential seam. No network or key required.

```
index.js               plugin entry: config, tool registration, credential resolver
client.js              Settings page (settings.section): save / remove / status
lib/agnes-api.js       image request, HTTP, error mapping, download
lib/agnes-video-api.js video create/query/download and error mapping
lib/agnes-files.js     format sniffing, dimensions, paths, safe writes
lib/agnes-key.js       key resolution (config -> credential store -> environment)
lib/agnes-tools.js     image tool definitions and shared executor
lib/video-tools.js     video tools, polling, download
lib/config.js          config normalization
```

## Privacy

- No secrets in code, docs, or examples; the Settings page only writes to the local credential store.
- A stored key is never echoed, logged, or placed in an error message (`Bearer ...` is redacted).
- The key is re-resolved on every call, so rotating it needs no restart.
- Network traffic happens only on a tool call: one image request, or create + poll + download for video.
- Generated files land in the session working directory (default `agnes-output/`).

## License

MIT © 2026 Neil Ji. The Agnes APIs and models belong to their owners; this repository only wraps the HTTP endpoints.
