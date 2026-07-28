from __future__ import annotations

from typing import Any

from deckops import (
    docx_result_to_markdown,
    extension_of,
    html_to_markdown,
    keynote_result_to_markdown,
    parse_task_type_for,
    pdf_result_to_markdown,
    pptx_result_to_markdown,
)


def _shape(
    text: str,
    *,
    left: int,
    top: int,
    width: int = 100,
    height: int = 20,
    order: int = 0,
    type: str = "Shape",
) -> dict[str, Any]:
    shape: dict[str, Any] = {
        "id": order + 1,
        "name": f"{type} {order + 1}",
        "type": type,
        "xfrm": {"x": left, "y": top, "cx": width, "cy": height},
    }
    if text:
        shape["txBody"] = {"children": [{"children": [{"t": text}]}]}
    return shape


def _presentation(
    shapes: list[dict[str, Any]],
    files: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "slides": [
            {
                "_ref": "slide1.xml",
                "_layoutRef": "layout1.xml",
                "_masterRef": "master1.xml",
                "spTree": shapes,
            }
        ],
        "slideMasters": [],
        "slideSize": {"cx": 12_000_000, "cy": 7_000_000},
        "notesSize": {"cx": 7_000_000, "cy": 9_000_000},
        "files": files or {},
    }


def test_pdf_markdown_preserves_page_order_and_roles() -> None:
    result = {
        "textBlocks": [
            {"text": "第二页", "locator": {"pageIndex": 1}},
            {"text": "标题", "role": "heading", "locator": {"pageIndex": 0}},
            {"text": "要点", "role": "list-item", "locator": {"pageIndex": 0}},
            {"text": "粗体", "style": {"bold": True}, "locator": {"pageIndex": 0}},
        ],
        "images": [{"key": "k/a.png", "fileName": "a.png", "locator": {"pageIndex": 0}}],
    }
    assert pdf_result_to_markdown(result) == "\n\n".join(
        ("## 标题", "- 要点", "**粗体**", "![a.png](k/a.png)", "第二页")
    )


def test_keynote_never_drops_unassigned_images() -> None:
    result = {
        "pageNum": 2,
        "width": 1280,
        "height": 720,
        "slides": [
            {"text": [{"id": "1", "text": "第一页"}], "table": [], "chart": []},
            {"text": [{"id": "2", "text": "第二页"}], "table": [], "chart": []},
        ],
        "images": [
            {"id": "i1", "fileName": "a.png", "key": "k/a.png"},
            {"id": "i2", "fileName": "b.png", "key": "k/b.png", "pageIndex": 9},
        ],
    }
    markdown = keynote_result_to_markdown(result)
    assert markdown.count("![img]") == 2
    assert markdown.endswith("![img](k/a.png)\n![img](k/b.png)")


def test_docx_outputs_headings_groups_and_gfm_tables() -> None:
    result = {
        "content": [
            {
                "idx": 1,
                "type": "table",
                "table": [
                    {
                        "children": [
                            {"children": [{"type": "text", "text": "A|B"}]},
                            {"children": [{"type": "text", "text": "值"}]},
                        ]
                    },
                    {"children": [{"children": [{"type": "text", "text": "一列"}]}]},
                ],
            },
            {
                "idx": 0,
                "type": "text",
                "text": "标题",
                "style": {"outlineLvl": 0},
            },
        ]
    }
    markdown = docx_result_to_markdown(result)
    assert markdown.startswith("# 标题\n\n")
    assert "| A\\|B | 值 |" in markdown
    assert "| 一列 |  |" in markdown


def test_html_extracts_article_and_absolutizes_lazy_images() -> None:
    html = """
    <html><head><title>文章标题</title></head><body>
      <nav>导航文字</nav>
      <article><h1>正文</h1><p>第一段内容。</p>
      <img data-src="/static/a.png" src="">
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <noscript><img src="/fallback.png"></noscript></article>
      <footer>页脚</footer>
    </body></html>
    """
    markdown = html_to_markdown(html, url="https://example.com/posts/1")
    assert markdown.startswith("# 文章标题")
    assert "导航文字" not in markdown
    assert "页脚" not in markdown
    assert "![img](https://example.com/static/a.png)" in markdown
    assert "fallback.png" not in markdown
    assert "| A | B |" in markdown


def test_pptx_recurses_entity_groups_and_uses_block_separator() -> None:
    emu = 100_000
    group = {
        **_shape(
            "",
            left=400 * emu,
            top=150 * emu,
            width=300 * emu,
            height=120 * emu,
            order=1,
            type="Group",
        ),
        "children": [
            _shape(
                "要点一",
                left=410 * emu,
                top=160 * emu,
                width=280 * emu,
                height=40 * emu,
            ),
            _shape(
                "要点二",
                left=410 * emu,
                top=230 * emu,
                width=280 * emu,
                height=40 * emu,
                order=1,
            ),
        ],
    }
    result = _presentation(
        [
            _shape(
                "左侧正文",
                left=50 * emu,
                top=150 * emu,
                width=300 * emu,
                height=100 * emu,
            ),
            group,
            _shape(
                "下一段",
                left=50 * emu,
                top=400 * emu,
                width=300 * emu,
                height=100 * emu,
                order=2,
            ),
        ]
    )
    assert pptx_result_to_markdown(result) == ("左侧正文\n---\n要点一\n要点二\n下一段")


def test_pptx_empty_geometry_bridges_rows_without_output() -> None:
    result = _presentation(
        [
            _shape("A", left=0, top=0, height=100),
            _shape("", left=40, top=225, height=25, order=1),
            _shape("B", left=100, top=350, height=100, order=2),
        ]
    )
    assert (
        pptx_result_to_markdown(
            result,
            vertical_tolerance_factor=0,
            absolute_vertical_tolerance=100,
        )
        == "A B"
    )


def test_pptx_virtual_groups_and_nearest_neighbor_order() -> None:
    result = _presentation(
        [
            _shape("Large", left=0, top=0, width=1000, height=1000),
            _shape("Medium", left=800, top=800, width=150, height=150, order=1),
            _shape("Child", left=940, top=940, width=10, height=10, order=2),
            _shape("After", left=960, top=760, width=20, height=20, order=3),
        ]
    )
    assert pptx_result_to_markdown(result) == "Large Medium Child After"


def test_pptx_tables_images_and_markdown_escaping() -> None:
    table = {
        **_shape("", left=0, top=0, width=100, height=80, type="Table"),
        "table": {
            "grid": {"cols": [{}, {}]},
            "trs": [
                {
                    "cells": [
                        {"txBody": {"children": [{"children": [{"t": "Name"}]}]}},
                        {"txBody": {"children": [{"children": [{"t": "Value"}]}]}},
                    ]
                },
                {
                    "cells": [
                        {"txBody": {"children": [{"children": [{"t": "A|B"}]}]}},
                        {"txBody": {"children": [{"children": [{"t": "10"}]}]}},
                    ]
                },
            ],
        },
    }
    image = {
        **_shape("", left=120, top=0, width=60, height=60, order=1, type="Picture"),
        "picture": {"blip": "rIdImage"},
        "alt": "示例]图",
    }
    result = _presentation([table, image], {"rIdImage": ["image 1.png", 6000, "hash"]})
    assert pptx_result_to_markdown(result) == (
        "| Name | Value |\n| --- | --- |\n| A\\|B | 10 |\n---\n![示例\\]图](<image 1.png>)"
    )


def test_pptx_resolves_placeholder_xfrm_from_layout() -> None:
    result = _presentation(
        [
            {
                "id": 1,
                "name": "Body",
                "type": "Shape",
                "ph": {"idx": 2, "type": "body"},
                "txBody": {"children": [{"children": [{"t": "Inherited"}]}]},
            },
            _shape("Direct", left=0, top=100_000, order=1),
        ]
    )
    result["slideMasters"] = [
        {
            "_ref": "master1.xml",
            "spTree": [],
            "slideLayouts": [
                {
                    "_ref": "layout1.xml",
                    "spTree": [
                        {
                            "id": 10,
                            "name": "Body placeholder",
                            "type": "Shape",
                            "ph": {"idx": 2, "type": "body"},
                            "xfrm": {"x": 0, "y": 0, "cx": 100, "cy": 20},
                        }
                    ],
                }
            ],
        }
    ]
    assert pptx_result_to_markdown(result) == "Inherited\nDirect"


def test_extension_routing_matches_typescript_sdk() -> None:
    assert parse_task_type_for("/tmp/deck.PPTX") == "pptx.parse"
    assert parse_task_type_for("https://x/a.key?v=1#f") == "keynote.parseTextAndImage"
    assert extension_of(".gitignore") == ""
    assert parse_task_type_for("a.txt") is None
