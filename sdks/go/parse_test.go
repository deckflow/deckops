package deckops

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseTaskTypeFor(t *testing.T) {
	tests := map[string]TaskType{
		"a.pdf":                          TaskPDFParse,
		"/tmp/deck.PPTX":                 TaskPptxParse,
		"report.docx":                    TaskDocxParse,
		"https://x.com/a/b.key?v=1#part": TaskKeynoteParse,
	}
	for input, want := range tests {
		got, ok := ParseTaskTypeFor(input)
		if !ok || got != want {
			t.Fatalf("ParseTaskTypeFor(%q) = %q, %t; want %q, true", input, got, ok, want)
		}
	}
	if _, ok := ParseTaskTypeFor("a.txt"); ok {
		t.Fatal("a.txt unexpectedly has a parser")
	}
	if got := ExtensionOf(".gitignore"); got != "" {
		t.Fatalf("ExtensionOf(.gitignore) = %q", got)
	}
}

func TestPDFResultToMarkdown(t *testing.T) {
	pageZero := &ParseLocator{PageIndex: 0}
	pageOne := &ParseLocator{PageIndex: 1}
	result := PDFParseResult{
		TextBlocks: []PDFTextBlock{
			{Text: "第二页正文", Locator: pageOne},
			{Text: "大标题", Role: "heading", Locator: pageZero},
			{Text: "要点一", Role: "list-item", Locator: pageZero},
			{Text: "图注", Role: "caption", Locator: pageZero},
			{Text: "加粗", Style: &PDFTextBlockStyle{Bold: true}, Locator: pageZero},
		},
		Images: []PDFImage{{Key: "k/a.png", FileName: "a.png", Locator: pageZero}},
	}
	want := strings.Join(
		[]string{"## 大标题", "- 要点一", "*图注*", "**加粗**", "![a.png](k/a.png)", "第二页正文"},
		"\n\n",
	)
	if got := PDFResultToMarkdown(result); got != want {
		t.Fatalf("PDFResultToMarkdown() =\n%s\nwant:\n%s", got, want)
	}
}

func TestKeynoteResultToMarkdownKeepsUnassignedImages(t *testing.T) {
	pageZero := float64(0)
	result := KeynoteParseResult{
		Slides: []KeynoteSlide{
			{Text: []KeynoteTextItem{{ID: "1", Text: "页一"}}},
			{Text: []KeynoteTextItem{{ID: "2", Text: "页二"}}},
		},
		Images: []KeynoteImageItem{
			{ID: "1", Key: "a.png", PageIndex: &pageZero},
			{ID: "2", Key: "b.png"},
		},
	}
	want := "页一\n![img](a.png)" + PageSeparator + "页二" + PageSeparator + "![img](b.png)"
	if got := KeynoteResultToMarkdown(result); got != want {
		t.Fatalf("KeynoteResultToMarkdown() = %q, want %q", got, want)
	}
}

func TestDocxResultToMarkdown(t *testing.T) {
	heading := float64(1)
	result := DocxParseResult{Content: []DocxElement{
		{Idx: 1, Type: "image", Image: "k/pic.png", Name: "pic.png"},
		{Idx: 0, Type: "text", Text: "二级标题", Style: &DocxTextStyle{OutlineLvl: &heading}},
		{
			Idx:  2,
			Type: "table",
			Table: []DocxElement{
				{Children: []DocxElement{
					{Children: []DocxElement{{Type: "text", Text: "姓名"}}},
					{Children: []DocxElement{{Type: "text", Text: "年龄"}}},
				}},
				{Children: []DocxElement{
					{Children: []DocxElement{{Type: "text", Text: "张三"}}},
					{Children: []DocxElement{{Type: "text", Text: "30"}}},
				}},
			},
		},
	}}
	want := "## 二级标题\n\n![pic](k/pic.png)\n\n| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |"
	if got := DocxResultToMarkdown(result); got != want {
		t.Fatalf("DocxResultToMarkdown() =\n%s\nwant:\n%s", got, want)
	}
}

func TestPptxResultToMarkdownReadingOrder(t *testing.T) {
	result := pptxPresentation(
		pptxShape("", 0, 0, 20, 20),
		pptxShape("A", 100, 0, 20, 100),
		pptxShape("B", 200, 0, 20, 100),
		pptxShape("C", 0, 150, 20, 100),
		pptxShape("D", 0, 100_000, 20, 100),
		pptxShape("E", 900, 100_000, 20, 100),
	)
	if got := PptxResultToMarkdown(result); got != "A C B\nD E" {
		t.Fatalf("PptxResultToMarkdown() = %q", got)
	}
}

func TestPptxResultToMarkdownEmptyGeometryBridge(t *testing.T) {
	result := pptxPresentation(
		pptxShape("A", 0, 0, 100, 100),
		pptxShape("", 40, 225, 100, 25),
		pptxShape("B", 100, 350, 100, 100),
	)
	tolerance := float64(100)
	got := PptxResultToMarkdown(result, PptxConvertOptions{
		AbsoluteVerticalTolerance: &tolerance,
	})
	if got != "A B" {
		t.Fatalf("empty geometry bridge result = %q", got)
	}
}

func TestPptxResultToMarkdownVirtualGroup(t *testing.T) {
	result := pptxPresentation(
		pptxShape("Large", 0, 0, 1000, 1000),
		pptxShape("Medium", 800, 800, 150, 150),
		pptxShape("Child", 940, 940, 10, 10),
		pptxShape("After", 960, 760, 20, 20),
	)
	if got := PptxResultToMarkdown(result); got != "Large Medium Child After" {
		t.Fatalf("virtual group result = %q", got)
	}
}

func TestPptxResultToMarkdownVerticalTolerance(t *testing.T) {
	result := pptxPresentation(
		pptxShape("A", 0, 0, 100, 10),
		pptxShape("B", 100, 25, 100, 10),
	)
	ten := float64(10)
	fifteen := float64(15)
	if got := PptxResultToMarkdown(result, PptxConvertOptions{
		AbsoluteVerticalTolerance: &ten,
	}); got != "A\nB" {
		t.Fatalf("10 tolerance result = %q", got)
	}
	if got := PptxResultToMarkdown(result, PptxConvertOptions{
		AbsoluteVerticalTolerance: &fifteen,
	}); got != "A B" {
		t.Fatalf("15 tolerance result = %q", got)
	}
}

func TestPptxResultToMarkdownGroupTableAndImage(t *testing.T) {
	group := map[string]any{
		"type": "Group",
		"xfrm": map[string]any{"x": 100.0, "y": 0.0, "cx": 100.0, "cy": 120_000.0},
		"children": []any{
			pptxShape("组内一", 100, 0, 50, 20),
			pptxShape("组内二", 100, 100_000, 50, 20),
		},
	}
	table := map[string]any{
		"type": "Table",
		"xfrm": map[string]any{"x": 0.0, "y": 0.0, "cx": 80.0, "cy": 80.0},
		"table": map[string]any{"trs": []any{
			map[string]any{"cells": []any{
				map[string]any{"txBody": pptxTextBody("Name")},
				map[string]any{"txBody": pptxTextBody("Value")},
			}},
			map[string]any{"cells": []any{
				map[string]any{"txBody": pptxTextBody("A|B")},
				map[string]any{"txBody": pptxTextBody("10")},
			}},
		}},
	}
	image := map[string]any{
		"type":    "Picture",
		"xfrm":    map[string]any{"x": 220.0, "y": 0.0, "cx": 60.0, "cy": 60.0},
		"picture": map[string]any{"blip": "image"},
		"alt":     "示例]图",
	}
	result := pptxPresentation(table, group, image)
	result["files"] = map[string]any{"image": []any{"image 1.png", float64(6000), "hash"}}
	want := "| Name | Value |\n| --- | --- |\n| A\\|B | 10 |\n---\n组内一\n组内二\n---\n![示例\\]图](<image 1.png>)"
	if got := PptxResultToMarkdown(result); got != want {
		t.Fatalf("PptxResultToMarkdown() =\n%s\nwant:\n%s", got, want)
	}
}

func TestPptxResultToMarkdownInheritsPlaceholderTransform(t *testing.T) {
	result := PptxParseResult{
		"slides": []any{map[string]any{
			"_ref":       "slide1.xml",
			"_layoutRef": "layout1.xml",
			"_masterRef": "master1.xml",
			"spTree": []any{
				map[string]any{"type": "Shape", "ph": map[string]any{"idx": 1.0}, "txBody": pptxTextBody("右")},
				map[string]any{"type": "Shape", "xfrm": map[string]any{"x": 0.0, "y": 0.0, "cx": 10.0, "cy": 10.0}, "txBody": pptxTextBody("左")},
			},
		}},
		"slideMasters": []any{map[string]any{
			"_ref": "master1.xml",
			"slideLayouts": []any{map[string]any{
				"_ref": "layout1.xml",
				"spTree": []any{map[string]any{
					"ph":   map[string]any{"idx": 1.0},
					"xfrm": map[string]any{"x": 100.0, "y": 0.0, "cx": 10.0, "cy": 10.0},
				}},
			}},
		}},
	}
	if got := PptxResultToMarkdown(result); got != "左 右" {
		t.Fatalf("placeholder transform result = %q", got)
	}
}

func TestHTMLToMarkdown(t *testing.T) {
	source := `<!doctype html><html><head><title>探针标题</title></head><body>
		<nav>导航</nav><article><h1>正文标题</h1><p>正文内容</p>
		<img data-src="/lazy.png" src="">
		<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
		<noscript><img src="/fallback.png"></noscript></article><footer>页脚</footer></body></html>`
	got, err := HTMLToMarkdown(source, "https://example.com/posts/1")
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"# 探针标题",
		"# 正文标题",
		"正文内容",
		"![img](https://example.com/lazy.png)",
		"| A | B |",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("HTMLToMarkdown() missing %q:\n%s", expected, got)
		}
	}
	if strings.Contains(got, "导航") || strings.Contains(got, "页脚") || strings.Contains(got, "fallback") {
		t.Fatalf("HTMLToMarkdown() retained excluded content:\n%s", got)
	}
}

func TestParseDetailed(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/tools/tasks":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["type"] != string(TaskPDFParse) {
				t.Fatalf("task type = %#v", body["type"])
			}
			_, _ = w.Write([]byte(`{"id":"task-parse","type":"pdf.parse","status":"pending"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/tools/tasks/task-parse":
			_, _ = w.Write([]byte(`{"id":"task-parse","type":"pdf.parse","status":"completed"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/tools/tasks/task-parse/download":
			_, _ = w.Write([]byte(`{"textBlocks":[{"text":"标题","role":"heading","locator":{"pageIndex":0}}]}`))
		default:
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	result, err := deck.ParseDetailed(ctx, ParseInput{
		FileID: "file-1",
		Name:   "report.PDF",
		Wait: WaitForTaskOptions{
			DisableSSE:   true,
			Timeout:      time.Second,
			PollInterval: time.Millisecond,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Markdown != "## 标题" || result.TaskID != "task-parse" || result.Type != TaskPDFParse {
		t.Fatalf("unexpected parse result: %#v", result)
	}
}

func TestParseDetailedURL(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/tools/tasks":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			params, _ := body["params"].(map[string]any)
			if body["type"] != string(TaskHTMLGetByURL) ||
				params["url"] != "https://example.com/posts/1" ||
				params["mode"] != string(ParseModeRuntime) {
				t.Fatalf("unexpected html task body: %#v", body)
			}
			_, _ = w.Write([]byte(`{"id":"task-html","type":"html.getByURL","status":"pending"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/tools/tasks/task-html":
			_, _ = w.Write([]byte(`{"id":"task-html","type":"html.getByURL","status":"completed"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/tools/tasks/task-html/download":
			_, _ = w.Write([]byte(`{"html":"<html><head><title>T</title></head><body><article><p>正文内容足够长，用于正文抽取并验证链接解析逻辑。正文内容足够长，用于正文抽取并验证链接解析逻辑。</p><img src=\"/a.png\"></article></body></html>"}`))
		default:
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	result, err := deck.ParseDetailed(ctx, ParseInput{
		URL: "https://example.com/posts/1",
		Wait: WaitForTaskOptions{
			DisableSSE:   true,
			Timeout:      time.Second,
			PollInterval: time.Millisecond,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Type != TaskHTMLGetByURL ||
		!strings.Contains(result.Markdown, "# T") ||
		!strings.Contains(result.Markdown, "![img](https://example.com/a.png)") {
		t.Fatalf("unexpected URL parse result: %#v", result)
	}
}

func TestParserShortcuts(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var got []TaskType
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var body struct {
			Type TaskType `json:"type"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		got = append(got, body.Type)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task","status":"pending"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	params := TaskShortcutParams{}
	calls := []func() (*Task, error){
		func() (*Task, error) { return deck.PDFParse(ctx, params) },
		func() (*Task, error) { return deck.PptxParse(ctx, params) },
		func() (*Task, error) { return deck.DocxParse(ctx, params) },
		func() (*Task, error) { return deck.KeynoteParse(ctx, params) },
		func() (*Task, error) { return deck.HTMLGetByURL(ctx, params) },
	}
	for _, call := range calls {
		if _, err := call(); err != nil {
			t.Fatal(err)
		}
	}
	want := []TaskType{TaskPDFParse, TaskPptxParse, TaskDocxParse, TaskKeynoteParse, TaskHTMLGetByURL}
	if len(got) != len(want) {
		t.Fatalf("got %d shortcut calls, want %d", len(got), len(want))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("shortcut %d = %q, want %q", index, got[index], want[index])
		}
	}
}

func pptxPresentation(shapes ...map[string]any) PptxParseResult {
	items := make([]any, len(shapes))
	for index, shape := range shapes {
		items[index] = shape
	}
	return PptxParseResult{
		"slides": []any{map[string]any{
			"_ref":       "slide1.xml",
			"_layoutRef": "layout1.xml",
			"_masterRef": "master1.xml",
			"spTree":     items,
		}},
		"slideMasters": []any{},
		"files":        map[string]any{},
	}
}

func pptxShape(text string, left, top, width, height float64) map[string]any {
	shape := map[string]any{
		"type":   "Shape",
		"xfrm":   map[string]any{"x": left, "y": top, "cx": width, "cy": height},
		"txBody": pptxTextBody(text),
	}
	if text == "" {
		delete(shape, "txBody")
	}
	return shape
}

func pptxTextBody(text string) map[string]any {
	return map[string]any{
		"children": []any{map[string]any{
			"children": []any{map[string]any{"t": text}},
		}},
	}
}
