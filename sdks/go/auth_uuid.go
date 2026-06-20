package deckops

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

const (
	AuthUUIDStorageKey = "df_uuid"
	AuthUUIDFilename   = "auth-uuid"
)

var (
	uuidV4RE       = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	defaultUUIDMu  sync.Mutex
	defaultUUIDVal string
)

func IsValidAuthUUID(value string) bool {
	return uuidV4RE.MatchString(value)
}

func GenerateAuthUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80

	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst), nil
}

func resolveAuthUUID(ctx context.Context, options ClientOptions) (string, error) {
	if IsValidAuthUUID(options.AuthUUID) {
		return options.AuthUUID, nil
	}
	if env := os.Getenv("DECKOPS_AUTH_UUID"); IsValidAuthUUID(env) {
		return env, nil
	}
	if options.AuthUUIDStorage != nil {
		return resolveAuthUUIDWithStorage(ctx, options.AuthUUIDStorage)
	}

	defaultUUIDMu.Lock()
	defer defaultUUIDMu.Unlock()
	if IsValidAuthUUID(defaultUUIDVal) {
		return defaultUUIDVal, nil
	}

	if stored, _ := readDefaultAuthUUID(); IsValidAuthUUID(stored) {
		defaultUUIDVal = stored
		return stored, nil
	}

	generated, err := GenerateAuthUUID()
	if err != nil {
		return "", err
	}
	_ = writeDefaultAuthUUID(generated)
	defaultUUIDVal = generated
	return generated, nil
}

func resolveAuthUUIDWithStorage(ctx context.Context, storage AuthUUIDStorage) (string, error) {
	stored, err := storage.Get(ctx)
	if err != nil {
		return "", err
	}
	if IsValidAuthUUID(stored) {
		return stored, nil
	}

	generated, err := GenerateAuthUUID()
	if err != nil {
		return "", err
	}
	if err := storage.Set(ctx, generated); err != nil {
		return "", err
	}
	return generated, nil
}

func defaultConfigDir() string {
	if dir := os.Getenv("DECKOPS_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".deckops")
}

func readDefaultAuthUUID() (string, error) {
	dir := defaultConfigDir()
	if dir == "" {
		return "", nil
	}
	content, err := os.ReadFile(filepath.Join(dir, AuthUUIDFilename))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(content)), nil
}

func writeDefaultAuthUUID(value string) error {
	dir := defaultConfigDir()
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, AuthUUIDFilename), []byte(value), 0o600)
}

func resetAuthUUIDCacheForTests() {
	defaultUUIDMu.Lock()
	defer defaultUUIDMu.Unlock()
	defaultUUIDVal = ""
}
