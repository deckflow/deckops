package deckops

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type FilesClient struct {
	http *httpClient
}

type normalizedUpload struct {
	Name      string
	Bytes     int64
	Hash      string
	Data      []byte
	ChunkSize int64
}

func (f *FilesClient) RequestUpload(ctx context.Context, params RequestUploadParams) (*UploadAuthResponse, error) {
	spaceID := params.SpaceID
	if spaceID == "" {
		spaceID = f.http.SpaceID()
	}
	if spaceID == "" {
		return nil, fmt.Errorf("spaceId is required")
	}
	if params.ChunkSize == 0 {
		params.ChunkSize = DefaultChunkSize
	}

	var out UploadAuthResponse
	_, err := f.http.postJSON(ctx, "/spaces/"+urlPathEscape(spaceID)+"/file/auth", map[string]any{
		"name":      params.Name,
		"bytes":     params.Bytes,
		"hash":      params.Hash,
		"chunkSize": params.ChunkSize,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (f *FilesClient) Upload(ctx context.Context, input UploadInput, options UploadOptions) (*FileUploadResult, error) {
	normalized, err := normalizeUploadInput(input, options)
	if err != nil {
		return nil, err
	}

	auth, err := f.RequestUpload(ctx, RequestUploadParams{
		SpaceID:   options.SpaceID,
		Name:      normalized.Name,
		Bytes:     normalized.Bytes,
		Hash:      normalized.Hash,
		ChunkSize: normalized.ChunkSize,
	})
	if err != nil {
		return nil, err
	}

	if auth.Auth != nil {
		if auth.Multipart {
			err = f.uploadMultipart(ctx, normalized, auth, options.OnProgress)
		} else {
			err = f.uploadSingle(ctx, normalized, auth, options.OnProgress)
		}
		if err != nil {
			return nil, err
		}
	} else if options.OnProgress != nil {
		options.OnProgress(1)
	}

	return &FileUploadResult{
		ID:    auth.ID,
		Key:   auth.Key,
		Name:  normalized.Name,
		Bytes: normalized.Bytes,
		Hash:  normalized.Hash,
	}, nil
}

func normalizeUploadInput(input UploadInput, options UploadOptions) (*normalizedUpload, error) {
	chunkSize := options.ChunkSize
	if chunkSize == 0 {
		chunkSize = DefaultChunkSize
	}

	var data []byte
	var name string
	var err error

	switch {
	case input.Data != nil:
		data = input.Data
		name = firstNonEmpty(options.Name, input.Name)
	case input.Path != "":
		data, err = os.ReadFile(input.Path)
		if err != nil {
			return nil, err
		}
		name = firstNonEmpty(options.Name, input.Name, filepath.Base(input.Path))
	case input.Reader != nil:
		data, err = io.ReadAll(input.Reader)
		if err != nil {
			return nil, err
		}
		name = firstNonEmpty(options.Name, input.Name)
	default:
		return nil, fmt.Errorf("upload input requires Data, Path, or Reader")
	}

	if name == "" {
		return nil, fmt.Errorf("name is required when uploading binary input")
	}

	hash := firstNonEmpty(options.Hash, input.Hash)
	if hash == "" {
		sum := md5.Sum(data)
		hash = hex.EncodeToString(sum[:])
	}

	return &normalizedUpload{
		Name:      name,
		Bytes:     int64(len(data)),
		Hash:      hash,
		Data:      data,
		ChunkSize: chunkSize,
	}, nil
}

func (f *FilesClient) uploadSingle(ctx context.Context, file *normalizedUpload, authResponse *UploadAuthResponse, onProgress func(float64)) error {
	auth := authResponse.Auth
	if auth == nil {
		return fmt.Errorf("missing auth in upload response")
	}

	var body io.Reader = bytes.NewReader(file.Data)
	headers := uploadAuthHeaders(auth.Headers, auth.Authorization)
	if authResponse.Platform != UploadPlatformOSS {
		formBody, formType, err := createFormBody(file.Name, file.Data)
		if err != nil {
			return err
		}
		body = formBody
		headers.Set("Content-Type", formType)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, auth.URL, body)
	if err != nil {
		return err
	}
	req.Header = headers
	resp, err := f.http.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return newAPIError(resp, data)
	}
	if onProgress != nil {
		onProgress(1)
	}
	return nil
}

func (f *FilesClient) uploadMultipart(ctx context.Context, file *normalizedUpload, authResponse *UploadAuthResponse, onProgress func(float64)) error {
	if authResponse.Auth == nil {
		return fmt.Errorf("missing auth in upload response")
	}
	if len(authResponse.MultipartPartAuths) == 0 {
		return fmt.Errorf("multipart upload authorization missing")
	}
	chunkSize := authResponse.MultipartPartSize
	if chunkSize == 0 {
		chunkSize = file.ChunkSize
	}

	partCount := len(authResponse.MultipartPartAuths)
	results := make([]PartResult, partCount)
	progress := make([]float64, partCount)
	sem := make(chan struct{}, 5)
	errCh := make(chan error, partCount)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for i, partAuth := range authResponse.MultipartPartAuths {
		i, partAuth := i, partAuth
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
			part, err := f.uploadPart(ctx, file.Name, file.Data, partAuth, i, chunkSize, authResponse.Platform)
			if err != nil {
				errCh <- err
				return
			}
			results[i] = part
			mu.Lock()
			progress[i] = 1
			if onProgress != nil {
				var total float64
				for _, p := range progress {
					total += p
				}
				onProgress(0.95 * total / float64(partCount))
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			return err
		}
	}

	sort.Slice(results, func(i, j int) bool { return results[i].PartNumber < results[j].PartNumber })
	if err := f.completeMultipart(ctx, authResponse.Auth, authResponse.Platform, results); err != nil {
		return err
	}
	if onProgress != nil {
		onProgress(1)
	}
	return nil
}

func (f *FilesClient) uploadPart(ctx context.Context, name string, data []byte, partAuth PartAuth, partIndex int, chunkSize int64, platform UploadPlatform) (PartResult, error) {
	start64 := int64(partIndex) * chunkSize
	end64 := start64 + chunkSize
	if end64 > int64(len(data)) {
		end64 = int64(len(data))
	}
	start := int(start64)
	end := int(end64)
	chunk := data[start:end]
	headers := uploadAuthHeaders(partAuth.Headers, partAuth.Authorization)
	var body io.Reader = bytes.NewReader(chunk)

	if platform != UploadPlatformOSS {
		formBody, formType, err := createFormBody(name, chunk)
		if err != nil {
			return PartResult{}, err
		}
		body = formBody
		headers.Set("Content-Type", formType)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, partAuth.URL, body)
	if err != nil {
		return PartResult{}, err
	}
	req.Header = headers
	resp, err := f.http.client.Do(req)
	if err != nil {
		return PartResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return PartResult{}, newAPIError(resp, data)
	}

	result := PartResult{PartNumber: partIndex + 1}
	if platform == UploadPlatformOSS {
		result.ETag = strings.Trim(resp.Header.Get("ETag"), `"`)
		return result, nil
	}
	var payload struct {
		Hash string `json:"hash"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	result.Hash = payload.Hash
	return result, nil
}

func (f *FilesClient) completeMultipart(ctx context.Context, auth *AuthInfo, platform UploadPlatform, parts []PartResult) error {
	headers := uploadAuthHeaders(auth.Headers, auth.Authorization)
	var body io.Reader
	method := http.MethodPost

	if platform == UploadPlatformOSS {
		var xml strings.Builder
		xml.WriteString("<CompleteMultipartUpload>")
		for _, part := range parts {
			xml.WriteString("<Part><PartNumber>")
			xml.WriteString(fmt.Sprint(part.PartNumber))
			xml.WriteString("</PartNumber><ETag>")
			xml.WriteString(part.ETag)
			xml.WriteString("</ETag></Part>")
		}
		xml.WriteString("</CompleteMultipartUpload>")
		body = strings.NewReader(xml.String())
	} else {
		payload, err := json.Marshal(map[string]any{"parts": parts})
		if err != nil {
			return err
		}
		body = bytes.NewReader(payload)
		headers.Set("Content-Type", "application/json")
	}

	req, err := http.NewRequestWithContext(ctx, method, auth.URL, body)
	if err != nil {
		return err
	}
	req.Header = headers
	resp, err := f.http.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return newAPIError(resp, data)
	}
	return nil
}

func uploadAuthHeaders(values map[string]string, authorization string) http.Header {
	headers := make(http.Header)
	for key, value := range values {
		headers.Set(key, value)
	}
	if authorization != "" {
		headers.Set("Authorization", authorization)
	}
	return headers
}

func createFormBody(name string, data []byte) (*bytes.Buffer, string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(data); err != nil {
		return nil, "", err
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return &body, writer.FormDataContentType(), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
