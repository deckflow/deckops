**語言：** [English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# deckops CLI

Deckops 是 [Deckflow](https://app.deckflow.com) 的命令列工具，用於上傳檔案、建立非同步任務，以及查看任務狀態。

## 環境需求

- Node.js >= 18
- 有效的 Deckflow 帳號與 workspace（space）

## 安裝

```bash
npm install -g deckops
deckops --help
```

## 快速開始

Deckops 會在命令需要時引導你完成認證和工作區設定。

```bash
deckops convert slides.pptx --to pdf
```

## 全域選項

| 選項 | 說明 |
|------|------|
| `--json` | 以 JSON 格式輸出結果（適合腳本整合） |
| `--version` | 顯示版本號 |
| `--help` | 顯示說明資訊 |

範例：

```bash
# JSON 模式列出任務
deckops --json task list --limit 5

# 查看版本
deckops --version

# 查看某子命令說明
deckops convert --help
```

## 檔案壓縮

### `compress <input-file>`

壓縮 Office 文件、影片或 zip 檔案。根據副檔名自動選擇任務類型。

支援格式：`.zip`、`.pptx`、`.key`、`.docx`、`.xlsx`、`.mp4`、`.avi`、`.mov`、`.mkv`

| 選項 | 說明 |
|------|------|
| `-o, --out <path>` | 將任務結果寫入檔案或目錄 |
| `--no-wait` | 建立任務後不等待完成 |
| `--timeout <seconds>` | 等待逾時（預設 300 秒） |

```bash
# 壓縮 PPT 簡報
deckops compress presentation.pptx

# 壓縮影片並儲存結果
deckops compress demo.mp4 -o ./output/compressed.mp4

# 僅建立任務，不等待完成
deckops compress large.pptx --no-wait
```

## 資訊擷取

### `extract <input-file>`

從檔案中擷取字型、文字形狀等資訊。

| 選項 | 說明 |
|------|------|
| `--type <type>` | 擷取類型：`fonts`、`text-shapes` |
| `-o, --out <path>` | 儲存結果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 逾時秒數 |

```bash
# 從 pptx 自動擷取字型資訊
deckops extract slides.pptx

# 明確指定擷取文字形狀
deckops extract slides.pptx --type text-shapes

# 擷取並儲存到目錄
deckops extract slides.pptx --type fonts -o ./extracted/
```

## OCR 文字辨識

### `ocr <input-file>`

對圖片進行 OCR。支援 `.jpg`、`.jpeg`、`.png`。

| 選項 | 說明 |
|------|------|
| `--language <lang>` | 語言（預設 `zh-hans`） |
| `-o, --out <path>` | 儲存結果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 逾時秒數 |

支援語言：`zh-hans`、`zh-hant`、`en`、`ja`、`ko`、`ar`、`de`、`es`、`fr`、`it`、`pt`、`ru`

```bash
# 辨識中文圖片（預設語言）
deckops ocr scan.jpg

# 辨識英文圖片
deckops ocr document.png --language en

# 辨識日文並儲存
deckops ocr receipt.jpg --language ja -o ./ocr-result.json
```

## 格式轉換

### `convert <input-files...> --to <format>`

將檔案轉換為指定格式。

| 選項 | 說明 |
|------|------|
| `--to <format>` | 輸出格式（必填）：`image`、`pdf`、`video`、`html`、`png`、`pptx`、`webp` |
| `--width <number>` | HTML → PPT/PNG 時的寬度 |
| `--height <number>` | HTML → PPT/PNG 時的高度 |
| `--need-embed-fonts [boolean]` | HTML → PPTX 是否嵌入字型（預設 false） |
| `-o, --out <path>` | 儲存結果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 逾時秒數 |

**多檔案說明**：僅 `html → pptx` 支援多個輸入檔案，按順序合併為一個轉換任務。

```bash
# PPT 轉 PDF
deckops convert slides.pptx --to pdf

# 多個 HTML 合併轉 PPTX
deckops convert page1.html page2.html page3.html --to pptx

# HTML 轉 PNG，指定尺寸並儲存
deckops convert slide.html --to png --width 1920 --height 1080 -o ./slide.png
```

## PPT 合併

### `join <input-files...>`

按給定順序將多個 `.pptx` 合併為一個（對應任務類型 `pptx.join`）。至少需要 2 個檔案。

| 選項 | 說明 |
|------|------|
| `--name <name>` | 任務名稱 |
| `-o, --out <path>` | 儲存結果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 逾時秒數 |

```bash
# 合併三段簡報
deckops join intro.pptx body.pptx appendix.pptx

# 指定輸出任務名並儲存
deckops join part1.pptx part2.pptx --name merged-deck -o ./merged.pptx

# 僅建立任務
deckops join a.pptx b.pptx --no-wait
```

## AI 內容生成

### `create [input-files...]`

根據文字或參考檔案生成文件內容（API 任務類型為 `generation`）。

| 選項 | 說明 |
|------|------|
| `--input-text <text>` | 輸入文字 |
| `--enable-search [boolean]` | 啟用搜尋 |
| `--advanced-model [boolean]` | 使用進階模型 |
| `--fast-mode [boolean]` | 快速模式 |
| `--intent <intent>` | 生成意圖 |
| `--audience <audience>` | 目標受眾 |
| `--page-count <number>` | 預期頁數 |
| `--author <name>` | 文件作者 |
| `-o, --out <path>` | 儲存結果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 逾時秒數 |

參考檔案最多 2 個，支援：`.html`、`.pdf`、`.docx`、`.pptx`、`.txt`、`.md`、`.mm`、`.xmind`、`.ipynb`

```bash
# 純文字生成
deckops create --input-text "請寫一份產品發布會方案"

# 帶參考檔案和頁數限制
deckops create outline.md --input-text "擴展為完整演講稿" --page-count 20

# 進階模型 + 搜尋，並儲存結果
deckops create brief.pdf --input-text "生成詳細報告" --advanced-model --enable-search -o ./report/
```

## 文件翻譯

### `translate <input-file>`

翻譯文件檔案。支援 `.docx`、`.pptx`、`.pdf`、`.xlsx`、`.key`。

| 選項 | 說明 |
|------|------|
| `--from <language>` | 來源語言（必填） |
| `--to <language>` | 目標語言（必填） |
| `--model <model>` | 模型（必填）：`Standard` 或 `Pro` |
| `--use-glossary [boolean]` | 使用術語表 |
| `--image-translate [boolean]` | 翻譯圖片內文字 |
| `-o, --out <path>` | 儲存結果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 逾時秒數 |

```bash
# 中譯英（Standard 模型）
deckops translate handbook.docx --from zh --to en --model Standard

# 英譯中，Pro 模型
deckops translate slides.pptx --from en --to zh --model Pro

# 自動偵測來源語言，啟用術語表並儲存
deckops translate manual.pdf --from auto --to ja --model Pro --use-glossary -o ./translated.pdf
```

## 通用任務執行

### `run <task-type> <input-files...>`

明確指定任務類型執行，適合進階用法或 CLI 未封裝的任務。

| 選項 | 說明 |
|------|------|
| `--param <key=value>` | 任務參數（可多次使用，值支援 JSON） |
| `-o, --out <path>` | 儲存結果 |
| `--no-wait` | 不等待完成 |
| `--timeout <seconds>` | 逾時秒數 |

**多檔案說明**：以下任務類型支援多個輸入檔案作為有序來源集合：`pptx.join`、`convertor.html2pptx`、`html.buildPlayer`、`generation`。

```bash
# PPT 轉 PDF（明確任務類型）
deckops run convertor.ppt2pdf demo.ppt

# 合併 PPT
deckops run pptx.join part1.pptx part2.pptx

# HTML 轉 PPTX 並傳參
deckops run convertor.html2pptx page1.html page2.html --param width=1920 --param needEmbedFonts=true
```

## 任務管理

### `task list`

列出 workspace 中的任務。

| 選項 | 說明 |
|------|------|
| `--type <type>` | 按任務類型過濾 |
| `--limit <n>` | 最大條數（預設 50） |
| `--offset <n>` | 分頁偏移（預設 0） |

```bash
# 列出最近 10 條任務
deckops task list --limit 10

# 只看轉換類任務
deckops task list --type convertor.ppt2pdf --limit 20

# JSON 分頁查詢
deckops --json task list --offset 50 --limit 50
```

### `task get <task-id>`

取得單個任務詳情。

| 選項 | 說明 |
|------|------|
| `-o, --out <path>` | 下載並儲存已完成任務的結果 |

```bash
# 查看任務詳情
deckops task get abc123-task-id

# 下載任務結果到檔案
deckops task get abc123-task-id -o ./result.pdf

# JSON 模式
deckops --json task get abc123-task-id
```

### `task delete <task-id>`

刪除指定任務。

```bash
# 刪除任務
deckops task delete abc123-task-id

# JSON 模式
deckops --json task delete abc123-task-id

# 刪除後確認列表
deckops task delete abc123-task-id && deckops task list --limit 5
```

## 互動式補全

在 TTY 環境下，若缺少必填參數或選項，CLI 會嘗試互動式提示補全（使用 `--json` 時不會觸發）。例如缺少 `--to` 時，`convert` 會引導你選擇輸出格式。

## 輸出與 `-o` 行為

- 預設：人類可讀文字 + 進度 spinner
- `--json`：結構化 JSON，便於腳本解析
- `-o, --out`：任務完成後自動下載結果
  - 單檔案 → 寫入指定路徑
  - 多檔案 → 寫入目錄；若路徑以 `.zip` 結尾則打包為 zip
  - 無檔案結果 → 寫入 JSON

指定 `-o` 時，CLI 會等待任務完成以便下載結果，即使同時傳入了 `--no-wait`。

## 常見問題

**Q: 多檔案輸入何時有效？**

僅部分任務支援有序多來源：`convert` 的 `html → pptx`、`join`、`create`（最多 2 個參考檔案）、以及 `run` 中的 `pptx.join` / `convertor.html2pptx` 等。

## 相關連結

- [Deckflow](https://app.deckflow.com)
- 問題回報：[GitHub Issues](https://github.com/deckflow/deckops/issues)
