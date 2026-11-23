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

"""Package exact source/materialized commits as unsigned candidate input archives."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
FULL_COMMIT = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
DORMANT_GRAPH = "test/qualification/distributed-correctness"
ARCHIVE_PATHS = (".", f":(exclude,literal){DORMANT_GRAPH}")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


@dataclass(frozen=True)
class Entry:
    mode: str
    blob: str
    size: int


def git(repo: Path, *args: str) -> bytes:
    # Respect the explicit repository, not inherited Git routing/command overrides.
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    env.update(TZ="UTC", GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1")
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "tar.umask=0022", *args],
        check=True,
        capture_output=True,
        env=env,
    ).stdout


def safe_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        not name
        or path.is_absolute()
        or path.as_posix() != name
        or any(part in {"..", ".git"} for part in path.parts)
        or "\\" in name
        or ":" in name
    ):
        raise ValueError(f"Unsupported archive path: {name!r}")
    return path


def tree(repo: Path, commit: str) -> dict[str, Entry]:
    if not FULL_COMMIT.fullmatch(commit):
        raise ValueError(
            "Commit inputs must be full lowercase commit IDs, not refs or abbreviations"
        )
    resolved = (
        git(repo, "rev-parse", "--verify", f"{commit}^{{commit}}").decode().strip()
    )
    if resolved != commit:
        raise ValueError(f"Input is not the exact commit object: {commit}")
    entries = {}
    for raw in git(repo, "ls-tree", "-rlz", "--full-tree", commit).split(b"\0"):
        if not raw:
            continue
        metadata, raw_name = raw.split(b"\t", 1)
        mode, kind, blob, size = metadata.decode().split()
        name = raw_name.decode("utf-8")
        safe_path(name)
        if mode not in {"100644", "100755"} or kind != "blob":
            raise ValueError(f"Only regular tracked files are supported: {name}")
        if name == "docs/releases" or name.startswith("docs/releases/"):
            raise ValueError("Tracked historical docs/releases content must not ship")
        entries[name] = Entry(mode, blob, int(size))
    return entries


def archive_entries(entries: dict[str, Entry]) -> dict[str, Entry]:
    return {
        name: entry
        for name, entry in entries.items()
        if name != DORMANT_GRAPH and not name.startswith(f"{DORMANT_GRAPH}/")
    }


def check_member(name: str, prefix: str, is_directory: bool) -> str | None:
    if is_directory and name.rstrip("/") == prefix.rstrip("/"):
        return None
    if not name.startswith(prefix):
        raise ValueError(f"Archive member outside expected root: {name!r}")
    relative = name[len(prefix) :].rstrip("/") if is_directory else name[len(prefix) :]
    safe_path(relative)
    return None if is_directory else relative


def verify_file(
    stream, entry: Entry, size: int, executable: bool, output: Path | None
) -> None:
    if size != entry.size or executable != (entry.mode == "100755"):
        raise ValueError(
            "Archive size or executable mode differs from its committed tree"
        )
    algorithm = "sha1" if len(entry.blob) == 40 else "sha256"
    digest = hashlib.new(algorithm, usedforsecurity=False)
    digest.update(f"blob {size}\0".encode())
    destination = None
    try:
        if output is not None:
            output.parent.mkdir(parents=True, exist_ok=True)
            destination = output.open("xb")
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            if destination is not None:
                destination.write(chunk)
    finally:
        if destination is not None:
            destination.close()
    if digest.hexdigest() != entry.blob:
        raise ValueError(
            "Archive bytes differ from the committed Git blob (export-subst?)"
        )
    if output is not None:
        output.chmod(0o755 if executable else 0o644)


def verify_tar(archive: Path, entries: dict[str, Entry], prefix: str) -> None:
    seen = set()
    with tarfile.open(archive, "r:") as tar:
        for member in tar:
            name = check_member(member.name, prefix, member.isdir())
            if name is None:
                continue
            if not member.isfile() or name not in entries or name in seen:
                raise ValueError(
                    f"Unexpected/duplicate source archive member: {member.name}"
                )
            seen.add(name)
            with tar.extractfile(member) as stream:
                verify_file(
                    stream, entries[name], member.size, bool(member.mode & 0o111), None
                )
    if seen != entries.keys():
        raise ValueError(
            "Source archive does not contain the exact committed tree (export-ignore?)"
        )


def verify_zip(
    archive: Path, entries: dict[str, Entry], prefix: str, staging: Path
) -> None:
    seen = set()
    with zipfile.ZipFile(archive) as zipped:
        for member in zipped.infolist():
            name = check_member(member.filename, prefix, member.is_dir())
            if name is None:
                continue
            if name not in entries or name in seen:
                raise ValueError(
                    f"Unexpected/duplicate Action archive member: {member.filename}"
                )
            seen.add(name)
            with zipped.open(member) as stream:
                verify_file(
                    stream,
                    entries[name],
                    member.file_size,
                    bool((member.external_attr >> 16) & 0o111),
                    staging.joinpath(*PurePosixPath(name).parts),
                )
    if seen != entries.keys():
        raise ValueError(
            "Action archive does not contain the exact committed tree (export-ignore?)"
        )


def package(args: argparse.Namespace) -> None:
    if not VERSION.fullmatch(args.version):
        raise ValueError(
            "Version must be stable X.Y.Z without a v prefix or candidate suffix"
        )
    repo = args.repository.resolve()
    source = tree(repo, args.source_commit)
    materialized = tree(repo, args.materialized_commit)
    if any(name == "dist" or name.startswith("dist/") for name in source):
        raise ValueError("Source commit must not contain the generated dist payload")
    if args.source_commit == args.materialized_commit or source != {
        name: entry
        for name, entry in materialized.items()
        if not name.startswith("dist/")
    }:
        raise ValueError(
            "Materialized commit must preserve source files/modes outside dist/"
        )
    output = args.output_dir.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError(f"Output directory must not already exist: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    source_root = f"buildish-mammoth-cache-{args.version}-src"
    action_root = f"buildish-mammoth-cache-{args.version}-github-action"
    with tempfile.TemporaryDirectory(
        prefix=".mammoth-package-", dir=output.parent
    ) as temporary:
        staging = Path(temporary)
        raw_tar = staging / "source.tar"
        source_archive = staging / f"{source_root}.tar.gz"
        action_archive = staging / f"{action_root}.zip"
        git(
            repo,
            "archive",
            "--format=tar",
            f"--prefix={source_root}/",
            f"--output={raw_tar}",
            args.source_commit,
            "--",
            *ARCHIVE_PATHS,
        )
        verify_tar(raw_tar, archive_entries(source), f"{source_root}/")
        with raw_tar.open("rb") as data, source_archive.open("xb") as compressed:
            with gzip.GzipFile(
                filename="", mode="wb", fileobj=compressed, mtime=0
            ) as gzip_file:
                shutil.copyfileobj(data, gzip_file)
        git(
            repo,
            "archive",
            "--format=zip",
            "-9",
            f"--prefix={action_root}/",
            f"--output={action_archive}",
            args.materialized_commit,
            "--",
            *ARCHIVE_PATHS,
        )
        distribution = staging / "distribution"
        verify_zip(
            action_archive, archive_entries(materialized), f"{action_root}/", distribution
        )
        # Parse metadata using trusted tooling; never execute selected-source bundles here.
        env = {
            key: value
            for key, value in os.environ.items()
            if key not in {"NODE_OPTIONS", "NODE_PATH"}
        }
        subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                "const {validateDistribution} = await import(process.argv[1]); await validateDistribution(process.argv[2]);",
                (ROOT / "scripts/validate-distribution.mjs").as_uri(),
                str(distribution),
            ],
            check=True,
            capture_output=True,
            env=env,
        )
        # Reserve the destination only after validation. Never replace an existing output.
        output.mkdir()
        for archive in (source_archive, action_archive):
            with (
                archive.open("rb") as data,
                (output / archive.name).open("xb") as destination,
            ):
                shutil.copyfileobj(data, destination)
            sys.stdout.write(f"{output / archive.name}\n")
    sys.stdout.write(
        f"Packaged source {args.source_commit} and materialized {args.materialized_commit}\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=ROOT)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--materialized-commit", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        package(args)
    except (
        ValueError,
        OSError,
        subprocess.CalledProcessError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        detail = (
            error.stderr.decode(errors="replace").strip()
            if isinstance(error, subprocess.CalledProcessError)
            else str(error)
        )
        sys.stderr.write(f"release-archives: {detail}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
