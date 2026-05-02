#!/usr/bin/env bash
set -euo pipefail

REPO="gregorydickson/pickle-rick-claude"
PKG_PATH="extension/package.json"
RELEASE_GATE_TMPDIR=""

usage() {
  cat >&2 <<'USAGE'
usage: bin/release-gate.sh --pre-tag <tag>
       bin/release-gate.sh --post-tag <tag>

exit codes:
  10 pre-tag package version mismatch
  11 jq parse failed
  12 tag or tagged package missing
  20 release download failed
  21 downloaded tarball package version mismatch
  22 GitHub release API error
USAGE
}

die() {
  local code="$1"
  shift
  echo "release-gate: $* (exit $code)" >&2
  exit "$code"
}

read_expected_version() {
  local version
  version="$(jq -r '.version' "$PKG_PATH" 2>/dev/null)" || die 11 "could not parse $PKG_PATH with jq"
  [ -n "$version" ] && [ "$version" != "null" ] || die 11 "$PKG_PATH missing version"
  printf '%s\n' "$version"
}

read_tag_version() {
  local tag="$1"
  local pkg
  git rev-parse -q --verify "$tag^{commit}" >/dev/null 2>&1 || die 12 "tag $tag not found"
  pkg="$(git show "$tag:$PKG_PATH" 2>/dev/null)" || die 12 "$PKG_PATH missing at tag $tag"
  local version
  version="$(printf '%s\n' "$pkg" | jq -r '.version' 2>/dev/null)" || die 11 "could not parse $PKG_PATH at tag $tag with jq"
  [ -n "$version" ] && [ "$version" != "null" ] || die 11 "$PKG_PATH at tag $tag missing version"
  printf '%s\n' "$version"
}

pre_tag() {
  local tag="$1"
  local expected tagged
  expected="$(read_expected_version)"
  tagged="$(read_tag_version "$tag")"
  [ "$expected" = "$tagged" ] || die 10 "expected $PKG_PATH version $expected but tag $tag has $tagged"
  echo "ok: tag $tag has $PKG_PATH version $expected"
}

post_tag() {
  local tag="$1"
  local expected tmpdir
  expected="$(read_expected_version)"
  gh api "repos/$REPO/releases/tags/$tag" >/dev/null 2>&1 || die 22 "GitHub release API check failed for $tag"
  tmpdir="$(mktemp -d)"
  RELEASE_GATE_TMPDIR="$tmpdir"
  trap 'rm -rf "$RELEASE_GATE_TMPDIR"' EXIT
  gh release download "$tag" -R "$REPO" -A 'tar.gz' -D "$tmpdir" >/dev/null 2>&1 || die 20 "release download failed for $tag"

  local tarball pkg_member pkg tagged
  tarball="$(find "$tmpdir" -type f -name '*.tar.gz' -print -quit)"
  [ -n "$tarball" ] || die 20 "release download produced no tar.gz asset for $tag"
  pkg_member="$(tar -tzf "$tarball" | awk '/(^|\/)extension\/package\.json$/ { print; exit }')"
  [ -n "$pkg_member" ] || die 21 "downloaded tarball is missing $PKG_PATH"
  pkg="$(tar -xOzf "$tarball" "$pkg_member" 2>/dev/null)" || die 21 "could not read $PKG_PATH from downloaded tarball"
  tagged="$(printf '%s\n' "$pkg" | jq -r '.version' 2>/dev/null)" || die 21 "could not parse $PKG_PATH from downloaded tarball"
  [ -n "$tagged" ] && [ "$tagged" != "null" ] || die 21 "downloaded tarball $PKG_PATH missing version"
  [ "$expected" = "$tagged" ] || die 21 "expected downloaded $PKG_PATH version $expected but found $tagged"
  echo "ok: release $tag tarball has $PKG_PATH version $expected"
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

case "$1" in
  --pre-tag) pre_tag "$2" ;;
  --post-tag) post_tag "$2" ;;
  *) usage; exit 2 ;;
esac
