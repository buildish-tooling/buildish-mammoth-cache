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

"""Invoke the exact installed release package with this component's configuration."""

from __future__ import annotations

import importlib
import importlib.metadata as metadata
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGE = "buildish-release-tooling"
CLI = "buildish_release_tooling/release/cli.py"


def installed_cli():
    if os.environ.get("BUILDISH_RELEASE_TOOLING_DIR"):
        raise ValueError(
            "BUILDISH_RELEASE_TOOLING_DIR is no longer supported; select an installed wheel with BUILDISH_RELEASE_TOOLING_PYTHON"
        )
    requirements = [
        line.strip()
        for line in (ROOT / "requirements.txt").read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if len(requirements) != 1 or not requirements[0].startswith(f"{PACKAGE}=="):
        raise ValueError("requirements.txt must contain one exact release-tooling pin")
    expected_version = requirements[0].split("==", 1)[1]
    distribution = metadata.distribution(PACKAGE)
    if distribution.version != expected_version:
        raise ValueError(
            f"Expected {PACKAGE}=={expected_version}; found {distribution.version}"
        )
    direct_url = json.loads(distribution.read_text("direct_url.json") or "{}")
    if direct_url.get("dir_info", {}).get("editable"):
        raise ValueError(
            "Editable Release Tooling installs are not accepted; install the qualified wheel"
        )
    if not distribution.read_text("WHEEL") or CLI not in {
        str(item) for item in distribution.files or ()
    }:
        raise ValueError("Release Tooling must be a recorded wheel installation")
    location = Path(distribution.locate_file("")).resolve()
    expected_cli = Path(distribution.locate_file(CLI)).resolve()
    if not expected_cli.is_relative_to(location):
        raise ValueError("Release Tooling CLI resolves outside its installation")
    module = importlib.import_module("buildish_release_tooling.release.cli")
    if Path(module.__file__).resolve() != expected_cli:
        raise ValueError(
            "Imported Release Tooling CLI does not match installed distribution"
        )
    return distribution.version, module


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write(
            "usage: release-tooling.sh <command> [args...] | --package-info\n"
        )
        return 2
    try:
        version, module = installed_cli()
        if sys.argv[1:] == ["--package-info"]:
            print(
                json.dumps(
                    {"version": version, "cli": str(Path(module.__file__).resolve())}
                )
            )
            return 0
        # argparse also accepts unambiguous long-option abbreviations.
        if any(
            len(option := arg.split("=", 1)[0]) > 2
            and option.startswith("--")
            and "--component-config".startswith(option)
            for arg in sys.argv[2:]
        ):
            raise ValueError("The component configuration is fixed by this launcher")
    except (metadata.PackageNotFoundError, ImportError, ValueError, OSError) as error:
        sys.stderr.write(
            f"release-tooling: {error}\nUse an approved installed environment with {ROOT / 'requirements.txt'}; no source fallback or automatic installation is performed.\n"
        )
        return 2
    sys.argv[2:2] = ["--component-config", str(ROOT / "release-config.yaml")]
    return module.main()


if __name__ == "__main__":
    sys.exit(main())
