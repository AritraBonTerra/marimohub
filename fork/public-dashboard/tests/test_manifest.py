import hashlib
import json
import os

import pytest

from gateway import (
    check_release_tree,
    create_app,
    env_flag,
    release_file,
    verify_release,
)

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
        create_app(check_owner=False)


def test_nested_entrypoint_loads(tmp_path, monkeypatch):
    write_release(tmp_path, {"apps/sales.py": NOTEBOOK}, entrypoint="apps/sales.py")
    monkeypatch.setenv("PUBLIC_DASHBOARD_RELEASE", str(tmp_path))
    monkeypatch.setenv("PUBLIC_DASHBOARD_ORIGIN", "http://127.0.0.1:8080")
    monkeypatch.setenv("PUBLIC_DASHBOARD_ENTRYPOINT", "apps/sales.py")
    create_app(check_owner=False)


def test_required_manifest_must_exist(tmp_path):
    (tmp_path / "notebook.py").write_bytes(NOTEBOOK)
    with pytest.raises(RuntimeError, match="required"):
        verify_release(tmp_path, "notebook.py", required=True)


def test_required_manifest_is_enforced_at_startup(tmp_path, monkeypatch):
    (tmp_path / "notebook.py").write_bytes(NOTEBOOK)
    monkeypatch.setenv("PUBLIC_DASHBOARD_RELEASE", str(tmp_path))
    monkeypatch.setenv("PUBLIC_DASHBOARD_ORIGIN", "http://127.0.0.1:8080")
    monkeypatch.setenv("PUBLIC_DASHBOARD_REQUIRE_MANIFEST", "1")
    with pytest.raises(RuntimeError, match="required"):
        create_app(check_owner=False)


def test_dangling_manifest_symlink_is_refused(tmp_path):
    (tmp_path / "notebook.py").write_bytes(NOTEBOOK)
    (tmp_path / "release.json").symlink_to(tmp_path / "missing.json")
    with pytest.raises(RuntimeError):
        verify_release(tmp_path, "notebook.py")


@pytest.mark.parametrize("value", ["yes", "TRUE", " 1"])
def test_ambiguous_flags_are_refused(monkeypatch, value):
    monkeypatch.setenv("PUBLIC_DASHBOARD_REQUIRE_MANIFEST", value)
    with pytest.raises(RuntimeError):
        env_flag("PUBLIC_DASHBOARD_REQUIRE_MANIFEST")


# The tests own their trees, so another uid stands in for the dashboard user.
DASHBOARD_UID = os.getuid() + 1


def manual_release(root):
    (root / "notebook.py").write_bytes(NOTEBOOK)
    (root / "public").mkdir()
    (root / "public" / "a.png").write_bytes(b"png")
    for path in [root, *root.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)


def test_tree_owned_by_another_user_passes(tmp_path):
    manual_release(tmp_path)
    check_release_tree(tmp_path, uid=DASHBOARD_UID, gids={DASHBOARD_UID})


@pytest.mark.parametrize("link", ["file", "directory", "dangling", "photo"])
def test_symlinks_anywhere_in_the_tree_are_refused(tmp_path, link):
    release = tmp_path / "release"
    release.mkdir()
    manual_release(release)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_bytes(b"x")
    if link == "file":
        (release / "data.txt").symlink_to(outside / "secret.txt")
    elif link == "directory":
        (release / "data").symlink_to(outside)
    elif link == "dangling":
        (release / "data.txt").symlink_to(outside / "missing.txt")
    else:
        (release / "public" / "b.png").symlink_to(outside / "secret.txt")
    with pytest.raises(RuntimeError, match="symlink"):
        check_release_tree(release, uid=None)


def test_manual_release_symlinks_are_refused_at_startup(tmp_path, monkeypatch):
    manual_release(tmp_path)
    (tmp_path / "public" / "b.png").symlink_to("/etc/hostname")
    monkeypatch.setenv("PUBLIC_DASHBOARD_RELEASE", str(tmp_path))
    monkeypatch.setenv("PUBLIC_DASHBOARD_ORIGIN", "http://127.0.0.1:8080")
    with pytest.raises(RuntimeError, match="symlink"):
        create_app(check_owner=False)


def test_special_files_are_refused(tmp_path):
    manual_release(tmp_path)
    os.mkfifo(tmp_path / "pipe")
    with pytest.raises(RuntimeError, match="files or folders"):
        check_release_tree(tmp_path, uid=None)


def test_tree_owned_by_the_dashboard_user_is_refused(tmp_path):
    manual_release(tmp_path)
    for path in [tmp_path, *tmp_path.rglob("*")]:
        path.chmod(0o555 if path.is_dir() else 0o444)
    try:
        # Read-only modes are not enough: the owner can chmod them back.
        with pytest.raises(RuntimeError, match="writable"):
            check_release_tree(tmp_path, uid=os.getuid(), gids=set())
    finally:
        for path in [tmp_path, *tmp_path.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)


@pytest.mark.parametrize("mode", [0o646, 0o664])
def test_writable_modes_are_refused(tmp_path, mode):
    manual_release(tmp_path)
    (tmp_path / "public" / "a.png").chmod(mode)
    group = (tmp_path / "public" / "a.png").stat().st_gid
    with pytest.raises(RuntimeError, match="writable"):
        check_release_tree(tmp_path, uid=DASHBOARD_UID, gids={group})


def test_group_write_for_another_group_is_allowed(tmp_path):
    manual_release(tmp_path)
    (tmp_path / "public" / "a.png").chmod(0o664)
    check_release_tree(tmp_path, uid=DASHBOARD_UID, gids={DASHBOARD_UID})


def test_dashboard_refuses_to_run_as_root(tmp_path):
    manual_release(tmp_path)
    with pytest.raises(RuntimeError, match="root"):
        check_release_tree(tmp_path, uid=0)
