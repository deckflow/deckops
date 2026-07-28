from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import httpx

from .files import FilesClient
from .http_client import AuthRefresh, HTTPClient
from .parse_facade import ParseFacade
from .tasks import TasksClient
from .types import DEFAULT_ROOT, AuthUUIDStorage, ParseResult, Task


class DeckClient:
    def __init__(
        self,
        *,
        root: str = DEFAULT_ROOT,
        token: str | None = None,
        api_key: str | None = None,
        space_id: str | None = None,
        auth_uuid: str | None = None,
        auth_uuid_storage: AuthUUIDStorage | None = None,
        on_unauthorized: Callable[[], AuthRefresh] | None = None,
        on_payment_required: Callable[[], None] | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._http = HTTPClient(
            root=root,
            token=token,
            api_key=api_key,
            space_id=space_id,
            auth_uuid=auth_uuid,
            auth_uuid_storage=auth_uuid_storage,
            on_unauthorized=on_unauthorized,
            on_payment_required=on_payment_required,
            client=http_client,
        )
        self.root = self._http.root
        self.files = FilesClient(self._http)
        self.tasks = TasksClient(self._http, self.files)
        self.ttask = self.tasks
        self._parse_facade = ParseFacade(self.tasks)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> DeckClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def set_token(self, token: str | None) -> None:
        self._http.set_token(token)

    def set_api_key(self, api_key: str | None) -> None:
        self._http.set_api_key(api_key)

    def set_space_id(self, space_id: str | None) -> None:
        self._http.set_space_id(space_id)

    def get_auth_uuid(self) -> str:
        return self._http.auth_uuid

    def parse(self, input: Any) -> str:
        return self._parse_facade.parse(input)

    def parse_detailed(self, input: Any) -> ParseResult:
        return self._parse_facade.parse_detailed(input)

    def _shortcut(self, task_type: str, **kwargs: Any) -> Task:
        kwargs.pop("type", None)
        aliases = {
            "spaceId": "space_id",
            "fileIds": "file_ids",
        }
        normalized = {aliases.get(key, key): value for key, value in kwargs.items()}
        return self.tasks.create(type=task_type, **normalized)

    def file_compress(self, **kwargs: Any) -> Task:
        return self._shortcut("file.compress", **kwargs)

    def image_ocr(self, **kwargs: Any) -> Task:
        return self._shortcut("image.ocr", **kwargs)

    def image_convert_webp(self, **kwargs: Any) -> Task:
        return self._shortcut("image.convertWebp", **kwargs)

    def image_resize(self, **kwargs: Any) -> Task:
        return self._shortcut("image.resize", **kwargs)

    def pptx_split(self, **kwargs: Any) -> Task:
        return self._shortcut("pptx.split", **kwargs)

    def pptx_join(self, **kwargs: Any) -> Task:
        return self._shortcut("pptx.join", **kwargs)

    def pptx_get_font_info(self, **kwargs: Any) -> Task:
        return self._shortcut("pptx.getFontInfo", **kwargs)

    def pptx_get_text_shapes(self, **kwargs: Any) -> Task:
        return self._shortcut("pptx.getTextShapes", **kwargs)

    def pptx_embed_fonts(self, **kwargs: Any) -> Task:
        return self._shortcut("pptx.embedFonts", **kwargs)

    def convert_ppt_to_image(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.ppt2image", **kwargs)

    def convert_ppt_to_pptx(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.ppt2pptx", **kwargs)

    def convert_ppt_to_pdf(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.ppt2pdf", **kwargs)

    def convert_doc_to_pdf(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.doc2pdf", **kwargs)

    def convert_ppt_to_video(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.ppt2video", **kwargs)

    def convert_pdf_to_image(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.pdf2image", **kwargs)

    def convert_keynote_to_image(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.keynote2image", **kwargs)

    def convert_keynote_to_html(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.keynote2html", **kwargs)

    def convert_keynote_to_pdf(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.keynote2pdf", **kwargs)

    def convert_html_to_png(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.html2png", **kwargs)

    def convert_markdown_to_png(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.markdown2png", **kwargs)

    def convert_html_to_pptx(self, **kwargs: Any) -> Task:
        return self._shortcut("convertor.html2pptx", **kwargs)

    def html_build_player(self, **kwargs: Any) -> Task:
        return self._shortcut("html.buildPlayer", **kwargs)

    def video_compress(self, **kwargs: Any) -> Task:
        return self._shortcut("video.compress", **kwargs)

    def generation(self, **kwargs: Any) -> Task:
        return self._shortcut("generation", **kwargs)

    def translation(self, **kwargs: Any) -> Task:
        return self._shortcut("translation", **kwargs)

    def revamp(self, **kwargs: Any) -> Task:
        return self._shortcut("revamp", **kwargs)

    def pdf_parse(self, **kwargs: Any) -> Task:
        return self._shortcut("pdf.parse", **kwargs)

    def pptx_parse(self, **kwargs: Any) -> Task:
        return self._shortcut("pptx.parse", **kwargs)

    def docx_parse(self, **kwargs: Any) -> Task:
        return self._shortcut("docx.parseTextAndImage", **kwargs)

    def keynote_parse(self, **kwargs: Any) -> Task:
        return self._shortcut("keynote.parseTextAndImage", **kwargs)

    def html_get_by_url(self, **kwargs: Any) -> Task:
        return self._shortcut("html.getByURL", **kwargs)

    # TypeScript-compatible aliases.
    setToken = set_token
    setApiKey = set_api_key
    setSpaceId = set_space_id
    getAuthUuid = get_auth_uuid
    parseDetailed = parse_detailed
    fileCompress = file_compress
    imageOcr = image_ocr
    imageConvertWebp = image_convert_webp
    imageResize = image_resize
    pptxSplit = pptx_split
    pptxJoin = pptx_join
    pptxGetFontInfo = pptx_get_font_info
    pptxGetTextShapes = pptx_get_text_shapes
    pptxEmbedFonts = pptx_embed_fonts
    convertPptToImage = convert_ppt_to_image
    convertPptToPptx = convert_ppt_to_pptx
    convertPptToPdf = convert_ppt_to_pdf
    convertDocToPdf = convert_doc_to_pdf
    convertPptToVideo = convert_ppt_to_video
    convertPdfToImage = convert_pdf_to_image
    convertKeynoteToImage = convert_keynote_to_image
    convertKeynoteToHtml = convert_keynote_to_html
    convertKeynoteToPdf = convert_keynote_to_pdf
    convertHtmlToPng = convert_html_to_png
    convertMarkdownToPng = convert_markdown_to_png
    convertHtmlToPptx = convert_html_to_pptx
    htmlBuildPlayer = html_build_player
    videoCompress = video_compress
    pdfParse = pdf_parse
    pptxParse = pptx_parse
    docxParse = docx_parse
    keynoteParse = keynote_parse
    htmlGetByURL = html_get_by_url


def create_deck(
    options: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> DeckClient:
    values = {**dict(options or {}), **kwargs}
    aliases = {
        "apiKey": "api_key",
        "spaceId": "space_id",
        "authUuid": "auth_uuid",
        "authUuidStorage": "auth_uuid_storage",
        "onUnauthorized": "on_unauthorized",
        "onPaymentRequired": "on_payment_required",
        "httpClient": "http_client",
    }
    normalized = {aliases.get(key, key): value for key, value in values.items()}
    return DeckClient(**normalized)


createDeck = create_deck
