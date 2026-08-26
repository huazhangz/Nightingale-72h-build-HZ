#!/usr/bin/env python3
"""Bridge to the Vitest suite for environments that invoke tests via Python.

Nightingale's tests are TypeScript (Vitest + Prisma SQLite). This script does
not reimplement them; it forwards to `npm run test` so judges, CI, or local
Python harnesses can use a single entry point.

Examples:
  python test_runner.py
  python test_runner.py -- tests/test_rbac_scope.test.ts
  python3 test_runner.py --reporter=verbose
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent
    os.chdir(root)

    extra = sys.argv[1:]
    if extra[:1] == ["--"]:
        extra = extra[1:]

    npm = shutil.which("npm")
    if npm is None:
        print("npm is not on PATH. Install Node.js 18+ and npm 9+.", file=sys.stderr)
        return 127

    cmd = [npm, "run", "test", "--", *extra]
    # Windows: npm is typically npm.cmd; shell=True avoids WinError 193.
    return subprocess.call(cmd, cwd=root, shell=os.name == "nt")


if __name__ == "__main__":
    raise SystemExit(main())
