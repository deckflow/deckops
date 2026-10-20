# Probe

`deckops probe` answers "what is this file?" on this machine with the free DeckProbe engine. It
needs no login, sends no request and spends no quota, so it is the right first step when the
answer decides what to do next.

```bash
deckops probe "deck.pptx" --json
deckops probe "report.pdf" --targets page_count,encrypted,title --json
deckops probe "report.pdf" --targets @security --level deep --json
deckops probe - --from docx --json < "notes.docx"
```

## Targets and levels

- `--targets` takes comma-separated fact names. Short aliases work across formats: `page_count`,
  `slide_count`, `title`, `author`, `encrypted`, `password_protected`, `has_macros`, `file_size`.
  Selectors name groups: `@summary`, `@security`, `@structure`, `@assets`, `@all`. Without
  `--targets`, the engine resolves its default set for the format.
- `--level header|metadata|deep` bounds how much of the file is read. `header` is cheapest;
  `deep` reads what a target needs and costs the most.
- `--minimum-confidence none|low|medium|high|exact` sets the lowest confidence accepted.
- Inputs: PDF, Office (`.docx` `.pptx` `.xlsx` and the legacy `.doc` `.ppt`) and iWork (`.key`
  `.pages` `.numbers`). A URL is not probed: download it first.

## Reading the report

The report is DeckProbe's schema-2 JSON, unchanged:

```jsonc
{
  "schema_version": 2,
  "status": "ok",                       // "partial" when some target is unresolved
  "input": { "display_name": "report.pdf", "source_kind": "local_file", "file_size": 118311 },
  "driver": { "id": "pdf", "profile": "pdf" },
  "results": {
    "pdf.page_count": { "status": "resolved", "value": 3, "confidence": "exact", "path": "pdf.document_structure" }
  },
  "execution": { "probe_level": "metadata", "unresolved_targets": [] },
  "diagnostics": []
}
```

Read `results[<id>].status` before `value`: `resolved` and `estimated` carry a value; `unknown`,
`unsupported`, `budget_exceeded` and `failed` do not. Do not treat a missing value as zero.

## Using the answer

- Encrypted or password-protected PDF: ask for the password before extract or convert.
- Many pages or slides: prefer `render --pages` or one conversion over many.
- A PDF with no text layer (scanned) still converts; expect OCR-quality text and check it.
- Legacy `.doc`, `.xlsx`, `.pages` and `.numbers` probe fine but are not cloud inputs in this
  version; say so instead of attempting extract or convert.

Errors use the DeckOps error envelope: `usage_error` for a bad target or level, `unsupported`
for a format DeckProbe does not know, `input_error` for a damaged or unreadable file. Without
the optional `@deckflow/deckprobe` package, probe reports `unsupported` with the install command.
