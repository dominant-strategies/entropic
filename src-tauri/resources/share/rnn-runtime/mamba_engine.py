import os
import threading
import time
from typing import Dict, Generator

from engine import InferenceEngine


class MambaEngine(InferenceEngine):
    name = "mamba"
    architecture = "mamba"

    def __init__(self):
        super().__init__()
        self.tokenizer = None
        self._device = "cpu"

    def load(self, model_path: str) -> Dict[str, object]:
        try:
            import torch
            from transformers import AutoTokenizer, MambaForCausalLM, TextIteratorStreamer
        except ImportError as error:
            raise RuntimeError(
                "transformers and torch are required to load Mamba models"
            ) from error

        started_at = time.time()
        self._streamer_class = TextIteratorStreamer
        self._torch = torch
        self._device = self.detect_device()

        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.model = MambaForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.float32,
            trust_remote_code=True,
        ).to(self._device)
        self.model.eval()

        self.model_path = model_path
        self.model_name = os.path.basename(model_path.rstrip(os.sep))
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

        input_ids = self.tokenizer.encode(prompt, return_tensors="pt").to(self._device)
        streamer = self._streamer_class(
            self.tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )
        generation_kwargs = {
            "input_ids": input_ids,
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
