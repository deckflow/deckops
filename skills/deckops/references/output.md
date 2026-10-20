# Machine-readable output

Use `--json` and capture the exit code, stdout and stderr separately. Not every failure emits
JSON: an unknown option and an unexpected process failure may write only stderr.

## Envelopes

Render, extract and convert print one object of the same shape:

```jsonc
{
  "ok": true,
  "op": "convert",                       // render | extract | convert
  "input": "report.pdf",
  "to": "markdown",                      // image | video | json | assets | markdown
  "tasks": [{ "type": "document.convert", "id": "t_1" }],
  "outputs": [
    { "file": "work/report.md", "bytes": 52311 },
    { "file": "work/report.assets/p1_i0000.png", "bytes": 48213 }
  ],
  "format": "pdf",                       // extract and convert: the parsed source format
  "pages": 12,                           // render: frames rendered before --pages selection
  "reusedParse": false,                  // extract and convert: true when no new parse was billed
  "schemaVersion": "result.v3",          // extract --to json only
  "warnings": [],
  "durationMs": 8421
}
```

- `tasks[]` lists every cloud task in order; a chained render (DOCX, WebP) has several. Keep
  the ids for support and traceability.
- `outputs[]` lists the files written. Render frames add `page`, `width` and `height`.
- `content` appears only with `-o -`: the Markdown text, or the extracted JSON object.
  `contentPages` adds one Markdown string per slide with `--split-pages`.
- `warnings[]` carries fidelity notes from the cloud (for example a Markdown rendering problem
  without `--strict`, or an option the format ignores). Report the ones that matter.

`deckops probe --json` prints the DeckProbe report itself, not an envelope; see
[probe.md](probe.md).

Without `--json`, `-o -` prints only the content on stdout; otherwise a short summary of the
files written. Warnings go to stderr.

## Files on disk

| Command | Files |
| --- | --- |
| `convert SOURCE -o out.md` | `out.md`, images in `out.assets/` (links are relative) |
| `convert --split-pages -o out.md` | also `out-001.md`, `out-002.md`, … sharing `out.assets/` |
| `extract --to json -o out.json` | `out.json`, images in `out.assets/` (references rewritten) |
| `extract --to assets -o DIR` | `DIR/assets/…` |
| `render --to image -o DIR` | `DIR/001.png`, `DIR/002.png`, … |
| `render -o file.mp4` / single image | that file |

Without `-o`, convert writes `<stem>.md` and extract `<stem>.json` (or `<stem>/assets/…`) beside
the source; render writes `<stem>/001.png …`, or `<stem>.<ext>` for one output. Each document's
`<stem>.assets/` is replaced as a whole on every run, and every download is checked against the
md5 the cloud reported. Nothing else is written outside `~/.cache/deckops/index.json`.

## Errors

```jsonc
{ "ok": false, "op": "convert", "error": { "code": "quota_error", "message": "…", "hint": "…", "taskId": "t_1" } }
```

| exit | `error.code` | what to do |
| --- | --- | --- |
| 2 | `usage_error` | fix the command; removed 3.x flags (`parse`, `--format`, `--mode`) name their replacement |
| 3 | `unsupported` | the input, target or combination is not available; the hint names what is |
| 4 | `auth_error` | ask the user to log in |
| 5 | `input_error`, `asset_error`, `ir_*` | fix the input, or rerun after a failed download |
| 6 | `backend_error` | the task failed or timed out; rerun to continue a created task |
| 7 | `not_implemented` | `modify` and `export` are reserved |
| 8 | `quota_error` | quota or package exhausted; report it |

`taskId` is present whenever a cloud task existed.

## Output checks

- `ok: true` with empty `content` or very short Markdown for a long document deserves a look at
  `warnings` and at a render of the first pages.
- Check that every `outputs[].file` you cite exists, and that Markdown links point into its
  `<stem>.assets/`.
- Do not mix outputs of different runs: a rerun replaces the document's assets directory.
