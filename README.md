# dsh-plugin-agnes-image

给 DeepSeek Harness（DSH）桌面端的 Agent 加两个生图工具，后端是 **Agnes Image 2.5 Flash**：

| 工具 | 用途 |
|---|---|
| `agnes_text2img` | 文生图：一句提示词出一张 PNG，落到工作目录 |
| `agnes_img2img` | 图生图 / 多参考图合成：1–6 张参考图（本地路径、公共 HTTPS URL、`data:` URI 都行） |

模型拿到的是「文件路径 + 像素尺寸 + 字节数」，想在图里看就用内置 `read_image`，想当交付物就用 `present`——不占额外上下文。

> **非官方插件。** 本项目只是社区对 Agnes 生图 HTTP 接口的封装，与 Agnes 官方无隶属关系。
> 运行环境需要带 `tools` 服务与 `read_image` 工具的 DSH 桌面端。

> English: [README.en.md](README.en.md)

## 它做什么

- 调 `POST https://apihub.agnes-ai.com/v1/images/generations`，把结果**下载并保存**成 PNG（URL 是临时直链，不落盘会过期）。
- 自动读 PNG/JPEG/WebP 头拿真实宽高，不靠猜。
- 同名文件不覆盖：`art.png` 已存在就写 `art-2.png`。
- 尺寸档位 `1K/2K/3K/4K` × 比例 `1:1 / 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2 / 21:9`，与官方实测尺寸一致（16:9 的 2K 是 2624×1472，不是 1920×1080）。
- 失败信息直接给可执行的下一步：401 提示去配 `AGNES_API_KEY`，429 提示降并发，400 提示别传 seed / negative_prompt / n>1，超时提示降档位。
- 引擎不支持的参数**根本不出现在工具 schema 里**，避免模型白试一轮。

## 安装

### 桌面端插件页（推荐）

设置 → 插件 → 添加插件，粘贴仓库地址：

```
https://github.com/neil-ji/dsh-plugin-agnes-image
```

### 本地目录（开发时）

```bash
# 在 DSH 里让 Agent 执行，或直接用 plugin_manager
plugin_manager install_bundle "F:\path\to\dsh-plugin-agnes-image"
```

装完是 profile 级插件，对所有会话生效；新增工具在下一轮对话即可见。

## 配置 API Key

插件本身**不含任何密钥**。二选一：

1. 环境变量（推荐）：给 Harness 进程设置 `AGNES_API_KEY`，重启 Harness。
2. 插件配置：在 profile 的 `cordis.patch.yml` 里给 `agnes-image` 行加 `apiKey: sk-...`；**不要提交到公开仓库**。

没配 key 时工具不会发请求，而是返回一条明确的报错：`No Agnes API key is configured.`

## 配置项

配置写在 bundle 的 `cordis.patch.yml`（安装后可用 profile patch 覆盖）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | `""` | 显式密钥，优先级最高；不要提交 |
| `apiKeyEnv` | `AGNES_API_KEY` | 读哪个环境变量 |
| `endpoint` | `https://apihub.agnes-ai.com/v1/images/generations` | 生成端点 |
| `model` | `agnes-image-2.5-flash` | 模型名 |
| `defaultSize` | `2K` | 未传 `size` 时的档位 |
| `defaultRatio` | `1:1` | 未传 `ratio` 时的比例 |
| `outputDir` | `agnes-output` | 默认输出目录，相对会话工作目录 |
| `maxReferenceImages` | `6` | 参考图上限 |
| `timeoutMs` | `240000` | 生成请求超时 |
| `downloadTimeoutMs` | `120000` | 下载成图超时 |
| `maxInputBytes` | `16 MiB` | 单张参考图上限 |
| `maxOutputBytes` | `64 MiB` | 单张成图上限 |

## 工具参数

两个工具共享：`prompt`（必填）、`size`、`ratio`、`path`（可选输出路径；相对路径按会话工作目录解析，以 `/` 结尾表示「放进这个目录、用默认文件名」）。

`agnes_img2img` 额外要求 `images`：字符串数组，每项可以是

- 本地图片路径（PNG / JPEG / GIF / WebP，自动转 `data:` URI）；
- 公共 HTTPS URL（原样交给 Agnes 抓取）；
- `data:image/png;base64,...`。

参考图 1 对结果影响最大；多图适合「角色 + 产品」，不适合当姿势控制——姿势请写进提示词。

## 典型用法

```text
# 文生图
帮我生成一张 2K、16:9 的赛博朋克街景，霓虹灯、雨后反光

# 图生图
把 C:\work\hero.png 里的角色改成挥剑动作，保持角色和构图，2K 16:9

# 多图合成
把角色图和产品图合成一张电商海报，背景浅灰
```

Agent 内部就是调用：

```json
{
  "prompt": "seamless stone floor texture, top-down, even light",
  "size": "2K",
  "ratio": "1:1"
}
```

## 引擎限制（照抄实测文档，别让模型白试）

- **没有 seed**：同提示词每次都不同，不可复现。
- **一次一张**：`n` 只能是 1，批量请多次调用（3 并发实测没问题）。
- **没有 negative prompt / steps / guidance_scale**：传了会 400。
- **没有透明通道**：输出 PNG 是 RGB，背景是模型画出来的近白，要透明得后期抠图。
- **`response_format` 必须放 `extra_body`**，参考图必须放 `extra_body.image` 且是数组——插件已经处理，手写脚本时要注意。
- 输出 URL 是临时直链，插件拿到即下载。
- 4K 与部分比例组合官方未实测；失败时降档位重试。

## 开发

无构建步骤，纯 ESM + Node 内置能力（`fetch`、`node:fs/promises`）。

```bash
npm test     # 28 个用例：请求体形状、错误映射、超时/取消、编码、落盘、路径
```

测试用本地 mock HTTP 服务模拟 Agnes 端点与图片下载，不需要 key、不联网。

目录：

```
index.js              插件入口：校验配置、注册工具
lib/agnes-api.js      请求构造、HTTP、错误映射、下载
lib/agnes-files.js    格式识别、宽高解析、路径与文件写入
lib/agnes-tools.js    两个工具的定义与共享执行器
lib/config.js         配置规范化
locale/{en,zh}.json   插件页显示名与描述
```

## 隐私与安全

- 代码里没有任何密钥；文档和示例也不含密钥。
- 密钥只从配置/环境变量读取，不进日志、不进错误信息（`Bearer ...` 会打码）。
- 只在用户调用工具时联网：一次生成请求 + 一次成图下载。
- 生成文件写到会话工作目录（默认 `agnes-output/`），不碰系统目录。

## License

MIT © 2026 Neil Ji

Agnes 的生图能力与接口归 Agnes 官方所有；本项目只是调用封装，未包含其代码或模型。
