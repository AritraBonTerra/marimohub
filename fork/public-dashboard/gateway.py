"""Expose one reviewed marimo app on an origin separate from the hub."""

import asyncio
import os
import threading
from pathlib import Path
from urllib.parse import urlsplit

import marimo
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

READ_ROUTES = frozenset({"/", "/favicon.ico", "/manifest.json", "/health"})
PHOTO_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".avif"})
UI_UPDATE = "/api/kernel/set_ui_element_value"
MAX_WIDGET_BODY_BYTES = 64 * 1024
# The locked marimo run-mode kernel uses this CPython thread name suffix.
KERNEL_THREAD_SUFFIX = " (launch_kernel_with_cleanup)"


class PublicDashboard:
    def __init__(
        self,
        app: ASGIApp,
        *,
        origin: str,
        max_connections: int = 12,
        connection_seconds: float = 270,
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
        self.max_connections = max_connections
        self.connection_seconds = connection_seconds
        self.connections = 0

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
            # A detached kernel can keep executing until its current cell returns.
            # Count live kernels and sockets, including those still starting.
            kernels = sum(
                thread.name.endswith(KERNEL_THREAD_SUFFIX)
                for thread in threading.enumerate()
            )
            if self.connections + kernels >= self.max_connections:
                await send({"type": "websocket.close", "code": 1013})
                return
            self.connections += 1
            connected = False

            async def track_receive():
                nonlocal connected
                message = await receive()
                if message["type"] == "websocket.disconnect":
                    connected = False
                return message

            async def track_send(message):
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
                self.connections -= 1
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
            pass
        elif method != "POST" or path != UI_UPDATE or not local_origin:
            await PlainTextResponse(
                "Not found", status_code=404, headers={"Cache-Control": "no-store"}
            )(scope, receive, send)
            return

        if method == "POST":
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                if len(body) + len(chunk) > MAX_WIDGET_BODY_BYTES:
                    await PlainTextResponse(
                        "Widget update too large",
                        status_code=413,
                        headers={"Cache-Control": "no-store"},
                    )(scope, receive, send)
                    return
                body.extend(chunk)
                if not message.get("more_body", False):
                    break

            upstream_receive = receive
            pending_body = True

            async def read_widget_body():
                nonlocal pending_body
                if pending_body:
                    pending_body = False
                    return {"type": "http.request", "body": bytes(body)}
                return await upstream_receive()

            receive = read_widget_body

        async def send_without_cache(message):
            if message["type"] == "http.response.start":
                response_headers = [
                    (key, value)
                    for key, value in message["headers"]
                    if key.lower() not in {b"cache-control", b"x-content-type-options"}
                ]
                message["headers"] = [
                    *response_headers,
                    (b"cache-control", b"no-store"),
                    (b"x-content-type-options", b"nosniff"),
                ]
            await send(message)

        await self.app(scope, receive, send_without_cache)


def create_app(
    *, connection_seconds: float = 270, max_connections: int = 12
) -> ASGIApp:
    release = Path(os.environ.get("PUBLIC_DASHBOARD_RELEASE", "/release")).resolve()
    notebook = release / "notebook.py"
    if not notebook.is_file():
        raise RuntimeError("Release must contain notebook.py")
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
        if photos.is_symlink():
            raise RuntimeError("The public photo directory must not be a symlink")
        routes.append(Mount("/public", StaticFiles(directory=photos)))
    routes.append(Mount("/", app=app))
    return PublicDashboard(
        Starlette(routes=routes),
        origin=os.environ["PUBLIC_DASHBOARD_ORIGIN"],
        connection_seconds=connection_seconds,
        max_connections=max_connections,
    )
