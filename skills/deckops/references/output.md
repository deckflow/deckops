# Machine-readable output

Use `--json` and capture the exit code, stdout, and stderr separately. Not every failure
emits JSON: an unknown option and an unexpected process failure may write only stderr.

## Read

Default `deckops SOURCE --json` returns one object:

```jsonc
{
  "schemaVersion": "deckops.read.v2",
  "ok": true,
  "format": "markdown",
  "content": "# Title\n…",
  "outputs": [],
  "assets": [{ "path": "/home/me/.cache/deckops/…/assets/p1.png", "lifecycle": "cache", "bytes": 2048 }],
  "report": {
    "schemaVersion": "deckops.run.v2",
    "parseTaskId": "t_1",
    "convertTaskId": "t_2",
    "cacheHit": false,
    "artifactBase": "/home/me/.cache/deckops/…",
    "warnings": []
  }
}
```

`--format ir` makes `content` the server IR object. `-o FILE` sets `content` to null, lists the
written files in `outputs`, and marks copied images `lifecycle: "output"`. `--report FILE`
writes the `report` object to a file. Without `--json`, stdout carries only the content and
warnings go to stderr.

## Parse

```jsonc
{
  "ok": true,
  "op": "parse",
  "input": "report.pdf",
  "type": "pdf.pdfParse",
  "format": "pdf",
  "taskId": "t_1",
  "irKey": "…/ir.json",
  "irSchemaVersion": "result.v3",
  "expiresAt": "2026-10-26T08:00:00.000Z",
  "reusedParse": false,
  "artifact": "work/report-pdf",
  "outputs": [{ "file": "work/report-pdf/ir.json", "bytes": 52311 }],
  "warnings": [],
  "durationMs": 9100
}
```

On reuse, `reusedParse` is true and `taskId` is the original parse task.

## Convert

```jsonc
{
  "ok": true,
  "op": "convert",
  "input": "work/report-pdf",
  "to": "markdown",
  "format": "pdf",
  "taskId": "t_2",
  "parseTaskId": "t_1",
  "reusedParse": true,
  "outputs": [{ "file": "work/report-pdf/views/markdown/index.md", "bytes": 1200 }],
  "warnings": [],
  "durationMs": 2400
}
```

`taskId` is null when the cached view was returned. `reusedParse` is false only for a one-shot
convert of a source document. `-o - --json` adds the Markdown as `content` in the same object.

## Errors and exit codes

```jsonc
{ "ok": false, "op": "parse", "error": { "code": "ir_expired", "message": "…", "hint": "…", "taskId": "…" } }
```

| Exit | Codes or condition | Response |
| ---: | --- | --- |
| `2` | `usage_error`, or CLI syntax | Check `--help`; removed 2.x options such as `--engine` land here. |
| `3` | `unsupported` | Change the format or option; do not approximate success. |
| `4` | `auth_error` | Restore the login (`deckops auth login`); do not switch identity. |
| `5` | `input_error`, `ir_not_found`, `ir_expired`, `ir_schema_unsupported`, `ir_invalid`, `asset_error` | Fix the named condition using its hint. |
| `6` | `backend_error` | Rerun the same parse into the same output to resume a recorded task. |
| `7` | `not_implemented` | The reserved operation is unavailable in this version. |
| `8` | `quota_error` | Report the quota and the login route. |

Branch on `error.code`, not on the message, and keep `taskId` and `hint`.

## Output checks

Before delivery:

1. Confirm `ok`, the operation, the format, and whether the parse was reused.
2. Read `warnings` against the user's goal.
3. Confirm every required path in `outputs` exists.
4. Check Markdown image destinations, or disclose remote, expiring links.
5. Keep stdout content, stderr diagnostics, and the document's own text separate.

Do not expose passwords, tokens, API keys, signed URL query strings, or full configuration
values in summaries.
