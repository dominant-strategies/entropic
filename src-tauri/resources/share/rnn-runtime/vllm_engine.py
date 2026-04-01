import os
import time
from typing import Any, Dict, Generator, Optional

from engine import InferenceEngine


class VllmEngine(InferenceEngine):
    name = "vllm"
    architecture = "transformer"

    def __init__(self, runtime_config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.tokenizer = None
        self._device = "cpu"
        self._sampling_params_class = None
        self.runtime_config = runtime_config or {}

    def _normalized_runtime_config(self) -> Dict[str, Any]:
        max_model_len = self.runtime_config.get("maxModelLen")
        try:
            normalized_max_model_len = (
                int(max_model_len) if max_model_len is not None and str(max_model_len).strip() else None
            )
        except (TypeError, ValueError):
            normalized_max_model_len = None

        return {
            "gpuMemoryUtilization": float(self.runtime_config.get("gpuMemoryUtilization", 0.9)),
            "kvCacheDtype": str(self.runtime_config.get("kvCacheDtype", "auto") or "auto"),
            "calculateKvScales": bool(self.runtime_config.get("calculateKvScales", False)),
            "cpuOffloadGb": float(self.runtime_config.get("cpuOffloadGb", 0.0) or 0.0),
            "swapSpace": float(self.runtime_config.get("swapSpace", 4.0) or 4.0),
            "enablePrefixCaching": bool(self.runtime_config.get("enablePrefixCaching", True)),
            "enforceEager": bool(self.runtime_config.get("enforceEager", False)),
            "maxModelLen": normalized_max_model_len,
        }

    def load(self, model_path: str) -> Dict[str, object]:
        try:
            import torch
            from transformers import AutoTokenizer
            from vllm import LLM, SamplingParams
        except ImportError as error:
            raise RuntimeError(
                "vLLM, transformers, and torch are required to load managed transformer models."
            ) from error

        started_at = time.time()
        self._torch = torch
        self._device = self.detect_device()
        self._sampling_params_class = SamplingParams
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        runtime_config = self._normalized_runtime_config()
        llm_args: Dict[str, Any] = {
            "model": model_path,
            "trust_remote_code": True,
            "dtype": "auto",
            "gpu_memory_utilization": runtime_config["gpuMemoryUtilization"],
            "cpu_offload_gb": runtime_config["cpuOffloadGb"],
            "swap_space": runtime_config["swapSpace"],
            "enable_prefix_caching": runtime_config["enablePrefixCaching"],
            "enforce_eager": runtime_config["enforceEager"],
            "calculate_kv_scales": runtime_config["calculateKvScales"],
        }
        if runtime_config["maxModelLen"] is not None:
            llm_args["max_model_len"] = runtime_config["maxModelLen"]
        if runtime_config["kvCacheDtype"] not in {"", "auto"}:
            llm_args["kv_cache_dtype"] = runtime_config["kvCacheDtype"]

        self.model = LLM(
            **llm_args,
        )
        self.model_path = model_path
        self.model_name = os.path.basename(model_path.rstrip(os.sep))
        self.is_loaded = True
        self.model_info = {
            "device": self._device,
            "backend": self.name,
            "load_time": round(time.time() - started_at, 2),
            "runtimeConfig": runtime_config,
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
        if not self.is_loaded or self.model is None or self._sampling_params_class is None:
            raise RuntimeError("No model loaded")

        sampling_params = self._sampling_params_class(
            temperature=0.0 if temperature <= 0.01 else temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        )
        outputs = self.model.generate([prompt], sampling_params, use_tqdm=False)
        if not outputs:
            return
        text = "".join(output.text for output in outputs[0].outputs)
        if text:
            yield text

    def encode(self, text: str) -> list:
        return self.tokenizer.encode(text)

    def decode(self, tokens: list) -> str:
        return self.tokenizer.decode(tokens, skip_special_tokens=True)
