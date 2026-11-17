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

"""Check archive consumer isolation, real packaging, and failure cleanup without network."""

from __future__ import annotations

import importlib.util
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from versioned_docs_test import git

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "archive_consumer", ROOT / "scripts/archive-consumer-check.py"
)
consumer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consumer)


class ArchiveConsumerTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory(prefix="consumer tests with spaces ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        git(self.root, "init", "-b", "main")
        files = {
            ".gitignore": "dist/\nbuild/\nnode_modules/\ndocs/releases/\n",
            "source.txt": "committed source\n",
            "LICENSE": "source legal\n",
            "NOTICE": "source notice\n",
            "legal/github/LICENSE": "bundled legal\n",
            "legal/github/NOTICE": "bundled notice\n",
            "fixture.sh": "#!/bin/sh\nexit 0\n",
        }
        for tool in ("gradle", "maven"):
            files[f"actions/github/{tool}/action.yml"] = (
                f"runs:\n  using: node24\n  main: ../../../dist/github/{tool}/main/index.cjs\n"
                f"  post: ../../../dist/github/{tool}/post/index.cjs\n"
            )
        for name, content in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        git(self.root, "add", "--all")
        git(self.root, "update-index", "--chmod=+x", "fixture.sh")
        git(self.root, "commit", "-m", "fixture")
        (self.root / "source.txt").write_text("current tracked bytes\n")
        for name in consumer.BUNDLES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"// real packaged fixture bytes: {name}\n")
        for name in (
            "untracked-private.txt",
            "node_modules/private.txt",
            "docs/releases/private.txt",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("must not ship\n")

    def state(self) -> tuple[str, str, bytes, bytes]:
        return (
            git(self.root, "show-ref"),
            git(self.root, "status", "--porcelain=v1", "--untracked-files=all"),
            (self.root / ".git/index").read_bytes(),
            (self.root / ".git/config").read_bytes(),
        )

    def assert_cleaned(self, before: tuple) -> None:
        self.assertEqual(before, self.state())
        self.assertEqual(list((self.root / "build").iterdir()), [])

    def run_consumer(self, fail_smoke: bool = False) -> list[Path]:
        run = subprocess.run
        seen = []

        def intercept(command, **kwargs):
            if len(command) > 1 and command[1] == str(ROOT / "scripts/smoke-test.mjs"):
                self.assertEqual(command[0], "fixture-node24")
                self.assertEqual(command[2], "--distribution-root")
                tree = Path(command[3])
                self.assertTrue(tree.is_relative_to(self.root / "build"))
                self.assertEqual(tree.name, consumer.ACTION_ROOT)
                self.assertEqual(
                    (tree / "source.txt").read_text(), "current tracked bytes\n"
                )
                self.assertTrue((tree / "fixture.sh").stat().st_mode & 0o111)
                self.assertFalse((tree / "untracked-private.txt").exists())
                self.assertFalse((tree / "node_modules").exists())
                self.assertFalse((tree / "docs/releases").exists())
                for name in consumer.BUNDLES:
                    self.assertEqual(
                        (tree / name).read_bytes(), (self.root / name).read_bytes()
                    )
                seen.append(tree)
                if fail_smoke:
                    raise subprocess.CalledProcessError(17, command)
                return subprocess.CompletedProcess(command, 0)
            return run(command, **kwargs)

        with patch.object(consumer.subprocess, "run", side_effect=intercept):
            consumer.check(self.root, "fixture-node24")
        return seen

    def test_real_package_unpack_and_checkout_preservation(self) -> None:
        before = self.state()
        seen = self.run_consumer()
        self.assertEqual(len(seen), 1)
        self.assertFalse(seen[0].exists())
        self.assert_cleaned(before)

    def test_failed_smoke_propagates_and_cleans(self) -> None:
        before = self.state()
        with self.assertRaises(subprocess.CalledProcessError) as error:
            self.run_consumer(fail_smoke=True)
        self.assertEqual(error.exception.returncode, 17)
        self.assert_cleaned(before)

    def test_missing_post_bundle_fails_before_smoke_and_cleans(self) -> None:
        (self.root / consumer.BUNDLES[-1]).unlink()
        before = self.state()
        with self.assertRaisesRegex(ValueError, "existing regular file"):
            self.run_consumer()
        self.assert_cleaned(before)

    def test_packaging_failure_propagates_and_cleans(self) -> None:
        (self.root / "legal/github/NOTICE").write_text("")
        before = self.state()
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_consumer()
        self.assert_cleaned(before)

    def test_symlinked_bundle_is_rejected(self) -> None:
        bundle = self.root / consumer.BUNDLES[0]
        bundle.unlink()
        bundle.symlink_to(self.root / "source.txt")
        before = self.state()
        with self.assertRaisesRegex(ValueError, "existing regular file"):
            self.run_consumer()
        self.assert_cleaned(before)


if __name__ == "__main__":
    unittest.main()
