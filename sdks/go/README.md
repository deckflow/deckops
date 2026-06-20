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

By default, the SDK persists `X-Auth-UUID` in `~/.deckops/auth-uuid`. Set `DECKOPS_CONFIG_DIR` to change that directory, or `DECKOPS_AUTH_UUID` to force a fixed UUID.

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
