import json
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


MODEL_CATALOG: List[Dict[str, Any]] = [
    {
        "id": "rwkv7-g1-0.4b",
        "name": "RWKV-7 GooseOne 0.4B",
        "display_name": "GooseOne 0.4B",
        "hf_repo": "BlinkDL/rwkv7-g1",
        "hf_file": "rwkv7-g1d-0.4b-20260210-ctx8192.pth",
        "architecture": "rwkv",
        "backend": "albatross",
        "params": "0.4B",
        "size_gb": 0.9,
        "context": 8192,
        "description": "Small thinking model for low-RAM systems, served through the managed Albatross backend.",
        "thinking": True,
    },
    {
        "id": "rwkv7-g1-1.5b",
        "name": "RWKV-7 GooseOne 1.5B",
        "display_name": "GooseOne 1.5B",
        "hf_repo": "BlinkDL/rwkv7-g1",
        "hf_file": "rwkv7-g1d-1.5b-20260212-ctx8192.pth",
        "architecture": "rwkv",
        "backend": "albatross",
        "params": "1.5B",
        "size_gb": 3.0,
        "context": 8192,
        "description": "Balanced thinking model served through the managed Albatross backend.",
        "thinking": True,
    },
    {
        "id": "rwkv7-g1-2.9b",
        "name": "RWKV-7 GooseOne 2.9B",
        "display_name": "GooseOne 2.9B",
        "hf_repo": "BlinkDL/rwkv7-g1",
        "hf_file": "rwkv7-g1d-2.9b-20260131-ctx8192.pth",
        "architecture": "rwkv",
        "backend": "albatross",
        "params": "2.9B",
        "size_gb": 5.9,
        "context": 8192,
        "description": "Recommended RWKV thinking model for local use, served through the managed Albatross backend.",
        "thinking": True,
    },
    {
        "id": "rwkv7-g1e-7.2b",
        "name": "RWKV-7 GooseOne 7.2B (G1e)",
        "display_name": "GooseOne 7.2B",
        "hf_repo": "BlinkDL/rwkv7-g1",
        "hf_file": "rwkv7-g1e-7.2b-20260301-ctx8192.pth",
        "architecture": "rwkv",
        "backend": "albatross",
        "params": "7.2B",
        "size_gb": 14.4,
        "context": 8192,
        "description": "Largest curated RWKV thinking model in the first runtime slice, served through the managed Albatross backend.",
        "thinking": True,
    },
    {
        "id": "rwkv7-world-0.4b",
        "name": "RWKV-7 Goose World 0.4B",
        "display_name": "Goose World 0.4B",
        "hf_repo": "BlinkDL/rwkv-7-world",
        "hf_file": "RWKV-x070-World-0.4B-v2.9-20250107-ctx4096.pth",
        "architecture": "rwkv",
        "backend": "albatross",
        "params": "0.4B",
        "size_gb": 0.9,
        "context": 4096,
        "description": "Small multilingual RWKV model served through the managed Albatross backend.",
        "thinking": False,
    },
    {
        "id": "rwkv7-world-1.5b",
        "name": "RWKV-7 Goose World 1.5B",
        "display_name": "Goose World 1.5B",
        "hf_repo": "BlinkDL/rwkv-7-world",
        "hf_file": "RWKV-x070-World-1.5B-v3-20250127-ctx4096.pth",
        "architecture": "rwkv",
        "backend": "albatross",
        "params": "1.5B",
        "size_gb": 3.0,
        "context": 4096,
        "description": "Mid-size multilingual RWKV model served through the managed Albatross backend.",
        "thinking": False,
    },
    {
        "id": "rwkv7-world-2.9b",
        "name": "RWKV-7 Goose World 2.9B",
        "display_name": "Goose World 2.9B",
        "hf_repo": "BlinkDL/rwkv-7-world",
        "hf_file": "RWKV-x070-World-2.9B-v3-20250211-ctx4096.pth",
        "architecture": "rwkv",
        "backend": "albatross",
        "params": "2.9B",
        "size_gb": 5.5,
        "context": 4096,
        "description": "Recommended multilingual RWKV model served through the managed Albatross backend.",
        "thinking": False,
    },
    {
        "id": "rwkv7-g1e-13.3b-q4-k-m",
        "name": "RWKV-7 GooseOne 13.3B Q4_K_M (G1e)",
        "display_name": "RWKV7 G1e 13.3B",
        "hf_repo": "shoumenchougou/RWKV7-G1e-13.3b-GGUF",
        "hf_file": "rwkv7-g1e-13.3b-Q4_K_M-better_quantization-20260319.gguf",
        "architecture": "gguf",
        "backend": "llama-cpp",
        "params": "13.3B",
        "size_gb": 8.46,
        "context": 8192,
        "description": "Large quantized RWKV-7 GooseOne model served through the managed llama.cpp backend.",
        "thinking": True,
    },
    {
        "id": "rwkv7-g1e-7.2b-q4-k-m-gguf",
        "name": "RWKV-7 GooseOne 7.2B Q4_K_M (G1e GGUF)",
        "display_name": "RWKV7 G1e 7.2B",
        "hf_repo": "shoumenchougou/RWKV7-G1e-7.2B-GGUF",
        "hf_file": "rwkv7-g1e-7.2b-Q4_K_M-better_quantization-20260319.gguf",
        "architecture": "gguf",
        "backend": "llama-cpp",
        "params": "7.2B",
        "size_gb": 4.58,
        "context": 8192,
        "description": "Mid-size quantized RWKV-7 GooseOne model served through the managed llama.cpp backend.",
        "thinking": True,
    },
    {
        "id": "nemotron3-nano-4b-q4-k-m",
        "name": "NVIDIA Nemotron 3 Nano 4B Q4_K_M",
        "display_name": "Nemotron 3 Nano 4B",
        "hf_repo": "nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF",
        "hf_file": "NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf",
        "architecture": "gguf",
        "backend": "llama-cpp",
        "params": "4B",
        "size_gb": 2.84,
        "context": 32768,
        "description": "Edge-sized hybrid Mamba-Transformer model served through the managed llama.cpp backend.",
        "thinking": False,
    },
    {
        "id": "qwen3-4b-q4-k-m",
        "name": "Qwen3 4B Q4_K_M",
        "display_name": "Qwen3 4B",
        "hf_repo": "Qwen/Qwen3-4B-GGUF",
        "hf_file": "Qwen3-4B-Q4_K_M.gguf",
        "architecture": "gguf",
        "backend": "llama-cpp",
        "params": "4B",
        "size_gb": 2.5,
        "context": 32768,
        "description": "Compact general-purpose Qwen model with strong chat and tool-use potential through the managed llama.cpp backend.",
        "thinking": False,
    },
    {
        "id": "qwen3-8b-q4-k-m",
        "name": "Qwen3 8B Q4_K_M",
        "display_name": "Qwen3 8B",
        "hf_repo": "Qwen/Qwen3-8B-GGUF",
        "hf_file": "Qwen3-8B-Q4_K_M.gguf",
        "architecture": "gguf",
        "backend": "llama-cpp",
        "params": "8B",
        "size_gb": 5.03,
        "context": 32768,
        "description": "Larger Qwen local model tuned for stronger general chat, coding, and tool-use workloads through llama.cpp.",
        "thinking": False,
    },
    {
        "id": "bonsai-8b-q1-0-g128",
        "name": "Bonsai 8B Q1_0_g128",
        "display_name": "Bonsai 8B",
        "hf_repo": "prism-ml/Bonsai-8B-gguf",
        "hf_file": "Bonsai-8B.gguf",
        "architecture": "gguf",
        "backend": "prism-llama",
        "params": "8B",
        "size_gb": 1.16,
        "context": 65536,
        "description": "Ultra-compressed Prism Bonsai GGUF model that requires the managed Prism llama.cpp backend.",
        "thinking": False,
    },
    {
        "id": "phi4-mini-instruct-q4-k-m",
        "name": "Phi-4 Mini Instruct Q4_K_M",
        "display_name": "Phi-4 Mini",
        "hf_repo": "Triangle104/Phi-4-mini-instruct-Q4_K_M-GGUF",
        "hf_file": "phi-4-mini-instruct-q4_k_m.gguf",
        "architecture": "gguf",
        "backend": "llama-cpp",
        "params": "3.8B",
        "size_gb": 2.49,
        "context": 32768,
        "description": "Compact reasoning-oriented Phi model with strong instruction following and tool-call potential through llama.cpp.",
        "thinking": False,
    },
    {
        "id": "llama32-3b-instruct-q4-k-m",
        "name": "Llama 3.2 3B Instruct Q4_K_M",
        "display_name": "Llama 3.2 3B",
        "hf_repo": "gpustack/Llama-3.2-3B-Instruct-GGUF",
        "hf_file": "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "architecture": "gguf",
        "backend": "llama-cpp",
        "params": "3B",
        "size_gb": 2.02,
        "context": 32768,
        "description": "Small, safe local default for chat and lightweight tools through the managed llama.cpp backend.",
        "thinking": False,
    },
    {
        "id": "rwkv6-world-1.6b",
        "name": "RWKV-6 Finch 1.6B",
        "display_name": "Finch 1.6B",
        "hf_repo": "BlinkDL/rwkv-6-world",
        "hf_file": "RWKV-x060-World-1B6-v2.1-20240328-ctx4096.pth",
        "architecture": "rwkv",
        "params": "1.6B",
        "size_gb": 3.0,
        "context": 4096,
        "description": "Fast RWKV v6 baseline.",
        "thinking": False,
    },
    {
        "id": "mamba-1.4b",
        "name": "Mamba 1.4B",
        "display_name": "Mamba 1.4B",
        "hf_repo": "state-spaces/mamba-1.4b-hf",
        "hf_file": None,
        "architecture": "mamba",
        "backend": "vllm",
        "params": "1.4B",
        "size_gb": 2.8,
        "context": 8192,
        "description": "Selective state space model served through the managed vLLM backend.",
        "thinking": False,
    },
    {
        "id": "mamba-2.8b",
        "name": "Mamba 2.8B",
        "display_name": "Mamba 2.8B",
        "hf_repo": "state-spaces/mamba-2.8b-hf",
        "hf_file": None,
        "architecture": "mamba",
        "backend": "vllm",
        "params": "2.8B",
        "size_gb": 5.6,
        "context": 8192,
        "description": "Larger state space model served through the managed vLLM backend.",
        "thinking": False,
    },
    {
        "id": "xlstm-7b",
        "name": "xLSTM 7B",
        "display_name": "xLSTM 7B",
        "hf_repo": "NX-AI/xLSTM-7b",
        "hf_file": None,
        "architecture": "xlstm",
        "params": "7B",
        "size_gb": 14.0,
        "context": 8192,
        "description": "Extended LSTM model via Hugging Face.",
        "thinking": False,
    },
    {
        "id": "stripedhyena-nous-7b",
        "name": "StripedHyena-Nous 7B",
        "display_name": "StripedHyena 7B",
        "hf_repo": "togethercomputer/StripedHyena-Nous-7B",
        "hf_file": None,
        "architecture": "hyena",
        "params": "7B",
        "size_gb": 14.0,
        "context": 32768,
        "description": "Hybrid convolutional long-context model.",
        "thinking": False,
    },
]


TOKENIZER_URL = (
    "https://raw.githubusercontent.com/BlinkDL/ChatRWKV/main/tokenizer/"
    "rwkv_vocab_v20230424.txt"
)
TOKENIZER_FILENAME = "rwkv_vocab_v20230424.txt"


def backend_for_architecture(architecture: str) -> str:
    normalized = (architecture or "").strip().lower()
    if normalized == "mamba":
        return "vllm"
    if normalized == "gguf":
        return "llama-cpp"
    return "huggingface"


def backend_for_model(architecture: str, filename: str) -> str:
    normalized_arch = (architecture or "").strip().lower()
    lowered_name = (filename or "").strip().lower()
    if normalized_arch == "gguf" and "bonsai" in lowered_name:
        return "prism-llama"
    if normalized_arch == "gguf" or lowered_name.endswith(".gguf"):
        return "llama-cpp"
    if normalized_arch == "rwkv":
        if "x070" in lowered_name or "rwkv7" in lowered_name:
            return "albatross"
        return "rwkv"
    return backend_for_architecture(normalized_arch)


def _copy_stream(
    src,
    dest,
    total_bytes: Optional[int] = None,
    progress_callback: Optional[Callable[[int, Optional[int]], None]] = None,
) -> None:
    copied = 0
    while True:
        chunk = src.read(1024 * 1024)
        if not chunk:
            break
        dest.write(chunk)
        copied += len(chunk)
        if progress_callback is not None:
            progress_callback(copied, total_bytes)


def download_url_to_path(
    url: str,
    dest: Path,
    token: Optional[str] = None,
    progress_callback: Optional[Callable[[int, Optional[int]], None]] = None,
) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")

    with urllib.request.urlopen(request) as response:
        total_bytes = response.headers.get("Content-Length")
        parsed_total = int(total_bytes) if total_bytes and total_bytes.isdigit() else None
        tmp_dir = Path(tempfile.mkdtemp(prefix="entropic-rnn-download-"))
        tmp_path = tmp_dir / dest.name
        try:
            with open(tmp_path, "wb") as handle:
                _copy_stream(response, handle, parsed_total, progress_callback)
            os.replace(tmp_path, dest)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


class ModelManager:
    def __init__(self, models_dir: str):
        self.models_dir = Path(models_dir)
        self.models_dir.mkdir(parents=True, exist_ok=True)

    def tokenizer_path(self) -> Path:
        return self.models_dir / TOKENIZER_FILENAME

    def ensure_rwkv_tokenizer(self, token: Optional[str] = None) -> Path:
        tokenizer_path = self.tokenizer_path()
        if tokenizer_path.exists():
            return tokenizer_path
        download_url_to_path(TOKENIZER_URL, tokenizer_path, token)
        return tokenizer_path

    def _match_catalog(self, filename: str) -> Optional[Dict[str, Any]]:
        for entry in MODEL_CATALOG:
            if entry.get("hf_file") == filename or entry["id"] == filename:
                return entry
        return None

    def _guess_arch(self, filename: str) -> str:
        lowered = filename.lower()
        if lowered.endswith(".gguf"):
            return "gguf"
        if "rwkv" in lowered or "x060" in lowered or "x070" in lowered:
            return "rwkv"
        if "mamba" in lowered:
            return "mamba"
        if "xlstm" in lowered:
            return "xlstm"
        if "hyena" in lowered:
            return "hyena"
        return "unknown"

    def _build_entry(self, name: str, path: Path) -> Dict[str, Any]:
        size_bytes = (
            path.stat().st_size
            if path.is_file()
            else sum(child.stat().st_size for child in path.rglob("*") if child.is_file())
        )
        catalog_entry = self._match_catalog(path.name) or self._match_catalog(name)
        return {
            "name": name,
            "filename": path.name,
            "path": str(path),
            "size_gb": round(size_bytes / 1024**3, 2),
            "architecture": (
                catalog_entry.get("architecture", "unknown")
                if catalog_entry
                else self._guess_arch(path.name)
            ),
            "backend": (
                catalog_entry.get(
                    "backend",
                    backend_for_model(
                        catalog_entry.get("architecture", ""),
                        catalog_entry.get("hf_file") or path.name,
                    ),
                )
                if catalog_entry
                else backend_for_model(self._guess_arch(path.name), path.name)
            ),
            "display_name": (
                catalog_entry.get("display_name", name) if catalog_entry else name
            ),
            "catalog_id": catalog_entry["id"] if catalog_entry else None,
            "description": catalog_entry.get("description", "") if catalog_entry else "",
            "thinking": bool(catalog_entry.get("thinking")) if catalog_entry else False,
        }

    def list_local(self) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        if not self.models_dir.exists():
            return entries
        for path in sorted(self.models_dir.iterdir(), key=lambda item: item.name.lower()):
            if path.name.startswith(".") or path.name == TOKENIZER_FILENAME:
                continue
            if path.is_file() and path.suffix in {".pth", ".safetensors", ".gguf"}:
                entries.append(self._build_entry(path.stem, path))
                continue
            if path.is_dir() and (path / "config.json").exists():
                entries.append(self._build_entry(path.name, path))
        return entries

    def list_available(self) -> List[Dict[str, Any]]:
        local = self.list_local()
        local_names = {entry["filename"] for entry in local}
        local_ids = {entry["catalog_id"] for entry in local if entry.get("catalog_id")}
        result: List[Dict[str, Any]] = []
        for entry in MODEL_CATALOG:
            downloadable_name = entry["hf_file"] or entry["id"]
            result.append(
                {
                    **entry,
                    "backend": entry.get(
                        "backend",
                        backend_for_model(
                            entry.get("architecture", ""),
                            entry.get("hf_file") or entry["id"],
                        ),
                    ),
                    "downloaded": downloadable_name in local_names or entry["id"] in local_ids,
                }
            )
        return result

    def get_local_entry(self, name_or_id: str) -> Optional[Dict[str, Any]]:
        for entry in self.list_local():
            if entry["name"] == name_or_id or entry.get("catalog_id") == name_or_id:
                return entry
        return None

    def get_model_path(self, name_or_id: str) -> Optional[str]:
        entry = self.get_local_entry(name_or_id)
        return entry["path"] if entry else None

    def delete(self, name_or_filename: str) -> Dict[str, Any]:
        for entry in self.list_local():
            if entry["name"] == name_or_filename or entry["filename"] == name_or_filename:
                path = Path(entry["path"])
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
                return {"status": "deleted", "name": entry["name"], "freed_gb": entry["size_gb"]}
        return {"status": "error", "error": f"Model not found: {name_or_filename}"}

    def download(
        self,
        catalog_id: str,
        token: Optional[str] = None,
        progress_callback: Optional[Callable[[int, Optional[int]], None]] = None,
    ) -> Dict[str, Any]:
        entry = next((candidate for candidate in MODEL_CATALOG if candidate["id"] == catalog_id), None)
        if not entry:
            return {"status": "error", "error": f"Unknown model: {catalog_id}"}

        target_name = entry["hf_file"] or entry["id"]
        destination = self.models_dir / target_name
        if destination.exists():
            return {"status": "already_exists", "path": str(destination)}

        started_at = time.time()
        try:
            if entry.get("hf_file"):
                url = f"https://huggingface.co/{entry['hf_repo']}/resolve/main/{entry['hf_file']}"
                download_url_to_path(url, destination, token, progress_callback)
                if entry["architecture"] == "rwkv":
                    self.ensure_rwkv_tokenizer(token)
            else:
                try:
                    from huggingface_hub import snapshot_download
                except ImportError:
                    return {
                        "status": "error",
                        "error": (
                            "huggingface_hub is required for directory-based models. "
                            "Install it in the Python environment running the managed local runtime."
                        ),
                    }
                snapshot_download(
                    repo_id=entry["hf_repo"],
                    local_dir=str(destination),
                    local_dir_use_symlinks=False,
                    token=token or None,
                )
        except urllib.error.HTTPError as error:
            return {
                "status": "error",
                "error": f"Hugging Face download failed with HTTP {error.code}: {error.reason}",
            }
        except Exception as error:
            return {"status": "error", "error": str(error)}

        return {
            "status": "downloaded",
            "path": str(destination),
            "size_gb": entry["size_gb"],
            "elapsed_s": round(time.time() - started_at, 2),
        }


def snapshot_json(manager: ModelManager, loaded_model: Optional[str]) -> Dict[str, Any]:
    local_entries = manager.list_local()
    catalog_entries = manager.list_available()
    loaded_catalog_ids = {
        entry["catalog_id"]
        for entry in local_entries
        if entry["name"] == loaded_model and entry.get("catalog_id")
    }
    for entry in catalog_entries:
        entry["loaded"] = entry["id"] in loaded_catalog_ids
    for entry in local_entries:
        entry["loaded"] = bool(loaded_model and entry["name"] == loaded_model)
    return {
        "catalog": catalog_entries,
        "local": local_entries,
        "loadedModel": loaded_model,
    }
