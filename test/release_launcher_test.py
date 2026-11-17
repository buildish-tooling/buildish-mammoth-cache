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

"""Exercise package selection and argument forwarding without installing Release Tooling."""

from __future__ import annotations

import importlib.metadata as metadata
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "buildish-release-tooling/run.py"
SPEC = importlib.util.spec_from_file_location("release_launcher", SCRIPT)
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class ReleaseLauncherTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory(prefix="release launcher tests with spaces ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.site = self.root / "site-packages"
        self.site.mkdir()
        self.info = self.site / "buildish_release_tooling-0.1.4.dist-info"
        self.info.mkdir()
        (self.info / "METADATA").write_text(
            "Name: buildish-release-tooling\nVersion: 0.1.4\n"
        )
        (self.info / "WHEEL").write_text("Wheel-Version: 1.0\n")
        (self.info / "RECORD").write_text(f"{launcher.CLI},,\n")
        self.cli = self.site / launcher.CLI
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text("# wheel fixture, never executed\n")
        self.distribution = metadata.PathDistribution(self.info)
        self.module = SimpleNamespace(
            __file__=str(self.cli), main=Mock(return_value=17)
        )
        self.lookup = self.enterContext(
            patch.object(
                launcher.metadata, "distribution", return_value=self.distribution
            )
        )
        self.import_cli = self.enterContext(
            patch.object(launcher.importlib, "import_module", return_value=self.module)
        )
        self.enterContext(patch.dict(os.environ, {}, clear=True))

    def run_main(self, *args: str) -> int:
        with patch.object(sys, "argv", [str(SCRIPT), *args]):
            return launcher.main()

    def test_component_pin_is_exactly_014(self) -> None:
        lines = [
            line
            for line in (SCRIPT.parent / "requirements.txt").read_text().splitlines()
            if line and not line.startswith("#")
        ]
        self.assertEqual(lines, ["buildish-release-tooling==0.1.4"])

    def test_wrong_version_fails_before_import(self) -> None:
        for version in ("0.1.3", "0.1.4.dev1", "0.1.5"):
            with self.subTest(version=version):
                (self.info / "METADATA").write_text(
                    f"Name: buildish-release-tooling\nVersion: {version}\n"
                )
                self.assertEqual(self.run_main("resolve-candidate", "1.2.3", "main"), 2)
        self.import_cli.assert_not_called()

    def test_missing_package_does_not_fall_back(self) -> None:
        self.lookup.side_effect = metadata.PackageNotFoundError(
            "buildish-release-tooling"
        )
        self.assertEqual(self.run_main("--package-info"), 2)
        self.import_cli.assert_not_called()

    def test_editable_install_fails_before_import(self) -> None:
        (self.info / "direct_url.json").write_text(
            json.dumps({"dir_info": {"editable": True}})
        )
        self.assertEqual(self.run_main("--package-info"), 2)
        self.import_cli.assert_not_called()

    def test_source_install_without_recorded_cli_is_rejected(self) -> None:
        (self.info / "RECORD").write_text("other.py,,\n")
        self.assertEqual(self.run_main("--package-info"), 2)
        self.import_cli.assert_not_called()

    def test_source_override_is_rejected_before_lookup(self) -> None:
        with patch.dict(os.environ, {"BUILDISH_RELEASE_TOOLING_DIR": "/unused/source"}):
            self.assertEqual(self.run_main("--package-info"), 2)
        self.lookup.assert_not_called()

    def test_import_from_wrong_location_cannot_run_command(self) -> None:
        self.module.__file__ = str(self.root / "source-checkout/cli.py")
        self.assertEqual(self.run_main("resolve-candidate", "1.2.3", "main"), 2)
        self.module.main.assert_not_called()

    def test_command_config_and_opaque_arguments_are_preserved(self) -> None:
        seen = []
        cwd = Path.cwd()
        self.module.main.side_effect = lambda: (
            seen.append((sys.argv[:], Path.cwd())) or 17
        )
        self.assertEqual(
            self.run_main(
                "bind-materialization", "--candidate-state", "state with spaces.json"
            ),
            17,
        )
        self.assertEqual(
            seen,
            [
                (
                    [
                        str(SCRIPT),
                        "bind-materialization",
                        "--component-config",
                        str(SCRIPT.parent / "release-config.yaml"),
                        "--candidate-state",
                        "state with spaces.json",
                    ],
                    cwd,
                )
            ],
        )

    def test_component_config_cannot_be_overridden(self) -> None:
        for args in (
            ("--component-config", "other.yaml"),
            ("--component-config=other.yaml",),
            ("--component-conf", "other.yaml"),
            ("--component=other.yaml",),
        ):
            self.assertEqual(self.run_main("resolve-candidate", *args), 2)
        self.module.main.assert_not_called()

    def test_package_info_does_not_invoke_command(self) -> None:
        self.assertEqual(self.run_main("--package-info"), 0)
        self.module.main.assert_not_called()

    def test_no_command_shows_usage_without_loading_package(self) -> None:
        self.assertEqual(self.run_main(), 2)
        self.lookup.assert_not_called()

    def test_shell_uses_selected_python_in_isolated_mode(self) -> None:
        python = self.root / "selected python"
        output = self.root / "arguments.json"
        python.write_text(
            f"#!{sys.executable}\nimport json,sys\nfrom pathlib import Path\nPath({str(output)!r}).write_text(json.dumps(sys.argv[1:]))\nsys.exit(23)\n"
        )
        python.chmod(0o755)
        result = subprocess.run(
            [
                "bash",
                str(SCRIPT.parent / "release-tooling.sh"),
                "bind-materialization",
                "--candidate-state",
                "state with spaces.json",
            ],
            env={"PATH": os.defpath, "BUILDISH_RELEASE_TOOLING_PYTHON": str(python)},
            cwd=self.root,
            check=False,
        )
        self.assertEqual(result.returncode, 23)
        self.assertEqual(
            json.loads(output.read_text()),
            [
                "-I",
                str(SCRIPT),
                "bind-materialization",
                "--candidate-state",
                "state with spaces.json",
            ],
        )


if __name__ == "__main__":
    unittest.main()
