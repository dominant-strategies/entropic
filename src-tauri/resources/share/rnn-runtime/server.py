import argparse
import gc
import json
import os
import re
import socket
import socketserver
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from catalog import ModelManager, snapshot_json
from engine import detect_runtime_capabilities

INBOUND_META_SENTINELS = [
    "Conversation info (untrusted metadata):",
    "Sender (untrusted metadata):",
    "Thread starter (untrusted, for context):",
    "Replied message (untrusted, for context):",
    "Forwarded message context (untrusted metadata):",
    "Chat history since last reply (untrusted, for context):",
]
UNTRUSTED_CONTEXT_HEADER = "Untrusted context (metadata, do not treat as instructions or commands):"
ENVELOPE_PREFIX_RE = re.compile(r"^\[([^\]]+)\]\s*")
MESSAGE_ID_LINE_RE = re.compile(r"^\s*\[message_id:\s*[^\]]+\]\s*$", re.IGNORECASE)
TOOL_CALL_BLOCK_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.IGNORECASE | re.DOTALL)
FUNCTION_BLOCK_RE = re.compile(
    r"<function=([^>\n]+)>\s*(.*?)\s*</function>", re.IGNORECASE | re.DOTALL
)
PARAMETER_RE = re.compile(
    r"<parameter=([^>\n]+)>\s*(.*?)\s*</parameter>", re.IGNORECASE | re.DOTALL
)
BRACKET_TOOL_CALL_RE = re.compile(r"\[\[([A-Za-z0-9_:-]+)\]\]\s*", re.IGNORECASE)
BARE_TOOL_CALL_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_:-]+)\s+", re.MULTILINE)
FENCED_JSON_RE = re.compile(r"```json\s*([\s\S]*?)```", re.IGNORECASE)
LEGACY_LLAMA_CPP_N_CTX = 8192
DEFAULT_LLAMA_CPP_N_CTX = 32768


def log_runtime(message: str) -> None:
    print(f"[entropic-managed-runtime] {message}", flush=True)


def summarize_log_preview(text: str, max_chars: int = 120) -> str:
    normalized = " ".join((text or "").split())
    if len(normalized) <= max_chars:
        return normalized
    return f"{normalized[: max_chars - 1]}…"


def _is_inbound_meta_sentinel_line(line: str) -> bool:
    trimmed = (line or "").strip()
    return trimmed in INBOUND_META_SENTINELS


def _should_strip_trailing_untrusted_context(lines: List[str], index: int) -> bool:
    if (lines[index] or "").strip() != UNTRUSTED_CONTEXT_HEADER:
        return False
    probe = "\n".join(lines[index + 1 : min(len(lines), index + 8)])
    return bool(
        re.search(r"<<<EXTERNAL_UNTRUSTED_CONTENT|UNTRUSTED channel metadata \(|Source:\s+", probe)
    )


def strip_inbound_metadata(text: str) -> str:
    if not text:
        return text
    if not any(sentinel in text for sentinel in INBOUND_META_SENTINELS) and UNTRUSTED_CONTEXT_HEADER not in text:
        return text

    lines = text.split("\n")
    result: List[str] = []
    in_meta_block = False
    in_fenced_json = False

    for index, line in enumerate(lines):
        if not in_meta_block and _should_strip_trailing_untrusted_context(lines, index):
            break

        if not in_meta_block and _is_inbound_meta_sentinel_line(line):
            next_line = lines[index + 1] if index + 1 < len(lines) else ""
            if next_line.strip() != "```json":
                result.append(line)
                continue
            in_meta_block = True
            in_fenced_json = False
            continue

        if in_meta_block:
            if not in_fenced_json and line.strip() == "```json":
                in_fenced_json = True
                continue
            if in_fenced_json:
                if line.strip() == "```":
                    in_meta_block = False
                    in_fenced_json = False
                continue
            if line.strip() == "":
                continue
            in_meta_block = False

        result.append(line)

    return "\n".join(result).lstrip("\n").rstrip("\n")


def strip_message_id_hints(text: str) -> str:
    if not text or "[message_id:" not in text.lower():
        return text
    lines = text.split("\n")
    filtered = [line for line in lines if not MESSAGE_ID_LINE_RE.match(line)]
    if len(filtered) == len(lines):
        return text
    return "\n".join(filtered)


def _looks_like_envelope_header(header: str) -> bool:
    if re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b", header):
        return True
    if re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b", header):
        return True
    if re.search(r"^[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\b", header):
        return True
    for label in [
        "WebChat",
        "WhatsApp",
        "Telegram",
        "Signal",
        "Slack",
        "Discord",
        "Google Chat",
        "iMessage",
        "Teams",
        "Matrix",
        "Zalo",
        "Zalo Personal",
        "BlueBubbles",
    ]:
        if header.startswith(f"{label} "):
            return True
    return False


def strip_envelope(text: str) -> str:
    if not text:
        return text
    match = ENVELOPE_PREFIX_RE.match(text)
    if not match:
        return text
    header = match.group(1) or ""
    if not _looks_like_envelope_header(header):
        return text
    return text[match.end() :]


def sanitize_user_prompt_text(text: str) -> str:
    return strip_message_id_hints(strip_envelope(strip_inbound_metadata(text or ""))).strip()


def _coerce_tool_argument_value(raw: str) -> Any:
    value = raw.strip()
    if not value:
        return ""
    try:
        return json.loads(value)
    except Exception:
        return value


def _build_tool_call(function_name: str, arguments: Any, suffix: str) -> Dict[str, Any]:
    if not isinstance(arguments, dict):
        arguments = {"input": arguments}
    return {
        "id": f"call_{uuid4().hex[:12]}_{suffix}",
        "type": "function",
        "function": {
            "name": function_name,
            "arguments": json.dumps(arguments, separators=(",", ":")),
        },
    }


def _extract_json_tool_call(parsed: Any) -> Optional[tuple[str, Any]]:
    if not isinstance(parsed, dict):
        return None
    function_name = str(parsed.get("tool") or parsed.get("name") or parsed.get("action") or "").strip()
    if not function_name:
        return None
    arguments = (
        parsed.get("parameters")
        or parsed.get("arguments")
        or parsed.get("args")
    )
    if arguments is None:
        arguments = {
            key: value
            for key, value in parsed.items()
            if key not in {"tool", "name", "action", "parameters", "arguments", "args"}
        }
    if function_name == "exec" and isinstance(arguments, dict):
        command = arguments.get("command")
        if isinstance(command, str) and "command" in arguments and "cmd" not in arguments:
            arguments = {**arguments, "cmd": command}
    return function_name, arguments


def parse_llama_cpp_tool_calls(text: str) -> List[Dict[str, Any]]:
    parsed_calls: List[Dict[str, Any]] = []
    if text and "<tool_call>" in text.lower():
        for index, tool_match in enumerate(TOOL_CALL_BLOCK_RE.finditer(text)):
            block = tool_match.group(1) or ""
            function_match = FUNCTION_BLOCK_RE.search(block)
            if not function_match:
                continue
            function_name = (function_match.group(1) or "").strip()
            function_body = function_match.group(2) or ""
            if not function_name:
                continue
            arguments: Dict[str, Any] = {}
            for param_match in PARAMETER_RE.finditer(function_body):
                param_name = (param_match.group(1) or "").strip()
                param_value = param_match.group(2) or ""
                if not param_name:
                    continue
                arguments[param_name] = _coerce_tool_argument_value(param_value)
            parsed_calls.append(_build_tool_call(function_name, arguments, str(index)))

    if parsed_calls:
        return parsed_calls

    if text and "```json" in text.lower():
        fenced_index = 0
        for fence_match in FENCED_JSON_RE.finditer(text):
            json_text = (fence_match.group(1) or "").strip()
            if not json_text:
                continue
            try:
                parsed = json.loads(json_text)
            except Exception:
                continue
            tool_call = _extract_json_tool_call(parsed)
            if tool_call is None:
                continue
            function_name, arguments = tool_call
            parsed_calls.append(_build_tool_call(function_name, arguments, f"f{fenced_index}"))
            fenced_index += 1

    if parsed_calls:
        return parsed_calls

    if text and text.lstrip().startswith("{"):
        decoder = json.JSONDecoder()
        stripped = text.lstrip()
        try:
            parsed_value, consumed = decoder.raw_decode(stripped)
        except Exception:
            parsed_value, consumed = None, 0
        if consumed > 0 and not stripped[consumed:].strip():
            tool_call = _extract_json_tool_call(parsed_value)
            if tool_call is not None:
                function_name, arguments = tool_call
                return [_build_tool_call(function_name, arguments, "j0")]

    if not text or "[[" not in text:
        return []

    decoder = json.JSONDecoder()
    search_index = 0
    bracket_index = 0
    while True:
        match = BRACKET_TOOL_CALL_RE.search(text, search_index)
        if not match:
            break
        function_name = (match.group(1) or "").strip()
        if not function_name:
            search_index = match.end()
            continue
        remainder = text[match.end() :]
        leading_ws = len(remainder) - len(remainder.lstrip())
        remainder = remainder.lstrip()
        arguments: Any = {}
        consumed = 0
        if remainder:
            try:
                parsed_value, consumed = decoder.raw_decode(remainder)
                arguments = parsed_value
            except Exception:
                arguments = {}
                consumed = 0
        parsed_calls.append(_build_tool_call(function_name, arguments, f"b{bracket_index}"))
        bracket_index += 1
        if consumed > 0:
            search_index = match.end() + leading_ws + consumed
        else:
            search_index = match.end()
    if parsed_calls:
        return parsed_calls

    if not text or "{" not in text:
        return []

    decoder = json.JSONDecoder()
    bare_index = 0
    for match in BARE_TOOL_CALL_RE.finditer(text):
        function_name = (match.group(1) or "").strip()
        if not function_name:
            continue
        remainder = text[match.end() :]
        leading_ws = len(remainder) - len(remainder.lstrip())
        remainder = remainder.lstrip()
        if not remainder.startswith("{"):
            continue
        try:
            parsed_value, consumed = decoder.raw_decode(remainder)
        except Exception:
            continue
        trailing = remainder[consumed:].strip()
        if trailing:
            continue
        parsed_calls.append(
            _build_tool_call(function_name, parsed_value, f"p{bare_index}")
        )
        bare_index += 1
    return parsed_calls


def strip_llama_cpp_tool_markup(text: str) -> str:
    if not text:
        return text
    cleaned = TOOL_CALL_BLOCK_RE.sub("", text)
    cleaned = FENCED_JSON_RE.sub(
        lambda match: ""
        if parse_llama_cpp_tool_calls(match.group(0))
        else match.group(0),
        cleaned,
    )
    decoder = json.JSONDecoder()
    while True:
        match = BRACKET_TOOL_CALL_RE.search(cleaned)
        if not match:
            break
        remainder = cleaned[match.end() :]
        leading_ws = len(remainder) - len(remainder.lstrip())
        remainder = remainder.lstrip()
        consumed = 0
        if remainder:
            try:
                _, consumed = decoder.raw_decode(remainder)
            except Exception:
                consumed = 0
        end_index = match.end() + leading_ws + consumed
        cleaned = (cleaned[: match.start()] + cleaned[end_index:]).strip()
    while True:
        match = BARE_TOOL_CALL_RE.search(cleaned)
        if not match:
            break
        remainder = cleaned[match.end() :]
        leading_ws = len(remainder) - len(remainder.lstrip())
        remainder = remainder.lstrip()
        if not remainder.startswith("{"):
            break
        consumed = 0
        try:
            _, consumed = decoder.raw_decode(remainder)
        except Exception:
            consumed = 0
        if consumed <= 0:
            break
        trailing = remainder[consumed:].strip()
        if trailing:
            break
        end_index = match.end() + leading_ws + consumed
        cleaned = (cleaned[: match.start()] + cleaned[end_index:]).strip()
    cleaned = re.sub(r"</?think>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"```json\s*```", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


TOOL_NARRATION_MARKERS = (
    "tool returned",
    "tool result",
    "i can provide this answer",
    "i can provide this",
    "i'll search",
    "i will search",
    "let me check",
    "i'll check",
    "i will check",
    "i'll respond",
    "i will respond",
    "the content is external, untrusted",
    "the user is asking",
    "i need to ",
    "i should ",
    "let me ",
)


def sanitize_llama_cpp_tool_answer(text: str) -> str:
    cleaned = re.sub(r"\[\[\s*reply_to_current\s*\]\]", "", (text or ""), flags=re.IGNORECASE)
    cleaned = cleaned.strip()
    if not cleaned:
        return cleaned

    paragraphs = [paragraph.strip() for paragraph in re.split(r"\n{2,}", cleaned) if paragraph.strip()]
    if len(paragraphs) >= 2:
        lead = " ".join(paragraphs[:-1]).lower()
        if any(marker in lead for marker in TOOL_NARRATION_MARKERS):
            return paragraphs[-1]

    sentences = re.split(r"(?<=[.!?])\s+", cleaned)
    while len(sentences) > 1:
        head = sentences[0].strip().lower()
        if not head:
            sentences = sentences[1:]
            continue
        if any(marker in head for marker in TOOL_NARRATION_MARKERS):
            sentences = sentences[1:]
            continue
        break
    return " ".join(sentence.strip() for sentence in sentences if sentence.strip()).strip()


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _as_float(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _as_optional_int(value: Any) -> Optional[int]:
    if value in (None, "", 0, "0"):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _as_int(value: Any, default: int, minimum: Optional[int] = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    return parsed


def default_runtime_config() -> Dict[str, Any]:
    return {
        "vllm": {
            "gpuMemoryUtilization": 0.9,
            "kvCacheDtype": "auto",
            "calculateKvScales": False,
            "cpuOffloadGb": 0.0,
            "swapSpace": 4.0,
            "maxModelLen": None,
            "enablePrefixCaching": True,
            "enforceEager": False,
        },
        "llamaCpp": {
            "nGpuLayers": -1,
            "nCtx": DEFAULT_LLAMA_CPP_N_CTX,
            "nBatch": 512,
            "nThreads": None,
            "flashAttn": True,
            "useMmap": True,
            "useMlock": False,
        },
    }


def normalize_runtime_config(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    base = default_runtime_config()
    candidate = config if isinstance(config, dict) else {}
    vllm = candidate.get("vllm") if isinstance(candidate.get("vllm"), dict) else {}
    llama_cpp = candidate.get("llamaCpp") if isinstance(candidate.get("llamaCpp"), dict) else {}
    base["vllm"] = {
        "gpuMemoryUtilization": _as_float(
            vllm.get("gpuMemoryUtilization"),
            0.9,
            0.5,
            0.99,
        ),
        "kvCacheDtype": str(vllm.get("kvCacheDtype") or "auto").strip().lower() or "auto",
        "calculateKvScales": _as_bool(vllm.get("calculateKvScales"), False),
        "cpuOffloadGb": _as_float(vllm.get("cpuOffloadGb"), 0.0, 0.0, 64.0),
        "swapSpace": _as_float(vllm.get("swapSpace"), 4.0, 0.0, 64.0),
        "maxModelLen": _as_optional_int(vllm.get("maxModelLen")),
        "enablePrefixCaching": _as_bool(vllm.get("enablePrefixCaching"), True),
        "enforceEager": _as_bool(vllm.get("enforceEager"), False),
    }
    base["llamaCpp"] = {
        "nGpuLayers": _as_int(llama_cpp.get("nGpuLayers"), -1),
        "nCtx": _as_int(llama_cpp.get("nCtx"), DEFAULT_LLAMA_CPP_N_CTX, 512),
        "nBatch": _as_int(llama_cpp.get("nBatch"), 512, 32),
        "nThreads": _as_optional_int(llama_cpp.get("nThreads")),
        "flashAttn": _as_bool(llama_cpp.get("flashAttn"), True),
        "useMmap": _as_bool(llama_cpp.get("useMmap"), True),
        "useMlock": _as_bool(llama_cpp.get("useMlock"), False),
    }
    return base


def merge_runtime_config(
    current: Dict[str, Any], updates: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    merged = default_runtime_config()
    for key, value in (current or {}).items():
        if isinstance(value, dict):
            merged[key] = {**merged.get(key, {}), **value}
        else:
            merged[key] = value
    for key, value in (updates or {}).items():
        if isinstance(value, dict):
            merged[key] = {**merged.get(key, {}), **value}
        else:
            merged[key] = value
    return normalize_runtime_config(merged)


class ThreadingUnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


class RuntimeManager:
    def __init__(self, models_dir: str, state_dir: str):
        self.models_dir = Path(models_dir)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.runtime_config_path = self.state_dir / "runtime-config.json"
        self.manager = ModelManager(str(self.models_dir))
        self.lock = threading.RLock()
        self.active_engine = None
        self.loaded_model: Optional[str] = None
        self.last_error: Optional[str] = None
        self.download_state: Optional[Dict[str, Any]] = None
        self.download_thread: Optional[threading.Thread] = None
        self.runtime_config = self._load_runtime_config()
        self.capabilities = detect_runtime_capabilities()

    def _load_runtime_config(self) -> Dict[str, Any]:
        if not self.runtime_config_path.exists():
            config = default_runtime_config()
            self._write_runtime_config(config)
            return config
        try:
            with open(self.runtime_config_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except Exception:
            payload = {}
        config = normalize_runtime_config(payload)
        self._write_runtime_config(config)
        return config

    def _write_runtime_config(self, config: Dict[str, Any]) -> None:
        with open(self.runtime_config_path, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2, sort_keys=True)
            handle.write("\n")

    def _build_engine(self, local_entry: Dict[str, Any]):
        architecture = str(local_entry.get("architecture") or "").strip().lower()
        backend = str(local_entry.get("backend") or "").strip().lower() or architecture
        if backend == "albatross":
            self.manager.ensure_rwkv_tokenizer()
            try:
                from albatross_engine import AlbatrossEngine
            except ImportError as error:
                raise RuntimeError(
                    "The bundled Albatross backend could not be imported. Check the managed runtime log for CUDA toolchain errors."
                ) from error

            return AlbatrossEngine(str(self.manager.tokenizer_path()))
        if backend == "vllm":
            try:
                from vllm_engine import VllmEngine
            except ImportError as error:
                raise RuntimeError(
                    "The vLLM backend is not installed in the managed local runtime yet."
                ) from error
            return VllmEngine(self.runtime_config.get("vllm"))
        if backend == "llama-cpp":
            try:
                from llama_cpp_engine import LlamaCppEngine
            except ImportError as error:
                raise RuntimeError(
                    "The llama.cpp backend is not installed in the managed local runtime yet."
                ) from error
            llama_cpp_config = dict(self.runtime_config.get("llamaCpp") or {})
            configured_n_ctx = _as_int(
                llama_cpp_config.get("nCtx"), DEFAULT_LLAMA_CPP_N_CTX, 512
            )
            model_context = _as_int(
                local_entry.get("context"), DEFAULT_LLAMA_CPP_N_CTX, 512
            )
            if configured_n_ctx <= LEGACY_LLAMA_CPP_N_CTX and model_context > configured_n_ctx:
                llama_cpp_config["nCtx"] = model_context
                current_llama_cpp = (
                    dict(self.runtime_config.get("llamaCpp") or {})
                    if isinstance(self.runtime_config.get("llamaCpp"), dict)
                    else {}
                )
                current_llama_cpp["nCtx"] = model_context
                self.runtime_config["llamaCpp"] = current_llama_cpp
                try:
                    self._save_runtime_config(self.runtime_config)
                except Exception:
                    pass
            else:
                llama_cpp_config["nCtx"] = configured_n_ctx
            return LlamaCppEngine(llama_cpp_config)
        if backend == "rwkv":
            self.manager.ensure_rwkv_tokenizer()
            from rwkv_engine import RWKVEngine

            return RWKVEngine(str(self.manager.tokenizer_path()))
        if backend == "mamba" or (not backend and architecture == "mamba"):
            from mamba_engine import MambaEngine

            return MambaEngine()
        from hf_engine import HFEngine

        return HFEngine()

    def health(self) -> Dict[str, Any]:
        with self.lock:
            self.capabilities = detect_runtime_capabilities()
            return {
                "ok": True,
                "runtimeName": "managed-local-runtime",
                "loadedModel": self.loaded_model,
                "lastError": self.last_error,
                "capabilities": self.capabilities,
                "activeBackend": getattr(self.active_engine, "name", None),
                "activeArchitecture": getattr(self.active_engine, "architecture", None),
                "activeModelInfo": getattr(self.active_engine, "model_info", None),
                "runtimeConfig": self.runtime_config,
            }

    def catalog_snapshot(self) -> Dict[str, Any]:
        with self.lock:
            payload = snapshot_json(self.manager, self.loaded_model)
            payload["lastError"] = self.last_error
            payload["downloadState"] = self.download_state
            return payload

    def describe_chat_request(self, model_name: str, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        with self.lock:
            local_entry = self.manager.get_local_entry(model_name)
            backend = str(local_entry.get("backend") or "").strip().lower() if local_entry else None
            normalized_messages = self._normalize_messages(messages)
            prompt = self._build_prompt(messages, model_name)
            return {
                "promptChars": (
                    sum(len(str(message.get("content") or "")) for message in normalized_messages)
                    if backend == "llama-cpp"
                    else len(prompt)
                ),
                "backend": backend,
                "architecture": (
                    str(local_entry.get("architecture") or "").strip().lower() if local_entry else None
                ),
                "thinking": bool(local_entry and local_entry.get("thinking")),
            }

    def _load_model_unlocked(self, model_name: str) -> Dict[str, Any]:
        local_entry = self.manager.get_local_entry(model_name)
        if not local_entry:
            raise RuntimeError(f"Model not found: {model_name}")

        if self.active_engine and self.loaded_model == local_entry["name"]:
            return {
                "status": "already_loaded",
                "model": self.loaded_model,
            }

        if self.active_engine is not None:
            try:
                self.active_engine.unload()
            finally:
                self.active_engine = None
                self.loaded_model = None

        engine = self._build_engine(local_entry)
        try:
            info = engine.load(local_entry["path"])
        except Exception as error:
            self.last_error = str(error)
            try:
                engine.unload()
            except Exception:
                pass
            finally:
                del engine
            try:
                gc.collect()
            except Exception:
                pass
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            self.active_engine = None
            self.loaded_model = None
            raise
        self.active_engine = engine
        self.loaded_model = local_entry["name"]
        self.last_error = None
        return {
            "status": "loaded",
            "model": self.loaded_model,
            "info": info,
        }

    def load_model(self, model_name: str) -> Dict[str, Any]:
        with self.lock:
            return self._load_model_unlocked(model_name)

    def unload_model(self) -> Dict[str, Any]:
        with self.lock:
            if self.active_engine is None:
                return {"status": "no_model_loaded"}
            name = self.loaded_model
            self.active_engine.unload()
            self.active_engine = None
            self.loaded_model = None
            self.last_error = None
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            return {"status": "unloaded", "model": name}

    def delete_model(self, model_name: str) -> Dict[str, Any]:
        with self.lock:
            if self.loaded_model == model_name and self.active_engine is not None:
                self.active_engine.unload()
                self.active_engine = None
                self.loaded_model = None
            result = self.manager.delete(model_name)
            if result.get("status") == "error":
                self.last_error = result.get("error")
            return result

    def _progress_state(
        self,
        catalog_id: str,
        downloaded_bytes: int,
        total_bytes: Optional[int],
        model_name: str,
    ) -> Dict[str, Any]:
        progress_percent = None
        if total_bytes and total_bytes > 0:
            progress_percent = round(downloaded_bytes * 100 / total_bytes, 1)
        return {
            "status": "downloading",
            "catalogId": catalog_id,
            "modelName": model_name,
            "downloadedBytes": downloaded_bytes,
            "totalBytes": total_bytes,
            "progressPercent": progress_percent,
        }

    def _download_worker(self, catalog_id: str, token: Optional[str]) -> None:
        entry = next(
            (candidate for candidate in self.manager.list_available() if candidate["id"] == catalog_id),
            None,
        )
        model_name = (
            str(entry.get("display_name") or entry.get("name") or catalog_id)
            if entry
            else catalog_id
        )

        def on_progress(downloaded_bytes: int, total_bytes: Optional[int]) -> None:
            with self.lock:
                self.download_state = self._progress_state(
                    catalog_id,
                    downloaded_bytes,
                    total_bytes,
                    model_name,
                )

        try:
            result = self.manager.download(catalog_id, token, on_progress)
            with self.lock:
                if result.get("status") == "error":
                    self.last_error = result.get("error")
                    self.download_state = {
                        "status": "error",
                        "catalogId": catalog_id,
                        "modelName": model_name,
                        "error": result.get("error"),
                    }
                else:
                    self.last_error = None
                    self.download_state = {
                        "status": "downloaded",
                        "catalogId": catalog_id,
                        "modelName": model_name,
                        "path": result.get("path"),
                        "sizeGb": result.get("size_gb"),
                        "elapsedS": result.get("elapsed_s"),
                    }
        finally:
            with self.lock:
                self.download_thread = None

    def download_model(self, catalog_id: str, token: Optional[str] = None) -> Dict[str, Any]:
        with self.lock:
            if self.download_thread is not None and self.download_thread.is_alive():
                if self.download_state and self.download_state.get("catalogId") == catalog_id:
                    return dict(self.download_state)
                return {
                    "status": "error",
                    "error": "Another managed-runtime download is already in progress.",
                }

            local_entry = self.manager.get_local_entry(catalog_id)
            if local_entry:
                return {
                    "status": "already_exists",
                    "catalogId": catalog_id,
                    "path": local_entry.get("path"),
                }

            entry = next(
                (candidate for candidate in self.manager.list_available() if candidate["id"] == catalog_id),
                None,
            )
            model_name = (
                str(entry.get("display_name") or entry.get("name") or catalog_id)
                if entry
                else catalog_id
            )
            self.last_error = None
            self.download_state = self._progress_state(catalog_id, 0, None, model_name)
            self.download_thread = threading.Thread(
                target=self._download_worker,
                args=(catalog_id, token),
                daemon=True,
            )
            self.download_thread.start()
            return dict(self.download_state)

    def warm_model(self, model_name: Optional[str] = None) -> Dict[str, Any]:
        with self.lock:
            if model_name:
                self._load_model_unlocked(model_name)
            if self.active_engine is None:
                return {"status": "error", "error": "No model loaded"}
            started_at = time.time()
            local_entry = self.manager.get_local_entry(self.loaded_model) if self.loaded_model else None
            backend = str(local_entry.get("backend") or "").strip().lower() if local_entry else ""
            if backend == "llama-cpp" and hasattr(self.active_engine, "generate_messages_stream"):
                for _ in self.active_engine.generate_messages_stream(
                    [{"role": "user", "content": "Hi"}],
                    max_tokens=1,
                ):
                    pass
            else:
                for _ in self.active_engine.generate_stream("User: Hi\n\nAssistant:", max_tokens=1):
                    pass
            if hasattr(self.active_engine, "reset"):
                self.active_engine.reset()
            return {"status": "warm", "elapsed_s": round(time.time() - started_at, 2)}

    def update_runtime_config(self, updates: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            self.runtime_config = merge_runtime_config(self.runtime_config, updates)
            self._write_runtime_config(self.runtime_config)
            restart_required = self.active_engine is not None and getattr(
                self.active_engine, "name", None
            ) in {"vllm", "llama-cpp"}
            return {
                "status": "updated",
                "runtimeConfig": self.runtime_config,
                "restartRequired": restart_required,
            }

    def _extract_content_text(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: List[str] = []
            for block in content:
                if isinstance(block, dict):
                    block_type = str(block.get("type") or "").strip().lower()
                    if block_type in {"text", "input_text", ""}:
                        text = block.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                elif isinstance(block, str) and block.strip():
                    parts.append(block.strip())
            return "\n".join(parts)
        if isinstance(content, dict):
            text = content.get("text")
            if isinstance(text, str):
                return text
        return ""

    def _normalize_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        normalized_messages: List[Dict[str, str]] = []
        for message in messages:
            role = str(message.get("role") or "").strip().lower() or "user"
            text = self._extract_content_text(message.get("content"))
            if not text.strip():
                continue
            if role == "user":
                text = sanitize_user_prompt_text(text)
                if not text:
                    continue
            normalized_messages.append({"role": role, "content": text.strip()})
        return normalized_messages

    def _build_prompt(self, messages: List[Dict[str, Any]], model_name: str) -> str:
        local_entry = self.manager.get_local_entry(model_name)
        thinking = bool(local_entry and local_entry.get("thinking"))
        system_messages: List[str] = []
        transcript: List[str] = []

        for message in self._normalize_messages(messages):
            role = str(message.get("role") or "").strip().lower() or "user"
            text = str(message.get("content") or "").strip()
            if role == "system":
                system_messages.append(text)
                continue
            if role == "assistant":
                transcript.append(f"Assistant: {text}")
                continue
            if role == "tool":
                transcript.append(f"Tool: {text}")
                continue
            transcript.append(f"User: {text}")

        prompt = ""
        if system_messages:
            prompt += "\n\n".join(system_messages).strip() + "\n\n"
        if transcript:
            prompt += "\n\n".join(transcript).strip() + "\n\n"
        prompt += "Assistant: <think\n" if thinking else "Assistant:"
        return prompt

    def generate(
        self,
        model_name: str,
        messages: List[Dict[str, Any]],
        temperature: float,
        top_p: float,
        max_tokens: int,
    ):
        with self.lock:
            self._load_model_unlocked(model_name)
            engine = self.active_engine
            normalized_messages = self._normalize_messages(messages)
            prompt = self._build_prompt(messages, model_name)
            if hasattr(engine, "reset"):
                engine.reset()
        if getattr(engine, "name", None) == "llama-cpp" and hasattr(engine, "generate_messages_stream"):
            for piece in engine.generate_messages_stream(
                normalized_messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
            ):
                yield piece
            return
        for piece in engine.generate_stream(
            prompt,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        ):
            yield piece

    def complete(
        self,
        model_name: str,
        messages: List[Dict[str, Any]],
        temperature: float,
        top_p: float,
        max_tokens: int,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Any] = None,
    ) -> Dict[str, Any]:
        with self.lock:
            self._load_model_unlocked(model_name)
            engine = self.active_engine
            normalized_messages = self._normalize_messages(messages)
            if hasattr(engine, "reset"):
                engine.reset()
        if getattr(engine, "name", None) == "llama-cpp" and hasattr(engine, "complete_messages"):
            return engine.complete_messages(
                normalized_messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
            )
        text = "".join(
            self.generate(
                model_name,
                messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
            )
        )
        return {
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ]
        }

    def generation_stats(self) -> Dict[str, Any]:
        with self.lock:
            if self.active_engine is None:
                return {}
            stats = getattr(self.active_engine, "last_generation_stats", None)
            return dict(stats) if isinstance(stats, dict) else {}


def make_handler(runtime: RuntimeManager):
    class Handler(BaseHTTPRequestHandler):
        server_version = "EntropicRnnRuntime/0.1"

        def _json_response(self, status: int, payload: Dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self) -> Dict[str, Any]:
            content_length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(content_length) if content_length else b"{}"
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))

        def _handle_chat_completions(self) -> None:
            body = self._read_json_body()
            model_name = str(body.get("model") or "").strip()
            if not model_name:
                self._json_response(400, {"error": {"message": "Missing model"}})
                return

            messages = body.get("messages") if isinstance(body.get("messages"), list) else []
            temperature = float(body.get("temperature") or 1.0)
            top_p = float(body.get("top_p") or 0.7)
            max_tokens = int(body.get("max_tokens") or body.get("max_completion_tokens") or 500)
            stream = bool(body.get("stream"))
            tools = body.get("tools") if isinstance(body.get("tools"), list) else None
            tool_choice = body.get("tool_choice")
            request_id = uuid4().hex[:8]
            input_chars = sum(
                len(runtime._extract_content_text(message.get("content")))
                for message in messages
                if isinstance(message, dict)
            )
            prompt_info = runtime.describe_chat_request(model_name, messages)
            started_at = time.perf_counter()
            log_runtime(
                "chat start "
                f"request={request_id} model={model_name} stream={int(stream)} "
                f"messages={len(messages)} inputChars={input_chars} "
                f"promptChars={prompt_info['promptChars']} backend={prompt_info['backend'] or '-'} "
                f"architecture={prompt_info['architecture'] or '-'} thinking={int(bool(prompt_info['thinking']))} "
                f"temperature={temperature:.2f} top_p={top_p:.2f} maxTokens={max_tokens} "
                f"tools={len(tools) if tools else 0} toolChoice={json.dumps(tool_choice) if tool_choice is not None else 'null'}"
            )

            use_llama_cpp_tool_bridge = bool(tools) and prompt_info.get("backend") == "llama-cpp"

            if use_llama_cpp_tool_bridge:
                try:
                    response = runtime.complete(
                        model_name,
                        messages,
                        temperature,
                        top_p,
                        max_tokens,
                        tools=tools,
                        tool_choice=tool_choice,
                    )
                except Exception as error:
                    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                    log_runtime(
                        f"chat error request={request_id} model={model_name} phase=setup "
                        f"elapsedMs={elapsed_ms} error={error!r}"
                    )
                    self._json_response(500, {"error": {"message": str(error)}})
                    return

                choices = response.get("choices") if isinstance(response, dict) else None
                first_choice = choices[0] if isinstance(choices, list) and choices else {}
                message = first_choice.get("message") if isinstance(first_choice, dict) else {}
                raw_content = message.get("content") if isinstance(message, dict) else ""
                if not isinstance(raw_content, str):
                    raw_content = str(raw_content or "")
                parsed_tool_calls = parse_llama_cpp_tool_calls(raw_content)
                cleaned_content = strip_llama_cpp_tool_markup(raw_content)
                if tools and not parsed_tool_calls:
                    cleaned_content = sanitize_llama_cpp_tool_answer(cleaned_content)
                finish_reason = "tool_calls" if parsed_tool_calls else "stop"
                completion_id = f"chatcmpl-{uuid4().hex}"
                created = int(time.time())
                elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                stats = runtime.generation_stats()
                stats_summary = ""
                generated_tokens = stats.get("generatedTokens")
                tokens_per_second = stats.get("tokensPerSecond")
                if isinstance(generated_tokens, int) and generated_tokens >= 0:
                    stats_summary += f" generatedTokens={generated_tokens}"
                if isinstance(tokens_per_second, (int, float)) and tokens_per_second > 0:
                    stats_summary += f" tokensPerSecond={tokens_per_second:.2f}"
                tool_call_names = [
                    tool_call.get("function", {}).get("name", "")
                    for tool_call in parsed_tool_calls
                    if isinstance(tool_call, dict)
                ]
                log_runtime(
                    f"chat first_token request={request_id} model={model_name} "
                    f"stream={int(stream)} firstTokenMs={elapsed_ms}"
                )
                log_runtime(
                    f"chat done request={request_id} model={model_name} stream={int(stream)} "
                    f"elapsedMs={elapsed_ms} chunks={1 if (parsed_tool_calls or cleaned_content) else 0} "
                    f"outputChars={len(cleaned_content)} finishReason={finish_reason} "
                    f"toolBridgeToolCalls={len(parsed_tool_calls)} "
                    f"toolBridgeToolNames={json.dumps(tool_call_names)}{stats_summary} "
                    f"preview={json.dumps(summarize_log_preview(cleaned_content or raw_content))}"
                )

                if not stream:
                    assistant_message: Dict[str, Any] = {
                        "role": "assistant",
                        "content": None if parsed_tool_calls else cleaned_content,
                    }
                    if parsed_tool_calls:
                        assistant_message["tool_calls"] = parsed_tool_calls
                    self._json_response(
                        200,
                        {
                            "id": completion_id,
                            "object": "chat.completion",
                            "created": created,
                            "model": model_name,
                            "choices": [
                                {
                                    "index": 0,
                                    "message": assistant_message,
                                    "finish_reason": finish_reason,
                                }
                            ],
                        },
                    )
                    return

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

                def send_event(payload: Dict[str, Any]) -> None:
                    data = json.dumps(payload).encode("utf-8")
                    self.wfile.write(b"data: " + data + b"\n\n")
                    self.wfile.flush()

                send_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant"},
                                "finish_reason": None,
                            }
                        ],
                    }
                )
                if parsed_tool_calls:
                    for index, tool_call in enumerate(parsed_tool_calls):
                        send_event(
                            {
                                "id": completion_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model_name,
                                "choices": [
                                    {
                                        "index": 0,
                                        "delta": {
                                            "tool_calls": [
                                                {
                                                    "index": index,
                                                    "id": tool_call["id"],
                                                    "type": "function",
                                                    "function": {
                                                        "name": tool_call["function"]["name"],
                                                        "arguments": tool_call["function"]["arguments"],
                                                    },
                                                }
                                            ]
                                        },
                                        "finish_reason": None,
                                    }
                                ],
                            }
                        )
                elif cleaned_content:
                    send_event(
                        {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {"content": cleaned_content},
                                    "finish_reason": None,
                                }
                            ],
                        }
                    )
                send_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": finish_reason,
                            }
                        ],
                    }
                )
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return

            try:
                chunks = runtime.generate(model_name, messages, temperature, top_p, max_tokens)
            except Exception as error:
                elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                log_runtime(
                    f"chat error request={request_id} model={model_name} phase=setup "
                    f"elapsedMs={elapsed_ms} error={error!r}"
                )
                self._json_response(500, {"error": {"message": str(error)}})
                return

            completion_id = f"chatcmpl-{uuid4().hex}"
            created = int(time.time())

            if not stream:
                parts = []
                chunk_count = 0
                output_chars = 0
                first_token_logged = False
                try:
                    for chunk in chunks:
                        chunk_count += 1
                        output_chars += len(chunk)
                        if not first_token_logged:
                            log_runtime(
                                f"chat first_token request={request_id} model={model_name} "
                                f"stream=0 firstTokenMs={round((time.perf_counter() - started_at) * 1000)}"
                            )
                            first_token_logged = True
                        parts.append(chunk)
                except Exception as error:
                    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                    log_runtime(
                        f"chat error request={request_id} model={model_name} phase=generate "
                        f"stream=0 elapsedMs={elapsed_ms} chunks={chunk_count} outputChars={output_chars} "
                        f"error={error!r}"
                    )
                    self._json_response(500, {"error": {"message": str(error)}})
                    return
                text = "".join(parts)
                elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                stats = runtime.generation_stats()
                stats_summary = ""
                generated_tokens = stats.get("generatedTokens")
                tokens_per_second = stats.get("tokensPerSecond")
                if isinstance(generated_tokens, int) and generated_tokens >= 0:
                    stats_summary += f" generatedTokens={generated_tokens}"
                if isinstance(tokens_per_second, (int, float)) and tokens_per_second > 0:
                    stats_summary += f" tokensPerSecond={tokens_per_second:.2f}"
                log_runtime(
                    f"chat done request={request_id} model={model_name} stream=0 "
                    f"elapsedMs={elapsed_ms} chunks={chunk_count} outputChars={output_chars}"
                    f"{stats_summary} preview={json.dumps(summarize_log_preview(text))}"
                )
                self._json_response(
                    200,
                    {
                        "id": completion_id,
                        "object": "chat.completion",
                        "created": created,
                        "model": model_name,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": text},
                                "finish_reason": "stop",
                            }
                        ],
                    },
                )
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

            def send_event(payload: Dict[str, Any]) -> None:
                data = json.dumps(payload).encode("utf-8")
                self.wfile.write(b"data: " + data + b"\n\n")
                self.wfile.flush()

            chunk_count = 0
            output_chars = 0
            first_token_logged = False
            streamed_parts: List[str] = []
            try:
                send_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant"},
                                "finish_reason": None,
                            }
                        ],
                    }
                )
                for piece in chunks:
                    chunk_count += 1
                    output_chars += len(piece)
                    streamed_parts.append(piece)
                    if not first_token_logged:
                        log_runtime(
                            f"chat first_token request={request_id} model={model_name} "
                            f"stream=1 firstTokenMs={round((time.perf_counter() - started_at) * 1000)}"
                        )
                        first_token_logged = True
                    send_event(
                        {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {"content": piece},
                                    "finish_reason": None,
                                }
                            ],
                        }
                    )
                send_event(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop",
                            }
                        ],
                        }
                    )
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                text = "".join(streamed_parts)
                stats = runtime.generation_stats()
                stats_summary = ""
                generated_tokens = stats.get("generatedTokens")
                tokens_per_second = stats.get("tokensPerSecond")
                if isinstance(generated_tokens, int) and generated_tokens >= 0:
                    stats_summary += f" generatedTokens={generated_tokens}"
                if isinstance(tokens_per_second, (int, float)) and tokens_per_second > 0:
                    stats_summary += f" tokensPerSecond={tokens_per_second:.2f}"
                log_runtime(
                    f"chat done request={request_id} model={model_name} stream=1 "
                    f"elapsedMs={elapsed_ms} chunks={chunk_count} outputChars={output_chars}"
                    f"{stats_summary} preview={json.dumps(summarize_log_preview(text))}"
                )
            except BrokenPipeError as error:
                elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                log_runtime(
                    f"chat client_disconnect request={request_id} model={model_name} stream=1 "
                    f"elapsedMs={elapsed_ms} chunks={chunk_count} outputChars={output_chars} "
                    f"error={error!r}"
                )
            except Exception as error:
                elapsed_ms = round((time.perf_counter() - started_at) * 1000)
                log_runtime(
                    f"chat error request={request_id} model={model_name} phase=stream "
                    f"elapsedMs={elapsed_ms} chunks={chunk_count} outputChars={output_chars} "
                    f"error={error!r}"
                )
                try:
                    send_event(
                        {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {},
                                    "finish_reason": "error",
                                }
                            ],
                            "error": {"message": str(error)},
                        }
                    )
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception:
                    pass

        def do_GET(self) -> None:
            if self.path == "/healthz":
                self._json_response(200, runtime.health())
                return
            if self.path == "/v1/models":
                snapshot = runtime.catalog_snapshot()
                self._json_response(
                    200,
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": entry["name"],
                                "object": "model",
                                "owned_by": "entropic-managed-runtime",
                            }
                            for entry in snapshot["local"]
                        ],
                    },
                )
                return
            if self.path == "/api/rnn/catalog":
                self._json_response(200, runtime.catalog_snapshot())
                return
            if self.path == "/api/rnn/runtime/config":
                self._json_response(200, {"runtimeConfig": runtime.runtime_config})
                return
            self._json_response(404, {"error": {"message": "Not found"}})

        def do_POST(self) -> None:
            if self.path == "/v1/chat/completions":
                self._handle_chat_completions()
                return

            body = self._read_json_body()
            token = str(body.get("hfToken") or "").strip() or None
            try:
                if self.path == "/api/rnn/models/download":
                    self._json_response(
                        200,
                        runtime.download_model(str(body.get("catalogId") or "").strip(), token),
                    )
                    return
                if self.path == "/api/rnn/models/load":
                    self._json_response(
                        200, runtime.load_model(str(body.get("modelName") or "").strip())
                    )
                    return
                if self.path == "/api/rnn/models/unload":
                    self._json_response(200, runtime.unload_model())
                    return
                if self.path == "/api/rnn/models/delete":
                    self._json_response(
                        200, runtime.delete_model(str(body.get("modelName") or "").strip())
                    )
                    return
                if self.path == "/api/rnn/models/warm":
                    model_name = str(body.get("modelName") or "").strip() or None
                    self._json_response(200, runtime.warm_model(model_name))
                    return
                if self.path == "/api/rnn/runtime/config":
                    updates = body.get("runtimeConfig")
                    if updates is None:
                        updates = body
                    if not isinstance(updates, dict):
                        self._json_response(
                            400,
                            {"status": "error", "error": "runtimeConfig must be an object"},
                        )
                        return
                    self._json_response(200, runtime.update_runtime_config(updates))
                    return
            except Exception as error:
                self._json_response(500, {"status": "error", "error": str(error)})
                return

            self._json_response(404, {"error": {"message": "Not found"}})

        def log_message(self, format: str, *args: Any) -> None:
            return None

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11445)
    parser.add_argument("--unix-socket", default="")
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--state-dir", required=True)
    args = parser.parse_args()

    runtime = RuntimeManager(args.models_dir, args.state_dir)
    handler = make_handler(runtime)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    unix_server: Optional[ThreadingUnixHTTPServer] = None
    unix_thread: Optional[threading.Thread] = None

    unix_socket_path = args.unix_socket.strip()
    if unix_socket_path:
        if not hasattr(socket, "AF_UNIX"):
            log_runtime("unix sockets unavailable on this platform; skipping shared socket listener")
        else:
            socket_path = Path(unix_socket_path)
            socket_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                if socket_path.exists():
                    socket_path.unlink()
            except FileNotFoundError:
                pass
            unix_server = ThreadingUnixHTTPServer(str(socket_path), handler)
            unix_thread = threading.Thread(
                target=unix_server.serve_forever,
                name="managed-runtime-unix-http",
                daemon=True,
            )
            unix_thread.start()
            os.chmod(socket_path, 0o600)
            log_runtime(f"listening on unix://{socket_path}")

    log_runtime(f"listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if unix_server is not None:
            unix_server.shutdown()
            unix_server.server_close()
        if unix_socket_path:
            try:
                Path(unix_socket_path).unlink()
            except FileNotFoundError:
                pass
        if unix_thread is not None:
            unix_thread.join(timeout=1)
        server.server_close()


if __name__ == "__main__":
    main()
