import asyncio
import threading

import pytest
from starlette.responses import PlainTextResponse
from starlette.testclient import TestClient
from starlette.types import Receive, Scope, Send
from starlette.websockets import WebSocket, WebSocketDisconnect

import gateway
from gateway import MAX_WIDGET_BODY_BYTES, PublicDashboard

ORIGIN = "http://127.0.0.1:8080"


async def runtime(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] == "websocket":
        ws = WebSocket(scope, receive, send)
        await ws.accept()
        await ws.receive_text()
        await ws.close()
        return

    await PlainTextResponse("dashboard", headers={"Cache-Control": "public"})(
        scope, receive, send
    )


def test_read_and_widget_requests_are_available():
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    for path in ["/", "/assets/main.js", "/public/photo.jpg"]:
        response = client.get(path)
        assert response.text == "dashboard"
        assert response.headers["Cache-Control"] == "no-store"

    assert (
        client.post(
            "/api/kernel/set_ui_element_value", headers={"Origin": ORIGIN}, json={}
        ).status_code
        == 200
    )


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/projects"),
        ("GET", "/public/%2e%2e/notebook.py"),
        ("GET", "/notebook.py"),
        ("GET", "/@file/photo.jpg"),
        ("POST", "/api/kernel/run"),
        ("POST", "/api/kernel/function_call"),
        ("POST", "/api/export/html"),
        ("POST", "/api/files/read_code"),
        ("GET", "/api/files/download?path=notebook.py"),
        ("GET", "/api/environment"),
        ("PUT", "/public/photo.jpg"),
    ],
)
def test_only_dashboard_routes_are_forwarded(method, path):
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    assert client.request(method, path, headers={"Origin": ORIGIN}).status_code == 404


def test_widget_requests_require_dashboard_origin():
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    assert client.post("/api/kernel/set_ui_element_value", json={}).status_code == 404
    assert (
        client.post(
            "/api/kernel/set_ui_element_value",
            headers={"Origin": "https://example.com"},
        ).status_code
        == 404
    )


def test_only_same_origin_dashboard_websocket_is_available():
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws"):
        pass
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws_sync", headers={"Origin": ORIGIN}),
    ):
        pass
    with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as socket:
        socket.send_text("done")


def test_websockets_are_bounded_and_close_on_timeout():
    app = PublicDashboard(
        runtime, origin=ORIGIN, max_sessions=1, connection_seconds=0.15
    )
    client = TestClient(app)
    with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as socket:
        with (
            pytest.raises(WebSocketDisconnect) as rejected,
            client.websocket_connect("/ws", headers={"Origin": ORIGIN}),
        ):
            pass
        assert rejected.value.code == 1013
        with pytest.raises(WebSocketDisconnect) as timed_out:
            socket.receive_text()
        assert timed_out.value.code == 1001
    assert app.occupied() == 0


def test_released_viewer_slots_still_count_toward_session_start_budget(monkeypatch):
    monkeypatch.setattr(gateway, "MAX_SESSION_STARTS", 3)
    app = PublicDashboard(runtime, origin=ORIGIN)
    client = TestClient(app)
    for _ in range(3):
        with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as socket:
            socket.send_text("done")
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_text()
            assert closed.value.code == 1000
    assert app.occupied() == 0
    with (
        pytest.raises(WebSocketDisconnect) as rejected,
        client.websocket_connect("/ws", headers={"Origin": ORIGIN}),
    ):
        pass
    assert rejected.value.code == 1013


def test_widget_update_limits_streamed_body():
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    response = client.post(
        "/api/kernel/set_ui_element_value",
        headers={"Origin": ORIGIN},
        content=iter([b"a" * MAX_WIDGET_BODY_BYTES, b"b"]),
    )
    assert response.status_code == 413


def test_responses_carry_security_headers():
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    for response in [client.get("/"), client.get("/notebook.py")]:
        assert response.headers["Cache-Control"] == "no-store"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["Referrer-Policy"] == "no-referrer"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["X-Robots-Tag"] == "noindex, nofollow"
        assert response.headers["Content-Security-Policy"] == (
            "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
        )


def test_widget_update_refuses_declared_oversize_body():
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    response = client.post(
        "/api/kernel/set_ui_element_value",
        headers={"Origin": ORIGIN},
        content=b"a" * (MAX_WIDGET_BODY_BYTES + 1),
    )
    assert response.status_code == 413


def test_widget_update_body_has_a_deadline(monkeypatch):
    monkeypatch.setattr(gateway, "WIDGET_BODY_SECONDS", 0.05)
    sent = []

    async def stalled_receive():
        await asyncio.sleep(10)
        return {"type": "http.disconnect"}

    async def record(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/kernel/set_ui_element_value",
        "headers": [(b"origin", ORIGIN.encode()), (b"content-length", b"10")],
    }
    asyncio.run(PublicDashboard(runtime, origin=ORIGIN)(scope, stalled_receive, record))
    assert sent[0]["status"] == 408


# Mirrors marimo's run-mode kernel thread so its name carries the counted suffix.
def launch_kernel_with_cleanup(release: threading.Event) -> None:
    release.wait(10)


def join_kernels() -> None:
    for thread in threading.enumerate():
        if thread.name.endswith(gateway.KERNEL_THREAD_SUFFIX):
            thread.join(5)


def kernel_runtime(release: threading.Event):
    """A fake runtime whose socket handler starts a kernel that outlives the socket."""

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            threading.Thread(
                target=launch_kernel_with_cleanup, args=(release,), daemon=True
            ).start()
            ws = WebSocket(scope, receive, send)
            await ws.accept()
            await ws.receive_text()
            await ws.close()
            return
        await runtime(scope, receive, send)

    return app


def rejected(client: TestClient) -> bool:
    try:
        with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as socket:
            socket.send_text("done")
    except WebSocketDisconnect as error:
        assert error.code == 1013
        return True
    return False


def test_started_session_uses_one_slot_until_its_kernel_exits():
    release = threading.Event()
    app = PublicDashboard(kernel_runtime(release), origin=ORIGIN, max_sessions=2)
    client = TestClient(app)
    try:
        with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as first:
            assert app.occupied() == 1
            with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as second:
                assert app.occupied() == 2
                second.send_text("done")
            first.send_text("done")
        # Both sockets closed, but their kernels are still running.
        assert app.occupied() == 2
        assert rejected(client)
    finally:
        release.set()
    join_kernels()
    assert app.occupied() == 0
    assert not rejected(client)


def test_unclaimed_kernel_threads_count_against_capacity():
    release = threading.Event()
    stray = threading.Thread(
        target=launch_kernel_with_cleanup, args=(release,), daemon=True
    )
    stray.start()
    try:
        app = PublicDashboard(runtime, origin=ORIGIN, max_sessions=1)
        assert app.occupied() == 1
        assert rejected(TestClient(app))
    finally:
        release.set()
        stray.join(5)


def test_health_fails_only_while_detached_kernels_fill_capacity():
    release = threading.Event()
    app = PublicDashboard(
        kernel_runtime(release), origin=ORIGIN, max_sessions=1, stuck_seconds=0
    )
    client = TestClient(app)
    try:
        with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as socket:
            # A connected viewer keeps the instance healthy even at full capacity.
            assert client.get("/health").status_code == 200
            socket.send_text("done")
        assert client.get("/health").status_code == 503
    finally:
        release.set()
    join_kernels()
    assert client.get("/health").status_code == 200


def test_health_waits_for_sustained_exhaustion():
    release = threading.Event()
    app = PublicDashboard(
        kernel_runtime(release), origin=ORIGIN, max_sessions=1, stuck_seconds=60
    )
    client = TestClient(app)
    try:
        with client.websocket_connect("/ws", headers={"Origin": ORIGIN}) as socket:
            socket.send_text("done")
        assert client.get("/health").status_code == 200
        assert app.exhausted_since is not None
    finally:
        release.set()
        join_kernels()
