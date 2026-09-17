"""Keeping one large model in memory at a time.

Sixteen gigabytes is the declared target, and a transcriber, a vision encoder
and a vision-language model will not co-exist in it. The pipeline is already
staged so that everything is transcribed, then everything is embedded, then the
events that need it are described, which means the fix is not smaller models but
never holding two at once.

Loaders are lazy and cached, so "transcribe thirty files" costs one model load
rather than thirty, which is where nearly all of the wall-clock time goes.
"""

from __future__ import annotations

import gc
from collections.abc import Callable
from typing import Any


class ModelScheduler:
    def __init__(self, capacity: int = 1) -> None:
        self.capacity = max(1, capacity)
        self._loaded: dict[str, Any] = {}
        self._order: list[str] = []

    @property
    def resident(self) -> list[str]:
        return list(self._order)

    def get(self, slot: str, load: Callable[[], Any]) -> Any:
        """Returns the model for `slot`, loading it and evicting others as needed."""
        if slot in self._loaded:
            self._order.remove(slot)
            self._order.append(slot)
            return self._loaded[slot]

        while len(self._order) >= self.capacity:
            self.unload(self._order[0])

        model = load()
        self._loaded[slot] = model
        self._order.append(slot)
        return model

    def unload(self, slot: str) -> None:
        model = self._loaded.pop(slot, None)
        if slot in self._order:
            self._order.remove(slot)
        if model is None:
            return
        del model
        gc.collect()
        _empty_accelerator_cache()

    def unload_all(self) -> None:
        for slot in list(self._order):
            self.unload(slot)


def _empty_accelerator_cache() -> None:
    """Returns freed memory to the driver.

    Python's garbage collector releasing a model is not the same as the GPU
    getting its memory back, and without this the next load fails on a card that
    is, as far as the driver is concerned, still full.
    """
    try:
        import torch  # noqa: PLC0415
    except ImportError:
        return
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - freeing cache must never fail a run
        pass
