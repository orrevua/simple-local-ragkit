"""Use a ragkit collection as a LangChain retriever (works in LangGraph too).

    pip install langchain-core
    from langchain_retriever import RagkitRetriever
    docs = RagkitRetriever(strategy="hybrid-rerank").invoke("how do I add CORS?")
"""

from __future__ import annotations

from langchain_core.callbacks import CallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever

from ragkit_client import RagkitClient


class RagkitRetriever(BaseRetriever):
    base_url: str = "http://127.0.0.1:8787"
    token: str | None = None
    top_k: int = 5
    strategy: str | None = None

    def _get_relevant_documents(
        self, query: str, *, run_manager: CallbackManagerForRetrieverRun
    ) -> list[Document]:
        client = RagkitClient(self.base_url, self.token)
        return [
            Document(
                page_content=p.text,
                metadata={"source": p.source, "heading": p.heading, "score": p.score},
            )
            for p in client.search(query, self.top_k, self.strategy)
        ]
