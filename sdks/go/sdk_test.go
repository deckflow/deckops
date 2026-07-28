package deckops

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const testAuthUUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

type memoryUUIDStorage struct {
	value string
}

func (s *memoryUUIDStorage) Get(context.Context) (string, error) {
	return s.value, nil
}

func (s *memoryUUIDStorage) Set(_ context.Context, value string) error {
	s.value = value
	return nil
}

func TestDefaultRoot(t *testing.T) {
	resetAuthUUIDCacheForTests()
	deck, err := New(context.Background(), ClientOptions{AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	if deck.Root() != DefaultRoot {
		t.Fatalf("root = %q, want %q", deck.Root(), DefaultRoot)
	}
}

func TestCreateTaskSendsAuthHeaders(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tools/tasks" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("X-Auth-Token"); got != "token-1" {
			t.Fatalf("token header = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer key-1" {
			t.Fatalf("authorization = %q", got)
		}
		if got := r.Header.Get("X-Auth-UUID"); got != testAuthUUID {
			t.Fatalf("auth uuid = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["spaceId"] != "space-1" || body["type"] != string(TaskConvertPptToPDF) || body["name"] != "slides" {
			t.Fatalf("unexpected body: %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task-1","spaceId":"space-1","type":"convertor.ppt2pdf","status":"pending"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		Token:    "token-1",
		APIKey:   "key-1",
		SpaceID:  "space-1",
		AuthUUID: testAuthUUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	task, err := deck.ConvertPptToPDF(ctx, TaskShortcutParams{FileIDs: []string{"file-1"}, Name: "slides"})
	if err != nil {
		t.Fatal(err)
	}
	if task.ID != "task-1" {
		t.Fatalf("task id = %q", task.ID)
	}
}

func TestResolveSpaceIDFromUserSelf(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/user":
			if got := r.Header.Get("X-Auth-Token"); got != "token-1" {
				t.Fatalf("token header = %q", got)
			}
			_, _ = w.Write([]byte(`{"id":"space-from-user"}`))
		case "/tools/tasks":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["spaceId"] != "space-from-user" {
				t.Fatalf("spaceId = %#v", body["spaceId"])
			}
			_, _ = w.Write([]byte(`{"id":"task-1","spaceId":"space-from-user","type":"convertor.ppt2pdf","status":"pending"}`))
		default:
			t.Fatalf("unexpected path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		Token:    "token-1",
		AuthUUID: testAuthUUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	task, err := deck.ConvertPptToPDF(ctx, TaskShortcutParams{FileIDs: []string{"file-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if task.ID != "task-1" {
		t.Fatalf("task id = %q", task.ID)
	}
}

func TestListGetDeleteAndWait(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/tools/tasks":
			w.Header().Set("X-Content-Record-Total", "1")
			_, _ = w.Write([]byte(`[{"id":"task-1","spaceId":"space-1","type":"image.ocr","status":"pending"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/tools/tasks/task-1":
			_, _ = w.Write([]byte(`{"id":"task-1","spaceId":"space-1","type":"image.ocr","status":"completed"}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/tools/tasks/task-1":
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	list, err := deck.Tasks.List(ctx, ListTasksParams{})
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 || list.Tasks[0].ID != "task-1" {
		t.Fatalf("unexpected list: %#v", list)
	}
	got, err := deck.Tasks.Get(ctx, "task-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != TaskStatusCompleted {
		t.Fatalf("status = %s", got.Status)
	}
	waited, err := deck.Tasks.Wait(ctx, "task-1", WaitForTaskOptions{DisableSSE: true, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if waited.Status != TaskStatusCompleted {
		t.Fatalf("waited status = %s", waited.Status)
	}
	if err := deck.Tasks.Delete(ctx, "task-1"); err != nil {
		t.Fatal(err)
	}
}

func TestUploadDeduplicatedFile(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/spaces/space-1/file/auth" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["name"] != "a.txt" || int(body["bytes"].(float64)) != 3 || body["hash"] != "900150983cd24fb0d6963f7d28e17f72" {
			t.Fatalf("unexpected auth body: %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-1","key":"files/a.txt","hash":"900150983cd24fb0d6963f7d28e17f72","platform":"oss","multipart":false}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	result, err := deck.Files.Upload(ctx, UploadInput{Name: "a.txt", Data: []byte("abc")}, UploadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "file-1" {
		t.Fatalf("file id = %q", result.ID)
	}
}

func TestTaskHelperUploadsBeforeCreate(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/spaces/space-1/file/auth":
			_, _ = w.Write([]byte(`{"id":"uploaded-file-1","key":"files/slides.pptx","hash":"900150983cd24fb0d6963f7d28e17f72","platform":"oss","multipart":false}`))
		case "/tools/tasks":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			fileIDs := body["fileIds"].([]any)
			if len(fileIDs) != 2 || fileIDs[0] != "existing-file" || fileIDs[1] != "uploaded-file-1" {
				t.Fatalf("unexpected fileIds: %#v", fileIDs)
			}
			_, _ = w.Write([]byte(`{"id":"task-1","spaceId":"space-1","type":"convertor.ppt2pdf","status":"pending","fileIds":["existing-file","uploaded-file-1"]}`))
		default:
			t.Fatalf("unexpected path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	task, err := deck.ConvertPptToPDF(ctx, TaskShortcutParams{
		FileIDs: []string{"existing-file"},
		Files: []TaskUploadInput{{
			Input:   UploadInput{Data: []byte("abc")},
			Options: UploadOptions{Name: "slides.pptx"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(task.FileIDs) != 2 {
		t.Fatalf("file ids = %#v", task.FileIDs)
	}
}

func TestUnauthorizedRefreshesCredentials(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"expired"}`))
			return
		}
		if got := r.Header.Get("X-Auth-Token"); got != "new-token" {
			t.Fatalf("token = %q", got)
		}
		if got := r.URL.Query().Get("spaceId"); got != "space-new" {
			t.Fatalf("spaceId = %q", got)
		}
		_, _ = w.Write([]byte(`{"id":"task-1","spaceId":"space-new","type":"image.ocr","status":"completed"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		Token:    "old-token",
		SpaceID:  "space-old",
		AuthUUID: testAuthUUID,
		OnUnauthorized: func(context.Context) (AuthRefresh, error) {
			return AuthRefresh{Token: "new-token", SpaceID: "space-new"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deck.Tasks.Get(ctx, "task-1", false); err != nil {
		t.Fatal(err)
	}
}

func TestUnauthorizedDedupesConcurrentRefresh(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	refreshCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("X-Auth-Token") == "old-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"expired"}`))
			return
		}
		if got := r.Header.Get("X-Auth-Token"); got != "new-token" {
			t.Fatalf("token = %q", got)
		}
		taskID := strings.TrimPrefix(r.URL.Path, "/tools/tasks/")
		_, _ = w.Write([]byte(`{"id":"` + taskID + `","spaceId":"space-new","type":"image.ocr","status":"completed"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		Token:    "old-token",
		SpaceID:  "space-old",
		AuthUUID: testAuthUUID,
		OnUnauthorized: func(context.Context) (AuthRefresh, error) {
			refreshCalls++
			time.Sleep(20 * time.Millisecond)
			return AuthRefresh{Token: "new-token", SpaceID: "space-new"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	errCh := make(chan error, 2)
	go func() {
		_, err := deck.Tasks.Get(ctx, "task-1", false)
		errCh <- err
	}()
	go func() {
		_, err := deck.Tasks.Get(ctx, "task-2", false)
		errCh <- err
	}()
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
	if refreshCalls != 1 {
		t.Fatalf("refresh calls = %d, want 1", refreshCalls)
	}
}

func TestAuthUUIDStorage(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	storage := &memoryUUIDStorage{}
	deck, err := New(ctx, ClientOptions{AuthUUIDStorage: storage})
	if err != nil {
		t.Fatal(err)
	}
	if !IsValidAuthUUID(deck.AuthUUID()) {
		t.Fatalf("invalid auth uuid: %q", deck.AuthUUID())
	}
	if storage.value != deck.AuthUUID() {
		t.Fatalf("stored = %q, uuid = %q", storage.value, deck.AuthUUID())
	}

	again, err := New(ctx, ClientOptions{AuthUUIDStorage: storage})
	if err != nil {
		t.Fatal(err)
	}
	if again.AuthUUID() != storage.value {
		t.Fatalf("uuid was not reused")
	}
}

func TestMain(m *testing.M) {
	oldConfigDir := os.Getenv("DECKOPS_CONFIG_DIR")
	oldAuthUUID := os.Getenv("DECKOPS_AUTH_UUID")
	tempDir, err := os.MkdirTemp("", "deckops-go-sdk-test-*")
	if err != nil {
		panic(err)
	}
	_ = os.Setenv("DECKOPS_CONFIG_DIR", tempDir)
	_ = os.Unsetenv("DECKOPS_AUTH_UUID")
	code := m.Run()
	if oldConfigDir == "" {
		_ = os.Unsetenv("DECKOPS_CONFIG_DIR")
	} else {
		_ = os.Setenv("DECKOPS_CONFIG_DIR", oldConfigDir)
	}
	if oldAuthUUID == "" {
		_ = os.Unsetenv("DECKOPS_AUTH_UUID")
	} else {
		_ = os.Setenv("DECKOPS_AUTH_UUID", oldAuthUUID)
	}
	_ = os.RemoveAll(tempDir)
	os.Exit(code)
}

func TestParseSSE(t *testing.T) {
	var got Task
	err := parseSSE(strings.NewReader("data: {\"id\":\"task-1\",\"status\":\"completed\"}\n\n"), func(data string) bool {
		if err := json.Unmarshal([]byte(data), &got); err != nil {
			t.Fatal(err)
		}
		return got.Status == TaskStatusCompleted
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "task-1" {
		t.Fatalf("task id = %q", got.ID)
	}
}

func TestUnauthorizedAPIKeyPromptsReset(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req-auth-1")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"invalid key"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		APIKey:   "key-1",
		SpaceID:  "space-1",
		AuthUUID: testAuthUUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = deck.Tasks.Get(ctx, "task-1", false)
	if err == nil {
		t.Fatal("expected unauthorized api key error")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", apiErr.StatusCode)
	}
	if apiErr.RequestID != "req-auth-1" {
		t.Fatalf("request id = %q", apiErr.RequestID)
	}
	if !strings.Contains(apiErr.Error(), "API key") {
		t.Fatalf("message = %q", apiErr.Error())
	}
}

func TestAPIErrorIncludesRequestID(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req-404-1")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"task not found"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		Token:    "token-1",
		SpaceID:  "space-1",
		AuthUUID: testAuthUUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = deck.Tasks.Get(ctx, "task-1", false)
	if err == nil {
		t.Fatal("expected not found error")
	}
	if !strings.Contains(err.Error(), "X-RequestId: req-404-1") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestRetryBadGateway(t *testing.T) {
	resetAuthUUIDCacheForTests()
	oldDelays := retryDelays
	retryDelays = []int{0, 0, 0}
	defer func() { retryDelays = oldDelays }()

	ctx := context.Background()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if calls <= 3 {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"message":"bad gateway"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"task-1","spaceId":"space-1","type":"image.ocr","status":"completed"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		Token:    "token-1",
		SpaceID:  "space-1",
		AuthUUID: testAuthUUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deck.Tasks.Get(ctx, "task-1", false); err != nil {
		t.Fatal(err)
	}
	if calls != 4 {
		t.Fatalf("calls = %d, want 4", calls)
	}
}

func TestGuestModeCreateResolvesSpaceFromUser(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("X-Auth-Token") != "" || r.Header.Get("Authorization") != "" {
			t.Fatalf("guest request should not send token/api key")
		}
		if r.Header.Get("X-Auth-UUID") != testAuthUUID {
			t.Fatalf("X-Auth-UUID = %q", r.Header.Get("X-Auth-UUID"))
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/user":
			_, _ = w.Write([]byte(`{"id":"guest-space"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/tools/tasks":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["spaceId"] != "guest-space" {
				t.Fatalf("spaceId = %#v", body["spaceId"])
			}
			_, _ = w.Write([]byte(`{"id":"task-guest","spaceId":"guest-space","type":"convertor.ppt2pdf","status":"pending"}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	task, err := deck.ConvertPptToPDF(ctx, TaskShortcutParams{FileIDs: []string{"file-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if task.ID != "task-guest" {
		t.Fatalf("task id = %q", task.ID)
	}
}

func TestTaskStart(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var started bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPut || r.URL.Path != "/tools/tasks/task-1/start" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("spaceId") != "space-1" {
			t.Fatalf("spaceId query = %q", r.URL.Query().Get("spaceId"))
		}
		started = true
		_, _ = w.Write([]byte(`{"id":"task-1","spaceId":"space-1","type":"image.ocr","status":"running"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	task, err := deck.Tasks.Start(ctx, "task-1")
	if err != nil {
		t.Fatal(err)
	}
	if !started || task.Status != TaskStatusRunning {
		t.Fatalf("started=%v status=%s", started, task.Status)
	}
}

func TestTaskStartAllowsEmptyBody(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/tools/tasks/task-1/start" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	task, err := deck.Tasks.Start(ctx, "task-1")
	if err != nil {
		t.Fatal(err)
	}
	if task == nil {
		t.Fatal("expected non-nil task")
	}
	if task.ID != "" || task.Status != "" {
		t.Fatalf("expected empty task for empty body, got %#v", task)
	}
}

func TestWaitReturnsImmediatelyWhenAlreadyCompleted(t *testing.T) {
	resetAuthUUIDCacheForTests()
	ctx := context.Background()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("response-event-stream") == "yes" {
			t.Fatal("SSE should not be requested when task is already completed")
		}
		_, _ = w.Write([]byte(`{"id":"task-done","spaceId":"space-1","type":"image.ocr","status":"completed"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{Root: server.URL, SpaceID: "space-1", AuthUUID: testAuthUUID})
	if err != nil {
		t.Fatal(err)
	}
	task, err := deck.Tasks.Wait(ctx, "task-done", WaitForTaskOptions{Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != TaskStatusCompleted {
		t.Fatalf("status = %s", task.Status)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
}

func TestDoesNotRetryForbidden(t *testing.T) {
	resetAuthUUIDCacheForTests()
	oldDelays := retryDelays
	retryDelays = []int{0, 0, 0}
	defer func() { retryDelays = oldDelays }()

	ctx := context.Background()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req-403-1")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"forbidden"}`))
	}))
	defer server.Close()

	deck, err := New(ctx, ClientOptions{
		Root:     server.URL,
		Token:    "token-1",
		SpaceID:  "space-1",
		AuthUUID: testAuthUUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = deck.Tasks.Down(ctx, "task-1", TaskDownloadOptions{}, &map[string]any{})
	if err == nil {
		t.Fatal("expected forbidden error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusForbidden {
		t.Fatalf("error = %#v", err)
	}
	if !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("error = %q", err.Error())
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	if IsRetriableError(err) {
		t.Fatal("403 should not be retriable")
	}
}
