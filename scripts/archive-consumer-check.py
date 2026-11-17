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

"""Package real built bundles in disposable commits and smoke-test their Action ZIP."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACTION_ROOT = "buildish-mammoth-cache-0.0.0-github-action"
BUNDLES = tuple(
    f"dist/github/{tool}/{phase}/index.cjs"
    for tool in ("gradle", "maven")
    for phase in ("main", "post")
)


def git(repo: Path, *args: str) -> bytes:
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    env.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_NO_REPLACE_OBJECTS="1",
    )
    return subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Archive consumer fixture",
            "-c",
            "user.email=archive-consumer@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            f"core.hooksPath={os.devnull}",
            *args,
        ],
        check=True,
        capture_output=True,
        env=env,
    ).stdout


def copy_regular(root: Path, name: str, destination: Path, executable: bool) -> None:
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts:
        raise ValueError(f"Unsupported fixture path: {name!r}")
    source = root / relative
    if (
        any(
            (root / Path(*relative.parts[:index])).is_symlink()
            for index in range(1, len(relative.parts) + 1)
        )
        or not source.is_file()
    ):
        raise ValueError(f"Fixture input must be an existing regular file: {name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o755 if executable else 0o644)


def snapshot(root: Path, repo: Path) -> str:
    # Use current bytes for tracked paths so local edits are exercised as well as CI.
    for record in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        metadata, raw_name = record.split(b"\t", 1)
        mode, _, stage = metadata.decode().split()
        name = raw_name.decode("utf-8")
        if mode not in {"100644", "100755"} or stage != "0":
            raise ValueError(f"Unsupported tracked fixture input: {name}")
        if name == "dist" or name.startswith("dist/"):
            raise ValueError("Source checkout must not track dist/")
        if name == "docs/releases" or name.startswith("docs/releases/"):
            raise ValueError("Source checkout must not track historical docs/releases/")
        copy_regular(root, name, repo / name, mode == "100755")
    git(repo, "add", "--force", "--all")
    git(repo, "commit", "-m", "fixture-only source snapshot")
    return git(repo, "rev-parse", "HEAD").decode().strip()


def check(root: Path, node: str) -> None:
    root = root.resolve()
    build = root / "build"
    build.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="archive-consumer-", dir=build
    ) as temporary:
        workspace = Path(temporary)
        repo = workspace / "source"
        repo.mkdir()
        git(repo, "init", "--initial-branch=fixture")
        source = snapshot(root, repo)
        for name in BUNDLES:
            copy_regular(root, name, repo / name, False)
        git(repo, "add", "--force", "dist")
        git(repo, "commit", "-m", "fixture-only generated Action payload")
        materialized = git(repo, "rev-parse", "HEAD").decode().strip()
        archives = workspace / "archives"
        env = {
            key: value
            for key, value in os.environ.items()
            if key not in {"NODE_OPTIONS", "NODE_PATH"}
        }
        subprocess.run(
            [
                sys.executable,
                "-B",
                str(ROOT / "scripts/package-release.py"),
                "--repository",
                str(repo),
                "--source-commit",
                source,
                "--materialized-commit",
                materialized,
                "--version",
                "0.0.0",
                "--output-dir",
                str(archives),
            ],
            check=True,
            env=env,
        )
        unpacked = workspace / "unpacked"
        # This is our own freshly produced archive, already verified by the packager.
        with zipfile.ZipFile(archives / f"{ACTION_ROOT}.zip") as archive:
            archive.extractall(unpacked)
            for member in archive.infolist():
                if not member.is_dir():
                    (unpacked / member.filename).chmod(
                        0o755 if (member.external_attr >> 16) & stat.S_IXUSR else 0o644
                    )
        subprocess.run(
            [
                node,
                str(ROOT / "scripts/smoke-test.mjs"),
                "--distribution-root",
                str(unpacked / ACTION_ROOT),
            ],
            check=True,
            env=env,
        )
        print(
            "Archive consumer verified: unpacked Action ZIP passed Gradle/Maven main+post.",
            flush=True,
        )
    print(
        "Removed disposable S/M repository, archives, and unpacked distribution.",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--node", default="node", help="Node executable for the consumer smoke test"
    )
    args = parser.parse_args()
    try:
        check(ROOT, args.node)
    except (
        ValueError,
        OSError,
        subprocess.CalledProcessError,
        zipfile.BadZipFile,
    ) as error:
        detail = (
            error.stderr.decode(errors="replace").strip()
            if isinstance(error, subprocess.CalledProcessError) and error.stderr
            else str(error)
        )
        sys.stderr.write(f"archive-consumer-check: {detail}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
