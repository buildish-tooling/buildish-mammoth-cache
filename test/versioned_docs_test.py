#
# Copyright 2026 The Buildish Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Exercise developer scripts using real, disposable Git repositories."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import io
import json
import shutil
import subprocess
import tarfile
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError

SCRIPTS = Path(__file__).resolve().parents[1] / "tools/versioned-docs"
PUBLISHED_AT = "2026-11-25T08:06:43Z"


def load_manage():
    spec = importlib.util.spec_from_file_location(
        "versioned_docs_manage", SCRIPTS / "manage.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            *args,
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def run(
    repo: Path, command: str, *args: str, success: bool = True
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(SCRIPTS / f"{command}.sh"), "--source", str(repo), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if (result.returncode == 0) != success:
        raise AssertionError(result.stdout + result.stderr)
    return result


def commit(repo: Path) -> None:
    git(repo, "add", "--all")
    git(repo, "commit", "-m", "fixture")


LICENSED_NOTES = "<!--\nLicense header\n-->\n\n# Mammoth Cache {version}\n\nChanges in {version}.\n"


def release(
    repo: Path,
    version: str,
    content: str = "release docs\n",
    notes: str | None = None,
) -> None:
    (repo / "docs/_index.md").write_text(content)
    if notes is not None:
        path = repo / f"buildish-release-tooling/release-notes/{version}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(notes.format(version=version))
    commit(repo)
    git(repo, "tag", f"v{version}")


class VersionedDocsScriptsTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp_path = Path(temporary.name)
        tmp_path = self.tmp_path
        repo = tmp_path / "source with spaces"
        repo.mkdir()
        git(repo, "init", "-b", "main")
        (repo / "docs").mkdir()
        (repo / ".gitignore").write_text("docs/releases/\n")
        release(repo, "0.1.2", "incomplete\n")
        release(repo, "0.1.3")
        git(repo, "tag", "v0.1.4-rc1")
        self.source = repo

    def test_create_import_and_incremental(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        self.assertFalse((worktree / "docs").exists())
        run(source, "import")
        self.assertEqual((worktree / "0.1.3/_index.md").read_text(), "release docs\n")
        self.assertTrue((worktree / "0.1.2").is_dir())
        self.assertFalse((worktree / "0.1.4-rc1").exists())
        snapshot = json.loads((worktree / "provider-snapshot.json").read_text())
        self.assertEqual(
            snapshot["artifacts"],
            [{"componentSlug": "mammoth-cache", "artifactKey": "mammoth-cache"}],
        )
        self.assertEqual(snapshot["providers"][0]["key"], "mammoth-cache-tags")
        self.assertEqual(snapshot["providers"][0]["type"], "git-tags")
        for record in snapshot["records"]:
            self.assertEqual(record["componentSlug"], "mammoth-cache")
            self.assertEqual(record["artifactKey"], "mammoth-cache")
            self.assertEqual(record["provider"], "mammoth-cache-tags")
            self.assertEqual(
                record["externalId"], f"git:buildish-mammoth-cache:{record['tag']}"
            )
            self.assertEqual(
                record["externalUrl"],
                f"https://github.com/buildish-tooling/buildish-mammoth-cache/releases/tag/{record['tag']}",
            )
            self.assertNotIn("publishedAt", record)
            self.assertNotIn("publicationState", record)
            self.assertNotIn("releaseLine", record)
            self.assertNotIn("docsSource", record)
        self.assertEqual(
            next(
                record for record in snapshot["records"] if record["version"] == "0.1.3"
            )["commitSha"],
            git(source, "rev-parse", "v0.1.3^{commit}"),
        )
        # Imports are deliberately left for review, without an automatic commit.
        self.assertTrue(git(worktree, "status", "--porcelain"))
        self.assertEqual(git(worktree, "diff", "--cached", "--name-only"), "")
        commit(worktree)
        self.assertEqual(len(git(worktree, "rev-list", "--parents", "HEAD").split()), 1)
        original = (worktree / "provider-snapshot.json").read_bytes()
        run(source, "import")
        self.assertEqual((worktree / "provider-snapshot.json").read_bytes(), original)
        release(source, "0.1.4", "new docs\n")
        run(source, "import")
        self.assertEqual((worktree / "0.1.3/_index.md").read_text(), "release docs\n")
        self.assertEqual((worktree / "0.1.4/_index.md").read_text(), "new docs\n")
        self.assertFalse(git(source, "status", "--porcelain"))
        archive = subprocess.check_output(["git", "-C", str(source), "archive", "HEAD"])
        with tarfile.open(fileobj=io.BytesIO(archive)) as source_archive:
            self.assertFalse(
                any(
                    name.startswith("docs/releases")
                    for name in source_archive.getnames()
                )
            )
        self.assertEqual(git(source, "branch", "--show-current"), "main")

    def post_release(self, version: str, responses: dict | None = None):
        module = load_manage()
        tag = f"v{version}"
        captured_commit = git(self.source, "rev-parse", f"{tag}^{{commit}}")
        api = "https://api.github.com/repos/buildish-tooling/buildish-mammoth-cache"
        tag_object = "1" * 40
        payloads = {
            f"{api}/releases/tags/{tag}": {
                "tag_name": tag,
                "draft": False,
                "prerelease": False,
                "published_at": PUBLISHED_AT,
                "target_commitish": "main",
            },
            f"{api}/git/ref/tags/{tag}": {
                "ref": f"refs/tags/{tag}",
                "object": {"type": "tag", "sha": tag_object},
            },
            f"{api}/git/tags/{tag_object}": {
                "object": {"type": "commit", "sha": captured_commit},
            },
        }
        for endpoint, payload in (responses or {}).items():
            payloads[f"{api}/{endpoint}"] = payload

        def open_response(request, *, timeout):
            payload = payloads[request.full_url]
            if payload is None:
                raise HTTPError(request.full_url, 404, "Not Found", {}, None)
            return io.BytesIO(json.dumps(payload).encode())

        args = [
            "manage.py",
            "import",
            "--source",
            str(self.source),
            "--post-release",
            "--version",
            version,
        ]
        with (
            patch("sys.argv", args),
            patch("sys.stdout", new_callable=io.StringIO) as stdout,
            patch("sys.stderr", new_callable=io.StringIO) as stderr,
            patch.object(module, "urlopen", side_effect=open_response),
        ):
            status = module.main()
        return status, stdout.getvalue(), stderr.getvalue()

    def test_post_release_backfills_and_advances_latest(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import", "--version", "0.1.3")
        worktree = source / "docs/releases"
        path = worktree / "provider-snapshot.json"
        docs = worktree / "0.1.3/_index.md"
        docs_inode = docs.stat().st_ino
        commit(worktree)

        status, out, error = self.post_release("0.1.3")
        self.assertEqual(status, 0, error)
        self.assertIn("Updated release metadata", out)
        self.assertEqual(docs.stat().st_ino, docs_inode)
        snapshot = json.loads(path.read_text())
        record = snapshot["records"][0]
        self.assertEqual(record["publishedAt"], PUBLISHED_AT)
        self.assertEqual(record["publicationState"], "published")
        self.assertEqual(record["releaseLine"], "0.1")
        self.assertEqual(
            record["docsSource"],
            {
                "repository": "https://github.com/buildish-tooling/buildish-mammoth-cache",
                "root": "docs",
                "ref": git(source, "rev-parse", "v0.1.3^{commit}"),
            },
        )
        artifact = snapshot["artifacts"][0]
        self.assertEqual(artifact["latestStable"], "0.1.3")
        self.assertEqual(artifact["releaseLines"], [{"key": "0.1", "latest": "0.1.3"}])
        artifact["releaseLines"][0]["supportStatus"] = "maintained"
        path.write_text(json.dumps(snapshot))
        commit(worktree)
        before = path.read_bytes()
        self.assertEqual(self.post_release("0.1.3")[0], 0)
        self.assertEqual(path.read_bytes(), before)

        self.assertEqual(self.post_release("0.1.2")[0], 0)
        self.assertEqual(json.loads(path.read_text())["artifacts"][0], artifact)
        commit(worktree)
        release(source, "0.1.4", "new patch\n")
        self.assertEqual(self.post_release("0.1.4")[0], 0)
        self.assertEqual((worktree / "0.1.4/_index.md").read_text(), "new patch\n")
        current = json.loads(path.read_text())["artifacts"][0]
        self.assertEqual(current["latestStable"], "0.1.4")
        self.assertEqual(
            current["releaseLines"],
            [{"key": "0.1", "latest": "0.1.4", "supportStatus": "maintained"}],
        )

    def test_post_release_verification_failure_leaves_worktree_clean(self) -> None:
        run(self.source, "checkout", "--create")
        worktree = self.source / "docs/releases"
        release_facts = {
            "tag_name": "v0.1.3",
            "draft": False,
            "prerelease": False,
            "published_at": PUBLISHED_AT,
        }
        cases = (
            ({"releases/tags/v0.1.3": None}, "404"),
            ({"releases/tags/v0.1.3": {**release_facts, "draft": True}}, "final published"),
            (
                {"releases/tags/v0.1.3": {**release_facts, "prerelease": True}},
                "final published",
            ),
            (
                {"releases/tags/v0.1.3": {**release_facts, "published_at": None}},
                "timestamp",
            ),
            (
                {
                    "git/ref/tags/v0.1.3": {
                        "ref": "refs/tags/v0.1.3",
                        "object": {"type": "commit", "sha": "0" * 40},
                    }
                },
                "does not match",
            ),
        )
        for responses, message in cases:
            with self.subTest(responses=responses):
                status, _, error = self.post_release("0.1.3", responses)
                self.assertEqual(status, 1)
                self.assertIn(message, error)
                self.assertEqual(git(worktree, "status", "--porcelain"), "")

    def test_post_release_preserves_curated_exclusion(self) -> None:
        run(self.source, "checkout", "--create")
        run(self.source, "import", "--version", "0.1.3")
        worktree = self.source / "docs/releases"
        path = worktree / "provider-snapshot.json"
        snapshot = json.loads(path.read_text())
        snapshot["artifacts"][0]["releases"] = [
            {"version": "0.1.3", "publicationState": "withdrawn"}
        ]
        path.write_text(json.dumps(snapshot))
        commit(worktree)
        status, _, error = self.post_release("0.1.3")
        self.assertEqual(status, 1)
        self.assertIn("excluded by snapshot publication policy", error)
        self.assertEqual(git(worktree, "status", "--porcelain"), "")

    def test_dirty_refused_and_full_rebuild_scope(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import", "--version", "0.1.2", "--version", "0.1.3")
        commit(worktree)
        (worktree / "README.md").write_text("Keep this\n")
        run(source, "import", "--full-rebuild", success=False)
        commit(worktree)
        run(source, "import", "--full-rebuild", "--version", "0.1.3")
        self.assertTrue((worktree / "0.1.2").is_dir())
        self.assertTrue((worktree / "0.1.3/_index.md").is_file())
        self.assertEqual((worktree / "README.md").read_text(), "Keep this\n")

    def test_curated_metadata_survives_incremental_and_full_rebuild(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import")
        path = worktree / "provider-snapshot.json"
        snapshot = json.loads(path.read_text())
        withdrawn = snapshot["records"][0]
        self.assertEqual(withdrawn["version"], "0.1.2")
        withdrawn["publicationState"] = "withdrawn"
        withdrawn["supportStatus"] = "unsupported"
        withdrawn["urls"] = {"explanation": "https://example.org/incomplete-release"}
        path.write_text(json.dumps(snapshot, indent=2) + "\n")
        # Rebuild restores docs, while retaining the curated inventory entry.
        (worktree / "0.1.2/_index.md").write_text("manual docs change\n")
        commit(worktree)
        release(source, "0.1.4", "new docs\n")
        for options in (
            (),
            ("--full-rebuild", "--version", "0.1.3"),
            ("--full-rebuild",),
        ):
            with self.subTest(options=options):
                run(source, "import", *options)
                current = json.loads(path.read_text())
                self.assertEqual(current["records"][0], withdrawn)
                self.assertEqual(len(current["records"]), 3)
                if git(worktree, "status", "--porcelain"):
                    commit(worktree)
        self.assertEqual((worktree / "0.1.2/_index.md").read_text(), "incomplete\n")

    def test_optional_minimum_version_filters_discovery(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import", "--minimum-version", "0.1.3")
        self.assertFalse((source / "docs/releases/0.1.2").exists())

    def test_invalid_export_does_not_remove_existing_docs(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import")
        commit(worktree)
        (source / "docs/_index.md").unlink()
        commit(source)
        git(source, "tag", "v0.1.4")
        run(source, "import", "--full-rebuild", success=False)
        self.assertTrue((worktree / "0.1.3/_index.md").is_file())
        self.assertFalse(git(worktree, "status", "--porcelain"))

    def test_changed_tag_and_unowned_directory_refused(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import")
        commit(worktree)
        git(source, "tag", "-f", "v0.1.3", "v0.1.2")
        result = run(source, "import", success=False)
        self.assertIn("Tag changed", result.stderr)
        (worktree / "0.1.4").mkdir()
        (worktree / "0.1.4/_index.md").write_text("hand authored\n")
        commit(worktree)
        release(source, "0.1.4", "real docs\n")
        result = run(source, "import", "--version", "0.1.4", success=False)
        self.assertIn("unowned", result.stderr)
        self.assertEqual((worktree / "0.1.4/_index.md").read_text(), "hand authored\n")

    def test_checkout_remote_update_and_divergence(self) -> None:
        source = self.source
        tmp_path = self.tmp_path
        # This local repository plays the role of the HTTPS remote; no network used.
        remote = tmp_path / "remote"
        git(tmp_path, "clone", str(source), str(remote))
        run(remote, "checkout", "--create")
        remote_docs = remote / "docs/releases"
        (remote_docs / "README.md").write_text("first\n")
        commit(remote_docs)
        run(source, "checkout", "--remote", str(remote))
        worktree = source / "docs/releases"
        self.assertEqual((worktree / "README.md").read_text(), "first\n")
        (remote_docs / "README.md").write_text("second\n")
        commit(remote_docs)
        run(source, "update", "--remote", str(remote))
        self.assertEqual((worktree / "README.md").read_text(), "second\n")
        (worktree / "README.md").write_text("local\n")
        run(source, "update", "--remote", str(remote), success=False)
        commit(worktree)
        (remote_docs / "README.md").write_text("third\n")
        commit(remote_docs)
        head = git(worktree, "rev-parse", "HEAD")
        run(source, "update", "--remote", str(remote), success=False)
        self.assertEqual(git(worktree, "rev-parse", "HEAD"), head)
        self.assertEqual((worktree / "README.md").read_text(), "local\n")

    def test_final_materialized_tag_commit_is_recorded(self) -> None:
        source = self.source
        reviewed_source = git(source, "rev-parse", "HEAD")
        (source / "dist").mkdir()
        (source / "dist/index.cjs").write_text("// generated\n")
        commit(source)
        materialized = git(source, "rev-parse", "HEAD")
        git(source, "tag", "v0.1.4")
        run(source, "checkout", "--create")
        run(source, "import", "--version", "0.1.4")
        worktree = source / "docs/releases"
        snapshot = json.loads((worktree / "provider-snapshot.json").read_text())
        self.assertNotEqual(reviewed_source, materialized)
        self.assertEqual(snapshot["records"][0]["commitSha"], materialized)
        self.assertEqual((worktree / "0.1.4/_index.md").read_text(), "release docs\n")

    def test_absent_local_tags_retain_inventory_and_curated_records(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        commit(worktree)
        before = (worktree / "provider-snapshot.json").read_bytes()
        git(source, "tag", "-d", "v0.1.2", "v0.1.3")
        for options in ((), ("--full-rebuild",)):
            run(source, "import", *options)
            self.assertEqual((worktree / "provider-snapshot.json").read_bytes(), before)
        run(source, "import", "--version", "0.1.3", success=False)
        self.assertEqual((worktree / "provider-snapshot.json").read_bytes(), before)

    def test_incremental_keeps_curated_docs_and_records_missing_tags(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        snapshot["records"][0]["publicationState"] = "hidden"
        snapshot["records"][0]["supportStatus"] = "unsupported"
        snapshot_file.write_text(json.dumps(snapshot))
        (worktree / "0.1.3/_index.md").write_text("curated docs\n")
        commit(worktree)
        git(source, "tag", "-d", "v0.1.2")
        release(source, "0.1.4", "new docs\n")
        run(source, "import")
        self.assertEqual((worktree / "0.1.3/_index.md").read_text(), "curated docs\n")
        self.assertEqual(
            json.loads(snapshot_file.read_text())["records"][0], snapshot["records"][0]
        )
        commit(worktree)
        run(source, "import", "--full-rebuild")
        self.assertEqual(
            json.loads(snapshot_file.read_text())["records"][0], snapshot["records"][0]
        )

    def test_excluded_records_without_docs_are_not_rediscovered(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        shutil.rmtree(worktree / "0.1.2")
        for state in ("hidden", "withdrawn", "tombstoned"):
            with self.subTest(state=state):
                snapshot["records"][0]["publicationState"] = state
                snapshot_file.write_text(json.dumps(snapshot))
                commit(worktree)
                before = snapshot_file.read_bytes()
                run(source, "import")
                self.assertEqual(snapshot_file.read_bytes(), before)
                self.assertFalse((worktree / "0.1.2").exists())

    def test_explicit_version_overrides_minimum_and_missing_published_docs_fail(
        self,
    ) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import", "--minimum-version", "9.0.0", "--version", "0.1.2")
        worktree = source / "docs/releases"
        self.assertTrue((worktree / "0.1.2/_index.md").is_file())
        shutil.rmtree(worktree / "0.1.2")
        commit(worktree)
        result = run(source, "import", success=False)
        self.assertIn("Missing docs", result.stderr)
        run(source, "import", "--full-rebuild", "--version", "0.1.2")
        self.assertEqual((worktree / "0.1.2/_index.md").read_text(), "incomplete\n")

    def test_import_does_not_fetch_configure_stage_or_move_source(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        config = (source / ".git/config").read_bytes()
        refs = git(source, "for-each-ref", "--format=%(refname) %(objectname)")
        head = git(source, "rev-parse", "HEAD")
        run(source, "import")
        self.assertEqual((source / ".git/config").read_bytes(), config)
        self.assertEqual(
            git(source, "for-each-ref", "--format=%(refname) %(objectname)"), refs
        )
        self.assertEqual(git(source, "rev-parse", "HEAD"), head)
        self.assertFalse((source / ".git/FETCH_HEAD").exists())
        self.assertFalse(
            git(source / "docs/releases", "diff", "--cached", "--name-only")
        )

    def test_local_checkout_does_not_fetch_or_configure_remote(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        (worktree / "README.md").write_text("docs branch\n")
        commit(worktree)
        git(source, "worktree", "remove", str(worktree))
        config = (source / ".git/config").read_bytes()
        run(source, "checkout", "--remote", str(self.tmp_path / "missing-remote"))
        self.assertEqual((source / ".git/config").read_bytes(), config)
        self.assertFalse((source / ".git/FETCH_HEAD").exists())

    def test_dangling_snapshot_symlink_is_rejected(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        target = self.tmp_path / "absent-snapshot.json"
        (worktree / "provider-snapshot.json").symlink_to(target)
        commit(worktree)
        result = run(source, "import", success=False)
        self.assertIn("Snapshot must not be a symlink", result.stderr)
        self.assertFalse(target.exists())

    def test_foreign_inventory_and_moved_rebuild_are_rejected(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        snapshot["records"][0]["artifactKey"] = "release-tooling"
        snapshot_file.write_text(json.dumps(snapshot))
        commit(worktree)
        result = run(source, "import", "--full-rebuild", success=False)
        self.assertIn("foreign", result.stderr)
        snapshot["records"][0]["artifactKey"] = "mammoth-cache"
        snapshot_file.write_text(json.dumps(snapshot))
        commit(worktree)
        git(source, "tag", "-f", "v0.1.3", "v0.1.2")
        result = run(source, "import", "--full-rebuild", success=False)
        self.assertIn("Tag changed", result.stderr)
        self.assertFalse(git(worktree, "status", "--porcelain"))

    def test_accidentally_tagged_nested_history_is_rejected(self) -> None:
        source = self.source
        history = source / "docs/releases/0.0.1"
        history.mkdir(parents=True)
        (history / "_index.md").write_text("historical docs\n")
        git(source, "add", "--force", "docs/releases/0.0.1/_index.md")
        commit(source)
        git(source, "tag", "v0.1.4")
        worktree = self.tmp_path / "separate-docs"
        run(source, "checkout", "--create", "--worktree", str(worktree))
        result = run(
            source,
            "import",
            "--version",
            "0.1.4",
            "--worktree",
            str(worktree),
            success=False,
        )
        self.assertIn("Unexpected docs path", result.stderr)
        self.assertFalse((worktree / "provider-snapshot.json").exists())

    def test_export_uses_captured_commit_when_tag_moves_concurrently(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        module = load_manage()
        original_export = module.export_docs
        captured_commit = git(source, "rev-parse", "v0.1.3^{commit}")

        def move_tag_then_export(repo: Path, ref: str, destination: Path) -> None:
            git(source, "tag", "--force", "v0.1.3", "v0.1.2")
            original_export(repo, ref, destination)

        args = argparse.Namespace(
            source=source,
            worktree=worktree,
            branch="versioned-docs",
            version=["0.1.3"],
            minimum_version=None,
            full_rebuild=False,
            post_release=False,
        )
        with patch.object(module, "export_docs", side_effect=move_tag_then_export):
            module.import_docs(args)
        snapshot = json.loads((worktree / "provider-snapshot.json").read_text())
        self.assertEqual(snapshot["records"][0]["commitSha"], captured_commit)
        self.assertEqual((worktree / "0.1.3/_index.md").read_text(), "release docs\n")

    def test_scoped_release_facts_survive_append_and_rebuild_without_latest_inference(
        self,
    ) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        facts = {
            "componentSlug": "mammoth-cache",
            "artifactKey": "mammoth-cache",
            "latestStable": "0.1.3",
            "releaseLines": [
                {"key": "0.x", "latest": "0.1.3"},
                {
                    "key": "0.1",
                    "parent": "0.x",
                    "latest": "0.1.3",
                    "supportStatus": "maintained",
                },
            ],
            "releases": [
                {
                    "version": "0.1.2",
                    "releaseLine": "0.1",
                    "publicationState": "hidden",
                    "supportWindow": {
                        "supportPolicyUrl": "https://example.org/support",
                        "notes": "Keep curated policy",
                    },
                },
                {
                    "version": "0.1.3",
                    "releaseLine": "0.1",
                    "supportStatus": "maintained",
                },
            ],
        }
        snapshot["artifacts"] = [facts]
        snapshot_file.write_text(json.dumps(snapshot))
        shutil.rmtree(worktree / "0.1.2")
        commit(worktree)
        git(source, "tag", "-d", "v0.1.2")
        release(source, "0.1.4", "new docs\n")
        for options in (
            (),
            ("--full-rebuild", "--version", "0.1.4"),
            ("--full-rebuild",),
        ):
            with self.subTest(options=options):
                run(source, "import", *options)
                current = json.loads(snapshot_file.read_text())
                self.assertEqual(current["artifacts"], [facts])
                self.assertEqual(len(current["records"]), 3)
                self.assertFalse((worktree / "0.1.2").exists())
                self.assertEqual(
                    (worktree / "0.1.4/_index.md").read_text(), "new docs\n"
                )
                commit(worktree)

    def test_records_only_inventory_is_preserved_then_upgraded_without_release_claims(
        self,
    ) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        snapshot.pop("artifacts")
        snapshot_file.write_text(json.dumps(snapshot))
        commit(worktree)
        before = snapshot_file.read_bytes()
        run(source, "import")
        self.assertEqual(snapshot_file.read_bytes(), before)
        release(source, "0.1.4", "new docs\n")
        run(source, "import")
        current = json.loads(snapshot_file.read_text())
        self.assertEqual(
            current["artifacts"],
            [{"componentSlug": "mammoth-cache", "artifactKey": "mammoth-cache"}],
        )
        self.assertEqual(current["records"][:2], snapshot["records"])

    def test_explicit_empty_artifact_policy_is_preserved(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        snapshot["artifacts"] = []
        snapshot_file.write_text(json.dumps(snapshot))
        commit(worktree)
        release(source, "0.1.4", "new docs\n")
        for options in ((), ("--full-rebuild",)):
            run(source, "import", *options)
            self.assertEqual(json.loads(snapshot_file.read_text())["artifacts"], [])
            commit(worktree)

    def test_invalid_scoped_artifacts_fail_before_any_write(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        identity = snapshot["artifacts"][0]
        cases = [
            None,
            [{**identity, "componentSlug": "release-tooling"}],
            [{**identity, "artifactKey": "other"}],
            [identity, identity],
            [{**identity, "releaseLines": {}}],
            [{**identity, "releases": {}}],
            [{**identity, "releases": [{"version": "0.1.2"}, {"version": "0.1.2"}]}],
            [
                {
                    **identity,
                    "releaseLines": [
                        {"key": "0.1", "latest": "0.1.2"},
                        {"key": "0.1", "latest": "0.1.3"},
                    ],
                }
            ],
            [{**identity, "latestStable": "0.1.4-rc1"}],
        ]
        for artifacts in cases:
            with self.subTest(artifacts=artifacts):
                current = copy.deepcopy(snapshot)
                current["artifacts"] = artifacts
                snapshot_file.write_text(json.dumps(current))
                commit(worktree)
                before = snapshot_file.read_bytes()
                run(source, "import", "--full-rebuild", success=False)
                self.assertEqual(snapshot_file.read_bytes(), before)
                self.assertFalse(git(worktree, "status", "--porcelain"))
                self.assertEqual(
                    (worktree / "0.1.3/_index.md").read_text(), "release docs\n"
                )

    def test_scoped_exclusion_allows_absent_original_docs(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        shutil.rmtree(worktree / "0.1.2")
        for state in ("hidden", "withdrawn", "tombstoned"):
            with self.subTest(state=state):
                snapshot["artifacts"][0]["releases"] = [
                    {"version": "0.1.2", "publicationState": state}
                ]
                snapshot_file.write_text(json.dumps(snapshot))
                commit(worktree)
                before = snapshot_file.read_bytes()
                run(source, "import")
                self.assertEqual(snapshot_file.read_bytes(), before)
                self.assertFalse((worktree / "0.1.2").exists())

    def test_explicit_scoped_and_provider_states_cannot_conflict(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import")
        worktree = source / "docs/releases"
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        snapshot["records"][0]["publicationState"] = "published"
        snapshot["artifacts"][0]["releases"] = [
            {"version": "0.1.2", "publicationState": "hidden"}
        ]
        snapshot_file.write_text(json.dumps(snapshot))
        commit(worktree)
        before = snapshot_file.read_bytes()
        result = run(source, "import", "--full-rebuild", success=False)
        self.assertIn("Contradictory publication states", result.stderr)
        self.assertEqual(snapshot_file.read_bytes(), before)
        self.assertFalse(git(worktree, "status", "--porcelain"))

    def test_existing_version_symlinks_are_rejected_before_incremental_return(
        self,
    ) -> None:
        for state in (None, "hidden"):
            with self.subTest(state=state):
                # Each case needs a separate clean source/docs worktree pair.
                source = self.source
                worktree = self.tmp_path / (
                    "published-docs" if state is None else "hidden-docs"
                )
                branch = "published-docs" if state is None else "hidden-docs"
                run(
                    source,
                    "checkout",
                    "--create",
                    "--worktree",
                    str(worktree),
                    "--branch",
                    branch,
                )
                run(source, "import", "--worktree", str(worktree), "--branch", branch)
                snapshot_file = worktree / "provider-snapshot.json"
                snapshot = json.loads(snapshot_file.read_text())
                if state is not None:
                    snapshot["records"][0]["publicationState"] = state
                    snapshot_file.write_text(json.dumps(snapshot))
                outside = self.tmp_path / f"outside-{branch}"
                outside.mkdir()
                (outside / "_index.md").write_text("external content\n")
                shutil.rmtree(worktree / "0.1.2")
                (worktree / "0.1.2").symlink_to(outside, target_is_directory=True)
                commit(worktree)
                before = snapshot_file.read_bytes()
                result = run(
                    source,
                    "import",
                    "--worktree",
                    str(worktree),
                    "--branch",
                    branch,
                    success=False,
                )
                self.assertIn("must not be a symlink", result.stderr)
                self.assertEqual(snapshot_file.read_bytes(), before)
                self.assertEqual(
                    (outside / "_index.md").read_text(), "external content\n"
                )
                self.assertFalse(git(worktree, "status", "--porcelain"))

    def test_release_notes_are_imported_without_title_and_backfilled(self) -> None:
        source = self.source
        release(source, "0.1.4", "notes docs\n", LICENSED_NOTES)
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import")
        notes = worktree / "release-notes/0.1.4.md"
        self.assertEqual(
            notes.read_text(), "<!--\nLicense header\n-->\n\nChanges in 0.1.4.\n"
        )
        snapshot_file = worktree / "provider-snapshot.json"
        records = {
            record["version"]: record
            for record in json.loads(snapshot_file.read_text())["records"]
        }
        self.assertEqual(records["0.1.4"]["releaseNotes"], {"path": "release-notes/0.1.4.md"})
        # Tags without notes keep publishing docs only.
        self.assertNotIn("releaseNotes", records["0.1.3"])
        commit(worktree)
        before = snapshot_file.read_bytes()
        run(source, "import")
        self.assertEqual(snapshot_file.read_bytes(), before)
        self.assertFalse(git(worktree, "status", "--porcelain"))

        # An inventory from before notes support gains them on incremental import.
        snapshot = json.loads(before)
        del snapshot["records"][-1]["releaseNotes"]
        snapshot_file.write_text(json.dumps(snapshot, indent=2) + "\n")
        notes.unlink()
        (worktree / "0.1.4/_index.md").write_text("curated docs\n")
        commit(worktree)
        run(source, "import")
        self.assertEqual(notes.read_text().count("Changes in 0.1.4."), 1)
        self.assertEqual(
            json.loads(snapshot_file.read_text())["records"][-1]["releaseNotes"],
            {"path": "release-notes/0.1.4.md"},
        )
        # Backfilling notes leaves existing docs alone.
        self.assertEqual((worktree / "0.1.4/_index.md").read_text(), "curated docs\n")

    def test_release_notes_are_not_added_for_excluded_releases(self) -> None:
        source = self.source
        release(source, "0.1.4", "notes docs\n", LICENSED_NOTES)
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import", "--version", "0.1.4")
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        del snapshot["records"][0]["releaseNotes"]
        (worktree / "release-notes/0.1.4.md").unlink()
        for state in ("hidden", "withdrawn", "tombstoned"):
            with self.subTest(state=state):
                snapshot["records"][0]["publicationState"] = state
                snapshot_file.write_text(json.dumps(snapshot))
                commit(worktree)
                for options in ((), ("--full-rebuild",)):
                    run(source, "import", "--version", "0.1.4", *options)
                    self.assertFalse((worktree / "release-notes/0.1.4.md").exists())
                    record = json.loads(snapshot_file.read_text())["records"][0]
                    self.assertNotIn("releaseNotes", record)
                    if git(worktree, "status", "--porcelain"):
                        commit(worktree)

    def test_unowned_or_symlinked_release_notes_are_refused(self) -> None:
        source = self.source
        release(source, "0.1.4", "notes docs\n", LICENSED_NOTES)
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import", "--version", "0.1.3")
        commit(worktree)
        notes_root = worktree / "release-notes"
        notes_root.mkdir()
        (notes_root / "0.1.4.md").write_text("hand-written\n")
        commit(worktree)
        result = run(source, "import", "--version", "0.1.4", success=False)
        self.assertIn("unowned path", result.stderr)
        self.assertEqual((notes_root / "0.1.4.md").read_text(), "hand-written\n")
        (notes_root / "0.1.4.md").unlink()
        outside = self.tmp_path / "outside-notes"
        outside.write_text("external\n")
        (notes_root / "0.1.4.md").symlink_to(outside)
        commit(worktree)
        result = run(source, "import", "--version", "0.1.4", success=False)
        self.assertIn("unowned path", result.stderr)
        self.assertEqual(outside.read_text(), "external\n")
        self.assertFalse(git(worktree, "status", "--porcelain"))

    def test_unmanaged_release_notes_reference_is_rejected(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        worktree = source / "docs/releases"
        run(source, "import")
        snapshot_file = worktree / "provider-snapshot.json"
        snapshot = json.loads(snapshot_file.read_text())
        snapshot["records"][0]["releaseNotes"] = {"path": "elsewhere.md"}
        snapshot_file.write_text(json.dumps(snapshot))
        commit(worktree)
        result = run(source, "import", success=False)
        self.assertIn("unmanaged release notes", result.stderr)

    def test_strip_title_drops_only_one_leading_heading(self) -> None:
        strip = load_manage().strip_title
        self.assertEqual(strip("# Title\n\nBody\n"), "Body\n")
        self.assertEqual(
            strip("<!--\nheader\n-->\n\n# Title\n\n## Part\n"),
            "<!--\nheader\n-->\n\n## Part\n",
        )
        for text in ("## Part\n\nBody\n", "Intro\n\n# Later\n", "#hashtag\n"):
            with self.subTest(text=text):
                self.assertEqual(strip(text), text)

    def test_rejects_symlink_docs_and_wrong_worktree(self) -> None:
        source = self.source
        run(source, "checkout", "--create")
        run(source, "import", "--worktree", str(source), success=False)
        (source / "docs/link").symlink_to("/etc/passwd")
        release(source, "0.1.4", "new docs\n")
        result = run(source, "import", success=False)
        self.assertIn("symlink", result.stderr)
        self.assertFalse((source / "docs/releases/0.1.3").exists())
