def _find_block(blocks, kind):
    return next(block for block in blocks if block.get("kind") == kind)


def test_docx_roundtrip_preserves_structured_blocks_and_links(tmp_path, office):
    path = tmp_path / "project-plan.docx"
    office.save_document(
        str(path),
        {
            "blocks": [
                {"id": "seed-title", "kind": "heading", "level": 1, "text": "Seed"},
                {"id": "seed-body", "kind": "paragraph", "text": "Initial content"},
            ]
        },
    )

    aio = office.inspect_aio(str(path))
    aio["object"]["blocks"] = [
        {"id": "title", "kind": "heading", "level": 1, "text": "Project Plan"},
        {
            "id": "summary",
            "kind": "paragraph",
            "inlines": [
                {"kind": "text", "text": "Read the docs", "href": "https://example.com", "marks": ["strong"]}
            ],
        },
        {
            "id": "tasks",
            "kind": "list",
            "ordered": False,
            "items": [
                {"level": 0, "blocks": [{"kind": "paragraph", "text": "Confirm AIO workflow"}]},
                {"level": 0, "blocks": [{"kind": "paragraph", "text": "Open in ONLYOFFICE"}]},
            ],
        },
        {
            "id": "owners",
            "kind": "table",
            "rows": [
                {
                    "cells": [
                        {"blocks": [{"kind": "paragraph", "text": "Owner"}]},
                        {"blocks": [{"kind": "paragraph", "text": "Status"}]},
                    ]
                },
                {
                    "cells": [
                        {"blocks": [{"kind": "paragraph", "text": "Alan"}]},
                        {"blocks": [{"kind": "paragraph", "text": "Ready"}]},
                    ]
                },
            ],
        },
    ]

    office.apply_aio(str(path), aio)
    reread = office.inspect_aio(str(path))
    blocks = reread["object"]["blocks"]

    heading = _find_block(blocks, "heading")
    paragraph = _find_block(blocks, "paragraph")
    task_list = _find_block(blocks, "list")
    table = _find_block(blocks, "table")

    assert heading["text"] == "Project Plan"
    assert paragraph["inlines"][0]["href"] == "https://example.com"
    assert paragraph["inlines"][0]["marks"] == ["strong"]
    assert task_list["items"][1]["blocks"][0]["text"] == "Open in ONLYOFFICE"
    assert table["rows"][1]["cells"][1]["blocks"][0]["text"] == "Ready"
