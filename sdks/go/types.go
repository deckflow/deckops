package deckops

import (
	"context"
	"io"
	"net/http"
	"time"
)

const (
	DefaultRoot         = "https://app.deckflow.com/v1"
	DefaultTimeout      = 300 * time.Second
	DefaultPollInterval = 2 * time.Second
	DefaultChunkSize    = 10 * 1024 * 1024
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
	TaskPDFParse             TaskType = "pdf.parse"
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
	ID        string                 `json:"id"`
	SpaceID   string                 `json:"spaceId"`
	Type      TaskType               `json:"type"`
	Status    TaskStatus             `json:"status"`
	FileIDs   []string               `json:"fileIds,omitempty"`
	Name      string                 `json:"name,omitempty"`
	Params    map[string]any         `json:"params,omitempty"`
	Preview   any                    `json:"preview,omitempty"`
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

// ParseInput describes one document or URL passed to Parse or ParseDetailed.
//
// Exactly one of URL, FileID, or File should be set. Name is required with
// FileID and with in-memory files whose name cannot otherwise be inferred.
type ParseInput struct {
	File    *TaskUploadInput
	FileID  string
	Name    string
	URL     string
	Mode    ParseMode
	SpaceID string
	Wait    WaitForTaskOptions
}

// ParseResult is the Markdown result together with the task that produced it.
type ParseResult struct {
	Markdown string
	TaskID   string
	Type     TaskType
}

// MarkdownConvertOptions contains options shared by document converters.
type MarkdownConvertOptions struct {
	ToImageURL func(string) string
}

type ParseLocator struct {
	PageIndex int `json:"pageIndex"`
}

type PDFTextBlockStyle struct {
	Bold   bool `json:"bold,omitempty"`
	Italic bool `json:"italic,omitempty"`
}

type PDFTextBlock struct {
	Text    string             `json:"text"`
	Role    string             `json:"role,omitempty"`
	Style   *PDFTextBlockStyle `json:"style,omitempty"`
	Locator *ParseLocator      `json:"locator,omitempty"`
}

type PDFImage struct {
	Key      string        `json:"key,omitempty"`
	FileName string        `json:"fileName,omitempty"`
	Locator  *ParseLocator `json:"locator,omitempty"`
	Bytes    int64         `json:"bytes,omitempty"`
	Hash     string        `json:"hash,omitempty"`
}

type PDFParseResult struct {
	TextBlocks []PDFTextBlock `json:"textBlocks"`
	Images     []PDFImage     `json:"images,omitempty"`
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
	Width   float64       `json:"width"`
	Height  float64       `json:"height"`
	PageNum int           `json:"pageNum"`
	Content []DocxElement `json:"content"`
}

type HTMLGetByURLResult struct {
	HTML string `json:"html"`
}

// PptxParseResult remains map-shaped because pptx.parse returns the complete
// presentation model and may add OOXML attributes without an SDK release.
type PptxParseResult map[string]any

// PptxConvertOptions controls geometry-based reading-order extraction.
type PptxConvertOptions struct {
	MarkdownConvertOptions
	MinImageBytes             *int64
	VerticalToleranceFactor   float64
	AbsoluteVerticalTolerance *float64
	InlineSeparator           string
	BlockSeparator            string
	RowSeparator              string
	DropEmptyText             *bool
	// Deprecated: retained for source compatibility; the current algorithm
	// uses AbsoluteVerticalTolerance instead.
	MinRowHeight float64
	// Deprecated: retained for source compatibility; the current algorithm
	// uses a two-dimensional nearest-neighbor chain.
	HorizontalGroupingThreshold float64
}
