package deckops

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	DefaultRoot         = "https://app.deckflow.com/v1"
	DefaultTimeout      = 300 * time.Second
	DefaultPollInterval = 2 * time.Second
	DefaultChunkSize    = 10 * 1024 * 1024
	// InlineTaskFilesMaxBytes: when creating a task with files under this total size,
	// attach them inline as `files` instead of async upload + `fileIds`.
	InlineTaskFilesMaxBytes = 10 * 1024 * 1024
)

type TaskType string

const (
	TaskFileCompress         TaskType = "file.compress"
	TaskImageOCR             TaskType = "image.ocr"
	TaskImageConvertWebp     TaskType = "image.convertWebp"
	TaskImageResize          TaskType = "image.resize"
	TaskPptxSplit            TaskType = "pptx.split"
	TaskPptxJoin             TaskType = "pptx.join"
	TaskPptxGetFontInfo      TaskType = "pptx.getFontInfo"
	TaskPptxGetTextShapes    TaskType = "pptx.getTextShapes"
	TaskPptxEmbedFonts       TaskType = "pptx.embedFonts"
	TaskConvertPptToImage    TaskType = "convertor.ppt2image"
	TaskConvertPptToPptx     TaskType = "convertor.ppt2pptx"
	TaskConvertPptToPDF      TaskType = "convertor.ppt2pdf"
	TaskConvertDocToPDF      TaskType = "convertor.doc2pdf"
	TaskConvertPptToVideo    TaskType = "convertor.ppt2video"
	TaskConvertPDFToImage    TaskType = "convertor.pdf2image"
	TaskConvertKeynoteImage  TaskType = "convertor.keynote2image"
	TaskConvertKeynoteHTML   TaskType = "convertor.keynote2html"
	TaskConvertKeynotePDF    TaskType = "convertor.keynote2pdf"
	TaskConvertHTMLToPNG     TaskType = "convertor.html2png"
	TaskConvertMarkdownToPNG TaskType = "convertor.markdown2png"
	TaskConvertHTMLToPptx    TaskType = "convertor.html2pptx"
	TaskHTMLBuildPlayer      TaskType = "html.buildPlayer"
	TaskVideoCompress        TaskType = "video.compress"
	TaskPDFParse             TaskType = "pdf.pdfParse"
	TaskPptxParse            TaskType = "pptx.parse"
	TaskDocxParse            TaskType = "docx.parseTextAndImage"
	TaskKeynoteParse         TaskType = "keynote.parseTextAndImage"
	TaskHTMLGetByURL         TaskType = "html.getByURL"
	TaskGeneration           TaskType = "generation"
	TaskTranslation          TaskType = "translation"
	TaskRevamp               TaskType = "revamp"
)

type TaskStatus string

const (
	TaskStatusPending   TaskStatus = "pending"
	TaskStatusRunning   TaskStatus = "running"
	TaskStatusCompleted TaskStatus = "completed"
	TaskStatusFailed    TaskStatus = "failed"
)

type UserSelf struct {
	ID string `json:"id"`
}

type ClientOptions struct {
	Root              string
	Token             string
	APIKey            string
	SpaceID           string
	AuthUUID          string
	AuthUUIDStorage   AuthUUIDStorage
	HTTPClient        *http.Client
	// OnUnauthorized is called once after a 401 when a user token is present.
	// The returned token is saved and the request is retried. If omitted or
	// refresh fails, credentials are cleared and the request is retried as guest.
	OnUnauthorized    func(context.Context) (AuthRefresh, error)
	OnPaymentRequired func(context.Context) error
}

type AuthRefresh struct {
	Token   string
	SpaceID string
}

type AuthUUIDStorage interface {
	Get(context.Context) (string, error)
	Set(context.Context, string) error
}

type Task struct {
	ID      string         `json:"id"`
	SpaceID string         `json:"spaceId"`
	Type    TaskType       `json:"type"`
	Status  TaskStatus     `json:"status"`
	FileIDs []string       `json:"fileIds,omitempty"`
	Name    string         `json:"name,omitempty"`
	Params  map[string]any `json:"params,omitempty"`
	Preview any            `json:"preview,omitempty"`
	// Result is optional on detail responses. Prefer Tasks.Down — detail no longer includes results.
	Result    any                    `json:"result,omitempty"`
	Error     string                 `json:"error,omitempty"`
	CreatedAt string                 `json:"createdAt,omitempty"`
	UpdatedAt string                 `json:"updatedAt,omitempty"`
	Raw       map[string]interface{} `json:"-"`
}

type CreateTaskParams struct {
	SpaceID string
	FileIDs []string
	Files   []TaskUploadInput
	Type    TaskType
	Name    string
	Params  map[string]any
	Upload  UploadOptions
}

type TaskShortcutParams struct {
	SpaceID string
	FileIDs []string
	Files   []TaskUploadInput
	Name    string
	Params  map[string]any
	Upload  UploadOptions
}

type ListTasksParams struct {
	SpaceID    string
	Type       TaskType
	StartIndex int
	MaxResults int
	HasStart   bool
	HasMax     bool
}

type TaskListResponse struct {
	Tasks []Task
	Total int
}

type WaitForTaskOptions struct {
	Timeout      time.Duration
	DisableSSE   bool
	PollInterval time.Duration
	OnProgress   func(Task)
}

type SubscribeTaskHandlers struct {
	OnUpdate func(Task)
	OnError  func(error)
}

type TaskDownloadOptions struct {
	Type string
}

type DownloadURLResult struct {
	DownloadURL string `json:"downloadUrl"`
}

type UploadPlatform string

const (
	UploadPlatformOSS   UploadPlatform = "oss"
	UploadPlatformLocal UploadPlatform = "local"
)

type UploadInput struct {
	Name   string
	Data   []byte
	Path   string
	Reader io.Reader
	Bytes  int64
	Hash   string
}

type UploadOptions struct {
	SpaceID    string
	Name       string
	Hash       string
	ChunkSize  int64
	OnProgress func(float64)
}

type TaskUploadInput struct {
	Input   UploadInput
	Options UploadOptions
}

type FileUploadResult struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Key   string `json:"key,omitempty"`
	Bytes int64  `json:"bytes"`
	Hash  string `json:"hash"`
}

type RequestUploadParams struct {
	SpaceID   string `json:"-"`
	Name      string `json:"name"`
	Bytes     int64  `json:"bytes"`
	Hash      string `json:"hash"`
	ChunkSize int64  `json:"chunkSize,omitempty"`
}

type UploadAuthResponse struct {
	ID                 string         `json:"id"`
	Key                string         `json:"key"`
	Hash               string         `json:"hash"`
	Platform           UploadPlatform `json:"platform"`
	Multipart          bool           `json:"multipart"`
	Auth               *AuthInfo      `json:"auth,omitempty"`
	MultipartUploadID  string         `json:"multipartUploadId,omitempty"`
	MultipartPartSize  int64          `json:"multipartPartSize,omitempty"`
	MultipartPartAuths []PartAuth     `json:"multipartPartAuths,omitempty"`
}

type AuthInfo struct {
	URL           string            `json:"url"`
	Headers       map[string]string `json:"headers"`
	Authorization string            `json:"Authorization,omitempty"`
}

type PartAuth struct {
	URL           string            `json:"url"`
	Headers       map[string]string `json:"headers"`
	Authorization string            `json:"Authorization,omitempty"`
}

type PartResult struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"eTag,omitempty"`
	Hash       string `json:"hash,omitempty"`
}

type ConvertFileBounds struct {
	W     float64 `json:"w,omitempty"`
	H     float64 `json:"h,omitempty"`
	Total int     `json:"total,omitempty"`
}

type FileResult struct {
	Path  string
	Bytes int64
	Hash  string
}

// FileResult travels as a [path, bytes, hash] tuple, not an object, so it needs
// its own codec to survive a round trip through encoding/json.
func (f *FileResult) UnmarshalJSON(data []byte) error {
	var tuple []json.RawMessage
	if err := json.Unmarshal(data, &tuple); err != nil {
		return fmt.Errorf("FileResult: %w", err)
	}
	if len(tuple) < 3 {
		return fmt.Errorf("FileResult: want [path, bytes, hash], got %d elements", len(tuple))
	}
	if err := json.Unmarshal(tuple[0], &f.Path); err != nil {
		return fmt.Errorf("FileResult.Path: %w", err)
	}
	if err := json.Unmarshal(tuple[1], &f.Bytes); err != nil {
		return fmt.Errorf("FileResult.Bytes: %w", err)
	}
	if err := json.Unmarshal(tuple[2], &f.Hash); err != nil {
		return fmt.Errorf("FileResult.Hash: %w", err)
	}
	return nil
}

func (f FileResult) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{f.Path, f.Bytes, f.Hash})
}

type ConvertFileResult struct {
	Path   string
	Bytes  int64
	Hash   string
	Bounds *ConvertFileBounds
}

// ParseMode controls whether html.getByURL parses page source or the rendered page.
type ParseMode string

const (
	ParseModeSource  ParseMode = "source"
	ParseModeRuntime ParseMode = "runtime"
)

// ParseOutput selects what Parse asks the backend for.
type ParseOutput string

const (
	// ParseOutputMarkdown returns Markdown only, dropping the structured result.
	ParseOutputMarkdown ParseOutput = "markdown"
	// ParseOutputIR skips Markdown rendering and returns the structured result.
	ParseOutputIR ParseOutput = "ir"
	// ParseOutputAll returns both.
	ParseOutputAll ParseOutput = "all"
)

// ParseSource describes one document or URL passed to Parse.
//
// Exactly one of URL, FileID, or File should be set. Name is required with
// FileID and with in-memory files whose name cannot otherwise be inferred.
type ParseSource struct {
	File   *TaskUploadInput
	FileID string
	Name   string
	URL    string
	Mode   ParseMode
}

// ParseOptions carries the Markdown switches and the per-parser passthrough
// params. Fields that a given task type does not accept are not sent.
type ParseOptions struct {
	// Output defaults to ParseOutputMarkdown.
	Output  ParseOutput
	SpaceID string
	Wait    WaitForTaskOptions

	// MarkdownPages requests the per-page Markdown array; paginated formats
	// (pptx, keynote) only.
	MarkdownPages *bool
	// MarkdownStrict makes the backend fail instead of returning MarkdownError.
	MarkdownStrict *bool

	// Password opens an encrypted PDF.
	Password string
	// ParseProfile picks the pdf accuracy/cost tier: fast, balanced, quality.
	ParseProfile string
	// IncludeImages extracts and stores pdf images; defaults to true.
	IncludeImages *bool
	// MarkdownMeta writes per-element provenance comments into pdf Markdown.
	MarkdownMeta *bool

	// StayImageAreaRate is the keynote image area retention rate, 0-1.
	StayImageAreaRate *float64
}

// ParseResult is what Parse returns: the Markdown fields, the raw structured
// payload, and the task that produced them.
//
// Markdown fields are filled for ParseOutputMarkdown and ParseOutputAll;
// Result is filled for ParseOutputIR and ParseOutputAll and holds the backend
// response verbatim, so under ParseOutputAll the Markdown fields appear in it
// as well.
type ParseResult struct {
	TaskID string
	Type   TaskType

	Markdown string
	// MarkdownPages is set when MarkdownPages was requested on a paginated format.
	MarkdownPages []string
	// MarkdownImages maps image access URLs in the Markdown to their durable
	// keys; returned under ParseOutputMarkdown.
	MarkdownImages map[string]FileResult
	// MarkdownError carries the reason Markdown rendering failed in the
	// backend's default lenient mode.
	MarkdownError string

	// Result is the raw response body; unmarshal it into the shape your task
	// type returns.
	Result json.RawMessage
}

// PageSeparator joins pages inside Markdown for paginated formats, so
// strings.Split(markdown, PageSeparator) restores the pagination.
const PageSeparator = "\n\n---\n\n"

// markdownResult mirrors the Markdown fields every parse service returns.
type markdownResult struct {
	Markdown       string                `json:"markdown,omitempty"`
	MarkdownPages  []string              `json:"markdownPages,omitempty"`
	MarkdownImages map[string]FileResult `json:"markdownImages,omitempty"`
	MarkdownError  string                `json:"markdownError,omitempty"`
}

// PDFParseProfile is the pdf.pdfParse accuracy/cost tier.
type PDFParseProfile = string

const (
	PDFParseProfileFast     PDFParseProfile = "fast"
	PDFParseProfileBalanced PDFParseProfile = "balanced"
	PDFParseProfileQuality  PDFParseProfile = "quality"
)

// StoredPDFAsset identifies a pdf image after the backend stored it.
type StoredPDFAsset struct {
	// Key is the durable identifier; use it for long-term references.
	Key   string `json:"key"`
	Bytes int64  `json:"bytes"`
	Hash  string `json:"hash"`
	// AccessURL is signed and expires.
	AccessURL string `json:"accessURL"`
}

// ParsedPDFAsset is a stored image keyed by its path inside the parse artifact.
type ParsedPDFAsset struct {
	StoredPDFAsset
	// AssetPath looks like assets/p1_i0000.png and links back to the IR.
	AssetPath string `json:"assetPath"`
}

// PDFDocInfo is the pdf document metadata block.
type PDFDocInfo struct {
	Status     string  `json:"status"`
	Title      *string `json:"title"`
	Author     *string `json:"author"`
	Subject    *string `json:"subject"`
	Keywords   *string `json:"keywords"`
	Creator    *string `json:"creator"`
	Producer   *string `json:"producer"`
	CreatedAt  *string `json:"createdAt"`
	ModifiedAt *string `json:"modifiedAt"`
	Lang       *string `json:"lang"`
}

// PDFParseResult is the pdf.pdfParse structured result. Document stays
// map-shaped: it is the complete IR and gains fields without an SDK release.
type PDFParseResult struct {
	markdownResult
	Document map[string]any   `json:"document"`
	Images   []ParsedPDFAsset `json:"images"`
}

// PDFParseMarkdownOnlyResult is what pdf.pdfParse returns under markdownOnly.
type PDFParseMarkdownOnlyResult struct {
	markdownResult
	PageNum      int             `json:"pageNum"`
	ParseProfile PDFParseProfile `json:"parseProfile"`
	DocInfo      PDFDocInfo      `json:"docInfo"`
}

type KeynoteTextItem struct {
	ID   string `json:"id"`
	Text string `json:"text,omitempty"`
}

type KeynoteTableItem struct {
	ID   string   `json:"id"`
	Data []string `json:"data"`
}

type KeynoteChartData struct {
	RowName    []string `json:"rowName"`
	ColumnName []string `json:"columnName"`
}

type KeynoteChartItem struct {
	ID   string           `json:"id"`
	Data KeynoteChartData `json:"data"`
}

type KeynoteSlide struct {
	Text  []KeynoteTextItem  `json:"text"`
	Table []KeynoteTableItem `json:"table"`
	Chart []KeynoteChartItem `json:"chart"`
}

type KeynoteImageItem struct {
	ID        string   `json:"id"`
	FileName  string   `json:"fileName"`
	PageIndex *float64 `json:"pageIndex,omitempty"`
	Key       string   `json:"key"`
}

type KeynoteParseResult struct {
	markdownResult
	PageNum int                `json:"pageNum"`
	Width   float64            `json:"width"`
	Height  float64            `json:"height"`
	Slides  []KeynoteSlide     `json:"slides"`
	Images  []KeynoteImageItem `json:"images,omitempty"`
}

type DocxTextStyle struct {
	StyleID    string   `json:"styleId,omitempty"`
	StyleName  string   `json:"styleName,omitempty"`
	OutlineLvl *float64 `json:"outlineLvl,omitempty"`
	FontSize   float64  `json:"fontSize,omitempty"`
	Bold       bool     `json:"bold,omitempty"`
	Italic     bool     `json:"italic,omitempty"`
}

// DocxElement represents every element variant returned by
// docx.parseTextAndImage. Fields not used by a particular Type are empty.
type DocxElement struct {
	Idx        int               `json:"idx"`
	Type       string            `json:"type"`
	Text       string            `json:"text,omitempty"`
	Style      *DocxTextStyle    `json:"style,omitempty"`
	Image      string            `json:"image,omitempty"`
	Name       string            `json:"name,omitempty"`
	Hash       string            `json:"hash,omitempty"`
	Bytes      int64             `json:"bytes,omitempty"`
	Children   []DocxElement     `json:"children,omitempty"`
	Table      []DocxElement     `json:"table,omitempty"`
	Series     []string          `json:"series,omitempty"`
	Categories []string          `json:"categories,omitempty"`
	Texts      []DocxDiagramText `json:"texts,omitempty"`
}

type DocxDiagramText struct {
	Idx int                    `json:"idx"`
	APs []DocxDiagramParagraph `json:"aps"`
}

type DocxDiagramParagraph struct {
	Idx  int    `json:"idx"`
	Text string `json:"text"`
}

type DocxParseResult struct {
	markdownResult
	Width   float64       `json:"width"`
	Height  float64       `json:"height"`
	PageNum int           `json:"pageNum"`
	Content []DocxElement `json:"content"`
}

type HTMLGetByURLResult struct {
	markdownResult
	HTML string `json:"html"`
}

// PptxParseResult remains map-shaped because pptx.parse returns the complete
// presentation model and may add OOXML attributes without an SDK release.
type PptxParseResult map[string]any
