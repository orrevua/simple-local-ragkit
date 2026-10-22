#!/usr/bin/env bash
# Fetch the FastAPI tutorial docs (MIT licensed) at a pinned commit, so the
# golden set below always matches the corpus it was written against.
set -euo pipefail
COMMIT=4bdfbe4513084b19e22421ce1f916d8c1ac462a0
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
git clone -q --filter=blob:none --sparse https://github.com/fastapi/fastapi "$TMP/fastapi"
git -C "$TMP/fastapi" checkout -q "$COMMIT"
git -C "$TMP/fastapi" sparse-checkout set docs/en/docs/tutorial
rm -rf "$HERE/docs"
cp -r "$TMP/fastapi/docs/en/docs/tutorial" "$HERE/docs"
rm -rf "$TMP"
echo "FastAPI tutorial docs copied to $HERE/docs"
