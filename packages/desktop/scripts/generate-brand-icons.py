#!/usr/bin/env python3
"""Generate every shipping NIBI desktop icon from the official source asset.

Source of truth: packages/ui/src/assets/nibi/nibi-app-icon.png
  (identical bytes to NIBI-Client-Private/docs/planning/ui-rebrand/preview/assets/nibi-app-icon.png)

Why Python/Pillow: the checked-in .ico/.icns/icons/*.png were produced by Pillow's
LANCZOS resize + ICO/ICNS encoders. Using the same encoder keeps regeneration
byte-for-byte reproducible. Pillow 13.0.0 was used for the current assets.

Usage (from the repository root):
  python packages/desktop/scripts/generate-brand-icons.py --check
  python packages/desktop/scripts/generate-brand-icons.py --write

`--check` regenerates into a temporary directory and fails if any tracked icon or
the manifest is stale. `--write` rewrites the icons and manifest.

This script deliberately does not draw artwork. If the official source is missing
or the wrong size, it fails instead of approximating an icon.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError as error:  # pragma: no cover - maintainer-only path
    raise SystemExit(
        "Pillow is required to regenerate NIBI icons: python -m pip install Pillow"
    ) from error

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE = REPO_ROOT / "packages/ui/src/assets/nibi/nibi-app-icon.png"
MANIFEST = REPO_ROOT / "packages/desktop/build/brand/icon-manifest.json"

PNG_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_SIZE = 1024
SOURCE_DIMENSIONS = (1024, 1024)

# Files that must never be used as product icons. Hashes are pinned so a future
# edit cannot silently swap the official NIBI artwork for upstream artwork.
FORBIDDEN_SHA256 = (
    {
        "sha256": "119462bb78eb240a65c869fc067ee599639b3cb5a41953f25c07b17d2a8c7e0f",
        "reason": "upstream blue-A app artwork",
    },
    {
        "sha256": "a4e030697a7571b3e95d31860e4da55d2f98e5e861e2b55e414f45a8556828ba",
        "reason": "upstream blue-A favicon artwork",
    },
    {
        "sha256": "0f7b3d57763e17d541cca7e3b983f67b4d08ba75ca3d364be9569874fa8d4652",
        "reason": "upstream provider icon",
    },
    {
        "sha256": "9de2d32f869150af875174e7c91137dd66ca4ef10b68687fd0f28c781f669a5f",
        "reason": "upstream provider icon (dark variant)",
    },
    {
        "sha256": "8159019313f25aad9862e959e86bbc66838e7926faead3ca099b9d254c056252",
        "reason": "upstream provider icon (light variant)",
    },
)


def relative(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_source() -> Image.Image:
    if not SOURCE.is_file():
        raise SystemExit(f"official NIBI icon source is missing: {relative(SOURCE)}")
    with Image.open(SOURCE) as image:
        image.load()
        if image.size != SOURCE_DIMENSIONS:
            raise SystemExit(
                f"official NIBI icon source must be {SOURCE_DIMENSIONS[0]}x{SOURCE_DIMENSIONS[1]}, "
                f"got {image.size[0]}x{image.size[1]}"
            )
        if image.mode != "RGBA":
            raise SystemExit(f"official NIBI icon source must be RGBA, got {image.mode}")
        return image.copy()


def png_paths() -> list[tuple[Path, int, str]]:
    paths: list[tuple[Path, int, str]] = []
    for name in ("icon.png", "icon_windows.png", "icon_macos_1024.png", "icon_installer.png"):
        paths.append((REPO_ROOT / "packages/desktop/build" / name, 1024, "copy"))
    paths.append(
        (
            REPO_ROOT / "packages/desktop/src/renderer/public/nibi-app-icon.png",
            1024,
            "copy",
        )
    )
    for size in PNG_SIZES:
        paths.append(
            (
                REPO_ROOT / f"packages/desktop/build/icons/{size}x{size}.png",
                size,
                "resize",
            )
        )
    return paths


def render(source: Image.Image, output_root: Path) -> None:
    # output_root is REPO_ROOT for --write, or a temporary tree for --check.
    for target, size, mode in png_paths():
        destination = output_root / target.relative_to(REPO_ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if mode == "copy":
            destination.write_bytes(SOURCE.read_bytes())
            # Validate the copied 1024 PNG too (cheap guard against a wrong source).
            if size != 1024:
                raise AssertionError(f"copy entry must be 1024, got {size}")
        else:
            source.resize((size, size), Image.Resampling.LANCZOS).save(destination, format="PNG")

    for name in ("icon.ico", "icon_installer.ico"):
        destination = output_root / "packages/desktop/build" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.save(destination, format="ICO", sizes=[(size, size) for size in ICO_SIZES])

    for name in ("icon.icns", "icon_installer.icns"):
        destination = output_root / "packages/desktop/build" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.save(destination, format="ICNS")


def manifest_for(output_root: Path, source_sha: str) -> dict[str, object]:
    files: list[dict[str, object]] = []
    for target, size, _mode in png_paths():
        path = output_root / target.relative_to(REPO_ROOT)
        files.append(
            {
                "path": relative(target),
                "kind": "png",
                "width": size,
                "height": size,
                "sha256": sha256(path),
            }
        )
    for name in ("icon.ico", "icon_installer.ico"):
        path = output_root / "packages/desktop/build" / name
        files.append(
            {
                "path": f"packages/desktop/build/{name}",
                "kind": "ico",
                "sizes": list(ICO_SIZES),
                "sha256": sha256(path),
            }
        )
    for name in ("icon.icns", "icon_installer.icns"):
        path = output_root / "packages/desktop/build" / name
        files.append(
            {
                "path": f"packages/desktop/build/{name}",
                "kind": "icns",
                "sizes": [16, 32, 64, 128, 256, 512, 1024],
                "sha256": sha256(path),
            }
        )
    return {
        "version": 1,
        "source": relative(SOURCE),
        "sourceSha256": source_sha,
        "generator": "packages/desktop/scripts/generate-brand-icons.py",
        "forbiddenSha256": list(FORBIDDEN_SHA256),
        "files": files,
    }


def compare(output_root: Path, source_sha: str) -> list[str]:
    problems: list[str] = []
    expected_manifest = manifest_for(output_root, source_sha)
    if not MANIFEST.is_file():
        problems.append(f"missing manifest: {relative(MANIFEST)}")
    else:
        actual_manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if actual_manifest != expected_manifest:
            problems.append(
                f"stale manifest: {relative(MANIFEST)} (run --write after reviewing the diff)"
            )

    for entry in expected_manifest["files"]:
        assert isinstance(entry, dict)
        path = REPO_ROOT / str(entry["path"])
        if not path.is_file():
            problems.append(f"missing icon: {relative(path)}")
            continue
        actual = sha256(path)
        if actual != entry["sha256"]:
            problems.append(
                f"stale icon: {relative(path)} (expected {entry['sha256']}, got {actual})"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="verify icons and manifest are current")
    mode.add_argument("--write", action="store_true", help="rewrite icons and manifest")
    args = parser.parse_args()

    source = load_source()
    source_sha = sha256(SOURCE)

    if args.write:
        render(source, REPO_ROOT)
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(
            json.dumps(manifest_for(REPO_ROOT, source_sha), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"wrote NIBI brand icons and {relative(MANIFEST)}")
        return 0

    with tempfile.TemporaryDirectory(prefix="nibi-brand-icons-") as temporary:
        staging_root = Path(temporary)
        render(source, staging_root)
        problems = compare(staging_root, source_sha)
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}", file=sys.stderr)
        print(
            "NIBI brand icons are stale. Run: python packages/desktop/scripts/generate-brand-icons.py --write",
            file=sys.stderr,
        )
        return 1
    print(f"NIBI brand icons OK ({len(png_paths()) + 4} files, source {source_sha[:16]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
