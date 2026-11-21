"""Expose one reviewed marimo app on an origin separate from the hub."""

import asyncio
import hashlib
import json
import os
import stat
import sys
import threading
import time
from collections import deque
from collections.abc import Collection
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import marimo
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

READ_ROUTES = frozenset({"/", "/favicon.ico", "/manifest.json", "/health"})
PHOTO_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".avif"})
UI_UPDATE = "/api/kernel/set_ui_element_value"
MAX_WIDGET_BODY_BYTES = 64 * 1024
WIDGET_BODY_SECONDS = 10
MAX_SESSION_STARTS = 30
SESSION_START_WINDOW_SECONDS = 60
# The locked marimo run-mode kernel uses this CPython thread name suffix.
KERNEL_THREAD_SUFFIX = " (launch_kernel_with_cleanup)"
# marimo renders per-process inline <script> config, so script-src would need
# per-response nonces. These directives restrict only framing, plugins and <base>.
CONTENT_SECURITY_POLICY = b"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
SECURITY_HEADERS = [
    (b"cache-control", b"no-store"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"x-robots-tag", b"noindex, nofollow"),
    (b"content-security-policy", CONTENT_SECURITY_POLICY),
]
REPLACED_HEADERS = frozenset(name for name, _ in SECURITY_HEADERS)
MANIFEST = "release.json"


def not_found(text: str = "Not found", status_code: int = 404) -> PlainTextResponse:
    response = PlainTextResponse(text, status_code=status_code)
    for name, value in SECURITY_HEADERS:
        response.headers[name.decode()] = value.decode()
    return response


def env_flag(name: str) -> bool:
    """Read a 1/0 environment switch, refusing anything ambiguous."""
    value = os.environ.get(name, "")
    if value in {"", "0", "false"}:
        return False
    if value in {"1", "true"}:
        return True
    raise RuntimeError(f"{name} must be 1 or 0")


def release_file(release: Path, relative: str) -> Path:
    """Resolve a clean relative path inside the release, refusing symlinks anywhere."""
    parts = relative.split("/")
    if (
        not relative
        or relative.startswith("/")
        or "\\" in relative
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise RuntimeError(f"Invalid release path: {relative!r}")
    path = release
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise RuntimeError(f"Release paths must not be symlinks: {relative!r}")
    if not path.resolve().is_relative_to(release) or not path.is_file():
        raise RuntimeError(f"Release file is missing: {relative!r}")
    return path


def check_release_tree(
    release: Path, *, uid: int | None, gids: Collection[int] = ()
) -> None:
    """Refuse symlinks, special files and anything the dashboard user could change.

    `uid` and `gids` identify the dashboard process. The owner of a file can always
    chmod it, so the tree must belong to another user (root in the images) and carry
    no write bit the process holds. `uid=None` skips that check for local test trees.
    """
    if uid == 0:
        raise RuntimeError("The public dashboard must not run as root")

    def check(path: Path) -> None:
        info = path.lstat()
        relative = path.relative_to(release).as_posix()
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError(f"Release paths must not be symlinks: {relative!r}")
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise RuntimeError(f"Release paths must be files or folders: {relative!r}")
        if uid is not None and (
            info.st_uid == uid
            or info.st_mode & stat.S_IWOTH
            or (info.st_mode & stat.S_IWGRP and info.st_gid in gids)
        ):
            raise RuntimeError(
                f"Release path is writable by the dashboard user: {relative!r}"
            )

    def fail(error: OSError) -> None:
        raise RuntimeError(f"Release tree is unreadable: {error}") from error

    check(release)
    for root, directories, files in os.walk(release, onerror=fail):
        for name in [*directories, *files]:
            check(Path(root) / name)


def verify_release(release: Path, entrypoint: str, *, required: bool = False) -> None:
    """Fail closed unless the release matches its manifest exactly.

    Manually assembled releases have no manifest and skip this check. Managed
    deployments pass `required` so a missing manifest refuses to start.
    """
    manifest_path = release / MANIFEST
    if not manifest_path.exists() and not manifest_path.is_symlink():
        if required:
            raise RuntimeError("release.json is required for this deployment")
        return
    manifest = json.loads(release_file(release, MANIFEST).read_bytes())
    if manifest.get("schema_version") != 1 or manifest.get("entrypoint") != entrypoint:
        raise RuntimeError("release.json does not describe this entrypoint")
    expected = {}
    for item in manifest.get("files", []):
        path = release_file(release, item["path"])
        if path.stat().st_size != item["size_bytes"]:
            raise RuntimeError(f"Release file changed: {item['path']!r}")
        with path.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        if digest != item["sha256"]:
            raise RuntimeError(f"Release file changed: {item['path']!r}")
        expected[item["path"]] = path
    if entrypoint not in expected:
        raise RuntimeError("release.json does not list the entrypoint")
    for root, directories, files in os.walk(release):
        for name in directories:
            if (Path(root) / name).is_symlink():
                raise RuntimeError("Release directories must not be symlinks")
        for name in files:
            relative = (Path(root) / name).relative_to(release).as_posix()
            if relative != MANIFEST and relative not in expected:
                raise RuntimeError(f"Unexpected release file: {relative!r}")


@dataclass(eq=False)
class Session:
    """One viewer's capacity slot, held while its socket is open or its kernel runs."""

    open: bool = True
    kernel: threading.Thread | None = None

    def live(self) -> bool:
        return self.open or (self.kernel is not None and self.kernel.is_alive())


# The socket session whose ASGI handler is running in the current task.
CURRENT_SESSION: ContextVar[Session | None] = ContextVar("session", default=None)


def attribute_kernel(event: str, args: tuple[object, ...]) -> None:
    """Bind a marimo kernel thread to the socket session whose handler starts it.

    marimo starts a run-mode kernel thread inside the WebSocket handler's task, so
    the context still names that session. Unattributed kernels count separately.
    Audit hooks must never raise, so every lookup here is defensive.
    """
    if event != "_thread.start_joinable_thread" or not args:
        return
    session = CURRENT_SESSION.get()
    thread = getattr(args[0], "__self__", None)
    if (
        session is not None
        and session.kernel is None
        and isinstance(thread, threading.Thread)
        and thread.name.endswith(KERNEL_THREAD_SUFFIX)
    ):
        session.kernel = thread


sys.addaudithook(attribute_kernel)


async def read_body(receive: Receive) -> bytes | None:
    """Read a request body up to MAX_WIDGET_BODY_BYTES; None if the client left."""
    body = bytearray()
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return None
        body.extend(message.get("body", b""))
        if len(body) > MAX_WIDGET_BODY_BYTES:
            raise OverflowError
        if not message.get("more_body", False):
            return bytes(body)


class PublicDashboard:
    """ASGI gate in front of marimo: route allowlist, origin checks and capacity.

    Capacity is counted in sessions. A session holds its slot from admission until
    both its socket has closed and its kernel thread has exited, because marimo
    cannot stop a run-mode kernel mid-cell. When detached kernels alone fill every
    slot for `stuck_seconds`, `/health` returns 503 so a liveness probe can restart
    the instance; open viewer sockets always keep it healthy.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        origin: str,
        max_sessions: int = 6,
        connection_seconds: float = 270,
        stuck_seconds: float = 180,
    ) -> None:
        url = urlsplit(origin)
        if (
            url.scheme not in {"http", "https"}
            or url.username
            or url.password
            or not url.hostname
            or url.path
            or url.query
            or url.fragment
            or (url.scheme == "http" and url.hostname not in {"127.0.0.1", "localhost"})
        ):
            raise ValueError("PUBLIC_DASHBOARD_ORIGIN must be an origin without a path")
        self.app = app
        self.origin = origin.encode("ascii")
        self.max_sessions = max_sessions
        self.connection_seconds = connection_seconds
        self.stuck_seconds = stuck_seconds
        self.sessions: set[Session] = set()
        self.session_starts: deque[float] = deque()
        self.exhausted_since: float | None = None

    def occupied(self) -> int:
        """Live sessions plus kernel threads that no session claimed."""
        self.sessions = {session for session in self.sessions if session.live()}
        claimed = {session.kernel for session in self.sessions}
        strays = sum(
            thread.name.endswith(KERNEL_THREAD_SUFFIX) and thread not in claimed
            for thread in threading.enumerate()
        )
        return len(self.sessions) + strays

    def stuck(self) -> bool:
        """True once detached kernels alone have filled capacity for stuck_seconds."""
        exhausted = self.occupied() >= self.max_sessions and not any(
            session.open for session in self.sessions
        )
        if not exhausted:
            self.exhausted_since = None
            return False
        now = time.monotonic()
        if self.exhausted_since is None:
            self.exhausted_since = now
        return now - self.exhausted_since >= self.stuck_seconds

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return

        path = scope["path"]
        headers = scope.get("headers", [])
        origins = [value for key, value in headers if key == b"origin"]
        local_origin = origins == [self.origin]

        if scope["type"] == "websocket":
            if path != "/ws" or not local_origin:
                await send({"type": "websocket.close", "code": 1008})
                return
            now = time.monotonic()
            while (
                self.session_starts
                and now - self.session_starts[0] >= SESSION_START_WINDOW_SECONDS
            ):
                self.session_starts.popleft()
            if (
                self.occupied() >= self.max_sessions
                or len(self.session_starts) >= MAX_SESSION_STARTS
            ):
                await send({"type": "websocket.close", "code": 1013})
                return
            self.session_starts.append(now)
            session = Session()
            self.sessions.add(session)
            token = CURRENT_SESSION.set(session)
            connected = False

            async def track_receive() -> Message:
                nonlocal connected
                message = await receive()
                if message["type"] == "websocket.disconnect":
                    connected = False
                return message

            async def track_send(message: Message) -> None:
                nonlocal connected
                if message["type"] == "websocket.accept":
                    connected = True
                elif message["type"] == "websocket.close":
                    connected = False
                await send(message)

            try:
                deadline = asyncio.timeout(self.connection_seconds)
                try:
                    async with deadline:
                        await self.app(scope, track_receive, track_send)
                except TimeoutError:
                    if not deadline.expired():
                        raise
                # marimo's streaming handler can consume the timeout cancellation.
                if deadline.expired() and connected:
                    await send({"type": "websocket.close", "code": 1001})
            finally:
                session.open = False
                CURRENT_SESSION.reset(token)
            return

        method = scope["method"]
        clean_path = "\\" not in path and not any(
            part in {".", ".."} for part in path.split("/")
        )
        if (
            clean_path
            and method in {"GET", "HEAD"}
            and (
                path in READ_ROUTES
                or path.startswith("/assets/")
                or (
                    path.startswith("/public/")
                    and Path(path).suffix.lower() in PHOTO_EXTENSIONS
                )
            )
        ):
            if path == "/health" and self.stuck():
                await not_found("Detached kernels exhausted capacity", 503)(
                    scope, receive, send
                )
                return
        elif method != "POST" or path != UI_UPDATE or not local_origin:
            await not_found()(scope, receive, send)
            return

        if method == "POST":
            declared = next((v for k, v in headers if k == b"content-length"), b"0")
            if not declared.isdigit():
                await not_found("Bad request", 400)(scope, receive, send)
                return
            if int(declared) > MAX_WIDGET_BODY_BYTES:
                await not_found("Widget update too large", 413)(scope, receive, send)
                return
            # A deadline stops slow senders from holding the request open.
            try:
                async with asyncio.timeout(WIDGET_BODY_SECONDS):
                    body = await read_body(receive)
            except TimeoutError:
                await not_found("Widget update timed out", 408)(scope, receive, send)
                return
            except OverflowError:
                await not_found("Widget update too large", 413)(scope, receive, send)
                return
            if body is None:
                return

            upstream_receive = receive
            pending_body = True

            async def replay_body() -> Message:
                nonlocal pending_body
                if pending_body:
                    pending_body = False
                    return {"type": "http.request", "body": body}
                return await upstream_receive()

            receive = replay_body

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = [
                    (key, value)
                    for key, value in message["headers"]
                    if key.lower() not in REPLACED_HEADERS
                ]
                message["headers"] = [*response_headers, *SECURITY_HEADERS]
            await send(message)

        await self.app(scope, receive, send_with_headers)


def create_app(
    *,
    connection_seconds: float = 270,
    max_sessions: int = 6,
    stuck_seconds: float = 180,
    check_owner: bool = True,
) -> ASGIApp:
    """Uvicorn factory. Tests pass `check_owner=False` for trees they own."""
    release = Path(os.environ.get("PUBLIC_DASHBOARD_RELEASE", "/release"))
    if release.is_symlink():
        raise RuntimeError("The release directory must not be a symlink")
    release = release.resolve()
    entrypoint = os.environ.get("PUBLIC_DASHBOARD_ENTRYPOINT", "notebook.py")
    check_release_tree(
        release,
        uid=os.geteuid() if check_owner else None,
        gids={os.getegid(), *os.getgroups()},
    )
    notebook = release_file(release, entrypoint)
    verify_release(
        release, entrypoint, required=env_flag("PUBLIC_DASHBOARD_REQUIRE_MANIFEST")
    )
    # The release is assembled separately from the hub and contains one reviewed entrypoint.
    app = (
        marimo.create_asgi_app(
            include_code=False,
            redirect_console_to_browser=False,
            show_tracebacks=False,
            session_ttl=0,
        )
        .with_app(path="", root=str(notebook))
        .build()
    )
    routes = []
    photos = release / "public"
    if photos.is_dir():
        routes.append(Mount("/public", StaticFiles(directory=photos)))
    routes.append(Mount("/", app=app))
    return PublicDashboard(
        Starlette(routes=routes),
        origin=os.environ["PUBLIC_DASHBOARD_ORIGIN"],
        connection_seconds=connection_seconds,
        max_sessions=max_sessions,
        stuck_seconds=stuck_seconds,
    )
