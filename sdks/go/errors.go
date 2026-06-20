package deckops

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type APIError struct {
	StatusCode   int
	ResponseData any
	RequestID    string
	Message      string
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	if e.RequestID != "" {
		return fmt.Sprintf("API Error (%d): %s [X-RequestId: %s]", e.StatusCode, e.Message, e.RequestID)
	}
	if e.StatusCode == 0 {
		return fmt.Sprintf("API Error (unknown): %s", e.Message)
	}
	return fmt.Sprintf("API Error (%d): %s", e.StatusCode, e.Message)
}

func newAPIError(resp *http.Response, body []byte) *APIError {
	msg := strings.TrimSpace(string(body))
	var data any
	if len(body) > 0 && json.Unmarshal(body, &data) == nil {
		if m, ok := data.(map[string]any); ok {
			for _, key := range []string{"message", "error", "msg"} {
				if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
					msg = strings.TrimSpace(v)
					break
				}
			}
		}
	}
	if msg == "" {
		msg = resp.Status
	}
	if len(msg) > 500 {
		msg = msg[:500] + "..."
	}
	return &APIError{
		StatusCode:   resp.StatusCode,
		ResponseData: data,
		RequestID:    extractRequestID(resp, data),
		Message:      msg,
	}
}

func extractRequestID(resp *http.Response, data any) string {
	for _, name := range []string{"X-Request-Id", "X-RequestId", "X-RequestID", "Request-Id"} {
		if v := strings.TrimSpace(resp.Header.Get(name)); v != "" {
			return v
		}
	}
	m, ok := data.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"requestId", "request_id", "RequestId", "xRequestId", "XRequestId", "traceId", "trace_id", "TraceId", "correlationId", "correlation_id"} {
		if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
