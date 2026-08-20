# deckops Go SDK

Go SDK for Deckops/Deckflow task APIs.

## Install

```bash
go get github.com/deckops/deckops/sdks/go
```

## Create a Client

```go
package main

import (
	"context"
	"log"
	"os"

	deckops "github.com/deckops/deckops/sdks/go"
)

func main() {
	ctx := context.Background()
	deck, err := deckops.New(ctx, deckops.ClientOptions{
		Token:   os.Getenv("DECKOPS_TOKEN"),
		APIKey:  os.Getenv("DECKOPS_API_KEY"),
		SpaceID: os.Getenv("DECKOPS_SPACE_ID"),
	})
	if err != nil {
		log.Fatal(err)
	}

	task, err := deck.ConvertPptToPDF(ctx, deckops.TaskShortcutParams{
		Files: []deckops.TaskUploadInput{{
			Input: deckops.UploadInput{Path: "./slides.pptx"},
		}},
		Name: "slides",
	})
	if err != nil {
		log.Fatal(err)
	}

	done, err := deck.Tasks.Wait(ctx, task.ID, deckops.WaitForTaskOptions{})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(done.Status)
}
```

## Options

- `Root` defaults to `https://app.deckflow.com/v1`.
- `Token` is sent as `X-Auth-Token`.
- `APIKey` is sent as `Authorization: Bearer {apiKey}`.
- `SpaceID` is the default workspace id for task and upload calls.
- `AuthUUID` is an explicit UUID v4 sent as `X-Auth-UUID`.
- `AuthUUIDStorage` can override default UUID persistence.
- `OnUnauthorized` is called once after a 401; the request is retried with returned credentials.
- `OnPaymentRequired` is called once after a 402; the request is retried after it returns.

By default, the SDK persists `X-Auth-UUID` in `~/.deckflow/auth-uuid`. Set `DECKFLOW_CONFIG_DIR` to change that directory, or `DECKOPS_AUTH_UUID` to force a fixed UUID.

## Tasks

```go
task, err := deck.Tasks.Create(ctx, deckops.CreateTaskParams{
	Type:    deckops.TaskConvertPptToPDF,
	FileIDs: []string{"file-1"},
	Params:  map[string]any{},
})

list, err := deck.Tasks.List(ctx, deckops.ListTasksParams{
	Type: deckops.TaskConvertPptToPDF,
})

got, err := deck.Tasks.Get(ctx, task.ID, false)
done, err := deck.Tasks.Wait(ctx, task.ID, deckops.WaitForTaskOptions{})
err = deck.Tasks.Down(ctx, task.ID, deckops.TaskDownloadOptions{}, &out)
err = deck.Tasks.Delete(ctx, task.ID)
_ = list
_ = got
_ = done
```

`deck.TTask` is an alias for `deck.Tasks`, matching the backend `ttask` naming used by existing integrations.

## Parse documents

`Parse` picks a parser from the file extension or URL, creates the task, waits
for it, and returns what `Output` asked for. Markdown is rendered by the
backend — the SDK does no conversion of its own.

```go
input := deckops.TaskUploadInput{
	Input: deckops.UploadInput{Path: "./slides.pptx"},
}

// Markdown only (the default): the structured result is dropped server-side.
res, err := deck.Parse(ctx, deckops.ParseSource{File: &input}, deckops.ParseOptions{})
if err != nil {
	log.Fatal(err)
}
log.Println(res.Markdown)
```

`ParseOptions.Output` picks what comes back:

| `Output`              | Markdown fields | `Result` | Sent to the backend               |
| --------------------- | --------------- | -------- | --------------------------------- |
| `ParseOutputMarkdown` | ✅              | —        | `markdown: true, markdownOnly: true` |
| `ParseOutputIR`       | —               | ✅       | *(no markdown params)*            |
| `ParseOutputAll`      | ✅              | ✅       | `markdown: true`                  |

`Result` is the raw response body, so unmarshal it into the shape your task type
returns:

```go
res, err := deck.Parse(ctx, deckops.ParseSource{File: &input}, deckops.ParseOptions{
	Output: deckops.ParseOutputIR,
})
if err != nil {
	log.Fatal(err)
}
var document deckops.PptxParseResult
if err := json.Unmarshal(res.Result, &document); err != nil {
	log.Fatal(err)
}
```

Per-parser params ride on `ParseOptions` and are only sent to the task types
that accept them — `MarkdownPages` for `.pptx` / `.key`, `Password`,
`ParseProfile`, `IncludeImages`, `MarkdownMeta` for `.pdf`, `StayImageAreaRate`
for `.key`:

```go
pages := true
res, err := deck.Parse(ctx, deckops.ParseSource{File: &input}, deckops.ParseOptions{
	Output:        deckops.ParseOutputAll,
	MarkdownPages: &pages,
})
// res.MarkdownPages[i] is page i; res.Markdown joins them with deckops.PageSeparator.
```

Links go through the same call:

```go
res, err := deck.Parse(ctx, deckops.ParseSource{
	URL:  "https://example.com/article",
	Mode: deckops.ParseModeRuntime,
}, deckops.ParseOptions{})
```

Supported file extensions are `.pdf`, `.pptx`, `.docx`, and `.key`. For an
already uploaded file, pass `FileID` and `Name`. The low-level task shortcuts
are `PDFParse` (`pdf.pdfParse`), `PptxParse`, `DocxParse`, `KeynoteParse`, and
`HTMLGetByURL`; they take the backend params directly, including `markdown`,
`markdownOnly`, `markdownPages`, and `markdownStrict`.

By default the backend degrades rather than fails: if Markdown rendering breaks,
`res.MarkdownError` explains why and `res.Markdown` is empty. Set
`MarkdownStrict` to make the task fail instead.

Markdown needs a backend running `@deckflow/platform-slave` 0.21.0 or newer.
Older servers ignore the markdown params silently instead of rejecting them, so
`Parse` returns an error rather than an empty string that would read as an empty
document. `ParseOutputIR` does not need the markdown params and works against
older backends.

## Uploads

```go
file, err := deck.Files.Upload(ctx, deckops.UploadInput{
	Path: "./slides.pptx",
}, deckops.UploadOptions{
	OnProgress: func(p float64) {
		log.Printf("%.0f%%", p*100)
	},
})
```

Upload inputs can be file paths, byte slices, or readers. Paths and byte slices are hashed automatically with MD5.
