package deckops

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Parse routes a supported document or URL through its parser and returns Markdown.
func (c *Client) Parse(ctx context.Context, input ParseInput) (string, error) {
	result, err := c.ParseDetailed(ctx, input)
	if err != nil {
		return "", err
	}
	return result.Markdown, nil
}

// ParseDetailed is Parse with the completed task ID and selected task type.
func (c *Client) ParseDetailed(ctx context.Context, input ParseInput) (*ParseResult, error) {
	if input.URL != "" {
		mode := input.Mode
		if mode == "" {
			mode = ParseModeRuntime
		}
		task, err := c.HTMLGetByURL(ctx, TaskShortcutParams{
			SpaceID: input.SpaceID,
			Params: map[string]any{
				"url":  input.URL,
				"mode": mode,
			},
		})
		if err != nil {
			return nil, err
		}
		return c.finishParse(ctx, task, TaskHTMLGetByURL, input.Wait, input.URL)
	}

	name := parseInputName(input)
	taskType, ok := ParseTaskTypeFor(name)
	if !ok {
		return nil, unsupportedParseInput(name)
	}

	params := TaskShortcutParams{SpaceID: input.SpaceID}
	switch {
	case input.FileID != "":
		params.FileIDs = []string{input.FileID}
	case input.File != nil:
		params.Files = []TaskUploadInput{*input.File}
	default:
		return nil, unsupportedParseInput(name)
	}
	task, err := c.shortcut(ctx, taskType, params)
	if err != nil {
		return nil, err
	}
	return c.finishParse(ctx, task, taskType, input.Wait, "")
}

func (c *Client) finishParse(
	ctx context.Context,
	task *Task,
	taskType TaskType,
	wait WaitForTaskOptions,
	sourceURL string,
) (*ParseResult, error) {
	done, err := c.Tasks.Wait(ctx, task.ID, wait)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err := c.Tasks.Down(ctx, done.ID, TaskDownloadOptions{}, &raw); err != nil {
		return nil, err
	}
	markdown, err := parseResultToMarkdown(taskType, raw, sourceURL)
	if err != nil {
		return nil, err
	}
	return &ParseResult{
		Markdown: markdown,
		TaskID:   done.ID,
		Type:     taskType,
	}, nil
}

func parseResultToMarkdown(taskType TaskType, raw json.RawMessage, sourceURL string) (string, error) {
	switch taskType {
	case TaskPDFParse:
		var result PDFParseResult
		if err := json.Unmarshal(raw, &result); err != nil {
			return "", fmt.Errorf("%s result: %w", taskType, err)
		}
		return PDFResultToMarkdown(result), nil
	case TaskPptxParse:
		var result PptxParseResult
		if err := json.Unmarshal(raw, &result); err != nil {
			return "", fmt.Errorf("%s result: %w", taskType, err)
		}
		return PptxResultToMarkdown(result), nil
	case TaskDocxParse:
		var result DocxParseResult
		if err := json.Unmarshal(raw, &result); err != nil {
			return "", fmt.Errorf("%s result: %w", taskType, err)
		}
		return DocxResultToMarkdown(result), nil
	case TaskKeynoteParse:
		var result KeynoteParseResult
		if err := json.Unmarshal(raw, &result); err != nil {
			return "", fmt.Errorf("%s result: %w", taskType, err)
		}
		return KeynoteResultToMarkdown(result), nil
	case TaskHTMLGetByURL:
		var result HTMLGetByURLResult
		if err := json.Unmarshal(raw, &result); err != nil {
			return "", fmt.Errorf("%s result: %w", taskType, err)
		}
		return HTMLToMarkdown(result.HTML, sourceURL)
	default:
		return "", fmt.Errorf("unsupported parser task type: %s", taskType)
	}
}

func parseInputName(input ParseInput) string {
	if input.Name != "" {
		return input.Name
	}
	if input.File == nil {
		return ""
	}
	if input.File.Options.Name != "" {
		return input.File.Options.Name
	}
	if input.File.Input.Name != "" {
		return input.File.Input.Name
	}
	return input.File.Input.Path
}

func unsupportedParseInput(name string) error {
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
