**语言：** [English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# deckops CLI

Deckops 是 [Deckflow](https://app.deckflow.com) 的命令行工具，用于上传文件、创建异步任务，以及查看任务状态。

## 环境要求

- Node.js >= 18
- 有效的 Deckflow 账号与 workspace（space）

## 安装

```bash
npm install -g deckops
deckops --help
```

## 快速开始

Deckops 会在命令需要时引导你完成认证和工作区设置。

```bash
deckops convert slides.pptx --to pdf
```

## 全局选项

| 选项 | 说明 |
|------|------|
| `--json` | 以 JSON 格式输出结果（适合脚本集成） |
| `--version` | 显示版本号 |
| `--help` | 显示帮助信息 |

示例：

```bash
# JSON 模式列出任务
deckops --json task list --limit 5

# 查看版本
deckops --version

# 查看某子命令帮助
deckops convert --help
```

## 文件压缩

### `compress <input-file>`

压缩 Office 文档、视频或 zip 文件。根据扩展名自动选择任务类型。

支持格式：`.zip`、`.pptx`、`.key`、`.docx`、`.xlsx`、`.mp4`、`.avi`、`.mov`、`.mkv`

| 选项 | 说明 |
|------|------|
| `-o, --out <path>` | 将任务结果写入文件或目录 |
| `--no-wait` | 创建任务后不等待完成 |
| `--timeout <seconds>` | 等待超时（默认 300 秒） |

```bash
# 压缩 PPT 演示文稿
deckops compress presentation.pptx

# 压缩视频并保存结果
deckops compress demo.mp4 -o ./output/compressed.mp4

# 仅创建任务，不等待完成
deckops compress large.pptx --no-wait
```

## 信息提取

### `extract <input-file>`

从文件中提取字体、文本形状等信息。

| 选项 | 说明 |
|------|------|
| `--type <type>` | 提取类型：`fonts`、`text-shapes` |
| `-o, --out <path>` | 保存结果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 超时秒数 |

```bash
# 从 pptx 自动提取字体信息
deckops extract slides.pptx

# 显式指定提取文本形状
deckops extract slides.pptx --type text-shapes

# 提取并保存到目录
deckops extract slides.pptx --type fonts -o ./extracted/
```

## OCR 文字识别

### `ocr <input-file>`

对图片进行 OCR。支持 `.jpg`、`.jpeg`、`.png`。

| 选项 | 说明 |
|------|------|
| `--language <lang>` | 语言（默认 `zh-hans`） |
| `-o, --out <path>` | 保存结果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 超时秒数 |

支持语言：`zh-hans`、`zh-hant`、`en`、`ja`、`ko`、`ar`、`de`、`es`、`fr`、`it`、`pt`、`ru`

```bash
# 识别中文图片（默认语言）
deckops ocr scan.jpg

# 识别英文图片
deckops ocr document.png --language en

# 识别日文并保存
deckops ocr receipt.jpg --language ja -o ./ocr-result.json
```

## 格式转换

### `convert <input-files...> --to <format>`

将文件转换为指定格式。

| 选项 | 说明 |
|------|------|
| `--to <format>` | 输出格式（必填）：`image`、`pdf`、`video`、`html`、`png`、`pptx`、`webp` |
| `--width <number>` | HTML → PPT/PNG 时的宽度 |
| `--height <number>` | HTML → PPT/PNG 时的高度 |
| `--need-embed-fonts [boolean]` | HTML → PPTX 是否嵌入字体（默认 false） |
| `-o, --out <path>` | 保存结果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 超时秒数 |

**多文件说明**：仅 `html → pptx` 支持多个输入文件，按顺序合并为一个转换任务。

```bash
# PPT 转 PDF
deckops convert slides.pptx --to pdf

# 多个 HTML 合并转 PPTX
deckops convert page1.html page2.html page3.html --to pptx

# HTML 转 PNG，指定尺寸并保存
deckops convert slide.html --to png --width 1920 --height 1080 -o ./slide.png
```

## PPT 合并

### `join <input-files...>`

按给定顺序将多个 `.pptx` 合并为一个（对应任务类型 `pptx.join`）。至少需要 2 个文件。

| 选项 | 说明 |
|------|------|
| `--name <name>` | 任务名称 |
| `-o, --out <path>` | 保存结果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 超时秒数 |

```bash
# 合并三段演示文稿
deckops join intro.pptx body.pptx appendix.pptx

# 指定输出任务名并保存
deckops join part1.pptx part2.pptx --name merged-deck -o ./merged.pptx

# 仅创建任务
deckops join a.pptx b.pptx --no-wait
```

## AI 内容生成

### `create [input-files...]`

根据文本或参考文件生成文档内容（API 任务类型为 `generation`）。

| 选项 | 说明 |
|------|------|
| `--input-text <text>` | 输入文本 |
| `--enable-search [boolean]` | 启用搜索 |
| `--advanced-model [boolean]` | 使用高级模型 |
| `--fast-mode [boolean]` | 快速模式 |
| `--intent <intent>` | 生成意图 |
| `--audience <audience>` | 目标受众 |
| `--page-count <number>` | 预期页数 |
| `--author <name>` | 文档作者 |
| `-o, --out <path>` | 保存结果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 超时秒数 |

参考文件最多 2 个，支持：`.html`、`.pdf`、`.docx`、`.pptx`、`.txt`、`.md`、`.mm`、`.xmind`、`.ipynb`

```bash
# 纯文本生成
deckops create --input-text "请写一份产品发布会方案"

# 带参考文件和页数限制
deckops create outline.md --input-text "扩展为完整演讲稿" --page-count 20

# 高级模型 + 搜索，并保存结果
deckops create brief.pdf --input-text "生成详细报告" --advanced-model --enable-search -o ./report/
```

## 文档翻译

### `translate <input-file>`

翻译文档文件。支持 `.docx`、`.pptx`、`.pdf`、`.xlsx`、`.key`。

| 选项 | 说明 |
|------|------|
| `--from <language>` | 源语言（必填） |
| `--to <language>` | 目标语言（必填） |
| `--model <model>` | 模型（必填）：`Standard` 或 `Pro` |
| `--use-glossary [boolean]` | 使用术语表 |
| `--image-translate [boolean]` | 翻译图片内文字 |
| `-o, --out <path>` | 保存结果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 超时秒数 |

```bash
# 中译英（Standard 模型）
deckops translate handbook.docx --from zh --to en --model Standard

# 英译中，Pro 模型
deckops translate slides.pptx --from en --to zh --model Pro

# 自动检测源语言，启用术语表并保存
deckops translate manual.pdf --from auto --to ja --model Pro --use-glossary -o ./translated.pdf
```

## 通用任务执行

### `run <task-type> <input-files...>`

显式指定任务类型执行，适合高级用法或 CLI 未封装的任务。

| 选项 | 说明 |
|------|------|
| `--param <key=value>` | 任务参数（可多次使用，值支持 JSON） |
| `-o, --out <path>` | 保存结果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 超时秒数 |

**多文件说明**：以下任务类型支持多个输入文件作为有序源集合：`pptx.join`、`convertor.html2pptx`、`html.buildPlayer`、`generation`。

```bash
# PPT 转 PDF（显式任务类型）
deckops run convertor.ppt2pdf demo.ppt

# 合并 PPT
deckops run pptx.join part1.pptx part2.pptx

# HTML 转 PPTX 并传参
deckops run convertor.html2pptx page1.html page2.html --param width=1920 --param needEmbedFonts=true
```

## 任务管理

### `task list`

列出 workspace 中的任务。

| 选项 | 说明 |
|------|------|
| `--type <type>` | 按任务类型过滤 |
| `--limit <n>` | 最大条数（默认 50） |
| `--offset <n>` | 分页偏移（默认 0） |

```bash
# 列出最近 10 条任务
deckops task list --limit 10

# 只看转换类任务
deckops task list --type convertor.ppt2pdf --limit 20

# JSON 分页查询
deckops --json task list --offset 50 --limit 50
```

### `task get <task-id>`

获取单个任务详情。

| 选项 | 说明 |
|------|------|
| `-o, --out <path>` | 下载并保存已完成任务的结果 |

```bash
# 查看任务详情
deckops task get abc123-task-id

# 下载任务结果到文件
deckops task get abc123-task-id -o ./result.pdf

# JSON 模式
deckops --json task get abc123-task-id
```

### `task delete <task-id>`

删除指定任务。

```bash
# 删除任务
deckops task delete abc123-task-id

# JSON 模式
deckops --json task delete abc123-task-id

# 删除后确认列表
deckops task delete abc123-task-id && deckops task list --limit 5
```

## 交互式补全

在 TTY 环境下，若缺少必填参数或选项，CLI 会尝试交互式提示补全（使用 `--json` 时不会触发）。例如缺少 `--to` 时，`convert` 会引导你选择输出格式。

## 输出与 `-o` 行为

- 默认：人类可读文本 + 进度 spinner
- `--json`：结构化 JSON，便于脚本解析
- `-o, --out`：任务完成后自动下载结果
  - 单文件 → 写入指定路径
  - 多文件 → 写入目录；若路径以 `.zip` 结尾则打包为 zip
  - 无文件结果 → 写入 JSON

指定 `-o` 时，CLI 会等待任务完成以便下载结果，即使同时传入了 `--no-wait`。

## 常见问题

**Q: 多文件输入何时有效？**

仅部分任务支持有序多源：`convert` 的 `html → pptx`、`join`、`create`（最多 2 个参考文件）、以及 `run` 中的 `pptx.join` / `convertor.html2pptx` 等。

## 相关链接

- [Deckflow](https://app.deckflow.com)
- 问题反馈：[GitHub Issues](https://github.com/deckflow/deckops/issues)
