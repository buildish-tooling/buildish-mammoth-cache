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

"""Small data-boundary checks for the component's ordinary release workflows.

Lifecycle state resolution, Git materialization, signing and remote mutations remain
Release Tooling commands in the workflows. This script only handles transport
inventories, component approval/evidence, downloads and consumer staging.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath

REPOSITORY = "buildish-tooling/buildish-mammoth-cache"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
SHA256 = re.compile(r"[0-9a-f]{64}")
COMMIT = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")


def require(pattern: re.Pattern, value: str, label: str) -> str:
    if not pattern.fullmatch(value):
        raise ValueError(f"Invalid {label}: {value!r}")
    return value


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path: Path) -> dict:
    if path.stat().st_size > 1024 * 1024:
        raise ValueError(f"JSON input too large: {path}")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("JSON input must be an object")
    return value


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        stream.write(json.dumps(value, sort_keys=True, indent=2) + "\n")


def output(name: str, value: str) -> None:
    if not re.fullmatch(r"[a-z_]+", name) or not re.fullmatch(
        r"[a-zA-Z0-9._/-]+", value
    ):
        raise ValueError("Unsafe workflow scalar output")
    if path := os.environ.get("GITHUB_OUTPUT"):
        with Path(path).open("a") as stream:
            stream.write(f"{name}={value}\n")
    else:
        print(f"{name}={value}")


def safe_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        not name
        or path.is_absolute()
        or path.as_posix() != name
        or any(part in {"..", ".git"} for part in path.parts)
        or not re.fullmatch(r"[A-Za-z0-9_./-]+", name)
    ):
        raise ValueError(f"Unsafe transport path: {name!r}")
    return path


def files(directory: Path, *, exclude_index: bool = False) -> dict[str, Path]:
    result = {}
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError("Transport symlinks are forbidden")
        if path.is_file():
            name = path.relative_to(directory).as_posix()
            safe_path(name)
            if not exclude_index or name != "transport.json":
                result[name] = path
    return result


def seal(directory: Path) -> None:
    entries = files(directory, exclude_index=True)
    if not entries:
        raise ValueError("Empty transport bundle")
    write(
        directory / "transport.json",
        {
            name: {"sha256": digest(path), "size": path.stat().st_size}
            for name, path in sorted(entries.items())
        },
    )
    output("bundle_digest", digest(directory / "transport.json"))


def verify(directory: Path, expected: str) -> None:
    require(SHA256, expected, "producer transport SHA-256")
    index = directory / "transport.json"
    if index.is_symlink() or digest(index) != expected:
        raise ValueError("Transport inventory does not match the producer digest")
    entries = read(index)
    actual = files(directory, exclude_index=True)
    if not entries or entries.keys() != actual.keys():
        raise ValueError("Transport inventory has missing or extra files")
    for name, record in entries.items():
        safe_path(name)
        if (
            actual[name].stat().st_size != record["size"]
            or digest(actual[name]) != record["sha256"]
        ):
            raise ValueError(f"Transport file differs from producer: {name}")


def check_digest(path: Path, expected: str) -> None:
    if digest(path) != require(SHA256, expected, "producer SHA-256"):
        raise ValueError(f"Producer digest mismatch: {path}")


def archive_names(version: str) -> list[str]:
    require(VERSION, version, "version")
    return [
        f"buildish-mammoth-cache-{version}-src.tar.gz",
        f"buildish-mammoth-cache-{version}-github-action.zip",
    ]


def asset_names(version: str) -> set[str]:
    return {
        name + suffix
        for name in archive_names(version)
        for suffix in ("", ".asc", ".sha256", ".sha512")
    } | {"materialized.bundle"}


def check_assets(directory: Path, version: str, signed: bool) -> None:
    expected = asset_names(version) if signed else set(archive_names(version))
    actual = files(directory)
    if actual.keys() != expected or any(
        path.stat().st_size == 0 for path in actual.values()
    ):
        raise ValueError(
            "Release asset set must match the exact nonempty component inventory"
        )


def state_outputs(path: Path) -> None:
    state = read(path)
    output("state_digest", digest(path))
    output(
        "source_commit", require(COMMIT, state["source"]["commit_sha"], "source commit")
    )
    tag = state.get("candidate", {}).get("tag", {})
    if tag:
        output("candidate_tag", tag["name"])
    if final := state.get("final_tag", state.get("final_tag_identity")):
        output("final_tag", final["name"])
    if binding := state.get("materialization"):
        output(
            "materialized_commit",
            require(COMMIT, binding["commit_sha"], "materialized commit"),
        )
        output(
            "git_bundle_digest",
            require(SHA256, binding["bundle_sha256"], "Git bundle digest"),
        )


def preflight(mode: str) -> None:
    version = require(VERSION, os.environ["RELEASE_VERSION"], "version")
    if (
        os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
        or os.environ.get("GITHUB_REF") != "refs/heads/main"
    ):
        raise ValueError("Release dispatch must use this repository's main workflow")
    if mode == "candidate":
        if source := os.environ.get("SOURCE_COMMIT", ""):
            require(COMMIT, source, "full source commit")
    else:
        if not re.fullmatch(
            rf"v{re.escape(version)}-rc[1-9][0-9]*", os.environ["CANDIDATE_TAG"]
        ):
            raise ValueError(
                "Candidate tag must match this version and a positive RC number"
            )
        require(
            SHA256, os.environ["CANDIDATE_MANIFEST_DIGEST"], "candidate manifest digest"
        )
        approval_record()


def approval_record() -> dict:
    # GitHub authorizes dispatch/reruns; retain the original dispatch actor as evidence.
    actor = os.environ.get("GITHUB_ACTOR", "")
    if not actor.strip():
        raise ValueError("GitHub dispatch actor is required for the approval record")
    version = require(VERSION, os.environ["RELEASE_VERSION"], "version")
    tag = os.environ["CANDIDATE_TAG"]
    if not re.fullmatch(rf"v{re.escape(version)}-rc[1-9][0-9]*", tag):
        raise ValueError("Approval candidate does not match version")
    return {
        "approver": actor.casefold(),
        "version": version,
        "candidate_tag": tag,
        "candidate_manifest_digest": require(
            SHA256, os.environ["CANDIDATE_MANIFEST_DIGEST"], "candidate manifest digest"
        ),
    }


def download_assets(
    manifest: Path, expected: str, destination: Path, version: str
) -> None:
    check_digest(manifest, expected)
    payload = read(manifest)
    tag = payload["candidate"]["tag"]["name"]
    if not re.fullmatch(rf"v{re.escape(version)}-rc[1-9][0-9]*", tag):
        raise ValueError("Downloaded candidate version differs")
    artifacts = payload["artifacts"]
    if len(artifacts) != len(asset_names(version)) or {
        a["logical_name"] for a in artifacts
    } != asset_names(version):
        raise ValueError("Candidate asset inventory differs from component contract")
    destination.mkdir()
    for artifact in artifacts:
        name = artifact["logical_name"]
        subprocess.run(
            [
                "gh",
                "release",
                "download",
                tag,
                "--repo",
                REPOSITORY,
                "--pattern",
                name,
                "--dir",
                str(destination),
            ],
            check=True,
        )
        path = destination / name
        if (
            path.stat().st_size != artifact["size_bytes"]
            or digest(path) != artifact["digests"]["sha256"]
        ):
            raise ValueError(f"Downloaded candidate asset mismatch: {name}")
    if (
        digest(destination / "materialized.bundle")
        != payload["materialization"]["bundle_sha256"]
    ):
        raise ValueError(
            "Retained Git bundle differs from candidate materialization binding"
        )
    check_assets(destination, version, True)


def unpack(archive: Path, destination: Path, version: str) -> None:
    root = f"buildish-mammoth-cache-{version}-github-action"
    require(VERSION, version, "version")
    destination.mkdir()
    seen = set()
    with zipfile.ZipFile(archive) as contents:
        for member in contents.infolist():
            name = member.filename.rstrip("/")
            safe_path(name)
            if name != root and not name.startswith(root + "/"):
                raise ValueError("Action ZIP member outside component root")
            if name in seen or (member.external_attr >> 16) & 0o170000 not in (
                0,
                0o040000,
                0o100000,
            ):
                raise ValueError("Duplicate or non-regular Action ZIP entry")
            seen.add(name)
            target = destination / name
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as stream:
                    stream.write(contents.read(member))
                target.chmod(0o755 if (member.external_attr >> 16) & 0o111 else 0o644)


def consumer_record(state_path: Path, ref: str) -> dict:
    state = read(state_path)
    binding = state["materialization"]
    expected = require(COMMIT, binding["commit_sha"], "materialized commit")
    expected_tag = state["final_tag"]["name"]
    if ref != expected_tag:
        raise ValueError("Consumer tag differs from promotion final tag")
    observed = subprocess.run(
        ["git", "--no-replace-objects", "rev-parse", f"refs/tags/{ref}^{{commit}}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if observed != expected:
        raise ValueError("Consumed release tag does not target approved M")
    tree = subprocess.run(
        ["git", "--no-replace-objects", "rev-parse", f"{expected}^{{tree}}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if tree != binding["tree_sha"]:
        raise ValueError("Consumed release tree differs from approved M")
    node = subprocess.run(
        ["node", "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if not node.startswith("v24."):
        raise ValueError("Release-ref consumer must run on Node 24")
    return {
        "version": state["release"]["version"],
        "tag": ref,
        "source": state["source"]["commit_sha"],
        "materialized": expected,
        "tree": tree,
        "node_major": "24",
        "scenarios": "gradle,maven:main,post",
    }


def evidence(
    state_path: Path, approval: Path, consumer: Path, destination: Path
) -> None:
    state = read(state_path)
    approved, consumed = read(approval), read(consumer)
    if (
        approved["version"] != state["release"]["version"]
        or approved["candidate_tag"] != state["candidate"]["tag"]["name"]
        or approved["candidate_manifest_digest"] != state["candidate_manifest_digest"]
        or consumed
        != {
            "version": state["release"]["version"],
            "tag": state["final_tag"]["name"],
            "source": state["source"]["commit_sha"],
            "materialized": state["materialization"]["commit_sha"],
            "tree": state["materialization"]["tree_sha"],
            "node_major": "24",
            "scenarios": "gradle,maven:main,post",
        }
    ):
        raise ValueError(
            "Approval/consumer evidence does not bind the exact promotion identity"
        )
    # Preserve the complete opaque CLI state; add only component-owned verification records.
    for kind, record, uri in (
        (
            "mammoth-cache-maintainer-approval",
            approved,
            f"https://github.com/{REPOSITORY}/releases/tag/{approved['candidate_tag']}",
        ),
        (
            "mammoth-cache-node24-consumer",
            consumed,
            f"https://github.com/{REPOSITORY}/tree/{consumed['tag']}",
        ),
    ):
        state.setdefault("verification_results", []).append(
            {
                "kind": kind,
                "uri": uri,
                "claims": {
                    "record": json.dumps(record, sort_keys=True, separators=(",", ":"))
                },
            }
        )
    write(destination, state)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=(
            "preflight",
            "seal",
            "verify",
            "digest",
            "outputs",
            "assets",
            "approval",
            "download",
            "unpack",
            "consumer-record",
            "evidence",
        ),
    )
    parser.add_argument("args", nargs="*")
    command, args = (parsed := parser.parse_args()).command, parsed.args
    if command == "preflight":
        preflight(args[0])
    elif command == "seal":
        seal(Path(args[0]))
    elif command == "verify":
        verify(Path(args[0]), args[1])
    elif command == "digest":
        check_digest(Path(args[0]), args[1])
    elif command == "outputs":
        state_outputs(Path(args[0]))
    elif command == "assets":
        check_assets(Path(args[0]), args[1], args[2] == "signed")
    elif command == "approval":
        write(Path(args[0]), approval_record())
    elif command == "download":
        download_assets(Path(args[0]), args[1], Path(args[2]), args[3])
    elif command == "unpack":
        unpack(Path(args[0]), Path(args[1]), args[2])
    elif command == "consumer-record":
        write(Path(args[2]), consumer_record(Path(args[0]), args[1]))
    elif command == "evidence":
        evidence(*(Path(arg) for arg in args))


if __name__ == "__main__":
    try:
        main()
    except (
        ValueError,
        OSError,
        KeyError,
        IndexError,
        TypeError,
        subprocess.CalledProcessError,
        zipfile.BadZipFile,
    ) as error:
        sys.exit(f"release-workflow: {error}")
