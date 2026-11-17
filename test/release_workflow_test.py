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

"""Prove release transport and approval boundaries without credentials or network."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "release_workflow", ROOT / "buildish-release-tooling/workflow.py"
)
workflow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workflow)


class ReleaseWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory(prefix="release workflow with spaces ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(patch.dict(os.environ, {}, clear=True))

    def bundle(self) -> Path:
        directory = self.root / "bundle"
        (directory / "assets").mkdir(parents=True)
        (directory / "state.json").write_text('{"source":"opaque"}\n')
        (directory / "assets/archive.zip").write_bytes(b"committed payload")
        workflow.seal(directory)
        return directory

    def test_transport_binds_all_bytes_and_exact_file_set(self) -> None:
        directory = self.bundle()
        expected = workflow.digest(directory / "transport.json")
        workflow.verify(directory, expected)
        (directory / "assets/archive.zip").write_bytes(b"substituted bytes")
        with self.assertRaisesRegex(ValueError, "differs from producer"):
            workflow.verify(directory, expected)

    def test_producer_index_digest_cannot_come_from_substituted_download(self) -> None:
        directory = self.bundle()
        expected = workflow.digest(directory / "transport.json")
        (directory / "transport.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "producer digest"):
            workflow.verify(directory, expected)

    def test_missing_extra_and_symlink_inputs_are_rejected(self) -> None:
        directory = self.bundle()
        expected = workflow.digest(directory / "transport.json")
        extra = directory / "extra"
        extra.write_text("not approved")
        with self.assertRaisesRegex(ValueError, "missing or extra"):
            workflow.verify(directory, expected)
        extra.unlink()
        payload = directory / "assets/archive.zip"
        payload.unlink()
        with self.assertRaisesRegex(ValueError, "missing or extra"):
            workflow.verify(directory, expected)
        payload.symlink_to(directory / "state.json")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            workflow.verify(directory, expected)

    def approved(self) -> dict:
        os.environ.update(
            RELEASE_VERSION="1.2.3",
            CANDIDATE_TAG="v1.2.3-rc2",
            CANDIDATE_MANIFEST_DIGEST="a" * 64,
            GITHUB_ACTOR="Alice",
            GITHUB_TRIGGERING_ACTOR="bob",
            GITHUB_REPOSITORY=workflow.REPOSITORY,
            GITHUB_REF="refs/heads/main",
        )
        return workflow.approval_record()

    def test_approval_records_dispatch_actor_without_a_separate_allowlist(self) -> None:
        record = self.approved()
        self.assertEqual(record["approver"], "alice")
        self.assertEqual(record["candidate_manifest_digest"], "a" * 64)
        self.assertNotIn("RELEASE_APPROVERS", os.environ)
        self.assertNotIn("APPROVAL_REFERENCE", os.environ)
        self.assertNotIn("reference", record)
        workflow.preflight("promotion")
        # A GitHub-authorized rerun retains the original dispatch decision.
        os.environ["GITHUB_TRIGGERING_ACTOR"] = "another-maintainer"
        self.assertEqual(workflow.approval_record(), record)
        workflow.preflight("promotion")
        os.environ["GITHUB_ACTOR"] = "Bob"
        self.assertEqual(workflow.approval_record()["approver"], "bob")

    def test_missing_dispatch_actor_cannot_create_an_approval_record(self) -> None:
        self.approved()
        for actor in ("", "  "):
            os.environ["GITHUB_ACTOR"] = actor
            with self.assertRaisesRegex(ValueError, "dispatch actor is required"):
                workflow.approval_record()

    def test_version_candidate_digest_and_dispatch_context_validation(self) -> None:
        original = self.approved()
        env = dict(os.environ)
        for key, value in (
            ("RELEASE_VERSION", "1.2.03"),
            ("CANDIDATE_TAG", "v1.2.3-rc0"),
            ("CANDIDATE_TAG", "v1.2.4-rc1"),
            ("CANDIDATE_MANIFEST_DIGEST", "not-a-digest"),
            ("GITHUB_REF", "refs/heads/topic"),
            ("GITHUB_REPOSITORY", "fork/project"),
        ):
            with (
                self.subTest(key=key, value=value),
                patch.dict(os.environ, {**env, key: value}, clear=True),
            ):
                with self.assertRaises(ValueError):
                    workflow.preflight("promotion")
        self.assertEqual(workflow.approval_record(), original)

    def test_candidate_accepts_omitted_source_or_a_full_explicit_commit(self) -> None:
        self.approved()
        os.environ.pop("SOURCE_COMMIT", None)
        workflow.preflight("candidate")
        os.environ["SOURCE_COMMIT"] = ""
        workflow.preflight("candidate")
        os.environ["SOURCE_COMMIT"] = "main"
        with self.assertRaisesRegex(ValueError, "full source commit"):
            workflow.preflight("candidate")
        os.environ["SOURCE_COMMIT"] = "b" * 40
        workflow.preflight("candidate")

    def test_exact_nonempty_asset_inventory(self) -> None:
        assets = self.root / "assets"
        assets.mkdir()
        for name in workflow.asset_names("1.2.3"):
            (assets / name).write_text("retained bytes")
        workflow.check_assets(assets, "1.2.3", True)
        (assets / "unapproved.zip").write_text("extra")
        with self.assertRaises(ValueError):
            workflow.check_assets(assets, "1.2.3", True)
        (assets / "unapproved.zip").unlink()
        (assets / "transport.json").write_text("not a release asset")
        with self.assertRaises(ValueError):
            workflow.check_assets(assets, "1.2.3", True)
        (assets / "transport.json").unlink()
        (assets / "materialized.bundle").write_bytes(b"")
        with self.assertRaises(ValueError):
            workflow.check_assets(assets, "1.2.3", True)

    def test_untrusted_zip_paths_and_symlinks_cannot_escape(self) -> None:
        for index, name in enumerate(
            (
                "../escape",
                "/absolute",
                "other-root/file",
                "buildish-mammoth-cache-1.2.3-github-action/../escape",
            )
        ):
            archive = self.root / f"bad-{index}.zip"
            with zipfile.ZipFile(archive, "w") as contents:
                contents.writestr(name, "untrusted")
            with self.assertRaises(ValueError):
                workflow.unpack(archive, self.root / f"unpack-{index}", "1.2.3")
        archive = self.root / "link.zip"
        with zipfile.ZipFile(archive, "w") as contents:
            entry = zipfile.ZipInfo("buildish-mammoth-cache-1.2.3-github-action/link")
            entry.external_attr = 0o120777 << 16
            contents.writestr(entry, "/outside")
        with self.assertRaisesRegex(ValueError, "non-regular"):
            workflow.unpack(archive, self.root / "link", "1.2.3")

    def test_approval_consumer_evidence_preserves_all_opaque_state(self) -> None:
        approval = self.approved()
        state = {
            "release": {"version": "1.2.3"},
            "candidate": {"tag": {"name": "v1.2.3-rc2"}},
            "candidate_manifest_digest": "a" * 64,
            "source": {"commit_sha": "b" * 40},
            "materialization": {"commit_sha": "c" * 40, "tree_sha": "d" * 40},
            "final_tag": {"name": "v1.2.3"},
            "opaque_future_field": {"bytes": [1, 2, 3]},
            "verification_results": [
                {"kind": "prior", "uri": "https://example.org/prior"}
            ],
        }
        consumer = {
            "version": "1.2.3",
            "tag": "v1.2.3",
            "source": "b" * 40,
            "materialized": "c" * 40,
            "tree": "d" * 40,
            "node_major": "24",
            "scenarios": "gradle,maven:main,post",
        }
        for name, value in (
            ("state", state),
            ("approval", approval),
            ("consumer", consumer),
        ):
            workflow.write(self.root / f"{name}.json", value)
        workflow.evidence(
            self.root / "state.json",
            self.root / "approval.json",
            self.root / "consumer.json",
            self.root / "out.json",
        )
        result = workflow.read(self.root / "out.json")
        self.assertEqual(
            result["verification_results"][-2]["uri"],
            f"https://github.com/{workflow.REPOSITORY}/releases/tag/v1.2.3-rc2",
        )
        prior = copy.deepcopy(result)
        prior["verification_results"] = prior["verification_results"][:-2]
        self.assertEqual(prior, state)
        self.assertEqual(
            json.loads(result["verification_results"][-1]["claims"]["record"]), consumer
        )
        consumer["materialized"] = "e" * 40
        (self.root / "consumer.json").write_text(json.dumps(consumer))
        with self.assertRaisesRegex(ValueError, "exact promotion identity"):
            workflow.evidence(
                self.root / "state.json",
                self.root / "approval.json",
                self.root / "consumer.json",
                self.root / "rejected.json",
            )
        self.assertFalse((self.root / "rejected.json").exists())

    def test_download_rejects_wrong_manifest_or_inventory_before_gh(self) -> None:
        manifest = self.root / "candidate.json"
        workflow.write(
            manifest, {"candidate": {"tag": {"name": "v1.2.3-rc1"}}, "artifacts": []}
        )
        with patch.object(workflow.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                workflow.download_assets(
                    manifest, "0" * 64, self.root / "download", "1.2.3"
                )
            with self.assertRaisesRegex(ValueError, "inventory differs"):
                workflow.download_assets(
                    manifest, workflow.digest(manifest), self.root / "download", "1.2.3"
                )
            run.assert_not_called()

    def test_consumer_record_requires_exact_ref_tree_and_node24(self) -> None:
        state = self.root / "state.json"
        workflow.write(
            state,
            {
                "source": {"commit_sha": "a" * 40},
                "release": {"version": "1.2.3"},
                "materialization": {"commit_sha": "b" * 40, "tree_sha": "c" * 40},
                "final_tag": {"name": "v1.2.3"},
            },
        )

        def completed(value: str) -> subprocess.CompletedProcess:
            return subprocess.CompletedProcess([], 0, stdout=value + "\n")

        with patch.object(
            workflow.subprocess,
            "run",
            side_effect=[
                completed("b" * 40),
                completed("c" * 40),
                completed("v24.22.1"),
            ],
        ):
            self.assertEqual(
                workflow.consumer_record(state, "v1.2.3")["materialized"], "b" * 40
            )
        with self.assertRaises(ValueError):
            workflow.consumer_record(state, "v1.2.4")
        with patch.object(workflow.subprocess, "run", return_value=completed("d" * 40)):
            with self.assertRaisesRegex(ValueError, "approved M"):
                workflow.consumer_record(state, "v1.2.3")
        with patch.object(
            workflow.subprocess,
            "run",
            side_effect=[completed("b" * 40), completed("d" * 40)],
        ):
            with self.assertRaisesRegex(ValueError, "release tree"):
                workflow.consumer_record(state, "v1.2.3")
        with patch.object(
            workflow.subprocess,
            "run",
            side_effect=[
                completed("b" * 40),
                completed("c" * 40),
                completed("v26.13.0"),
            ],
        ):
            with self.assertRaisesRegex(ValueError, "Node 24"):
                workflow.consumer_record(state, "v1.2.3")

    def test_workflow_outputs_reject_line_injection(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsafe workflow scalar"):
            workflow.output("source_commit", "abc\nother=value")


if __name__ == "__main__":
    unittest.main()
