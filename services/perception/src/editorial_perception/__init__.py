"""The perception runtime for Editorial IR.

TypeScript owns the contract; this package implements it. Nothing here invents a
field, and every capability is optional except reading a file's metadata.
"""

from .protocol import PROTOCOL_VERSION, WORKER_VERSION

__all__ = ["PROTOCOL_VERSION", "WORKER_VERSION"]
__version__ = WORKER_VERSION
