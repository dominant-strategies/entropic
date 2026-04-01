import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Generator, Optional
from uuid import uuid4

from engine import InferenceEngine


PRISM_LLAMA_SERVER_BIN_ENV = "ENTROPIC_RNN_PRISM_LLAMA_SERVER"
PRISM_LLAMA_STATE_DIR_ENV = "ENTROPIC_RNN_RUNTIME_STATE_DIR"
PRISM_LLAMA_READY_TIMEOUT_S = 45.0
PRISM_LLAMA_HTTP_TIMEOUT_S = 600


def _default_prism_llama_server_path(state_dir: Optional[str]) -> Path:
    base_dir = Path(state_dir or os.environ.get(PRISM_LLAMA_STATE_DIR_ENV) or "")
    if not str(base_dir).strip():
        return Path("")
    binary_name = "llama-server.exe" if os.name == "nt" else "llama-server"
    release_path = base_dir / "prism-llama.cpp" / "build" / "bin" / "Release" / binary_name
    if release_path.exists():
        return release_path
    return base_dir / "prism-llama.cpp" / "build" / "bin" / binary_name


def resolve_prism_llama_server_path(state_dir: Optional[str] = None) -> Optional[str]:
    configured = (os.environ.get(PRISM_LLAMA_SERVER_BIN_ENV) or "").strip()
    if configured:
        candidate = Path(configured)
        if candidate.exists():
            return str(candidate)
    candidate = _default_prism_llama_server_path(state_dir)
    if candidate.exists():
        return str(candidate)
    return None


def _append_library_path(env: Dict[str, str], key: str, path: str) -> None:
    existing = env.get(key, "").strip()
    if not existing:
        env[key] = path
        return
    parts = [part for part in existing.split(os.pathsep) if part]
    if path not in parts:
        env[key] = os.pathsep.join([path, *parts])


def _summarize_prism_runtime_error(raw: str, fallback: str) -> str:
    text = (raw or "").strip()
    if not text:
        return fallback
    overflow = re.search(
        r"request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)",
        text,
        re.IGNORECASE,
    )
    if overflow:
        return (
            "Prism request exceeded the available context window "
            f"({overflow.group(1)} > {overflow.group(2)} tokens)."
        )
    if "Library not loaded: @rpath/libmtmd.0.dylib" in text:
        return (
            "Prism llama-server could not load its bundled libmtmd runtime library. "
            "Restart the managed runtime or reinstall the Prism backend."
        )
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        if "send_error:" in stripped:
            return stripped.split("send_error:", 1)[1].strip()
        if "error:" in stripped.lower():
            return stripped
    if len(text) > 240:
        return f"{text[:237]}..."
    return text


def _pick_unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _json_request(
    url: str,
    payload: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = PRISM_LLAMA_HTTP_TIMEOUT_S,
) -> Dict[str, Any]:
    body = None
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=request_headers, method="POST" if body else "GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}


def _normalize_chat_messages(messages: list) -> tuple[list, int]:
    normalized_messages = []
    input_chars = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user").strip().lower() or "user"
        if role not in {"system", "user", "assistant", "tool"}:
            role = "user"
        content = message.get("content")
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if isinstance(block, dict):
                    text = block.get("text")
                    if isinstance(text, str) and text:
                        text_parts.append(text)
                elif isinstance(block, str) and block:
                    text_parts.append(block)
            text = "\n".join(text_parts)
        elif isinstance(content, str):
            text = content
        elif content is None:
            text = ""
        else:
            text = str(content)
        normalized_messages.append({"role": role, "content": text})
        input_chars += len(text)
    return normalized_messages, input_chars


def _response_message(response: Dict[str, Any]) -> Dict[str, Any]:
    choices = response.get("choices") if isinstance(response, dict) else None
    first_choice = choices[0] if isinstance(choices, list) and choices else {}
    message = first_choice.get("message") if isinstance(first_choice, dict) else {}
    return message if isinstance(message, dict) else {}


def _merge_reasoning_into_content(message: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(message)
    raw_reasoning = normalized.get("reasoning_content")
    reasoning_text = raw_reasoning if isinstance(raw_reasoning, str) else ""
    content = normalized.get("content")
    content_text = content if isinstance(content, str) else ""
    if reasoning_text:
        normalized["content"] = (
            f"<think>{reasoning_text.strip()}</think>\n{content_text.strip()}".strip()
        )
    elif not isinstance(content, str):
        normalized["content"] = content_text
    return normalized


class PrismLlamaServerEngine(InferenceEngine):
    name = "prism-llama"
    architecture = "gguf"

    def __init__(self, runtime_config: Optional[Dict[str, Any]] = None, state_dir: Optional[str] = None):
        super().__init__()
        self.runtime_config = runtime_config or {}
        self.state_dir = Path(state_dir) if state_dir else None
        self._process: Optional[subprocess.Popen[Any]] = None
        self._server_port: Optional[int] = None
        self._api_key: Optional[str] = None
        self._log_path: Optional[Path] = None
        self._log_handle = None

    def _normalized_runtime_config(self) -> Dict[str, Any]:
        n_gpu_layers = self.runtime_config.get("nGpuLayers", -1)
        n_ctx = self.runtime_config.get("nCtx", 32768)
        n_batch = self.runtime_config.get("nBatch", 512)
        n_threads = self.runtime_config.get("nThreads")
        return {
            "nGpuLayers": int(n_gpu_layers) if n_gpu_layers is not None else -1,
            "nCtx": max(512, int(n_ctx) if n_ctx is not None else 32768),
            "nBatch": max(32, int(n_batch) if n_batch is not None else 512),
            "nThreads": max(1, int(n_threads)) if n_threads not in (None, "", 0, "0") else None,
            "flashAttn": bool(self.runtime_config.get("flashAttn", True)),
            "useMmap": bool(self.runtime_config.get("useMmap", True)),
            "useMlock": bool(self.runtime_config.get("useMlock", False)),
        }

    def _server_url(self, path: str) -> str:
        if self._server_port is None:
            raise RuntimeError("Prism llama-server is not running")
        return f"http://127.0.0.1:{self._server_port}{path}"

    def _request_headers(self) -> Dict[str, str]:
        if not self._api_key:
            return {}
        return {"Authorization": f"Bearer {self._api_key}"}

    def _build_server_env(self, server_path: str) -> Dict[str, str]:
        env = dict(os.environ)
        library_dir = str(Path(server_path).resolve().parent)
        if os.name != "nt":
            _append_library_path(env, "LD_LIBRARY_PATH", library_dir)
        if sys.platform == "darwin":
            _append_library_path(env, "DYLD_LIBRARY_PATH", library_dir)
            _append_library_path(env, "DYLD_FALLBACK_LIBRARY_PATH", library_dir)
        return env

    def _request_error_message(self, error: Exception, fallback: str) -> str:
        detail = ""
        if isinstance(error, urllib.error.HTTPError):
            try:
                body = error.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            detail = body
        elif isinstance(error, urllib.error.URLError):
            detail = str(error.reason or error)
        else:
            detail = str(error)
        recent_log = self._read_recent_log()
        combined = "\n".join(part for part in [detail, recent_log] if part)
        return _summarize_prism_runtime_error(combined, fallback)

    def _build_server_args(self, model_path: str, runtime_config: Dict[str, Any]) -> list[str]:
        server_path = resolve_prism_llama_server_path(str(self.state_dir) if self.state_dir else None)
        if not server_path:
            raise RuntimeError(
                "The Prism llama.cpp backend is not installed yet. Install the Prism GGUF backend first."
            )
        port = _pick_unused_port()
        api_key = uuid4().hex
        self._server_port = port
        self._api_key = api_key
        args = [
            server_path,
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--model",
            model_path,
            "--ctx-size",
            str(runtime_config["nCtx"]),
            "--ubatch-size",
            str(runtime_config["nBatch"]),
            "--batch-size",
            str(max(runtime_config["nBatch"], 2048)),
            "--api-key",
            api_key,
            "--reasoning-format",
            "deepseek",
            "--reasoning-budget",
            "-1",
            "--no-webui",
            "--timeout",
            "600",
        ]
        if runtime_config["nThreads"] is not None:
            args.extend(["--threads", str(runtime_config["nThreads"])])
        if runtime_config["nGpuLayers"] >= 0:
            args.extend(["--gpu-layers", str(runtime_config["nGpuLayers"])])
        args.extend(["--flash-attn", "on" if runtime_config["flashAttn"] else "off"])
        args.append("--mmap" if runtime_config["useMmap"] else "--no-mmap")
        if runtime_config["useMlock"]:
            args.append("--mlock")
        return args

    def _wait_until_ready(self) -> None:
        deadline = time.time() + PRISM_LLAMA_READY_TIMEOUT_S
        last_error = "Prism llama-server did not become ready."
        while time.time() < deadline:
            if self._process is not None and self._process.poll() is not None:
                last_error = _summarize_prism_runtime_error(
                    self._read_recent_log(),
                    "Prism llama-server exited during startup.",
                )
                break
            try:
                request = urllib.request.Request(
                    self._server_url("/health"),
                    headers=self._request_headers(),
                    method="GET",
                )
                with urllib.request.urlopen(request, timeout=5):
                    pass
                return
            except Exception as error:
                last_error = self._request_error_message(
                    error,
                    "Prism llama-server did not become ready.",
                )
                time.sleep(0.5)
        raise RuntimeError(last_error)

    def _read_recent_log(self) -> str:
        if not self._log_path or not self._log_path.exists():
            return ""
        try:
            lines = self._log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            return "\n".join(lines[-20:]).strip()
        except Exception:
            return ""

    def _detect_runtime_device(self) -> tuple[str, Optional[str]]:
        if not self._log_path or not self._log_path.exists():
            return self.detect_device(), None
        try:
            lines = self._log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            return self.detect_device(), None

        device_name: Optional[str] = None
        for line in lines:
            if "ggml_metal_init: found device:" in line:
                device_name = line.split("ggml_metal_init: found device:", 1)[1].strip() or None
                return "mps", device_name
            if "ggml_cuda_init:" in line and "device" in line.lower():
                device_name = line.split(":", 2)[-1].strip() or None
                return "cuda", device_name
            if "vulkan" in line.lower() and "device" in line.lower():
                device_name = line.split(":", 1)[-1].strip() or None
                return "vulkan", device_name

        return self.detect_device(), device_name

    def load(self, model_path: str) -> Dict[str, object]:
        self.unload()
        runtime_config = self._normalized_runtime_config()
        started_at = time.time()
        self.device = self.detect_device()
        log_dir = self.state_dir or Path.cwd()
        log_dir.mkdir(parents=True, exist_ok=True)
        self._log_path = log_dir / "prism-llama-server.log"
        log_handle = open(self._log_path, "a", encoding="utf-8")
        self._log_handle = log_handle
        args = self._build_server_args(model_path, runtime_config)
        try:
            server_env = self._build_server_env(args[0])
            self._process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=log_handle,
                cwd=str(Path(args[0]).resolve().parent),
                env=server_env,
            )
            self._wait_until_ready()
        except Exception:
            log_handle.close()
            self._log_handle = None
            self.unload()
            raise
        self.device, detected_device_name = self._detect_runtime_device()
        self.model_path = model_path
        self.model_name = os.path.basename(model_path.rstrip(os.sep))
        self.is_loaded = True
        self.model_info = {
            "device": self.device,
            "backend": self.name,
            "loadTime": round(time.time() - started_at, 2),
            "fileSizeGb": round(os.path.getsize(model_path) / 1024**3, 2),
            "runtimeConfig": runtime_config,
            "serverLog": str(self._log_path),
        }
        if detected_device_name:
            self.model_info["deviceName"] = detected_device_name
        return self.model_info

    def unload(self) -> None:
        process = self._process
        self._process = None
        if process is not None:
            try:
                process.terminate()
                process.wait(timeout=10)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
        log_handle = self._log_handle
        self._log_handle = None
        if log_handle is not None:
            try:
                log_handle.close()
            except Exception:
                pass
        self._server_port = None
        self._api_key = None
        self.model_name = None
        self.model_path = None
        self.model_info = {}
        self.is_loaded = False

    def generate_stream(
        self,
        prompt: str,
        temperature: float = 1.0,
        top_p: float = 0.7,
        max_tokens: int = 500,
    ) -> Generator[str, None, None]:
        if not self.is_loaded:
            raise RuntimeError("No Prism llama.cpp model loaded")
        messages = [{"role": "user", "content": prompt}]
        for piece in self.generate_messages_stream(
            messages,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        ):
            yield piece

    def generate_messages_stream(
        self,
        messages: list,
        temperature: float = 1.0,
        top_p: float = 0.7,
        max_tokens: int = 500,
    ) -> Generator[str, None, None]:
        if not self.is_loaded:
            raise RuntimeError("No Prism llama.cpp model loaded")

        normalized_messages, input_chars = _normalize_chat_messages(messages)
        payload = {
            "messages": normalized_messages,
            "max_tokens": max_tokens,
            "temperature": max(0.0, temperature),
            "top_p": top_p,
            "stream": True,
        }
        request = urllib.request.Request(
            self._server_url("/v1/chat/completions"),
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                **self._request_headers(),
            },
            method="POST",
        )

        started_at = time.perf_counter()
        output_parts = []
        reasoning_open = False
        try:
            with urllib.request.urlopen(request, timeout=PRISM_LLAMA_HTTP_TIMEOUT_S) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        event = json.loads(data)
                    except Exception:
                        continue
                    choices = event.get("choices") if isinstance(event, dict) else None
                    if not choices:
                        continue
                    delta = choices[0].get("delta")
                    if not isinstance(delta, dict):
                        continue
                    reasoning = (
                        delta.get("reasoning_content")
                        or delta.get("reasoning")
                        or delta.get("thinking")
                    )
                    if isinstance(reasoning, str) and reasoning:
                        if not reasoning_open:
                            reasoning_open = True
                            output_parts.append("<think>")
                            yield "<think>"
                        output_parts.append(reasoning)
                        yield reasoning
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        if reasoning_open:
                            reasoning_open = False
                            output_parts.append("</think>\n")
                            yield "</think>\n"
                        output_parts.append(content)
                        yield content
        except Exception as error:
            raise RuntimeError(
                self._request_error_message(
                    error,
                    "Prism llama-server request failed during streaming.",
                )
            ) from error
        if reasoning_open:
            output_parts.append("</think>")
            yield "</think>"

        final_text = "".join(output_parts)
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        generated_tokens = len(self.encode(final_text)) if final_text else 0
        tokens_per_second = 0.0
        if elapsed_ms > 0 and generated_tokens > 0:
            tokens_per_second = round(generated_tokens / (elapsed_ms / 1000), 2)
        self.last_generation_stats = {
            "promptTokens": len(self.encode(json.dumps(normalized_messages, ensure_ascii=False))),
            "inputChars": input_chars,
            "generatedTokens": generated_tokens,
            "generatedChars": len(final_text),
            "decodeElapsedMs": elapsed_ms,
            "tokensPerSecond": tokens_per_second,
        }

    def complete_messages(
        self,
        messages: list,
        temperature: float = 1.0,
        top_p: float = 0.7,
        max_tokens: int = 500,
        tools: Optional[list] = None,
        tool_choice: Optional[Any] = None,
    ) -> Dict[str, Any]:
        if not self.is_loaded:
            raise RuntimeError("No Prism llama.cpp model loaded")

        normalized_messages, input_chars = _normalize_chat_messages(messages)
        payload: Dict[str, Any] = {
            "messages": normalized_messages,
            "max_tokens": max_tokens,
            "temperature": max(0.0, temperature),
            "top_p": top_p,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice

        started_at = time.perf_counter()
        try:
            response = _json_request(
                self._server_url("/v1/chat/completions"),
                payload=payload,
                headers=self._request_headers(),
            )
        except Exception as error:
            raise RuntimeError(
                self._request_error_message(
                    error,
                    "Prism llama-server request failed.",
                )
            ) from error
        message = _merge_reasoning_into_content(_response_message(response))
        choices = response.get("choices")
        if isinstance(choices, list) and choices:
            choices[0]["message"] = message
        usage = response.get("usage") if isinstance(response, dict) else {}
        content = message.get("content")
        content_text = content if isinstance(content, str) else str(content or "")
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        prompt_tokens = usage.get("prompt_tokens")
        if not isinstance(prompt_tokens, int):
            prompt_tokens = len(self.encode(json.dumps(normalized_messages, ensure_ascii=False)))
        generated_tokens = usage.get("completion_tokens")
        if not isinstance(generated_tokens, int):
            generated_tokens = len(self.encode(content_text)) if content_text else 0
        tokens_per_second = 0.0
        if elapsed_ms > 0 and generated_tokens > 0:
            tokens_per_second = round(generated_tokens / (elapsed_ms / 1000), 2)
        self.last_generation_stats = {
            "promptTokens": prompt_tokens,
            "inputChars": input_chars,
            "generatedTokens": generated_tokens,
            "generatedChars": len(content_text),
            "decodeElapsedMs": elapsed_ms,
            "tokensPerSecond": tokens_per_second,
        }
        return response

    def encode(self, text: str) -> list:
        return list(text.encode("utf-8"))

    def decode(self, tokens: list) -> str:
        try:
            return bytes(int(token) & 0xFF for token in tokens).decode("utf-8", errors="replace")
        except Exception:
            return ""
