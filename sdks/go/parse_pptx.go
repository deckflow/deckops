package deckops

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

const (
	pptxDefaultMinImageBytes             = int64(5120)
	pptxDefaultAbsoluteVerticalTolerance = 9000.0
	pptxBackgroundMinWidth               = 8_000_000.0
	pptxBackgroundMinHeight              = 5_000_000.0
)

type normalizedPptxOptions struct {
	minImageBytes             int64
	verticalToleranceFactor   float64
	absoluteVerticalTolerance float64
	inlineSeparator           string
	blockSeparator            string
	rowSeparator              string
	dropEmptyText             bool
	toImageURL                func(string) string
}

type pptxBox struct {
	left   float64
	top    float64
	right  float64
	bottom float64
	width  float64
	height float64
}

type pptxAtom struct {
	box           pptxBox
	kind          string
	order         int
	ooxmlOrder    int
	output        string
	isEntityGroup bool
	hasChildren   bool
}

type pptxChainItem struct {
	virtual  bool
	element  *pptxAtom
	mother   *pptxAtom
	children []*pptxChainItem
}

// PptxResultToMarkdown converts pptx.parse output using the same geometry-based
// row absorption, nearest-neighbor chain, virtual-group, and entity-group rules
// as the TypeScript SDK.
func PptxResultToMarkdown(result PptxParseResult, options ...PptxConvertOptions) string {
	slides := anySlice(result["slides"])
	if len(slides) == 0 {
		return ""
	}
	normalized := normalizePptxOptions(options)
	files := anyMap(result["files"])
	var pages []string
	for _, rawSlide := range slides {
		slide := anyMap(rawSlide)
		if slide == nil {
			continue
		}
		atoms := pptxShapesToAtoms(result, slide, anySlice(slide["spTree"]), files, normalized)
		if markdown := strings.TrimSpace(pptxParseGroup(atoms, normalized)); markdown != "" {
			pages = append(pages, markdown)
		}
	}
	return strings.Join(pages, PageSeparator)
}

func normalizePptxOptions(values []PptxConvertOptions) normalizedPptxOptions {
	result := normalizedPptxOptions{
		minImageBytes:             pptxDefaultMinImageBytes,
		absoluteVerticalTolerance: pptxDefaultAbsoluteVerticalTolerance,
		inlineSeparator:           " ",
		blockSeparator:            "\n---\n",
		rowSeparator:              "\n",
		dropEmptyText:             true,
		toImageURL:                IdentityImageURL,
	}
	if len(values) == 0 {
		return result
	}
	options := values[0]
	if options.MinImageBytes != nil {
		result.minImageBytes = *options.MinImageBytes
	}
	result.verticalToleranceFactor = options.VerticalToleranceFactor
	if options.AbsoluteVerticalTolerance != nil {
		result.absoluteVerticalTolerance = *options.AbsoluteVerticalTolerance
	}
	if options.InlineSeparator != "" {
		result.inlineSeparator = options.InlineSeparator
	}
	if options.BlockSeparator != "" {
		result.blockSeparator = options.BlockSeparator
	}
	if options.RowSeparator != "" {
		result.rowSeparator = options.RowSeparator
	}
	if options.DropEmptyText != nil {
		result.dropEmptyText = *options.DropEmptyText
	}
	if options.ToImageURL != nil {
		result.toImageURL = options.ToImageURL
	}
	return result
}

func pptxShapesToAtoms(
	presentation PptxParseResult,
	slide map[string]any,
	shapes []any,
	files map[string]any,
	options normalizedPptxOptions,
) []*pptxAtom {
	atoms := make([]*pptxAtom, 0, len(shapes))
	for order, rawShape := range shapes {
		shape := anyMap(rawShape)
		if shape == nil || boolValue(shape["hidden"]) {
			continue
		}
		atoms = append(atoms, pptxShapeToAtom(presentation, slide, shape, files, options, order))
	}
	return atoms
}

func pptxShapeToAtom(
	presentation PptxParseResult,
	slide map[string]any,
	shape map[string]any,
	files map[string]any,
	options normalizedPptxOptions,
	order int,
) *pptxAtom {
	shapeType := stringValue(shape["type"])
	kind := "object"
	switch {
	case shapeType == "Group":
		kind = "group"
	case shapeType == "Table" || anyMap(shape["table"]) != nil:
		kind = "table"
	case shapeType == "Picture" || anyMap(shape["picture"]) != nil:
		kind = "image"
	}
	children := anySlice(shape["children"])
	isEntityGroup := shapeType == "Group"
	output := pptxShapeOutput(shape, kind, files, options)
	if isEntityGroup && len(children) > 0 {
		output = pptxParseGroup(
			pptxShapesToAtoms(presentation, slide, children, files, options),
			options,
		)
	}

	return &pptxAtom{
		box:           pptxBoundingBox(pptxShapeTransform(presentation, slide, shape)),
		kind:          kind,
		order:         order,
		ooxmlOrder:    order,
		output:        output,
		isEntityGroup: isEntityGroup,
		hasChildren:   len(children) > 0,
	}
}

func pptxShapeOutput(
	shape map[string]any,
	kind string,
	files map[string]any,
	options normalizedPptxOptions,
) string {
	if rows := pptxTableRows(shape["table"]); len(rows) > 0 {
		return pptxTableToMarkdown(rows)
	}
	if kind == "image" {
		picture := anyMap(shape["picture"])
		if picture != nil {
			entry := files[stringValue(picture["blip"])]
			path, size, hasSize := pptxFilePathAndSize(entry)
			if path != "" && (options.minImageBytes == 0 || !hasSize || size >= options.minImageBytes) {
				alt := firstNonEmptyString(shape["alt"], shape["descr"], shape["title"])
				return fmt.Sprintf(
					"![%s](%s)",
					pptxEscapeImageAlt(alt),
					pptxMarkdownLinkTarget(options.toImageURL(path)),
				)
			}
		}
	}
	return pptxTextFromBody(shape["txBody"])
}

func pptxTextFromBody(value any) string {
	body := anyMap(value)
	if body == nil {
		return ""
	}
	var paragraphs []string
	for _, rawParagraph := range anySlice(body["children"]) {
		paragraph := anyMap(rawParagraph)
		if paragraph == nil {
			continue
		}
		var builder strings.Builder
		for _, rawRun := range anySlice(paragraph["children"]) {
			run := anyMap(rawRun)
			if run != nil {
				builder.WriteString(stringValue(run["t"]))
			}
		}
		paragraphs = append(paragraphs, builder.String())
	}
	return strings.Join(paragraphs, "\n")
}

func pptxTableRows(value any) [][]string {
	table := anyMap(value)
	if table == nil {
		return nil
	}
	var rows [][]string
	for _, rawRow := range anySlice(table["trs"]) {
		row := anyMap(rawRow)
		if row == nil {
			continue
		}
		var cells []string
		for _, rawCell := range anySlice(row["cells"]) {
			cell := anyMap(rawCell)
			if cell != nil {
				cells = append(cells, pptxTextFromBody(cell["txBody"]))
			}
		}
		rows = append(rows, cells)
	}
	return rows
}

func pptxTableToMarkdown(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	width := 0
	normalized := make([][]string, 0, len(rows))
	for _, row := range rows {
		cells := make([]string, len(row))
		for index, cell := range row {
			cells[index] = strings.TrimSpace(
				strings.ReplaceAll(strings.ReplaceAll(cell, "|", `\|`), "\n", "<br>"),
			)
		}
		if len(cells) > width {
			width = len(cells)
		}
		normalized = append(normalized, cells)
	}
	if width == 0 {
		return ""
	}
	for index := range normalized {
		for len(normalized[index]) < width {
			normalized[index] = append(normalized[index], "")
		}
	}
	lines := []string{markdownTableRow(normalized[0]), markdownTableRow(repeatedString("---", width))}
	for _, row := range normalized[1:] {
		lines = append(lines, markdownTableRow(row))
	}
	return strings.Join(lines, "\n")
}

func pptxFilePathAndSize(value any) (string, int64, bool) {
	if items := anySlice(value); len(items) > 0 {
		path := stringValue(items[0])
		if len(items) > 1 {
			if number, ok := finiteNumber(items[1]); ok {
				return path, int64(number), true
			}
		}
		return path, 0, false
	}
	if entry := anyMap(value); entry != nil {
		path := firstNonEmptyString(entry["path"], entry["key"], entry["url"])
		if number, ok := finiteNumber(firstNonNil(entry["bytes"], entry["size"])); ok {
			return path, int64(number), true
		}
		return path, 0, false
	}
	return "", 0, false
}

func pptxShapeTransform(
	presentation PptxParseResult,
	slide map[string]any,
	shape map[string]any,
) map[string]any {
	if transform := anyMap(shape["xfrm"]); transform != nil {
		return transform
	}
	placeholder := anyMap(shape["ph"])
	if placeholder == nil {
		return nil
	}

	var master map[string]any
	for _, candidate := range anySlice(presentation["slideMasters"]) {
		item := anyMap(candidate)
		if item != nil && valuesEqual(item["_ref"], slide["_masterRef"]) {
			master = item
			break
		}
	}
	if master == nil {
		return nil
	}

	var layout map[string]any
	for _, candidate := range anySlice(master["slideLayouts"]) {
		item := anyMap(candidate)
		if item != nil && valuesEqual(item["_ref"], slide["_layoutRef"]) {
			layout = item
			break
		}
	}
	if layout == nil {
		return nil
	}

	layoutShape := pptxPlaceholderShape(layout["spTree"], placeholder)
	if layoutShape == nil {
		return nil
	}
	if transform := anyMap(layoutShape["xfrm"]); transform != nil {
		return transform
	}
	layoutPlaceholder := anyMap(layoutShape["ph"])
	if layoutPlaceholder == nil {
		return nil
	}
	masterShape := pptxPlaceholderShape(master["spTree"], layoutPlaceholder)
	if masterShape == nil {
		return nil
	}
	return anyMap(masterShape["xfrm"])
}

func pptxPlaceholderShape(value any, placeholder map[string]any) map[string]any {
	var candidates []map[string]any
	for _, rawShape := range anySlice(value) {
		shape := anyMap(rawShape)
		if shape != nil && anyMap(shape["ph"]) != nil {
			candidates = append(candidates, shape)
		}
	}
	if index, ok := placeholder["idx"]; ok {
		for _, shape := range candidates {
			if valuesEqual(anyMap(shape["ph"])["idx"], index) {
				return shape
			}
		}
	}
	if placeholderType, ok := placeholder["type"]; ok {
		for _, shape := range candidates {
			if valuesEqual(anyMap(shape["ph"])["type"], placeholderType) {
				return shape
			}
		}
	}
	return nil
}

func pptxBoundingBox(transform map[string]any) pptxBox {
	left := numberOrZero(transform["x"])
	top := numberOrZero(transform["y"])
	width := numberOrZero(transform["cx"])
	height := numberOrZero(transform["cy"])
	return pptxBox{
		left:   left,
		top:    top,
		right:  left + width,
		bottom: top + height,
		width:  width,
		height: height,
	}
}

func pptxParseGroup(atoms []*pptxAtom, options normalizedPptxOptions) string {
	participants := make([]*pptxAtom, 0, len(atoms))
	for _, atom := range atoms {
		if pptxParticipatesInRowGrouping(atom) {
			participants = append(participants, atom)
		}
	}
	rows := pptxGroupIntoRows(participants, options)
	sort.SliceStable(rows, func(i, j int) bool { return pptxRowTop(rows[i]) < pptxRowTop(rows[j]) })
	for _, row := range rows {
		pptxSortRowByChainedDistance(row)
	}

	var output []string
	for _, row := range rows {
		text := pptxFormatRow(row, options)
		if text != "" || !options.dropEmptyText {
			output = append(output, text)
		}
	}
	return strings.Join(output, options.rowSeparator)
}

func pptxParticipatesInRowGrouping(atom *pptxAtom) bool {
	if atom.box.width <= 0 && atom.box.height <= 0 {
		return false
	}
	return strings.TrimSpace(atom.output) != "" || !pptxIsBackgroundLike(atom)
}

func pptxIsBackgroundLike(atom *pptxAtom) bool {
	return strings.TrimSpace(atom.output) == "" &&
		atom.box.left <= 0 &&
		atom.box.top <= 0 &&
		atom.box.width >= pptxBackgroundMinWidth &&
		atom.box.height >= pptxBackgroundMinHeight
}

func pptxGroupingBox(atom *pptxAtom, options normalizedPptxOptions) pptxBox {
	if strings.TrimSpace(atom.output) != "" {
		return atom.box
	}
	padding := options.absoluteVerticalTolerance * 2
	box := atom.box
	box.top -= padding
	box.height += padding * 2
	box.bottom = box.top + box.height
	return box
}

func pptxGroupIntoRows(atoms []*pptxAtom, options normalizedPptxOptions) [][]*pptxAtom {
	sorted := append([]*pptxAtom(nil), atoms...)
	sort.SliceStable(sorted, func(i, j int) bool { return pptxCompareAtomsByPosition(sorted[i], sorted[j]) < 0 })
	var rows [][]*pptxAtom
	var current []*pptxAtom
	for _, atom := range sorted {
		if len(current) == 0 || pptxIsVerticallyAssociated(atom, current, options) {
			current = append(current, atom)
		} else {
			rows = append(rows, current)
			current = []*pptxAtom{atom}
		}
	}
	if len(current) > 0 {
		rows = append(rows, current)
	}
	return rows
}

func pptxIsVerticallyAssociated(
	atom *pptxAtom,
	row []*pptxAtom,
	options normalizedPptxOptions,
) bool {
	rowTop := math.Inf(1)
	rowBottom := math.Inf(-1)
	for _, item := range row {
		box := pptxGroupingBox(item, options)
		rowTop = math.Min(rowTop, box.top)
		rowBottom = math.Max(rowBottom, box.bottom)
	}
	elementBox := pptxGroupingBox(atom, options)
	if elementBox.top < rowBottom && elementBox.bottom > rowTop {
		return true
	}
	verticalGap := elementBox.top - rowBottom
	if verticalGap <= 0 {
		return false
	}
	relativeTolerance := (rowBottom - rowTop) * options.verticalToleranceFactor
	return verticalGap <= math.Max(options.absoluteVerticalTolerance, relativeTolerance)
}

func pptxRowTop(row []*pptxAtom) float64 {
	top := math.Inf(1)
	for _, atom := range row {
		if strings.TrimSpace(atom.output) != "" {
			top = math.Min(top, atom.box.top)
		}
	}
	if !math.IsInf(top, 1) {
		return top
	}
	for _, atom := range row {
		top = math.Min(top, atom.box.top)
	}
	return top
}

func pptxFormatRow(row []*pptxAtom, options normalizedPptxOptions) string {
	var outputs []string
	blockLike := false
	for _, atom := range row {
		output := strings.TrimSpace(atom.output)
		if output == "" {
			continue
		}
		outputs = append(outputs, output)
		if atom.kind == "group" || atom.kind == "table" || strings.Contains(output, "\n") {
			blockLike = true
		}
	}
	separator := options.inlineSeparator
	if blockLike {
		separator = options.blockSeparator
	}
	return strings.Join(outputs, separator)
}

func pptxSortRowByChainedDistance(row []*pptxAtom) {
	if len(row) == 0 {
		return
	}
	anchorLeft := math.Inf(1)
	anchorTop := math.Inf(1)
	for _, atom := range row {
		anchorLeft = math.Min(anchorLeft, atom.box.left)
		anchorTop = math.Min(anchorTop, atom.box.top)
	}
	ordered, _ := pptxChainOrderElements(row, anchorLeft, anchorTop)
	copy(row, ordered)
}

func pptxChainOrderElements(
	atoms []*pptxAtom,
	anchorLeft float64,
	anchorTop float64,
) ([]*pptxAtom, *pptxAtom) {
	items := pptxVirtualChainItems(atoms)
	first := pptxFirstMeaningfulChainItem(items)
	if first == nil {
		return pptxChainOrderItems(items, anchorLeft, anchorTop)
	}
	remaining := make([]*pptxChainItem, 0, len(items)-1)
	for _, item := range items {
		if item != first {
			remaining = append(remaining, item)
		}
	}
	ordered := pptxExpandChainItem(first)
	anchor := pptxChainItemAnchor(first)
	rest, lastAnchor := pptxChainOrderItems(remaining, anchor.box.left, anchor.box.top)
	ordered = append(ordered, rest...)
	if lastAnchor == nil {
		lastAnchor = anchor
	}
	return ordered, lastAnchor
}

func pptxFirstMeaningfulChainItem(items []*pptxChainItem) *pptxChainItem {
	var meaningful []*pptxChainItem
	for _, item := range items {
		if pptxChainItemHasMeaning(item) {
			meaningful = append(meaningful, item)
		}
	}
	if len(meaningful) == 0 {
		return nil
	}
	sort.SliceStable(meaningful, func(i, j int) bool {
		return pptxCompareAtomsByPosition(
			pptxChainItemAnchor(meaningful[i]),
			pptxChainItemAnchor(meaningful[j]),
		) < 0
	})
	topmost := meaningful[0]
	topmostBox := pptxChainItemAnchor(topmost).box
	var candidates []*pptxChainItem
	for _, item := range meaningful {
		if pptxBoxesVerticallyOverlap(pptxChainItemAnchor(item).box, topmostBox) {
			candidates = append(candidates, item)
		}
	}
	if len(candidates) == 0 {
		candidates = []*pptxChainItem{topmost}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		first := pptxChainItemAnchor(candidates[i])
		second := pptxChainItemAnchor(candidates[j])
		return pptxCompareLeftFirst(first, second) < 0
	})
	return candidates[0]
}

func pptxChainItemHasMeaning(item *pptxChainItem) bool {
	if !item.virtual {
		return item.element.isEntityGroup || strings.TrimSpace(item.element.output) != ""
	}
	if strings.TrimSpace(item.mother.output) != "" {
		return true
	}
	for _, child := range item.children {
		if pptxChainItemHasMeaning(child) {
			return true
		}
	}
	return false
}

func pptxChainOrderItems(
	items []*pptxChainItem,
	anchorLeft float64,
	anchorTop float64,
) ([]*pptxAtom, *pptxAtom) {
	remaining := append([]*pptxChainItem(nil), items...)
	var ordered []*pptxAtom
	var lastAnchor *pptxAtom
	for len(remaining) > 0 {
		sort.SliceStable(remaining, func(i, j int) bool {
			return pptxCompareChainItems(remaining[i], remaining[j], anchorLeft, anchorTop) < 0
		})
		next := remaining[0]
		remaining = remaining[1:]
		ordered = append(ordered, pptxExpandChainItem(next)...)
		anchor := pptxChainItemAnchor(next)
		anchorLeft = anchor.box.left
		anchorTop = anchor.box.top
		lastAnchor = anchor
	}
	return ordered, lastAnchor
}

func pptxCompareChainItems(
	first *pptxChainItem,
	second *pptxChainItem,
	anchorLeft float64,
	anchorTop float64,
) int {
	firstAtom := pptxChainItemAnchor(first)
	secondAtom := pptxChainItemAnchor(second)
	if comparison := compareFloat(
		pptxPlaneDistanceSq(firstAtom.box, anchorLeft, anchorTop),
		pptxPlaneDistanceSq(secondAtom.box, anchorLeft, anchorTop),
	); comparison != 0 {
		return comparison
	}
	return pptxCompareAtomsByPosition(firstAtom, secondAtom)
}

func pptxVirtualChainItems(atoms []*pptxAtom) []*pptxChainItem {
	var mothers []*pptxAtom
	for _, atom := range atoms {
		if pptxIsVirtualGroupMother(atom) {
			mothers = append(mothers, atom)
		}
	}
	childrenByMother := make(map[*pptxAtom][]*pptxAtom)
	parentByChild := make(map[*pptxAtom]*pptxAtom)
	for _, atom := range atoms {
		if !pptxIsVirtualGroupChild(atom) {
			continue
		}
		mother := pptxOverlappingVirtualMother(atom, mothers)
		if mother != nil {
			parentByChild[atom] = mother
			childrenByMother[mother] = append(childrenByMother[mother], atom)
		}
	}

	var items []*pptxChainItem
	for _, atom := range atoms {
		if parentByChild[atom] == nil {
			items = append(items, pptxVirtualChainItemFor(atom, childrenByMother))
		}
	}
	return items
}

func pptxVirtualChainItemFor(
	atom *pptxAtom,
	childrenByMother map[*pptxAtom][]*pptxAtom,
) *pptxChainItem {
	children := childrenByMother[atom]
	if len(children) == 0 {
		return &pptxChainItem{element: atom}
	}
	item := &pptxChainItem{virtual: true, mother: atom}
	for _, child := range children {
		item.children = append(item.children, pptxVirtualChainItemFor(child, childrenByMother))
	}
	return item
}

func pptxIsVirtualGroupMother(atom *pptxAtom) bool {
	return !atom.isEntityGroup &&
		!pptxIsBackgroundLike(atom) &&
		atom.box.width > 0 &&
		atom.box.height > 0
}

func pptxIsVirtualGroupChild(atom *pptxAtom) bool {
	return !atom.isEntityGroup && !atom.hasChildren
}

func pptxOverlappingVirtualMother(atom *pptxAtom, mothers []*pptxAtom) *pptxAtom {
	atomArea := pptxBoxArea(atom.box)
	var candidates []*pptxAtom
	for _, mother := range mothers {
		if mother != atom &&
			pptxBoxArea(mother.box) > atomArea &&
			pptxBoxesOverlapWithArea(atom.box, mother.box) {
			candidates = append(candidates, mother)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		first := candidates[i]
		second := candidates[j]
		if comparison := compareFloat(pptxBoxArea(first.box), pptxBoxArea(second.box)); comparison != 0 {
			return comparison < 0
		}
		if comparison := compareFloat(
			pptxPlaneDistanceSq(atom.box, first.box.left, first.box.top),
			pptxPlaneDistanceSq(atom.box, second.box.left, second.box.top),
		); comparison != 0 {
			return comparison < 0
		}
		return pptxCompareOrder(first, second) < 0
	})
	if len(candidates) == 0 {
		return nil
	}
	return candidates[0]
}

func pptxChainItemAnchor(item *pptxChainItem) *pptxAtom {
	if item.virtual {
		return item.mother
	}
	return item.element
}

func pptxExpandChainItem(item *pptxChainItem) []*pptxAtom {
	if !item.virtual {
		return []*pptxAtom{item.element}
	}
	if len(item.children) == 0 {
		return []*pptxAtom{item.mother}
	}
	children, _ := pptxChainOrderItems(item.children, item.mother.box.left, item.mother.box.top)
	return append([]*pptxAtom{item.mother}, children...)
}

func pptxCompareAtomsByPosition(first, second *pptxAtom) int {
	if comparison := compareFloat(first.box.top, second.box.top); comparison != 0 {
		return comparison
	}
	if comparison := compareFloat(first.box.left, second.box.left); comparison != 0 {
		return comparison
	}
	return pptxCompareOrder(first, second)
}

func pptxCompareLeftFirst(first, second *pptxAtom) int {
	if comparison := compareFloat(first.box.left, second.box.left); comparison != 0 {
		return comparison
	}
	if comparison := compareFloat(first.box.top, second.box.top); comparison != 0 {
		return comparison
	}
	return pptxCompareOrder(first, second)
}

func pptxCompareOrder(first, second *pptxAtom) int {
	if first.ooxmlOrder < second.ooxmlOrder {
		return -1
	}
	if first.ooxmlOrder > second.ooxmlOrder {
		return 1
	}
	if first.order < second.order {
		return -1
	}
	if first.order > second.order {
		return 1
	}
	return 0
}

func pptxBoxesVerticallyOverlap(first, second pptxBox) bool {
	return first.top < second.bottom && first.bottom > second.top
}

func pptxBoxesOverlapWithArea(first, second pptxBox) bool {
	return first.left < second.right &&
		first.right > second.left &&
		first.top < second.bottom &&
		first.bottom > second.top
}

func pptxBoxArea(box pptxBox) float64 {
	return box.width * box.height
}

func pptxPlaneDistanceSq(box pptxBox, anchorLeft, anchorTop float64) float64 {
	dx := box.left - anchorLeft
	dy := box.top - anchorTop
	return dx*dx + dy*dy
}

func pptxEscapeImageAlt(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\n", " "), "]", `\]`)
}

func pptxMarkdownLinkTarget(value string) string {
	needsAngleBrackets := strings.ContainsAny(value, "()#<>")
	if !needsAngleBrackets {
		for _, character := range value {
			if unicode.IsSpace(character) {
				needsAngleBrackets = true
				break
			}
		}
	}
	if needsAngleBrackets {
		return "<" + strings.ReplaceAll(value, ">", "%3E") + ">"
	}
	return value
}

func anyMap(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case PptxParseResult:
		return map[string]any(typed)
	default:
		return nil
	}
}

func anySlice(value any) []any {
	if value == nil {
		return nil
	}
	if values, ok := value.([]any); ok {
		return values
	}
	return nil
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(typed)
	}
}

func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func firstNonEmptyString(values ...any) string {
	for _, value := range values {
		if text := stringValue(value); text != "" {
			return text
		}
	}
	return ""
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func finiteNumber(value any) (float64, bool) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		number = float64(typed)
	case int8:
		number = float64(typed)
	case int16:
		number = float64(typed)
	case int32:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case uint:
		number = float64(typed)
	case uint8:
		number = float64(typed)
	case uint16:
		number = float64(typed)
	case uint32:
		number = float64(typed)
	case uint64:
		number = float64(typed)
	case json.Number:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	default:
		return 0, false
	}
	return number, !math.IsNaN(number) && !math.IsInf(number, 0)
}

func numberOrZero(value any) float64 {
	number, _ := finiteNumber(value)
	return number
}

func valuesEqual(first, second any) bool {
	if firstNumber, ok := finiteNumber(first); ok {
		if secondNumber, ok := finiteNumber(second); ok {
			return firstNumber == secondNumber
		}
	}
	return stringValue(first) == stringValue(second)
}

func compareFloat(first, second float64) int {
	switch {
	case first < second:
		return -1
	case first > second:
		return 1
	default:
		return 0
	}
}
