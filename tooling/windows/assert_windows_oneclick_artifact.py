#!/usr/bin/env python3
"""Static audit for the BLUE-TANUKI Windows one-click installer artifact."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


INSTALLER_PATTERN = "blue-tanuki-*-windows-x64-installer.zip"
INSTALLER_RE = re.compile(r"^blue-tanuki-.+-windows-x64-installer\.zip$")
WINDOWS_RUNTIME_RE = re.compile(r"^runtime/node-v\d+\.\d+\.\d+-win-x64\.zip$")

REQUIRED_ZIP_FILES = (
    "BlueTanukiSetup.cmd",
    "BlueTanukiSetup.ps1",
    "windows-installer-manifest.json",
    "launcher/BlueTanuki.cmd",
    "launcher/BlueTanukiLauncher.ps1",
    "launcher/BlueTanukiUninstall.ps1",
    "launcher/BlueTanukiStop.cmd",
    "launcher/BlueTanukiDoctor.cmd",
    "launcher/BlueTanukiRestart.cmd",
    "launcher/BlueTanukiSafeMode.cmd",
    "launcher/UninstallBlueTanuki.cmd",
    "app/package.json",
    "app/apps/gateway/dist/main.js",
    "app/packages/protocol/dist/index.js",
    "app/packages/hds-brain/dist/index.js",
    "app/packages/blue-tanuki/dist/index.js",
    "app/packages/channel-base/dist/index.js",
    "app/packages/channel-webchat/dist/index.js",
    "app/packages/channel-telegram/dist/index.js",
    "app/packages/operator-writing/dist/index.js",
    "app/packages/operator-daily/dist/index.js",
    "app/packages/operator-developer/dist/index.js",
    "app/node_modules/@blue-tanuki/core/package.json",
    "app/node_modules/@blue-tanuki/hds-brain/package.json",
    "app/node_modules/@blue-tanuki/protocol/package.json",
    "app/node_modules/ws/package.json",
    "app/node_modules/zod/package.json",
)

NORMAL_PATH_SCRIPT_FILES = (
    "BlueTanukiSetup.cmd",
    "BlueTanukiSetup.ps1",
    "launcher/BlueTanuki.cmd",
    "launcher/BlueTanukiLauncher.ps1",
)

FORBIDDEN_NORMAL_PATH_FRAGMENTS = (
    "corepack enable",
    "corepack prepare",
    "pnpm install",
    "pnpm build",
    "pnpm package:windows",
    "npm install",
    "npm exec",
    "git clone",
)

FORBIDDEN_ENTRY_PARTS = {
    ".git",
    ".blue-tanuki",
    ".codex-tmp",
    "GUI-Shell",
}

FORBIDDEN_FILE_NAMES = {
    ".env",
    ".env.local",
    ".npmrc",
    "blue-tanuki.env",
}


class AuditError(Exception):
    pass


def fail(message: str) -> None:
    raise AuditError(message)


def resolve_release_dir(arg: str) -> Path:
    candidate = Path(arg).resolve()
    if candidate.is_file():
        if candidate.name == "blue-tanuki-main.zip":
            fail("blue-tanuki-main.zip is a source zip, not a Windows user artifact")
        fail(f"expected repository root or release/windows directory, got file: {candidate}")
    if not candidate.exists():
        fail(f"path does not exist: {candidate}")

    nested = candidate / "release" / "windows"
    if nested.is_dir():
        return nested
    if any(candidate.glob(INSTALLER_PATTERN)) or candidate.name == "windows":
        return candidate
    fail(f"could not find release/windows under: {candidate}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_sidecar_sha(path: Path) -> str:
    text = path.read_text(encoding="utf-8").strip()
    match = re.search(r"\b([0-9a-fA-F]{64})\b", text)
    if not match:
        fail(f"sha256 sidecar does not contain a SHA-256 digest: {path}")
    return match.group(1).lower()


def require_manifest_value(manifest: dict[str, Any], dotted: str, expected: Any) -> None:
    current: Any = manifest
    for part in dotted.split("."):
        if not isinstance(current, dict) or part not in current:
            fail(f"manifest missing required field: {dotted}")
        current = current[part]
    if current != expected:
        fail(f"manifest field {dotted} expected {expected!r}, got {current!r}")


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"manifest is not valid JSON: {path}: {exc}")
    if not isinstance(data, dict):
        fail(f"manifest root must be an object: {path}")
    return data


def validate_manifest(manifest: dict[str, Any], zip_path: Path, actual_sha: str) -> None:
    require_manifest_value(manifest, "name", "blue-tanuki")
    require_manifest_value(manifest, "package_type", "windows-x64-zip-installer")
    require_manifest_value(manifest, "node_runtime.bundled", True)
    require_manifest_value(manifest, "user_experience.requires_node_pnpm_git_from_user", False)
    require_manifest_value(manifest, "user_experience.gui_entry", "http://127.0.0.1:8787/app")
    require_manifest_value(manifest, "boundaries.secrets_included", False)
    require_manifest_value(manifest, "boundaries.installer_autostart", False)
    require_manifest_value(manifest, "archive.file", zip_path.name)
    require_manifest_value(manifest, "archive.sha256", actual_sha)

    runtime = manifest.get("node_runtime")
    if not isinstance(runtime, dict):
        fail("manifest node_runtime must be an object")
    archive = runtime.get("archive")
    version = runtime.get("version")
    source = runtime.get("source")
    shasums = runtime.get("shasums_source")
    runtime_sha = runtime.get("sha256")
    if not isinstance(archive, str) or not re.match(r"^node-v\d+\.\d+\.\d+-win-x64\.zip$", archive):
        fail(f"manifest node_runtime.archive is not a Windows x64 Node zip: {archive!r}")
    if not isinstance(version, str) or archive != f"node-v{version}-win-x64.zip":
        fail("manifest node_runtime version/archive mismatch")
    if not isinstance(source, str) or not source.endswith(f"/{archive}"):
        fail("manifest node_runtime.source must point to the declared runtime archive")
    if not isinstance(shasums, str) or not shasums.endswith("/SHASUMS256.txt"):
        fail("manifest node_runtime.shasums_source must point to SHASUMS256.txt")
    if not isinstance(runtime_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", runtime_sha):
        fail("manifest node_runtime.sha256 must be a lowercase SHA-256 digest")


def validate_entry_name(name: str) -> None:
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        fail(f"zip entry must be relative: {name}")
    path = PurePosixPath(name)
    if ".." in path.parts:
        fail(f"zip entry must not traverse directories: {name}")
    for part in path.parts:
        if part in FORBIDDEN_ENTRY_PARTS:
            fail(f"zip entry contains forbidden directory: {name}")
    base = path.name.lower()
    if base in FORBIDDEN_FILE_NAMES:
        fail(f"zip entry contains forbidden secret/config filename: {name}")
    if base.endswith((".pem", ".p12", ".pfx", ".key")):
        fail(f"zip entry contains forbidden private key material: {name}")
    if base.startswith("blue-tanuki.env.") and base.endswith(".bak"):
        fail(f"zip entry contains forbidden env backup: {name}")


def read_zip_text(archive: zipfile.ZipFile, name: str) -> str:
    try:
        raw = archive.read(name)
    except KeyError:
        fail(f"zip missing required text file: {name}")
    return raw.decode("utf-8", errors="replace")


def validate_zip(zip_path: Path, sidecar_manifest: dict[str, Any]) -> None:
    with zipfile.ZipFile(zip_path) as archive:
        entries = set(archive.namelist())
        for name in entries:
            validate_entry_name(name)

        for required in REQUIRED_ZIP_FILES:
            if required not in entries:
                fail(f"zip missing required entry: {required}")

        for prefix in ("app/", "runtime/", "launcher/"):
            if not any(name.startswith(prefix) for name in entries):
                fail(f"zip missing required directory prefix: {prefix}")

        runtime_entries = sorted(name for name in entries if WINDOWS_RUNTIME_RE.match(name))
        if len(runtime_entries) != 1:
            fail(f"zip must contain exactly one bundled Windows Node runtime, got {runtime_entries}")

        expected_runtime = f"runtime/{sidecar_manifest['node_runtime']['archive']}"
        if runtime_entries[0] != expected_runtime:
            fail(f"zip runtime entry {runtime_entries[0]} does not match manifest {expected_runtime}")

        built_outputs = [name for name in entries if name.startswith("app/") and "/dist/" in name]
        if len(built_outputs) < 10:
            fail("zip does not contain enough built dist output; source-only package suspected")

        node_modules = [name for name in entries if name.startswith("app/node_modules/")]
        if len(node_modules) < 5:
            fail("zip does not contain packaged runtime node_modules; source-only package suspected")

        internal_manifest = json.loads(read_zip_text(archive, "windows-installer-manifest.json"))
        if not isinstance(internal_manifest, dict):
            fail("internal windows-installer-manifest.json must be a JSON object")
        require_manifest_value(internal_manifest, "name", "blue-tanuki")
        require_manifest_value(internal_manifest, "package_type", "windows-x64-zip-installer")
        require_manifest_value(internal_manifest, "node_runtime.bundled", True)
        require_manifest_value(
            internal_manifest,
            "user_experience.requires_node_pnpm_git_from_user",
            False,
        )

        for script_name in NORMAL_PATH_SCRIPT_FILES:
            text = read_zip_text(archive, script_name).lower()
            for fragment in FORBIDDEN_NORMAL_PATH_FRAGMENTS:
                if fragment in text:
                    fail(f"normal installer path script {script_name} contains forbidden fragment: {fragment}")


def audit(path_arg: str) -> tuple[Path, str]:
    release_dir = resolve_release_dir(path_arg)
    source_zip = release_dir / "blue-tanuki-main.zip"
    if source_zip.exists():
        fail("blue-tanuki-main.zip is a source zip and must not be present as the Windows user artifact")

    installers = sorted(path for path in release_dir.glob(INSTALLER_PATTERN) if INSTALLER_RE.match(path.name))
    if len(installers) != 1:
        fail(f"release/windows must contain exactly one {INSTALLER_PATTERN}; found {len(installers)}")

    zip_path = installers[0]
    sha_path = Path(f"{zip_path}.sha256")
    manifest_path = Path(f"{zip_path}.manifest.json")
    readme_path = release_dir / "README_INSTALL_WINDOWS.txt"
    for required in (sha_path, manifest_path, readme_path):
        if not required.is_file():
            fail(f"missing required sidecar: {required}")

    actual_sha = sha256_file(zip_path)
    sidecar_sha = read_sidecar_sha(sha_path)
    if actual_sha != sidecar_sha:
        fail(f"installer zip SHA-256 mismatch: actual {actual_sha}, sidecar {sidecar_sha}")

    manifest = load_manifest(manifest_path)
    validate_manifest(manifest, zip_path, actual_sha)
    validate_zip(zip_path, manifest)
    return zip_path, actual_sha


def main(argv: list[str]) -> int:
    path_arg = argv[1] if len(argv) > 1 else "."
    try:
        zip_path, actual_sha = audit(path_arg)
    except AuditError as exc:
        print("windows_oneclick_artifact_audit=fail", file=sys.stderr)
        print(f"reason={exc}", file=sys.stderr)
        return 1
    except zipfile.BadZipFile as exc:
        print("windows_oneclick_artifact_audit=fail", file=sys.stderr)
        print(f"reason=bad installer zip: {exc}", file=sys.stderr)
        return 1

    print("windows_oneclick_artifact_audit=pass")
    print(f"installer_zip_path={zip_path}")
    print(f"installer_zip_sha256={actual_sha}")
    print("source_zip_returned_as_user_artifact=false")
    print("user_requires_node_pnpm_git=false")
    print("normal_install_invokes_corepack=false")
    print("normal_install_invokes_pnpm=false")
    print("normal_install_invokes_source_build=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
