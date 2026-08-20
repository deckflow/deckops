package deckops

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Parse routes a document or URL through its parser, waits for the task, and
// returns whatever ParseOptions.Output asked for.
//
// Markdown is rendered by the backend (slave >= 0.21.0); this only routes the
// input, translates Output into the backend's markdown switches, and sorts the
// response into Markdown fields plus the raw payload.
//
//	res, err := deck.Parse(ctx, deckops.ParseSource{File: &upload}, deckops.ParseOptions{})
//	res.Markdown
//
//	res, err := deck.Parse(ctx, src, deckops.ParseOptions{Output: deckops.ParseOutputIR})
//	json.Unmarshal(res.Result, &document)
func (c *Client) Parse(ctx context.Context, source ParseSource, options ParseOptions) (*ParseResult, error) {
	output := options.Output
	if output == "" {
		output = ParseOutputMarkdown
	}
	if _, ok := markdownSwitches(output); !ok {
		return nil, fmt.Errorf("unsupported parse output: %q", output)
	}

	if source.URL != "" {
		mode := source.Mode
		if mode == "" {
			mode = ParseModeRuntime
		}
		params := taskParams(TaskHTMLGetByURL, output, options)
		params["url"] = source.URL
		params["mode"] = mode
		task, err := c.HTMLGetByURL(ctx, TaskShortcutParams{SpaceID: options.SpaceID, Params: params})
		if err != nil {
			return nil, err
		}
		return c.finishParse(ctx, task, TaskHTMLGetByURL, options, output)
	}

	name := parseSourceName(source)
	taskType, ok := ParseTaskTypeFor(name)
	if !ok {
		return nil, unsupportedParseSource(name)
	}

	params := TaskShortcutParams{SpaceID: options.SpaceID, Params: taskParams(taskType, output, options)}
	switch {
	case source.FileID != "":
		params.FileIDs = []string{source.FileID}
	case source.File != nil:
		params.Files = []TaskUploadInput{*source.File}
	default:
		return nil, unsupportedParseSource(name)
	}
	task, err := c.shortcut(ctx, taskType, params)
	if err != nil {
		return nil, err
	}
	return c.finishParse(ctx, task, taskType, options, output)
}

func (c *Client) finishParse(
	ctx context.Context,
	task *Task,
	taskType TaskType,
	options ParseOptions,
	output ParseOutput,
) (*ParseResult, error) {
	done, err := c.Tasks.Wait(ctx, task.ID, options.Wait)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err := c.Tasks.Down(ctx, done.ID, TaskDownloadOptions{}, &raw); err != nil {
		return nil, err
	}

	result := &ParseResult{TaskID: done.ID, Type: taskType}
	if output != ParseOutputIR {
		var body markdownResult
		if err := json.Unmarshal(raw, &body); err != nil {
			return nil, fmt.Errorf("%s result: %w", taskType, err)
		}
		result.Markdown = body.Markdown
		result.MarkdownPages = body.MarkdownPages
		result.MarkdownImages = body.MarkdownImages
		result.MarkdownError = body.MarkdownError
	}
	if output != ParseOutputMarkdown {
		result.Result = raw
	}
	return result, nil
}

// markdownSwitches maps an Output tier onto the backend's markdown params:
// markdown-only drops the structured result to shrink the response, ir skips
// rendering entirely, all keeps both.
func markdownSwitches(output ParseOutput) (map[string]any, bool) {
	switch output {
	case ParseOutputMarkdown:
		return map[string]any{"markdown": true, "markdownOnly": true}, true
	case ParseOutputAll:
		return map[string]any{"markdown": true}, true
	case ParseOutputIR:
		return map[string]any{}, true
	default:
		return nil, false
	}
}

// taskParams builds the markdown switches plus the passthrough params this task
// type accepts. Params a type does not accept are dropped rather than sent.
func taskParams(taskType TaskType, output ParseOutput, options ParseOptions) map[string]any {
	params, _ := markdownSwitches(output)
	if options.MarkdownStrict != nil {
		params["markdownStrict"] = *options.MarkdownStrict
	}

	switch taskType {
	case TaskPDFParse:
		if options.Password != "" {
			params["password"] = options.Password
		}
		if options.ParseProfile != "" {
			params["parseProfile"] = options.ParseProfile
		}
		if options.IncludeImages != nil {
			params["includeImages"] = *options.IncludeImages
		}
		if options.MarkdownMeta != nil {
			params["markdownMeta"] = *options.MarkdownMeta
		}
	case TaskPptxParse:
		if options.MarkdownPages != nil {
			params["markdownPages"] = *options.MarkdownPages
		}
	case TaskKeynoteParse:
		if options.MarkdownPages != nil {
			params["markdownPages"] = *options.MarkdownPages
		}
		if options.StayImageAreaRate != nil {
			params["stayImageAreaRate"] = *options.StayImageAreaRate
		}
	}
	return params
}

func parseSourceName(source ParseSource) string {
	if source.Name != "" {
		return source.Name
	}
	if source.File == nil {
		return ""
	}
	if source.File.Options.Name != "" {
		return source.File.Options.Name
	}
	if source.File.Input.Name != "" {
		return source.File.Input.Name
	}
	return source.File.Input.Path
}

func unsupportedParseSource(name string) error {
	label := "input"
	if name != "" {
		label = fmt.Sprintf("%q", name)
	}
	return fmt.Errorf(
		"cannot determine parser for %s. Supported extensions: %s. Pass Name to specify the file name",
		label,
		strings.Join(ParseSupportedExtensions, ", "),
	)
}
