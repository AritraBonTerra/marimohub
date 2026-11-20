import pytest
from starlette.responses import PlainTextResponse
from starlette.testclient import TestClient
from starlette.types import Receive, Scope, Send
from starlette.websockets import WebSocket, WebSocketDisconnect

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
        runtime, origin=ORIGIN, max_connections=1, connection_seconds=0.15
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
    assert app.connections == 0


def test_widget_update_limits_streamed_body():
    client = TestClient(PublicDashboard(runtime, origin=ORIGIN))
    response = client.post(
        "/api/kernel/set_ui_element_value",
        headers={"Origin": ORIGIN},
        content=iter([b"a" * MAX_WIDGET_BODY_BYTES, b"b"]),
    )
    assert response.status_code == 413
