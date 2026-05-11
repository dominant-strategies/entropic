import pytest


def test_pptx_roundtrip_adds_slide_objects_and_notes(tmp_path, office):
    if not office.python_pptx_available():
        pytest.skip("python-pptx is required for structured .pptx apply tests")

    path = tmp_path / "pipeline-review.pptx"
    office.save_presentation(
        str(path),
        {
            "slides": [
                {
                    "id": "slide:1",
                    "title": "Pipeline Review",
                    "body": {"kind": "outline", "items": [{"text": "Current state", "level": 0}]},
                }
            ]
        },
    )

    aio = office.inspect_aio(str(path))
    aio["object"]["slides"].append(
        {
            "id": "slide:2",
            "kind": "slide",
            "title": "Next Steps",
            "body": {
                "kind": "outline",
                "items": [
                    {"text": "Finalize priorities", "level": 0},
                    {"text": "Assign owners", "level": 0},
                ],
            },
            "notes": ["Review these commitments in the weekly pipeline meeting."],
            "objects": [
                {
                    "id": "object:2:callout",
                    "kind": "text_box",
                    "text": "Target close: Q2",
                    "frame": {"x": 914400, "y": 1828800, "w": 3657600, "h": 914400},
                    "z_index": 1,
                }
            ],
        }
    )

    office.apply_aio(str(path), aio)
    reread = office.inspect_aio(str(path))
    slides = reread["object"]["slides"]
    added = next(slide for slide in slides if slide.get("title") == "Next Steps")

    assert len(slides) >= 2
    assert added["body"]["items"][1]["text"] == "Assign owners"
    assert "weekly pipeline meeting" in added["notes"][0]
    assert any(obj.get("text") == "Target close: Q2" for obj in added.get("objects") or [])
