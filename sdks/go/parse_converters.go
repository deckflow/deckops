package deckops

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

const PageSeparator = "\n\n---\n\n"

// IdentityImageURL returns an image key unchanged.
func IdentityImageURL(value string) string {
	return value
}

func imageURLResolver(options MarkdownConvertOptions) func(string) string {
	if options.ToImageURL != nil {
		return options.ToImageURL
	}
	return IdentityImageURL
}

// PDFResultToMarkdown converts a pdf.parse result to Markdown in page order.
func PDFResultToMarkdown(result PDFParseResult, options ...MarkdownConvertOptions) string {
	toImageURL := imageURLResolver(firstMarkdownOptions(options))
	pageSet := make(map[int]struct{})
	for _, block := range result.TextBlocks {
		pageSet[locatorPage(block.Locator)] = struct{}{}
	}
	for _, image := range result.Images {
		pageSet[locatorPage(image.Locator)] = struct{}{}
	}

	pages := make([]int, 0, len(pageSet))
	for page := range pageSet {
		pages = append(pages, page)
	}
	sort.Ints(pages)

	var parts []string
	for _, page := range pages {
		for _, block := range result.TextBlocks {
			if locatorPage(block.Locator) != page {
				continue
			}
			if line := renderPDFTextBlock(block); line != "" {
				parts = append(parts, line)
			}
		}
		for _, image := range result.Images {
			if locatorPage(image.Locator) != page || image.Key == "" {
				continue
			}
			alt := image.FileName
			if alt == "" {
				alt = "img"
			}
			parts = append(parts, fmt.Sprintf("![%s](%s)", alt, toImageURL(image.Key)))
		}
	}
	return strings.Join(parts, "\n\n")
}

func locatorPage(locator *ParseLocator) int {
	if locator == nil {
		return 0
	}
	return locator.PageIndex
}

func renderPDFTextBlock(block PDFTextBlock) string {
	text := strings.TrimSpace(block.Text)
	if text == "" {
		return ""
	}
	switch block.Role {
	case "heading":
		return "## " + text
	case "list-item":
		return "- " + text
	case "caption":
		return "*" + text + "*"
	default:
		if block.Style != nil && block.Style.Bold {
			return "**" + text + "**"
		}
		if block.Style != nil && block.Style.Italic {
			return "*" + text + "*"
		}
		return text
	}
}

// KeynoteResultToMarkdown converts slides to Markdown separated by horizontal rules.
// Images with a missing or invalid page index are retained in a final fallback page.
func KeynoteResultToMarkdown(result KeynoteParseResult, options ...MarkdownConvertOptions) string {
	toImageURL := imageURLResolver(firstMarkdownOptions(options))
	byPage := make(map[int][]KeynoteImageItem)
	var unassigned []KeynoteImageItem
	for _, image := range result.Images {
		if image.Key == "" {
			continue
		}
		if image.PageIndex == nil ||
			*image.PageIndex < 0 ||
			math.Trunc(*image.PageIndex) != *image.PageIndex ||
			int(*image.PageIndex) >= len(result.Slides) {
			unassigned = append(unassigned, image)
			continue
		}
		pageIndex := int(*image.PageIndex)
		byPage[pageIndex] = append(byPage[pageIndex], image)
	}

	var pages []string
	for slideIndex, slide := range result.Slides {
		var lines []string
		for _, item := range slide.Text {
			if text := strings.TrimSpace(item.Text); text != "" {
				lines = append(lines, text)
			}
		}
		for _, table := range slide.Table {
			var cells []string
			for _, cell := range table.Data {
				if value := strings.TrimSpace(cell); value != "" {
					cells = append(cells, value)
				}
			}
			if len(cells) > 0 {
				lines = append(lines, strings.Join(cells, " | "))
			}
		}
		for _, chart := range slide.Chart {
			if values := nonEmptyStrings(chart.Data.ColumnName); len(values) > 0 {
				lines = append(lines, strings.Join(values, " | "))
			}
			if values := nonEmptyStrings(chart.Data.RowName); len(values) > 0 {
				lines = append(lines, strings.Join(values, " | "))
			}
		}
		for _, image := range byPage[slideIndex] {
			lines = append(lines, fmt.Sprintf("![img](%s)", toImageURL(image.Key)))
		}
		if len(lines) > 0 {
			pages = append(pages, strings.Join(lines, "\n"))
		}
	}

	if len(unassigned) > 0 {
		lines := make([]string, 0, len(unassigned))
		for _, image := range unassigned {
			lines = append(lines, fmt.Sprintf("![img](%s)", toImageURL(image.Key)))
		}
		pages = append(pages, strings.Join(lines, "\n"))
	}
	return strings.Join(pages, PageSeparator)
}

func nonEmptyStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return result
}

// DocxResultToMarkdown restores body order and renders paragraphs, media,
// tables, charts, diagrams, and grouped text.
func DocxResultToMarkdown(result DocxParseResult, options ...MarkdownConvertOptions) string {
	toImageURL := imageURLResolver(firstMarkdownOptions(options))
	content := append([]DocxElement(nil), result.Content...)
	sort.SliceStable(content, func(i, j int) bool { return content[i].Idx < content[j].Idx })

	var blocks []string
	for _, element := range content {
		if block := strings.TrimSpace(docxElementToBlock(element, toImageURL)); block != "" {
			blocks = append(blocks, block)
		}
	}
	return strings.Join(blocks, "\n\n")
}

func docxElementToBlock(element DocxElement, toImageURL func(string) string) string {
	switch element.Type {
	case "text":
		text := strings.TrimSpace(element.Text)
		if text == "" {
			return ""
		}
		return docxHeadingPrefix(element) + text
	case "image":
		if element.Image == "" {
			return ""
		}
		alt := "img"
		if element.Name != "" {
			alt = strings.TrimSuffix(element.Name, filepathExtension(element.Name))
		}
		return fmt.Sprintf("![%s](%s)", alt, toImageURL(element.Image))
	case "table":
		return docxTableToMarkdown(element.Table)
	case "chart":
		var lines []string
		if values := nonEmptyStrings(element.Categories); len(values) > 0 {
			lines = append(lines, strings.Join(values, " | "))
		}
		if values := nonEmptyStrings(element.Series); len(values) > 0 {
			lines = append(lines, strings.Join(values, " | "))
		}
		return strings.Join(lines, "\n")
	case "diagram":
		var lines []string
		for _, text := range element.Texts {
			for _, paragraph := range text.APs {
				if value := strings.TrimSpace(paragraph.Text); value != "" {
					lines = append(lines, value)
				}
			}
		}
		return strings.Join(lines, "\n")
	case "group", "wsp":
		return strings.Join(docxGroupLines(element), "\n")
	case "sdt":
		var lines []string
		for _, wrapper := range element.Children {
			for _, child := range wrapper.Children {
				if text := strings.TrimSpace(child.Text); text != "" {
					lines = append(lines, text)
				}
			}
		}
		return strings.Join(lines, "\n")
	default:
		return ""
	}
}

func docxHeadingPrefix(element DocxElement) string {
	if element.Style == nil {
		return ""
	}
	if element.Style.OutlineLvl != nil {
		level := *element.Style.OutlineLvl
		if level >= 0 && math.Trunc(level) == level {
			return strings.Repeat("#", minInt(int(level)+1, 6)) + " "
		}
	}
	if element.Style.StyleName == "title" {
		return "# "
	}
	return ""
}

func docxTableToMarkdown(rows []DocxElement) string {
	var table [][]string
	width := 0
	hasText := false
	for _, row := range rows {
		cells := make([]string, 0, len(row.Children))
		for _, cell := range row.Children {
			value := docxCellText(cell.Children)
			if value != "" {
				hasText = true
			}
			cells = append(cells, value)
		}
		if len(cells) > 0 {
			if len(cells) > width {
				width = len(cells)
			}
			table = append(table, cells)
		}
	}
	if len(table) == 0 || width == 0 || !hasText {
		return ""
	}
	for index := range table {
		for len(table[index]) < width {
			table[index] = append(table[index], "")
		}
	}

	lines := []string{markdownTableRow(table[0])}
	lines = append(lines, markdownTableRow(repeatedString("---", width)))
	for _, row := range table[1:] {
		lines = append(lines, markdownTableRow(row))
	}
	return strings.Join(lines, "\n")
}

var docxNewlinePattern = regexp.MustCompile(`\s*\n\s*`)

func docxCellText(children []DocxElement) string {
	var values []string
	for _, child := range children {
		if value := strings.TrimSpace(child.Text); value != "" {
			values = append(values, value)
		}
	}
	value := strings.ReplaceAll(strings.Join(values, " "), "|", `\|`)
	return strings.TrimSpace(docxNewlinePattern.ReplaceAllString(value, " "))
}

func docxGroupLines(element DocxElement) []string {
	var lines []string
	for _, child := range element.Children {
		switch child.Type {
		case "group", "wsp":
			lines = append(lines, docxGroupLines(child)...)
		default:
			if text := strings.TrimSpace(child.Text); text != "" {
				lines = append(lines, text)
			}
		}
	}
	return lines
}

func markdownTableRow(cells []string) string {
	return "| " + strings.Join(cells, " | ") + " |"
}

func repeatedString(value string, count int) []string {
	result := make([]string, count)
	for index := range result {
		result[index] = value
	}
	return result
}

func filepathExtension(name string) string {
	index := strings.LastIndex(name, ".")
	if index <= 0 {
		return ""
	}
	return name[index:]
}

func minInt(first, second int) int {
	if first < second {
		return first
	}
	return second
}

func firstMarkdownOptions(options []MarkdownConvertOptions) MarkdownConvertOptions {
	if len(options) > 0 {
		return options[0]
	}
	return MarkdownConvertOptions{}
}
