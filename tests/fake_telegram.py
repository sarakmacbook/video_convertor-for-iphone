"""A tiny stand-in for the Telegram Bot API, so the bot can be tested without internet access.

It answers the handful of methods the bot uses, serves files that the tests register, and
records every call so tests can check what the bot sent (including uploaded video bytes).
"""

from __future__ import annotations

import email.parser
import email.policy
import json
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qsl, unquote

BOT_ID = 42
BOT_USERNAME = "test_convertor_bot"
CLOUD_DOWNLOAD_LIMIT = 20_000_000  # what the real cloud server enforces on getFile


@dataclass
class Call:
    method: str
    fields: dict[str, str] = field(default_factory=dict)
    files: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass
class _ServedFile:
    file_id: str
    data: bytes | None  # None means the file lives on the local disk at `file_path`
    file_path: str
    file_size: int


def _parse_body(content_type: str, body: bytes) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    if content_type.startswith("multipart/form-data"):
        raw = b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
        message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(raw)
        fields: dict[str, str] = {}
        files: dict[str, dict[str, Any]] = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            payload = part.get_payload(decode=True) or b""
            if filename:
                files[str(name)] = {"filename": filename, "data": payload}
            else:
                fields[str(name)] = payload.decode("utf-8")
        return fields, files
    if content_type.startswith("application/json"):
        return {k: v for k, v in (json.loads(body or b"{}")).items()}, {}
    return dict(parse_qsl(body.decode("utf-8"))), {}


class FakeBotApi:
    def __init__(self, token: str) -> None:
        self.token = token
        self.calls: list[Call] = []
        self.downloads: list[str] = []
        self._served: dict[str, _ServedFile] = {}
        self._by_path: dict[str, _ServedFile] = {}
        self._next_message_id = 1000
        self._pending_updates: list[dict[str, Any]] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- test setup ----------------------------------------------------------

    def serve_file(
        self,
        file_id: str,
        data: bytes | None = None,
        *,
        file_path: str | None = None,
        file_size: int | None = None,
    ) -> _ServedFile:
        """Make `file_id` downloadable. With data=None the file must already exist at `file_path`."""
        path = file_path or f"documents/{file_id}.bin"
        size = file_size if file_size is not None else (len(data) if data is not None else 0)
        served = _ServedFile(file_id=file_id, data=data, file_path=path, file_size=size)
        self._served[file_id] = served
        self._by_path[path] = served
        return served

    @property
    def url(self) -> str:
        assert self._server is not None, "server not started"
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.api = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def queue_update(self, payload: dict[str, Any]) -> None:
        """Deliver this update on the bot's next getUpdates call (used for polling tests)."""
        self._pending_updates.append(payload)

    # -- queries --------------------------------------------------------------

    def calls_to(self, method: str) -> list[Call]:
        return [c for c in self.calls if c.method == method]

    # -- request handling -----------------------------------------------------

    def handle_method(self, method: str, fields: dict[str, str], files: dict[str, dict[str, Any]]):
        self.calls.append(Call(method, fields, files))
        if method == "getMe":
            return 200, self._user()
        if method == "getFile":
            return self._get_file(fields.get("file_id", ""))
        if method == "getUpdates":
            if not self._pending_updates:
                time.sleep(0.2)  # like long polling, don't spin when nothing is waiting
                return 200, []
            updates, self._pending_updates = self._pending_updates, []
            return 200, updates
        if method in ("sendMessage", "sendVideo", "sendDocument"):
            return 200, self._message(fields)
        if method == "editMessageText":
            return 200, self._message(fields, text=fields.get("text"))
        return 200, True

    def _user(self) -> dict[str, Any]:
        return {
            "id": BOT_ID,
            "is_bot": True,
            "first_name": "Test Convertor",
            "username": BOT_USERNAME,
            "can_join_groups": True,
            "can_read_all_group_messages": False,
            "supports_inline_queries": False,
        }

    def _get_file(self, file_id: str):
        served = self._served.get(file_id)
        if served is None:
            return 400, _error(400, "Bad Request: wrong file identifier/HTTP URL specified")
        if served.data is not None and served.file_size > CLOUD_DOWNLOAD_LIMIT:
            return 400, _error(400, "Bad Request: file is too big")
        return 200, {
            "file_id": file_id,
            "file_unique_id": f"uniq-{file_id}",
            "file_size": served.file_size,
            "file_path": served.file_path,
        }

    def _message(self, fields: dict[str, str], text: str | None = None) -> dict[str, Any]:
        self._next_message_id += 1
        chat_id = int(fields.get("chat_id", "0") or 0)
        message: dict[str, Any] = {
            "message_id": self._next_message_id,
            "date": int(time.time()),
            "chat": {"id": chat_id, "type": "private", "first_name": "Sam"},
            "from": {"id": BOT_ID, "is_bot": True, "first_name": "Test Convertor", "username": BOT_USERNAME},
        }
        if text is not None:
            message["text"] = text
        return message

    def download(self, path: str) -> bytes | None:
        self.downloads.append(path)
        served = self._by_path.get(path)
        if served is None or served.data is None:
            return None
        return served.data


def _error(code: int, description: str) -> dict[str, Any]:
    return {"ok": False, "error_code": code, "description": description}


class _Handler(BaseHTTPRequestHandler):
    server: ThreadingHTTPServer

    def log_message(self, format: str, *args: Any) -> None:  # keep test output quiet
        return

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps({"ok": status == 200, "result": payload} if status == 200 else payload).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the bot hung up (for example during shutdown); nothing to answer

    def do_POST(self) -> None:  # noqa: N802 (http.server naming)
        api: FakeBotApi = self.server.api  # type: ignore[attr-defined]
        path = unquote(self.path)  # clients may percent-encode the ':' in the token
        prefix = f"/bot{api.token}/"
        if not path.startswith(prefix):
            self._send_json(404, _error(404, "Not Found"))
            return
        method = path[len(prefix) :].split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        fields, files = _parse_body(self.headers.get("Content-Type", ""), body)
        status, payload = api.handle_method(method, fields, files)
        self._send_json(status, payload)

    def do_GET(self) -> None:  # noqa: N802
        api: FakeBotApi = self.server.api  # type: ignore[attr-defined]
        path = unquote(self.path)
        prefix = f"/file/bot{api.token}/"
        if not path.startswith(prefix):
            self._send_json(404, _error(404, "Not Found"))
            return
        data = api.download(path[len(prefix) :])
        if data is None:
            self._send_json(404, _error(404, "Not Found"))
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
