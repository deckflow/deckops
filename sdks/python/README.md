# deckops-sdk

Python SDK for Deckops/Deckflow task APIs. It mirrors the TypeScript SDK's task,
upload, SSE wait, and parse behavior.

## Install

```bash
pip install deckops-sdk
```

For local development:

```bash
pip install -e ".[dev]"
```

## Create a client

```python
import os
from deckops import create_deck

deck = create_deck(
    token=os.getenv("DECKOPS_TOKEN"),
    api_key=os.getenv("DECKOPS_API_KEY"),
    space_id=os.getenv("DECKOPS_SPACE_ID"),
)
```

Every API request includes a stable UUID v4 in `X-Auth-UUID`. By default it is
stored in `~/.deckops/auth-uuid`. Set `DECKOPS_CONFIG_DIR` to change the directory
or `DECKOPS_AUTH_UUID` to use a fixed value.

## Create and wait for tasks

```python
task = deck.convert_ppt_to_pdf(files=["./slides.pptx"], name="slides")
done = deck.tasks.wait(task["id"])
result = deck.ttask.down(done["id"])
```

The generic API is also available:

```python
task = deck.tasks.create(
    type="convertor.ppt2pdf",
    file_ids=["file-1"],
    params={},
)
tasks = deck.tasks.list(type="convertor.ppt2pdf")
deck.tasks.delete(task["id"])
```

## Upload files

```python
uploaded = deck.files.upload(
    "./slides.pptx",
    on_progress=lambda progress: print(f"{progress:.0%}"),
)
```

Upload inputs can be paths, bytes, bytearray values, memoryviews, or readable
binary streams. Binary streams and in-memory data require `name=`.

## Parse documents

`parse()` picks a parser from the file extension or URL, creates the task, waits
for it, and returns what `output` asked for. Markdown is rendered by the
backend — the SDK does no conversion of its own.

```python
# Markdown only (the default): the structured result is dropped server-side.
res = deck.parse("./slides.pptx")
print(res["markdown"])
```

`output` picks what comes back:

| `output`     | `markdown` 系字段 | `result` | 下发给服务端                         |
| ------------ | ----------------- | -------- | ------------------------------------ |
| `"markdown"` | ✅                | —        | `markdown: true, markdownOnly: true` |
| `"ir"`       | —                 | ✅       | *（不带 markdown 参数）*             |
| `"all"`      | ✅                | ✅       | `markdown: true`                     |

`result` 是服务端返回体的原样透传：

```python
res = deck.parse("./report.pdf", output="ir")
document = res["result"]["document"]      # pdf.pdfParse 的结构化 IR

res = deck.parse("./slides.pptx", output="all", markdown_pages=True)
res["markdown"], res["markdownPages"], res["result"]
```

各解析器的直通参数写在同一个 options 上，只会下发给认得它的任务类型 ——
`markdown_pages` 只对 `.pptx` / `.key` 有效，`password` / `parse_profile` /
`include_images` / `markdown_meta` 只对 `.pdf` 有效，`stay_image_area_rate`
只对 `.key` 有效：

```python
res = deck.parse("./report.pdf", output="all", parse_profile="quality", password="pw")
```

已上传的文件传 `file_id` + `name`，链接传 `url`：

```python
res = deck.parse({"file_id": "uploaded-file-id", "name": "slides.pptx"})
res = deck.parse({"url": "https://example.com/article", "mode": "runtime"})
```

支持的扩展名是 `.pdf`、`.pptx`、`.docx`、`.key`。底层任务快捷方法
（`deck.pdf_parse` → `pdf.pdfParse`、`deck.pptx_parse`、`deck.docx_parse`、
`deck.keynote_parse`、`deck.html_get_by_url`）直接收服务端参数，
包括 `markdown` / `markdownOnly` / `markdownPages` / `markdownStrict`。

服务端默认容错而非失败：markdown 生成出错时 `res["markdownError"]` 说明原因、
`res["markdown"]` 为空。要它直接失败就传 `markdown_strict=True`。

The client is synchronous and owns its HTTP connection pool. Use
`with create_deck(...) as deck:` or call `deck.close()` when the client has a
short lifetime.

