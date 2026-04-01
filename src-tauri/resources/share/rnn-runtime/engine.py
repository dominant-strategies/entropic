import shutil
from abc import ABC, abstractmethod
from importlib.util import find_spec
from pathlib import Path
import os
from typing import Any, Dict, Generator, Optional

try:
    import torch
except ImportError:
    torch = None


RUNTIME_DIR = Path(__file__).resolve().parent
ALBATROSS_REFERENCE_DIR = RUNTIME_DIR / "albatross_reference"
PRISM_LLAMA_STATE_DIR_ENV = "ENTROPIC_RNN_RUNTIME_STATE_DIR"
PRISM_LLAMA_SERVER_BIN_ENV = "ENTROPIC_RNN_PRISM_LLAMA_SERVER"


def _bundled_albatross_source_available() -> bool:
    return (
        (ALBATROSS_REFERENCE_DIR / "__init__.py").exists()
        and (ALBATROSS_REFERENCE_DIR / "rwkv7.py").exists()
        and (ALBATROSS_REFERENCE_DIR / "utils.py").exists()
        and (ALBATROSS_REFERENCE_DIR / "cuda" / "rwkv7_state_fwd_fp16.cpp").exists()
        and (ALBATROSS_REFERENCE_DIR / "cuda" / "rwkv7_state_fwd_fp16.cu").exists()
    )


def _resolve_nvcc_path() -> Optional[str]:
    path = shutil.which("nvcc")
    if path:
        return path
    cuda_home = os.environ.get("CUDA_HOME") or os.environ.get("CUDA_PATH")
    if cuda_home:
        candidate = Path(cuda_home) / "bin" / "nvcc"
        if candidate.exists():
            return str(candidate)
    fallback = Path("/usr/local/cuda/bin/nvcc")
    if fallback.exists():
        return str(fallback)
    return None


def _prism_llama_server_available() -> bool:
    configured = (os.environ.get(PRISM_LLAMA_SERVER_BIN_ENV) or "").strip()
    if configured and Path(configured).exists():
        return True
    state_dir = (os.environ.get(PRISM_LLAMA_STATE_DIR_ENV) or "").strip()
    if not state_dir:
        return False
    base_dir = Path(state_dir)
    binary_name = "llama-server.exe" if os.name == "nt" else "llama-server"
    candidates = [
        base_dir / "prism-llama.cpp" / "build" / "bin" / binary_name,
        base_dir / "prism-llama.cpp" / "build" / "bin" / "Release" / binary_name,
    ]
    return any(candidate.exists() for candidate in candidates)


def _detect_host_memory() -> Dict[str, Any]:
    total_bytes: Optional[int] = None
    available_bytes: Optional[int] = None
    source: Optional[str] = None

    try:
        import psutil  # type: ignore

        vm = psutil.virtual_memory()
        total_bytes = int(getattr(vm, "total", 0) or 0) or None
        available_bytes = int(getattr(vm, "available", 0) or 0) or None
        source = "psutil"
    except Exception:
        pass

    if total_bytes is None and hasattr(os, "sysconf"):
        try:
            page_count = int(os.sysconf("SC_PHYS_PAGES"))
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            if page_count > 0 and page_size > 0:
                total_bytes = page_count * page_size
                source = source or "sysconf"
        except Exception:
            pass

    if available_bytes is None:
        try:
            meminfo_path = Path("/proc/meminfo")
            if meminfo_path.exists():
                meminfo: Dict[str, int] = {}
                for raw_line in meminfo_path.read_text(encoding="utf-8").splitlines():
                    if ":" not in raw_line:
                        continue
                    key, value = raw_line.split(":", 1)
                    parts = value.strip().split()
                    if not parts:
                        continue
                    parsed = int(parts[0])
                    meminfo[key.strip()] = parsed * 1024
                available_bytes = meminfo.get("MemAvailable") or meminfo.get("MemFree")
                source = source or "procfs"
        except Exception:
            pass

    if total_bytes is None and os.name == "nt":
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                total_bytes = int(status.ullTotalPhys or 0) or None
                available_bytes = int(status.ullAvailPhys or 0) or available_bytes
                source = "GlobalMemoryStatusEx"
        except Exception:
            pass

    return {
        "hostMemoryTotalBytes": total_bytes,
        "hostMemoryAvailableBytes": available_bytes,
        "hostMemorySource": source,
    }


def detect_runtime_capabilities() -> Dict[str, Any]:
    transformers_available = find_spec("transformers") is not None
    vllm_available = find_spec("vllm") is not None
    llama_cpp_available = find_spec("llama_cpp") is not None
    prism_llama_available = _prism_llama_server_available()
    nvcc_path = _resolve_nvcc_path()
    bundled_albatross = _bundled_albatross_source_available()
    payload: Dict[str, Any] = {
        "torchAvailable": torch is not None,
        "torchVersion": getattr(torch, "__version__", None) if torch is not None else None,
        "cudaAvailable": False,
        "cudaDeviceCount": 0,
        "cudaDeviceName": None,
        "mpsAvailable": False,
        "preferredDevice": "cpu",
        "nvccPath": nvcc_path,
        "albatrossSourceBundled": bundled_albatross,
        "currentProcessCudaAllocatedMiB": 0.0,
        "currentProcessCudaReservedMiB": 0.0,
    }
    payload.update(_detect_host_memory())
    if torch is None:
        payload["backendAvailability"] = {
            "rwkv": False,
            "mamba": False,
            "huggingface": False,
            "vllm": vllm_available,
            "llama-cpp": llama_cpp_available,
            "prism-llama": prism_llama_available,
            "albatross": False,
        }
        payload["supportedBackends"] = [
            name
            for name, available in payload["backendAvailability"].items()
            if available
        ]
        return payload

    try:
        payload["mpsAvailable"] = bool(torch.backends.mps.is_available())
    except Exception:
        payload["mpsAvailable"] = False

    try:
        payload["cudaAvailable"] = bool(torch.cuda.is_available())
    except Exception:
        payload["cudaAvailable"] = False

    if payload["cudaAvailable"]:
        try:
            payload["cudaDeviceCount"] = int(torch.cuda.device_count())
        except Exception:
            payload["cudaDeviceCount"] = 0
        if payload["cudaDeviceCount"] > 0:
            try:
                payload["cudaDeviceName"] = str(torch.cuda.get_device_name(0))
            except Exception:
                payload["cudaDeviceName"] = None
        try:
            payload["currentProcessCudaAllocatedMiB"] = round(
                torch.cuda.memory_allocated() / 1024**2, 1
            )
        except Exception:
            payload["currentProcessCudaAllocatedMiB"] = 0.0
        try:
            payload["currentProcessCudaReservedMiB"] = round(
                torch.cuda.memory_reserved() / 1024**2, 1
            )
        except Exception:
            payload["currentProcessCudaReservedMiB"] = 0.0

    payload["preferredDevice"] = (
        "mps"
        if payload["mpsAvailable"]
        else "cuda"
        if payload["cudaAvailable"]
        else "cpu"
    )

    backend_availability = {
        "rwkv": True,
        "mamba": transformers_available,
        "huggingface": transformers_available,
        "vllm": vllm_available,
        "llama-cpp": llama_cpp_available,
        "prism-llama": prism_llama_available,
        "albatross": bool(payload["cudaAvailable"] and bundled_albatross and nvcc_path),
    }
    payload["backendAvailability"] = backend_availability
    payload["supportedBackends"] = [
        name for name, available in backend_availability.items() if available
    ]
    return payload


class InferenceEngine(ABC):
    name: str = "base"
    architecture: str = "unknown"

    def __init__(self):
        self.model = None
        self.model_path: Optional[str] = None
        self.model_name: Optional[str] = None
        self.is_loaded: bool = False
        self.device: str = "cpu"
        self.model_info: Dict[str, object] = {}
        self.last_generation_stats: Dict[str, object] = {}

    @abstractmethod
    def load(self, model_path: str) -> Dict[str, object]:
        raise NotImplementedError

    @abstractmethod
    def unload(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def generate_stream(
        self,
        prompt: str,
        temperature: float = 1.0,
        top_p: float = 0.7,
        max_tokens: int = 500,
    ) -> Generator[str, None, None]:
        raise NotImplementedError

    @abstractmethod
    def encode(self, text: str) -> list:
        raise NotImplementedError

    @abstractmethod
    def decode(self, tokens: list) -> str:
        raise NotImplementedError

    def reset(self) -> None:
        return None

    @staticmethod
    def detect_device() -> str:
        if torch is None:
            return "cpu"
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
