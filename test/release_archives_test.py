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

"""Exercise unsigned packaging against real disposable Git objects and archives."""

from __future__ import annotations

import gzip
import os
import subprocess
import sys
import tarfile
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from versioned_docs_test import commit, git

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/package-release.py"


class ReleaseArchivesTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo, self.source, self.materialized = self.pair("source with spaces")

    def pair(
        self,
        name: str,
        extra: dict[str, str] | None = None,
        missing_legal: bool = False,
        sha256: bool = False,
    ) -> tuple[Path, str, str]:
        repo = self.root / name
        repo.mkdir()
        git(repo, "init", "-b", "main", *(["--object-format=sha256"] if sha256 else []))
        files = {
            ".gitignore": "dist/\ndocs/releases/\n",
            "source.txt": "reviewed source\n",
            "LICENSE": "Source license fixture\n",
            "NOTICE": "Source notice fixture\n",
            "legal/github/LICENSE": "Bundled license fixture\n",
            "legal/github/NOTICE": "Bundled notice fixture\n",
            "scripts/fixture.sh": "#!/bin/sh\nexit 0\n",
        }
        for tool in ("gradle", "maven"):
            files[f"actions/github/{tool}/action.yml"] = (
                f"runs:\n  using: node24\n  main: ../../../dist/github/{tool}/main/index.cjs\n"
                f"  post: ../../../dist/github/{tool}/post/index.cjs\n"
            )
        files.update(extra or {})
        if missing_legal:
            files.pop("legal/github/NOTICE")
        for path, content in files.items():
            destination = repo / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content)
        (repo / "scripts/fixture.sh").chmod(0o755)
        git(repo, "add", "--force", "--all")
        git(repo, "update-index", "--chmod=+x", "scripts/fixture.sh")
        git(repo, "commit", "-m", "reviewed source")
        source = git(repo, "rev-parse", "HEAD")
        for tool in ("gradle", "maven"):
            for phase in ("main", "post"):
                bundle = repo / f"dist/github/{tool}/{phase}/index.cjs"
                bundle.parent.mkdir(parents=True, exist_ok=True)
                bundle.write_text(f"// generated {tool} {phase}\n")
        git(repo, "add", "--force", "dist")
        git(repo, "commit", "-m", "materialized payload")
        return repo, source, git(repo, "rev-parse", "HEAD")

    def run_package(
        self,
        *,
        repo: Path | None = None,
        source: str | None = None,
        materialized: str | None = None,
        output: Path | None = None,
        version: str = "1.2.3",
        env: dict | None = None,
        success: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(SCRIPT),
                "--repository",
                str(repo or self.repo),
                "--source-commit",
                source if source is not None else self.source,
                "--materialized-commit",
                materialized if materialized is not None else self.materialized,
                "--version",
                version,
                "--output-dir",
                str(output or self.root / "archives"),
            ],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertFalse(list(self.root.glob(".mammoth-package-*")))
        return result

    def test_omits_only_the_dormant_graph_from_both_archives(self) -> None:
        graph = "test/qualification/distributed-correctness"
        retained = f"{graph}-other/example.txt"
        repo, source, materialized = self.pair(
            "graph isolation", {f"{graph}/nested/helper.mjs": "dormant", retained: "shipped"}
        )
        self.run_package(repo=repo, source=source, materialized=materialized)
        output = self.root / "archives"
        with (
            tarfile.open(next(output.glob("*.tar.gz"))) as source_archive,
            zipfile.ZipFile(next(output.glob("*.zip"))) as action_archive,
        ):
            for names in (source_archive.getnames(), action_archive.namelist()):
                self.assertTrue(any(name.endswith("/" + retained) for name in names))
                self.assertFalse(
                    any(
                        name.rstrip("/").endswith("/" + graph) or f"/{graph}/" in name
                        for name in names
                    )
                )

        (repo / graph / "nested" / "helper.mjs").write_text("changed after source")
        git(repo, "add", "--all")
        git(repo, "commit", "-m", "change omitted file in materialization")
        result = self.run_package(
            repo=repo,
            source=source,
            materialized=git(repo, "rev-parse", "HEAD"),
            output=self.root / "mismatched",
            success=False,
        )
        self.assertIn("preserve source files/modes", result.stderr)

    def test_exact_commits_archive_roots_modes_and_no_worktree_fallback(self) -> None:
        (self.repo / "source.txt").write_text("uncommitted corruption\n")
        (self.repo / "untracked.txt").write_text("must not ship\n")
        history = self.repo / "docs/releases/0.0.1"
        history.mkdir(parents=True)
        (history / "_index.md").write_text("must not ship\n")
        config = (self.repo / ".git/config").read_bytes()
        refs = git(self.repo, "show-ref")
        status = git(self.repo, "status", "--porcelain")
        self.run_package()
        output = self.root / "archives"
        self.assertEqual(
            sorted(p.name for p in output.iterdir()),
            [
                "buildish-mammoth-cache-1.2.3-github-action.zip",
                "buildish-mammoth-cache-1.2.3-src.tar.gz",
            ],
        )
        with tarfile.open(
            output / "buildish-mammoth-cache-1.2.3-src.tar.gz"
        ) as archive:
            prefix = "buildish-mammoth-cache-1.2.3-src/"
            self.assertEqual(
                archive.extractfile(prefix + "source.txt").read(), b"reviewed source\n"
            )
            self.assertTrue(
                archive.getmember(prefix + "scripts/fixture.sh").mode & 0o111
            )
            self.assertFalse(
                any(
                    "/dist/" in n
                    or "/docs/releases/" in n
                    or n.endswith("untracked.txt")
                    for n in archive.getnames()
                )
            )
        with zipfile.ZipFile(
            output / "buildish-mammoth-cache-1.2.3-github-action.zip"
        ) as archive:
            prefix = "buildish-mammoth-cache-1.2.3-github-action/"
            self.assertEqual(archive.read(prefix + "source.txt"), b"reviewed source\n")
            self.assertEqual(
                len([n for n in archive.namelist() if n.endswith("index.cjs")]), 4
            )
            self.assertTrue(
                (archive.getinfo(prefix + "scripts/fixture.sh").external_attr >> 16)
                & 0o111
            )
            self.assertFalse(
                any(
                    "/docs/releases/" in n or n.endswith("untracked.txt")
                    for n in archive.namelist()
                )
            )
        self.assertEqual((self.repo / ".git/config").read_bytes(), config)
        self.assertEqual(git(self.repo, "show-ref"), refs)
        self.assertEqual(git(self.repo, "status", "--porcelain"), status)

    def test_repeat_build_has_identical_bytes_with_fixed_inputs_and_toolchain(
        self,
    ) -> None:
        self.run_package(output=self.root / "one")
        self.run_package(output=self.root / "two")
        for archive in (self.root / "one").iterdir():
            self.assertEqual(
                archive.read_bytes(), (self.root / "two" / archive.name).read_bytes()
            )
        with gzip.open(
            self.root / "one/buildish-mammoth-cache-1.2.3-src.tar.gz"
        ) as archive:
            self.assertTrue(archive.read(512))

    def test_existing_output_is_never_replaced_even_if_empty(self) -> None:
        output = self.root / "archives"
        output.mkdir()
        self.assertIn("must not already exist", self.run_package(success=False).stderr)
        marker = output / "keep.txt"
        marker.write_text("keep\n")
        self.run_package(success=False)
        self.assertEqual(marker.read_text(), "keep\n")
        self.assertEqual(len(list(output.iterdir())), 1)

    def test_rejects_source_changes_hidden_in_materialization(self) -> None:
        (self.repo / "source.txt").write_text("changed source\n")
        commit(self.repo)
        result = self.run_package(
            materialized=git(self.repo, "rev-parse", "HEAD"), success=False
        )
        self.assertIn("preserve source files/modes", result.stderr)
        self.assertFalse((self.root / "archives").exists())

    def test_rejects_legal_changes_between_source_and_materialized_tree(self) -> None:
        (self.repo / "legal/github/LICENSE").write_text("different attribution\n")
        commit(self.repo)
        result = self.run_package(
            materialized=git(self.repo, "rev-parse", "HEAD"), success=False
        )
        self.assertIn("preserve source files/modes", result.stderr)

    def test_rejects_missing_post_bundle(self) -> None:
        (self.repo / "dist/github/maven/post/index.cjs").unlink()
        commit(self.repo)
        result = self.run_package(
            materialized=git(self.repo, "rev-parse", "HEAD"), success=False
        )
        self.assertIn("Missing distribution file", result.stderr)
        self.assertFalse((self.root / "archives").exists())

    def test_rejects_missing_legal_files(self) -> None:
        repo, source, materialized = self.pair("missing-legal", missing_legal=True)
        result = self.run_package(
            repo=repo, source=source, materialized=materialized, success=False
        )
        self.assertIn("legal/github/NOTICE", result.stderr)
        self.assertFalse((self.root / "archives").exists())

    def test_rejects_invalid_executable_paths(self) -> None:
        repo, source, materialized = self.pair(
            "bad-descriptor",
            extra={
                "actions/github/gradle/action.yml": "runs: {using: node24, main: ../../../../outside.cjs, post: ../../../dist/github/gradle/post/index.cjs}\n"
            },
        )
        result = self.run_package(
            repo=repo, source=source, materialized=materialized, success=False
        )
        self.assertIn("resolve inside dist", result.stderr)

    def test_rejects_generated_source_tree_and_identical_source_materialization(
        self,
    ) -> None:
        self.assertIn(
            "preserve source",
            self.run_package(materialized=self.source, success=False).stderr,
        )
        self.assertIn(
            "must not contain",
            self.run_package(source=self.materialized, success=False).stderr,
        )

    def test_rejects_mutable_or_abbreviated_inputs_and_candidate_versions(self) -> None:
        for source in ("main", self.source[:12]):
            with self.subTest(source=source):
                self.assertIn(
                    "full lowercase commit",
                    self.run_package(source=source, success=False).stderr,
                )
        for version in ("v1.2.3", "1.2.3-rc1", "01.2.3", "../bad"):
            with self.subTest(version=version):
                self.assertIn(
                    "stable X.Y.Z",
                    self.run_package(version=version, success=False).stderr,
                )

    def test_rejects_tracked_history_symlinks_and_submodules(self) -> None:
        repo, source, materialized = self.pair(
            "tracked-history", extra={"docs/releases/0.0.1/_index.md": "old docs\n"}
        )
        self.assertIn(
            "historical",
            self.run_package(
                repo=repo, source=source, materialized=materialized, success=False
            ).stderr,
        )
        (self.repo / "linked").symlink_to("source.txt")
        commit(self.repo)
        linked = git(self.repo, "rev-parse", "HEAD")
        self.assertIn(
            "regular tracked files",
            self.run_package(source=linked, success=False).stderr,
        )
        git(self.repo, "rm", "linked")
        git(
            self.repo,
            "update-index",
            "--add",
            "--cacheinfo",
            f"160000,{self.source},module",
        )
        git(self.repo, "commit", "-m", "submodule fixture")
        self.assertIn(
            "regular tracked files",
            self.run_package(
                source=git(self.repo, "rev-parse", "HEAD"), success=False
            ).stderr,
        )

    def test_export_ignore_cannot_silently_omit_source_or_action_files(self) -> None:
        for attributes in ("source.txt export-ignore\n", "dist/** export-ignore\n"):
            with self.subTest(attributes=attributes):
                repo, source, materialized = self.pair(
                    f"attributes-{len(list(self.root.iterdir()))}",
                    extra={".gitattributes": attributes},
                )
                result = self.run_package(
                    repo=repo, source=source, materialized=materialized, success=False
                )
                self.assertIn("exact committed tree", result.stderr)
                self.assertFalse((self.root / "archives").exists())

    def test_export_substitution_cannot_rewrite_committed_source(self) -> None:
        repo, source, materialized = self.pair(
            "substitution",
            extra={
                ".gitattributes": "revision.txt export-subst\n",
                "revision.txt": "$Format:%H$\n",
            },
        )
        result = self.run_package(
            repo=repo, source=source, materialized=materialized, success=False
        )
        self.assertIn("Archive", result.stderr)
        self.assertFalse((self.root / "archives").exists())

    def test_inherited_git_routing_cannot_redirect_the_explicit_repository(
        self,
    ) -> None:
        env = {
            **os.environ,
            "GIT_DIR": str(self.root / "does-not-exist"),
            "GIT_WORK_TREE": str(self.root),
        }
        self.run_package(env=env)

    def test_replacement_refs_cannot_change_requested_bytes(self) -> None:
        replacement, source, materialized = self.pair(
            "replacement", extra={"source.txt": "replacement bytes\n"}
        )
        git(self.repo, "fetch", str(replacement), materialized)
        git(self.repo, "replace", self.source, source)
        git(self.repo, "replace", self.materialized, materialized)
        self.assertEqual(
            git(self.repo, "show", f"{self.source}:source.txt"), "replacement bytes"
        )
        self.run_package()
        output = self.root / "archives"
        with tarfile.open(
            output / "buildish-mammoth-cache-1.2.3-src.tar.gz"
        ) as archive:
            self.assertEqual(
                archive.extractfile(
                    "buildish-mammoth-cache-1.2.3-src/source.txt"
                ).read(),
                b"reviewed source\n",
            )
        with zipfile.ZipFile(
            output / "buildish-mammoth-cache-1.2.3-github-action.zip"
        ) as archive:
            self.assertEqual(
                archive.read("buildish-mammoth-cache-1.2.3-github-action/source.txt"),
                b"reviewed source\n",
            )

    def test_sha256_object_ids(self) -> None:
        repo, source, materialized = self.pair("sha256", sha256=True)
        self.assertEqual(len(source), 64)
        self.run_package(repo=repo, source=source, materialized=materialized)
