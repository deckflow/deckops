package deckops

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	StatusUpstreamUnavailable = 604
)

var retryDelays = []int{5, 10, 20}

func retryDelayForAttempt(attempt int) time.Duration {
	if attempt < 0 || attempt >= len(retryDelays) {
		return 0
	}
	return time.Duration(retryDelays[attempt]) * time.Second
}

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

func isRetriableStatus(status int) bool {
	return status == StatusUpstreamUnavailable || status == http.StatusBadGateway
}

func isRetriableTransportError(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return isRetriableStatus(apiErr.StatusCode)
	}
	return true
}

func unauthorizedAPIKeyError(base *APIError) *APIError {
	return &APIError{
		StatusCode: http.StatusUnauthorized,
		RequestID:  base.RequestID,
		Message:    "Authentication failed. Please update your API key.",
	}
}

func unauthorizedTokenError(base *APIError) *APIError {
	return &APIError{
		StatusCode: http.StatusUnauthorized,
		RequestID:  base.RequestID,
		Message:    "Authentication expired. Please log in again.",
	}
}

func paymentRequiredError(base *APIError) *APIError {
	return &APIError{
		StatusCode: http.StatusPaymentRequired,
		RequestID:  base.RequestID,
		Message:    "Payment is required. Please complete checkout and try again.",
	}
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
