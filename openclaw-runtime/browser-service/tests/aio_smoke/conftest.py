import sys
from pathlib import Path

import pytest


BROWSER_SERVICE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BROWSER_SERVICE_ROOT))

import office_tools  # noqa: E402


@pytest.fixture()
def office(tmp_path, monkeypatch):
    monkeypatch.setattr(office_tools, "WORKSPACE_ROOT", str(tmp_path))
    return office_tools
