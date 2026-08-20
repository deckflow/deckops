package deckops

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestExtensionRouting(t *testing.T) {
	for name, want := range map[string]TaskType{
		"a.pdf":                       TaskPDFParse,
		"/tmp/deck.PPTX":              TaskPptxParse,
		"report.docx":                 TaskDocxParse,
		"https://x.com/a/b.key?v=1#f": TaskKeynoteParse,
	} {
		got, ok := ParseTaskTypeFor(name)
		if !ok || got != want {
			t.Fatalf("ParseTaskTypeFor(%q) = %q, %v; want %q", name, got, ok, want)
		}
	}
	for _, name := range []string{"a.txt", "noext", ".gitignore"} {
		if got, ok := ParseTaskTypeFor(name); ok {
			t.Fatalf("ParseTaskTypeFor(%q) = %q; want no match", name, got)
		}
	}
	if ExtensionOf("a/b/c.tar.gz") != ".gz" || ExtensionOf("") != "" {
		t.Fatal("ExtensionOf mismatch")
	}
}

// parseServer serves the create → poll → download round trip and records the
// params each task was created with.
func parseServer(t *testing.T, taskType TaskType, download string, seen *[]map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/tools/tasks":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			*seen = append(*seen, body)
			if body["type"] != string(taskType) {
				t.Fatalf("task type = %#v, want %q", body["type"], taskType)
			}
			_, _ = w.Write([]byte(`{"id":"task-1","status":"pending"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/tools/tasks/task-1":
			_, _ = w.Write([]byte(`{"id":"task-1","status":"completed"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/tools/tasks/task-1/download":
			_, _ = w.Write([]byte(download))
		default:
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
	}))
}

func testWait() WaitForTaskOptions {
	return WaitForTaskOptions{DisableSSE: true, Timeout: time.Second, PollInterval: time.Millisecond}
}

func newTestDeck(t *testing.T, ctx context.Context, root string) *Client {
	t.Helper()
	deck, err := New(ctx, ClientOptions{Root: root, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	return deck
}

func lastParams(t *testing.T, seen []map[string]any) map[string]any {
	t.Helper()
	if len(seen) == 0 {
		t.Fatal("no task was created")
	}
	params, _ := seen[len(seen)-1]["params"].(map[string]any)
	return params
}

func TestParseDefaultsToMarkdownOnly(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskPDFParse, `{"markdown":"# 标题","markdownImages":{"u":["k",1,"h"]}}`, &seen)
	defer server.Close()

	result, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "file-1", Name: "report.PDF"},
		ParseOptions{Wait: testWait()},
	)
	if err != nil {
		t.Fatal(err)
	}
	if want := (map[string]any{"markdown": true, "markdownOnly": true}); !reflect.DeepEqual(lastParams(t, seen), want) {
		t.Fatalf("params = %#v, want %#v", lastParams(t, seen), want)
	}
	if result.Markdown != "# 标题" || result.TaskID != "task-1" || result.Type != TaskPDFParse {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.MarkdownImages["u"].Path != "k" {
		t.Fatalf("markdownImages = %#v", result.MarkdownImages)
	}
	if result.Result != nil {
		t.Fatalf("markdown output should not carry the raw payload: %s", result.Result)
	}
}

func TestParseOutputIRSkipsMarkdown(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskPDFParse, `{"document":{"elements":[]},"images":[]}`, &seen)
	defer server.Close()

	result, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "file-1", Name: "a.pdf"},
		ParseOptions{Output: ParseOutputIR, Wait: testWait()},
	)
	if err != nil {
		t.Fatal(err)
	}
	if params := lastParams(t, seen); len(params) != 0 {
		t.Fatalf("ir output should not request markdown: %#v", params)
	}
	if result.Markdown != "" {
		t.Fatalf("ir output should not carry markdown: %q", result.Markdown)
	}
	var parsed PDFParseResult
	if err := json.Unmarshal(result.Result, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Document == nil {
		t.Fatalf("raw payload not passed through: %s", result.Result)
	}
}

func TestParseOutputAllPassesThroughParams(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskPptxParse, `{"slides":[{}],"markdown":"# a","markdownPages":["# a"]}`, &seen)
	defer server.Close()

	pages, strict := true, true
	result, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "file-1", Name: "a.pptx"},
		ParseOptions{Output: ParseOutputAll, MarkdownPages: &pages, MarkdownStrict: &strict, Wait: testWait()},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"markdown": true, "markdownPages": true, "markdownStrict": true}
	if !reflect.DeepEqual(lastParams(t, seen), want) {
		t.Fatalf("params = %#v, want %#v", lastParams(t, seen), want)
	}
	if result.Markdown != "# a" || len(result.MarkdownPages) != 1 || result.Result == nil {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestParsePDFPassthroughParams(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskPDFParse, `{"markdown":""}`, &seen)
	defer server.Close()

	images, meta := false, true
	_, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "file-1", Name: "a.pdf"},
		ParseOptions{
			Password:      "pw",
			ParseProfile:  PDFParseProfileQuality,
			IncludeImages: &images,
			MarkdownMeta:  &meta,
			Wait:          testWait(),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"markdown":      true,
		"markdownOnly":  true,
		"password":      "pw",
		"parseProfile":  "quality",
		"includeImages": false,
		"markdownMeta":  true,
	}
	if !reflect.DeepEqual(lastParams(t, seen), want) {
		t.Fatalf("params = %#v, want %#v", lastParams(t, seen), want)
	}
}

func TestParseDropsParamsTheTaskTypeRejects(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskDocxParse, `{"markdown":""}`, &seen)
	defer server.Close()

	pages := true
	rate := 0.08
	_, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "file-1", Name: "a.docx"},
		ParseOptions{MarkdownPages: &pages, StayImageAreaRate: &rate, Wait: testWait()},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"markdown": true, "markdownOnly": true}
	if !reflect.DeepEqual(lastParams(t, seen), want) {
		t.Fatalf("params = %#v, want %#v", lastParams(t, seen), want)
	}
}

func TestParseKeynotePassthroughParams(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskKeynoteParse, `{"markdown":""}`, &seen)
	defer server.Close()

	pages := true
	rate := 0.08
	_, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "file-1", Name: "a.key"},
		ParseOptions{MarkdownPages: &pages, StayImageAreaRate: &rate, Wait: testWait()},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"markdown":          true,
		"markdownOnly":      true,
		"markdownPages":     true,
		"stayImageAreaRate": 0.08,
	}
	if !reflect.DeepEqual(lastParams(t, seen), want) {
		t.Fatalf("params = %#v, want %#v", lastParams(t, seen), want)
	}
}

func TestParseURLSendsModeAndMarkdownSwitches(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskHTMLGetByURL, `{"markdown":"# page"}`, &seen)
	defer server.Close()

	result, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{URL: "https://example.com/posts/1"},
		ParseOptions{Wait: testWait()},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"url":          "https://example.com/posts/1",
		"mode":         string(ParseModeRuntime),
		"markdown":     true,
		"markdownOnly": true,
	}
	if !reflect.DeepEqual(lastParams(t, seen), want) {
		t.Fatalf("params = %#v, want %#v", lastParams(t, seen), want)
	}
	if result.Type != TaskHTMLGetByURL || result.Markdown != "# page" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestParseErrorsWhenBackendReturnsNoMarkdownField(t *testing.T) {
	// slave < 0.21.0 silently ignores the markdown params: the task succeeds but
	// the response carries no markdown key at all.
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskPptxParse, `{"slides":[{}]}`, &seen)
	defer server.Close()

	_, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "f", Name: "a.pptx"},
		ParseOptions{Wait: testWait()},
	)
	if err == nil || !strings.Contains(err.Error(), "returned no markdown field") {
		t.Fatalf("err = %v; want a missing-markdown error", err)
	}
}

func TestParseAcceptsPresentButEmptyMarkdown(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskPptxParse, `{"markdown":""}`, &seen)
	defer server.Close()

	result, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "f", Name: "a.pptx"},
		ParseOptions{Wait: testWait()},
	)
	if err != nil {
		t.Fatalf("an empty document is a legitimate result, got %v", err)
	}
	if result.Markdown != "" {
		t.Fatalf("markdown = %q", result.Markdown)
	}
}

func TestParseOutputIRWorksAgainstOldBackend(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var seen []map[string]any
	server := parseServer(t, TaskPptxParse, `{"slides":[{}]}`, &seen)
	defer server.Close()

	result, err := newTestDeck(t, ctx, server.URL).Parse(ctx,
		ParseSource{FileID: "f", Name: "a.pptx"},
		ParseOptions{Output: ParseOutputIR, Wait: testWait()},
	)
	if err != nil {
		t.Fatalf("ir output must not depend on the markdown key: %v", err)
	}
	if result.Result == nil {
		t.Fatal("raw payload not passed through")
	}
}

func TestParseRejectsUnsupportedExtension(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	deck := newTestDeck(t, ctx, "http://127.0.0.1:0")

	if _, err := deck.Parse(ctx, ParseSource{FileID: "f", Name: "a.txt"}, ParseOptions{}); err == nil {
		t.Fatal("expected an error for an unsupported extension")
	}
	if _, err := deck.Parse(ctx, ParseSource{FileID: "f", Name: "a.pdf"}, ParseOptions{Output: "bogus"}); err == nil {
		t.Fatal("expected an error for an unknown output tier")
	}
}
