import hashlib
import json

import pytest

from gateway import create_app, release_file, verify_release

NOTEBOOK = b"import marimo\napp = marimo.App()\n"


def write_release(root, files, entrypoint="notebook.py"):
    for path, data in files.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(data)
    manifest = {
        "schema_version": 1,
        "release_id": "01JRELEASE0000000000000000",
        "entrypoint": entrypoint,
        "files": [
            {
                "path": path,
                "sha256": hashlib.sha256(data).hexdigest(),
                "size_bytes": len(data),
            }
            for path, data in files.items()
        ],
    }
    (root / "release.json").write_text(json.dumps(manifest))


def test_exact_release_passes(tmp_path):
    write_release(tmp_path, {"notebook.py": NOTEBOOK, "public/a.png": b"png"})
    verify_release(tmp_path, "notebook.py")


@pytest.mark.parametrize("change", ["modified", "missing", "extra", "entrypoint"])
def test_release_fails_closed(tmp_path, change):
    write_release(tmp_path, {"notebook.py": NOTEBOOK, "data/t.csv": b"a,b"})
    if change == "modified":
        (tmp_path / "data/t.csv").write_bytes(b"a,c")
    elif change == "missing":
        (tmp_path / "data/t.csv").unlink()
    elif change == "extra":
        (tmp_path / "secret.txt").write_bytes(b"x")
    with pytest.raises(RuntimeError):
        verify_release(
            tmp_path, "other.py" if change == "entrypoint" else "notebook.py"
        )


def test_symlinked_files_are_refused(tmp_path):
    write_release(tmp_path, {"notebook.py": NOTEBOOK})
    (tmp_path / "outside.txt").write_bytes(b"x")
    (tmp_path / "link.txt").symlink_to(tmp_path / "outside.txt")
    with pytest.raises(RuntimeError):
        release_file(tmp_path, "link.txt")


def test_manual_release_without_manifest_is_unchecked(tmp_path):
    (tmp_path / "notebook.py").write_bytes(NOTEBOOK)
    (tmp_path / "anything.csv").write_bytes(b"1")
    verify_release(tmp_path, "notebook.py")


@pytest.mark.parametrize(
    "entrypoint", ["../notebook.py", "/etc/passwd", "a/../notebook.py", "a\\b.py", ""]
)
def test_entrypoint_must_stay_inside_the_release(tmp_path, monkeypatch, entrypoint):
    (tmp_path / "notebook.py").write_bytes(NOTEBOOK)
    monkeypatch.setenv("PUBLIC_DASHBOARD_RELEASE", str(tmp_path))
    monkeypatch.setenv("PUBLIC_DASHBOARD_ORIGIN", "http://127.0.0.1:8080")
    monkeypatch.setenv("PUBLIC_DASHBOARD_ENTRYPOINT", entrypoint)
    with pytest.raises(RuntimeError):
        create_app()


def test_nested_entrypoint_loads(tmp_path, monkeypatch):
    write_release(tmp_path, {"apps/sales.py": NOTEBOOK}, entrypoint="apps/sales.py")
    monkeypatch.setenv("PUBLIC_DASHBOARD_RELEASE", str(tmp_path))
    monkeypatch.setenv("PUBLIC_DASHBOARD_ORIGIN", "http://127.0.0.1:8080")
    monkeypatch.setenv("PUBLIC_DASHBOARD_ENTRYPOINT", "apps/sales.py")
    create_app()
