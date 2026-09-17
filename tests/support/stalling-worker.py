"""A perception worker that answers `health` at once and never answers `probe`.

The real worker handles one request at a time and cannot be told to stop, so a
request that times out does not release it. This stands in for that: a client
that merely abandons the request is left talking to a process that is still busy
with it, and everything sent afterwards waits behind work nobody wants.
"""

from __future__ import annotations

import json
import sys
import time


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        if request.get("op") == "probe":
            time.sleep(30)
        print(
            json.dumps(
                {
                    "v": "0.1.0",
                    "id": request["id"],
                    "op": request.get("op"),
                    "ok": True,
                    "result": {
                        "protocol_version": "0.1.0",
                        "worker_version": "stalling",
                        "capabilities": {},
                    },
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
