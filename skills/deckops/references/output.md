# Machine-readable output

Use `--json` with file or artifact output. Capture process exit code, stdout, and stderr
separately. Do not assume every failure emits JSON: Commander option errors and an unexpected
process failure may write only stderr.

Default `deckops SOURCE --json` returns one `deckops.read.v1` object with `content`,
`assets`, `outputs`, and `report.assessment` / `report.decision`. `--format ir` makes content
an object. `-o FILE --json` returns null content and output receipts. `-o - --json` is also
one JSON value; it does not mix Markdown with a second envelope. Preserve the report when
wrapping the tool for an Agent. Pure Markdown consumers must also read stderr diagnostics.
`completeness: partial` indicates observed missing source content; a visual warning alone
does not imply missing pages. `unknown` does not certify completeness.
`assessment.summary` reports known source pages and evidence, parsed/missing/failed pages,
body text characters, textless/OCR/visual-risk pages, and unsupported control counts.
Large inferred missing-page lists are capped at 1,000 with a full count and truncation flag.
`assessment.recommendation` describes an optional paid cloud run and upload scope.
`decision` describes actual policy execution; read these separately.
Markdown replaces unsupported C0/DEL controls with U+FFFD, preserving original IR and
recording the replacement. This does not recover missing text.

## Parse envelope

Important fields on success:

```jsonc
{
  "ok": true,
  "op": "parse",
  "input": "report.pdf",
  "engine": "local",
  "format": "pdf",
  "quality": { "status": "pass", "checks": [], "coverage": {} },
  "taskId": null,
  "reusedParse": false,
  "irSchemaVersion": "deckir.v1",
  "artifact": "work/report-pdf",
  "outputs": [],
  "warnings": [],
  "durationMs": 100
}
```

`engine` can be `local`, `cloud`, or `artifact-cache`. Cloud fields and inspection are
conditional. Use the actual envelope rather than requiring every optional field.

## Convert envelope

Important fields on success:

```jsonc
{
  "ok": true,
  "op": "convert",
  "input": "work/report-pdf",
  "to": "markdown",
  "engine": "local",
  "format": "pdf",
  "taskId": null,
  "reusedParse": true,
  "outputs": [{ "file": "work/report-pdf/views/markdown/index.md", "bytes": 1200 }],
  "warnings": [],
  "durationMs": 20
}
```

Quality, inspection, parse task ID, and cloud task ID depend on the conversion path. Cached
outputs report actual file bytes on both new writes and cache hits; zero means an empty file.

## Errors and exit codes

DeckOps errors use a stable `error.code` when they reach the product error layer:

| Exit | Codes or condition | Response |
| ---: | --- | --- |
| `2` | `usage_error`, or CLI syntax | Check the relevant `--help`; stdout may be empty. |
| `3` | `unsupported` | Change the real format/engine/option path; do not approximate success. |
| `4` | `auth_error` | Restore the same cloud identity/space; do not silently switch user or guest. |
| `5` | `input_error`, `ir_not_found`, `ir_expired`, `ir_schema_unsupported`, `ir_invalid`, `asset_error` | Fix the named local or remote input condition using its hint. |
| `6` | `backend_error` | Retain a known task ID and recover before retrying a parse submission. |
| `7` | `not_implemented` | The reserved operation is unavailable in this version. |
| `8` | `quota_error` | Report the quota/login route; do not create another identity to bypass it. |
| Other | Unexpected process failure | Preserve the code and necessary stderr; do not invent an envelope. |

Error messages can change. Branch on `error.code` when available and retain `taskId` and `hint`.

## Output checks

Before delivery:

1. Confirm `ok`, operation, actual engine, format, and reuse state.
2. Evaluate quality and warnings for the user's goal.
3. Confirm every required path in `outputs` exists.
4. Check Markdown image destinations or disclose remote/expiring links.
5. Keep stdout content, stderr diagnostics, and the document's own text separate.

Do not expose passwords, access tokens, API keys, signed asset query strings, or full config
values in summaries.
