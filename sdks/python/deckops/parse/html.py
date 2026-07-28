from __future__ import annotations

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag
from bs4.element import NavigableString


def _clean_inline(value: str) -> str:
    return re.sub(r"[ \t\r\f\v]+", " ", value).strip()


def _table_markdown(table: Tag) -> str:
    rows: list[list[str]] = []
    for row in table.find_all("tr"):
        cells = [
            _clean_inline(cell.get_text(" ", strip=True)).replace("|", r"\|")
            for cell in row.find_all(["th", "td"], recursive=False)
        ]
        if cells:
            rows.append(cells)
    if not rows:
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


def _children_markdown(tag: Tag, base_url: str | None) -> str:
    return "".join(_node_markdown(child, base_url) for child in tag.children)


def _node_markdown(node: object, base_url: str | None) -> str:
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""
    name = node.name.lower()
    if name in {"script", "style", "noscript", "iframe", "nav", "footer", "aside"}:
        return ""
    if name == "img":
        src = str(node.get("src") or "")
        return f"![img]({urljoin(base_url, src) if base_url else src})" if src else ""
    if name == "br":
        return "\n"
    if name == "hr":
        return "\n\n---\n\n"
    if name in {"strong", "b"}:
        text = _clean_inline(_children_markdown(node, base_url))
        return f"**{text}**" if text else ""
    if name in {"em", "i"}:
        text = _clean_inline(_children_markdown(node, base_url))
        return f"*{text}*" if text else ""
    if name == "code" and node.parent and node.parent.name != "pre":
        return f"`{node.get_text()}`"
    if name == "pre":
        return f"\n\n```\n{node.get_text().strip()}\n```\n\n"
    if name == "a":
        text = _clean_inline(_children_markdown(node, base_url))
        href = str(node.get("href") or "")
        target = urljoin(base_url, href) if base_url and href else href
        return f"[{text}]({target})" if text and target else text
    if name == "table":
        table = _table_markdown(node)
        return f"\n\n{table}\n\n" if table else ""
    if name in {"ul", "ol"}:
        lines: list[str] = []
        for index, item in enumerate(node.find_all("li", recursive=False), start=1):
            text = _clean_inline(_children_markdown(item, base_url))
            if text:
                marker = f"{index}." if name == "ol" else "-"
                lines.append(f"{marker} {text}")
        joined = "\n".join(lines)
        return f"\n\n{joined}\n\n" if lines else ""
    if name == "li":
        return _children_markdown(node, base_url)
    if re.fullmatch(r"h[1-6]", name):
        text = _clean_inline(_children_markdown(node, base_url))
        return f"\n\n{'#' * int(name[1])} {text}\n\n" if text else ""
    if name == "blockquote":
        text = _children_markdown(node, base_url).strip()
        return "\n\n" + "\n".join(f"> {line}" for line in text.splitlines()) + "\n\n"
    if name in {"p", "div", "section", "article", "main", "header"}:
        text = _children_markdown(node, base_url).strip()
        return f"\n\n{text}\n\n" if text else ""
    return _children_markdown(node, base_url)


def _normalize_markdown(value: str) -> str:
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n[ \t]+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def html_to_markdown(html: str, *, url: str | None = None) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    for image in soup.find_all("img"):
        data_src = image.get("data-src")
        src = image.get("src")
        if data_src and (not src or not str(src).startswith("http")):
            image["src"] = data_src
    for element in soup.find_all(["noscript", "script", "style", "iframe"]):
        element.decompose()

    title = _clean_inline(soup.title.get_text(" ", strip=True)) if soup.title else ""
    content = (
        soup.find("article") or soup.find("main") or soup.select_one('[role="main"]') or soup.body
    )
    body = _normalize_markdown(_children_markdown(content, url)) if isinstance(content, Tag) else ""
    if not body:
        suffix = f" from {url}" if url else ""
        raise ValueError(f"html2markdown: empty content extracted{suffix}")
    return f"# {title}\n\n{body}" if title else body


html2markdown = html_to_markdown
