#!/usr/bin/env bash
set -euo pipefail

REPO="gregorydickson/pickle-rick-claude"
RELEASE_GATE_TMPDIR=""
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
PKG_DISPLAY_PATH="extension/package.json"

[ -n "$REPO_ROOT" ] || {
  echo "release-gate: must run inside a git worktree (exit 12)" >&2
  exit 12
}

PKG_PATH="$REPO_ROOT/$PKG_DISPLAY_PATH"

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
  version="$(jq -r '.version' "$PKG_PATH" 2>/dev/null)" || die 11 "could not parse $PKG_DISPLAY_PATH with jq"
  [ -n "$version" ] && [ "$version" != "null" ] || die 11 "$PKG_DISPLAY_PATH missing version"
  printf '%s\n' "$version"
}

read_tag_name_version() {
  local tag="$1"
  local version="${tag#v}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 12 "tag $tag is not a semver release tag"
  printf '%s\n' "$version"
}

read_tag_version() {
  local tag="$1"
  local pkg
  git -C "$REPO_ROOT" rev-parse -q --verify "$tag^{commit}" >/dev/null 2>&1 || die 12 "tag $tag not found"
  pkg="$(git -C "$REPO_ROOT" show "$tag:$PKG_DISPLAY_PATH" 2>/dev/null)" || die 12 "$PKG_DISPLAY_PATH missing at tag $tag"
  local version
  version="$(printf '%s\n' "$pkg" | jq -r '.version' 2>/dev/null)" || die 11 "could not parse $PKG_DISPLAY_PATH at tag $tag with jq"
  [ -n "$version" ] && [ "$version" != "null" ] || die 11 "$PKG_DISPLAY_PATH at tag $tag missing version"
  printf '%s\n' "$version"
}

select_installable_tarball() {
  local dir="$1"
  local tag="$2"
  local -a downloaded=()
  local -a installable=()
  local tarball

  while IFS= read -r tarball; do
    [ -n "$tarball" ] || continue
    downloaded+=("$tarball")
  done < <(find "$dir" -type f -name '*.tar.gz' -print)

  [ ${#downloaded[@]} -gt 0 ] || die 20 "release download produced no tar.gz asset for $tag"

  for tarball in "${downloaded[@]}"; do
    if tar -tzf "$tarball" | awk '
      /(^|\/)extension\/package\.json$/ { has_pkg=1 }
      /(^|\/)install\.sh$/ { has_install=1 }
      END { exit (has_pkg && has_install) ? 0 : 1 }
    '; then
      installable+=("$tarball")
    fi
  done

  [ ${#installable[@]} -gt 0 ] || die 21 "downloaded tarball is missing install payload ($PKG_DISPLAY_PATH + install.sh)"
  [ ${#installable[@]} -eq 1 ] || die 21 "release $tag downloaded multiple installable tar.gz assets"
  printf '%s\n' "${installable[0]}"
}

pre_tag() {
  local tag="$1"
  local expected tag_name_version tagged
  expected="$(read_expected_version)"
  tag_name_version="$(read_tag_name_version "$tag")"
  tagged="$(read_tag_version "$tag")"
  [ "$expected" = "$tag_name_version" ] || die 10 "expected release tag $tag to match $PKG_DISPLAY_PATH version $expected"
  [ "$expected" = "$tagged" ] || die 10 "expected $PKG_DISPLAY_PATH version $expected but tag $tag has $tagged"
  echo "ok: tag $tag has $PKG_DISPLAY_PATH version $expected"
}

post_tag() {
  local tag="$1"
  local expected tag_name_version tmpdir
  expected="$(read_expected_version)"
  tag_name_version="$(read_tag_name_version "$tag")"
  [ "$expected" = "$tag_name_version" ] || die 21 "expected release tag $tag to match $PKG_DISPLAY_PATH version $expected"
  gh api "repos/$REPO/releases/tags/$tag" >/dev/null 2>&1 || die 22 "GitHub release API check failed for $tag"
  tmpdir="$(mktemp -d)"
  RELEASE_GATE_TMPDIR="$tmpdir"
  trap 'rm -rf "$RELEASE_GATE_TMPDIR"' EXIT
  gh release download "$tag" -R "$REPO" -p '*.tar.gz' -D "$tmpdir" >/dev/null 2>&1 || die 20 "release download failed for $tag"

  local tarball pkg_member pkg tagged
  tarball="$(select_installable_tarball "$tmpdir" "$tag")"
  pkg_member="$(tar -tzf "$tarball" | awk '/(^|\/)extension\/package\.json$/ { print; exit }')"
  [ -n "$pkg_member" ] || die 21 "downloaded tarball is missing $PKG_DISPLAY_PATH"
  pkg="$(tar -xOzf "$tarball" "$pkg_member" 2>/dev/null)" || die 21 "could not read $PKG_DISPLAY_PATH from downloaded tarball"
  tagged="$(printf '%s\n' "$pkg" | jq -r '.version' 2>/dev/null)" || die 21 "could not parse $PKG_DISPLAY_PATH from downloaded tarball"
  [ -n "$tagged" ] && [ "$tagged" != "null" ] || die 21 "downloaded tarball $PKG_DISPLAY_PATH missing version"
  [ "$expected" = "$tagged" ] || die 21 "expected downloaded $PKG_DISPLAY_PATH version $expected but found $tagged"
  echo "ok: release $tag tarball has $PKG_DISPLAY_PATH version $expected"
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
