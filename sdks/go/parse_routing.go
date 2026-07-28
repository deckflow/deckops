package deckops

import (
	"path/filepath"
	"strings"
)

// ParseTaskTypeByExtension maps supported document extensions to task types.
var ParseTaskTypeByExtension = map[string]TaskType{
	".pdf":  TaskPDFParse,
	".pptx": TaskPptxParse,
	".docx": TaskDocxParse,
	".key":  TaskKeynoteParse,
}

// ParseSupportedExtensions lists the file extensions understood by Parse.
var ParseSupportedExtensions = []string{".pdf", ".pptx", ".docx", ".key"}

// ExtensionOf extracts a lowercase extension, including the leading dot.
func ExtensionOf(nameOrPath string) string {
	clean := nameOrPath
	if index := strings.IndexAny(clean, "?#"); index >= 0 {
		clean = clean[:index]
	}
	base := filepath.Base(strings.ReplaceAll(clean, "\\", "/"))
	extension := strings.ToLower(filepath.Ext(base))
	if extension == base {
		return ""
	}
	return extension
}

// ParseTaskTypeFor returns the parser task type selected for a file name.
func ParseTaskTypeFor(nameOrPath string) (TaskType, bool) {
	taskType, ok := ParseTaskTypeByExtension[ExtensionOf(nameOrPath)]
	return taskType, ok
}
