#!/usr/bin/env python3

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_CAPTURE_PATH = Path.home() / ".local" / "share" / "ai.openclaw.entropic.dev" / "rnn-runtime" / "state" / "tool-bridge-captures.jsonl"
DEFAULT_RUNTIME_URL = "http://127.0.0.1:11445/v1/chat/completions"


def load_captures(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    captures: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if isinstance(payload, dict):
                captures.append(payload)
    return captures


def guess_format(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return "empty"
    lowered = text.lower()
    if "<tools." in lowered:
        return "tools_tag"
    if "<tool_call>" in lowered or "</tool_call>" in lowered:
        return "tool_call_xml"
    if lowered.startswith("tool:"):
        return "transcript_tool"
    if lowered.startswith("{"):
        return "json_object"
    if lowered.startswith("[[tool_call:"):
        return "inline_bracket_tool_call"
    if lowered.startswith("[["):
        return "double_bracket"
    match = re.match(r"^\s*([A-Za-z][A-Za-z0-9_:-]+)\s+\{", text)
    if match:
        return f"bare_call:{match.group(1)}"
    return "plain_text"


def summarize_record(record: Dict[str, Any], index: int) -> str:
    raw = str(record.get("rawContent") or "")
    cleaned = str(record.get("cleanedContent") or "")
    parsed = record.get("parsedToolCallNames") or []
    tool_names = record.get("toolNamesAvailable") or []
    lines = [
        f"[{index}] {record.get('capturedAt', '?')}  model={record.get('model', '?')}",
        f"  requestId={record.get('requestId', '?')}  finish={record.get('finishReason', '?')}  format={guess_format(raw)}",
        f"  latestUser={json.dumps(record.get('latestUserText', ''))}",
        f"  toolChoice requested={json.dumps(record.get('toolChoiceRequested'))} effective={json.dumps(record.get('toolChoiceEffective'))}",
        f"  availableTools={len(tool_names)} parsedToolCalls={json.dumps(parsed)}",
        f"  raw={json.dumps(raw)}",
        f"  cleaned={json.dumps(cleaned)}",
    ]
    return "\n".join(lines)


def filter_captures(captures: List[Dict[str, Any]], model: str | None) -> List[Dict[str, Any]]:
    if not model:
        return captures
    return [record for record in captures if str(record.get("model") or "") == model]


def latest_records(captures: List[Dict[str, Any]], count: int) -> List[Dict[str, Any]]:
    if count <= 0:
        return []
    return captures[-count:]


def replay_capture(record: Dict[str, Any], base_url: str) -> Dict[str, Any]:
    payload = {
        "model": record.get("model"),
        "messages": record.get("messages") or [],
        "temperature": record.get("temperature", 1.0),
        "top_p": record.get("topP", 0.7),
        "max_tokens": record.get("maxTokens", 500),
        "stream": False,
    }
    tools = record.get("tools")
    if isinstance(tools, list) and tools:
        payload["tools"] = tools
    tool_choice = record.get("toolChoiceEffective")
    if tool_choice is not None:
        payload["tool_choice"] = tool_choice
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        base_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read().decode("utf-8")
    return json.loads(body)


def print_replay_summary(response: Dict[str, Any]) -> None:
    choices = response.get("choices") if isinstance(response, dict) else None
    first_choice = choices[0] if isinstance(choices, list) and choices else {}
    message = first_choice.get("message") if isinstance(first_choice, dict) else {}
    finish_reason = first_choice.get("finish_reason") if isinstance(first_choice, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
    print(f"finish_reason={finish_reason}")
    print(f"content={json.dumps(content)}")
    print("tool_calls=" + json.dumps(tool_calls, indent=2, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect and replay managed local-model tool-bridge captures.")
    parser.add_argument(
        "--capture-path",
        default=os.environ.get("ENTROPIC_TOOL_BRIDGE_CAPTURE_PATH", str(DEFAULT_CAPTURE_PATH)),
        help="Path to tool-bridge-captures.jsonl",
    )
    parser.add_argument("--model", default=None, help="Filter by exact model name")
    subparsers = parser.add_subparsers(dest="command", required=False)

    latest_parser = subparsers.add_parser("latest", help="Show the latest captured tool-bridge runs")
    latest_parser.add_argument("--count", type=int, default=3, help="Number of latest records to show")

    replay_parser = subparsers.add_parser("replay", help="Replay the latest captured run against the managed runtime")
    replay_parser.add_argument("--index", type=int, default=1, help="1 = latest capture, 2 = one before that, etc.")
    replay_parser.add_argument("--base-url", default=DEFAULT_RUNTIME_URL, help="Managed runtime /v1/chat/completions URL")

    args = parser.parse_args()
    capture_path = Path(args.capture_path).expanduser()
    captures = filter_captures(load_captures(capture_path), args.model)
    if not captures:
        print(f"No captures found at {capture_path}", file=sys.stderr)
        return 1

    command = args.command or "latest"
    if command == "latest":
        records = latest_records(captures, args.count)
        start_index = len(captures) - len(records) + 1
        for offset, record in enumerate(records, start=start_index):
            print(summarize_record(record, offset))
            if offset != len(captures):
                print()
        return 0

    if command == "replay":
        index = max(1, args.index)
        if index > len(captures):
            print(f"Requested index {index} but only {len(captures)} captures are available", file=sys.stderr)
            return 1
        record = captures[-index]
        print(summarize_record(record, len(captures) - index + 1))
        print()
        try:
            response = replay_capture(record, args.base_url)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            print(f"Replay failed with HTTP {error.code}: {body}", file=sys.stderr)
            return 2
        except Exception as error:
            print(f"Replay failed: {error}", file=sys.stderr)
            return 2
        print("Replay response:")
        print_replay_summary(response)
        return 0

    parser.error(f"Unknown command: {command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
