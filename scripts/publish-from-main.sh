#!/usr/bin/env bash
set -euo pipefail

BRANCH="${PUBLISH_BRANCH:-publish-npm}"
BASE="${PUBLISH_BASE:-main}"
REMOTE="${PUBLISH_REMOTE:-origin}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
CACHE="${NPM_CONFIG_CACHE:-${TMPDIR:-/tmp}/bolt-npm-cache}"

usage() {
  cat <<'USAGE'
Usage:
  npm run publish:from-main

Environment:
  PUBLISH_BRANCH   Branch to reset and publish from. Default: publish-npm
  PUBLISH_BASE     Base branch to reset from. Default: main
  PUBLISH_REMOTE   Remote used to refresh the base branch. Default: origin
  NPM_REGISTRY     Registry URL. Default: https://registry.npmjs.org/
  NPM_CONFIG_CACHE npm cache directory. Default: $TMPDIR/bolt-npm-cache

The working tree must be clean because this script resets the publish branch.
Update the package version on main before running this for a new release.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "Unexpected argument: $1" >&2
  usage >&2
  exit 1
fi

if [[ "${BRANCH}" == "${BASE}" ]]; then
  echo "Refusing to use the same branch for publish and base: ${BRANCH}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash changes before resetting ${BRANCH} from ${BASE}." >&2
  git status --short >&2
  exit 1
fi

git fetch "${REMOTE}" "${BASE}"
git switch "${BASE}"
git pull --ff-only "${REMOTE}" "${BASE}"
git switch -C "${BRANCH}" "${BASE}"

npm --cache "${CACHE}" whoami --registry "${REGISTRY}" >/dev/null
npm --cache "${CACHE}" pack --dry-run
npm --cache "${CACHE}" publish --access public --registry "${REGISTRY}"
