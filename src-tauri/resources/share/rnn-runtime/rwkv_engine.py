import copy
import os
import re
import time
from typing import Dict, Generator, List, Optional

import torch
import torch.nn.functional as F

from catalog import TOKENIZER_FILENAME
from engine import InferenceEngine


RWKV_CONFIGS = {
    768: (12, "0.1B"),
    1024: (24, "0.4B"),
    1280: (24, "0.5B"),
    2048: (24, "1.5B"),
    2560: (32, "2.9B"),
    4096: (32, "7.2B"),
    5120: (40, "13.3B"),
}


class RWKVTokenizer:
    def __init__(self, file_name: str):
        self.idx2token = {}
        sorted_tokens = []
        lines = open(file_name, "r", encoding="utf-8").readlines()
        for line in lines:
            index = int(line[: line.index(" ")])
            token = eval(line[line.index(" ") : line.rindex(" ")])
            token = token.encode("utf-8") if isinstance(token, str) else token
            sorted_tokens.append(token)
            self.idx2token[index] = token

        self.token2idx = {value: int(key) for key, value in self.idx2token.items()}
        self.table = [[[] for _ in range(256)] for _ in range(256)]
        self.good = [set() for _ in range(256)]
        self.wlen = [0 for _ in range(256)]

        for token in reversed(sorted_tokens):
            if len(token) < 2:
                continue
            first = int(token[0])
            second = int(token[1])
            self.table[first][second].append(token)
            self.good[first].add(second)
            self.wlen[first] = max(self.wlen[first], len(token))

    def encode(self, src: str) -> list:
        data = src.encode("utf-8")
        tokens = []
        index = 0
        while index < len(data):
            token = data[index : index + 1]
            if index < len(data) - 1:
                first = int(data[index])
                second = int(data[index + 1])
                if second in self.good[first]:
                    window = data[index : index + self.wlen[first]]
                    try:
                        token = next(filter(window.startswith, self.table[first][second]))
                    except StopIteration:
                        pass
            tokens.append(self.token2idx[token])
            index += len(token)
        return tokens

    def decode(self, tokens: list) -> str:
        return b"".join(self.idx2token[token] for token in tokens).decode(
            "utf-8", errors="replace"
        )


def _v7_time_mixing(
    layer_id,
    n_head,
    head_size,
    x,
    x_prev,
    v_first,
    state,
    x_r,
    x_w,
    x_k,
    x_v,
    x_a,
    x_g,
    w0,
    w1,
    w2,
    a0,
    a1,
    a2,
    v0,
    v1,
    v2,
    g1,
    g2,
    k_k,
    k_a,
    r_k,
    kw,
    vw,
    rw,
    ow,
    ln_w,
    ln_b,
):
    xx = x_prev - x
    xr = x + xx * x_r
    xw = x + xx * x_w
    xk = x + xx * x_k
    xv = x + xx * x_v
    xa = x + xx * x_a
    xg = x + xx * x_g

    r = rw @ xr
    w = torch.tanh(xw @ w1) @ w2
    k = kw @ xk
    v = vw @ xv
    a = torch.sigmoid(a0 + (xa @ a1) @ a2)
    g = torch.sigmoid(xg @ g1) @ g2

    kk = k * k_k
    kk = F.normalize(kk.view(n_head, head_size), dim=-1, p=2.0).view(-1)
    k = k * (1 + (a - 1) * k_a)

    if layer_id == 0:
        v_first = v
    else:
        v = v + (v_first - v) * torch.sigmoid(v0 + (xv @ v1) @ v2)

    w = w0 + w.float()
    w = torch.exp(-0.606531 * torch.sigmoid(w))

    vk = v.view(n_head, head_size, 1) @ k.view(n_head, 1, head_size)
    ab = (-kk).view(n_head, head_size, 1) @ (kk * a).view(n_head, 1, head_size)
    state = state.float() * w.view(n_head, 1, head_size) + state.float() @ ab.float() + vk.float()
    state = state.to(dtype=x.dtype)
    out = state @ r.view(n_head, head_size, 1)

    out = F.group_norm(
        out.view(1, n_head * head_size),
        num_groups=n_head,
        weight=ln_w,
        bias=ln_b,
        eps=64e-5,
    ).view(n_head * head_size)
    out = out + ((r * k * r_k).view(n_head, head_size).sum(dim=-1, keepdim=True) * v.view(n_head, head_size)).view(
        n_head * head_size
    )
    return ow @ (out * g), x, state, v_first


def _v7_channel_mixing(x, x_prev, x_k, kw, vw):
    xx = x_prev - x
    k = x + xx * x_k
    k = torch.relu(kw @ k) ** 2
    return vw @ k, x


def _v6_time_mixing(
    x,
    state,
    layer_id,
    n_head,
    head_size,
    time_maa_x,
    time_maa_w,
    time_maa_k,
    time_maa_v,
    time_maa_r,
    time_maa_g,
    time_maa_w1,
    time_maa_w2,
    time_decay_w1,
    time_decay_w2,
    time_faaaa,
    time_decay,
    kw,
    vw,
    rw,
    gw,
    ow,
    ln_w,
    ln_b,
):
    sx = state[layer_id * 3 + 0] - x
    state[layer_id * 3 + 0] = x

    xxx = x + sx * time_maa_x
    xxx = torch.tanh(xxx @ time_maa_w1).view(5, 1, -1)
    xxx = torch.bmm(xxx, time_maa_w2).view(5, -1)
    mw, mk, mv, mr, mg = xxx.unbind(dim=0)

    xw = x + sx * (time_maa_w + mw)
    xk = x + sx * (time_maa_k + mk)
    xv = x + sx * (time_maa_v + mv)
    xr = x + sx * (time_maa_r + mr)
    xg = x + sx * (time_maa_g + mg)

    w = time_decay + (torch.tanh(xw @ time_decay_w1) @ time_decay_w2).float()
    w = torch.exp(-torch.exp(w.clamp(-100, 5)))

    r = rw @ xr
    k = kw @ xk
    v = vw @ xv
    g = F.silu(gw @ xg)

    kk = k.view(n_head, head_size)
    vv = v.view(n_head, head_size)
    rr = r.view(n_head, head_size)

    s = state[layer_id * 3 + 1].view(n_head, head_size, head_size).float()
    ww = w.view(n_head, head_size)

    a = kk.float().unsqueeze(-1) @ vv.float().unsqueeze(-2)
    out = (rr.float().unsqueeze(-2) @ s).squeeze(-2)
    s = s * ww.unsqueeze(-1).float() + a
    state[layer_id * 3 + 1] = s.view(n_head, head_size, head_size)

    out = out.view(1, n_head * head_size)
    out = F.group_norm(out, num_groups=n_head, weight=ln_w, bias=ln_b, eps=64e-5).view(
        n_head * head_size
    )
    return ow @ (out.to(dtype=x.dtype) * g), state


def _v6_channel_mixing(x, state, layer_id, time_maa_k, time_maa_r, kw, vw, rw):
    sx = state[layer_id * 3 + 2] - x
    state[layer_id * 3 + 2] = x
    xk = x + sx * time_maa_k
    xr = x + sx * time_maa_r
    r = torch.sigmoid(rw @ xr)
    k = torch.relu(kw @ xk) ** 2
    return r * (vw @ k), state


class RWKVEngine(InferenceEngine):
    name = "rwkv"
    architecture = "rwkv"

    def __init__(self, tokenizer_path: str):
        super().__init__()
        self.tokenizer_path = tokenizer_path
        self.tokenizer: Optional[RWKVTokenizer] = (
            RWKVTokenizer(tokenizer_path) if os.path.exists(tokenizer_path) else None
        )
        self.weights = None
        self.version = None
        self.n_layer = 0
        self.n_embd = 0
        self.n_head = 0
        self.head_size = 64
        self.state = None
        self.init_state = None

    def _detect_version(self, keys: List[str]) -> int:
        for key in keys:
            if "att.x_a" in key:
                return 7
            if "time_maa_x" in key:
                return 6
        return 6

    def load(self, model_path: str) -> Dict[str, object]:
        if self.tokenizer is None:
            raise RuntimeError(
                f"RWKV tokenizer not found at {self.tokenizer_path}. Download the tokenizer first."
            )

        self.device = self.detect_device()
        dtype = torch.float16
        started_at = time.time()

        weights = torch.load(model_path, map_location="cpu", weights_only=True)
        self.version = self._detect_version(list(weights.keys()))
        self.n_embd = weights["blocks.0.ln1.weight"].shape[0]
        self.n_layer, size_name = RWKV_CONFIGS.get(
            self.n_embd, (32, f"~{self.n_embd // 256 * 256 / 1000:.1f}B?")
        )

        if self.version == 7:
            self.n_head, self.head_size = weights["blocks.0.att.r_k"].shape
        else:
            self.n_head = weights["blocks.0.att.time_faaaa"].shape[0]
            self.head_size = self.n_embd // self.n_head

        if self.version == 7:
            for key in list(weights.keys()):
                weights[key] = weights[key].to(device=self.device)
                if key.endswith("att.w0"):
                    weights[key] = weights[key].float().to(device=self.device)
                else:
                    weights[key] = weights[key].to(dtype=dtype, device=self.device)
                weights[key] = weights[key].squeeze()
                if key.endswith("att.r_k"):
                    weights[key] = weights[key].flatten()
            weights["emb.weight"] = F.layer_norm(
                weights["emb.weight"],
                (self.n_embd,),
                weight=weights["blocks.0.ln0.weight"],
                bias=weights["blocks.0.ln0.bias"],
            )
            weights["blocks.0.att.v0"] = weights["blocks.0.att.a0"]
            weights["blocks.0.att.v1"] = weights["blocks.0.att.a1"]
            weights["blocks.0.att.v2"] = weights["blocks.0.att.a2"]
        else:
            for key in list(weights.keys()):
                if ".time_" in key:
                    weights[key] = weights[key].float().to(device=self.device).squeeze()
                else:
                    weights[key] = weights[key].to(dtype=dtype, device=self.device)
                if ".time_faaaa" in key:
                    weights[key] = weights[key].unsqueeze(-1)

        self.weights = weights
        self.model_path = model_path
        self.model_name = os.path.basename(model_path).replace(".pth", "")
        self.is_loaded = True
        self._init_state()

        self.model_info = {
            "version": f"v{self.version}",
            "size": size_name,
            "n_layer": self.n_layer,
            "n_embd": self.n_embd,
            "n_head": self.n_head,
            "head_size": self.head_size,
            "device": self.device,
            "load_time": round(time.time() - started_at, 2),
            "file_size_gb": round(os.path.getsize(model_path) / 1024**3, 2),
        }
        return self.model_info

    def _make_state(self) -> list:
        state = [None] * (self.n_layer * 3)
        for index in range(self.n_layer):
            state[index * 3 + 0] = torch.zeros(self.n_embd, dtype=torch.float16, device=self.device)
            state[index * 3 + 1] = torch.zeros(
                (self.n_head, self.head_size, self.head_size),
                dtype=torch.float,
                device=self.device,
            )
            state[index * 3 + 2] = torch.zeros(self.n_embd, dtype=torch.float16, device=self.device)
        return state

    def _init_state(self) -> None:
        self.state = self._make_state()
        system_prompt = (
            "You are a helpful, knowledgeable AI assistant.\n\n"
            "User: Please reply briefly and clearly.\n\n"
            "Assistant: Certainly.\n\n"
        )
        for token in self.tokenizer.encode(system_prompt):
            self._forward(token)
        self.init_state = copy.deepcopy(self.state)

    def _forward(self, token: int) -> torch.Tensor:
        if self.version == 7:
            return self._forward_v7(token)
        return self._forward_v6(token)

    def _forward_v7(self, token: int) -> torch.Tensor:
        with torch.no_grad():
            weights = self.weights
            x = weights["emb.weight"][token]
            v_first = torch.empty_like(x)
            for index in range(self.n_layer):
                prefix = f"blocks.{index}."
                att = f"{prefix}att."
                ffn = f"{prefix}ffn."

                xx = F.layer_norm(
                    x,
                    (self.n_embd,),
                    weight=weights[f"{prefix}ln1.weight"],
                    bias=weights[f"{prefix}ln1.bias"],
                )
                xx, self.state[index * 3 + 0], self.state[index * 3 + 1], v_first = _v7_time_mixing(
                    index,
                    self.n_head,
                    self.head_size,
                    xx,
                    self.state[index * 3 + 0],
                    v_first,
                    self.state[index * 3 + 1],
                    weights[f"{att}x_r"],
                    weights[f"{att}x_w"],
                    weights[f"{att}x_k"],
                    weights[f"{att}x_v"],
                    weights[f"{att}x_a"],
                    weights[f"{att}x_g"],
                    weights[f"{att}w0"],
                    weights[f"{att}w1"],
                    weights[f"{att}w2"],
                    weights[f"{att}a0"],
                    weights[f"{att}a1"],
                    weights[f"{att}a2"],
                    weights[f"{att}v0"],
                    weights[f"{att}v1"],
                    weights[f"{att}v2"],
                    weights[f"{att}g1"],
                    weights[f"{att}g2"],
                    weights[f"{att}k_k"],
                    weights[f"{att}k_a"],
                    weights[f"{att}r_k"],
                    weights[f"{att}key.weight"],
                    weights[f"{att}value.weight"],
                    weights[f"{att}receptance.weight"],
                    weights[f"{att}output.weight"],
                    weights[f"{att}ln_x.weight"],
                    weights[f"{att}ln_x.bias"],
                )
                x = x + xx

                xx = F.layer_norm(
                    x,
                    (self.n_embd,),
                    weight=weights[f"{prefix}ln2.weight"],
                    bias=weights[f"{prefix}ln2.bias"],
                )
                xx, self.state[index * 3 + 2] = _v7_channel_mixing(
                    xx,
                    self.state[index * 3 + 2],
                    weights[f"{ffn}x_k"],
                    weights[f"{ffn}key.weight"],
                    weights[f"{ffn}value.weight"],
                )
                x = x + xx

            x = F.layer_norm(
                x,
                (self.n_embd,),
                weight=weights["ln_out.weight"],
                bias=weights["ln_out.bias"],
            )
            return weights["head.weight"] @ x

    def _forward_v6(self, token: int) -> torch.Tensor:
        with torch.no_grad():
            weights = self.weights
            x = weights["emb.weight"][token]
            x = F.layer_norm(
                x,
                (self.n_embd,),
                weight=weights["blocks.0.ln0.weight"],
                bias=weights["blocks.0.ln0.bias"],
            )

            for index in range(self.n_layer):
                prefix = f"blocks.{index}."
                att = f"{prefix}att."
                ffn = f"{prefix}ffn."

                xx = F.layer_norm(
                    x,
                    (self.n_embd,),
                    weight=weights[f"{prefix}ln1.weight"],
                    bias=weights[f"{prefix}ln1.bias"],
                )
                xx, self.state = _v6_time_mixing(
                    xx,
                    self.state,
                    index,
                    self.n_head,
                    self.head_size,
                    weights[f"{att}time_maa_x"],
                    weights[f"{att}time_maa_w"],
                    weights[f"{att}time_maa_k"],
                    weights[f"{att}time_maa_v"],
                    weights[f"{att}time_maa_r"],
                    weights[f"{att}time_maa_g"],
                    weights[f"{att}time_maa_w1"],
                    weights[f"{att}time_maa_w2"],
                    weights[f"{att}time_decay_w1"],
                    weights[f"{att}time_decay_w2"],
                    weights[f"{att}time_faaaa"],
                    weights[f"{att}time_decay"],
                    weights[f"{att}key.weight"],
                    weights[f"{att}value.weight"],
                    weights[f"{att}receptance.weight"],
                    weights[f"{att}gate.weight"],
                    weights[f"{att}output.weight"],
                    weights[f"{att}ln_x.weight"],
                    weights[f"{att}ln_x.bias"],
                )
                x = x + xx

                xx = F.layer_norm(
                    x,
                    (self.n_embd,),
                    weight=weights[f"{prefix}ln2.weight"],
                    bias=weights[f"{prefix}ln2.bias"],
                )
                xx, self.state = _v6_channel_mixing(
                    xx,
                    self.state,
                    index,
                    weights[f"{ffn}time_maa_k"],
                    weights[f"{ffn}time_maa_r"],
                    weights[f"{ffn}key.weight"],
                    weights[f"{ffn}value.weight"],
                    weights[f"{ffn}receptance.weight"],
                )
                x = x + xx

            x = F.layer_norm(
                x,
                (self.n_embd,),
                weight=weights["ln_out.weight"],
                bias=weights["ln_out.bias"],
            )
            return weights["head.weight"] @ x

    def _sample(self, logits: torch.Tensor, temperature: float, top_p: float) -> int:
        probs = F.softmax(logits.float(), dim=-1)
        sorted_probs, _ = torch.sort(probs, descending=True)
        if top_p < 1:
            cumulative = torch.cumsum(sorted_probs, dim=-1)
            cutoff_index = torch.searchsorted(cumulative, top_p)
            cutoff = sorted_probs[cutoff_index]
            probs[probs < cutoff] = 0
        if temperature != 1.0:
            probs = probs ** (1.0 / temperature)
        probs = probs / probs.sum()
        return torch.multinomial(probs, num_samples=1).item()

    def generate_stream(
        self,
        prompt: str,
        temperature: float = 1.0,
        top_p: float = 0.7,
        max_tokens: int = 500,
    ) -> Generator[str, None, None]:
        if not self.is_loaded:
            raise RuntimeError("No model loaded")

        prompt_tokens = self.tokenizer.encode(prompt)
        emit_initial_think = prompt.endswith("<think\n")
        if emit_initial_think:
            yield "<think>\n"

        out = None
        for token in prompt_tokens:
            out = self._forward(token)
        if out is None:
            raise RuntimeError("RWKV forward pass failed")

        all_tokens: List[int] = []
        stop_pattern = re.compile(
            r"\n\s*User\s*:|(?:^|\n)\s*#{1,3}\s*Context Checkpoint\b|<\|endoftext\|>",
            re.IGNORECASE,
        )
        in_thinking = emit_initial_think

        for _ in range(max_tokens):
            token = self._sample(out, temperature, top_p)
            all_tokens.append(token)
            decoded = self.tokenizer.decode(all_tokens)

            if not in_thinking and "<think>" in decoded:
                in_thinking = True
            if in_thinking and "</think>" in decoded:
                in_thinking = False

            stop_match = stop_pattern.search(decoded)
            if stop_match:
                remaining = decoded[: stop_match.start()]
                previous = self.tokenizer.decode(all_tokens[:-1]) if len(all_tokens) > 1 else ""
                new_text = remaining[len(previous) :]
                if new_text and "\ufffd" not in new_text:
                    yield new_text
                break

            if decoded.endswith("\n\n") and len(all_tokens) > 100 and not in_thinking:
                break
            if decoded.endswith("\n\n\n") and len(all_tokens) > 30 and not in_thinking:
                break

            try:
                piece = self.tokenizer.decode([token])
                if piece and "\ufffd" not in piece:
                    yield piece
            except Exception:
                pass

            out = self._forward(token)

    def reset(self) -> None:
        if self.init_state is not None:
            self.state = copy.deepcopy(self.init_state)

    def unload(self) -> None:
        self.weights = None
        self.state = None
        self.init_state = None
        self.is_loaded = False
        self.model_name = None
        self.model_path = None
        self.model_info = {}
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()

    def encode(self, text: str) -> list:
        return self.tokenizer.encode(text)

    def decode(self, tokens: list) -> str:
        return self.tokenizer.decode(tokens)
