#!/usr/bin/env bash
# Create one GitHub release per published package.
#
# The workflow used to delegate this to changesets/action v1, which hardcodes the
# release name to the tag name (titling releases "@hank-warren/pi-stats@0.3.1")
# and skips the release entirely when a package has no CHANGELOG.md (that is how
# @hank-warren/pi-herdr-auto-title@0.1.0 reached npm and got a tag but never got
# a release). So this script creates the releases instead; the action itself has
# since been dropped for a single-run version+publish in publish.yml.
#
# Reads the publish step's parsed output: a JSON array of
# [{"name": "@scope/pkg", "version": "1.2.3"}, ...]. That list is everything the
# run confirmed is on npm at this version — the packages it published (parsed
# from "New tag:" lines) plus any npm rejected as already published, which need
# a release only in the rare case nothing tagged them earlier.
#
# Tag stays fully scoped (@hank-warren/pi-stats@0.3.1) to match what
# `changeset publish` created. Only the title drops the scope.
#
# This script also PUSHES the tag, and must keep doing so: `changeset publish`
# only creates the tag locally on the ephemeral runner. When changesets/action
# ran with createGithubReleases: false, its tag push was silently disabled too
# (in v1 the push lives inside the `if (createGithubReleases)` branch,
# src/run.ts:120-125), which is exactly how @hank-warren/pi-stats@0.3.2 reached
# npm with no tag and no release. Nothing else pushes tags now either.
set -euo pipefail

published_packages=${1:-}

if [[ -z "$published_packages" || "$published_packages" == "[]" ]]; then
  echo "No published packages; nothing to release."
  exit 0
fi

# Extract the section for one version out of a changesets-generated CHANGELOG.md.
# Those files are "## <version>" per release under a leading "# <package>" title,
# so the section runs until the next "## " heading. Prints nothing when the
# version is absent, which the caller treats as "use the fallback body".
changelog_section() {
  local file=$1 version=$2
  [[ -f "$file" ]] || return 0
  awk -v want="$version" '
    /^## / {
      # Strip the marker and any surrounding whitespace to compare versions.
      heading = substr($0, 4)
      gsub(/^[ \t]+|[ \t]+$/, "", heading)
      in_section = (heading == want)
      next
    }
    in_section { print }
  ' "$file"
}

count=$(echo "$published_packages" | jq 'length')
echo "Creating releases for $count published package(s)."

for i in $(seq 0 $((count - 1))); do
  name=$(echo "$published_packages" | jq -r ".[$i].name")
  version=$(echo "$published_packages" | jq -r ".[$i].version")

  tag="${name}@${version}"
  # Strip any leading @scope/ generically rather than hardcoding @hank-warren/.
  unscoped=${name##*/}
  title="${unscoped}@${version}"

  # @hank-warren/pi-stats -> packages/pi-stats/CHANGELOG.md
  changelog="packages/${unscoped}/CHANGELOG.md"
  body=$(changelog_section "$changelog" "$version")

  if [[ -z "${body//[$' \t\n\r']/}" ]]; then
    # No CHANGELOG.md, or no section for this version. Never fail the run over
    # this: a brand-new package legitimately publishes 0.1.0 without a changeset.
    body="${name}@${version} published to npm.

https://www.npmjs.com/package/${name}/v/${version}"
    echo "  ${tag} -> ${title} (generated body)"
  else
    echo "  ${tag} -> ${title} (changelog body)"
  fi

  prerelease_flag=()
  if [[ "$version" == *-* ]]; then
    prerelease_flag=(--prerelease)
  fi

  # Decide how this tag reaches the remote before touching releases.
  #   already-on-remote  a re-run, or someone pushed it by hand; nothing to do
  #   push-local         the normal path: changeset publish tagged this checkout
  #   create-via-target  no tag anywhere (for example workflow_dispatch on a
  #                      fresh checkout that published nothing new), so let the
  #                      release API create the tag at the commit being built
  if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
    tag_action=already-on-remote
  elif git rev-parse -q --verify "refs/tags/${tag}" >/dev/null 2>&1; then
    tag_action=push-local
  else
    tag_action=create-via-target
  fi
  echo "    tag: ${tag_action}"

  # gh rejects an abbreviated sha here with "Release.target_commitish is invalid",
  # so this must be the full 40-character GITHUB_SHA.
  target_flag=()
  if [[ "$tag_action" == "create-via-target" ]]; then
    if [[ -z "${GITHUB_SHA:-}" ]]; then
      echo "    cannot create tag ${tag}: GITHUB_SHA is unset" >&2
      exit 1
    fi
    target_flag=(--target "$GITHUB_SHA")
  fi

  if [[ -n "${DRY_RUN:-}" ]]; then
    continue
  fi

  if [[ "$tag_action" == "push-local" ]]; then
    git push origin "refs/tags/${tag}"
  fi

  # Idempotent: workflow_dispatch re-runs must not go red on an existing release.
  if gh release view "$tag" >/dev/null 2>&1; then
    echo "    release exists; updating title and body"
    gh release edit "$tag" --title "$title" --notes "$body"
  else
    gh release create "$tag" --title "$title" --notes "$body" "${prerelease_flag[@]}" "${target_flag[@]}"
  fi
done
