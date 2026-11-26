"""Convert a PDF into a Markdown note and its sibling image directory."""

from collections import defaultdict
from hashlib import sha256
from itertools import groupby
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import quote, urlsplit
import os
import base64
import json
import re
import shutil
import sys

try:
    import pymupdf as pdf
except ImportError:
    sys.exit(2)


class ImportErrorMessage(Exception):
    pass


def escape(text):
    return re.sub(r"([\\`*_\[\]<>|])", r"\\\1", text)


def compact(text):
    return re.sub(r"\s+", "", text)


def lines_on(page):
    flags = pdf.TEXTFLAGS_RAWDICT & ~pdf.TEXT_PRESERVE_IMAGES
    lines = []
    for block in page.get_text("rawdict", flags=flags)["blocks"]:
        for line in block["lines"]:
            chars = [char for span in line["spans"] for char in span["chars"]]
            text = "".join(char["c"] for char in chars).strip()
            if text:
                lines.append((pdf.Rect(line["bbox"]), chars, text))
    return sorted(lines, key=lambda line: (round(line[0].y0, 1), line[0].x0))


def page_links(page):
    links = []
    for link in page.get_links():
        uri = link.get("uri", "")
        try:
            if urlsplit(uri).scheme.lower() in {"https", "http", "mailto"}:
                links.append((link["from"], quote(uri, safe=":/?#[]@!$&'()*+,;=%")))
        except ValueError:
            continue
    return links


def linked_line(line, links):
    rect, chars, _ = line
    y = (rect.y0 + rect.y1) / 2
    nearby = [(rect, uri) for rect, uri in links if rect.y0 <= y <= rect.y1]

    def destination(char):
        left, _, right, _ = char["bbox"]
        x = (left + right) / 2
        return next((uri for rect, uri in nearby if rect.x0 <= x <= rect.x1), None)

    parts = []
    for uri, run in groupby(chars, destination):
        raw = "".join(char["c"] for char in run)
        text = raw.strip()
        if uri and text:
            parts.append(raw[:len(raw) - len(raw.lstrip())] +
                         f"[{escape(text)}](<{uri}>)" + raw[len(raw.rstrip()):])
        else:
            parts.append(escape(raw))
    return "".join(parts).strip()


def heading_events(lines, bookmarks, links):
    events, consumed = [], set()
    for depth, title, y in bookmarks:
        title_key = compact(title)
        match = None
        for index in sorted(range(len(lines)), key=lambda index: abs(lines[index][0].y0 - y)):
            if abs(lines[index][0].y0 - y) > 48:
                break
            for end in range(index + 1, min(index + 4, len(lines)) + 1):
                if compact("".join(line[2] for line in lines[index:end])) == title_key:
                    match = (index, end)
                    break
            if match:
                break

        if match:
            lower, upper = match
            consumed.update(range(lower, upper))
            y = lines[lower][0].y0
            label = " ".join(linked_line(line, links) for line in lines[lower:upper])
        else:
            label = escape(title)
        events.append((y, "block", "#" * min(6, max(2, depth + 1)) + " " + label))
    return events, consumed


def table_events(page, lines, links, drawings):
    if len(drawings) < 8:
        return [], []
    events, bounds = [], []
    for table in page.find_tables().tables:
        if table.row_count < 2 or table.col_count < 2:
            continue
        box = pdf.Rect(table.bbox)
        rows = []
        for row in table.rows:
            values = []
            for cell in row.cells:
                cell_box = pdf.Rect(cell) if cell else pdf.Rect()
                parts = []
                for rect, chars, text in lines:
                    if not cell_box.intersects(rect):
                        continue
                    inside = [char for char in chars if cell_box.x0 - 1 <= char["origin"][0] < cell_box.x1 + 1
                              and cell_box.y0 <= (char["bbox"][1] + char["bbox"][3]) / 2 <= cell_box.y1]
                    if inside:
                        parts.append(linked_line((rect, inside, text), links))
                values.append(" ".join(part for part in parts if part))
            if any(values):
                rows.append(values)
        if len(rows) > 1:
            bounds.append(box)
            separators = [round(cell[2] / page.rect.width, 2) for cell in table.rows[0].cells[:-1] if cell]
            continues = bool(separators) and box.y1 > page.rect.height * .88
            events.append((box.y0, "table", (rows, separators, continues)))
    return events, bounds


def image_events(page, lines, drawings, tables, add_image):
    events = []
    images = [block for block in page.get_text("dict")["blocks"] if block["type"] == 1]
    for block in images:
        box = pdf.Rect(block["bbox"])
        data, extension = block["image"], block["ext"]
        if box.width > page.rect.width * .88 and block["colorspace"] == 1 and (lines or len(images) > 1):
            # WPS exports can include a nearly white page-sized raster under the real content.
            thumbnail = pdf.Pixmap(pdf.Pixmap(data), 24, 24)
            coverage, color = thumbnail.color_topusage()
            if coverage >= .8 and color == b"\xff" and min(thumbnail.samples) > 225:
                continue

        if block.get("mask") or extension not in {"png", "jpeg", "jpg", "gif", "webp", "bmp"}:
            bitmap = pdf.Pixmap(data)
            if block.get("mask") and not bitmap.alpha:
                bitmap = pdf.Pixmap(bitmap, pdf.Pixmap(block["mask"]))
            if bitmap.colorspace and bitmap.colorspace.n > 3:
                bitmap = pdf.Pixmap(pdf.csRGB, bitmap)
            data, extension = bitmap.tobytes("png"), "png"
        events.append((box.y0, "block", add_image(page.number, data, extension)))

    # A large filled diagram with marks inside can be represented by PDF drawing commands.
    for drawing in drawings:
        box = drawing["rect"]
        if (drawing["type"] == "s" or not page.rect.width * .25 < box.width < page.rect.width * .88
                or box.height < page.rect.height * .12):
            continue
        if any(box.intersects(table) for table in tables) or any(box.contains(rect) for rect, _, _ in lines):
            continue
        if any(box.contains(other["rect"]) and other["rect"] != box for other in drawings):
            pixels = page.get_pixmap(matrix=pdf.Matrix(1.5, 1.5), clip=box)
            events.append((box.y0, "block", add_image(page.number, pixels.tobytes("png"), "png")))
    return events


def page_blocks(events):
    paragraph, previous = "", None
    for _, kind, data in sorted(events, key=lambda event: event[0]):
        if kind == "text":
            rect, text, plain = data
            if previous:
                old_rect, old_text = previous
                if rect.y0 - old_rect.y0 > max(22, old_rect.height * 1.75) or abs(rect.x0 - old_rect.x0) > 6:
                    yield paragraph
                    paragraph = ""
                elif old_text[-1:].isascii() and plain[:1].isascii() and plain[:1].isalnum():
                    paragraph += " "
            if not paragraph:
                text = re.sub(r"^(?=#+\s|[-+]\s|\d+[.)]\s|---+$|===+$)", lambda _: "\\", text)
            paragraph += text
            previous = (rect, plain)
            continue
        if paragraph:
            yield paragraph
            paragraph = ""
        previous = None
        yield data
    if paragraph:
        yield paragraph


def markdown_table(rows):
    divider = ["---"] * len(rows[0])
    return "\n".join("| " + " | ".join(row) + " |" for row in [rows[0], divider, *rows[1:]])


def extract(document, title, assets, citation=None):
    bookmarks = defaultdict(list)
    for depth, label, page, destination in document.get_toc(simple=False):
        if page >= 1 and destination.get("to") is not None:
            bookmarks[page].append((depth, label, destination["to"].y))

    image_names = {}

    def add_image(page, data, extension):
        digest = sha256(data).digest()
        if digest not in image_names:
            name = f"figure-{len(image_names) + 1:02d}.{extension}"
            assets.mkdir(exist_ok=True)
            (assets / name).write_bytes(data)
            image_names[digest] = name
        directory = quote(assets.name, safe="")
        return f"![原 PDF 第 {page + 1} 页插图]({directory}/{image_names[digest]})"

    output = ["# " + escape(title)]
    continued = False
    tail = None
    for page in document:
        lines = lines_on(page)
        links = page_links(page)
        events, consumed = heading_events(lines, bookmarks[page.number + 1], links)
        drawings = page.get_drawings()
        tables, table_bounds = table_events(page, lines, links, drawings)
        events.extend(tables)
        events.extend(image_events(page, lines, drawings, table_bounds, add_image))
        for index, line in enumerate(lines):
            rect, _, plain = line
            if index in consumed or any(rect.intersects(box) for box in table_bounds):
                continue
            if page.number == 0 and index == 0 and compact(plain) == compact(title):
                continue
            events.append((rect.y0, "text", (rect, linked_line(line, links), plain)))

        page_items = list(page_blocks(events))
        for index, item in enumerate(page_items):
            if (index == 0 and continued and isinstance(item, tuple) and item[1]
                    and tail[1] == item[1] and tables[0][0] < page.rect.height * .16):
                tail[0].extend(item[0])
            else:
                output.append(item)
                tail = item
        continued = bool(page_items and isinstance(page_items[-1], tuple) and page_items[-1][2])
        if citation:
            number = page.number + 1
            output.append(f"[原 PDF 第 {number} 页]({citation}#page={number})")

    return "\n\n".join(markdown_table(item[0]) if isinstance(item, tuple) else item
                      for item in output if item) + "\n"


def convert(source, destination, with_source=False):
    assets = destination.with_suffix(".assets")
    if destination.exists() or assets.exists():
        raise ImportErrorMessage("同名笔记或图片目录已存在，请换一个文件名后再导入。")

    with pdf.open(source) as document, TemporaryDirectory(prefix=".pdf-import-", dir=destination.parent) as temp:
        if document.needs_pass:
            raise ImportErrorMessage("PDF 有密码保护，请先解除保护再导入。")
        staging = Path(temp)
        staged_assets = staging / assets.name
        staged_note = staging / destination.name
        title = (document.metadata.get("title") or source.stem).strip() or source.stem
        citation = None
        if with_source:
            staged_assets.mkdir()
            filename = "原始资料.pdf"
            shutil.copyfile(source, staged_assets / filename)
            citation = "/".join(quote(part, safe="") for part in (assets.name, filename))
        staged_note.write_text(extract(document, title, staged_assets, citation), encoding="utf-8", newline="\n")
        published_assets = False
        try:
            if staged_assets.exists():
                assets.mkdir()
                published_assets = True
                for image in staged_assets.iterdir():
                    image.rename(assets / image.name)
            # Publish the complete note without overwriting a concurrent import.
            if os.name == "nt":
                staged_note.rename(destination)
            else:
                os.link(staged_note, destination)
        except OSError:
            if published_assets:
                shutil.rmtree(assets)
            raise


def preview_page(source, number):
    with pdf.open(source) as document:
        if document.needs_pass:
            raise ImportErrorMessage("PDF 有密码保护，请在系统阅读器中打开。")
        if not 1 <= number <= len(document):
            raise ImportErrorMessage(f"PDF 没有第 {number} 页（共 {len(document)} 页）。")
        page = document[number - 1]
        scale = min(2, 1400 / max(page.rect.width, page.rect.height, 1))
        image = page.get_pixmap(matrix=pdf.Matrix(scale, scale)).tobytes("png")
        print(json.dumps({
            "count": len(document),
            "image": base64.b64encode(image).decode("ascii"),
            "text": page.get_text(sort=True),
        }))


if __name__ == "__main__":
    try:
        if sys.argv[1] == "--page":
            preview_page(Path(sys.argv[2]), int(sys.argv[3]))
        else:
            convert(Path(sys.argv[1]), Path(sys.argv[2]), "--with-source" in sys.argv[3:])
    except ImportErrorMessage as error:
        sys.exit(str(error))
    except FileExistsError:
        sys.exit("同名笔记或图片目录已存在，请换一个文件名后再导入。")
    except (OSError, ValueError, RuntimeError, AttributeError) as error:
        sys.exit(f"PDF 导入失败。{error}")
