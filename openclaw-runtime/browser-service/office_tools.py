#!/usr/bin/env python3

import csv
import io
import json
import os
import posixpath
import re
import shutil
import sys
import tempfile
import zipfile
from typing import Dict, Iterable, List, Optional, Tuple
from xml.etree import ElementTree as ET

try:
    from openpyxl import Workbook, load_workbook
except ImportError:  # pragma: no cover - runtime dependency may be absent in dev
    Workbook = None
    load_workbook = None

WORKSPACE_ROOT = os.environ.get("ENTROPIC_WORKSPACE_PATH", "/data/workspace")

AIO_SPEC = "agent-interpretable-object"
AIO_ROOT = "Agent-Intepretable-Object"
AIO_MANIFEST = f"{AIO_ROOT}/manifest.yaml"
AIO_CORE_KEYWORDS = f"{AIO_ROOT}/core/keywords.yaml"
AIO_CORE_ONTOLOGY = f"{AIO_ROOT}/core/ontology.yaml"
AIO_CORE_CANONICAL_INSTANCE = f"{AIO_ROOT}/core/canonical-instance.yaml"
AIO_FAMILY_TABULAR = f"{AIO_ROOT}/families/tabular-space.yaml"
AIO_FAMILY_LINEAR_TEXT = f"{AIO_ROOT}/families/linear-text.yaml"
AIO_FAMILY_SLIDE_SPACE = f"{AIO_ROOT}/families/slide-space.yaml"
AIO_FAMILY_GRAPHICS_SCENE = f"{AIO_ROOT}/families/graphics-scene.md"
AIO_KIND_SPREADSHEET = f"{AIO_ROOT}/kinds/spreadsheet.yaml"
AIO_KIND_DOCUMENT = f"{AIO_ROOT}/kinds/document.yaml"
AIO_KIND_PRESENTATION = f"{AIO_ROOT}/kinds/presentation.yaml"

XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOCX_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

ET.register_namespace("", XLSX_NS)
ET.register_namespace("r", DOC_REL_NS)
ET.register_namespace("w", DOCX_NS)


def xlsx_tag(name: str) -> str:
    return f"{{{XLSX_NS}}}{name}"


def docx_tag(name: str) -> str:
    return f"{{{DOCX_NS}}}{name}"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def normalize_workspace_root() -> str:
    return posixpath.normpath(WORKSPACE_ROOT)


def resolve_workspace_path(raw_path: str) -> str:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("A workspace file path is required.")
    root = normalize_workspace_root()
    trimmed = raw_path.strip()
    if trimmed == root or trimmed.startswith(f"{root}/"):
        full_path = posixpath.normpath(trimmed)
    else:
        normalized_relative = posixpath.normpath(f"/{trimmed}").lstrip("/")
        full_path = posixpath.join(root, normalized_relative)
    if full_path != root and not full_path.startswith(f"{root}/"):
        raise ValueError("The requested path is outside /data/workspace.")
    return full_path


def path_metadata(path: str) -> Dict[str, object]:
    exists = os.path.exists(path)
    if not exists:
        return {
            "exists": False,
            "modifiedMs": None,
            "size": 0,
            "etag": "missing",
        }
    stats = os.stat(path)
    modified_ms = int(round(stats.st_mtime_ns / 1_000_000))
    return {
        "exists": True,
        "modifiedMs": modified_ms,
        "size": int(stats.st_size),
        "etag": f"{modified_ms}:{stats.st_size}",
    }


def assert_expected_etag(path: str, expected_etag: Optional[str]) -> None:
    if not expected_etag:
        return
    current = path_metadata(path)["etag"]
    if current != expected_etag:
        raise RuntimeError(
            "The file changed on disk while you were editing it. Reload the viewer before saving again."
        )


def ensure_parent_dir(path: str) -> None:
    os.makedirs(posixpath.dirname(path), exist_ok=True)


def atomic_write_bytes(path: str, data: bytes) -> None:
    ensure_parent_dir(path)
    temp_fd, temp_path = tempfile.mkstemp(prefix=".entropic-office-", dir=posixpath.dirname(path))
    try:
        with os.fdopen(temp_fd, "wb") as handle:
            handle.write(data)
        os.replace(temp_path, path)
    finally:
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except OSError:
            pass


def atomic_write_text(path: str, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def split_extension(path: str) -> str:
    return posixpath.splitext(path)[1].lower()


def basename_without_extension(path: str) -> str:
    return posixpath.splitext(posixpath.basename(path))[0] or "object"


def slugify_identifier(value: object, fallback: str) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or fallback


def aio_definition_refs(kind: str) -> Dict[str, object]:
    families: List[str] = []
    kind_path = ""
    if kind == "spreadsheet":
        families = [AIO_FAMILY_TABULAR]
        kind_path = AIO_KIND_SPREADSHEET
    elif kind == "document":
        families = [AIO_FAMILY_LINEAR_TEXT]
        kind_path = AIO_KIND_DOCUMENT
    elif kind == "presentation":
        families = [AIO_FAMILY_SLIDE_SPACE, AIO_FAMILY_GRAPHICS_SCENE]
        kind_path = AIO_KIND_PRESENTATION
    return {
        "manifest": AIO_MANIFEST,
        "core": [AIO_CORE_KEYWORDS, AIO_CORE_ONTOLOGY, AIO_CORE_CANONICAL_INSTANCE],
        "families": families,
        "kind": kind_path,
    }


def aio_source_block(document: Dict[str, object], extra_notes: Optional[List[str]] = None) -> Dict[str, object]:
    notes = []
    warning = str(document.get("warning") or "").strip()
    if warning:
        notes.append(warning)
    for note in extra_notes or []:
        normalized = str(note or "").strip()
        if normalized:
            notes.append(normalized)
    return {
        "path": str(document.get("path") or ""),
        "exists": bool(document.get("exists")),
        "etag": str(document.get("etag") or "missing"),
        "modifiedMs": document.get("modifiedMs"),
        "size": int(document.get("size") or 0),
        "notes": notes,
    }


def aio_envelope(
    kind: str,
    document: Dict[str, object],
    object_payload: Dict[str, object],
    capability_set: str,
    extra_notes: Optional[List[str]] = None,
) -> Dict[str, object]:
    return {
        "spec": AIO_SPEC,
        "kind": kind,
        "format": str(document.get("format") or "").strip(),
        "definitions": aio_definition_refs(kind),
        "realization": {
            "name": "entropic-office",
            "mode": "automation",
            "capability_set": capability_set,
        },
        "source": aio_source_block(document, extra_notes=extra_notes),
        "object": object_payload,
    }


def extract_aio_source_path(payload: Dict[str, object]) -> str:
    source = payload.get("source")
    if isinstance(source, dict):
        return str(source.get("path") or "").strip()
    return ""


def extract_aio_source_etag(payload: Dict[str, object]) -> Optional[str]:
    source = payload.get("source")
    if not isinstance(source, dict):
        return None
    etag = str(source.get("etag") or "").strip()
    return etag or None


def ensure_aio_payload(payload: Dict[str, object]) -> Dict[str, object]:
    if not isinstance(payload, dict) or payload.get("spec") != AIO_SPEC:
        raise RuntimeError("Expected an agent-interpretable-object payload.")
    return payload


def col_index_to_label(index: int) -> str:
    if index < 1:
        raise ValueError("Column index must be positive.")
    label = []
    value = index
    while value > 0:
        value, remainder = divmod(value - 1, 26)
        label.append(chr(65 + remainder))
    return "".join(reversed(label))


def label_to_col_index(label: str) -> int:
    value = 0
    for char in label.upper():
        if not ("A" <= char <= "Z"):
            raise ValueError(f"Invalid column label `{label}`.")
        value = value * 26 + (ord(char) - 64)
    return value


def cell_ref(row: int, col: int) -> str:
    return f"{col_index_to_label(col)}{row}"


def parse_cell_ref(ref: str) -> Tuple[int, int]:
    match = re.fullmatch(r"([A-Za-z]+)(\d+)", ref or "")
    if not match:
        raise ValueError(f"Invalid cell reference `{ref}`.")
    return int(match.group(2)), label_to_col_index(match.group(1))


def is_numeric_value(value: str) -> bool:
    if not isinstance(value, str):
        return False
    trimmed = value.strip()
    if not trimmed:
        return False
    return re.fullmatch(r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)", trimmed) is not None


def coerce_boolean_text(value: str) -> Optional[str]:
    if not isinstance(value, str):
        return None
    lowered = value.strip().lower()
    if lowered in {"true", "1", "yes"}:
        return "1"
    if lowered in {"false", "0", "no"}:
        return "0"
    return None


def safe_inline_text(parent: ET.Element, value: str) -> None:
    inline = ET.SubElement(parent, xlsx_tag("is"))
    text = ET.SubElement(inline, xlsx_tag("t"))
    text.text = value


def read_shared_strings(archive: zipfile.ZipFile) -> List[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    values: List[str] = []
    for item in root:
        if local_name(item.tag) != "si":
            continue
        text_parts = []
        for text_node in item.iter():
            if local_name(text_node.tag) == "t":
                text_parts.append(text_node.text or "")
        values.append("".join(text_parts))
    return values


def decode_xlsx_cell(cell: ET.Element, shared_strings: List[str]) -> Dict[str, object]:
    ref = cell.attrib.get("r", "")
    row, col = parse_cell_ref(ref)
    formula_node = cell.find(xlsx_tag("f"))
    value_node = cell.find(xlsx_tag("v"))
    cell_type = cell.attrib.get("t")
    formula = formula_node.text or "" if formula_node is not None and formula_node.text else None
    raw_value = value_node.text or "" if value_node is not None and value_node.text else ""
    if cell_type == "s":
        try:
            display_value = shared_strings[int(raw_value)]
        except (IndexError, ValueError):
            display_value = ""
        kind = "string"
    elif cell_type == "inlineStr":
        text_parts = []
        inline = cell.find(xlsx_tag("is"))
        if inline is not None:
            for node in inline.iter():
                if local_name(node.tag) == "t":
                    text_parts.append(node.text or "")
        display_value = "".join(text_parts)
        kind = "string"
    elif cell_type == "b":
        display_value = "TRUE" if raw_value == "1" else "FALSE"
        kind = "boolean"
    else:
        display_value = raw_value
        kind = "number" if raw_value and is_numeric_value(raw_value) else "string"
    return {
        "ref": ref,
        "row": row,
        "col": col,
        "formula": formula,
        "value": display_value,
        "display": display_value if formula is None else (raw_value or display_value),
        "kind": "formula" if formula else kind,
    }


def parse_xlsx_sheet(sheet_name: str, payload: bytes, shared_strings: List[str]) -> Dict[str, object]:
    root = ET.fromstring(payload)
    sheet_data = root.find(xlsx_tag("sheetData"))
    cells = []
    max_row = 0
    max_col = 0
    if sheet_data is not None:
        for row in sheet_data.findall(xlsx_tag("row")):
            for cell in row.findall(xlsx_tag("c")):
                decoded = decode_xlsx_cell(cell, shared_strings)
                cells.append(decoded)
                max_row = max(max_row, int(decoded["row"]))
                max_col = max(max_col, int(decoded["col"]))
    return {
        "name": sheet_name,
        "cells": cells,
        "rowCount": max_row,
        "colCount": max_col,
    }


def normalize_relationship_target(base_dir: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(base_dir, target))


def read_xlsx_document(path: str) -> Dict[str, object]:
    metadata = path_metadata(path)
    if not metadata["exists"]:
        return {
            "kind": "spreadsheet",
            "format": "xlsx",
            "path": path,
            **metadata,
            "warning": None,
            "sheets": [{"name": "Sheet1", "cells": [], "rowCount": 0, "colCount": 0}],
        }
    with zipfile.ZipFile(path, "r") as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets_by_id: Dict[str, str] = {}
        for rel in rels:
            if local_name(rel.tag) != "Relationship":
                continue
            rel_id = rel.attrib.get("Id")
            target = rel.attrib.get("Target")
            if rel_id and target:
                targets_by_id[rel_id] = normalize_relationship_target("xl", target)
        shared_strings = read_shared_strings(archive)
        sheets: List[Dict[str, object]] = []
        sheets_parent = workbook.find(xlsx_tag("sheets"))
        if sheets_parent is not None:
            for sheet in sheets_parent.findall(xlsx_tag("sheet")):
                rel_id = sheet.attrib.get(f"{{{DOC_REL_NS}}}id", "")
                target = targets_by_id.get(rel_id)
                if not target:
                    continue
                if target not in archive.namelist():
                    continue
                sheets.append(
                    parse_xlsx_sheet(
                        sheet.attrib.get("name", f"Sheet{len(sheets) + 1}"),
                        archive.read(target),
                        shared_strings,
                    )
                )
        if not sheets:
            sheets = [{"name": "Sheet1", "cells": [], "rowCount": 0, "colCount": 0}]
        return {
            "kind": "spreadsheet",
            "format": "xlsx",
            "path": path,
            **metadata,
            "warning": None,
            "sheets": sheets,
        }


def read_csv_document(path: str) -> Dict[str, object]:
    metadata = path_metadata(path)
    if not metadata["exists"]:
        return {
            "kind": "spreadsheet",
            "format": "csv",
            "path": path,
            **metadata,
            "warning": None,
            "sheets": [{"name": "Sheet1", "cells": [], "rowCount": 0, "colCount": 0}],
        }
    with open(path, "r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        rows = list(reader)
    cells = []
    max_col = 0
    for row_index, row in enumerate(rows, start=1):
        max_col = max(max_col, len(row))
        for col_index, value in enumerate(row, start=1):
            if value == "":
                continue
            cells.append(
                {
                    "ref": cell_ref(row_index, col_index),
                    "row": row_index,
                    "col": col_index,
                    "formula": value[1:] if value.startswith("=") else None,
                    "value": value,
                    "display": value,
                    "kind": "formula" if value.startswith("=") else "string",
                }
            )
    return {
        "kind": "spreadsheet",
        "format": "csv",
        "path": path,
        **metadata,
        "warning": None,
        "sheets": [{"name": "Sheet1", "cells": cells, "rowCount": len(rows), "colCount": max_col}],
    }


def legacy_minimal_xlsx(path: str) -> bool:
    if not os.path.exists(path):
        return False
    try:
        with zipfile.ZipFile(path, "r") as archive:
            entries = set(archive.namelist())
    except (OSError, zipfile.BadZipFile):
        return False
    required_minimal = {
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
    }
    if not required_minimal.issubset(entries):
        return False
    has_sheet = any(name.startswith("xl/worksheets/") and name.endswith(".xml") for name in entries)
    if not has_sheet:
        return False
    # Older Entropic-generated workbooks omitted these standard parts, which ONLYOFFICE
    # rejects even though the file is readable by the lightweight inspector.
    missing_standard_parts = {
        "docProps/app.xml",
        "docProps/core.xml",
        "xl/styles.xml",
        "xl/theme/theme1.xml",
    }
    return bool(entries.isdisjoint(missing_standard_parts))


def normalize_sheet_payload(sheet: Dict[str, object]) -> Dict[str, object]:
    name = str(sheet.get("name") or "Sheet1").strip() or "Sheet1"
    cleaned_cells = []
    max_row = 0
    max_col = 0
    for raw_cell in sheet.get("cells") or []:
        if not isinstance(raw_cell, dict):
            continue
        raw_ref = str(raw_cell.get("ref") or "").strip().upper()
        if raw_ref:
            row, col = parse_cell_ref(raw_ref)
            ref = raw_ref
        else:
            row = int(raw_cell.get("row") or 0)
            col = int(raw_cell.get("col") or 0)
            if row <= 0 or col <= 0:
                continue
            ref = cell_ref(row, col)
        formula = str(raw_cell.get("formula") or "").strip()
        if formula.startswith("="):
            formula = formula[1:]
        value = str(raw_cell.get("value") or "")
        if formula:
            cleaned_cells.append(
                {
                    "ref": ref,
                    "row": row,
                    "col": col,
                    "formula": formula,
                    "value": value,
                    "display": str(raw_cell.get("display") or value),
                    "kind": "formula",
                }
            )
        elif value != "":
            kind = str(raw_cell.get("kind") or "")
            if kind not in {"number", "boolean", "string"}:
                if is_numeric_value(value):
                    kind = "number"
                elif coerce_boolean_text(value) is not None:
                    kind = "boolean"
                else:
                    kind = "string"
            cleaned_cells.append(
                {
                    "ref": ref,
                    "row": row,
                    "col": col,
                    "formula": None,
                    "value": value,
                    "display": str(raw_cell.get("display") or value),
                    "kind": kind,
                }
            )
        max_row = max(max_row, row)
        max_col = max(max_col, col)
    cleaned_cells.sort(key=lambda cell: (int(cell["row"]), int(cell["col"])))
    return {"name": name, "cells": cleaned_cells, "rowCount": max_row, "colCount": max_col}


def openpyxl_available() -> bool:
    return Workbook is not None and load_workbook is not None


def coerce_openpyxl_value(cell: Dict[str, object]):
    formula = str(cell.get("formula") or "").strip()
    if formula:
        return f"={formula}"
    value = str(cell.get("value") or "")
    kind = str(cell.get("kind") or "string")
    if kind == "boolean":
        return coerce_boolean_text(value) == "1"
    if kind == "number" and is_numeric_value(value):
        trimmed = value.strip()
        if re.fullmatch(r"[+-]?\d+", trimmed):
            try:
                return int(trimmed)
            except ValueError:
                return trimmed
        try:
            return float(trimmed)
        except ValueError:
            return trimmed
    return value


def build_sheet_root(sheet: Dict[str, object], existing_bytes: Optional[bytes]) -> bytes:
    existing_rows: Dict[int, ET.Element] = {}
    existing_cells: Dict[str, ET.Element] = {}
    if existing_bytes:
        root = ET.fromstring(existing_bytes)
    else:
        root = ET.Element(xlsx_tag("worksheet"))
        ET.SubElement(root, xlsx_tag("sheetData"))
    sheet_data = root.find(xlsx_tag("sheetData"))
    if sheet_data is None:
        sheet_data = ET.SubElement(root, xlsx_tag("sheetData"))
    for row in sheet_data.findall(xlsx_tag("row")):
        row_index = int(row.attrib.get("r") or 0)
        if row_index > 0:
            existing_rows[row_index] = row
        for cell in row.findall(xlsx_tag("c")):
            cell_key = cell.attrib.get("r")
            if cell_key:
                existing_cells[cell_key] = cell
    for child in list(sheet_data):
        sheet_data.remove(child)

    rows_by_index: Dict[int, List[Dict[str, object]]] = {}
    for cell in sheet["cells"]:
        rows_by_index.setdefault(int(cell["row"]), []).append(cell)

    for row_index in sorted(rows_by_index):
        row_element = ET.Element(xlsx_tag("row"))
        if row_index in existing_rows:
            row_element.attrib.update(existing_rows[row_index].attrib)
        row_element.attrib["r"] = str(row_index)
        for cell in rows_by_index[row_index]:
            ref = str(cell["ref"])
            existing_cell = existing_cells.get(ref)
            cell_element = ET.Element(xlsx_tag("c"))
            if existing_cell is not None:
                for key, value in existing_cell.attrib.items():
                    if key not in {"r", "t"}:
                        cell_element.attrib[key] = value
            cell_element.attrib["r"] = ref
            formula = cell.get("formula")
            value = str(cell.get("value") or "")
            if formula:
                ET.SubElement(cell_element, xlsx_tag("f")).text = str(formula)
                cached = str(cell.get("display") or value)
                if cached != "":
                    boolean_value = coerce_boolean_text(cached)
                    if boolean_value is not None:
                        cell_element.attrib["t"] = "b"
                        ET.SubElement(cell_element, xlsx_tag("v")).text = boolean_value
                    elif is_numeric_value(cached):
                        ET.SubElement(cell_element, xlsx_tag("v")).text = cached.strip()
                    else:
                        cell_element.attrib["t"] = "str"
                        ET.SubElement(cell_element, xlsx_tag("v")).text = cached
            else:
                kind = str(cell.get("kind") or "string")
                if kind == "boolean":
                    boolean_value = coerce_boolean_text(value) or "0"
                    cell_element.attrib["t"] = "b"
                    ET.SubElement(cell_element, xlsx_tag("v")).text = boolean_value
                elif kind == "number" and is_numeric_value(value):
                    ET.SubElement(cell_element, xlsx_tag("v")).text = value.strip()
                else:
                    cell_element.attrib["t"] = "inlineStr"
                    safe_inline_text(cell_element, value)
            row_element.append(cell_element)
        sheet_data.append(row_element)

    dimension_ref = "A1"
    if sheet["cells"]:
        max_row = max(int(cell["row"]) for cell in sheet["cells"])
        max_col = max(int(cell["col"]) for cell in sheet["cells"])
        dimension_ref = f"A1:{cell_ref(max_row, max_col)}"
    dimension = root.find(xlsx_tag("dimension"))
    if dimension is None:
        dimension = ET.Element(xlsx_tag("dimension"))
        root.insert(0, dimension)
    dimension.attrib["ref"] = dimension_ref
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def minimal_xlsx_entries(sheets: List[Dict[str, object]]) -> Dict[str, bytes]:
    workbook = ET.Element(xlsx_tag("workbook"))
    sheets_root = ET.SubElement(workbook, xlsx_tag("sheets"))
    for index, sheet in enumerate(sheets, start=1):
        sheet_el = ET.SubElement(sheets_root, xlsx_tag("sheet"))
        sheet_el.set("name", str(sheet["name"]))
        sheet_el.set("sheetId", str(index))
        sheet_el.set(f"{{{DOC_REL_NS}}}id", f"rId{index}")
    calc_pr = ET.SubElement(workbook, xlsx_tag("calcPr"))
    calc_pr.set("fullCalcOnLoad", "1")
    calc_pr.set("calcMode", "auto")

    rels = ET.Element(f"{{{PKG_REL_NS}}}Relationships")
    for index in range(1, len(sheets) + 1):
        relationship = ET.SubElement(rels, f"{{{PKG_REL_NS}}}Relationship")
        relationship.set("Id", f"rId{index}")
        relationship.set(
            "Type",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
        )
        relationship.set("Target", f"worksheets/sheet{index}.xml")

    content_types = ET.Element(f"{{{CONTENT_TYPES_NS}}}Types")
    default_rels = ET.SubElement(content_types, f"{{{CONTENT_TYPES_NS}}}Default")
    default_rels.set("Extension", "rels")
    default_rels.set("ContentType", "application/vnd.openxmlformats-package.relationships+xml")
    default_xml = ET.SubElement(content_types, f"{{{CONTENT_TYPES_NS}}}Default")
    default_xml.set("Extension", "xml")
    default_xml.set("ContentType", "application/xml")
    workbook_override = ET.SubElement(content_types, f"{{{CONTENT_TYPES_NS}}}Override")
    workbook_override.set("PartName", "/xl/workbook.xml")
    workbook_override.set(
        "ContentType",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    )
    for index in range(1, len(sheets) + 1):
        sheet_override = ET.SubElement(content_types, f"{{{CONTENT_TYPES_NS}}}Override")
        sheet_override.set("PartName", f"/xl/worksheets/sheet{index}.xml")
        sheet_override.set(
            "ContentType",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        )

    root_rels = ET.Element(f"{{{PKG_REL_NS}}}Relationships")
    workbook_rel = ET.SubElement(root_rels, f"{{{PKG_REL_NS}}}Relationship")
    workbook_rel.set("Id", "rId1")
    workbook_rel.set(
        "Type",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    )
    workbook_rel.set("Target", "xl/workbook.xml")

    entries = {
        "[Content_Types].xml": ET.tostring(content_types, encoding="utf-8", xml_declaration=True),
        "_rels/.rels": ET.tostring(root_rels, encoding="utf-8", xml_declaration=True),
        "xl/workbook.xml": ET.tostring(workbook, encoding="utf-8", xml_declaration=True),
        "xl/_rels/workbook.xml.rels": ET.tostring(rels, encoding="utf-8", xml_declaration=True),
    }
    for index, sheet in enumerate(sheets, start=1):
        entries[f"xl/worksheets/sheet{index}.xml"] = build_sheet_root(sheet, None)
    return entries


def write_xlsx_document(path: str, sheets: List[Dict[str, object]], expected_etag: Optional[str]) -> Dict[str, object]:
    assert_expected_etag(path, expected_etag)
    normalized_sheets = [normalize_sheet_payload(sheet) for sheet in sheets] or [
        {"name": "Sheet1", "cells": [], "rowCount": 0, "colCount": 0}
    ]

    if openpyxl_available():
        if os.path.exists(path):
            workbook = load_workbook(path)
            if len(workbook.worksheets) != len(normalized_sheets):
                raise RuntimeError(
                    "Adding or removing worksheets is not supported yet. Edit the existing sheets or create a new workbook."
                )
        else:
            workbook = Workbook()
            while len(workbook.worksheets) < len(normalized_sheets):
                workbook.create_sheet()
            while len(workbook.worksheets) > len(normalized_sheets):
                workbook.remove(workbook.worksheets[-1])

        for index, sheet in enumerate(normalized_sheets):
            worksheet = workbook.worksheets[index]
            worksheet.title = str(sheet["name"])
            max_row = max(worksheet.max_row or 0, int(sheet.get("rowCount") or 0))
            max_col = max(worksheet.max_column or 0, int(sheet.get("colCount") or 0))
            for row in range(1, max_row + 1):
                for col in range(1, max_col + 1):
                    worksheet.cell(row=row, column=col).value = None
            for cell in sheet["cells"]:
                worksheet[str(cell["ref"])].value = coerce_openpyxl_value(cell)

        temp_fd, temp_path = tempfile.mkstemp(prefix=".entropic-office-", dir=posixpath.dirname(path))
        os.close(temp_fd)
        try:
            workbook.save(temp_path)
            os.replace(temp_path, path)
        finally:
            try:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
            except OSError:
                pass
        return read_xlsx_document(path)

    if os.path.exists(path):
        with zipfile.ZipFile(path, "r") as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        workbook_root = ET.fromstring(entries["xl/workbook.xml"])
        rels_root = ET.fromstring(entries["xl/_rels/workbook.xml.rels"])
        workbook_sheets = workbook_root.find(xlsx_tag("sheets"))
        if workbook_sheets is None:
            raise RuntimeError("The workbook is missing sheet metadata.")
        existing_names = workbook_sheets.findall(xlsx_tag("sheet"))
        if len(existing_names) != len(normalized_sheets):
            raise RuntimeError(
                "Adding or removing worksheets is not supported yet. Edit the existing sheets or create a new workbook."
            )
        rel_targets: Dict[str, str] = {}
        for rel in rels_root:
            if local_name(rel.tag) != "Relationship":
                continue
            rel_id = rel.attrib.get("Id")
            target = rel.attrib.get("Target")
            if rel_id and target:
                rel_targets[rel_id] = normalize_relationship_target("xl", target)
        for index, sheet in enumerate(existing_names):
            rel_id = sheet.attrib.get(f"{{{DOC_REL_NS}}}id", "")
            target = rel_targets.get(rel_id)
            if not target:
                continue
            sheet.set("name", str(normalized_sheets[index]["name"]))
            entries[target] = build_sheet_root(normalized_sheets[index], entries.get(target))
        entries["xl/workbook.xml"] = ET.tostring(workbook_root, encoding="utf-8", xml_declaration=True)
    else:
        entries = minimal_xlsx_entries(normalized_sheets)

    temp_fd, temp_path = tempfile.mkstemp(prefix=".entropic-office-", dir=posixpath.dirname(path))
    os.close(temp_fd)
    try:
        with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(entries):
                archive.writestr(name, entries[name])
        os.replace(temp_path, path)
    finally:
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except OSError:
            pass
    return read_xlsx_document(path)


def write_csv_document(path: str, sheets: List[Dict[str, object]], expected_etag: Optional[str]) -> Dict[str, object]:
    assert_expected_etag(path, expected_etag)
    normalized_sheet = normalize_sheet_payload(sheets[0] if sheets else {"name": "Sheet1", "cells": []})
    max_row = max((int(cell["row"]) for cell in normalized_sheet["cells"]), default=0)
    max_col = max((int(cell["col"]) for cell in normalized_sheet["cells"]), default=0)
    grid = [["" for _ in range(max_col)] for _ in range(max_row)]
    for cell in normalized_sheet["cells"]:
        row = int(cell["row"]) - 1
        col = int(cell["col"]) - 1
        if row < 0 or col < 0:
            continue
        if cell.get("formula"):
            grid[row][col] = f"={cell['formula']}"
        else:
            grid[row][col] = str(cell.get("value") or "")
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for row in grid:
        writer.writerow(row)
    atomic_write_text(path, buffer.getvalue())
    return read_csv_document(path)


def read_docx_document(path: str) -> Dict[str, object]:
    metadata = path_metadata(path)
    if not metadata["exists"]:
        return {
            "kind": "document",
            "format": "docx",
            "path": path,
            **metadata,
            "warning": "Rich formatting and tables are preserved when possible, but the editor currently focuses on paragraph text.",
            "paragraphs": [],
        }
    with zipfile.ZipFile(path, "r") as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    body = root.find(docx_tag("body"))
    paragraphs: List[str] = []
    if body is not None:
        for child in body:
            if local_name(child.tag) != "p":
                continue
            text_parts = []
            for node in child.iter():
                if local_name(node.tag) == "t":
                    text_parts.append(node.text or "")
            paragraphs.append("".join(text_parts))
    return {
        "kind": "document",
        "format": "docx",
        "path": path,
        **metadata,
        "warning": "Rich formatting and tables are preserved when possible, but the editor currently focuses on paragraph text.",
        "paragraphs": paragraphs,
    }


def build_doc_paragraph(text: str) -> ET.Element:
    paragraph = ET.Element(docx_tag("p"))
    run = ET.SubElement(paragraph, docx_tag("r"))
    text_node = ET.SubElement(run, docx_tag("t"))
    text_node.text = text
    return paragraph


def minimal_docx_entries(paragraphs: List[str]) -> Dict[str, bytes]:
    document = ET.Element(docx_tag("document"))
    body = ET.SubElement(document, docx_tag("body"))
    for paragraph in paragraphs:
        body.append(build_doc_paragraph(paragraph))
    ET.SubElement(body, docx_tag("sectPr"))

    content_types = ET.Element(f"{{{CONTENT_TYPES_NS}}}Types")
    default_rels = ET.SubElement(content_types, f"{{{CONTENT_TYPES_NS}}}Default")
    default_rels.set("Extension", "rels")
    default_rels.set("ContentType", "application/vnd.openxmlformats-package.relationships+xml")
    default_xml = ET.SubElement(content_types, f"{{{CONTENT_TYPES_NS}}}Default")
    default_xml.set("Extension", "xml")
    default_xml.set("ContentType", "application/xml")
    document_override = ET.SubElement(content_types, f"{{{CONTENT_TYPES_NS}}}Override")
    document_override.set("PartName", "/word/document.xml")
    document_override.set(
        "ContentType",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    )

    rels = ET.Element(f"{{{PKG_REL_NS}}}Relationships")
    rel = ET.SubElement(rels, f"{{{PKG_REL_NS}}}Relationship")
    rel.set("Id", "rId1")
    rel.set(
        "Type",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    )
    rel.set("Target", "word/document.xml")

    return {
        "[Content_Types].xml": ET.tostring(content_types, encoding="utf-8", xml_declaration=True),
        "_rels/.rels": ET.tostring(rels, encoding="utf-8", xml_declaration=True),
        "word/document.xml": ET.tostring(document, encoding="utf-8", xml_declaration=True),
    }


def write_docx_document(path: str, paragraphs: List[str], expected_etag: Optional[str]) -> Dict[str, object]:
    assert_expected_etag(path, expected_etag)
    normalized_paragraphs = [str(value) for value in paragraphs]
    if os.path.exists(path):
        with zipfile.ZipFile(path, "r") as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        root = ET.fromstring(entries["word/document.xml"])
        body = root.find(docx_tag("body"))
        if body is None:
            body = ET.SubElement(root, docx_tag("body"))
        section = None
        if len(body) > 0 and local_name(body[-1].tag) == "sectPr":
            section = body[-1]
        template_children = [child for child in list(body) if child is not section]
        body[:] = []
        remaining = list(normalized_paragraphs)
        for child in template_children:
            if local_name(child.tag) == "p":
                if remaining:
                    body.append(build_doc_paragraph(remaining.pop(0)))
            else:
                body.append(child)
        for paragraph in remaining:
            body.append(build_doc_paragraph(paragraph))
        if section is None:
            section = ET.Element(docx_tag("sectPr"))
        body.append(section)
        entries["word/document.xml"] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    else:
        entries = minimal_docx_entries(normalized_paragraphs)

    temp_fd, temp_path = tempfile.mkstemp(prefix=".entropic-office-", dir=posixpath.dirname(path))
    os.close(temp_fd)
    try:
        with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(entries):
                archive.writestr(name, entries[name])
        os.replace(temp_path, path)
    finally:
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except OSError:
            pass
    return read_docx_document(path)


def spreadsheet_document_to_aio(document: Dict[str, object]) -> Dict[str, object]:
    workbook_id = f"workbook:{slugify_identifier(basename_without_extension(str(document.get('path') or 'workbook')), 'workbook')}"
    worksheets = []
    for index, sheet in enumerate(document.get("sheets") or [], start=1):
        if not isinstance(sheet, dict):
            continue
        sheet_name = str(sheet.get("name") or f"Sheet{index}").strip() or f"Sheet{index}"
        worksheet_slug = slugify_identifier(sheet_name, f"sheet{index}")
        cells = []
        for raw_cell in sheet.get("cells") or []:
            if not isinstance(raw_cell, dict):
                continue
            ref = str(raw_cell.get("ref") or "").strip().upper()
            row = int(raw_cell.get("row") or 0)
            col = int(raw_cell.get("col") or 0)
            if not ref:
                if row <= 0 or col <= 0:
                    continue
                ref = cell_ref(row, col)
            elif row <= 0 or col <= 0:
                row, col = parse_cell_ref(ref)
            formula = str(raw_cell.get("formula") or "").strip()
            value = str(raw_cell.get("value") or "")
            display = str(raw_cell.get("display") or value)
            kind = str(raw_cell.get("kind") or ("formula" if formula else "string"))
            entry = {
                "id": f"cell:{worksheet_slug}:{ref}",
                "kind": "cell",
                "ref": ref,
                "row": row,
                "col": col,
            }
            if formula:
                entry["formula"] = formula
                if value:
                    entry["value"] = value
                if display and display != value:
                    entry["display"] = display
            else:
                entry["value"] = value
                entry["value_kind"] = kind
                if display and display != value:
                    entry["display"] = display
            cells.append(entry)
        worksheets.append(
            {
                "id": f"worksheet:{worksheet_slug}",
                "kind": "worksheet",
                "name": sheet_name,
                "extent": {
                    "rows": int(sheet.get("rowCount") or 0),
                    "cols": int(sheet.get("colCount") or 0),
                },
                "cells": cells,
            }
        )
    return aio_envelope(
        "spreadsheet",
        document,
        {
            "id": workbook_id,
            "kind": "workbook",
            "worksheets": worksheets,
        },
        capability_set="current_entropic_office",
    )


def document_document_to_aio(document: Dict[str, object]) -> Dict[str, object]:
    document_id = f"document:{slugify_identifier(basename_without_extension(str(document.get('path') or 'document')), 'document')}"
    blocks = []
    for index, paragraph in enumerate(document.get("paragraphs") or [], start=1):
        blocks.append(
            {
                "id": f"block:{index}",
                "kind": "paragraph",
                "index": index,
                "text": str(paragraph),
            }
        )
    return aio_envelope(
        "document",
        document,
        {
            "id": document_id,
            "kind": "document",
            "blocks": blocks,
        },
        capability_set="current_entropic_office",
    )


def presentation_document_to_aio(path: str) -> Dict[str, object]:
    metadata = path_metadata(path)
    document = {
        "kind": "presentation",
        "format": "pptx",
        "path": path,
        **metadata,
        "warning": "Structured presentation automation is not implemented yet. Use ONLYOFFICE for direct visual editing.",
    }
    deck_id = f"deck:{slugify_identifier(basename_without_extension(path), 'deck')}"
    return aio_envelope(
        "presentation",
        document,
        {
            "id": deck_id,
            "kind": "deck",
            "slides": [],
        },
        capability_set="current_entropic_office",
    )


def document_to_aio(document: Dict[str, object]) -> Dict[str, object]:
    kind = str(document.get("kind") or "").strip()
    if kind == "spreadsheet":
        return spreadsheet_document_to_aio(document)
    if kind == "document":
        return document_document_to_aio(document)
    raise RuntimeError(f"Unsupported AIO conversion for `{kind or 'unknown'}`.")


def attach_aio_projection(document: Dict[str, object]) -> Dict[str, object]:
    result = dict(document)
    result["aio"] = document_to_aio(document)
    return result


def spreadsheet_payload_from_aio(payload: Dict[str, object]) -> Dict[str, object]:
    ensure_aio_payload(payload)
    if str(payload.get("kind") or "").strip() != "spreadsheet":
        raise RuntimeError("Expected a spreadsheet AIO object.")
    object_payload = payload.get("object")
    if not isinstance(object_payload, dict):
        raise RuntimeError("AIO spreadsheet object is missing.")
    worksheets = object_payload.get("worksheets")
    if not isinstance(worksheets, list):
        raise RuntimeError("AIO spreadsheet object must contain `worksheets`.")
    sheets = []
    for index, worksheet in enumerate(worksheets, start=1):
        if not isinstance(worksheet, dict):
            continue
        name = str(worksheet.get("name") or f"Sheet{index}").strip() or f"Sheet{index}"
        cells = []
        for raw_cell in worksheet.get("cells") or []:
            if not isinstance(raw_cell, dict):
                continue
            ref = str(raw_cell.get("ref") or "").strip().upper()
            row = int(raw_cell.get("row") or 0)
            col = int(raw_cell.get("col") or 0)
            if not ref:
                if row <= 0 or col <= 0:
                    continue
                ref = cell_ref(row, col)
            elif row <= 0 or col <= 0:
                row, col = parse_cell_ref(ref)
            formula = str(raw_cell.get("formula") or "").strip()
            value = str(raw_cell.get("value") or "")
            display = str(raw_cell.get("display") or value)
            value_kind = str(raw_cell.get("value_kind") or raw_cell.get("kind") or "").strip()
            cell_entry = {
                "ref": ref,
                "row": row,
                "col": col,
                "display": display,
            }
            if formula:
                cell_entry["formula"] = formula
                cell_entry["value"] = value
            else:
                cell_entry["value"] = value
                if value_kind:
                    cell_entry["kind"] = value_kind
            cells.append(cell_entry)
        sheets.append({"name": name, "cells": cells})
    return {
        "expectedEtag": extract_aio_source_etag(payload),
        "sheets": sheets,
    }


def document_payload_from_aio(payload: Dict[str, object]) -> Dict[str, object]:
    ensure_aio_payload(payload)
    if str(payload.get("kind") or "").strip() != "document":
        raise RuntimeError("Expected a document AIO object.")
    object_payload = payload.get("object")
    if not isinstance(object_payload, dict):
        raise RuntimeError("AIO document object is missing.")
    blocks = object_payload.get("blocks")
    if not isinstance(blocks, list):
        raise RuntimeError("AIO document object must contain `blocks`.")
    paragraphs: List[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_kind = str(block.get("kind") or "paragraph").strip()
        if block_kind == "list":
            for item in block.get("items") or []:
                if isinstance(item, dict):
                    paragraphs.append(str(item.get("text") or ""))
                else:
                    paragraphs.append(str(item))
            continue
        paragraphs.append(str(block.get("text") or ""))
    return {
        "expectedEtag": extract_aio_source_etag(payload),
        "paragraphs": paragraphs,
    }


def inspect_aio(path: str) -> Dict[str, object]:
    extension = split_extension(path)
    if extension == ".csv":
        return spreadsheet_document_to_aio(read_csv_document(path))
    if extension == ".xlsx":
        return spreadsheet_document_to_aio(read_xlsx_document(path))
    if extension == ".docx":
        return document_document_to_aio(read_docx_document(path))
    if extension == ".pptx":
        return presentation_document_to_aio(path)
    if extension == ".xls":
        raise RuntimeError("Legacy .xls files are not supported yet. Save or convert the workbook as .xlsx.")
    raise RuntimeError("Unsupported format for AIO inspection.")


def apply_aio(path: str, payload: Dict[str, object]) -> Dict[str, object]:
    ensure_aio_payload(payload)
    payload_source_path = extract_aio_source_path(payload)
    if payload_source_path:
        try:
            normalized_payload_source_path = resolve_workspace_path(payload_source_path)
        except ValueError as error:
            raise RuntimeError(str(error))
        if posixpath.normpath(normalized_payload_source_path) != posixpath.normpath(path):
            raise RuntimeError("AIO payload source path does not match the requested path.")
    extension = split_extension(path)
    if extension in {".csv", ".xlsx"}:
        return save_spreadsheet(path, spreadsheet_payload_from_aio(payload))
    if extension == ".docx":
        return save_document(path, document_payload_from_aio(payload))
    if extension == ".pptx":
        raise RuntimeError("Structured .pptx AIO writes are not implemented yet.")
    if extension == ".xls":
        raise RuntimeError("Legacy .xls files are not supported yet. Save or convert the workbook as .xlsx.")
    raise RuntimeError("Unsupported format for AIO application.")


def inspect_spreadsheet(path: str) -> Dict[str, object]:
    extension = split_extension(path)
    if extension == ".csv":
        return attach_aio_projection(read_csv_document(path))
    if extension == ".xlsx":
        return attach_aio_projection(read_xlsx_document(path))
    if extension == ".xls":
        raise RuntimeError("Legacy .xls files are not supported yet. Save or convert the workbook as .xlsx.")
    raise RuntimeError("Unsupported spreadsheet format. Use .xlsx or .csv.")


def save_spreadsheet(path: str, payload: Dict[str, object]) -> Dict[str, object]:
    if isinstance(payload, dict) and payload.get("spec") == AIO_SPEC:
        payload = spreadsheet_payload_from_aio(payload)
    extension = split_extension(path)
    sheets = payload.get("sheets") or []
    expected_etag = payload.get("expectedEtag")
    if extension == ".csv":
        return attach_aio_projection(write_csv_document(path, sheets, expected_etag))
    if extension == ".xlsx":
        return attach_aio_projection(write_xlsx_document(path, sheets, expected_etag))
    if extension == ".xls":
        raise RuntimeError("Legacy .xls files are not supported yet. Save or convert the workbook as .xlsx.")
    raise RuntimeError("Unsupported spreadsheet format. Use .xlsx or .csv.")


def normalize_spreadsheet(path: str) -> Dict[str, object]:
    extension = split_extension(path)
    if extension == ".csv":
        return attach_aio_projection(read_csv_document(path))
    if extension == ".xlsx":
        document = read_xlsx_document(path)
        if document.get("exists") and legacy_minimal_xlsx(path):
            return attach_aio_projection(write_xlsx_document(path, document.get("sheets") or [], document.get("etag")))
        return attach_aio_projection(document)
    if extension == ".xls":
        raise RuntimeError("Legacy .xls files are not supported yet. Save or convert the workbook as .xlsx.")
    raise RuntimeError("Unsupported spreadsheet format. Use .xlsx or .csv.")


def inspect_document(path: str) -> Dict[str, object]:
    extension = split_extension(path)
    if extension == ".docx":
        return attach_aio_projection(read_docx_document(path))
    raise RuntimeError("Unsupported document format. Use .docx.")


def save_document(path: str, payload: Dict[str, object]) -> Dict[str, object]:
    if isinstance(payload, dict) and payload.get("spec") == AIO_SPEC:
        payload = document_payload_from_aio(payload)
    extension = split_extension(path)
    paragraphs = payload.get("paragraphs") or []
    expected_etag = payload.get("expectedEtag")
    if extension == ".docx":
        return attach_aio_projection(write_docx_document(path, [str(value) for value in paragraphs], expected_etag))
    raise RuntimeError("Unsupported document format. Use .docx.")


def todo_spreadsheet_payload(items: Iterable[str]) -> Dict[str, object]:
    rows = [
        {"ref": "A1", "row": 1, "col": 1, "value": "Task", "kind": "string"},
        {"ref": "B1", "row": 1, "col": 2, "value": "Status", "kind": "string"},
    ]
    for index, item in enumerate(items, start=2):
        rows.append({"ref": cell_ref(index, 1), "row": index, "col": 1, "value": str(item), "kind": "string"})
        rows.append({"ref": cell_ref(index, 2), "row": index, "col": 2, "value": "Todo", "kind": "string"})
    return {"sheets": [{"name": "Sheet1", "cells": rows}]}


def blank_spreadsheet_payload() -> Dict[str, object]:
    return {"sheets": [{"name": "Sheet1", "cells": []}]}


def blank_document_payload(lines: Iterable[str]) -> Dict[str, object]:
    return {"paragraphs": [str(value) for value in lines]}


def cli_usage() -> str:
    return """Usage:
  entropic-office api inspect-spreadsheet <path>
  entropic-office api normalize-spreadsheet <path>
  entropic-office api save-spreadsheet <path>
  entropic-office api inspect-document <path>
  entropic-office api save-document <path>
  entropic-office api inspect-aio <path>
  entropic-office api apply-aio <path>
  entropic-office spreadsheet new <path>
  entropic-office spreadsheet todo <path> <item> [<item> ...]
  entropic-office document new <path>
  entropic-office document lines <path> <line> [<line> ...]
"""


def emit_json(payload: Dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")


def run_api(argv: List[str]) -> Dict[str, object]:
    if len(argv) < 4:
        raise RuntimeError(cli_usage().strip())
    command = argv[2]
    path = resolve_workspace_path(argv[3])
    if command == "inspect-spreadsheet":
        return inspect_spreadsheet(path)
    if command == "normalize-spreadsheet":
        return normalize_spreadsheet(path)
    if command == "save-spreadsheet":
        payload = json.load(sys.stdin)
        return save_spreadsheet(path, payload)
    if command == "inspect-document":
        return inspect_document(path)
    if command == "save-document":
        payload = json.load(sys.stdin)
        return save_document(path, payload)
    if command == "inspect-aio":
        return inspect_aio(path)
    if command == "apply-aio":
        payload = json.load(sys.stdin)
        return apply_aio(path, payload)
    raise RuntimeError(cli_usage().strip())


def run_cli(argv: List[str]) -> Dict[str, object]:
    if len(argv) < 4:
        raise RuntimeError(cli_usage().strip())
    category = argv[1]
    command = argv[2]
    path = resolve_workspace_path(argv[3])
    if category == "spreadsheet" and command == "new":
        return save_spreadsheet(path, blank_spreadsheet_payload())
    if category == "spreadsheet" and command == "todo":
        items = argv[4:] or [f"Item {index}" for index in range(1, 11)]
        return save_spreadsheet(path, todo_spreadsheet_payload(items))
    if category == "document" and command == "new":
        return save_document(path, blank_document_payload([]))
    if category == "document" and command == "lines":
        return save_document(path, blank_document_payload(argv[4:]))
    raise RuntimeError(cli_usage().strip())


def main() -> int:
    try:
        if len(sys.argv) < 2:
            raise RuntimeError(cli_usage().strip())
        if sys.argv[1] == "api":
            result = run_api(sys.argv)
        else:
            result = run_cli(sys.argv)
        emit_json({"ok": True, "result": result})
        return 0
    except Exception as error:
        emit_json({"ok": False, "error": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
