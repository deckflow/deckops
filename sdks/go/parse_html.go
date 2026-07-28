package deckops

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	readability "github.com/go-shiori/go-readability"
	xhtml "golang.org/x/net/html"
)

// HTMLToMarkdown extracts the article/main/body content and converts it to
// GitHub-flavored Markdown. Relative media URLs are resolved against baseURL.
func HTMLToMarkdown(source string, baseURL ...string) (string, error) {
	document, err := xhtml.Parse(strings.NewReader(source))
	if err != nil {
		return "", fmt.Errorf("html2markdown: parse html: %w", err)
	}
	preprocessHTML(document)

	documentTitle := strings.TrimSpace(collapseInlineText(nodeText(findFirstElement(document, "title"))))
	var pageURL *url.URL
	if len(baseURL) > 0 && baseURL[0] != "" {
		pageURL, _ = url.Parse(baseURL[0])
	}
	if pageURL == nil {
		pageURL = &url.URL{}
	}
	article, readabilityErr := readability.FromDocument(document, pageURL)

	base := ""
	if len(baseURL) > 0 {
		base = baseURL[0]
	}
	title := documentTitle
	var content *xhtml.Node
	if readabilityErr == nil && article.Node != nil {
		content = article.Node
		if strings.TrimSpace(article.Title) != "" {
			title = strings.TrimSpace(collapseInlineText(article.Title))
		}
	} else {
		content = findFirstElement(document, "body")
	}
	body := ""
	if content != nil {
		body = normalizeMarkdown(htmlChildrenToMarkdown(content, base))
	}
	if body == "" && readabilityErr == nil {
		if fallback := findFirstElement(document, "body"); fallback != nil && fallback != content {
			body = normalizeMarkdown(htmlChildrenToMarkdown(fallback, base))
		}
	}
	if body == "" {
		suffix := ""
		if base != "" {
			suffix = " from " + base
		}
		return "", fmt.Errorf("html2markdown: empty content extracted%s", suffix)
	}
	if title != "" {
		return "# " + title + "\n\n" + body, nil
	}
	return body, nil
}

func preprocessHTML(node *xhtml.Node) {
	if node == nil {
		return
	}
	if node.Type == xhtml.ElementNode && node.Data == "img" {
		dataSrc := htmlAttribute(node, "data-src")
		src := htmlAttribute(node, "src")
		if dataSrc != "" && !strings.HasPrefix(src, "http") {
			setHTMLAttribute(node, "src", dataSrc)
		}
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		preprocessHTML(child)
	}
}

func htmlChildrenToMarkdown(node *xhtml.Node, baseURL string) string {
	if node == nil {
		return ""
	}
	var builder strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		builder.WriteString(htmlNodeToMarkdown(child, baseURL))
	}
	return builder.String()
}

func htmlNodeToMarkdown(node *xhtml.Node, baseURL string) string {
	if node == nil {
		return ""
	}
	if node.Type == xhtml.TextNode {
		return node.Data
	}
	if node.Type != xhtml.ElementNode {
		return ""
	}

	switch strings.ToLower(node.Data) {
	case "script", "style", "noscript", "iframe", "nav", "footer", "aside":
		return ""
	case "img":
		src := htmlAttribute(node, "src")
		if src == "" {
			return ""
		}
		return "![img](" + resolveHTMLURL(src, baseURL) + ")"
	case "br":
		return "\n"
	case "hr":
		return "\n\n---\n\n"
	case "strong", "b":
		text := collapseInlineText(htmlChildrenToMarkdown(node, baseURL))
		if text != "" {
			return "**" + text + "**"
		}
		return ""
	case "em", "i":
		text := collapseInlineText(htmlChildrenToMarkdown(node, baseURL))
		if text != "" {
			return "*" + text + "*"
		}
		return ""
	case "code":
		if node.Parent != nil && node.Parent.Data == "pre" {
			return nodeText(node)
		}
		return "`" + nodeText(node) + "`"
	case "pre":
		return "\n\n```\n" + strings.TrimSpace(nodeText(node)) + "\n```\n\n"
	case "a":
		text := collapseInlineText(htmlChildrenToMarkdown(node, baseURL))
		href := htmlAttribute(node, "href")
		if text != "" && href != "" {
			return "[" + text + "](" + resolveHTMLURL(href, baseURL) + ")"
		}
		return text
	case "table":
		if table := htmlTableToMarkdown(node); table != "" {
			return "\n\n" + table + "\n\n"
		}
		return ""
	case "ul", "ol":
		var lines []string
		index := 0
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if child.Type != xhtml.ElementNode || child.Data != "li" {
				continue
			}
			index++
			text := collapseInlineText(htmlChildrenToMarkdown(child, baseURL))
			if text == "" {
				continue
			}
			marker := "-"
			if node.Data == "ol" {
				marker = fmt.Sprintf("%d.", index)
			}
			lines = append(lines, marker+" "+text)
		}
		if len(lines) > 0 {
			return "\n\n" + strings.Join(lines, "\n") + "\n\n"
		}
		return ""
	case "li":
		return htmlChildrenToMarkdown(node, baseURL)
	case "h1", "h2", "h3", "h4", "h5", "h6":
		text := collapseInlineText(htmlChildrenToMarkdown(node, baseURL))
		if text == "" {
			return ""
		}
		level := int(node.Data[1] - '0')
		return "\n\n" + strings.Repeat("#", level) + " " + text + "\n\n"
	case "blockquote":
		text := strings.TrimSpace(htmlChildrenToMarkdown(node, baseURL))
		if text == "" {
			return ""
		}
		lines := strings.Split(text, "\n")
		for index := range lines {
			lines[index] = "> " + lines[index]
		}
		return "\n\n" + strings.Join(lines, "\n") + "\n\n"
	case "p", "div", "section", "article", "main", "header":
		text := strings.TrimSpace(htmlChildrenToMarkdown(node, baseURL))
		if text != "" {
			return "\n\n" + text + "\n\n"
		}
		return ""
	default:
		return htmlChildrenToMarkdown(node, baseURL)
	}
}

func htmlTableToMarkdown(table *xhtml.Node) string {
	var rows [][]string
	var visit func(*xhtml.Node)
	visit = func(node *xhtml.Node) {
		if node.Type == xhtml.ElementNode && node.Data == "tr" {
			var cells []string
			for child := node.FirstChild; child != nil; child = child.NextSibling {
				if child.Type == xhtml.ElementNode && (child.Data == "th" || child.Data == "td") {
					value := strings.ReplaceAll(collapseInlineText(nodeText(child)), "|", `\|`)
					cells = append(cells, value)
				}
			}
			if len(cells) > 0 {
				rows = append(rows, cells)
			}
			return
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(table)
	if len(rows) == 0 {
		return ""
	}
	width := 0
	for _, row := range rows {
		if len(row) > width {
			width = len(row)
		}
	}
	for index := range rows {
		for len(rows[index]) < width {
			rows[index] = append(rows[index], "")
		}
	}
	lines := []string{markdownTableRow(rows[0]), markdownTableRow(repeatedString("---", width))}
	for _, row := range rows[1:] {
		lines = append(lines, markdownTableRow(row))
	}
	return strings.Join(lines, "\n")
}

func findFirstElement(node *xhtml.Node, name string) *xhtml.Node {
	if node == nil {
		return nil
	}
	if node.Type == xhtml.ElementNode && node.Data == name {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findFirstElement(child, name); found != nil {
			return found
		}
	}
	return nil
}

func findElementByAttribute(node *xhtml.Node, name, value string) *xhtml.Node {
	if node == nil {
		return nil
	}
	if node.Type == xhtml.ElementNode && htmlAttribute(node, name) == value {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findElementByAttribute(child, name, value); found != nil {
			return found
		}
	}
	return nil
}

func nodeText(node *xhtml.Node) string {
	if node == nil {
		return ""
	}
	if node.Type == xhtml.TextNode {
		return node.Data
	}
	var builder strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		builder.WriteString(nodeText(child))
	}
	return builder.String()
}

func htmlAttribute(node *xhtml.Node, name string) string {
	for _, attribute := range node.Attr {
		if attribute.Key == name {
			return attribute.Val
		}
	}
	return ""
}

func setHTMLAttribute(node *xhtml.Node, name, value string) {
	for index := range node.Attr {
		if node.Attr[index].Key == name {
			node.Attr[index].Val = value
			return
		}
	}
	node.Attr = append(node.Attr, xhtml.Attribute{Key: name, Val: value})
}

func resolveHTMLURL(value, base string) string {
	if base == "" {
		return value
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return value
	}
	reference, err := url.Parse(value)
	if err != nil {
		return value
	}
	return baseURL.ResolveReference(reference).String()
}

var (
	inlineWhitespacePattern = regexp.MustCompile(`[ \t\r\f\v]+`)
	trailingSpacePattern    = regexp.MustCompile(`[ \t]+\n`)
	leadingSpacePattern     = regexp.MustCompile(`\n[ \t]+`)
	excessNewlinePattern    = regexp.MustCompile(`\n{3,}`)
)

func collapseInlineText(value string) string {
	return strings.TrimSpace(inlineWhitespacePattern.ReplaceAllString(value, " "))
}

func normalizeMarkdown(value string) string {
	value = inlineWhitespacePattern.ReplaceAllString(value, " ")
	value = trailingSpacePattern.ReplaceAllString(value, "\n")
	value = leadingSpacePattern.ReplaceAllString(value, "\n")
	value = excessNewlinePattern.ReplaceAllString(value, "\n\n")
	return strings.TrimSpace(value)
}
