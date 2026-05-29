"""Semantic retrieval of training examples by client_request similarity.

We use TF-IDF + cosine similarity instead of dense embeddings because:
  - Client requests are short (~200-1000 chars) and domain-specific (country/city/duration/budget terms)
  - TF-IDF excels at lexical overlap which dominates this kind of query
  - No external API cost · sub-millisecond search over 1000s of docs
  - Multilingual ES/EN handled by character n-grams + analyzer 'word'

Index lifecycle:
  - Built lazily on first request and cached in process memory
  - Rebuilt when the version counter in MongoDB is bumped (any insert / update / delete
    of a TrainingExample bumps it)
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

logger = logging.getLogger("retrieval")


# Spanish + English stopwords (small curated list — sklearn doesn't ship Spanish
# by default and full spaCy stopword lists would be overkill).
_STOPWORDS = frozenset({
    # Spanish
    "a", "al", "algo", "algún", "algunas", "alguno", "algunos", "ante", "antes",
    "aquí", "así", "aún", "ayer", "buenos", "cada", "como", "con", "contra",
    "cual", "cuales", "cuando", "de", "del", "desde", "donde", "dos", "el", "él",
    "ella", "ellas", "ellos", "en", "entre", "era", "eran", "eres", "es", "esa",
    "esas", "ese", "eso", "esos", "esta", "está", "estaba", "estamos", "están",
    "estar", "estas", "este", "esto", "estos", "estoy", "fue", "fuera", "ha",
    "habia", "había", "han", "has", "hasta", "hay", "hola", "la", "las", "le",
    "les", "lo", "los", "me", "mi", "mis", "más", "muy", "nada", "ni", "no",
    "nos", "nosotros", "o", "os", "otra", "otras", "otro", "otros", "para",
    "pero", "poco", "por", "porque", "que", "qué", "quien", "quienes", "se",
    "ser", "si", "sí", "sin", "sobre", "su", "sus", "también", "te", "ti",
    "tiene", "tienen", "todo", "todos", "tu", "tus", "un", "una", "uno", "unos",
    "y", "ya", "yo",
    # English
    "the", "a", "an", "and", "or", "but", "if", "to", "from", "of", "in", "on",
    "at", "for", "with", "as", "by", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "this", "that", "these", "those", "i", "we", "you",
    "they", "he", "she", "it", "my", "our", "your", "their", "his", "her", "its",
    "me", "us", "them", "him", "what", "which", "who", "where", "when", "why",
    "how", "all", "any", "both", "each", "few", "more", "most", "other", "some",
    "such", "than", "too", "very", "so", "just", "now", "then", "also",
})


@dataclass
class TripRetriever:
    """Singleton-style TF-IDF index over training examples' client_request."""
    docs: list[dict]                    # examples ordered the same way as the matrix
    vectorizer: TfidfVectorizer
    matrix: Any                         # scipy.sparse matrix
    version: int

    def top_k(
        self,
        query: str,
        k: int = 8,
        prefer_outcomes: Optional[list[str]] = None,
        min_score: float = 0.02,
    ) -> list[dict]:
        """Return up to k most similar examples (descending by score).

        `prefer_outcomes` filters before ranking (e.g. ["sold"] for winners only).
        `min_score` discards near-irrelevant matches.
        """
        if self.matrix.shape[0] == 0 or not query.strip():
            return []
        q_vec = self.vectorizer.transform([query])
        sims = cosine_similarity(q_vec, self.matrix).ravel()
        if prefer_outcomes:
            mask = np.array(
                [d.get("outcome") in prefer_outcomes for d in self.docs],
                dtype=bool,
            )
            sims = np.where(mask, sims, -1.0)
        order = np.argsort(-sims)
        out: list[dict] = []
        for idx in order:
            score = float(sims[idx])
            if score < min_score:
                break
            out.append({**self.docs[idx], "_score": round(score, 4)})
            if len(out) >= k:
                break
        return out


_index_lock = asyncio.Lock()
_index: TripRetriever | None = None
_index_version: int = -1


async def _current_version(db) -> int:
    doc = await db.retrieval_meta.find_one({"_id": "trip_index"}) or {}
    return int(doc.get("version", 0))


async def bump_version(db) -> None:
    """Call this whenever a training_example is inserted / updated / deleted."""
    await db.retrieval_meta.update_one(
        {"_id": "trip_index"},
        {"$inc": {"version": 1}},
        upsert=True,
    )


async def get_retriever(db) -> TripRetriever:
    """Return a fresh TF-IDF index if the version was bumped since last build,
    else the cached one. Cheap to call from every request."""
    global _index, _index_version
    version = await _current_version(db)
    if _index is not None and version == _index_version:
        return _index
    async with _index_lock:
        # Re-check inside the lock (another caller may have rebuilt)
        version = await _current_version(db)
        if _index is not None and version == _index_version:
            return _index
        logger.info("Rebuilding TF-IDF index (version %d)", version)
        cursor = db.training_examples.find(
            {"client_request": {"$nin": [None, ""]}},
            {"_id": 0},
        )
        docs: list[dict] = await cursor.to_list(length=10_000)
        # Drop any whose client_request is whitespace-only
        docs = [d for d in docs if (d.get("client_request") or "").strip()]
        if not docs:
            # Empty corpus — build a placeholder vectorizer so .transform() works.
            vec = TfidfVectorizer(stop_words=list(_STOPWORDS), max_features=1)
            vec.fit(["placeholder"])
            empty = vec.transform([])
            _index = TripRetriever(docs=[], vectorizer=vec, matrix=empty, version=version)
            _index_version = version
            return _index
        texts = [d["client_request"] for d in docs]
        vec = TfidfVectorizer(
            stop_words=list(_STOPWORDS),
            ngram_range=(1, 2),
            max_df=0.9,
            min_df=1,
            sublinear_tf=True,
            lowercase=True,
            strip_accents="unicode",
        )
        matrix = vec.fit_transform(texts)
        _index = TripRetriever(docs=docs, vectorizer=vec, matrix=matrix, version=version)
        _index_version = version
        logger.info("TF-IDF index ready · %d docs · %d features",
                    matrix.shape[0], matrix.shape[1])
        return _index
