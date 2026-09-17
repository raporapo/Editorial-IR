"""Entry point.

Reads requests from stdin and writes replies to stdout, one JSON object per
line. Not a server and not a CLI: it is started by whatever needs it, does work,
and exits when its input closes.
"""

from __future__ import annotations

import sys

from .handlers import HANDLERS
from .protocol import Session, serve
from .scheduler import ModelScheduler


def main() -> int:
    # Line buffering, because a reply that sits in a buffer is a reply that
    # never arrived as far as the other side is concerned.
    sys.stdout.reconfigure(line_buffering=True)

    session = Session()
    try:
        return serve(HANDLERS, sys.stdin, session)
    except KeyboardInterrupt:
        return 130
    finally:
        ModelScheduler().unload_all()


if __name__ == "__main__":
    raise SystemExit(main())
