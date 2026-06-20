package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	deckops "github.com/deckops/deckops/sdks/go"
)

const (
	version            = "0.7.0"
	defaultTimeoutSec  = 300
	defaultOCRLanguage = "zh-hans"
	defaultLoginPort   = 3737
	loginTimeout       = 5 * time.Minute
)

var compressTypes = map[string]string{
	".zip":  "file.compress",
	".pptx": "file.compress",
	".key":  "file.compress",
	".docx": "file.compress",
	".xlsx": "file.compress",
	".mp4":  "video.compress",
	".avi":  "video.compress",
	".mov":  "video.compress",
	".mkv":  "video.compress",
}

var extractTypes = map[string]string{
	".pptx": "pptx.getFontInfo",
}

var extractTypeMap = map[string]string{
	"fonts":       "pptx.getFontInfo",
	"text-shapes": "pptx.getTextShapes",
}

var renderFormats = map[string]map[string]string{
	"image": {
		".ppt":  "convertor.ppt2image",
		".pptx": "convertor.ppt2image",
		".pdf":  "convertor.pdf2image",
		".key":  "convertor.keynote2image",
	},
	"pdf": {
		".ppt":  "convertor.ppt2pdf",
		".pptx": "convertor.ppt2pdf",
		".doc":  "convertor.doc2pdf",
		".docx": "convertor.doc2pdf",
		".key":  "convertor.keynote2pdf",
	},
	"video": {
		".ppt":  "convertor.ppt2video",
		".pptx": "convertor.ppt2video",
	},
	"html": {
		".key": "convertor.keynote2html",
	},
	"png": {
		".html": "convertor.html2png",
		".md":   "convertor.markdown2png",
	},
	"pptx": {
		".ppt":  "convertor.ppt2pptx",
		".html": "convertor.html2pptx",
	},
	"webp": {
		".jpg":  "image.convertWebp",
		".jpeg": "image.convertWebp",
		".png":  "image.convertWebp",
	},
}

var multiSourceTaskTypes = []string{"pptx.join", "convertor.html2pptx", "html.buildPlayer", "generation"}
var multiSourceConvertTaskTypes = []string{"convertor.html2pptx"}
var ocrLanguages = []string{"zh-hans", "zh-hant", "en", "ja", "ko", "ar", "de", "es", "fr", "it", "pt", "ru"}
var sourceLanguages = []string{"auto", "zh", "zh-hans", "zh-hant", "en", "ja", "ko", "de", "fr", "es", "it", "pt", "ru"}
var targetLanguages = []string{"zh", "zh-hans", "zh-hant", "en", "ja", "ko", "de", "fr", "es", "it", "pt", "ru"}
var generationExtensions = []string{".html", ".pdf", ".docx", ".pptx", ".txt", ".md", ".mm", ".xmind", ".ipynb"}
var translationExtensions = []string{".docx", ".pptx", ".pdf", ".xlsx", ".key"}

type configData struct {
	Token   string `json:"token,omitempty"`
	SpaceID string `json:"spaceId,omitempty"`
	APIBase string `json:"apiBase,omitempty"`
	SignURI string `json:"signURI,omitempty"`
}

type appContext struct {
	config     configData
	configDir  string
	configPath string
	json       bool
	client     *deckops.Client
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		var exitErr exitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.code)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type exitError struct {
	code int
}

func (e exitError) Error() string {
	return fmt.Sprintf("exit %d", e.code)
}

func run(args []string) error {
	jsonOut := false
	filtered := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == "--json" {
			jsonOut = true
			continue
		}
		filtered = append(filtered, arg)
	}

	ctx, err := newAppContext(jsonOut)
	if err != nil {
		return err
	}

	if len(filtered) == 0 {
		printHelp()
		return nil
	}
	if filtered[0] == "--help" || filtered[0] == "-h" {
		printHelp()
		return nil
	}
	if filtered[0] == "--version" || filtered[0] == "-v" {
		fmt.Println(version)
		return nil
	}

	if err := dispatch(ctx, filtered); err != nil {
		ctx.outputError(err, "ERROR")
		return exitError{code: 1}
	}
	return nil
}

func newAppContext(jsonOut bool) (*appContext, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	dir := os.Getenv("DECKOPS_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".deckops")
	}
	ctx := &appContext{
		configDir:  dir,
		configPath: filepath.Join(dir, "config.json"),
		json:       jsonOut,
	}
	_ = ctx.loadConfig()
	ctx.applyConfigDefaults()
	return ctx, nil
}

func dispatch(ctx *appContext, args []string) error {
	switch args[0] {
	case "config":
		return ctx.runConfig(args[1:])
	case "login":
		return ctx.runLogin(args[1:])
	case "task":
		return ctx.runTask(args[1:])
	case "compress":
		return ctx.runCompress(args[1:])
	case "extract":
		return ctx.runExtract(args[1:])
	case "ocr":
		return ctx.runOCR(args[1:])
	case "convert":
		return ctx.runConvert(args[1:])
	case "join":
		return ctx.runJoin(args[1:])
	case "create":
		return ctx.runCreate(args[1:])
	case "translate":
		return ctx.runTranslate(args[1:])
	case "run":
		return ctx.runExplicitTask(args[1:])
	default:
		return fmt.Errorf("unknown command: %s", args[0])
	}
}

func printHelp() {
	fmt.Println(`Deckflow CLI - File processing and conversion tools

Usage:
  deckops [--json] <command> [options]

Commands:
  config      Manage configuration
  login       Login to Deckflow and save authentication token
  task        Manage tasks
  compress    Compress a file
  extract     Extract information from a file
  ocr         Extract text from images using OCR
  convert     Convert file(s) to a different format
  join        Merge multiple pptx files into one
  create      Create document content
  translate   Translate a document file
  run         Run a task with explicit type`)
}

func (c *appContext) loadConfig() error {
	data, err := os.ReadFile(c.configPath)
	if err != nil {
		c.config = configData{}
		return nil
	}
	if err := json.Unmarshal(data, &c.config); err != nil {
		c.config = configData{}
	}
	if c.config.APIBase != "" && !isValidURL(c.config.APIBase) {
		c.config = configData{}
	}
	return nil
}

func (c *appContext) applyConfigDefaults() {
	if c.config.APIBase == "" {
		c.config.APIBase = deckops.DefaultRoot
	}
}

func (c *appContext) saveConfig() error {
	if err := os.MkdirAll(c.configDir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c.config, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(c.configPath, data, 0o600)
}

func (c *appContext) apiBase() string {
	if c.config.APIBase != "" {
		return c.config.APIBase
	}
	return deckops.DefaultRoot
}

func (c *appContext) getClient(ctx context.Context) (*deckops.Client, error) {
	if c.config.Token == "" {
		if _, err := c.ensureLoggedIn(ctx, defaultLoginPort, "explicit"); err != nil {
			return nil, err
		}
	}
	if c.config.Token == "" {
		return nil, fmt.Errorf("Login did not provide a token. Please run `deckflow login` again.")
	}
	if c.client != nil {
		return c.client, nil
	}
	client, err := deckops.New(ctx, deckops.ClientOptions{
		Root:    c.apiBase(),
		Token:   c.config.Token,
		SpaceID: c.config.SpaceID,
		OnUnauthorized: func(ctx context.Context) (deckops.AuthRefresh, error) {
			token, err := c.ensureLoggedIn(ctx, defaultLoginPort, "unauthorized")
			if err != nil {
				return deckops.AuthRefresh{}, err
			}
			return deckops.AuthRefresh{Token: token, SpaceID: c.config.SpaceID}, nil
		},
		OnPaymentRequired: func(ctx context.Context) error {
			return c.ensureCheckout(ctx, defaultLoginPort)
		},
	})
	if err != nil {
		return nil, err
	}
	c.client = client
	return client, nil
}

func (c *appContext) requireSpaceID() (string, error) {
	if c.config.SpaceID == "" {
		return "", fmt.Errorf("Space ID missing. Please run `deckflow login` first.")
	}
	return c.config.SpaceID, nil
}

func (c *appContext) output(data any, human func() string) {
	if c.json {
		printJSON(data)
		return
	}
	if human != nil {
		fmt.Println(human())
		return
	}
	fmt.Println(data)
}

func (c *appContext) outputError(err error, code string) {
	if c.json {
		payload := map[string]any{"error": err.Error(), "code": code}
		var apiErr *deckops.APIError
		if errors.As(err, &apiErr) {
			if apiErr.RequestID != "" {
				payload["requestId"] = apiErr.RequestID
			}
			if apiErr.ResponseData != nil {
				payload["body"] = apiErr.ResponseData
			}
		}
		data, _ := json.Marshal(payload)
		fmt.Fprintln(os.Stderr, string(data))
		return
	}
	fmt.Fprintln(os.Stderr, "Error:", err)
}

func printJSON(data any) {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		fmt.Println(data)
		return
	}
	fmt.Println(string(out))
}

func (c *appContext) info(msg string) {
	if !c.json {
		fmt.Println(msg)
	}
}

func (c *appContext) runConfig(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("missing config command")
	}
	switch args[0] {
	case "set-token":
		if len(args) != 2 {
			return fmt.Errorf("usage: deckops config set-token <token>")
		}
		c.config.Token = args[1]
		if err := c.saveConfig(); err != nil {
			return err
		}
		c.output(map[string]any{"token": args[1], "message": "Token set successfully"}, func() string { return "Token set successfully" })
	case "set-space":
		if len(args) != 2 {
			return fmt.Errorf("usage: deckops config set-space <space-id>")
		}
		c.config.SpaceID = args[1]
		if err := c.saveConfig(); err != nil {
			return err
		}
		c.output(map[string]any{"spaceId": args[1], "message": "Space ID set successfully"}, func() string { return "Space ID set successfully" })
	case "set-api-base":
		if len(args) != 2 {
			return fmt.Errorf("usage: deckops config set-api-base <url>")
		}
		if !isValidURL(args[1]) {
			return fmt.Errorf("Invalid API base URL: %s", args[1])
		}
		c.config.APIBase = args[1]
		if err := c.saveConfig(); err != nil {
			return err
		}
		c.output(map[string]any{"apiBase": args[1], "message": "API base URL set successfully"}, func() string { return "API base URL set successfully" })
	case "show":
		display := map[string]string{
			"token":   c.config.Token,
			"spaceId": c.config.SpaceID,
			"apiBase": c.config.APIBase,
			"signURI": c.config.SignURI,
		}
		c.output(display, func() string {
			token := display["token"]
			if token != "" && len(token) > 8 {
				token = token[:8] + "..."
			}
			lines := []string{
				"token: " + valueOrUnset(token),
				"spaceId: " + valueOrUnset(display["spaceId"]),
				"apiBase: " + valueOrUnset(display["apiBase"]),
				"signURI: " + valueOrUnset(display["signURI"]),
			}
			if c.config.Token == "" {
				lines = append(lines, "Tip: token is missing. Please run `deckflow login` first.")
			} else if c.config.SpaceID == "" {
				lines = append(lines, "Tip: spaceId is missing. Some commands require it; set it via `deckflow config set-space <space-id>`.")
			}
			return strings.Join(lines, "\n")
		})
	default:
		return fmt.Errorf("unknown config command: %s", args[0])
	}
	return nil
}

func valueOrUnset(v string) string {
	if v == "" {
		return "(not set)"
	}
	return v
}

func isValidURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme != "" && u.Host != ""
}

func (c *appContext) runLogin(args []string) error {
	opts, rest, err := parseOptions(args, optionSpec{
		"port": {takesValue: true, value: strconv.Itoa(defaultLoginPort)},
	})
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return fmt.Errorf("usage: deckops login [--port <port>]")
	}
	port, err := positiveInt(opts.first("port"), "--port")
	if err != nil {
		return err
	}
	if _, err := c.ensureLoggedIn(context.Background(), port, "explicit"); err != nil {
		return err
	}
	if !c.json {
		fmt.Println("\nToken saved successfully!\n")
		fmt.Println("You can now use Deckflow CLI commands.\n")
	}
	c.output(map[string]any{"success": true, "message": "Login successful"}, func() string { return "Login successful!" })
	return nil
}

func (c *appContext) ensureLoggedIn(ctx context.Context, port int, reason string) (string, error) {
	callbackURL := fmt.Sprintf("http://localhost:%d", port)
	loginURL, err := buildLoginURL(c.apiBase(), callbackURL)
	if err != nil {
		return "", err
	}
	if !c.json {
		if reason == "unauthorized" {
			fmt.Println("\nAuthentication expired. Please log in again.\n")
		} else {
			fmt.Println("\nDeckflow Login\n")
		}
		fmt.Println("Opening browser to:", loginURL)
		fmt.Printf("Waiting for authentication on port %d...\n\n", port)
	}
	resultCh := make(chan loginResult, 1)
	server, err := startLoginServer(port, resultCh)
	if err != nil {
		return "", err
	}
	defer server.Close()
	if err := openBrowser(loginURL); err != nil && !c.json {
		fmt.Println("\nUnable to open browser automatically.")
		fmt.Println("Please open this link manually:\n" + loginURL + "\n")
	}
	select {
	case result := <-resultCh:
		if result.err != nil {
			return "", result.err
		}
		c.config.Token = result.token
		if result.spaceID != "" {
			c.config.SpaceID = result.spaceID
		}
		if err := c.saveConfig(); err != nil {
			return "", err
		}
		if c.client != nil {
			c.client.SetToken(c.config.Token)
			c.client.SetSpaceID(c.config.SpaceID)
		}
		return result.token, nil
	case <-time.After(loginTimeout):
		return "", fmt.Errorf("Login timeout. Please try again.")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (c *appContext) ensureCheckout(ctx context.Context, port int) error {
	if c.config.Token == "" {
		if _, err := c.ensureLoggedIn(ctx, port, "unauthorized"); err != nil {
			return err
		}
	}
	redirectURL := fmt.Sprintf("http://localhost:%d", port)
	checkoutURL, err := buildCheckoutURL(c.apiBase(), redirectURL, c.config.Token, c.config.SpaceID)
	if err != nil {
		return err
	}
	if !c.json {
		fmt.Println("\nInsufficient balance. Please complete payment to continue.\n")
		fmt.Println("Opening browser to:", checkoutURL)
		fmt.Printf("Waiting for checkout completion on port %d...\n\n", port)
	}
	resultCh := make(chan error, 1)
	server, err := startDoneServer(port, resultCh)
	if err != nil {
		return err
	}
	defer server.Close()
	if err := openBrowser(checkoutURL); err != nil && !c.json {
		fmt.Println("\nUnable to open browser automatically.")
		fmt.Println("Please open this link manually:\n" + checkoutURL + "\n")
	}
	select {
	case err := <-resultCh:
		return err
	case <-time.After(loginTimeout):
		return fmt.Errorf("Operation timeout. Please try again.")
	case <-ctx.Done():
		return ctx.Err()
	}
}

type loginResult struct {
	token   string
	spaceID string
	err     error
}

func startLoginServer(port int, resultCh chan<- loginResult) (*http.Server, error) {
	mux := http.NewServeMux()
	server := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: mux}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		spaceID := firstNonEmpty(r.URL.Query().Get("spaceId"), r.URL.Query().Get("space_id"))
		if token == "" {
			http.Error(w, "Missing token parameter", http.StatusBadRequest)
			select {
			case resultCh <- loginResult{err: fmt.Errorf("missing token parameter")}:
			default:
			}
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, successHTML("Login Successful!", "You can close this window and return to your terminal."))
		select {
		case resultCh <- loginResult{token: token, spaceID: spaceID}:
		default:
		}
	})
	errCh := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case err := <-errCh:
		return nil, err
	case <-time.After(100 * time.Millisecond):
		return server, nil
	}
}

func startDoneServer(port int, resultCh chan<- error) (*http.Server, error) {
	mux := http.NewServeMux()
	server := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: mux}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, successHTML("Done", "You can close this window and return to your terminal."))
		select {
		case resultCh <- nil:
		default:
		}
	})
	errCh := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case err := <-errCh:
		return nil, err
	case <-time.After(100 * time.Millisecond):
		return server, nil
	}
}

func successHTML(title, body string) string {
	return fmt.Sprintf(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>%s</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6}.container{background:white;padding:3rem;border-radius:1rem;box-shadow:0 20px 60px rgba(0,0,0,.18);text-align:center;max-width:420px}h1{color:#111827;margin:0 0 1rem 0}p{color:#6b7280;margin:0}</style></head><body><div class="container"><h1>%s</h1><p>%s</p></div></body></html>`, title, title, body)
}

func normalizeLoginBase(apiBase string) (string, error) {
	u, err := url.Parse(apiBase)
	if err != nil {
		return "", err
	}
	u.Path = strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), "/v1")
	return strings.TrimRight(u.String(), "/"), nil
}

func buildLoginURL(apiBase, callbackURL string) (string, error) {
	base, err := normalizeLoginBase(apiBase)
	if err != nil {
		return "", err
	}
	return base + "/cli/auth?redirect_url=" + url.QueryEscape(callbackURL), nil
}

func buildCheckoutURL(apiBase, redirectURL, token, spaceID string) (string, error) {
	base, err := normalizeLoginBase(apiBase)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(base + "/cli/checkout")
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("redirect_url", redirectURL)
	q.Set("token", token)
	if spaceID != "" {
		q.Set("spaceId", spaceID)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func openBrowser(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}

func (c *appContext) runTask(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("missing task command")
	}
	switch args[0] {
	case "list":
		opts, rest, err := parseOptions(args[1:], optionSpec{
			"type":   {takesValue: true},
			"limit":  {takesValue: true, value: "50"},
			"offset": {takesValue: true, value: "0"},
		})
		if err != nil {
			return err
		}
		if len(rest) != 0 {
			return fmt.Errorf("usage: deckops task list [--type <type>] [--limit <n>] [--offset <n>]")
		}
		client, err := c.getClient(context.Background())
		if err != nil {
			return err
		}
		spaceID, err := c.requireSpaceID()
		if err != nil {
			return err
		}
		offset, err := nonNegativeInt(opts.first("offset"), "--offset")
		if err != nil {
			return err
		}
		limit, err := positiveInt(opts.first("limit"), "--limit")
		if err != nil {
			return err
		}
		result, err := client.Tasks.List(context.Background(), deckops.ListTasksParams{
			SpaceID: spaceID, Type: deckops.TaskType(opts.first("type")), StartIndex: offset, MaxResults: limit, HasStart: true, HasMax: true,
		})
		if err != nil {
			return err
		}
		c.output(result, func() string {
			if len(result.Tasks) == 0 {
				return "No tasks found"
			}
			lines := []string{fmt.Sprintf("Found %d tasks:\n", result.Total)}
			for _, task := range result.Tasks {
				lines = append(lines, fmt.Sprintf("  %s - %s - %s", task.ID, task.Status, task.Type))
			}
			return strings.Join(lines, "\n")
		})
	case "get":
		opts, rest, err := parseOptions(args[1:], optionSpec{"out": {short: "o", takesValue: true}})
		if err != nil {
			return err
		}
		if len(rest) != 1 {
			return fmt.Errorf("usage: deckops task get <task-id> [-o <path>]")
		}
		client, err := c.getClient(context.Background())
		if err != nil {
			return err
		}
		task, err := client.Tasks.Get(context.Background(), rest[0], false)
		if err != nil {
			return err
		}
		if out := opts.first("out"); out != "" {
			if result, ok := c.tryWriteTaskOutput(context.Background(), client, task, out); ok {
				c.outputTaskSaved(result)
				return nil
			}
		}
		c.output(task, func() string { return formatTaskDetails(task) })
	case "delete":
		if len(args) != 2 {
			return fmt.Errorf("usage: deckops task delete <task-id>")
		}
		client, err := c.getClient(context.Background())
		if err != nil {
			return err
		}
		if err := client.Tasks.Delete(context.Background(), args[1]); err != nil {
			return err
		}
		taskID := args[1]
		c.output(map[string]any{"taskId": taskID, "deleted": true}, func() string { return "Task " + taskID + " deleted" })
	default:
		return fmt.Errorf("unknown task command: %s", args[0])
	}
	return nil
}

func (c *appContext) runCompress(args []string) error {
	opts, rest, err := parseTaskOptions(args, nil)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: deckops compress <input-file> [options]")
	}
	input := rest[0]
	ext := strings.ToLower(filepath.Ext(input))
	taskType := compressTypes[ext]
	if taskType == "" {
		return fmt.Errorf("Unsupported file type: %s\nSupported: %s", ext, strings.Join(keys(compressTypes), ", "))
	}
	return c.runFileTask(fileTaskOptions{
		inputFiles: rest, taskType: taskType, taskName: strings.TrimSuffix(filepath.Base(input), ext), title: "Compression Task",
		createMessage: "Creating compression task...", waitMessage: "Processing...", doneMessage: "Compression completed", failMessage: "Compression failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

func (c *appContext) runExtract(args []string) error {
	opts, rest, err := parseTaskOptions(args, optionSpec{"type": {takesValue: true}})
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: deckops extract <input-file> [--type <type>] [options]")
	}
	input := rest[0]
	ext := strings.ToLower(filepath.Ext(input))
	taskType := ""
	if typ := opts.first("type"); typ != "" {
		taskType = extractTypeMap[typ]
		if taskType == "" {
			return fmt.Errorf("Unknown extract type: %s\nSupported: %s", typ, strings.Join(keys(extractTypeMap), ", "))
		}
	} else {
		taskType = extractTypes[ext]
		if taskType == "" {
			return fmt.Errorf("Cannot auto-detect extract type for: %s\nPlease specify --type", ext)
		}
	}
	return c.runFileTask(fileTaskOptions{
		inputFiles: rest, taskType: taskType, taskName: strings.TrimSuffix(filepath.Base(input), ext), title: "Extraction Task",
		createMessage: "Creating extraction task...", waitMessage: "Processing...", doneMessage: "Extraction completed", failMessage: "Extraction failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

func (c *appContext) runOCR(args []string) error {
	opts, rest, err := parseTaskOptions(args, optionSpec{"language": {takesValue: true, value: defaultOCRLanguage}})
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: deckops ocr <input-file> [--language <lang>] [options]")
	}
	lang := opts.first("language")
	if !contains(ocrLanguages, lang) {
		return fmt.Errorf("Unsupported language: %s\nSupported: %s", lang, strings.Join(ocrLanguages, ", "))
	}
	input := rest[0]
	ext := strings.ToLower(filepath.Ext(input))
	if !contains([]string{".jpg", ".jpeg", ".png"}, ext) {
		return fmt.Errorf("Unsupported file type: %s\nSupported: .jpg, .jpeg, .png", ext)
	}
	return c.runFileTask(fileTaskOptions{
		inputFiles: rest, taskType: "image.ocr", taskName: strings.TrimSuffix(filepath.Base(input), ext), params: map[string]any{"language": lang},
		title: "OCR Task", extraLines: []string{"  Language: " + lang}, createMessage: "Creating OCR task...", waitMessage: "Processing OCR...", doneMessage: "OCR completed", failMessage: "OCR failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

func (c *appContext) runConvert(args []string) error {
	opts, rest, err := parseTaskOptions(args, optionSpec{
		"to":               {takesValue: true, required: true},
		"width":            {takesValue: true},
		"height":           {takesValue: true},
		"need-embed-fonts": {optionalBool: true, value: "false"},
	})
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return fmt.Errorf("usage: deckops convert <input-files...> --to <format> [options]")
	}
	formatMap := renderFormats[opts.first("to")]
	if formatMap == nil {
		return fmt.Errorf("Unsupported output format: %s\nSupported: %s", opts.first("to"), strings.Join(keysNested(renderFormats), ", "))
	}
	taskTypes := make([]string, 0, len(rest))
	for _, input := range rest {
		ext := strings.ToLower(filepath.Ext(input))
		taskType := formatMap[ext]
		if taskType == "" {
			return fmt.Errorf("Cannot convert %s to %s\nSupported input types: %s", ext, opts.first("to"), strings.Join(keys(formatMap), ", "))
		}
		taskTypes = append(taskTypes, taskType)
	}
	taskType := taskTypes[0]
	for _, t := range taskTypes[1:] {
		if t != taskType {
			return fmt.Errorf("All input files must map to the same conversion task type.")
		}
	}
	if len(rest) > 1 && !contains(multiSourceConvertTaskTypes, taskType) {
		return fmt.Errorf("Multiple input files for one conversion task are only supported by: %s", strings.Join(multiSourceConvertTaskTypes, ", "))
	}
	params := map[string]any{}
	if taskType == "convertor.html2pptx" || taskType == "convertor.html2png" {
		if width := opts.first("width"); width != "" {
			v, err := positiveFloat(width, "--width")
			if err != nil {
				return err
			}
			params["width"] = v
		}
		if height := opts.first("height"); height != "" {
			v, err := positiveFloat(height, "--height")
			if err != nil {
				return err
			}
			params["height"] = v
		}
	}
	if taskType == "convertor.html2pptx" {
		params["needEmbedFonts"], err = parseBool(opts.first("need-embed-fonts"))
		if err != nil {
			return err
		}
	}
	first := rest[0]
	ext := strings.ToLower(filepath.Ext(first))
	return c.runFileTask(fileTaskOptions{
		inputFiles: rest, taskType: taskType, taskName: strings.TrimSuffix(filepath.Base(first), ext), params: params,
		title: "Conversion Task", createMessage: "Creating conversion task...", waitMessage: "Converting...", doneMessage: "Conversion completed", failMessage: "Conversion failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

func (c *appContext) runJoin(args []string) error {
	opts, rest, err := parseTaskOptions(args, optionSpec{"name": {takesValue: true}})
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return fmt.Errorf("Join requires at least 2 pptx files, got %d", len(rest))
	}
	var invalid []string
	for _, input := range rest {
		if strings.ToLower(filepath.Ext(input)) != ".pptx" {
			invalid = append(invalid, input)
		}
	}
	if len(invalid) > 0 {
		return fmt.Errorf("Only .pptx files are supported. Invalid file(s): %s", strings.Join(invalid, ", "))
	}
	name := opts.first("name")
	if name == "" {
		name = strings.TrimSuffix(filepath.Base(rest[0]), ".pptx")
	}
	return c.runFileTask(fileTaskOptions{
		inputFiles: rest, taskType: "pptx.join", taskName: name, title: "Join Task", extraLines: []string{fmt.Sprintf("  Inputs: %d file(s)", len(rest))},
		createMessage: "Creating pptx.join task...", waitMessage: "Joining pptx files...", doneMessage: "Join completed", failMessage: "Join failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

func (c *appContext) runCreate(args []string) error {
	opts, rest, err := parseTaskOptions(args, optionSpec{
		"input-text":     {takesValue: true},
		"enable-search":  {optionalBool: true},
		"advanced-model": {optionalBool: true},
		"fast-mode":      {optionalBool: true},
		"intent":         {takesValue: true},
		"audience":       {takesValue: true},
		"page-count":     {takesValue: true},
		"author":         {takesValue: true},
	})
	if err != nil {
		return err
	}
	if opts.first("input-text") == "" && len(rest) == 0 {
		return fmt.Errorf("At least one of --input-text or input file is required.")
	}
	if len(rest) > 2 {
		return fmt.Errorf("Generation allows up to 2 reference files.")
	}
	for _, input := range rest {
		ext := strings.ToLower(filepath.Ext(input))
		if !contains(generationExtensions, ext) {
			return fmt.Errorf("Unsupported file type: %s\nSupported: %s", ext, strings.Join(generationExtensions, ", "))
		}
	}
	params := map[string]any{}
	copyStringParam(params, opts, "input-text", "inputText")
	if err := copyBoolParam(params, opts, "enable-search", "enableSearch"); err != nil {
		return err
	}
	if err := copyBoolParam(params, opts, "advanced-model", "advancedModel"); err != nil {
		return err
	}
	if err := copyBoolParam(params, opts, "fast-mode", "fastMode"); err != nil {
		return err
	}
	copyStringParam(params, opts, "intent", "intent")
	copyStringParam(params, opts, "audience", "audience")
	copyStringParam(params, opts, "author", "author")
	if pageCount := opts.first("page-count"); pageCount != "" {
		v, err := positiveInt(pageCount, "--page-count")
		if err != nil {
			return err
		}
		params["pageCount"] = v
	}
	name := firstNonEmpty(opts.first("intent"), "create")
	if len(rest) > 0 {
		name = filepath.Base(rest[0])
	}
	return c.runFileTask(fileTaskOptions{
		inputFiles: rest, taskType: "generation", taskName: name, params: params,
		title: "Generation Task", createMessage: "Creating generation task...", waitMessage: "Generating...", doneMessage: "Generation completed", failMessage: "Generation failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

func (c *appContext) runTranslate(args []string) error {
	opts, rest, err := parseTaskOptions(args, optionSpec{
		"from":            {takesValue: true, required: true},
		"to":              {takesValue: true, required: true},
		"model":           {takesValue: true, required: true},
		"use-glossary":    {optionalBool: true, value: "false"},
		"image-translate": {optionalBool: true, value: "false"},
	})
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: deckops translate <input-file> --from <language> --to <language> --model <model> [options]")
	}
	if !contains(sourceLanguages, opts.first("from")) {
		return fmt.Errorf("Unsupported source language: %s\nSupported: %s", opts.first("from"), strings.Join(sourceLanguages, ", "))
	}
	if !contains(targetLanguages, opts.first("to")) {
		return fmt.Errorf("Unsupported target language: %s\nSupported: %s", opts.first("to"), strings.Join(targetLanguages, ", "))
	}
	model, err := normalizeTranslationModel(opts.first("model"))
	if err != nil {
		return err
	}
	input := rest[0]
	ext := strings.ToLower(filepath.Ext(input))
	if !contains(translationExtensions, ext) {
		return fmt.Errorf("Unsupported file type: %s\nSupported: %s", ext, strings.Join(translationExtensions, ", "))
	}
	useGlossary, err := parseBool(opts.first("use-glossary"))
	if err != nil {
		return err
	}
	imageTranslate, err := parseBool(opts.first("image-translate"))
	if err != nil {
		return err
	}
	params := map[string]any{
		"from":           opts.first("from"),
		"to":             opts.first("to"),
		"model":          model,
		"useGlossary":    useGlossary,
		"imageTranslate": imageTranslate,
	}
	return c.runFileTask(fileTaskOptions{
		inputFiles: rest, taskType: "translation", taskName: strings.TrimSuffix(filepath.Base(input), ext), params: params,
		title: "Translation Task", createMessage: "Creating translation task...", waitMessage: "Translating...", doneMessage: "Translation completed", failMessage: "Translation failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

func (c *appContext) runExplicitTask(args []string) error {
	opts, rest, err := parseTaskOptions(args, optionSpec{"param": {takesValue: true, repeat: true}})
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return fmt.Errorf("usage: deckops run <task-type> <input-files...> [--param <key=value>] [options]")
	}
	taskType := rest[0]
	inputFiles := rest[1:]
	if len(inputFiles) > 1 && !contains(multiSourceTaskTypes, taskType) {
		return fmt.Errorf("Task %s does not support multiple source files. Supported multi-source task types: %s", taskType, strings.Join(multiSourceTaskTypes, ", "))
	}
	params := map[string]any{}
	for _, p := range opts["param"] {
		idx := strings.Index(p, "=")
		if idx < 0 {
			return fmt.Errorf("Invalid parameter format: %s\nExpected: key=value", p)
		}
		key, raw := p[:idx], p[idx+1:]
		var value any
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			value = raw
		}
		params[key] = value
	}
	name := filepath.Base(inputFiles[0])
	return c.runFileTask(fileTaskOptions{
		inputFiles: inputFiles, taskType: taskType, taskName: name, params: params,
		title: "Task", createMessage: "Creating task...", waitMessage: "Processing...", doneMessage: "Task completed", failMessage: "Task failed",
		wait: shouldWait(opts), timeout: opts.first("timeout"), out: opts.first("out"),
	})
}

type fileTaskOptions struct {
	inputFiles    []string
	taskType      string
	taskName      string
	params        map[string]any
	title         string
	extraLines    []string
	createMessage string
	waitMessage   string
	doneMessage   string
	failMessage   string
	wait          bool
	timeout       string
	out           string
}

func (c *appContext) runFileTask(options fileTaskOptions) error {
	client, err := c.getClient(context.Background())
	if err != nil {
		return err
	}
	spaceID, err := c.requireSpaceID()
	if err != nil {
		return err
	}
	fileIDs := make([]string, 0, len(options.inputFiles))
	for i, input := range options.inputFiles {
		base := filepath.Base(input)
		if len(options.inputFiles) > 1 {
			c.info(fmt.Sprintf("Uploading [%d/%d] %s...", i+1, len(options.inputFiles), base))
		} else {
			c.info("Uploading " + base + "...")
		}
		result, err := client.Files.Upload(context.Background(), deckops.UploadInput{Path: input}, deckops.UploadOptions{
			SpaceID: spaceID,
			OnProgress: func(progress float64) {
				if !c.json && progress >= 1 {
					fmt.Println("Uploaded " + base)
				}
			},
		})
		if err != nil {
			return err
		}
		fileIDs = append(fileIDs, result.ID)
	}
	c.info(options.createMessage)
	task, err := client.Tasks.Create(context.Background(), deckops.CreateTaskParams{
		SpaceID: spaceID,
		FileIDs: fileIDs,
		Type:    deckops.TaskType(options.taskType),
		Name:    options.taskName,
		Params:  options.params,
	})
	if err != nil {
		return err
	}
	c.info("Task created: " + task.ID)
	if options.wait {
		timeoutSec, err := positiveInt(options.timeout, "--timeout")
		if err != nil {
			return err
		}
		c.info(options.waitMessage)
		task, err = client.Tasks.Wait(context.Background(), task.ID, deckops.WaitForTaskOptions{
			Timeout: time.Duration(timeoutSec) * time.Second,
			OnProgress: func(t deckops.Task) {
				if !c.json && t.Status == deckops.TaskStatusRunning {
					fmt.Println(options.waitMessage)
				}
			},
		})
		if err != nil {
			return err
		}
		if task.Status == deckops.TaskStatusCompleted {
			c.info(options.doneMessage)
		} else {
			c.info(options.failMessage)
		}
	}
	if options.out != "" {
		if result, ok := c.tryWriteTaskOutput(context.Background(), client, task, options.out); ok {
			c.outputTaskSaved(result)
			return nil
		}
	}
	c.output(task, func() string {
		lines := []string{
			options.title + ":",
			"  Task ID: " + task.ID,
		}
		if options.title == "Task" || options.title == "Join Task" {
			lines = append(lines, "  Type: "+string(task.Type))
		}
		lines = append(lines, options.extraLines...)
		lines = append(lines, "  Status: "+string(task.Status))
		if task.Result != nil {
			b, _ := json.MarshalIndent(task.Result, "", "  ")
			lines = append(lines, "  Result: "+string(b))
		}
		return strings.Join(lines, "\n")
	})
	return nil
}

func parseTaskOptions(args []string, extra optionSpec) (options, []string, error) {
	spec := optionSpec{
		"out":     {short: "o", takesValue: true},
		"wait":    {value: "true"},
		"no-wait": {value: "true"},
		"timeout": {takesValue: true, value: strconv.Itoa(defaultTimeoutSec)},
	}
	for k, v := range extra {
		spec[k] = v
	}
	opts, rest, err := parseOptions(args, spec)
	if err != nil {
		return nil, nil, err
	}
	for name, cfg := range spec {
		if cfg.required && opts.first(name) == "" {
			return nil, nil, fmt.Errorf("missing required option --%s", name)
		}
	}
	return opts, rest, nil
}

type optionConfig struct {
	short        string
	takesValue   bool
	optionalBool bool
	required     bool
	repeat       bool
	value        string
}

type optionSpec map[string]optionConfig
type options map[string][]string

func (o options) first(name string) string {
	if len(o[name]) == 0 {
		return ""
	}
	return o[name][len(o[name])-1]
}

func parseOptions(args []string, spec optionSpec) (options, []string, error) {
	opts := options{}
	for name, cfg := range spec {
		if cfg.value != "" {
			opts[name] = []string{cfg.value}
		}
	}
	shortToLong := map[string]string{}
	for name, cfg := range spec {
		if cfg.short != "" {
			shortToLong[cfg.short] = name
		}
	}
	var rest []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			rest = append(rest, args[i+1:]...)
			break
		}
		if strings.HasPrefix(arg, "--") {
			nameValue := strings.TrimPrefix(arg, "--")
			name, value, hasInline := strings.Cut(nameValue, "=")
			cfg, ok := spec[name]
			if !ok {
				return nil, nil, fmt.Errorf("unknown option --%s", name)
			}
			if cfg.takesValue {
				if !hasInline {
					i++
					if i >= len(args) {
						return nil, nil, fmt.Errorf("missing value for --%s", name)
					}
					value = args[i]
				}
			} else if cfg.optionalBool {
				if !hasInline {
					if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
						i++
						value = args[i]
					} else {
						value = "true"
					}
				}
			} else {
				value = "true"
			}
			opts[name] = appendOption(opts[name], value, cfg.repeat)
			continue
		}
		if strings.HasPrefix(arg, "-") && len(arg) == 2 {
			short := strings.TrimPrefix(arg, "-")
			name, ok := shortToLong[short]
			if !ok {
				return nil, nil, fmt.Errorf("unknown option -%s", short)
			}
			cfg := spec[name]
			value := "true"
			if cfg.takesValue {
				i++
				if i >= len(args) {
					return nil, nil, fmt.Errorf("missing value for -%s", short)
				}
				value = args[i]
			}
			opts[name] = appendOption(opts[name], value, cfg.repeat)
			continue
		}
		rest = append(rest, arg)
	}
	return opts, rest, nil
}

func appendOption(values []string, value string, repeat bool) []string {
	if repeat {
		return append(values, value)
	}
	return []string{value}
}

func shouldWait(opts options) bool {
	return opts.first("no-wait") != "true" || opts.first("out") != ""
}

func positiveInt(raw, name string) (int, error) {
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("Invalid %s: %s\nExpected: a positive integer", name, raw)
	}
	return v, nil
}

func nonNegativeInt(raw, name string) (int, error) {
	v, err := strconv.Atoi(raw)
	if err != nil || v < 0 {
		return 0, fmt.Errorf("Invalid %s: %s\nExpected: a non-negative integer", name, raw)
	}
	return v, nil
}

func positiveFloat(raw, name string) (float64, error) {
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("Invalid %s: %s\nExpected: a positive number", name, raw)
	}
	return v, nil
}

func parseBool(raw string) (bool, error) {
	switch strings.ToLower(raw) {
	case "true", "":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("Invalid boolean value: %s. Expected true or false.", raw)
	}
}

func copyStringParam(params map[string]any, opts options, optName, paramName string) {
	if value := opts.first(optName); value != "" {
		params[paramName] = value
	}
}

func copyBoolParam(params map[string]any, opts options, optName, paramName string) error {
	if _, ok := opts[optName]; ok {
		value, err := parseBool(opts.first(optName))
		if err != nil {
			return err
		}
		params[paramName] = value
	}
	return nil
}

func normalizeTranslationModel(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "standard":
		return "Standard", nil
	case "pro":
		return "Pro", nil
	default:
		return "", fmt.Errorf("Invalid model: %s. Expected one of: Standard, Pro", value)
	}
}

func formatTaskDetails(task *deckops.Task) string {
	lines := []string{
		"Task Details:",
		"  ID: " + task.ID,
		"  Type: " + string(task.Type),
		"  Status: " + string(task.Status),
	}
	if task.Name != "" {
		lines = append(lines, "  Name: "+task.Name)
	}
	if task.Error != "" {
		lines = append(lines, "  Error: "+task.Error)
	}
	if task.Result != nil {
		b, _ := json.MarshalIndent(task.Result, "", "  ")
		lines = append(lines, "  Result: "+string(b))
	}
	return strings.Join(lines, "\n")
}

type outputWriteResult struct {
	Kind  string   `json:"kind"`
	Path  string   `json:"path"`
	Files []string `json:"files,omitempty"`
}

func (c *appContext) tryWriteTaskOutput(ctx context.Context, client *deckops.Client, task *deckops.Task, outPath string) (outputWriteResult, bool) {
	if task.Status != deckops.TaskStatusCompleted {
		return outputWriteResult{}, false
	}
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		result, err := c.writeTaskOutput(ctx, client, task, outPath)
		if err == nil {
			return result, true
		}
		lastErr = err
		if attempt < 3 {
			time.Sleep(10 * time.Second)
		}
	}
	message := fmt.Sprintf("Task completed, but --out result could not be saved to %s after 3 attempts. The task result will be printed below; you can manually download the file from the target/result JSON.", outPath)
	if c.json {
		data, _ := json.Marshal(map[string]any{"warning": message, "error": lastErr.Error()})
		fmt.Fprintln(os.Stderr, string(data))
	} else {
		fmt.Fprintln(os.Stderr, "Warning:", message)
		fmt.Fprintln(os.Stderr, "Last error:", lastErr)
	}
	return outputWriteResult{}, false
}

func (c *appContext) writeTaskOutput(ctx context.Context, client *deckops.Client, task *deckops.Task, outPath string) (outputWriteResult, error) {
	var downloadResult any
	if err := client.Tasks.Down(ctx, task.ID, deckops.TaskDownloadOptions{}, &downloadResult); err != nil {
		return outputWriteResult{}, err
	}
	files := collectOutputFiles(downloadResult)
	if len(files) == 0 {
		target, err := resolveSingleOutputPath(outPath, task.ID, ".json")
		if err != nil {
			return outputWriteResult{}, err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return outputWriteResult{}, err
		}
		payload := downloadResult
		if payload == nil {
			payload = task.Result
		}
		if payload == nil {
			payload = task
		}
		data, _ := json.MarshalIndent(payload, "", "  ")
		data = append(data, '\n')
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return outputWriteResult{}, err
		}
		abs, _ := filepath.Abs(target)
		return outputWriteResult{Kind: "json", Path: abs}, nil
	}
	if len(files) == 1 {
		target, err := resolveSingleOutputPath(outPath, task.ID, files[0].Ext)
		if err != nil {
			return outputWriteResult{}, err
		}
		data, err := downloadFile(ctx, files[0].URL)
		if err != nil {
			return outputWriteResult{}, err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return outputWriteResult{}, err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return outputWriteResult{}, err
		}
		abs, _ := filepath.Abs(target)
		return outputWriteResult{Kind: "file", Path: abs}, nil
	}
	downloaded := make([][]byte, len(files))
	for i, file := range files {
		data, err := downloadFile(ctx, file.URL)
		if err != nil {
			return outputWriteResult{}, err
		}
		downloaded[i] = data
	}
	outExt := strings.ToLower(filepath.Ext(outPath))
	if !isDirectory(outPath) && outExt == ".zip" {
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			return outputWriteResult{}, err
		}
		if err := writeZip(outPath, files, downloaded); err != nil {
			return outputWriteResult{}, err
		}
		abs, _ := filepath.Abs(outPath)
		return outputWriteResult{Kind: "zip", Path: abs}, nil
	}
	if err := os.MkdirAll(outPath, 0o755); err != nil {
		return outputWriteResult{}, err
	}
	written := make([]string, 0, len(files))
	for i, file := range files {
		target := filepath.Join(outPath, orderedFileName(i, len(files), file.Ext))
		if err := os.WriteFile(target, downloaded[i], 0o644); err != nil {
			return outputWriteResult{}, err
		}
		abs, _ := filepath.Abs(target)
		written = append(written, abs)
	}
	abs, _ := filepath.Abs(outPath)
	return outputWriteResult{Kind: "directory", Path: abs, Files: written}, nil
}

func (c *appContext) outputTaskSaved(result outputWriteResult) {
	c.output(map[string]any{"output": result.Path}, func() string { return "Result saved to " + result.Path })
}

type outputFile struct {
	URL string
	Ext string
}

func collectOutputFiles(value any) []outputFile {
	var files []outputFile
	visitOutputValue(value, &files)
	return files
}

func visitOutputValue(value any, files *[]outputFile) {
	switch v := value.(type) {
	case []any:
		if len(v) > 0 {
			if raw, ok := v[0].(string); ok {
				addOutputFile(raw, files)
				return
			}
		}
		for _, item := range v {
			visitOutputValue(item, files)
		}
	case map[string]any:
		if raw, ok := v["downloadUrl"].(string); ok {
			addOutputFile(raw, files)
		}
		for _, item := range v {
			visitOutputValue(item, files)
		}
	}
}

func addOutputFile(raw string, files *[]outputFile) {
	if !strings.HasPrefix(strings.ToLower(raw), "http://") && !strings.HasPrefix(strings.ToLower(raw), "https://") {
		return
	}
	*files = append(*files, outputFile{URL: raw, Ext: extensionFromURL(raw)})
}

func extensionFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err == nil {
		if ext := strings.ToLower(filepath.Ext(u.Path)); ext != "" {
			return ext
		}
	}
	if ext := strings.ToLower(filepath.Ext(strings.Split(raw, "?")[0])); ext != "" {
		return ext
	}
	return ".bin"
}

func resolveSingleOutputPath(outPath, taskID, expectedExt string) (string, error) {
	outExt := strings.ToLower(filepath.Ext(outPath))
	if isDirectory(outPath) || outExt == "" || outExt != strings.ToLower(expectedExt) {
		return filepath.Join(outPath, taskID+expectedExt), nil
	}
	return outPath, nil
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func downloadFile(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Failed to download %s: %s", rawURL, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func orderedFileName(index, total int, ext string) string {
	width := len(strconv.Itoa(total))
	if width < 2 {
		width = 2
	}
	return fmt.Sprintf("%0*d%s", width, index+1, ext)
}

func writeZip(path string, files []outputFile, data [][]byte) error {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i, file := range files {
		w, err := zw.Create(orderedFileName(i, len(files), file.Ext))
		if err != nil {
			return err
		}
		if _, err := w.Write(data[i]); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func keysNested(m map[string]map[string]string) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
