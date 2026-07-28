# deckops-sdk

Python SDK for Deckops/Deckflow task APIs. It mirrors the TypeScript SDK's task,
upload, SSE wait, parse, and Markdown conversion behavior.

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

## Parse documents to Markdown

```python
markdown = deck.parse("./slides.pptx")

detailed = deck.parse_detailed({
    "file_id": "uploaded-file-id",
    "name": "slides.pptx",
})
print(detailed["taskId"], detailed["markdown"])

page_markdown = deck.parse({
    "url": "https://example.com/article",
    "mode": "runtime",
})
```

Low-level structured parse results can be converted without making API calls:

```python
from deckops import pdf_result_to_markdown, pptx_result_to_markdown

markdown = pdf_result_to_markdown(result)
```

The client is synchronous and owns its HTTP connection pool. Use
`with create_deck(...) as deck:` or call `deck.close()` when the client has a
short lifetime.

