import os
import re
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, Generator, List, Optional

import torch

from engine import InferenceEngine
from albatross_reference.rwkv7 import RWKV_x070
from albatross_reference.utils import TRIE_TOKENIZER, sample_logits


class AlbatrossEngine(InferenceEngine):
    name = "albatross"
    architecture = "rwkv"

    def __init__(self, tokenizer_path: str):
        super().__init__()
        self.tokenizer_path = tokenizer_path
        self.tokenizer: Optional[TRIE_TOKENIZER] = None
        self.state: Optional[List[torch.Tensor]] = None
        self.init_state: Optional[List[torch.Tensor]] = None

    def _clone_state(self, state: List[torch.Tensor]) -> List[torch.Tensor]:
        return [tensor.clone() for tensor in state]

    def load(self, model_path: str) -> Dict[str, object]:
        tokenizer_path = Path(self.tokenizer_path)
        if not tokenizer_path.exists():
            raise RuntimeError(
                f"RWKV tokenizer not found at {self.tokenizer_path}. Download the tokenizer first."
            )
        if not torch.cuda.is_available():
            raise RuntimeError("Albatross requires a CUDA-capable GPU.")

        started_at = time.time()
        self.device = "cuda"
        self.tokenizer = TRIE_TOKENIZER(str(tokenizer_path))
        model_root = model_path[:-4] if model_path.endswith(".pth") else model_path
        if not Path(f"{model_root}.pth").exists():
            raise RuntimeError(f"Managed runtime could not find the Albatross model file: {model_path}")

        args = SimpleNamespace(MODEL_NAME=model_root)
        self.model = RWKV_x070(args)
        self.model_path = model_path
        self.model_name = os.path.basename(model_root)
        self.is_loaded = True

        self.state = self.model.generate_zero_state(0)
        self._prime_state()
        self.init_state = self._clone_state(self.state)

        self.model_info = {
            "backend": self.name,
            "device": self.device,
            "nLayer": getattr(self.model.args, "n_layer", None),
            "nEmbd": getattr(self.model.args, "n_embd", None),
            "headSize": getattr(self.model.args, "head_size", None),
            "vocabSize": getattr(self.model.args, "vocab_size", None),
            "loadTime": round(time.time() - started_at, 2),
            "fileSizeGb": round(os.path.getsize(model_path) / 1024**3, 2),
        }
        return self.model_info

    def _prime_state(self) -> None:
        if self.tokenizer is None or self.state is None or self.model is None:
            return
        system_prompt = (
            "You are a helpful, knowledgeable AI assistant.\n\n"
            "User: Please reply briefly and clearly.\n\n"
            "Assistant: Certainly.\n\n"
        )
        self.reset()
        for token in self.tokenizer.encode(system_prompt):
            self.model.forward(token, self.state)

    def generate_stream(
        self,
        prompt: str,
        temperature: float = 1.0,
        top_p: float = 0.7,
        max_tokens: int = 500,
    ) -> Generator[str, None, None]:
        if not self.is_loaded or self.model is None or self.tokenizer is None or self.state is None:
            raise RuntimeError("No Albatross model loaded")

        prompt_tokens = self.tokenizer.encode(prompt)
        emit_initial_think = prompt.endswith("<think\n")
        if emit_initial_think:
            yield "<think>\n"

        out = None
        for token in prompt_tokens:
            out = self.model.forward(token, self.state)
        if out is None:
            raise RuntimeError("Albatross forward pass failed")

        all_tokens: List[int] = []
        stop_pattern = re.compile(
            r"(?:\r?\n)+\s*(?:User|Assistant|System|Tool)(?:\s*:|\b)|(?:^|\n)\s*#{1,3}\s*Context Checkpoint\b|<\|endoftext\|>",
            re.IGNORECASE,
        )
        trailing_turn_pattern = re.compile(
            r"(?:\r?\n)+\s*(?:User|Assistant|System|Tool)\s*:?\s*$"
        )
        checkpoint_pattern = re.compile(r"(?is)(?:^|\n)\s*#{1,3}\s*Context Checkpoint\b.*$")
        emitted_text = ""
        holdback_chars = 24
        in_thinking = emit_initial_think
        decode_started_at = time.perf_counter()
        for _ in range(max_tokens):
            if temperature <= 0.01:
                token = int(torch.argmax(out).item())
            else:
                token = sample_logits(out, temperature=temperature, top_p=top_p)
            all_tokens.append(token)
            decoded = self.tokenizer.decode(all_tokens, utf8_errors="replace")

            if not in_thinking and "<think>" in decoded:
                in_thinking = True
            if in_thinking and "</think>" in decoded:
                in_thinking = False

            stop_match = stop_pattern.search(decoded)
            if stop_match:
                remaining = decoded[: stop_match.start()].rstrip()
                new_text = remaining[len(emitted_text) :]
                if new_text and "\ufffd" not in new_text:
                    yield new_text
                emitted_text = remaining
                break

            safe_output = decoded
            if len(decoded) > holdback_chars:
                safe_output = decoded[:-holdback_chars]

            new_text = safe_output[len(emitted_text) :]
            if new_text and "\ufffd" not in new_text:
                yield new_text
                emitted_text = safe_output

            out = self.model.forward(token, self.state)

            if decoded.endswith("\n\n") and len(all_tokens) > 100 and not in_thinking:
                break
            if decoded.endswith("\n\n\n") and len(all_tokens) > 30 and not in_thinking:
                break

        final_text = self.tokenizer.decode(all_tokens, utf8_errors="replace")
        final_text = re.sub(r"(?is)<\|endoftext\|>.*$", "", final_text)
        final_text = checkpoint_pattern.sub("", final_text)
        final_text = trailing_turn_pattern.sub("", final_text).rstrip()
        final_delta = final_text[len(emitted_text) :]
        if final_delta and "\ufffd" not in final_delta:
            yield final_delta
        elapsed_ms = round((time.perf_counter() - decode_started_at) * 1000)
        generated_tokens = len(all_tokens)
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

    def reset(self) -> None:
        if self.init_state is not None:
            self.state = self._clone_state(self.init_state)

    def unload(self) -> None:
        self.model = None
        self.state = None
        self.init_state = None
        self.tokenizer = None
        self.is_loaded = False
        self.model_name = None
        self.model_path = None
        self.model_info = {}
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def encode(self, text: str) -> list:
        if self.tokenizer is None:
            raise RuntimeError("No Albatross tokenizer available")
        return self.tokenizer.encode(text)

    def decode(self, tokens: list) -> str:
        if self.tokenizer is None:
            raise RuntimeError("No Albatross tokenizer available")
        return self.tokenizer.decode(tokens, utf8_errors="replace")
