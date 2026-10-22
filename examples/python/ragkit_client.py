"""Minimal client for `ragkit serve`, standard library only.

    python ragkit_client.py "how do I add CORS?" --strategy hybrid-rerank
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.request
from dataclasses import dataclass


@dataclass
class Passage:
    source: str
    heading: str | None
    score: float
    text: str


class RagkitClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8787", token: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.token = token or os.environ.get("RAGKIT_API_TOKEN")

    def search(
        self, query: str, top_k: int = 5, strategy: str | None = None
    ) -> list[Passage]:
        body: dict[str, object] = {"query": query, "topK": top_k}
        if strategy:
            body["strategy"] = strategy
        req = urllib.request.Request(
            f"{self.base_url}/search",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.load(res)
        return [
            Passage(r["source"], r["headingPath"], r["score"], r["text"])
            for r in data["results"]
        ]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("query")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--strategy")
    parser.add_argument("--url", default="http://127.0.0.1:8787")
    args = parser.parse_args()

    for i, p in enumerate(RagkitClient(args.url).search(args.query, args.top_k, args.strategy), 1):
        print(f"[{i}] {p.source} ({p.score:.3f}) {p.heading or ''}")
