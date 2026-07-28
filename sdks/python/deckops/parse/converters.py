from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from .html import html_to_markdown

PAGE_SEPARATOR = "\n\n---\n\n"
ImageResolver = Callable[[str], str]


def _identity(value: str) -> str:
    return value


def pdf_result_to_markdown(
    result: Mapping[str, Any],
    *,
    to_image_url: ImageResolver = _identity,
) -> str:
    text_blocks = result.get("textBlocks") or []
    images = result.get("images") or []
    page_indices: set[int] = set()
    for block in text_blocks:
        if isinstance(block, Mapping):
            locator = block.get("locator")
            page_indices.add(
                int(locator.get("pageIndex", 0)) if isinstance(locator, Mapping) else 0
            )
    for image in images:
        if isinstance(image, Mapping):
            locator = image.get("locator")
            page_indices.add(
                int(locator.get("pageIndex", 0)) if isinstance(locator, Mapping) else 0
            )

    parts: list[str] = []
    for page_index in sorted(page_indices):
        for block in text_blocks:
            if not isinstance(block, Mapping):
                continue
            locator = block.get("locator")
            current = int(locator.get("pageIndex", 0)) if isinstance(locator, Mapping) else 0
            if current != page_index:
                continue
            text = str(block.get("text") or "").strip()
            if not text:
                continue
            role = block.get("role")
            style = block.get("style")
            if role == "heading":
                parts.append(f"## {text}")
            elif role == "list-item":
                parts.append(f"- {text}")
            elif role == "caption":
                parts.append(f"*{text}*")
            elif isinstance(style, Mapping) and style.get("bold"):
                parts.append(f"**{text}**")
            elif isinstance(style, Mapping) and style.get("italic"):
                parts.append(f"*{text}*")
            else:
                parts.append(text)

        for image in images:
            if not isinstance(image, Mapping):
                continue
            locator = image.get("locator")
            current = int(locator.get("pageIndex", 0)) if isinstance(locator, Mapping) else 0
            key = image.get("key")
            if current == page_index and isinstance(key, str) and key:
                parts.append(f"![{image.get('fileName') or 'img'}]({to_image_url(key)})")
    return "\n\n".join(parts)


def keynote_result_to_markdown(
    result: Mapping[str, Any],
    *,
    to_image_url: ImageResolver = _identity,
) -> str:
    slides = result.get("slides") or []
    images = [
        image
        for image in (result.get("images") or [])
        if isinstance(image, Mapping) and image.get("key")
    ]
    by_page: dict[int, list[Mapping[str, Any]]] = {}
    unassigned: list[Mapping[str, Any]] = []
    for image in images:
        page_index = image.get("pageIndex")
        if (
            not isinstance(page_index, int)
            or isinstance(page_index, bool)
            or page_index < 0
            or page_index >= len(slides)
        ):
            unassigned.append(image)
        else:
            by_page.setdefault(page_index, []).append(image)

    pages: list[str] = []
    for slide_index, slide in enumerate(slides):
        if not isinstance(slide, Mapping):
            continue
        lines: list[str] = []
        for text_item in slide.get("text") or []:
            if isinstance(text_item, Mapping):
                text = str(text_item.get("text") or "").strip()
                if text:
                    lines.append(text)
        for table in slide.get("table") or []:
            if not isinstance(table, Mapping):
                continue
            row = " | ".join(
                str(cell or "").strip()
                for cell in (table.get("data") or [])
                if str(cell or "").strip()
            )
            if row:
                lines.append(row)
        for chart in slide.get("chart") or []:
            if not isinstance(chart, Mapping) or not isinstance(chart.get("data"), Mapping):
                continue
            data = chart["data"]
            columns = [str(value) for value in data.get("columnName") or [] if str(value).strip()]
            rows = [str(value) for value in data.get("rowName") or [] if str(value).strip()]
            if columns:
                lines.append(" | ".join(columns))
            if rows:
                lines.append(" | ".join(rows))
        for image in by_page.get(slide_index, []):
            lines.append(f"![img]({to_image_url(str(image['key']))})")
        if lines:
            pages.append("\n".join(lines))

    if unassigned:
        pages.append(
            "\n".join(f"![img]({to_image_url(str(image['key']))})" for image in unassigned)
        )
    return PAGE_SEPARATOR.join(pages)


def _docx_heading_prefix(element: Mapping[str, Any]) -> str:
    style = element.get("style")
    if not isinstance(style, Mapping):
        return ""
    level = style.get("outlineLvl")
    if isinstance(level, int) and not isinstance(level, bool) and level >= 0:
        return f"{'#' * min(level + 1, 6)} "
    return "# " if style.get("styleName") == "title" else ""


def _docx_cell_text(children: Sequence[Any]) -> str:
    value = " ".join(
        str(child.get("text") or "").strip()
        for child in children
        if isinstance(child, Mapping) and str(child.get("text") or "").strip()
    )
    return re.sub(r"\s*\n\s*", " ", value.replace("|", r"\|")).strip()


def _docx_table(element: Mapping[str, Any]) -> str:
    rows: list[list[str]] = []
    for row in element.get("table") or []:
        if not isinstance(row, Mapping):
            continue
        cells = [
            _docx_cell_text(cell.get("children") or [])
            for cell in (row.get("children") or [])
            if isinstance(cell, Mapping)
        ]
        if cells:
            rows.append(cells)
    if not rows or not any(any(cell for cell in row) for row in rows):
        return ""
    width = max(map(len, rows))
    padded = [row + [""] * (width - len(row)) for row in rows]
    return "\n".join(
        [
            f"| {' | '.join(padded[0])} |",
            f"| {' | '.join(['---'] * width)} |",
            *(f"| {' | '.join(row)} |" for row in padded[1:]),
        ]
    )


def _docx_group_lines(element: Mapping[str, Any]) -> list[str]:
    lines: list[str] = []
    for child in element.get("children") or []:
        if not isinstance(child, Mapping):
            continue
        if child.get("type") in {"group", "wsp"}:
            lines.extend(_docx_group_lines(child))
        else:
            text = str(child.get("text") or "").strip()
            if text:
                lines.append(text)
    return lines


def _docx_block(element: Mapping[str, Any], to_image_url: ImageResolver) -> str:
    element_type = element.get("type")
    if element_type == "text":
        text = str(element.get("text") or "").strip()
        return f"{_docx_heading_prefix(element)}{text}" if text else ""
    if element_type == "image":
        image = element.get("image")
        if not image:
            return ""
        name = str(element.get("name") or "")
        alt = re.sub(r"\.[^.]+$", "", name) if name else "img"
        return f"![{alt}]({to_image_url(str(image))})"
    if element_type == "table":
        return _docx_table(element)
    if element_type == "chart":
        categories = [str(value) for value in element.get("categories") or [] if value]
        series = [str(value) for value in element.get("series") or [] if value]
        return "\n".join(part for part in (" | ".join(categories), " | ".join(series)) if part)
    if element_type == "diagram":
        lines: list[str] = []
        for text_item in element.get("texts") or []:
            if not isinstance(text_item, Mapping):
                continue
            for paragraph in text_item.get("aps") or []:
                if isinstance(paragraph, Mapping):
                    text = str(paragraph.get("text") or "").strip()
                    if text:
                        lines.append(text)
        return "\n".join(lines)
    if element_type in {"group", "wsp"}:
        return "\n".join(_docx_group_lines(element))
    if element_type == "sdt":
        lines = []
        for wrapper in element.get("children") or []:
            if not isinstance(wrapper, Mapping):
                continue
            for child in wrapper.get("children") or []:
                if isinstance(child, Mapping):
                    text = str(child.get("text") or "").strip()
                    if text:
                        lines.append(text)
        return "\n".join(lines)
    return ""


def docx_result_to_markdown(
    result: Mapping[str, Any],
    *,
    to_image_url: ImageResolver = _identity,
) -> str:
    content = sorted(
        (item for item in (result.get("content") or []) if isinstance(item, Mapping)),
        key=lambda item: int(item.get("idx") or 0),
    )
    blocks = [block.strip() for item in content if (block := _docx_block(item, to_image_url))]
    return "\n\n".join(block for block in blocks if block)


# TypeScript-compatible aliases.
pdfResult2Markdown = pdf_result_to_markdown
keynoteResult2Markdown = keynote_result_to_markdown
docxResult2Markdown = docx_result_to_markdown
html2markdown = html_to_markdown
