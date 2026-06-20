package deckops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type httpClient struct {
	root              string
	token             string
	apiKey            string
	spaceID           string
	authUUID          string
	client            *http.Client
	onUnauthorized    func(context.Context) (AuthRefresh, error)
	onPaymentRequired func(context.Context) error
	mu                sync.RWMutex
}

type httpResponse struct {
	Header http.Header
	Body   []byte
	Stream io.ReadCloser
}

func newHTTPClient(ctx context.Context, options ClientOptions) (*httpClient, error) {
	root := strings.TrimRight(options.Root, "/")
	if root == "" {
		root = DefaultRoot
	}
	authUUID, err := resolveAuthUUID(ctx, options)
	if err != nil {
		return nil, err
	}
	c := options.HTTPClient
	if c == nil {
		c = &http.Client{Timeout: 30 * time.Second}
	}
	return &httpClient{
		root:              root,
		token:             options.Token,
		apiKey:            options.APIKey,
		spaceID:           options.SpaceID,
		authUUID:          authUUID,
		client:            c,
		onUnauthorized:    options.OnUnauthorized,
		onPaymentRequired: options.OnPaymentRequired,
	}, nil
}

func (c *httpClient) Root() string {
	return c.root
}

func (c *httpClient) SetToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = token
}

func (c *httpClient) SetAPIKey(apiKey string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.apiKey = apiKey
}

func (c *httpClient) SetSpaceID(spaceID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spaceID = spaceID
}

func (c *httpClient) SpaceID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.spaceID
}

func (c *httpClient) AuthUUID() string {
	return c.authUUID
}

func (c *httpClient) getJSON(ctx context.Context, path string, query url.Values, headers http.Header, out any) (*httpResponse, error) {
	res, err := c.do(ctx, http.MethodGet, path, query, headers, nil, false)
	if err != nil {
		return nil, err
	}
	if out != nil {
		if err := json.Unmarshal(res.Body, out); err != nil {
			return nil, err
		}
	}
	return res, nil
}

func (c *httpClient) postJSON(ctx context.Context, path string, in any, out any) (*httpResponse, error) {
	var body []byte
	var err error
	if in != nil {
		body, err = json.Marshal(in)
		if err != nil {
			return nil, err
		}
	}
	res, err := c.do(ctx, http.MethodPost, path, nil, nil, body, false)
	if err != nil {
		return nil, err
	}
	if out != nil {
		if err := json.Unmarshal(res.Body, out); err != nil {
			return nil, err
		}
	}
	return res, nil
}

func (c *httpClient) delete(ctx context.Context, path string, query url.Values) error {
	_, err := c.do(ctx, http.MethodDelete, path, query, nil, nil, false)
	return err
}

func (c *httpClient) eventStream(ctx context.Context, path string, query url.Values, headers http.Header) (*httpResponse, error) {
	return c.do(ctx, http.MethodGet, path, query, headers, nil, true)
}

func (c *httpClient) do(ctx context.Context, method string, path string, query url.Values, headers http.Header, body []byte, stream bool) (*httpResponse, error) {
	var paymentRetried, authRetried bool
	var lastErr error

	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			delay := time.Duration(math.Pow(2, float64(attempt-1)) * float64(100*time.Millisecond))
			if err := sleepContext(ctx, delay); err != nil {
				return nil, err
			}
		}

		res, err := c.doOnce(ctx, method, path, query, headers, body, stream)
		if err == nil {
			return res, nil
		}
		lastErr = err

		var apiErr *APIError
		if errors.As(err, &apiErr) {
			if apiErr.StatusCode == http.StatusPaymentRequired && c.onPaymentRequired != nil && !paymentRetried {
				paymentRetried = true
				if err := c.onPaymentRequired(ctx); err != nil {
					return nil, err
				}
				attempt = -1
				continue
			}
			if apiErr.StatusCode == http.StatusUnauthorized && c.onUnauthorized != nil && !authRetried {
				authRetried = true
				oldSpaceID := c.SpaceID()
				auth, err := c.onUnauthorized(ctx)
				if err != nil {
					return nil, err
				}
				c.SetToken(auth.Token)
				if auth.SpaceID != "" {
					c.SetSpaceID(auth.SpaceID)
					body = rewriteSpaceID(query, body, oldSpaceID, auth.SpaceID)
				}
				attempt = -1
				continue
			}
			if !isRetriableStatus(apiErr.StatusCode) {
				return nil, err
			}
			continue
		}
	}
	return nil, lastErr
}

func (c *httpClient) doOnce(ctx context.Context, method string, path string, query url.Values, headers http.Header, body []byte, stream bool) (*httpResponse, error) {
	u, err := url.Parse(c.root + "/" + strings.TrimLeft(path, "/"))
	if err != nil {
		return nil, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, err
	}
	c.applyHeaders(req.Header)
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, newAPIError(resp, data)
	}
	if stream {
		return &httpResponse{Header: resp.Header.Clone(), Stream: resp.Body}, nil
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return &httpResponse{Header: resp.Header.Clone(), Body: data}, nil
}

func (c *httpClient) applyHeaders(headers http.Header) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Auth-UUID", c.authUUID)
	if c.token != "" {
		headers.Set("X-Auth-Token", c.token)
	}
	if c.apiKey != "" {
		headers.Set("Authorization", "Bearer "+c.apiKey)
	}
}

func isRetriableStatus(status int) bool {
	switch status {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func rewriteSpaceID(query url.Values, body []byte, oldSpaceID string, newSpaceID string) []byte {
	if oldSpaceID == "" || newSpaceID == "" || oldSpaceID == newSpaceID {
		return body
	}
	if query != nil && query.Get("spaceId") == oldSpaceID {
		query.Set("spaceId", newSpaceID)
	}
	if len(body) == 0 {
		return body
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) == nil && payload["spaceId"] == oldSpaceID {
		payload["spaceId"] = newSpaceID
		next, err := json.Marshal(payload)
		if err == nil {
			return next
		}
	}
	return body
}

func isEventStream(headers http.Header) bool {
	contentType := strings.ToLower(headers.Get("Content-Type"))
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err == nil {
		contentType = mediaType
	}
	return strings.Contains(contentType, "event-stream")
}
