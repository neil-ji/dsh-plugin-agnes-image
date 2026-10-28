# dsh-plugin-agnes-image

给 DeepSeek Harness（DSH）桌面端的 Agent 加一组 Agnes 生成工具：**文生图、图生图、文生视频**，后端是 **Agnes Image / Video 2.5 Flash**。

| 工具 | 用途 |
|---|---|
| `agnes_text2img` | 文生图：一句提示词出一张 PNG，落到工作目录 |
| `agnes_img2img` | 图生图 / 多参考图合成：1–6 张参考图（本地路径、公共 HTTPS URL、`data:` URI 都行） |
| `agnes_video` | 文生视频 / 首尾帧 / 参考素材：4–12 秒、720P，自动轮询并下载 MP4 |
| `agnes_video_status` | 继续等待或查询视频任务，完成后下载 MP4 |

API Key 在 **设置 → Agnes 生图** 里粘贴，走 DSH 内置凭据库（和内置模型 Provider 的 Key 同一套机制），只写不回显；图片与视频共用同一个 Key。

模型拿到的是「文件路径 + 尺寸/时长 + 字节数」，看图用内置 `read_image`，交付用 `present`——不占额外上下文。

> **非官方插件。** 本项目只是社区对 Agnes 生成接口的封装，与 Agnes 官方无隶属关系。
> 运行环境需要带 `tools` 服务、`read_image` 工具和凭据服务的 DSH 桌面端。

> English: [README.en.md](README.en.md)

## 图片能力

- 调 `POST /v1/images/generations`，把结果**下载并保存**成 PNG（URL 是临时直链，不落盘会过期）。
- 自动读 PNG/JPEG/WebP 头拿真实宽高，不靠猜。
- 同名文件不覆盖：`art.png` 已存在就写 `art-2.png`。
- 尺寸档位 `1K/2K/3K/4K` × 比例 `1:1 / 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2 / 21:9`（16:9 的 2K 是 2624×1472，不是 1920×1080）。
- 引擎不支持的参数（seed / negative_prompt / steps / n>1）**根本不出现在工具 schema 里**。

## 视频能力

Agnes 视频是**异步任务**：先创建，再按 `video_id` 轮询，完成后从 `url` 下载。

- 模型 `agnes-video-2.5-flash`，分辨率固定 **720P**，时长 `"4"`–`"12"` 秒，`n` 固定 1。
- 三种模式：
  - `text`：只给提示词；
  - `keyframe`：`first_frame` / `last_frame`（至少一个）控制首尾构图；
  - `reference`：最多 5 张参考图 + 3 段参考音频，提示词里用 `<Picture 1>`、`<Audio 1>` 指代。
- **参考素材必须是公共 HTTPS URL**：Agnes 自己去抓，所以本地文件、`data:` URI 都用不了；Flash 也**不支持参考视频**。
- 工具默认等最多 3 分钟；没跑完就返回 `pending` + `videoId`，再调 `agnes_video_status` 继续等或下载。也可以 `wait: false` 立即拿 `videoId`。
- 完成后下载 MP4 并在文件头校验（`ftyp`），不是视频就不落盘；同名不覆盖。

画幅（720P）：

| ratio | 像素 |
|---|---|
| 21:9 | 1680×720 |
| 16:9 | 1280×704 |
| 4:3 | 960×720 |
| 1:1 | 720×720 |
| 3:4 | 720×960 |
| 9:16 | 720×1280 |

计费：官方当前限时 **$0/秒**（720P），价格随时可能变。

## 安装

### 桌面端插件页（推荐）

设置 → 插件 → 添加插件，粘贴仓库地址：

```
https://github.com/neil-ji/dsh-plugin-agnes-image
```

### 本地目录（开发时）

```bash
plugin_manager install_bundle "F:\path\to\dsh-plugin-agnes-image"
```

## 配置 API Key：设置 → Agnes 生图

1. 打开 **设置 → Agnes 生图**。
2. 粘贴 API Key，点**保存**（密码框，可临时点「显示」核对）。
3. 状态点变绿；下一次生图/生视频立即生效，无需重启。

安全与存储：

- Key 写入 **本机 DSH 凭据库**（`~/.dsh/.credentials.yaml` 的 `AGNES_API_KEY` 引用）。
- 界面**只写不读**：只回传「是否配置 / 是否可写」等脱敏事实，已存的 Key 不会读回浏览器。
- 不会出现在插件配置、`cordis.patch.yml`、仓库、会话记录或工具结果里。
- 解析优先级：`apiKey` 配置（仅 CI）→ 凭据库 → 同名环境变量。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `credentialRef` | `AGNES_API_KEY` | 凭据引用名 |
| `apiKey` | `""` | 显式密钥，优先级最高；不要提交 |
| `endpoint` | `.../v1/images/generations` | 图片端点 |
| `model` | `agnes-image-2.5-flash` | 图片模型 |
| `defaultSize` / `defaultRatio` | `2K` / `1:1` | 图片默认档位与比例 |
| `outputDir` | `agnes-output` | 输出目录（相对会话工作目录） |
| `maxReferenceImages` | `6` | 图生图参考图上限 |
| `timeoutMs` / `downloadTimeoutMs` | `240000` / `120000` | 单次 HTTP 超时 |
| `maxInputBytes` / `maxOutputBytes` | `16 MiB` / `64 MiB` | 输入 / 输出图片上限 |
| `videoEndpoint` | `.../v1/videos` | 视频创建端点 |
| `videoQueryEndpoint` | `.../agnesapi` | 视频查询端点 |
| `videoModel` | `agnes-video-2.5-flash` | 视频模型 |
| `videoDefaultSeconds` | `"5"` | 默认时长 |
| `videoDefaultAspectRatio` | `16:9` | 默认画幅 |
| `videoPollIntervalMs` | `2000` | 轮询间隔 |
| `videoWaitMs` | `180000` | 单次工具调用最多等待 |
| `videoDownloadTimeoutMs` | `120000` | 视频下载超时 |
| `maxVideoBytes` | `256 MiB` | 单个视频上限 |

## 典型用法

```text
# 文生图
生成一张 2K、16:9 的赛博朋克街景，霓虹灯、雨后反光

# 图生图
把 C:\work\hero.png 里的角色改成挥剑动作，保持角色和构图，2K 16:9

# 文生视频
生成 6 秒、16:9 的视频：雨后的未来城市街道，霓虹倒映，银色跑车缓慢驶过，低机位跟拍，自然环境声

# 首尾帧视频（图片需公共 URL）
用这两张图做首尾帧，5 秒、16:9，人物自然转身走向窗边
```

## 引擎限制

**图片**

- 没有 seed：同提示词每次都不同，不可复现。
- 一次一张；没有 negative prompt / steps / guidance_scale；输出无 alpha。
- `response_format` 必须放 `extra_body`，参考图必须放 `extra_body.image`（插件已处理）。

**视频**

- Flash 只有 720P；`size` 传别的值直接 400。
- 时长 4–12 秒；`n` 只能 1；参考视频不支持（400 `videos is not supported`）。
- 参考图 ≤5、参考音频 ≤3；素材必须是公共可访问 URL。
- 任务状态以 `status` 与 `url` 为准，`internal_status` 不可用于判断完成。
- 超过 `videoWaitMs` 会返回 pending，不影响任务继续跑；`videoId` 可用于后续查询。
- 创建任务返回 `503 video queue is full` 表示 Agnes 视频队列已满（不是参数错误），等一分钟重试即可。

## 开发

无构建步骤，纯 ESM + Node 内置能力；浏览器半边是 loader 包装的片段，只 `require('react')`。

```bash
npm test   # 60 个用例：图片请求/错误/落盘、密钥优先级、设置页、视频任务/轮询/下载/校验
```

测试用本地 mock HTTP 服务模拟两端点与文件下载，不需要 key、不联网。

目录：

```
index.js               插件入口：配置、注册图片与视频工具、绑定凭据解析
client.js              设置页（settings.section）：Key 的保存 / 移除 / 状态
lib/agnes-api.js       图片请求构造、HTTP、错误映射、下载
lib/agnes-video-api.js 视频创建、查询、下载与错误映射
lib/agnes-files.js     图片/视频识别、宽高、路径与安全写入
lib/agnes-key.js       凭据解析（配置 → 凭据库 → 环境变量）
lib/agnes-tools.js     图片工具定义与执行器
lib/video-tools.js     视频工具定义、轮询与下载
lib/config.js          配置规范化
locale/{en,zh}.json    插件页显示名与描述
```

## 隐私与安全

- 代码、文档、示例里没有任何密钥；设置页只把 Key 写进本机凭据库。
- 已存的 Key 不回显、不进日志、不进错误信息（`Bearer ...` 会打码）。
- 每次调用重新解析凭据，轮换 Key 不需要重启。
- 联网只发生在工具调用时：一次请求（图片）或创建 + 轮询 + 下载（视频）。
- 生成文件写到会话工作目录（默认 `agnes-output/`）。

## License

MIT © 2026 Neil Ji

Agnes 的生成能力与接口归 Agnes 官方所有，本项目只是调用封装，未包含其代码或模型。
