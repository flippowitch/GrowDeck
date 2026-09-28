"""Single-password login with HMAC-signed session cookies."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, WebSocket, status

COOKIE_NAME = "gd_session"
SESSION_DAYS = 30
_MAX_FAILURES = 8
_FAILURE_WINDOW = 300


class Auth:
    def __init__(self, password: str, secret: str) -> None:
        self._password = password
        self._secret = secret.encode()
        # Changing APP_PASSWORD invalidates every existing session.
        self._fingerprint = hashlib.sha256(("gd:" + password).encode()).hexdigest()[:16]
        self._failures: dict[str, deque[float]] = defaultdict(deque)

    def _sign(self, payload: str) -> str:
        return hmac.new(self._secret, f"{payload}.{self._fingerprint}".encode(), hashlib.sha256).hexdigest()

    def issue(self) -> str:
        payload = f"{int(time.time())}.{secrets.token_urlsafe(12)}"
        return f"{payload}.{self._sign(payload)}"

    def valid(self, token: str | None) -> bool:
        if not token or token.count(".") != 2:
            return False
        issued, nonce, signature = token.split(".")
        if not hmac.compare_digest(self._sign(f"{issued}.{nonce}"), signature):
            return False
        try:
            return time.time() - int(issued) < SESSION_DAYS * 86400
        except ValueError:
            return False

    def locked(self, client: str) -> bool:
        attempts = self._failures[client]
        now = time.time()
        while attempts and now - attempts[0] > _FAILURE_WINDOW:
            attempts.popleft()
        return len(attempts) >= _MAX_FAILURES

    def check_password(self, client: str, password: str) -> bool:
        ok = hmac.compare_digest(password.encode(), self._password.encode())
        if ok:
            self._failures.pop(client, None)
        else:
            self._failures[client].append(time.time())
        return ok

    def require(self, request: Request) -> None:
        if not self.valid(request.cookies.get(COOKIE_NAME)):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bitte anmelden.")

    def websocket_ok(self, websocket: WebSocket) -> bool:
        return self.valid(websocket.cookies.get(COOKIE_NAME))
