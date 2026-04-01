import os
import threading
import time
from pathlib import Path
from typing import Dict, Generator

from engine import InferenceEngine


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _hf_remote_code_allowed(model_path: str) -> bool:
    if _env_flag("ENTROPIC_HF_TRUST_REMOTE_CODE"):
        return True

    allowlist = {
        entry.strip().lower()
        for entry in os.environ.get("ENTROPIC_HF_TRUST_REMOTE_CODE_ALLOWLIST", "").split(",")
        if entry.strip()
    }
    if not allowlist:
        return False

    resolved = Path(model_path).expanduser().resolve()
    candidates = {
        model_path.strip().lower(),
        os.path.basename(model_path.rstrip(os.sep)).lower(),
        str(resolved).lower(),
        resolved.name.lower(),
    }
    return any(candidate in allowlist for candidate in candidates)


def _remote_code_error(model_name: str) -> RuntimeError:
    return RuntimeError(
        "Managed Hugging Face remote code is disabled by default for security. "
        f"Model '{model_name}' requires trust_remote_code. "
        "To trust only this model, set "
        f"ENTROPIC_HF_TRUST_REMOTE_CODE_ALLOWLIST={model_name}. "
        "To trust all Hugging Face models for this session, set "
        "ENTROPIC_HF_TRUST_REMOTE_CODE=1 and restart the managed runtime."
    )


def _looks_like_remote_code_requirement(error: Exception) -> bool:
    message = str(error).lower()
    return "trust_remote_code" in message or "requires you to execute the configuration file" in message


class HFEngine(InferenceEngine):
    name = "huggingface"
    architecture = "hf"

    def __init__(self):
        super().__init__()
        self.tokenizer = None
        self._device = "cpu"

    def load(self, model_path: str) -> Dict[str, object]:
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer
        except ImportError as error:
            raise RuntimeError(
                "transformers and torch are required to load Hugging Face RNN/SSM models"
            ) from error

        started_at = time.time()
        self._streamer_class = TextIteratorStreamer
        self._torch = torch
        self._device = self.detect_device()
        allow_remote_code = _hf_remote_code_allowed(model_path)
        model_name = os.path.basename(model_path.rstrip(os.sep))

        try:
            self.tokenizer = AutoTokenizer.from_pretrained(
                model_path,
                trust_remote_code=allow_remote_code,
            )
            self.model = AutoModelForCausalLM.from_pretrained(
                model_path,
                torch_dtype=torch.float32,
                trust_remote_code=allow_remote_code,
            ).to(self._device)
        except Exception as error:
            if not allow_remote_code and _looks_like_remote_code_requirement(error):
                raise _remote_code_error(model_name) from error
            raise
        self.model.eval()

        self.model_path = model_path
        self.model_name = model_name
        self.is_loaded = True
        self.model_info = {
            "device": self._device,
            "load_time": round(time.time() - started_at, 2),
        }
        return self.model_info

    def unload(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
        if self.tokenizer is not None:
            del self.tokenizer
            self.tokenizer = None
        if hasattr(self, "_torch"):
            if self._torch.backends.mps.is_available():
                self._torch.mps.empty_cache()
            elif self._torch.cuda.is_available():
                self._torch.cuda.empty_cache()
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
        if not self.is_loaded or self.model is None or self.tokenizer is None:
            raise RuntimeError("No model loaded")

        inputs = self.tokenizer(prompt, return_tensors="pt").to(self._device)
        streamer = self._streamer_class(
            self.tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )
        generation_kwargs = {
            **inputs,
            "max_new_tokens": max_tokens,
            "temperature": max(temperature, 0.01),
            "top_p": top_p,
            "do_sample": temperature > 0.01,
            "streamer": streamer,
        }

        worker = threading.Thread(target=self.model.generate, kwargs=generation_kwargs)
        worker.start()
        for text in streamer:
            if text:
                yield text
        worker.join()

    def encode(self, text: str) -> list:
        return self.tokenizer.encode(text)

    def decode(self, tokens: list) -> str:
        return self.tokenizer.decode(tokens, skip_special_tokens=True)
