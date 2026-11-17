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

"""Explicit installed-wheel qualification; no network, signing, or hosted mutations.

Run through make release-tooling-qualification with an approved installed interpreter.
Synthetic candidate/stage records below are local fixtures, never publication proof.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from versioned_docs_test import git

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "buildish-release-tooling/release-tooling.sh"
CONFIG = ROOT / "buildish-release-tooling/release-config.yaml"


class InstalledReleaseToolingQualificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.python = os.environ["BUILDISH_RELEASE_TOOLING_PYTHON"]
        temporary = TemporaryDirectory(prefix="installed qualification ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.producer = self.root / "producer"
        self.producer.mkdir()
        git(self.producer, "init", "-b", "main")
        for name in (
            "LICENSE",
            "NOTICE",
            "legal/github/LICENSE",
            "legal/github/NOTICE",
            "actions/github/gradle/action.yml",
            "actions/github/maven/action.yml",
        ):
            path = self.producer / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, path)
        notes = self.producer / "buildish-release-tooling/release-notes/1.2.3.md"
        notes.parent.mkdir(parents=True)
        notes.write_text(
            "# Fixture release\n\nSynthetic notes for local CLI qualification.\n"
        )
        git(self.producer, "add", "--all")
        git(self.producer, "commit", "-m", "fixture reviewed source")
        self.source = git(self.producer, "rev-parse", "HEAD")
        git(self.producer, "update-ref", "refs/remotes/origin/main", self.source)
        git(
            self.producer,
            "remote",
            "add",
            "origin",
            "https://github.com/buildish-tooling/buildish-mammoth-cache.git",
        )
        self.resolved = self.cli("resolve-candidate", "1.2.3", self.source)
        git(self.producer, "checkout", "--detach", self.source)
        for tool in ("gradle", "maven"):
            for phase in ("main", "post"):
                name = f"dist/github/{tool}/{phase}/index.cjs"
                path = self.producer / name
                path.parent.mkdir(parents=True)
                shutil.copyfile(ROOT / name, path)
        git(self.producer, "add", "--all")
        git(self.producer, "commit", "-m", "fixture real generated bundles")
        self.materialized = git(self.producer, "rev-parse", "HEAD")
        self.bundle = self.root / "materialized.bundle"
        self.bound = self.cli(
            "bind-materialization",
            "--candidate-state",
            str(self.resolved),
            "--materialized-commit",
            self.materialized,
            "--bundle-output",
            str(self.bundle),
        )
        self.consumer = self.root / "fresh shallow consumer"
        git(
            self.root,
            "clone",
            "--depth=1",
            "--no-tags",
            "--branch",
            "main",
            self.producer.as_uri(),
            str(self.consumer),
        )
        self.assertNotEqual(
            subprocess.run(
                ["git", "-C", str(self.consumer), "cat-file", "-e", self.materialized],
                capture_output=True,
            ).returncode,
            0,
        )

    def cli(
        self, command: str, *args: str, cwd: Path | None = None, success: bool = True
    ) -> Path:
        output = self.root / f"{command}-{len(list(self.root.glob('*.json')))}.json"
        result = subprocess.run(
            ["bash", str(LAUNCHER), command, *args],
            cwd=cwd or self.producer,
            env={
                **os.environ,
                "MANIFEST_PATH": str(output),
                "PYTHONPATH": "/unavailable/should-not-be-imported",
                "GITHUB_STEP_SUMMARY": str(self.root / "summary.md"),
                "GITHUB_OUTPUT": str(self.root / "outputs"),
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
            },
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return output

    def test_installed_origin_and_component_schema(self) -> None:
        result = subprocess.run(
            ["bash", str(LAUNCHER), "--package-info"],
            cwd=self.root,
            env=os.environ,
            check=True,
            capture_output=True,
            text=True,
        )
        origin = json.loads(result.stdout)
        self.assertEqual(origin["version"], "0.1.4")
        self.assertTrue(
            Path(origin["cli"]).is_relative_to(
                Path(self.python).absolute().parent.parent
            )
        )
        subprocess.run(
            [
                self.python,
                "-I",
                "-c",
                "from buildish_release_tooling.release.config import load_release_config; "
                "import sys; c=load_release_config(sys.argv[1]); "
                "assert c.tags.materialized_paths == ['dist']; assert c.lifecycle.mode == 'candidate'",
                str(CONFIG),
            ],
            cwd=self.root,
            check=True,
        )

    def test_configured_signing_fingerprint_is_enforced_without_runtime_variable(
        self,
    ) -> None:
        # Exercise the installed signer with fixture GPG responses: no real key,
        # GPG process, secret access, signature, or normal keyring is involved.
        script = textwrap.dedent(
            """\
            import os
            import sys
            from pathlib import Path
            from unittest.mock import patch
            from buildish_release_tooling.release.config import load_release_config
            from buildish_release_tooling.release.signing import openpgp

            config = load_release_config(sys.argv[1])
            signing = openpgp.OpenPgpSigningInput.from_config(config.artifacts.signing)
            expected = signing.expected_fingerprint
            assert expected
            with patch.dict(os.environ, {signing.private_key_env: "fixture-only-not-a-key"}, clear=True):
                assert "BUILDISH_RELEASE_GPG_SIGNING_FINGERPRINT" not in os.environ
                with patch.object(openpgp, "run_logged_command") as gpg:
                    with patch.object(openpgp, "_secret_key_fingerprints", return_value=("0" * 40, [])):
                        try:
                            openpgp.OpenPgpSigner.from_environment(Path("fixture-keyring"), signing)
                        except openpgp.OpenPgpSigningError as error:
                            assert "does not match expected_fingerprint" in str(error)
                        else:
                            raise AssertionError("Configured fingerprint mismatch was accepted")
                    with patch.object(openpgp, "_secret_key_fingerprints", return_value=(expected, [])):
                        signer = openpgp.OpenPgpSigner.from_environment(Path("fixture-keyring"), signing)
                        assert signer.fingerprint == expected
                    assert gpg.call_count == 2
            """
        )
        subprocess.run(
            [self.python, "-I", "-c", script, str(CONFIG)], cwd=self.root, check=True
        )

    def test_bind_and_import_retain_source_and_head_in_fresh_shallow_checkout(
        self,
    ) -> None:
        imported = self.cli(
            "import-materialization",
            "--candidate-state",
            str(self.bound),
            "--source-state",
            str(self.resolved),
            "--bundle",
            str(self.bundle),
            "--bundle-sha256",
            hashlib.sha256(self.bundle.read_bytes()).hexdigest(),
            cwd=self.consumer,
        )
        payload = json.loads(imported.read_text())
        self.assertEqual(payload["source"]["commit_sha"], self.source)
        self.assertEqual(
            payload["candidate"]["tag"]["target_commit"], self.materialized
        )
        self.assertEqual(git(self.consumer, "rev-parse", "HEAD"), self.source)
        self.assertFalse((self.consumer / "dist").exists())
        self.assertEqual(
            git(self.consumer, "rev-parse", f"{self.materialized}^"), self.source
        )

    def test_changed_bundle_and_rewritten_original_state_are_rejected(self) -> None:
        expected = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        original = self.bundle.read_bytes()
        self.bundle.write_bytes(original + b"tampered")
        self.cli(
            "import-materialization",
            "--candidate-state",
            str(self.bound),
            "--source-state",
            str(self.resolved),
            "--bundle",
            str(self.bundle),
            "--bundle-sha256",
            expected,
            cwd=self.consumer,
            success=False,
        )
        self.bundle.write_bytes(original)
        source = json.loads(self.resolved.read_text())
        source["source"]["source_ref"] = "rewritten-producer-identity"
        self.resolved.write_text(json.dumps(source))
        self.cli(
            "import-materialization",
            "--candidate-state",
            str(self.bound),
            "--source-state",
            str(self.resolved),
            "--bundle",
            str(self.bundle),
            "--bundle-sha256",
            expected,
            cwd=self.consumer,
            success=False,
        )
        self.assertEqual(git(self.consumer, "rev-parse", "HEAD"), self.source)
        self.assertFalse((self.consumer / "dist").exists())

    def test_materialization_outside_dist_or_with_non_source_parent_is_rejected(
        self,
    ) -> None:
        (self.producer / "NOTICE").write_text("changed outside allowed paths\n")
        git(self.producer, "add", "NOTICE")
        git(self.producer, "commit", "--amend", "--no-edit")
        wrong_paths = git(self.producer, "rev-parse", "HEAD")
        self.cli(
            "bind-materialization",
            "--candidate-state",
            str(self.resolved),
            "--materialized-commit",
            wrong_paths,
            "--bundle-output",
            str(self.root / "wrong.bundle"),
            success=False,
        )
        (self.producer / "extra").write_text("not a sole child of S\n")
        git(self.producer, "add", "extra")
        git(self.producer, "commit", "-m", "fixture second child")
        wrong_parent = git(self.producer, "rev-parse", "HEAD")
        self.cli(
            "bind-materialization",
            "--candidate-state",
            str(self.resolved),
            "--materialized-commit",
            wrong_parent,
            "--bundle-output",
            str(self.root / "parent.bundle"),
            success=False,
        )

    def test_promotion_and_final_manifest_preserve_exact_M_and_inline_evidence(
        self,
    ) -> None:
        bound = json.loads(self.bound.read_text())
        manifest = self.root / "candidate-manifest.json"
        candidate = {
            key: bound[key]
            for key in (
                "release",
                "candidate",
                "materialization",
                "source",
                "release_notes",
                "source_date_epoch",
            )
        }
        candidate.update(
            candidate_tag=bound["candidate"]["tag"],
            artifacts=[],
            tooling={"version": "0.1.4"},
            created_at="2026-11-17T00:00:00Z",
            publications=[
                {
                    "target_kind": "github-release-candidate",
                    "uri": "https://github.com/buildish-tooling/buildish-mammoth-cache/releases/tag/v1.2.3-rc1",
                }
            ],
        )
        manifest.write_text(json.dumps(candidate))
        promoted = self.cli(
            "resolve-promotion",
            "--candidate-tag",
            "v1.2.3-rc1",
            "--candidate-manifest",
            str(manifest),
            "--candidate-manifest-digest",
            hashlib.sha256(manifest.read_bytes()).hexdigest(),
            "1.2.3",
        )
        imported = self.cli(
            "import-materialization",
            "--promotion-state",
            str(promoted),
            "--bundle",
            str(self.bundle),
            "--bundle-sha256",
            hashlib.sha256(self.bundle.read_bytes()).hexdigest(),
            cwd=self.consumer,
        )
        promotion = json.loads(imported.read_text())
        self.assertEqual(promotion["final_tag"]["target_commit"], self.materialized)
        self.assertEqual(promotion["materialization"], bound["materialization"])
        self.assertEqual(git(self.consumer, "rev-parse", "HEAD"), self.source)
        self.assertFalse((self.consumer / "dist").exists())
        # Fixture proof: validate component-owned verification records with the real
        # final-manifest CLI, using a synthetic local stage result (no hosted API).
        promotion["verification_results"] = [
            {
                "kind": "mammoth-cache-maintainer-approval",
                "uri": "https://example.org/fixture-approval",
                "claims": {"record": "fixture-only"},
            }
        ]
        imported.write_text(json.dumps(promotion))
        stage = self.root / "stage.json"
        stage.write_text(
            json.dumps(
                {
                    "action": "stage-github-final-release",
                    "component": "buildish-mammoth-cache",
                    "version": "1.2.3",
                    "source_commit": self.source,
                    "outcome": "created",
                    "publication": {
                        "repository": "buildish-tooling/buildish-mammoth-cache",
                        "release_id": 1,
                        "release_url": "https://github.com/buildish-tooling/buildish-mammoth-cache/releases/tag/v1.2.3",
                        "created_at": "2026-11-17T00:00:00Z",
                        "tag": "v1.2.3",
                        "draft": True,
                        "prerelease": False,
                    },
                }
            )
        )
        final = self.cli(
            "create-release-manifest",
            "--release-state",
            str(imported),
            "--publication-result",
            str(stage),
            cwd=self.consumer,
        )
        payload = json.loads(final.read_text())
        self.assertEqual(payload["materialization"], bound["materialization"])
        self.assertEqual(
            payload["verification_results"], promotion["verification_results"]
        )
        self.assertEqual(
            payload["promoted_candidate"]["manifest"]["digest"],
            hashlib.sha256(manifest.read_bytes()).hexdigest(),
        )


if __name__ == "__main__":
    unittest.main()
