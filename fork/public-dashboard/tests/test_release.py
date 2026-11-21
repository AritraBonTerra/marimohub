import asyncio
import hashlib
import json
import re
import socket
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from subprocess import Popen
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

SOURCE_MARKER = "fixture_source_only_12b38704"
NOTEBOOK = """import marimo

app = marimo.App()

@app.cell
def _():
    import marimo as mo
    # fixture_source_only_12b38704
    district = mo.ui.dropdown(["North", "South"], value="North", label="District")
    district
    return district, mo

@app.cell
def _(district, mo):
    mo.md(f"Selected store district: {district.value}")
    return
"""


def seal(release):
    """Write release.json and make the tree read-only, as a managed release image does."""
    files = sorted(p for p in release.rglob("*") if p.is_file())
    manifest = {
        "schema_version": 1,
        "release_id": "01JRELEASE0000000000000000",
        "entrypoint": "notebook.py",
        "files": [
            {
                "path": p.relative_to(release).as_posix(),
                "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                "size_bytes": p.stat().st_size,
            }
            for p in files
        ],
    }
    (release / "release.json").write_text(json.dumps(manifest))
    for path in [*release.rglob("*"), release]:
        path.chmod(0o555 if path.is_dir() else 0o444)


def fetch(origin, path, session, *, token="", body=None):
    request = Request(
        origin + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Origin": origin,
            "Content-Type": "application/json",
            "Marimo-Session-Id": session,
            "Marimo-Server-Token": token,
        },
    )
    try:
        response = urlopen(request, timeout=5)
    except HTTPError as exc:
        response = exc
    with response:
        return response.status, response.read()


@contextmanager
def live_release(
    tmp_path,
    *,
    connection_seconds=270,
    max_connections=12,
    notebook=NOTEBOOK,
    sealed=False,
):
    (tmp_path / "notebook.py").write_text(notebook)
    (tmp_path / "public").mkdir()
    (tmp_path / "public" / "approved.jpg").write_bytes(b"approved-photo-bytes")
    if sealed:
        seal(tmp_path)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    with Popen(
        [
            sys.executable,
            "-c",
            (
                "import uvicorn; from gateway import create_app; "
                f"uvicorn.run(create_app(connection_seconds={connection_seconds}, "
                f"max_connections={max_connections}), port={port})"
            ),
        ],
        cwd=Path(__file__).resolve().parents[1],
        env={
            "PUBLIC_DASHBOARD_ORIGIN": origin,
            "PUBLIC_DASHBOARD_RELEASE": str(tmp_path),
            "HOME": str(tmp_path.parent if sealed else tmp_path),
            "MARIMO_SKIP_UPDATE_CHECK": "1",
        },
    ) as process:
        try:
            deadline = time.monotonic() + 15
            while process.poll() is None and time.monotonic() < deadline:
                try:
                    if fetch(origin, "/", "probe")[0] == 200:
                        yield origin
                        return
                except URLError:
                    time.sleep(0.1)
            raise AssertionError("Public dashboard did not start")
        finally:
            process.terminate()
            process.wait(timeout=10)


async def check_widget(origin, session, token):
    async with websockets.connect(
        origin.replace("http:", "ws:") + f"/ws?session_id={session}",
        origin=origin,
    ) as websocket:
        messages = []
        async with asyncio.timeout(10):
            while not any(
                "Selected store district: North" in item for item in messages
            ):
                messages.append(await websocket.recv(decode=True))
            object_id = re.search(r"object-id='([^']+)'", "\n".join(messages))
            assert object_id
            status, _ = fetch(
                origin,
                "/api/kernel/set_ui_element_value",
                session,
                token=token,
                body={"objectIds": [object_id[1]], "values": [["South"]]},
            )
            assert status == 200
            while not any(
                "Selected store district: South" in item for item in messages
            ):
                messages.append(await websocket.recv(decode=True))
        assert SOURCE_MARKER not in "".join(messages)


def test_live_release_is_interactive_without_exposing_source(tmp_path):
    with live_release(tmp_path) as origin:
        session = str(uuid4())
        status, html = fetch(origin, "/?include-code=true&show-code=true", session)
        assert status == 200
        assert SOURCE_MARKER.encode() not in html
        token = re.search(rb'<marimo-server-token data-token="([^"]+)"', html)
        assert token
        asyncio.run(check_widget(origin, session, token[1].decode()))
        assert fetch(origin, "/public/approved.jpg", session) == (
            200,
            b"approved-photo-bytes",
        )
        assert fetch(origin, "/api/files/download?path=notebook.py", session)[0] == 404


def test_sealed_read_only_release_is_interactive(tmp_path):
    release = tmp_path / "release"
    release.mkdir()
    try:
        with live_release(release, sealed=True) as origin:
            session = str(uuid4())
            status, html = fetch(origin, "/", session)
            assert status == 200
            token = re.search(rb'<marimo-server-token data-token="([^"]+)"', html)
            assert token
            asyncio.run(check_widget(origin, session, token[1].decode()))
            assert fetch(origin, "/release.json", session)[0] == 404
    finally:
        for path in [release, *release.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)


def test_live_socket_sends_close_at_its_deadline(tmp_path):
    async def check_deadline(origin):
        for _ in range(2):
            async with websockets.connect(
                origin.replace("http:", "ws:") + f"/ws?session_id={uuid4()}",
                origin=origin,
            ) as websocket:
                async with asyncio.timeout(8):
                    while "Selected store district: North" not in await websocket.recv(
                        decode=True
                    ):
                        pass
                    with pytest.raises(ConnectionClosed) as timed_out:
                        while True:
                            await websocket.recv()
                    assert timed_out.value.rcvd is not None
                    assert timed_out.value.rcvd.code == 1001

    with live_release(tmp_path, connection_seconds=2) as origin:
        asyncio.run(check_deadline(origin))


def test_live_kernel_counts_against_budget_after_disconnect(tmp_path):
    notebook = NOTEBOOK.replace(
        "    district = mo.ui.dropdown",
        "    import time\n"
        "    from pathlib import Path\n"
        "    Path(mo.notebook_dir(), 'started').touch()\n"
        "    while not Path(mo.notebook_dir(), 'stop').exists():\n"
        "        time.sleep(0.02)\n"
        "    district = mo.ui.dropdown",
    )

    async def check_budget(origin):
        def connect():
            return websockets.connect(
                origin.replace("http:", "ws:") + f"/ws?session_id={uuid4()}",
                origin=origin,
            )

        try:
            async with asyncio.timeout(8):
                async with connect():
                    while not (tmp_path / "started").exists():
                        await asyncio.sleep(0.02)
                with pytest.raises(InvalidStatus) as limited:
                    async with connect():
                        pytest.fail("The disconnected kernel still occupies the slot")
                assert limited.value.response.status_code == 403
        finally:
            (tmp_path / "stop").touch()

    with live_release(tmp_path, max_connections=1, notebook=notebook) as origin:
        asyncio.run(check_budget(origin))
