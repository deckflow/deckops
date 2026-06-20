package deckops

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	sseRetryInterval = 5 * time.Second
	sseMaxRetries    = 100
)

type TasksClient struct {
	http  *httpClient
	files *FilesClient
}

func (t *TasksClient) Create(ctx context.Context, params CreateTaskParams) (*Task, error) {
	spaceID, err := t.requireSpaceID(params.SpaceID)
	if err != nil {
		return nil, err
	}
	fileIDs, err := t.resolveFileIDs(ctx, spaceID, params)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"spaceId": spaceID,
		"fileIds": fileIDs,
		"type":    params.Type,
		"params":  params.Params,
	}
	if payload["params"] == nil {
		payload["params"] = map[string]any{}
	}
	if params.Name != "" {
		payload["name"] = params.Name
	}

	var task Task
	if _, err := t.http.postJSON(ctx, "/tools/tasks", payload, &task); err != nil {
		return nil, err
	}
	return &task, nil
}

func (t *TasksClient) List(ctx context.Context, params ListTasksParams) (*TaskListResponse, error) {
	spaceID, err := t.requireSpaceID(params.SpaceID)
	if err != nil {
		return nil, err
	}
	query := url.Values{}
	query.Set("spaceId", spaceID)
	if params.HasStart {
		query.Set("_startIndex", strconv.Itoa(params.StartIndex))
	} else {
		query.Set("_startIndex", "0")
	}
	if params.HasMax {
		query.Set("_maxResults", strconv.Itoa(params.MaxResults))
	} else {
		query.Set("_maxResults", "50")
	}
	if params.Type != "" {
		query.Set("type", string(params.Type))
	}

	var tasks []Task
	res, err := t.http.getJSON(ctx, "/tools/tasks", query, nil, &tasks)
	if err != nil {
		return nil, err
	}
	total := len(tasks)
	if raw := res.Header.Get("X-Content-Record-Total"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			total = parsed
		}
	}
	return &TaskListResponse{Tasks: tasks, Total: total}, nil
}

func (t *TasksClient) Get(ctx context.Context, taskID string, useEventStream bool) (*Task, error) {
	headers := http.Header{}
	if useEventStream {
		headers.Set("response-event-stream", "yes")
	}
	res, err := t.http.getJSON(ctx, "/tools/tasks/"+urlPathEscape(taskID), t.taskQueryParams(), headers, nil)
	if err != nil {
		return nil, err
	}
	if isEventStream(res.Header) {
		return firstTaskFromSSEBytes(res.Body)
	}
	var task Task
	if err := json.Unmarshal(res.Body, &task); err != nil {
		return nil, err
	}
	return &task, nil
}

func (t *TasksClient) Delete(ctx context.Context, taskID string) error {
	return t.http.delete(ctx, "/tools/tasks/"+urlPathEscape(taskID), t.taskQueryParams())
}

func (t *TasksClient) Down(ctx context.Context, taskID string, options TaskDownloadOptions, out any) error {
	query := url.Values{}
	if options.Type != "" {
		query.Set("_type", options.Type)
	}
	var q url.Values
	if len(query) > 0 {
		q = query
	}
	_, err := t.http.getJSON(ctx, "/tools/tasks/"+urlPathEscape(taskID)+"/download", q, nil, out)
	return err
}

func (t *TasksClient) Wait(ctx context.Context, taskID string, options WaitForTaskOptions) (*Task, error) {
	timeout := options.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if !options.DisableSSE {
		task, err := t.waitWithEventStream(ctx, taskID, options.OnProgress)
		if err == nil {
			return task, nil
		}
	}

	interval := options.PollInterval
	if interval == 0 {
		interval = DefaultPollInterval
	}
	return t.waitWithPolling(ctx, taskID, interval, options.OnProgress)
}

func (t *TasksClient) Subscribe(ctx context.Context, taskID string, handlers SubscribeTaskHandlers) (func(), error) {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		retryCount := 0
		for {
			err := t.openTaskEventStream(ctx, taskID, handlers)
			if err == nil || ctx.Err() != nil {
				return
			}
			if !isSSETransportError(err) || retryCount >= sseMaxRetries {
				if handlers.OnError != nil {
					handlers.OnError(err)
				}
				return
			}
			retryCount++
			if err := sleepContext(ctx, sseRetryInterval); err != nil {
				return
			}
		}
	}()
	return cancel, nil
}

func (t *TasksClient) resolveFileIDs(ctx context.Context, spaceID string, params CreateTaskParams) ([]string, error) {
	fileIDs := append([]string(nil), params.FileIDs...)
	for _, file := range params.Files {
		if t.files == nil {
			return nil, fmt.Errorf("file upload is not available for this task client")
		}
		options := mergeUploadOptions(params.Upload, file.Options)
		options.SpaceID = spaceID
		result, err := t.files.Upload(ctx, file.Input, options)
		if err != nil {
			return nil, err
		}
		fileIDs = append(fileIDs, result.ID)
	}
	return fileIDs, nil
}

func (t *TasksClient) openTaskEventStream(ctx context.Context, taskID string, handlers SubscribeTaskHandlers) error {
	headers := http.Header{}
	headers.Set("response-event-stream", "yes")
	res, err := t.http.eventStream(ctx, "/tools/tasks/"+urlPathEscape(taskID), t.taskQueryParams(), headers)
	if err != nil {
		return err
	}
	defer res.Stream.Close()

	if !isEventStream(res.Header) {
		if strings.Contains(strings.ToLower(res.Header.Get("Content-Type")), "application/json") {
			var task Task
			data, err := io.ReadAll(res.Stream)
			if err != nil {
				return err
			}
			if err := json.Unmarshal(data, &task); err != nil {
				return err
			}
			if handlers.OnUpdate != nil {
				handlers.OnUpdate(task)
			}
			return nil
		}
		return fmt.Errorf("unexpected Content-Type: %s", res.Header.Get("Content-Type"))
	}

	return parseSSE(res.Stream, func(data string) bool {
		var task Task
		if err := json.Unmarshal([]byte(data), &task); err != nil {
			if handlers.OnError != nil {
				handlers.OnError(err)
			}
			return false
		}
		if handlers.OnUpdate != nil {
			handlers.OnUpdate(task)
		}
		return task.Status == TaskStatusCompleted || task.Status == TaskStatusFailed
	})
}

func (t *TasksClient) waitWithEventStream(ctx context.Context, taskID string, onProgress func(Task)) (*Task, error) {
	type waitResult struct {
		task *Task
		err  error
	}
	done := make(chan waitResult, 1)
	send := func(result waitResult) {
		select {
		case done <- result:
		default:
		}
	}
	cancel, err := t.Subscribe(ctx, taskID, SubscribeTaskHandlers{
		OnUpdate: func(task Task) {
			if onProgress != nil {
				onProgress(task)
			}
			if task.Status == TaskStatusCompleted {
				send(waitResult{task: &task})
			} else if task.Status == TaskStatusFailed {
				send(waitResult{err: fmt.Errorf("task failed: %s", firstNonEmpty(task.Error, "Unknown error"))})
			}
		},
		OnError: func(err error) {
			send(waitResult{err: err})
		},
	})
	if err != nil {
		return nil, err
	}
	defer cancel()

	select {
	case result := <-done:
		return result.task, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *TasksClient) waitWithPolling(ctx context.Context, taskID string, interval time.Duration, onProgress func(Task)) (*Task, error) {
	for {
		task, err := t.Get(ctx, taskID, false)
		if err != nil {
			return nil, err
		}
		if onProgress != nil {
			onProgress(*task)
		}
		switch task.Status {
		case TaskStatusCompleted:
			return task, nil
		case TaskStatusFailed:
			return nil, fmt.Errorf("task failed: %s", firstNonEmpty(task.Error, "Unknown error"))
		}
		if err := sleepContext(ctx, interval); err != nil {
			return nil, err
		}
	}
}

func (t *TasksClient) requireSpaceID(spaceID string) (string, error) {
	if spaceID == "" {
		spaceID = t.http.SpaceID()
	}
	if spaceID == "" {
		return "", fmt.Errorf("spaceId is required")
	}
	return spaceID, nil
}

func (t *TasksClient) taskQueryParams() url.Values {
	spaceID := t.http.SpaceID()
	if spaceID == "" {
		return nil
	}
	query := url.Values{}
	query.Set("spaceId", spaceID)
	return query
}

func parseSSE(r io.Reader, onEvent func(data string) bool) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	var dataLines []string
	flush := func() bool {
		if len(dataLines) == 0 {
			return false
		}
		data := strings.Join(dataLines, "\n")
		dataLines = nil
		return onEvent(data)
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if flush() {
				return nil
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if flush() {
		return nil
	}
	return fmt.Errorf("SSE connection ended before task completion")
}

func firstTaskFromSSEBytes(data []byte) (*Task, error) {
	var found *Task
	err := parseSSE(strings.NewReader(string(data)), func(raw string) bool {
		var task Task
		if json.Unmarshal([]byte(raw), &task) == nil {
			found = &task
			return true
		}
		return false
	})
	if found != nil {
		return found, nil
	}
	return nil, err
}

func isSSETransportError(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return false
	}
	return !strings.HasPrefix(err.Error(), "unexpected Content-Type:")
}

func mergeUploadOptions(defaults UploadOptions, override UploadOptions) UploadOptions {
	out := defaults
	if override.SpaceID != "" {
		out.SpaceID = override.SpaceID
	}
	if override.Name != "" {
		out.Name = override.Name
	}
	if override.Hash != "" {
		out.Hash = override.Hash
	}
	if override.ChunkSize != 0 {
		out.ChunkSize = override.ChunkSize
	}
	if override.OnProgress != nil {
		out.OnProgress = override.OnProgress
	}
	return out
}

func urlPathEscape(value string) string {
	return url.PathEscape(value)
}
