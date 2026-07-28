from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PptxConvertOptions:
    min_image_bytes: int = 5120
    vertical_tolerance_factor: float = 0.0
    absolute_vertical_tolerance: float = 9000.0
    inline_separator: str = " "
    block_separator: str = "\n---\n"
    row_separator: str = "\n"
    drop_empty_text: bool = True
    to_image_url: Callable[[str], str] = lambda value: value


def pptx_result_to_markdown(
    result: Mapping[str, Any],
    *,
    min_image_bytes: int = 5120,
    vertical_tolerance_factor: float = 0.0,
    absolute_vertical_tolerance: float = 9000.0,
    inline_separator: str = " ",
    block_separator: str = "\n---\n",
    row_separator: str = "\n",
    drop_empty_text: bool = True,
    to_image_url: Callable[[str], str] = lambda value: value,
) -> str:
    options = PptxConvertOptions(
        min_image_bytes=min_image_bytes,
        vertical_tolerance_factor=vertical_tolerance_factor,
        absolute_vertical_tolerance=absolute_vertical_tolerance,
        inline_separator=inline_separator,
        block_separator=block_separator,
        row_separator=row_separator,
        drop_empty_text=drop_empty_text,
        to_image_url=to_image_url,
    )
    files = result.get("files")
    file_map = files if isinstance(files, Mapping) else {}
    pages: list[str] = []
    for slide in result.get("slides") or []:
        if not isinstance(slide, Mapping):
            continue
        shapes = slide.get("spTree")
        elements = _shapes_to_elements(
            result,
            slide,
            shapes if isinstance(shapes, Sequence) else [],
            file_map,
            options,
        )
        markdown = _parse_group(elements, options).strip()
        if markdown:
            pages.append(markdown)
    return "\n\n---\n\n".join(pages)


def _shapes_to_elements(
    presentation: Mapping[str, Any],
    slide: Mapping[str, Any],
    shapes: Sequence[Any],
    files: Mapping[str, Any],
    options: PptxConvertOptions,
) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    for order, shape in enumerate(shapes):
        if not isinstance(shape, Mapping) or shape.get("hidden"):
            continue
        elements.append(_shape_to_element(presentation, slide, shape, files, options, order))
    return elements


def _shape_to_element(
    presentation: Mapping[str, Any],
    slide: Mapping[str, Any],
    shape: Mapping[str, Any],
    files: Mapping[str, Any],
    options: PptxConvertOptions,
    order: int,
) -> dict[str, Any]:
    shape_type = str(shape.get("type") or "")
    is_group = shape_type == "Group"
    table_rows = _table_rows(shape.get("table"))
    kind = (
        "group"
        if is_group
        else "table"
        if shape_type == "Table" or shape.get("table")
        else "image"
        if shape_type == "Picture" or shape.get("picture")
        else "object"
    )
    xfrm = _shape_xfrm(presentation, slide, shape)
    element: dict[str, Any] = {
        "type": shape_type,
        "kind": kind,
        "order": order,
        "ooxmlOrder": order,
        "xfrm": {
            "off": {
                "x": _number(xfrm.get("x")),
                "y": _number(xfrm.get("y")),
            },
            "ext": {
                "cx": _number(xfrm.get("cx")),
                "cy": _number(xfrm.get("cy")),
            },
        },
        "plainText": _text_from_body(shape.get("txBody")),
    }
    if table_rows:
        element["tableRows"] = table_rows

    picture = shape.get("picture")
    if kind == "image" and isinstance(picture, Mapping):
        blip = picture.get("blip")
        entry = files.get(blip) if isinstance(blip, str) else None
        path, size = _file_path_and_size(entry)
        if path and (
            not options.min_image_bytes or size is None or size >= options.min_image_bytes
        ):
            alt = shape.get("alt") or shape.get("descr") or shape.get("title") or ""
            element["image"] = {
                "alt": str(alt),
                "fileName": options.to_image_url(path),
            }

    children = shape.get("children")
    if isinstance(children, Sequence) and not isinstance(children, (str, bytes)):
        if is_group:
            element["children"] = _shapes_to_elements(
                presentation,
                slide,
                children,
                files,
                options,
            )
        elif children:
            # Non-group children are only a leaf/mother eligibility marker.
            element["children"] = [{}]
    return element


def _file_path_and_size(entry: Any) -> tuple[str | None, int | None]:
    if isinstance(entry, Sequence) and not isinstance(entry, (str, bytes)):
        path = str(entry[0]) if entry else None
        size = entry[1] if len(entry) > 1 else None
        return path, int(size) if isinstance(size, (int, float)) else None
    if isinstance(entry, Mapping):
        path = entry.get("path") or entry.get("key") or entry.get("url")
        size = entry.get("bytes") or entry.get("size")
        return (
            str(path) if path else None,
            int(size) if isinstance(size, (int, float)) else None,
        )
    return None, None


def _text_from_body(tx_body: Any) -> str:
    if not isinstance(tx_body, Mapping):
        return ""
    paragraphs: list[str] = []
    for paragraph in tx_body.get("children") or []:
        if not isinstance(paragraph, Mapping):
            continue
        paragraphs.append(
            "".join(
                str(run.get("t") or "")
                for run in (paragraph.get("children") or [])
                if isinstance(run, Mapping)
            )
        )
    return "\n".join(paragraphs)


def _table_rows(table: Any) -> list[list[str]]:
    if not isinstance(table, Mapping):
        return []
    rows: list[list[str]] = []
    for row in table.get("trs") or []:
        if not isinstance(row, Mapping):
            continue
        rows.append(
            [
                _text_from_body(cell.get("txBody"))
                for cell in (row.get("cells") or [])
                if isinstance(cell, Mapping)
            ]
        )
    return rows


def _shape_xfrm(
    presentation: Mapping[str, Any],
    slide: Mapping[str, Any],
    shape: Mapping[str, Any],
) -> Mapping[str, Any]:
    own = shape.get("xfrm")
    if isinstance(own, Mapping):
        return own
    placeholder = shape.get("ph")
    if not isinstance(placeholder, Mapping):
        return {}

    master = next(
        (
            item
            for item in (presentation.get("slideMasters") or [])
            if isinstance(item, Mapping) and item.get("_ref") == slide.get("_masterRef")
        ),
        None,
    )
    if not isinstance(master, Mapping):
        return {}
    layout = next(
        (
            item
            for item in (master.get("slideLayouts") or [])
            if isinstance(item, Mapping) and item.get("_ref") == slide.get("_layoutRef")
        ),
        None,
    )
    if not isinstance(layout, Mapping):
        return {}

    layout_shape = _placeholder_shape(layout.get("spTree"), placeholder)
    if isinstance(layout_shape, Mapping):
        layout_xfrm = layout_shape.get("xfrm")
        if isinstance(layout_xfrm, Mapping):
            return layout_xfrm
        layout_placeholder = layout_shape.get("ph")
        if isinstance(layout_placeholder, Mapping):
            master_shape = _placeholder_shape(master.get("spTree"), layout_placeholder)
            if isinstance(master_shape, Mapping):
                master_xfrm = master_shape.get("xfrm")
                if isinstance(master_xfrm, Mapping):
                    return master_xfrm
    return {}


def _placeholder_shape(shapes: Any, placeholder: Mapping[str, Any]) -> Mapping[str, Any] | None:
    if not isinstance(shapes, Sequence):
        return None
    idx = placeholder.get("idx")
    placeholder_type = placeholder.get("type")
    candidates = [
        shape
        for shape in shapes
        if isinstance(shape, Mapping) and isinstance(shape.get("ph"), Mapping)
    ]
    if idx is not None:
        matched = next((shape for shape in candidates if shape["ph"].get("idx") == idx), None)
        if matched is not None:
            return matched
    if placeholder_type is not None:
        return next(
            (shape for shape in candidates if shape["ph"].get("type") == placeholder_type),
            None,
        )
    return None


def _parse_group(elements: list[dict[str, Any]], options: PptxConvertOptions) -> str:
    processed = [_prepare_group_member(element, options) for element in elements]
    participants = [element for element in processed if _participates(element)]
    rows = _group_into_rows(participants, options)
    rows.sort(key=_row_top)
    for row in rows:
        _sort_row_by_chained_distance(row)
    return options.row_separator.join(
        text for row in rows if (text := _format_row(row, options)) or not options.drop_empty_text
    )


def _prepare_group_member(
    element: dict[str, Any],
    options: PptxConvertOptions,
) -> dict[str, Any]:
    if not _is_entity_group(element) or not element.get("children"):
        return element
    processed = dict(element)
    processed["kind"] = processed.get("kind") or "group"
    processed["plainText"] = _parse_group(element["children"], options)
    processed.pop("children", None)
    return processed


def _group_into_rows(
    elements: list[dict[str, Any]],
    options: PptxConvertOptions,
) -> list[list[dict[str, Any]]]:
    rows: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for element in sorted(elements, key=_initial_sort_key):
        if not current or _vertically_associated(element, current, options):
            current.append(element)
        else:
            rows.append(current)
            current = [element]
    if current:
        rows.append(current)
    return rows


def _vertically_associated(
    element: dict[str, Any],
    row: list[dict[str, Any]],
    options: PptxConvertOptions,
) -> bool:
    row_boxes = [_grouping_box(item, options) for item in row]
    row_top = min(box["top"] for box in row_boxes)
    row_bottom = max(box["top"] + box["height"] for box in row_boxes)
    element_box = _grouping_box(element, options)
    element_top = element_box["top"]
    element_bottom = element_top + element_box["height"]
    if element_top < row_bottom and element_bottom > row_top:
        return True
    vertical_gap = element_top - row_bottom
    if vertical_gap <= 0:
        return False
    tolerance = max(
        options.absolute_vertical_tolerance,
        (row_bottom - row_top) * options.vertical_tolerance_factor,
    )
    return vertical_gap <= tolerance


def _format_row(row: list[dict[str, Any]], options: PptxConvertOptions) -> str:
    items = [
        (element, _element_output(element).strip())
        for element in row
        if _element_output(element).strip()
    ]
    block_like = any(
        _element_kind(element) in {"group", "table"} or "\n" in output for element, output in items
    )
    separator = options.block_separator if block_like else options.inline_separator
    return separator.join(output for _, output in items)


def _participates(element: dict[str, Any]) -> bool:
    box = _box(element)
    if box["width"] <= 0 and box["height"] <= 0:
        return False
    return bool(_element_output(element).strip()) or not _is_background_like(element)


def _is_background_like(element: dict[str, Any]) -> bool:
    box = _box(element)
    return (
        not _element_output(element).strip()
        and box["left"] <= 0
        and box["top"] <= 0
        and box["width"] >= 8_000_000
        and box["height"] >= 5_000_000
    )


def _element_output(element: dict[str, Any]) -> str:
    if element.get("markdown"):
        return str(element["markdown"])
    rows = element.get("tableRows")
    if rows:
        return _markdown_table(rows)
    if _element_kind(element) == "image":
        image = element.get("image") or {}
        file_name = image.get("fileName") or element.get("fileName") or element.get("name")
        if file_name:
            alt = image.get("alt") or element.get("alt") or ""
            return f"![{_escape_image_alt(str(alt))}]({_markdown_link_target(str(file_name))})"
    return str(element.get("plainText") or element.get("text") or "")


def _markdown_table(rows: list[list[Any]]) -> str:
    normalized = [[_table_cell_text(cell) for cell in row] for row in rows]
    if not normalized:
        return ""
    width = max(map(len, normalized))
    if width <= 0:
        return ""
    padded = [row + [""] * (width - len(row)) for row in normalized]
    return "\n".join(
        "| " + " | ".join(row) + " |" for row in [padded[0], ["---"] * width, *padded[1:]]
    )


def _table_cell_text(value: Any) -> str:
    return str(value).replace("|", r"\|").replace("\n", "<br>").strip()


def _escape_image_alt(value: str) -> str:
    return value.replace("\n", " ").replace("]", r"\]")


def _markdown_link_target(value: str) -> str:
    if any(character.isspace() for character in value) or any(
        character in value for character in "()#<>"
    ):
        return f"<{value.replace('>', '%3E')}>"
    return value


def _element_kind(element: dict[str, Any]) -> str:
    if element.get("kind"):
        return str(element["kind"])
    if element.get("tableRows"):
        return "table"
    if element.get("type") == "Picture":
        return "image"
    if element.get("type") == "Group":
        return "group"
    return str(element.get("type") or "object")


def _is_entity_group(element: dict[str, Any]) -> bool:
    return _element_kind(element) == "group"


def _initial_sort_key(element: dict[str, Any]) -> tuple[float, float, int, int]:
    box = _box(element)
    return box["top"], box["left"], _ooxml_order(element), _fallback_order(element)


def _sort_row_by_chained_distance(row: list[dict[str, Any]]) -> None:
    if not row:
        return
    anchor_left = min(_box(element)["left"] for element in row)
    anchor_top = min(_box(element)["top"] for element in row)
    ordered, _ = _chain_order_elements(row, anchor_left, anchor_top)
    row[:] = ordered


def _chain_order_elements(
    elements: list[dict[str, Any]],
    anchor_left: float,
    anchor_top: float,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    items = _virtual_chain_items(elements)
    first = _first_meaningful_chain_item(items)
    if first is None:
        return _chain_order_items(items, anchor_left, anchor_top)
    remaining = [item for item in items if item is not first]
    ordered = _expand_chain_item(first)
    anchor = _chain_item_anchor(first)
    anchor_box = _box(anchor)
    rest, last_anchor = _chain_order_items(
        remaining,
        anchor_box["left"],
        anchor_box["top"],
    )
    return [*ordered, *rest], last_anchor or anchor


def _first_meaningful_chain_item(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    meaningful = [item for item in items if _chain_item_has_meaning(item)]
    if not meaningful:
        return None
    topmost = min(meaningful, key=_chain_item_position_key)
    topmost_box = _chain_item_box(topmost)
    side_by_side = [
        item for item in meaningful if _boxes_vertically_overlap(_chain_item_box(item), topmost_box)
    ]
    return min(
        side_by_side or [topmost],
        key=lambda item: (
            _chain_item_box(item)["left"],
            _chain_item_box(item)["top"],
            _ooxml_order(_chain_item_anchor(item)),
            _fallback_order(_chain_item_anchor(item)),
        ),
    )


def _chain_item_has_meaning(item: dict[str, Any]) -> bool:
    if item["kind"] == "element":
        element = item["element"]
        return _is_entity_group(element) or bool(_element_output(element).strip())
    return bool(_element_output(item["mother"]).strip()) or any(
        _chain_item_has_meaning(child) for child in item["children"]
    )


def _chain_item_position_key(item: dict[str, Any]) -> tuple[float, float, int, int]:
    box = _chain_item_box(item)
    anchor = _chain_item_anchor(item)
    return box["top"], box["left"], _ooxml_order(anchor), _fallback_order(anchor)


def _chain_item_box(item: dict[str, Any]) -> dict[str, float]:
    return _box(_chain_item_anchor(item))


def _chain_order_items(
    items: list[dict[str, Any]],
    anchor_left: float,
    anchor_top: float,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    remaining = list(items)
    ordered: list[dict[str, Any]] = []
    last_anchor: dict[str, Any] | None = None
    while remaining:
        next_item = min(
            remaining,
            key=lambda item: _chain_sort_key(_chain_item_anchor(item), anchor_left, anchor_top),
        )
        remaining.remove(next_item)
        ordered.extend(_expand_chain_item(next_item))
        anchor = _chain_item_anchor(next_item)
        anchor_box = _box(anchor)
        anchor_left = anchor_box["left"]
        anchor_top = anchor_box["top"]
        last_anchor = anchor
    return ordered, last_anchor


def _virtual_chain_items(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    mothers = [element for element in elements if _is_virtual_group_mother(element)]
    child_map: dict[int, list[dict[str, Any]]] = {id(mother): [] for mother in mothers}
    parent_by_child: dict[int, dict[str, Any]] = {}
    for element in elements:
        if not _is_virtual_group_child(element):
            continue
        mother = _overlapping_virtual_mother(element, mothers)
        if mother is not None:
            parent_by_child[id(element)] = mother
            child_map[id(mother)].append(element)
    return [
        _virtual_chain_item_for(element, child_map)
        for element in elements
        if id(element) not in parent_by_child
    ]


def _virtual_chain_item_for(
    element: dict[str, Any],
    child_map: dict[int, list[dict[str, Any]]],
) -> dict[str, Any]:
    children = child_map.get(id(element), [])
    if not children:
        return {"kind": "element", "element": element}
    return {
        "kind": "virtual_group",
        "mother": element,
        "children": [_virtual_chain_item_for(child, child_map) for child in children],
    }


def _is_virtual_group_mother(element: dict[str, Any]) -> bool:
    box = _box(element)
    return (
        not _is_entity_group(element)
        and not _is_background_like(element)
        and box["width"] > 0
        and box["height"] > 0
    )


def _is_virtual_group_child(element: dict[str, Any]) -> bool:
    return not _is_entity_group(element) and not element.get("children")


def _overlapping_virtual_mother(
    element: dict[str, Any],
    mothers: list[dict[str, Any]],
) -> dict[str, Any] | None:
    element_box = _box(element)
    element_area = _box_area(element_box)
    candidates = [
        mother
        for mother in mothers
        if mother is not element
        and _box_area(_box(mother)) > element_area
        and _boxes_overlap_with_area(element_box, _box(mother))
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda mother: (
            _box_area(_box(mother)),
            _plane_distance_sq(element_box, _box(mother)["left"], _box(mother)["top"]),
            _ooxml_order(mother),
            _fallback_order(mother),
        ),
    )


def _chain_item_anchor(item: dict[str, Any]) -> dict[str, Any]:
    anchor = item["mother"] if item["kind"] == "virtual_group" else item["element"]
    if not isinstance(anchor, dict):
        raise TypeError("chain item anchor must be an element")
    return anchor


def _expand_chain_item(item: dict[str, Any]) -> list[dict[str, Any]]:
    if item["kind"] != "virtual_group":
        return [item["element"]]
    mother = item["mother"]
    children = item["children"]
    if not children:
        return [mother]
    mother_box = _box(mother)
    ordered, _ = _chain_order_items(children, mother_box["left"], mother_box["top"])
    return [mother, *ordered]


def _chain_sort_key(
    element: dict[str, Any],
    anchor_left: float,
    anchor_top: float,
) -> tuple[float, float, float, int, int]:
    box = _box(element)
    return (
        _plane_distance_sq(box, anchor_left, anchor_top),
        box["top"],
        box["left"],
        _ooxml_order(element),
        _fallback_order(element),
    )


def _plane_distance_sq(box: dict[str, float], anchor_left: float, anchor_top: float) -> float:
    return (box["left"] - anchor_left) ** 2 + (box["top"] - anchor_top) ** 2


def _boxes_overlap_with_area(first: dict[str, float], second: dict[str, float]) -> bool:
    return (
        first["left"] < second["left"] + second["width"]
        and first["left"] + first["width"] > second["left"]
        and first["top"] < second["top"] + second["height"]
        and first["top"] + first["height"] > second["top"]
    )


def _boxes_vertically_overlap(first: dict[str, float], second: dict[str, float]) -> bool:
    return (
        first["top"] < second["top"] + second["height"]
        and first["top"] + first["height"] > second["top"]
    )


def _box_area(box: dict[str, float]) -> float:
    return box["width"] * box["height"]


def _row_top(row: list[dict[str, Any]]) -> float:
    readable = [_box(element)["top"] for element in row if _element_output(element).strip()]
    return min(readable) if readable else min(_box(element)["top"] for element in row)


def _box(element: dict[str, Any]) -> dict[str, float]:
    xfrm = element.get("xfrm") or {}
    off = xfrm.get("off") or {}
    ext = xfrm.get("ext") or {}
    return {
        "left": _number(off.get("x")),
        "top": _number(off.get("y")),
        "width": _number(ext.get("cx")),
        "height": _number(ext.get("cy")),
    }


def _grouping_box(
    element: dict[str, Any],
    options: PptxConvertOptions,
) -> dict[str, float]:
    box = _box(element)
    if _element_output(element).strip():
        return box
    padding = options.absolute_vertical_tolerance * 2
    return {
        **box,
        "top": box["top"] - padding,
        "height": box["height"] + padding * 2,
    }


def _ooxml_order(element: dict[str, Any]) -> int:
    value = element.get("ooxmlOrder", element.get("order"))
    return value if isinstance(value, int) and not isinstance(value, bool) else 2**31 - 1


def _fallback_order(element: dict[str, Any]) -> int:
    value = element.get("order")
    return value if isinstance(value, int) and not isinstance(value, bool) else 2**31 - 1


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


pptxResult2Markdown = pptx_result_to_markdown
