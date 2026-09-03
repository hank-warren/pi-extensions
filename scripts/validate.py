#!/usr/bin/env python3
"""Validate the package structure without third-party dependencies."""

from __future__ import annotations

import json
import re
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPECTED_EXTENSION_ENTRYPOINTS = [
    "./packages/pi-statusline/index.ts",
    "./packages/pi-stats/index.ts",
    "./packages/pi-auto-permissions/index.ts",
    "./packages/pi-plan-mode/index.ts",
    "./packages/pi-ask-user-question/index.ts",
    "./packages/pi-multi-login/index.ts",
    "./packages/pi-loop/index.ts",
    "./packages/pi-stash/index.ts",
]
# Public resources must live in inventoried packages: a top-level extensions/
# or skills/ directory would bypass package validation and ship through the
# aggregate repository install. Skill and hybrid *packages* are different:
# their skills live under packages/<name>/ and are published individually, so
# they are exempt from this guard (it only ever looks at ROOT/).
FORBIDDEN_DIRS = ("extensions", "skills")
# Pure-library packages: published for sibling packages to import (plain
# `dependencies`, deep file imports), but loading nothing as an extension.
# They must have no `pi` manifest and no index.ts entrypoint.
LIBRARY_PACKAGES = {"packages/pi-permission-selector"}
# Skill-only packages: no code, no entrypoint, no dependencies of any kind.
# Their `pi` manifest exposes only `skills`, each entry is a directory holding
# a SKILL.md whose frontmatter name matches the directory name, and the root
# manifest must re-export every skill path so the aggregate git install loads
# them.
SKILL_PACKAGES = {"packages/pi-simplify"}
# Hybrid packages: an extension *and* the skills that document how to drive it.
# They version together on purpose — a skill describing an engine the installed
# extension does not have is a coupling failure waiting to happen. Their `pi`
# manifest exposes both keys, and their skills re-export from the root manifest
# exactly like a skill package's.
HYBRID_PACKAGES = {
    "packages/pi-auto-permissions",
    "packages/pi-loop",
    "packages/pi-plan-mode",
}
PUBLIC_PACKAGES = {
    "packages/pi-statusline": "@hank-warren/pi-statusline",
    "packages/pi-stats": "@hank-warren/pi-stats",
    "packages/pi-permission-selector": "@hank-warren/pi-permission-selector",
    "packages/pi-auto-permissions": "@hank-warren/pi-auto-permissions",
    "packages/pi-plan-mode": "@hank-warren/pi-plan-mode",
    "packages/pi-ask-user-question": "@hank-warren/pi-ask-user-question",
    "packages/pi-simplify": "@hank-warren/pi-simplify",
    "packages/pi-multi-login": "@hank-warren/pi-multi-login",
    "packages/pi-loop": "@hank-warren/pi-loop",
    "packages/pi-stash": "@hank-warren/pi-stash",
}
# Sources deliberately duplicated byte-for-byte instead of shared through a
# package dependency, because sharing them would cost far more than copying
# them. Empty since pi-herdr-auto-title was removed: `guardian-transport.ts`
# now has exactly one home in pi-auto-permissions. Add a pair here rather than
# reaching for a relative import into a sibling package, and keep every
# package-specific detail behind a parameter so the copies can stay identical.
DUPLICATED_SOURCES: list[tuple[str, str]] = []
# Pi's own floor, so a package that advertises less is advertising a lie: a host
# on Node 20 installs it and the extension fails to load. Every extension and
# library package carries this exact string, plus the copy-to-create template.
# Skill-only packages ship no code and declare no engines at all.
REQUIRED_NODE_ENGINE = ">=22.19.0"
TEMPLATE_PACKAGE = "docs/template-package"
# Test helpers shared across packages live here, and a package test file may
# climb out to reach them. Nothing else may: see the cross-package import check.
SHARED_TEST_SUPPORT = "test/support"
ALLOWED_PEERS = {
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
}
# Written into every package by `changeset version`, so it may be listed in a
# files allowlist before it exists on disk.
GENERATED_FILE_ENTRY = "CHANGELOG.md"
# Directories under a package that never ship, so their .ts files are exempt from
# the files-allowlist check.
IGNORED_SOURCE_DIRS = {"test", "tests", "node_modules"}
IMPORT_RE = re.compile(r"""(?:from|import)\s*\(?\s*["']([^"']+)["']""")
LINK_RE = re.compile(r"!?\[[^]]*]\(([^)]+)\)")
FRONTMATTER_NAME_RE = re.compile(r"^name:\s*(\S+)\s*$", re.MULTILINE)
FORBIDDEN_TEXT = {
    "${CLAUDE_PLUGIN_ROOT}": "unresolved Claude plugin root",
    "$CLAUDE_PLUGIN_ROOT": "unresolved Claude plugin root",
    "mcp__": "excluded MCP tool dependency",
}
FORBIDDEN_PARTS = {"__pycache__", ".claude-plugin", ".mcp.json"}
FORBIDDEN_SUFFIXES = {".pyc", ".pyo"}


def skill_frontmatter_name(skill_md: Path) -> str | None:
    """Return the `name:` value from SKILL.md YAML frontmatter, or None."""
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end == -1:
        return None
    match = FRONTMATTER_NAME_RE.search(text[4:end])
    return match.group(1) if match else None


def validate_skill_entries(
    rel_dir: str, pkg_dir: Path, skills: list[str], errors: list[str]
) -> list[str]:
    """Validate every declared skill entry; return its root-manifest entrypoints.

    Each entry is a directory holding a SKILL.md whose frontmatter name matches
    the directory name. Shared by skill-only and hybrid packages.
    """
    entrypoints: list[str] = []
    for entry in skills:
        skill_dir = pkg_dir / entry
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            errors.append(f"{rel_dir}: skill entry has no SKILL.md: {entry}")
            continue
        name = skill_frontmatter_name(skill_md)
        if name != skill_dir.name:
            errors.append(
                f"{rel_dir}: {entry}/SKILL.md frontmatter name {name!r}"
                f" must match directory name {skill_dir.name!r}"
            )
        # Path() already normalizes a leading "./" and a trailing slash away.
        entrypoints.append(f"./{rel_dir}/{Path(entry).as_posix()}")
    return entrypoints


def validate_skill_package(rel_dir: str, pkg_dir: Path, pkg: dict, errors: list[str]) -> list[str]:
    """Validate a skill-only package; return its root-manifest skill entrypoints."""
    pi = pkg.get("pi", {})
    if set(pi) != {"skills"}:
        errors.append(f"{rel_dir}: skill package pi manifest must expose only skills")
    skills = pi.get("skills", [])
    if not skills:
        errors.append(f"{rel_dir}: skill package must declare at least one skill")
    entrypoints = validate_skill_entries(rel_dir, pkg_dir, skills, errors)
    if (pkg_dir / "index.ts").exists():
        errors.append(f"{rel_dir}: skill package must not have an index.ts entrypoint")
    for source in pkg_dir.rglob("*.ts"):
        if not set(source.relative_to(pkg_dir).parts) & IGNORED_SOURCE_DIRS:
            errors.append(f"{rel_dir}: skill package must not contain TypeScript sources")
            break
    for dep_key in ("dependencies", "peerDependencies", "devDependencies"):
        if pkg.get(dep_key):
            errors.append(f"{rel_dir}: skill package must have no {dep_key}")
    if "pi-skill" not in pkg.get("keywords", []):
        errors.append(f"{rel_dir}: keywords must include pi-skill")
    return entrypoints


def validate_links(path: Path, errors: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]*`", "", text)
    for raw_target in LINK_RE.findall(text):
        target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
        if not target or target.startswith(("#", "http://", "https://", "mailto:")):
            continue
        target = target.split("#", 1)[0]
        resolved = (path.parent / target).resolve()
        if not resolved.is_relative_to(ROOT) or not resolved.exists():
            errors.append(f"{path.relative_to(ROOT)}: broken relative link: {raw_target}")


def main() -> int:
    errors: list[str] = []
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if manifest.get("private") is not True:
        errors.append("package.json: package must remain private")
    pi_manifest = manifest.get("pi", {})
    if pi_manifest.get("extensions") != EXPECTED_EXTENSION_ENTRYPOINTS:
        errors.append("package.json: pi.extensions must expose all expected entrypoints")
    if set(pi_manifest) != {"extensions", "skills"}:
        errors.append("package.json: pi manifest may expose only extensions and skills")
    for name in FORBIDDEN_DIRS:
        if (ROOT / name).exists():
            errors.append(f"{name}/: top-level resources must live in an inventoried package")
    if manifest.get("workspaces") != ["packages/*"]:
        errors.append("package.json: workspaces must be ['packages/*']")

    package_dirs = sorted(
        str(path.relative_to(ROOT)) for path in (ROOT / "packages").iterdir() if path.is_dir()
    )
    if package_dirs != sorted(PUBLIC_PACKAGES):
        errors.append(f"packages/: expected {sorted(PUBLIC_PACKAGES)}, found {package_dirs}")
    expected_skill_entrypoints: list[str] = []
    for rel_dir, expected_name in PUBLIC_PACKAGES.items():
        pkg_dir = ROOT / rel_dir
        pkg_json = pkg_dir / "package.json"
        if not pkg_json.is_file():
            errors.append(f"{rel_dir}: missing package.json")
            continue
        pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
        if pkg.get("name") != expected_name:
            errors.append(f"{rel_dir}: package name must be {expected_name!r}")
        if pkg.get("private") is True:
            errors.append(f"{rel_dir}: public package must not be private")
        if pkg.get("license") != "MIT":
            errors.append(f"{rel_dir}: public package must be MIT licensed")
        if not (pkg_dir / "LICENSE").is_file():
            errors.append(f"{rel_dir}: missing LICENSE file")
        if not (pkg_dir / "README.md").is_file():
            errors.append(f"{rel_dir}: missing README.md")
        if "pi-package" not in pkg.get("keywords", []):
            errors.append(f"{rel_dir}: keywords must include pi-package")
        if rel_dir in LIBRARY_PACKAGES:
            if "pi" in pkg:
                errors.append(f"{rel_dir}: library package must not have a pi manifest")
            if (pkg_dir / "index.ts").exists():
                errors.append(f"{rel_dir}: library package must not have an index.ts entrypoint")
        elif rel_dir in SKILL_PACKAGES:
            expected_skill_entrypoints.extend(
                validate_skill_package(rel_dir, pkg_dir, pkg, errors)
            )
        elif rel_dir in HYBRID_PACKAGES:
            pi = pkg.get("pi", {})
            if set(pi) != {"extensions", "skills"}:
                errors.append(f"{rel_dir}: hybrid pi manifest must expose extensions and skills")
            if pi.get("extensions") != ["./index.ts"]:
                errors.append(f"{rel_dir}: pi.extensions must be ['./index.ts']")
            if not pi.get("skills"):
                errors.append(f"{rel_dir}: hybrid package must declare at least one skill")
            expected_skill_entrypoints.extend(
                validate_skill_entries(rel_dir, pkg_dir, pi.get("skills", []), errors)
            )
        elif pkg.get("pi", {}).get("extensions") != ["./index.ts"]:
            errors.append(f"{rel_dir}: pi.extensions must be ['./index.ts']")
        if pkg.get("repository", {}).get("directory") != rel_dir:
            errors.append(f"{rel_dir}: repository.directory must be {rel_dir!r}")
        if rel_dir in SKILL_PACKAGES:
            # A skill package ships no code, so an engines range would be a claim
            # about a runtime it never reaches. AGENTS.md states the rule; this
            # keeps the statement from drifting away from the tree.
            if pkg.get("engines"):
                errors.append(f"{rel_dir}: skill-only packages declare no engines")
        else:
            engine = pkg.get("engines", {}).get("node")
            if engine != REQUIRED_NODE_ENGINE:
                errors.append(
                    f"{rel_dir}: engines.node must be {REQUIRED_NODE_ENGINE!r}, found {engine!r}"
                )
            peers = set(pkg.get("peerDependencies", {}))
            if not peers or not peers <= ALLOWED_PEERS:
                errors.append(f"{rel_dir}: peerDependencies must be a non-empty subset of {sorted(ALLOWED_PEERS)}")
            if any(pkg.get("peerDependencies", {}).get(peer) != "*" for peer in peers):
                errors.append(f"{rel_dir}: peerDependencies must use '*' ranges")
            # A declared peer that nothing imports is a stale claim about what the
            # package needs at runtime, and consumers pay for it in install
            # resolution. Compare against the sources that actually ship: tests are
            # excluded by IGNORED_SOURCE_DIRS because they never reach a consumer.
            imported = {
                peer
                for source in pkg_dir.rglob("*.ts")
                if not set(source.relative_to(pkg_dir).parts) & IGNORED_SOURCE_DIRS
                for specifier in IMPORT_RE.findall(source.read_text(encoding="utf-8"))
                for peer in ALLOWED_PEERS
                if specifier == peer or specifier.startswith(f"{peer}/")
            }
            for stale in sorted(peers - imported):
                errors.append(f"{rel_dir}: peerDependency is never imported: {stale}")
            for undeclared in sorted(imported - peers):
                errors.append(f"{rel_dir}: imported Pi package missing from peerDependencies: {undeclared}")
        files = pkg.get("files", [])
        if not files:
            errors.append(f"{rel_dir}: files allowlist is required")
        for entry in files:
            # CHANGELOG.md is generated by `changeset version` during the publish
            # run, so a package that has not been released through changesets yet
            # legitimately lists it before the file exists.
            if entry == GENERATED_FILE_ENTRY:
                continue
            if not (pkg_dir / entry).exists():
                errors.append(f"{rel_dir}: files entry does not exist: {entry}")
        if any(entry.startswith("test") for entry in files):
            errors.append(f"{rel_dir}: files must not include tests")
        if GENERATED_FILE_ENTRY not in files:
            errors.append(f"{rel_dir}: files allowlist must include {GENERATED_FILE_ENTRY}")
        # Nested sources (tool/, view/, src/) ship only when the allowlist covers
        # them, either by exact path or by an ancestor directory entry. A
        # top-level-only check silently dropped them from the tarball.
        entries = [entry.rstrip("/") for entry in files]
        for source in sorted(pkg_dir.rglob("*.ts")):
            rel_source = source.relative_to(pkg_dir)
            if set(rel_source.parts) & IGNORED_SOURCE_DIRS:
                continue
            name = rel_source.as_posix()
            if not any(name == entry or name.startswith(f"{entry}/") for entry in entries):
                errors.append(f"{rel_dir}: source file missing from files allowlist: {name}")
        if rel_dir in SKILL_PACKAGES | HYBRID_PACKAGES:
            for entry in pkg.get("pi", {}).get("skills", []):
                skill_rel = Path(entry).as_posix()
                if not any(
                    skill_rel == allowed or skill_rel.startswith(f"{allowed}/")
                    for allowed in entries
                ):
                    errors.append(f"{rel_dir}: skill missing from files allowlist: {entry}")

    # The root manifest must re-export exactly the skills declared by skill and
    # hybrid packages, so a new skill cannot ship without loading through the
    # aggregate git install (and vice versa).
    if sorted(pi_manifest.get("skills", [])) != sorted(expected_skill_entrypoints):
        errors.append(
            "package.json: pi.skills must exactly re-export every skill-package skill"
            f" (expected {sorted(expected_skill_entrypoints)})"
        )

    # The template is copied to create a package, so an engines value that drifts
    # from the required one is reproduced into every package made from it.
    template_json = ROOT / TEMPLATE_PACKAGE / "package.json"
    if template_json.is_file():
        template_engine = json.loads(template_json.read_text(encoding="utf-8")).get(
            "engines", {}
        ).get("node")
        if template_engine != REQUIRED_NODE_ENGINE:
            errors.append(
                f"{TEMPLATE_PACKAGE}: engines.node must be {REQUIRED_NODE_ENGINE!r},"
                f" found {template_engine!r}"
            )
    else:
        errors.append(f"{TEMPLATE_PACKAGE}: missing package.json")

    # `npm ci` (the first step of every workflow, including publish) fails outright
    # on a workspace member that is missing from the lockfile, which used to break
    # a release rather than a pull request. npm records each member twice: the
    # workspace directory and a link entry under node_modules/<name>. The link is
    # the one `npm ci` resolves, so that is what this checks.
    lock_path = ROOT / "package-lock.json"
    if not lock_path.is_file():
        errors.append("package-lock.json: missing (run npm install --package-lock-only)")
    else:
        lock_packages = json.loads(lock_path.read_text(encoding="utf-8")).get("packages", {})
        for rel_dir, expected_name in PUBLIC_PACKAGES.items():
            if f"node_modules/{expected_name}" not in lock_packages:
                errors.append(
                    f"package-lock.json: workspace member missing from the lockfile:"
                    f" {expected_name} ({rel_dir}) — run npm install --package-lock-only"
                )

    # Public packages are self-contained: a relative import that climbs out of a
    # package reaches into a sibling's *sources*, which npm never ships, so it
    # works in this workspace and fails for every consumer. Depending on a
    # sibling's published package is the supported form and is unaffected here,
    # because that is a bare specifier, not a relative path. Tests are included
    # deliberately: a test reaching into a sibling is the same coupling, and it
    # is how the first one usually appears. The one exception is the shared test
    # harness in ROOT/test/support/, which exists precisely so packages stop
    # re-implementing it; it never ships, so no consumer can be broken by it.
    shared_test_support = (ROOT / SHARED_TEST_SUPPORT).resolve()
    for pkg_dir in sorted((ROOT / "packages").iterdir()):
        if not pkg_dir.is_dir():
            continue
        for source in sorted(pkg_dir.rglob("*.ts")):
            if "node_modules" in source.relative_to(pkg_dir).parts:
                continue
            for specifier in IMPORT_RE.findall(source.read_text(encoding="utf-8")):
                if not specifier.startswith("."):
                    continue
                resolved = (source.parent / specifier).resolve()
                if resolved.is_relative_to(pkg_dir.resolve()):
                    continue
                if resolved.is_relative_to(shared_test_support) and "test" in source.relative_to(
                    pkg_dir
                ).parts:
                    continue
                errors.append(
                    f"{source.relative_to(ROOT)}: cross-package source import: {specifier}"
                    " (depend on the sibling's published package, or duplicate the helper)"
                )

    # The carve-out above is one-way. Without this, `test/support/x.ts` could
    # re-export a package's sources and any package test could import it from
    # there — the coupling the cross-package rule exists to catch, laundered
    # through the shared harness. The harness composes Pi's own API and nothing
    # else; a package-specific helper belongs in that package's own test/support/.
    for source in sorted(shared_test_support.rglob("*.ts")):
        for specifier in IMPORT_RE.findall(source.read_text(encoding="utf-8")):
            if not specifier.startswith("."):
                continue
            if (source.parent / specifier).resolve().is_relative_to(ROOT / "packages"):
                errors.append(
                    f"{source.relative_to(ROOT)}: shared test support may not import"
                    f" package sources: {specifier}"
                )

    for source, copy in DUPLICATED_SOURCES:
        source_path, copy_path = ROOT / source, ROOT / copy
        if not source_path.is_file() or not copy_path.is_file():
            errors.append(f"{source} / {copy}: duplicated source is missing")
        elif source_path.read_bytes() != copy_path.read_bytes():
            errors.append(
                f"{copy} has drifted from {source}; these files are duplicated"
                " deliberately and must stay byte-identical (copy one over the other)"
            )

    for path in ROOT.rglob("*"):
        if ".git" in path.parts or "node_modules" in path.parts:
            continue
        rel_path = path.relative_to(ROOT)
        if path.is_symlink():
            errors.append(f"{rel_path}: symlinks are not allowed in the package")
        if any(part in FORBIDDEN_PARTS for part in rel_path.parts):
            errors.append(f"{rel_path}: excluded path")
        if path.suffix in FORBIDDEN_SUFFIXES:
            errors.append(f"{rel_path}: generated Python artifact")
        if not path.is_file():
            continue
        if path.suffix == ".md":
            validate_links(path, errors)
        if path.suffix in {".md", ".sh", ".py", ".json", ".ts"} and path != Path(__file__).resolve():
            text = path.read_text(encoding="utf-8")
            for needle, message in FORBIDDEN_TEXT.items():
                if needle in text:
                    errors.append(f"{rel_path}: {message} ({needle})")
        if path.read_bytes().startswith(b"#!") and path.suffix != ".py":
            if not path.stat().st_mode & stat.S_IXUSR:
                errors.append(f"{rel_path}: shebang script is not executable")

    if errors:
        print("Validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Structure: ok ({len(PUBLIC_PACKAGES)} public packages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
