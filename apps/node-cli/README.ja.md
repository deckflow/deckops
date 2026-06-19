**言語:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | **日本語**

# deckops CLI

Deckops は [Deckflow](https://app.deckflow.com) のコマンドラインツールです。ファイルのアップロード、非同期タスクの作成、タスク状態の確認ができます。

## 要件

- Node.js >= 18
- 有効な Deckflow アカウントと workspace（space）

## インストール

```bash
npm install -g deckops
deckops --help
```

## クイックスタート

```bash
deckops convert slides.pptx --to pdf
```

## グローバルオプション

| オプション | 説明 |
|-----------|------|
| `--json` | 結果を JSON 形式で出力（スクリプト連携に最適） |
| `--version` | バージョン番号を表示 |
| `--help` | ヘルプを表示 |

例：

```bash
# JSON モードでタスク一覧
deckops --json task list --limit 5

# バージョンを表示
deckops --version

# サブコマンドのヘルプを表示
deckops convert --help
```

## ファイル圧縮

### `compress <input-file>`

Office 文書、動画、zip ファイルを圧縮。拡張子に応じてタスクタイプを自動選択。

対応形式：`.zip`、`.pptx`、`.key`、`.docx`、`.xlsx`、`.mp4`、`.avi`、`.mov`、`.mkv`

| オプション | 説明 |
|-----------|------|
| `-o, --out <path>` | タスク結果をファイルまたはディレクトリに書き込み |
| `--no-wait` | タスク作成後に完了を待たない |
| `--timeout <seconds>` | 待機タイムアウト（デフォルト 300 秒） |

```bash
# PPT プレゼンテーションを圧縮
deckops compress presentation.pptx

# 動画を圧縮して結果を保存
deckops compress demo.mp4 -o ./output/compressed.mp4

# タスク作成のみ、待機しない
deckops compress large.pptx --no-wait
```

## 情報抽出

### `extract <input-file>`

ファイルからフォント、テキストシェイプなどの情報を抽出。

| オプション | 説明 |
|-----------|------|
| `--type <type>` | 抽出タイプ：`fonts`、`text-shapes` |
| `-o, --out <path>` | 結果を保存 |
| `--no-wait` | 完了を待たない |
| `--timeout <seconds>` | タイムアウト秒数 |

```bash
# pptx からフォント情報を自動抽出
deckops extract slides.pptx

# テキストシェイプを明示的に抽出
deckops extract slides.pptx --type text-shapes

# 抽出してディレクトリに保存
deckops extract slides.pptx --type fonts -o ./extracted/
```

## OCR 文字認識

### `ocr <input-file>`

画像に対して OCR を実行。`.jpg`、`.jpeg`、`.png` に対応。

| オプション | 説明 |
|-----------|------|
| `--language <lang>` | 言語（デフォルト `zh-hans`） |
| `-o, --out <path>` | 結果を保存 |
| `--no-wait` | 完了を待たない |
| `--timeout <seconds>` | タイムアウト秒数 |

対応言語：`zh-hans`、`zh-hant`、`en`、`ja`、`ko`、`ar`、`de`、`es`、`fr`、`it`、`pt`、`ru`

```bash
# 中国語画像を認識（デフォルト言語）
deckops ocr scan.jpg

# 英語画像を認識
deckops ocr document.png --language en

# 日本語を認識して保存
deckops ocr receipt.jpg --language ja -o ./ocr-result.json
```

## フォーマット変換

### `convert <input-files...> --to <format>`

ファイルを指定フォーマットに変換。

| オプション | 説明 |
|-----------|------|
| `--to <format>` | 出力フォーマット（必須）：`image`、`pdf`、`video`、`html`、`png`、`pptx`、`webp` |
| `--width <number>` | HTML → PPT/PNG 時の幅 |
| `--height <number>` | HTML → PPT/PNG 時の高さ |
| `--need-embed-fonts [boolean]` | HTML → PPTX でフォントを埋め込むか（デフォルト false） |
| `-o, --out <path>` | 結果を保存 |
| `--no-wait` | 完了を待たない |
| `--timeout <seconds>` | タイムアウト秒数 |

**複数ファイルの注意**：`html → pptx` のみ複数入力ファイルに対応し、順序どおりに 1 つの変換タスクにマージされます。

```bash
# PPT を PDF に変換
deckops convert slides.pptx --to pdf

# 複数 HTML を PPTX にマージ
deckops convert page1.html page2.html page3.html --to pptx

# HTML を PNG に変換、サイズ指定して保存
deckops convert slide.html --to png --width 1920 --height 1080 -o ./slide.png
```

## PPT 結合

### `join <input-files...>`

指定順に複数の `.pptx` を 1 つに結合（タスクタイプ `pptx.join`）。最低 2 ファイル必要。

| オプション | 説明 |
|-----------|------|
| `--name <name>` | タスク名 |
| `-o, --out <path>` | 結果を保存 |
| `--no-wait` | 完了を待たない |
| `--timeout <seconds>` | タイムアウト秒数 |

```bash
# 3 つのプレゼンテーションを結合
deckops join intro.pptx body.pptx appendix.pptx

# タスク名を指定して保存
deckops join part1.pptx part2.pptx --name merged-deck -o ./merged.pptx

# タスク作成のみ
deckops join a.pptx b.pptx --no-wait
```

## AI コンテンツ生成

### `create [input-files...]`

テキストまたは参照ファイルから文書コンテンツを生成（API タスクタイプ `generation`）。

| オプション | 説明 |
|-----------|------|
| `--input-text <text>` | 入力テキスト |
| `--enable-search [boolean]` | 検索を有効化 |
| `--advanced-model [boolean]` | 高度なモデルを使用 |
| `--fast-mode [boolean]` | 高速モード |
| `--intent <intent>` | 生成意図 |
| `--audience <audience>` | 対象読者 |
| `--page-count <number>` | 想定ページ数 |
| `--author <name>` | 文書の著者 |
| `-o, --out <path>` | 結果を保存 |
| `--no-wait` | 完了を待たない |
| `--timeout <seconds>` | タイムアウト秒数 |

参照ファイルは最大 2 つ：`.html`、`.pdf`、`.docx`、`.pptx`、`.txt`、`.md`、`.mm`、`.xmind`、`.ipynb`

```bash
# テキストのみで生成
deckops create --input-text "製品発表会の企画書を書いて"

# 参照ファイルとページ数制限付き
deckops create outline.md --input-text "完全なスピーチ原稿に拡張" --page-count 20

# 高度なモデル + 検索、結果を保存
deckops create brief.pdf --input-text "詳細レポートを生成" --advanced-model --enable-search -o ./report/
```

## 文書翻訳

### `translate <input-file>`

文書ファイルを翻訳。`.docx`、`.pptx`、`.pdf`、`.xlsx`、`.key` に対応。

| オプション | 説明 |
|-----------|------|
| `--from <language>` | ソース言語（必須） |
| `--to <language>` | ターゲット言語（必須） |
| `--model <model>` | モデル（必須）：`Standard` または `Pro` |
| `--use-glossary [boolean]` | 用語集を使用 |
| `--image-translate [boolean]` | 画像内の文字を翻訳 |
| `-o, --out <path>` | 結果を保存 |
| `--no-wait` | 完了を待たない |
| `--timeout <seconds>` | タイムアウト秒数 |

```bash
# 中国語から英語（Standard モデル）
deckops translate handbook.docx --from zh --to en --model Standard

# 英語から中国語、Pro モデル
deckops translate slides.pptx --from en --to zh --model Pro

# ソース言語を自動検出、用語集を有効化して保存
deckops translate manual.pdf --from auto --to ja --model Pro --use-glossary -o ./translated.pdf
```

## 汎用タスク実行

### `run <task-type> <input-files...>`

タスクタイプを明示して実行。高度な用途や CLI でラップされていないタスク向け。

| オプション | 説明 |
|-----------|------|
| `--param <key=value>` | タスクパラメータ（複数指定可、値は JSON 対応） |
| `-o, --out <path>` | 結果を保存 |
| `--no-wait` | 完了を待たない |
| `--timeout <seconds>` | タイムアウト秒数 |

**複数ファイルの注意**：次のタスクタイプは複数入力ファイルを順序付きソース集合としてサポート：`pptx.join`、`convertor.html2pptx`、`html.buildPlayer`、`generation`。

```bash
# PPT を PDF に（明示的タスクタイプ）
deckops run convertor.ppt2pdf demo.ppt

# PPT を結合
deckops run pptx.join part1.pptx part2.pptx

# HTML を PPTX に変換してパラメータを渡す
deckops run convertor.html2pptx page1.html page2.html --param width=1920 --param needEmbedFonts=true
```

## タスク管理

### `task list`

workspace 内のタスクを一覧表示。

| オプション | 説明 |
|-----------|------|
| `--type <type>` | タスクタイプでフィルタ |
| `--limit <n>` | 最大件数（デフォルト 50） |
| `--offset <n>` | ページネーションオフセット（デフォルト 0） |

```bash
# 直近 10 件のタスクを表示
deckops task list --limit 10

# 変換タスクのみ
deckops task list --type convertor.ppt2pdf --limit 20

# JSON でページネーション検索
deckops --json task list --offset 50 --limit 50
```

### `task get <task-id>`

単一タスクの詳細を取得。

| オプション | 説明 |
|-----------|------|
| `-o, --out <path>` | 完了したタスクの結果をダウンロードして保存 |

```bash
# タスク詳細を表示
deckops task get abc123-task-id

# タスク結果をファイルにダウンロード
deckops task get abc123-task-id -o ./result.pdf

# JSON モード
deckops --json task get abc123-task-id
```

### `task delete <task-id>`

指定タスクを削除。

```bash
# タスクを削除
deckops task delete abc123-task-id

# JSON モード
deckops --json task delete abc123-task-id

# 削除後に一覧を確認
deckops task delete abc123-task-id && deckops task list --limit 5
```

## 対話型 REPL

### `repl`

対話型コマンドラインに入り、プロセスを再起動せずにサブコマンドを 1 つずつ実行。

```bash
# REPL を起動
deckops repl
```

REPL では通常の CLI と同じコマンドを入力できます。例：

```
deckflow> convert slides.pptx --to pdf
deckflow> task list --limit 5
```

`exit` または `quit` で終了。

## 対話型補完

TTY 環境で必須の引数やオプションが不足している場合、CLI は対話的に補完を試みます（`--json` 使用時は発動しません）。例えば `--to` がない場合、`convert` が出力フォーマットの選択を案内します。

## 出力と `-o` の動作

- デフォルト：人間が読めるテキスト + 進捗スピナー
- `--json`：スクリプト解析用の構造化 JSON
- `-o, --out`：タスク完了後に結果を自動ダウンロード
  - 単一ファイル → 指定パスに書き込み
  - 複数ファイル → ディレクトリに書き込み；パスが `.zip` で終わる場合は zip にパッケージ
  - ファイル結果なし → JSON を書き込み

`-o` を指定した場合、`--wait` を明示しなくてもタスク完了を待ちます。

## よくある質問

**Q: 複数ファイル入力はいつ有効？**

一部のタスクのみ順序付き複数ソースに対応：`convert` の `html → pptx`、`join`、`create`（参照ファイル最大 2 つ）、`run` の `pptx.join` / `convertor.html2pptx` など。

## 関連リンク

- [Deckflow](https://app.deckflow.com)
- 問題報告：[GitHub Issues](https://github.com/deckflow/deckops/issues)
