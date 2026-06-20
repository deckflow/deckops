package deckops

import (
	"context"
)

type Client struct {
	root  string
	http  *httpClient
	Tasks *TasksClient
	TTask *TasksClient
	Files *FilesClient
}

func New(ctx context.Context, options ClientOptions) (*Client, error) {
	httpClient, err := newHTTPClient(ctx, options)
	if err != nil {
		return nil, err
	}
	files := &FilesClient{http: httpClient}
	tasks := &TasksClient{http: httpClient, files: files}
	return &Client{
		root:  httpClient.Root(),
		http:  httpClient,
		Tasks: tasks,
		TTask: tasks,
		Files: files,
	}, nil
}

func CreateDeck(ctx context.Context, options ClientOptions) (*Client, error) {
	return New(ctx, options)
}

func (c *Client) Root() string {
	return c.root
}

func (c *Client) SetToken(token string) {
	c.http.SetToken(token)
}

func (c *Client) SetAPIKey(apiKey string) {
	c.http.SetAPIKey(apiKey)
}

func (c *Client) SetSpaceID(spaceID string) {
	c.http.SetSpaceID(spaceID)
}

func (c *Client) AuthUUID() string {
	return c.http.AuthUUID()
}

func (c *Client) FileCompress(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskFileCompress, params)
}

func (c *Client) ImageOCR(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskImageOCR, params)
}

func (c *Client) ImageConvertWebp(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskImageConvertWebp, params)
}

func (c *Client) ImageResize(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskImageResize, params)
}

func (c *Client) PptxSplit(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskPptxSplit, params)
}

func (c *Client) PptxJoin(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskPptxJoin, params)
}

func (c *Client) PptxGetFontInfo(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskPptxGetFontInfo, params)
}

func (c *Client) PptxGetTextShapes(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskPptxGetTextShapes, params)
}

func (c *Client) PptxEmbedFonts(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskPptxEmbedFonts, params)
}

func (c *Client) ConvertPptToImage(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertPptToImage, params)
}

func (c *Client) ConvertPptToPptx(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertPptToPptx, params)
}

func (c *Client) ConvertPptToPDF(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertPptToPDF, params)
}

func (c *Client) ConvertDocToPDF(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertDocToPDF, params)
}

func (c *Client) ConvertPptToVideo(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertPptToVideo, params)
}

func (c *Client) ConvertPDFToImage(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertPDFToImage, params)
}

func (c *Client) ConvertKeynoteToImage(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertKeynoteImage, params)
}

func (c *Client) ConvertKeynoteToHTML(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertKeynoteHTML, params)
}

func (c *Client) ConvertKeynoteToPDF(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertKeynotePDF, params)
}

func (c *Client) ConvertHTMLToPNG(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertHTMLToPNG, params)
}

func (c *Client) ConvertMarkdownToPNG(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertMarkdownToPNG, params)
}

func (c *Client) ConvertHTMLToPptx(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskConvertHTMLToPptx, params)
}

func (c *Client) HTMLBuildPlayer(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskHTMLBuildPlayer, params)
}

func (c *Client) Generation(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskGeneration, params)
}

func (c *Client) Translation(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskTranslation, params)
}

func (c *Client) Revamp(ctx context.Context, params TaskShortcutParams) (*Task, error) {
	return c.shortcut(ctx, TaskRevamp, params)
}

func (c *Client) shortcut(ctx context.Context, taskType TaskType, params TaskShortcutParams) (*Task, error) {
	return c.Tasks.Create(ctx, CreateTaskParams{
		SpaceID: params.SpaceID,
		FileIDs: params.FileIDs,
		Files:   params.Files,
		Type:    taskType,
		Name:    params.Name,
		Params:  params.Params,
		Upload:  params.Upload,
	})
}
