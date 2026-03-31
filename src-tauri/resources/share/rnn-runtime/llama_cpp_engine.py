import importlib
import os
import re
import time
from urllib.parse import quote_plus
from typing import Any, Dict, Generator, Optional

from engine import InferenceEngine

LOCAL_TOOL_USE_SYSTEM_GUIDANCE = (
    "Tool-use rules for local chat: "
    "If a tool is needed, call it directly without narrating your plan. "
    "Never say you will search, check, look up, or use a tool later. "
    "Either emit the tool call immediately or answer directly from an existing tool result. "
    "If web_search is unavailable, use browser or web_fetch when they are present instead of refusing just because search is missing. "
    "Do not use configuration-changing or environment-changing tools for ordinary user requests. "
    "Do not call exec, gateway, or setup/config commands unless the user explicitly asked you to configure, install, debug, repair, or change the system. "
    "For requests like weather, news, prices, websites, and current information, prefer information-gathering tools over configuration or repair commands. "
    "For weather, news, prices, schedules, and other live information, never answer from memory when tools are available. "
    "For those requests, emit a real tool call first and return no prose before the tool call. "
    "Prefer web_search first, then web_fetch or browser. "
    "If web_search fails or is unavailable, immediately try web_fetch or browser in the same conversation instead of asking the user to configure search first. "
    "For simple public weather lookups with web_fetch, prefer lightweight endpoints like wttr.in with a direct city query instead of JavaScript-heavy weather pages. "
    "Do not use exec for public web lookups if web_search, web_fetch, or browser are available. "
    "After tool results arrive, answer the user directly in plain language. "
    "If a tool result already contains the requested live information, answer from that result directly. "
    "Do not second-guess the observation date or speculate about mock data unless the user explicitly asks about timestamps or data quality. "
    "Do not mention tool names, do not say phrases like 'the tool returned', "
    "and do not expose hidden reasoning."
)
LIVE_INFO_REQUEST_RE = re.compile(
    r"\b(weather|forecast|temperature|rain|snow|news|headline|stock|price|market|score|scores|schedule|current|currently|latest|today|tonight|right now)\b",
    re.IGNORECASE,
)
MEMORY_REQUEST_RE = re.compile(r"\bmemory\b", re.IGNORECASE)
SPREADSHEET_REQUEST_RE = re.compile(
    r"\b(excel|spreadsheet|workbook|csv|xlsx|xls)\b",
    re.IGNORECASE,
)
LOCAL_FILE_HINT_RE = re.compile(
    r"\b(local|workspace|file\s*system|filesystem|on\s+disk|on\s+my\s+machine|locally|file\s+path|folder|directory)\b",
    re.IGNORECASE,
)
CLOUD_SPREADSHEET_HINT_RE = re.compile(
    r"\b(google\s+sheets?|google\s+drive|sheets_(?:create|append|read|write)|drive_(?:list|search|upload|download))\b",
    re.IGNORECASE,
)
CLOUD_SPREADSHEET_NEGATION_RE = re.compile(
    r"\b(?:not|don't|do\s+not|dont|without|no)\b[^.!?\n]{0,60}\b(?:google\s+sheets?|google\s+drive)\b",
    re.IGNORECASE,
)


def _latest_user_message_text(messages: list) -> str:
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip().lower()
        if role != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if content is None:
            return ""
        return str(content).strip()
    return ""


def _latest_tool_message_text(messages: list) -> str:
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip().lower()
        if role != "tool":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if content is None:
            return ""
        return str(content).strip()
    return ""


def _all_user_message_text(messages: list) -> str:
    parts = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").strip().lower() != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content.strip())
        elif content is not None:
            parts.append(str(content).strip())
    return "\n".join(part for part in parts if part)


def _extract_available_tool_names(tools: Optional[list]) -> set[str]:
    names: set[str] = set()
    if not tools:
        return names
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if not isinstance(function, dict):
            continue
        name = str(function.get("name") or "").strip().lower()
        if name:
            names.add(name)
    return names


def _derive_weather_location_query(text: str) -> str:
    normalized = (text or "").strip()
    if not normalized:
        return ""
    match = re.search(r"\bweather\b(?:[^a-z0-9]+(?:in|for))?\s+(.+)$", normalized, re.IGNORECASE)
    if not match:
        match = re.search(r"\b(?:in|for)\s+(.+)$", normalized, re.IGNORECASE)
    if not match:
        return ""
    location = match.group(1).strip().strip("?.!,/ ")
    location = re.sub(r"^(the|a)\s+", "", location, flags=re.IGNORECASE)
    return quote_plus(location) if location else ""


class LlamaCppEngine(InferenceEngine):
    name = "llama-cpp"
    architecture = "gguf"

    def __init__(self, runtime_config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.runtime_config = runtime_config or {}
        self._llama = None

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

    def load(self, model_path: str) -> Dict[str, object]:
        try:
            importlib.invalidate_caches()
            from llama_cpp import Llama
        except ImportError as error:
            raise RuntimeError(
                "The llama.cpp backend is not installed in the managed local runtime yet. Install the GGUF backend first."
            ) from error

        started_at = time.time()
        self._llama = Llama
        self.device = self.detect_device()
        runtime_config = self._normalized_runtime_config()
        self.model = Llama(
            model_path=model_path,
            n_gpu_layers=runtime_config["nGpuLayers"],
            n_ctx=runtime_config["nCtx"],
            n_batch=runtime_config["nBatch"],
            n_threads=runtime_config["nThreads"],
            flash_attn=runtime_config["flashAttn"],
            use_mmap=runtime_config["useMmap"],
            use_mlock=runtime_config["useMlock"],
            verbose=False,
        )
        self.model_path = model_path
        self.model_name = os.path.basename(model_path.rstrip(os.sep))
        self.is_loaded = True
        self.model_info = {
            "device": self.device,
            "backend": self.name,
            "loadTime": round(time.time() - started_at, 2),
            "fileSizeGb": round(os.path.getsize(model_path) / 1024**3, 2),
            "runtimeConfig": runtime_config,
        }
        return self.model_info

    def unload(self) -> None:
        if self.model is not None:
            try:
                close = getattr(self.model, "close", None)
                if callable(close):
                    close()
            except Exception:
                pass
            del self.model
            self.model = None
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
        if not self.is_loaded or self.model is None:
            raise RuntimeError("No llama.cpp model loaded")

        prompt_tokens = self.encode(prompt)
        output_parts = []
        started_at = time.perf_counter()
        stream = self.model(
            prompt,
            max_tokens=max_tokens,
            temperature=max(0.0, temperature),
            top_p=top_p,
            stream=True,
            echo=False,
            stop=["\nUser:", "\nAssistant:", "\nTool:", "\nSystem:"],
        )
        for event in stream:
            choices = event.get("choices") if isinstance(event, dict) else None
            if not choices:
                continue
            text = choices[0].get("text")
            if not text:
                continue
            output_parts.append(text)
            yield text
        final_text = "".join(output_parts)
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        generated_tokens = len(self.encode(final_text)) if final_text else 0
        tokens_per_second = 0.0
        if elapsed_ms > 0 and generated_tokens > 0:
            tokens_per_second = round(generated_tokens / (elapsed_ms / 1000), 2)
        self.last_generation_stats = {
            "promptTokens": len(prompt_tokens),
            "generatedTokens": generated_tokens,
            "generatedChars": len(final_text),
            "decodeElapsedMs": elapsed_ms,
            "tokensPerSecond": tokens_per_second,
        }

    def generate_messages_stream(
        self,
        messages: list,
        temperature: float = 1.0,
        top_p: float = 0.7,
        max_tokens: int = 500,
    ) -> Generator[str, None, None]:
        if not self.is_loaded or self.model is None:
            raise RuntimeError("No llama.cpp model loaded")

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

        started_at = time.perf_counter()
        output_parts = []
        stream = self.model.create_chat_completion(
            messages=normalized_messages,
            max_tokens=max_tokens,
            temperature=max(0.0, temperature),
            top_p=top_p,
            stream=True,
        )
        for event in stream:
            choices = event.get("choices") if isinstance(event, dict) else None
            if not choices:
                continue
            delta = choices[0].get("delta")
            if not isinstance(delta, dict):
                continue
            text = delta.get("content")
            if not text:
                continue
            output_parts.append(text)
            yield text
        final_text = "".join(output_parts)
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        generated_tokens = len(self.encode(final_text)) if final_text else 0
        tokens_per_second = 0.0
        if elapsed_ms > 0 and generated_tokens > 0:
            tokens_per_second = round(generated_tokens / (elapsed_ms / 1000), 2)
        self.last_generation_stats = {
            "promptTokens": len(self.encode(json_safe_message_dump(normalized_messages))),
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
        if not self.is_loaded or self.model is None:
            raise RuntimeError("No llama.cpp model loaded")

        normalized_messages = []
        input_chars = 0
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "user").strip().lower() or "user"
            if role not in {"system", "user", "assistant", "tool"}:
                role = "user"
            content = message.get("content")
            if isinstance(content, str):
                text = content
            elif content is None:
                text = ""
            else:
                text = str(content)
            normalized_messages.append({"role": role, "content": text})
            input_chars += len(text)

        if tools:
            live_info_guidance = None
            memory_guidance = None
            spreadsheet_guidance = None
            latest_user_text = _latest_user_message_text(normalized_messages)
            latest_tool_text = _latest_tool_message_text(normalized_messages)
            conversation_user_text = _all_user_message_text(normalized_messages)
            available_tool_names = _extract_available_tool_names(tools)
            if latest_user_text and LIVE_INFO_REQUEST_RE.search(latest_user_text):
                live_info_guidance = (
                    "Latest user request needs live external information. "
                    "You must call an information-gathering tool before answering. "
                    "Do not answer from memory. "
                    "Do not narrate your plan. "
                    "If the first tool fails, immediately try another information-gathering tool when one is available. "
                    "Only explain the failure if no suitable fallback tool is available."
                )
            if latest_user_text and MEMORY_REQUEST_RE.search(latest_user_text):
                memory_guidance = (
                    "Latest user request is about MEMORY. "
                    "Use memory_search first when you need to find relevant notes. "
                    "Only use memory_get if you specifically need to fetch a snippet or read a returned entry. "
                    "After a successful MEMORY result, answer directly from that result instead of calling memory_search again."
                )
            if latest_user_text and SPREADSHEET_REQUEST_RE.search(latest_user_text):
                if CLOUD_SPREADSHEET_NEGATION_RE.search(conversation_user_text):
                    spreadsheet_guidance = (
                        "Latest user request is for a spreadsheet and the user explicitly rejected Google Sheets or Drive. "
                        "Use local workspace tools only. Create a local CSV or XLSX-compatible file and report the exact local path."
                    )
                elif CLOUD_SPREADSHEET_HINT_RE.search(conversation_user_text):
                    spreadsheet_guidance = (
                        "Latest user request is for a spreadsheet and the user explicitly mentioned Google Sheets or Drive. "
                        "Prefer the matching Sheets or Drive tool and report the created sheet id or link."
                    )
                else:
                    spreadsheet_guidance = (
                        "Latest user request is for a spreadsheet or Excel-compatible file. "
                        "Prefer local workspace tools such as write, edit, read, or exec. "
                        "Do not assume Google Sheets or Google Drive unless the user explicitly asked for them. "
                        "Create a local CSV or XLSX-compatible file when practical and report the exact local file path in the final answer."
                    )
                    if LOCAL_FILE_HINT_RE.search(conversation_user_text):
                        spreadsheet_guidance += (
                            " The user explicitly wants a local filesystem or workspace result, so do not use cloud spreadsheet tools."
                        )
            fallback_guidance = None
            if (
                latest_tool_text
                and "missing_brave_api_key" in latest_tool_text.lower()
                and available_tool_names.intersection({"web_fetch", "browser"})
            ):
                fallback_guidance = (
                    "The previous tool attempt failed because web_search is unavailable "
                    "(missing_brave_api_key). Do not call web_search again in this conversation. "
                    "Use web_fetch or browser now. Do not answer from memory."
                )
                if "weather" in (latest_user_text or "").lower() and "web_fetch" in available_tool_names:
                    location_query = _derive_weather_location_query(latest_user_text)
                    if location_query:
                        fallback_guidance += (
                            f" For this weather request, prefer a direct web_fetch call to "
                            f"https://wttr.in/{location_query}?format=j1."
                        )
            normalized_messages = [
                {"role": "system", "content": LOCAL_TOOL_USE_SYSTEM_GUIDANCE},
                *([{"role": "system", "content": live_info_guidance}] if live_info_guidance else []),
                *([{"role": "system", "content": memory_guidance}] if memory_guidance else []),
                *([{"role": "system", "content": spreadsheet_guidance}] if spreadsheet_guidance else []),
                *([{"role": "system", "content": fallback_guidance}] if fallback_guidance else []),
                *normalized_messages,
            ]

        started_at = time.perf_counter()
        request: Dict[str, Any] = {
            "messages": normalized_messages,
            "max_tokens": max_tokens,
            "temperature": max(0.0, temperature),
            "top_p": top_p,
            "stream": False,
        }
        if tools:
            request["tools"] = tools
        if tool_choice is not None:
            request["tool_choice"] = tool_choice
        response = self.model.create_chat_completion(**request)

        choices = response.get("choices") if isinstance(response, dict) else None
        first_choice = choices[0] if isinstance(choices, list) and choices else {}
        message = first_choice.get("message") if isinstance(first_choice, dict) else {}
        content = message.get("content") if isinstance(message, dict) else ""
        if not isinstance(content, str):
            content = str(content or "")
        usage = response.get("usage") if isinstance(response, dict) else {}
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        prompt_tokens = usage.get("prompt_tokens")
        if not isinstance(prompt_tokens, int):
            prompt_tokens = len(self.encode(json_safe_message_dump(normalized_messages)))
        generated_tokens = usage.get("completion_tokens")
        if not isinstance(generated_tokens, int):
            generated_tokens = len(self.encode(content)) if content else 0
        tokens_per_second = 0.0
        if elapsed_ms > 0 and generated_tokens > 0:
            tokens_per_second = round(generated_tokens / (elapsed_ms / 1000), 2)
        self.last_generation_stats = {
            "promptTokens": prompt_tokens,
            "inputChars": input_chars,
            "generatedTokens": generated_tokens,
            "generatedChars": len(content),
            "decodeElapsedMs": elapsed_ms,
            "tokensPerSecond": tokens_per_second,
        }
        return response

    def encode(self, text: str) -> list:
        if self.model is None:
            raise RuntimeError("No llama.cpp model available")
        return list(self.model.tokenize(text.encode("utf-8"), add_bos=False))

    def decode(self, tokens: list) -> str:
        if self.model is None:
            raise RuntimeError("No llama.cpp model available")
        return self.model.detokenize(tokens).decode("utf-8", errors="replace")


def json_safe_message_dump(messages: list) -> str:
    lines = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user")
        content = message.get("content")
        if not isinstance(content, str):
            content = str(content or "")
        lines.append(f"{role}: {content}")
    return "\n".join(lines)
