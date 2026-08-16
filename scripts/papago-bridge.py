#!/usr/bin/env python3
"""Papago translation bridge (unofficial web endpoint).

Long-lived stdio NDJSON JSON-RPC server. Node.js (src/papago.ts) spawns this
process and exchanges one JSON object per line over stdin/stdout (UTF-8).

Endpoint (2026-08): the legacy `/apis/n2mt/translate` (HMAC-MD5 "PPG" auth,
device ids, license key embedded in the old webpack chunk) is dead - it
returns 404 since papago.naver.com migrated to Next.js. The current web app
calls `POST https://papago.naver.com/api/text/translation` with a plain form
body and no authentication headers (request shape verified against
LunaTranslator <https://github.com/HIllya51/LunaTranslator>,
src/LunaTranslator/translator/papago.py, and by live capture of
papago.naver.com traffic).

Defense-in-depth for the unofficial endpoint (low rate limits / blocking):
  * fully serialized processing - one Papago request at a time,
  * configurable inter-request pacing with random jitter,
  * circuit breaker with exponential cooldown on repeated block signals,
  * in-memory LRU translation cache to deduplicate identical requests,
  * browser-like session (persistent cookies, UA, Referer, Origin).

Protocol (newline-delimited JSON, stdout):
  -> {"id": 1, "method": "translate", "params": {"text": "...", "source": "ko", "target": "en"}}
  <- {"id": 1, "ok": true, "result": {"translatedText": "...", "latencyMs": 123.4}}
  <- {"id": 1, "ok": false, "error": {"class": "rate_limit", "message": "...", "retryAfterMs": 30000}}
  -> {"id": 2, "method": "ping"}
  -> {"id": 3, "method": "shutdown"}

Error classes match NormalizedClientErrorClass on the Node side:
rate_limit, timeout, server_overload, network, invalid_response, auth,
bad_request, unknown.

All diagnostics go to stderr; stdout carries protocol messages only.

Environment configuration (all optional):
  PAPAGO_API_URL                 translation endpoint (default https://papago.naver.com/api/text/translation)
  PAPAGO_MIN_INTERVAL_MS         base delay between requests; total cycle = base + jitter (default 10000)
  PAPAGO_JITTER_MS               random extra delay on top, so one call lands every ~10-30s (default 20000)
  PAPAGO_REQUEST_TIMEOUT_MS      HTTP timeout per Papago call (default 30000)
  PAPAGO_CACHE_SIZE              LRU translation cache size, 0 disables (default 1024)
  PAPAGO_BASE_COOLDOWN_MS        circuit breaker base cooldown (default 30000)
  PAPAGO_AUTH_COOLDOWN_MS        cooldown after 403 block (default 60000)
  PAPAGO_MAX_COOLDOWN_MS         circuit breaker max cooldown (default 300000)
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import ssl
import sys
import threading
import time
from collections import OrderedDict
from typing import Any, Optional

import httpx

BRIDGE_VERSION = "2.1.0"
DEFAULT_API_URL = "https://papago.naver.com/api/text/translation"

# Browser-like request surface for the unofficial endpoint.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def _log(message: str) -> None:
    sys.stderr.write(f"[papago-bridge] {message}\n")
    sys.stderr.flush()


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


class Config:
    """Bridge tuning knobs (env-overridable, conservative defaults)."""

    def __init__(self) -> None:
        self.api_url = os.environ.get("PAPAGO_API_URL", DEFAULT_API_URL)
        self.min_interval_ms = _env_float("PAPAGO_MIN_INTERVAL_MS", 10000.0)
        self.jitter_ms = _env_float("PAPAGO_JITTER_MS", 20000.0)
        self.request_timeout_ms = _env_float("PAPAGO_REQUEST_TIMEOUT_MS", 30000.0)
        self.cache_size = _env_int("PAPAGO_CACHE_SIZE", 1024)
        self.base_cooldown_ms = _env_float("PAPAGO_BASE_COOLDOWN_MS", 30000.0)
        self.auth_cooldown_ms = _env_float("PAPAGO_AUTH_COOLDOWN_MS", 60000.0)
        self.max_cooldown_ms = _env_float("PAPAGO_MAX_COOLDOWN_MS", 300000.0)


# Language codes supported by Papago's web endpoint, with common aliases.
LANG_ALIASES = {
    "ko": "ko", "korean": "ko", "kor": "ko",
    "en": "en", "english": "en",
    "ja": "ja", "japanese": "ja", "jp": "ja",
    "zh-cn": "zh-CN", "zh-hans": "zh-CN", "zh": "zh-CN", "chs": "zh-CN",
    "chinese simplified": "zh-CN",
    "zh-tw": "zh-TW", "zh-hant": "zh-TW", "cht": "zh-TW",
    "chinese traditional": "zh-TW",
    "es": "es", "spanish": "es",
    "fr": "fr", "french": "fr",
    "de": "de", "german": "de",
    "ru": "ru", "russian": "ru",
    "pt": "pt", "portuguese": "pt",
    "it": "it", "italian": "it",
    "vi": "vi", "vietnamese": "vi",
    "th": "th", "thai": "th",
    "id": "id", "indonesian": "id",
    "hi": "hi", "hindi": "hi",
    "ar": "ar", "arabic": "ar",
}


def normalize_lang(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    key = value.strip().lower().replace("_", "-")
    return LANG_ALIASES.get(key)


class BridgeError(Exception):
    """Structured error reported to the Node side."""

    def __init__(self, error_class: str, message: str, retry_after_ms: Optional[float] = None) -> None:
        super().__init__(message)
        self.error_class = error_class
        self.retry_after_ms = retry_after_ms


def _parse_retry_after_ms(headers: Any) -> Optional[float]:
    value = headers.get("retry-after") if headers is not None else None
    if value is None:
        return None
    try:
        return max(0.0, float(value) * 1000.0)
    except (TypeError, ValueError):
        return None


class Bridge:
    """Serialized, rate-limited, self-healing Papago translation worker."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self._lock = asyncio.Lock()
        self._client: Optional[httpx.AsyncClient] = None
        self._consecutive_blocks = 0
        self._cooldown_until = 0.0
        self._last_request_at = 0.0
        self._cache: "OrderedDict[tuple[str, str, str], str]" = OrderedDict()
        self._shutdown_requested = False

    # ------------------------------------------------------------------
    # HTTP session
    # ------------------------------------------------------------------
    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self.config.request_timeout_ms / 1000.0,
                follow_redirects=True,
                headers={
                    "User-Agent": USER_AGENT,
                    "Referer": "https://papago.naver.com/",
                    "Origin": "https://papago.naver.com",
                    "Accept": "application/json, text/plain, */*",
                },
            )
        return self._client

    async def _close_client(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------
    # Pacing (anti-burst)
    # ------------------------------------------------------------------
    async def _pace(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        wait = (self.config.min_interval_ms / 1000.0) - elapsed
        if wait > 0:
            await asyncio.sleep(wait + random.uniform(0.0, self.config.jitter_ms / 1000.0))
        self._last_request_at = time.monotonic()

    # ------------------------------------------------------------------
    # Circuit breaker
    # ------------------------------------------------------------------
    def _record_block(self, kind: str) -> None:
        self._consecutive_blocks += 1
        base = self.config.auth_cooldown_ms if kind == "auth" else self.config.base_cooldown_ms
        cooldown = min(self.config.max_cooldown_ms, base * (2 ** (self._consecutive_blocks - 1)))
        self._cooldown_until = time.monotonic() + cooldown / 1000.0
        _log(
            f"block signal ({kind}) recorded; "
            f"cooldown {cooldown:.0f}ms (consecutive={self._consecutive_blocks})"
        )

    def _remaining_cooldown_ms(self) -> float:
        remaining = self._cooldown_until - time.monotonic()
        return max(0.0, remaining * 1000.0)

    # ------------------------------------------------------------------
    # LRU translation cache
    # ------------------------------------------------------------------
    def _cache_get(self, key: "tuple[str, str, str]") -> Optional[str]:
        if self.config.cache_size <= 0:
            return None
        value = self._cache.get(key)
        if value is not None:
            self._cache.move_to_end(key)
        return value

    def _cache_put(self, key: "tuple[str, str, str]", value: str) -> None:
        if self.config.cache_size <= 0:
            return
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > self.config.cache_size:
            self._cache.popitem(last=False)

    # ------------------------------------------------------------------
    # Core translation
    # ------------------------------------------------------------------
    async def translate(self, source: Any, target: Any, text: Any) -> dict:
        norm_source = normalize_lang(source)
        norm_target = normalize_lang(target)
        if norm_source is None:
            raise BridgeError("bad_request", f"unsupported source language: {source!r}")
        if norm_target is None:
            raise BridgeError("bad_request", f"unsupported target language: {target!r}")
        if not isinstance(text, str) or not text.strip():
            raise BridgeError("bad_request", "empty text")

        cache_key = (norm_source, norm_target, text)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return {"translatedText": cached, "cached": True, "latencyMs": 0.0}

        async with self._lock:
            remaining = self._remaining_cooldown_ms()
            if remaining > 0:
                raise BridgeError(
                    "rate_limit",
                    f"Papago cooldown active; retry after {remaining / 1000.0:.1f}s",
                    retry_after_ms=remaining,
                )

            await self._pace()

            try:
                result = await self._call_papago(norm_source, norm_target, text)
            except BridgeError:
                raise
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise self._classify_exception(exc) from exc

            self._consecutive_blocks = 0
            self._cache_put(cache_key, result["translatedText"])
            return result

    async def _call_papago(self, source: str, target: str, text: str) -> dict:
        """POST to the current papago.naver.com translation endpoint.

        Request shape matches the live web app (and LunaTranslator's papago.py).
        `dict=false` keeps the response small (skips the dictionary payload).
        """
        data = {
            "dict": "false",
            "dictDisplay": "30",
            "honorific": "false",
            "useGlossary": "false",
            "source": source,
            "target": target,
            "text": text,
        }
        started = time.monotonic()
        res = await self._get_client().post(self.config.api_url, data=data)
        latency_ms = (time.monotonic() - started) * 1000.0

        if res.status_code == 200:
            try:
                content = res.json()
            except Exception:
                raise BridgeError("invalid_response", "Papago 200 response was not JSON")
            translated = content.get("translatedText")
            if not isinstance(translated, str) or not translated.strip():
                raise BridgeError(
                    "invalid_response",
                    "Papago 200 response contained empty translatedText",
                )
            return {
                "translatedText": translated.strip(),
                "cached": False,
                "latencyMs": round(latency_ms, 1),
            }

        if res.status_code in (401, 403):
            self._record_block("auth")
            retry_after = _parse_retry_after_ms(res.headers) or self.config.auth_cooldown_ms
            raise BridgeError(
                "auth",
                f"Papago rejected request (HTTP {res.status_code})",
                retry_after_ms=retry_after,
            )

        if res.status_code == 429:
            self._record_block("rate_limit")
            retry_after = (
                _parse_retry_after_ms(res.headers)
                or self._remaining_cooldown_ms()
                or self.config.base_cooldown_ms
            )
            raise BridgeError(
                "rate_limit",
                "Papago rate limit (HTTP 429)",
                retry_after_ms=retry_after,
            )

        if 500 <= res.status_code < 600:
            raise BridgeError(
                "server_overload",
                f"Papago server error (HTTP {res.status_code})",
            )

        snippet = res.text[:200].replace("\n", " ")
        raise BridgeError(
            "bad_request",
            f"Papago request failed (HTTP {res.status_code}): {snippet}",
        )

    @staticmethod
    def _classify_exception(exc: Exception) -> BridgeError:
        if isinstance(exc, httpx.TimeoutException):
            return BridgeError("timeout", f"Papago request timed out: {exc}")
        if isinstance(exc, (httpx.ConnectError, httpx.ProxyError, httpx.NetworkError, ssl.SSLError)):
            return BridgeError("network", f"Papago network error: {exc}")
        if isinstance(exc, (json.JSONDecodeError, ValueError, KeyError, TypeError)):
            return BridgeError("invalid_response", f"Papago invalid response: {exc}")
        return BridgeError("unknown", f"Papago request failed: {exc!r}")

    # ------------------------------------------------------------------
    # Protocol handling
    # ------------------------------------------------------------------
    async def handle_line(self, line: str) -> dict:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            return self._error(None, "bad_request", "malformed JSON request")
        if not isinstance(request, dict):
            return self._error(None, "bad_request", "request must be a JSON object")

        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params")

        if method == "translate":
            if not isinstance(params, dict):
                return self._error(req_id, "bad_request", "translate params must be an object")
            try:
                result = await self.translate(
                    params.get("source"),
                    params.get("target"),
                    params.get("text"),
                )
                return {"id": req_id, "ok": True, "result": result}
            except BridgeError as err:
                return self._error(req_id, err.error_class, str(err), err.retry_after_ms)

        if method == "ping":
            return {
                "id": req_id,
                "ok": True,
                "result": {
                    "pong": True,
                    "version": BRIDGE_VERSION,
                    "apiUrl": self.config.api_url,
                    "cacheSize": len(self._cache),
                },
            }

        if method == "shutdown":
            self._shutdown_requested = True
            return {"id": req_id, "ok": True, "result": {"shutdown": True}}

        return self._error(req_id, "bad_request", f"unknown method: {method!r}")

    @staticmethod
    def _error(
        req_id: Any,
        error_class: str,
        message: str,
        retry_after_ms: Optional[float] = None,
    ) -> dict:
        error: dict = {"class": error_class, "message": message}
        if retry_after_ms is not None:
            error["retryAfterMs"] = round(retry_after_ms, 1)
        return {"id": req_id, "ok": False, "error": error}


async def amain() -> None:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    config = Config()
    bridge = Bridge(config)
    _log(
        f"bridge {BRIDGE_VERSION} ready (api={config.api_url}, "
        f"min_interval={config.min_interval_ms:.0f}ms, cache={config.cache_size})"
    )

    queue: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def stdin_reader() -> None:
        for line in sys.stdin:
            stripped = line.strip()
            if stripped:
                loop.call_soon_threadsafe(queue.put_nowait, stripped)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=stdin_reader, daemon=True, name="papago-stdin-reader").start()

    try:
        while True:
            line = await queue.get()
            if line is None:
                break
            try:
                response = await bridge.handle_line(line)
            except Exception as exc:  # pragma: no cover - safety net, never crash the loop
                _log(f"unhandled bridge error: {exc!r}")
                response = bridge._error(
                    None,
                    "unknown",
                    f"internal bridge error: {exc!r}",
                )
            sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
            sys.stdout.flush()
            if bridge._shutdown_requested:
                break
    finally:
        await bridge._close_client()


def main() -> int:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
