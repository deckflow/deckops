package deckops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	spaceIDExplicit   bool
	authUUID          string
	client            *http.Client
	onUnauthorized    func(context.Context) (AuthRefresh, error)
	onPaymentRequired func(context.Context) error
	mu                sync.RWMutex
	authRefreshMu     sync.Mutex
	authRefreshWait   *authRefreshWaiter
	guestDowngradeMu  sync.Mutex
	guestDowngradeWait *guestDowngradeWaiter
	authDowngradedToGuest bool
}

type authRefreshWaiter struct {
	done chan struct{}
	auth AuthRefresh
	err  error
}

type guestDowngradeWaiter struct {
	done    chan struct{}
	spaceID string
	err     error
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
		spaceIDExplicit:   options.SpaceID != "",
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
	if token != "" {
		c.authDowngradedToGuest = false
	}
	c.clearAutoResolvedSpaceID()
}

func (c *httpClient) SetAPIKey(apiKey string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.apiKey = apiKey
	if apiKey != "" {
		c.authDowngradedToGuest = false
	}
	c.clearAutoResolvedSpaceID()
}

func (c *httpClient) SetSpaceID(spaceID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spaceID = spaceID
	c.spaceIDExplicit = spaceID != ""
}

func (c *httpClient) SpaceID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.spaceID
}

func (c *httpClient) ResolveSpaceID(ctx context.Context, spaceID string) (string, error) {
	if spaceID != "" {
		return spaceID, nil
	}

	c.mu.RLock()
	if c.spaceID != "" {
		id := c.spaceID
		c.mu.RUnlock()
		return id, nil
	}
	c.mu.RUnlock()

	// Resolve from GET /user. The endpoint only requires X-Auth-UUID, so
	// it works for both authenticated users and guests.
	var user UserSelf
	if _, err := c.getJSON(ctx, "/user", nil, nil, &user); err != nil {
		return "", err
	}
	if user.ID == "" {
		return "", fmt.Errorf("user.self did not return an id")
	}

	c.mu.Lock()
	if c.spaceID == "" {
		c.spaceID = user.ID
	}
	id := c.spaceID
	c.mu.Unlock()
	return id, nil
}

func (c *httpClient) clearAutoResolvedSpaceID() {
	if c.spaceIDExplicit {
		return
	}
	c.spaceID = ""
}

func (c *httpClient) AuthUUID() string {
	return c.authUUID
}

func (c *httpClient) getJSON(ctx context.Context, path string, query url.Values, headers http.Header, out any) (*httpResponse, error) {
	res, err := c.do(ctx, http.MethodGet, path, query, headers, nil, false)
	if err != nil {
		return nil, err
	}
	if err := decodeJSONBody(res.Body, out); err != nil {
		return nil, err
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
	if err := decodeJSONBody(res.Body, out); err != nil {
		return nil, err
	}
	return res, nil
}

func (c *httpClient) putJSON(ctx context.Context, path string, query url.Values, in any, out any) (*httpResponse, error) {
	var body []byte
	var err error
	if in != nil {
		body, err = json.Marshal(in)
		if err != nil {
			return nil, err
		}
	}
	res, err := c.do(ctx, http.MethodPut, path, query, nil, body, false)
	if err != nil {
		return nil, err
	}
	if err := decodeJSONBody(res.Body, out); err != nil {
		return nil, err
	}
	return res, nil
}

// decodeJSONBody unmarshals JSON into out. Empty bodies (common for 204 / start)
// are treated as success and leave out unchanged.
func decodeJSONBody(body []byte, out any) error {
	if out == nil || len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	return json.Unmarshal(body, out)
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

	for attempt := 0; attempt <= len(retryDelays); attempt++ {
		if attempt > 0 {
			delay := retryDelayForAttempt(attempt - 1)
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
			if apiErr.StatusCode == http.StatusPaymentRequired && !paymentRetried {
				if c.onPaymentRequired != nil {
					paymentRetried = true
					if err := c.onPaymentRequired(ctx); err != nil {
						return nil, err
					}
					attempt = -1
					continue
				}
				return nil, paymentRequiredError(apiErr)
			}
			if apiErr.StatusCode == http.StatusUnauthorized && !authRetried {
				authRetried = true
				oldSpaceID := spaceIDFromRequest(path, query, body)
				if oldSpaceID == "" {
					oldSpaceID = c.SpaceID()
				}

				if c.onUnauthorized != nil && c.hasUserToken() && !c.usesAPIKeyAuth() {
					auth, refreshErr := c.refreshAuth(ctx)
					if refreshErr == nil {
						c.SetToken(auth.Token)
						if auth.SpaceID != "" {
							c.SetSpaceID(auth.SpaceID)
						}
						path, body = rewriteSpaceID(path, query, body, oldSpaceID, auth.SpaceID)
						attempt = -1
						continue
					}
					// Refresh failed — fall through to guest mode.
				}

				if c.hasCredentials() || c.isAuthDowngradedToGuest() || c.hasGuestDowngradeInFlight() {
					guestSpaceID, guestErr := c.ensureGuestMode(ctx)
					if guestErr != nil {
						return nil, guestErr
					}
					path, body = rewriteSpaceID(path, query, body, oldSpaceID, guestSpaceID)
					attempt = -1
					continue
				}
				return nil, apiErr
			}
			if !isRetriableStatus(apiErr.StatusCode) {
				return nil, err
			}
			continue
		}

		if !isRetriableTransportError(err) || attempt >= len(retryDelays) {
			return nil, err
		}
	}
	return nil, lastErr
}

func (c *httpClient) usesAPIKeyAuth() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.apiKey != "" && c.token == ""
}

func (c *httpClient) hasUserToken() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token != ""
}

func (c *httpClient) hasCredentials() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token != "" || c.apiKey != ""
}

func (c *httpClient) isAuthDowngradedToGuest() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.authDowngradedToGuest
}

func (c *httpClient) hasGuestDowngradeInFlight() bool {
	c.guestDowngradeMu.Lock()
	defer c.guestDowngradeMu.Unlock()
	return c.guestDowngradeWait != nil
}

func (c *httpClient) refreshAuth(ctx context.Context) (AuthRefresh, error) {
	if c.onUnauthorized == nil {
		return AuthRefresh{}, fmt.Errorf("onUnauthorized is not configured")
	}

	c.authRefreshMu.Lock()
	if waiting := c.authRefreshWait; waiting != nil {
		c.authRefreshMu.Unlock()
		select {
		case <-waiting.done:
			return waiting.auth, waiting.err
		case <-ctx.Done():
			return AuthRefresh{}, ctx.Err()
		}
	}

	wait := &authRefreshWaiter{done: make(chan struct{})}
	c.authRefreshWait = wait
	c.authRefreshMu.Unlock()

	wait.auth, wait.err = c.onUnauthorized(ctx)

	c.authRefreshMu.Lock()
	if c.authRefreshWait == wait {
		c.authRefreshWait = nil
	}
	c.authRefreshMu.Unlock()
	close(wait.done)

	return wait.auth, wait.err
}

func (c *httpClient) ensureGuestMode(ctx context.Context) (string, error) {
	c.mu.RLock()
	alreadyGuest := c.authDowngradedToGuest && c.token == "" && c.apiKey == "" && c.spaceID != ""
	existingSpace := c.spaceID
	c.mu.RUnlock()

	c.guestDowngradeMu.Lock()
	inFlight := c.guestDowngradeWait != nil
	c.guestDowngradeMu.Unlock()

	if alreadyGuest && !inFlight {
		return existingSpace, nil
	}
	return c.downgradeToGuest(ctx)
}

func (c *httpClient) downgradeToGuest(ctx context.Context) (string, error) {
	c.guestDowngradeMu.Lock()
	if waiting := c.guestDowngradeWait; waiting != nil {
		c.guestDowngradeMu.Unlock()
		select {
		case <-waiting.done:
			return waiting.spaceID, waiting.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}

	wait := &guestDowngradeWaiter{done: make(chan struct{})}
	c.guestDowngradeWait = wait
	c.guestDowngradeMu.Unlock()

	c.mu.Lock()
	c.authDowngradedToGuest = true
	c.token = ""
	c.apiKey = ""
	c.spaceID = ""
	c.spaceIDExplicit = false
	c.mu.Unlock()

	guestSpaceID, err := c.fetchUserSpaceID(ctx)
	if err == nil {
		c.mu.Lock()
		c.spaceID = guestSpaceID
		c.mu.Unlock()
	}

	wait.spaceID = guestSpaceID
	wait.err = err

	c.guestDowngradeMu.Lock()
	if c.guestDowngradeWait == wait {
		c.guestDowngradeWait = nil
	}
	c.guestDowngradeMu.Unlock()
	close(wait.done)

	return wait.spaceID, wait.err
}

// fetchUserSpaceID calls GET /user directly to avoid re-entering 401 guest handling.
func (c *httpClient) fetchUserSpaceID(ctx context.Context) (string, error) {
	res, err := c.doOnce(ctx, http.MethodGet, "/user", nil, nil, nil, false)
	if err != nil {
		return "", err
	}
	var user UserSelf
	if err := decodeJSONBody(res.Body, &user); err != nil {
		return "", err
	}
	if user.ID == "" {
		return "", fmt.Errorf("Failed to resolve guest space id after auth downgrade")
	}
	return user.ID, nil
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

func spaceIDFromRequest(path string, query url.Values, body []byte) string {
	if query != nil {
		if spaceID := query.Get("spaceId"); spaceID != "" {
			return spaceID
		}
	}
	if len(body) > 0 {
		var payload map[string]any
		if json.Unmarshal(body, &payload) == nil {
			if spaceID, ok := payload["spaceId"].(string); ok && spaceID != "" {
				return spaceID
			}
		}
	}
	if marker := "/spaces/"; strings.Contains(path, marker) {
		rest := path[strings.Index(path, marker)+len(marker):]
		if end := strings.IndexByte(rest, '/'); end > 0 {
			spaceID, err := url.PathUnescape(rest[:end])
			if err == nil && spaceID != "" {
				return spaceID
			}
			return rest[:end]
		}
	}
	return ""
}

func rewriteSpaceID(path string, query url.Values, body []byte, oldSpaceID string, newSpaceID string) (string, []byte) {
	if oldSpaceID == "" || newSpaceID == "" || oldSpaceID == newSpaceID {
		return path, body
	}
	escapedOld := url.PathEscape(oldSpaceID)
	escapedNew := url.PathEscape(newSpaceID)
	path = strings.ReplaceAll(path, "/spaces/"+escapedOld+"/", "/spaces/"+escapedNew+"/")
	path = strings.ReplaceAll(path, "/spaces/"+oldSpaceID+"/", "/spaces/"+newSpaceID+"/")
	if query != nil && query.Get("spaceId") == oldSpaceID {
		query.Set("spaceId", newSpaceID)
	}
	if len(body) == 0 {
		return path, body
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) == nil && payload["spaceId"] == oldSpaceID {
		payload["spaceId"] = newSpaceID
		next, err := json.Marshal(payload)
		if err == nil {
			return path, next
		}
	}
	return path, body
}

func isEventStream(headers http.Header) bool {
	contentType := strings.ToLower(headers.Get("Content-Type"))
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err == nil {
		contentType = mediaType
	}
	return strings.Contains(contentType, "event-stream")
}
