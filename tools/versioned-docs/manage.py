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

"""Repository-local Git worktree and tagged documentation maintenance."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import Request, urlopen

GITHUB_REPOSITORY = "buildish-tooling/buildish-mammoth-cache"
REPOSITORY = f"https://github.com/{GITHUB_REPOSITORY}"
DEFAULT_REMOTE = f"{REPOSITORY}.git"
COMPONENT = "mammoth-cache"
PROVIDER = "mammoth-cache-tags"
ROOT = Path(__file__).resolve().parents[2]
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
PUBLICATION_STATES = (None, "published", "hidden", "withdrawn", "tombstoned")
EXCLUDED_STATES = {"hidden", "withdrawn", "tombstoned"}
# Release Tooling's release_notes.path_template in buildish-release-tooling/release-config.yaml.
NOTES_SOURCE = "buildish-release-tooling/release-notes/{version}.md"
NOTES_DIRECTORY = "release-notes"


def notes_reference(version: str) -> dict:
    return {"path": f"{NOTES_DIRECTORY}/{version}.md"}


def artifact_identity() -> dict:
    return {"componentSlug": COMPONENT, "artifactKey": COMPONENT}


def scoped_release_states(data: dict) -> dict:
    """Check ownership/identity before writes; Pipeline owns full lifecycle validation."""
    artifacts = data.get("artifacts", [])
    if not isinstance(artifacts, list):
        raise ValueError("Snapshot artifacts must be a list")
    states = {}
    seen = False
    for artifact in artifacts:
        if (
            not isinstance(artifact, dict)
            or artifact.get("componentSlug") != COMPONENT
            or artifact.get("artifactKey") != COMPONENT
            or seen
        ):
            raise ValueError("Snapshot contains foreign or duplicate artifacts")
        seen = True
        if artifact.get("latestStable") is not None:
            version_key(artifact["latestStable"])
        for field, identity in (("releaseLines", "key"), ("releases", "version")):
            items = artifact.get(field)
            if items is None:
                continue
            if not isinstance(items, list):
                raise ValueError(f"Snapshot artifact {field} must be a list")
            identities = set()
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError(
                        f"Snapshot artifact {field} entries must be objects"
                    )
                key = item.get(identity)
                if not isinstance(key, str) or not key.strip() or key in identities:
                    raise ValueError(
                        f"Snapshot artifact has invalid or duplicate {field} identities"
                    )
                identities.add(key)
                if field == "releaseLines":
                    version_key(item.get("latest"))
                else:
                    version_key(key)
                    state = item.get("publicationState")
                    if state not in PUBLICATION_STATES:
                        raise ValueError(
                            "Snapshot contains an invalid publication state"
                        )
                    states[key] = state
    return states


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True
    )
    return result.stdout.decode().strip()


def clean(worktree: Path) -> None:
    if git(worktree, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError(
            f"Worktree has local changes; commit or move them first: {worktree}"
        )


def checked_worktree(args: argparse.Namespace) -> Path:
    path = args.worktree.absolute()
    # A parent checkout must never accidentally pass as the requested worktree.
    if not path.is_dir() or path.is_symlink():
        raise ValueError(f"Expected a real docs worktree: {path}")
    if Path(git(path, "rev-parse", "--show-toplevel")).resolve() != path.resolve():
        raise ValueError(f"Not a worktree root: {path}")
    if git(path, "symbolic-ref", "--short", "HEAD") != args.branch:
        raise ValueError(f"Worktree must be on branch {args.branch}")
    common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    expected = git(
        args.source, "rev-parse", "--path-format=absolute", "--git-common-dir"
    )
    if Path(common).resolve() != Path(expected).resolve():
        raise ValueError("Docs worktree belongs to another repository")
    clean(path)
    return path


def checkout(args: argparse.Namespace) -> None:
    path = args.worktree.absolute()
    if path.exists() or path.is_symlink():
        checked_worktree(args)
        sys.stdout.write(f"Already checked out: {path}\n")
        return
    branch_ref = f"refs/heads/{args.branch}"
    git(args.source, "check-ref-format", branch_ref)
    local = git(args.source, "for-each-ref", "--format=%(refname)", branch_ref)
    if args.create:
        if local:
            raise ValueError(f"Branch already exists: {args.branch}; omit --create")
        # Orphan checkout contains no source history or source-tree files.
        git(args.source, "worktree", "add", "--orphan", "-b", args.branch, str(path))
    elif local:
        git(args.source, "worktree", "add", str(path), args.branch)
    else:
        git(args.source, "fetch", "--no-tags", "--", args.remote, branch_ref)
        git(args.source, "worktree", "add", "-b", args.branch, str(path), "FETCH_HEAD")
    sys.stdout.write(f"Docs worktree ready: {path}\n")


def update(args: argparse.Namespace) -> None:
    path = checked_worktree(args)
    git(
        args.source,
        "fetch",
        "--no-tags",
        "--",
        args.remote,
        f"refs/heads/{args.branch}",
    )
    commit = git(args.source, "rev-parse", "FETCH_HEAD^{commit}")
    git(path, "merge", "--ff-only", commit)
    sys.stdout.write(f"Updated {path} (fast-forward only; nothing pushed)\n")


def version_key(value: str) -> tuple[int, ...]:
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise ValueError(f"Expected a stable X.Y.Z version: {value}")
    return tuple(int(part) for part in value.split("."))


def github_json(endpoint: str) -> dict:
    request = Request(
        f"https://api.github.com/repos/{GITHUB_REPOSITORY}/{endpoint}",
        headers={"Accept": "application/vnd.github+json"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            data = json.load(response)
    except (OSError, ValueError) as error:
        raise ValueError(f"GitHub lookup failed for {endpoint}: {error}") from error
    if not isinstance(data, dict):
        raise ValueError(f"Expected a GitHub object for {endpoint}")
    return data


def hosted_tag_commit(tag: str) -> str:
    ref = f"refs/tags/{tag}"
    response = github_json(f"git/ref/tags/{tag}")
    if response.get("ref") != ref:
        raise ValueError(f"GitHub did not return the exact ref {ref}")
    target = response.get("object")
    seen = set()
    while isinstance(target, dict):
        sha = target.get("sha")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
            break
        if target.get("type") == "commit":
            return sha
        if target.get("type") != "tag" or sha in seen:
            break
        seen.add(sha)
        target = github_json(f"git/tags/{sha}").get("object")
    raise ValueError(f"GitHub ref {ref} does not resolve to a commit")


def verified_publication_time(tag: str, commit: str) -> str:
    release = github_json(f"releases/tags/{tag}")
    if (
        release.get("tag_name") != tag
        or release.get("draft") is not False
        or release.get("prerelease") is not False
    ):
        raise ValueError(f"GitHub does not report a final published release for {tag}")
    published_at = release.get("published_at")
    try:
        if not isinstance(published_at, str):
            raise ValueError
        datetime.strptime(published_at, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise ValueError(
            f"GitHub release {tag} has no valid publication timestamp"
        ) from None
    # target_commitish may name a branch. Resolve the hosted tag itself.
    if hosted_tag_commit(tag) != commit:
        raise ValueError(f"GitHub tag {tag} does not match the local commit {commit}")
    return published_at


def published_metadata(record: dict, artifacts: list) -> tuple[dict, list]:
    version = record["version"]
    line_key = version.rsplit(".", 1)[0]
    artifact = artifacts[0] if artifacts else artifact_identity()
    for facts in (record, *(artifact.get("releases") or [])):
        if facts["version"] != version:
            continue
        if facts.get("publicationState") not in (None, "published"):
            raise ValueError(
                f"Release {version} is excluded by snapshot publication policy"
            )
        if facts.get("releaseLine") not in (None, line_key):
            raise ValueError(f"Release {version} has a conflicting primary release line")

    commit = record["commitSha"]
    published_at = verified_publication_time(record["tag"], commit)
    record = {
        **record,
        "releaseLine": line_key,
        "publicationState": "published",
        "publishedAt": published_at,
        "docsSource": {"repository": REPOSITORY, "root": "docs", "ref": commit},
    }
    lines = {line["key"]: line for line in artifact.get("releaseLines") or []}
    line = lines.get(line_key, {"key": line_key})
    if "latest" not in line or version_key(version) > version_key(line["latest"]):
        lines[line_key] = {**line, "latest": version}
    artifact = {**artifact, "releaseLines": list(lines.values())}
    latest = artifact.get("latestStable")
    if latest is None or version_key(version) > version_key(latest):
        artifact["latestStable"] = version
    return record, [artifact]


def load_snapshot(path: Path) -> dict:
    if path.is_symlink():
        raise ValueError("Snapshot must not be a symlink")
    if not path.exists():
        return {
            "schemaVersion": 1,
            "providers": [],
            "records": [],
            "artifacts": [artifact_identity()],
        }
    data = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(data, dict)
        or data.get("schemaVersion") != 1
        or not isinstance(data.get("records"), list)
        or not isinstance(data.get("providers"), list)
    ):
        raise ValueError("Unsupported provider snapshot")
    curated_states = scoped_release_states(data)
    versions = set()
    for record in data["records"]:
        if not isinstance(record, dict):
            raise ValueError("Snapshot records must be objects")
        version = record["version"]
        version_key(version)
        if (
            record.get("componentSlug") != COMPONENT
            or record.get("artifactKey") != COMPONENT
            or record.get("provider") != PROVIDER
            or record.get("kind") != "released"
            or version in versions
        ):
            raise ValueError("Snapshot contains foreign or duplicate records")
        if record.get("publicationState") not in PUBLICATION_STATES:
            raise ValueError("Snapshot contains an invalid publication state")
        if "releaseNotes" in record and record["releaseNotes"] != notes_reference(
            version
        ):
            raise ValueError(f"Snapshot contains unmanaged release notes for {version}")
        observed = record.get("publicationState")
        curated = curated_states.get(version)
        if observed is not None and curated is not None and observed != curated:
            raise ValueError(f"Contradictory publication states for {version}")
        versions.add(version)
    providers = data["providers"]
    if providers and (
        len(providers) != 1
        or not isinstance(providers[0], dict)
        or providers[0].get("key") != PROVIDER
        or providers[0].get("type") != "git-tags"
    ):
        raise ValueError("Snapshot contains foreign providers")
    if data["records"] and not providers:
        raise ValueError("Snapshot records require their provider descriptor")
    return data


def export_docs(source: Path, tag: str, destination: Path) -> None:
    listing = subprocess.run(
        ["git", "-C", str(source), "ls-tree", "-rz", tag, "--", "docs/"],
        check=True,
        capture_output=True,
    ).stdout
    entries = []
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, blob = metadata.decode().split()
        relative = Path(raw_path.decode()).relative_to("docs")
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.parts[0] == "releases"
        ):
            raise ValueError(f"Unexpected docs path in {tag}: {relative}")
        if mode not in {"100644", "100755"} or kind != "blob":
            raise ValueError(
                f"Unsupported docs entry in {tag}: {relative} (symlink/submodule?)"
            )
        entries.append((relative, blob))
    if not entries or not any(path == Path("_index.md") for path, _ in entries):
        raise ValueError(f"Tag {tag} has no docs/_index.md")
    destination.mkdir()
    for relative, blob in entries:
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(git_blob(source, blob))


def git_blob(source: Path, blob: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(source), "cat-file", "blob", blob],
        check=True,
        capture_output=True,
    ).stdout


def tagged_notes_blob(source: Path, commit: str, version: str) -> str | None:
    path = NOTES_SOURCE.format(version=version)
    listing = git(source, "ls-tree", commit, "--", path)
    if not listing:
        return None
    metadata, _path = listing.split("\t", 1)
    mode, kind, blob = metadata.split()
    if mode not in {"100644", "100755"} or kind != "blob":
        raise ValueError(f"Unsupported release notes entry in {commit}: {path}")
    return blob


def strip_title(text: str) -> str:
    """Drop one leading top-level heading; the site generates the page title."""
    prefix = ""
    if text.startswith("<!--") and "-->" in text:
        end = text.index("-->") + 3
        prefix, text = text[:end], text[end:]
    body = text.lstrip("\n")
    first, _, rest = body.partition("\n")
    if not first.startswith("# "):
        return prefix + text
    return prefix + text[: len(text) - len(body)] + rest.lstrip("\n")


def import_docs(args: argparse.Namespace) -> None:
    worktree = checked_worktree(args)
    snapshot_path = worktree / "provider-snapshot.json"
    snapshot = load_snapshot(snapshot_path)
    curated_states = scoped_release_states(snapshot)
    previous = {record["version"]: record for record in snapshot["records"]}
    minimum = version_key(args.minimum_version) if args.minimum_version else None
    if args.version:
        selected = sorted(set(args.version), key=version_key)
    else:
        tags = git(args.source, "tag", "--list", "v*").splitlines()
        selected = sorted(
            (
                tag[1:]
                for tag in tags
                if VERSION.fullmatch(tag[1:])
                and (minimum is None or version_key(tag[1:]) >= minimum)
            ),
            key=version_key,
        )
    if not selected:
        if previous:
            sys.stdout.write(
                "No matching local tags; retained existing inventory unchanged\n"
            )
            return
        raise ValueError(
            "No matching local stable tags; fetch tags or use --version X.Y.Z"
        )
    records = previous.copy()
    previous_artifacts = snapshot.get("artifacts", [artifact_identity()])
    artifacts = previous_artifacts
    exports = []
    notes_exports = []
    notes_root = worktree / NOTES_DIRECTORY
    if notes_root.is_symlink() or (notes_root.exists() and not notes_root.is_dir()):
        raise ValueError(f"Expected managed directory: {notes_root}")
    for version in selected:
        tag = f"v{version}"
        commit = git(
            args.source, "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"
        )
        old = previous.get(version)
        if old and (old.get("commitSha") != commit or old.get("tag") != tag):
            raise ValueError(
                f"Tag changed for existing snapshot {version}; investigate before rebuilding"
            )
        target = worktree / version
        if target.is_symlink():
            raise ValueError(f"Docs directory must not be a symlink: {target}")
        if target.exists() and (not target.is_dir() or version not in previous):
            raise ValueError(f"Refusing to replace unowned path: {target}")
        if target.exists() and any(item.is_symlink() for item in target.rglob("*")):
            raise ValueError(f"Existing docs must not contain symlinks: {target}")
        record = old or {
            "provider": PROVIDER,
            "kind": "released",
            "componentSlug": COMPONENT,
            "artifactKey": COMPONENT,
            "version": version,
            "tag": tag,
            "commitSha": commit,
            "externalId": f"git:buildish-mammoth-cache:{tag}",
            "externalUrl": f"{REPOSITORY}/releases/tag/{tag}",
        }
        if args.post_release:
            record, artifacts = published_metadata(record, artifacts)
        notes_target = notes_root / f"{version}.md"
        if notes_target.is_symlink() or (
            notes_target.exists()
            and (not notes_target.is_file() or "releaseNotes" not in record)
        ):
            raise ValueError(f"Refusing to replace unowned path: {notes_target}")
        excluded = (
            curated_states.get(version) or record.get("publicationState")
        ) in EXCLUDED_STATES
        # Rebuilt docs refresh their notes; existing records gain missing notes.
        if not excluded and (
            args.full_rebuild
            or not old
            or "releaseNotes" not in record
            or not notes_target.is_file()
        ):
            blob = tagged_notes_blob(args.source, commit, version)
            if blob is not None:
                notes_exports.append((version, blob))
                record = {**record, "releaseNotes": notes_reference(version)}
        records[version] = record
        if old and not args.full_rebuild:
            if (
                curated_states.get(version) or old.get("publicationState")
            ) not in EXCLUDED_STATES and not (worktree / version / "_index.md").is_file():
                raise ValueError(
                    f"Missing docs for {version}; use --full-rebuild to restore"
                )
            continue
        exports.append((version, commit))
    if (
        not exports
        and not notes_exports
        and not args.full_rebuild
        and records == previous
        and artifacts == previous_artifacts
    ):
        sys.stdout.write("Release docs already up to date\n")
        return
    # Validate and export all tags before replacing any existing docs.
    with tempfile.TemporaryDirectory(
        prefix="versioned-docs-", dir=worktree.parent
    ) as temp:
        staging = Path(temp)
        for version, commit in exports:
            export_docs(args.source, commit, staging / version)
        for version, blob in notes_exports:
            text = git_blob(args.source, blob).decode("utf-8")
            output = staging / NOTES_DIRECTORY / f"{version}.md"
            output.parent.mkdir(exist_ok=True)
            output.write_text(strip_title(text), encoding="utf-8")
        snapshot = {
            **snapshot,
            "schemaVersion": 1,
            "artifacts": artifacts,
            "providers": [
                {
                    **(snapshot["providers"][0] if snapshot["providers"] else {}),
                    "key": PROVIDER,
                    "type": "git-tags",
                    "displayName": "Mammoth Cache Git tags",
                    "baseUrl": REPOSITORY,
                    "fetchedAt": datetime.now(UTC).isoformat(),
                }
            ],
            "records": [records[v] for v in sorted(records, key=version_key)],
        }
        staged_snapshot = staging / snapshot_path.name
        staged_snapshot.write_text(
            json.dumps(snapshot, indent=2) + "\n", encoding="utf-8"
        )
        if args.full_rebuild:
            for version, _commit in exports:
                target = worktree / version
                if target.is_symlink() or (target.exists() and not target.is_dir()):
                    raise ValueError(f"Expected managed directory: {target}")
            for version, _commit in exports:
                if (worktree / version).exists():
                    shutil.rmtree(worktree / version)
        for version, _commit in exports:
            (staging / version).rename(worktree / version)
        for version, _blob in notes_exports:
            notes_root.mkdir(exist_ok=True)
            (staging / NOTES_DIRECTORY / f"{version}.md").replace(
                notes_root / f"{version}.md"
            )
        staged_snapshot.replace(snapshot_path)
    action = (
        f"Imported {len(exports)} version(s) into"
        if exports
        else "Updated release metadata in"
    )
    sys.stdout.write(f"{action} {worktree}; review and commit separately\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("checkout", "update", "import"):
        command = commands.add_parser(name)
        command.add_argument(
            "--source", type=Path, default=ROOT, help="Source Git repository"
        )
        command.add_argument(
            "--worktree", type=Path, help="Default: <source>/docs/releases"
        )
        command.add_argument("--branch", default="versioned-docs")
        if name != "import":
            command.add_argument(
                "--remote",
                default=DEFAULT_REMOTE,
                help="Remote URL or name; no remotes are configured",
            )
        if name == "checkout":
            command.add_argument(
                "--create",
                action="store_true",
                help="Create a new local orphan branch; no fetch/commit/push",
            )
        if name == "import":
            command.add_argument(
                "--version",
                action="append",
                help="Import only this version; repeatable, overrides minimum",
            )
            command.add_argument(
                "--post-release",
                action="store_true",
                help="Verify one exact --version on GitHub and update release metadata",
            )
            command.add_argument(
                "--minimum-version",
                help="Optional minimum stable version for tag discovery; default scans all stable tags",
            )
            command.add_argument(
                "--full-rebuild",
                action="store_true",
                help="Rebuild selected docs directories, preserving existing inventory metadata",
            )
    args = parser.parse_args()
    if args.command == "import" and args.post_release:
        if len(args.version or []) != 1 or args.minimum_version is not None:
            parser.error(
                "--post-release requires exactly one --version and no --minimum-version"
            )
    args.source = args.source.resolve()
    args.worktree = args.worktree or args.source / "docs/releases"
    try:
        {"checkout": checkout, "update": update, "import": import_docs}[args.command](
            args
        )
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        message = (
            error.stderr.decode().strip()
            if isinstance(error, subprocess.CalledProcessError)
            else str(error)
        )
        sys.stderr.write(f"versioned-docs: {message}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
