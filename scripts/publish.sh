#!/usr/bin/env bash
set -euo pipefail

BRANCH="${PUBLISH_BRANCH:-publish}"
BASE="${PUBLISH_BASE:-main}"
REMOTE="${PUBLISH_REMOTE:-origin}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
CACHE="${NPM_CONFIG_CACHE:-${TMPDIR:-/tmp}/bolt-npm-cache}"
PUSH_BRANCH="${PUBLISH_PUSH_BRANCH:-true}"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/publish.sh
  npm run publish:package

Environment:
  PUBLISH_BRANCH      Branch reset from main before publish. Default: publish
  PUBLISH_BASE        Base branch to publish from. Default: main
  PUBLISH_REMOTE      Remote used for fetch/pull/push. Default: origin
  PUBLISH_PUSH_BRANCH Push the reset publish branch. Default: true
  NPM_REGISTRY        Registry URL. Default: https://registry.npmjs.org/
  NPM_CONFIG_CACHE    npm cache directory. Default: $TMPDIR/bolt-npm-cache
  NPM_CONFIG_USERCONFIG Optional npmrc path for token-based publishing.

Update the package version on main before running this for a new release.
The script blocks tracked or staged local changes before resetting branches.
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

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked changes are present. Commit or stash before resetting ${BRANCH} from ${BASE}." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

git fetch "${REMOTE}" "${BASE}"
git switch "${BASE}"
git pull --ff-only "${REMOTE}" "${BASE}"
git switch -C "${BRANCH}" "${BASE}"

if [[ "${PUSH_BRANCH}" != "false" ]]; then
  git push --force-with-lease "${REMOTE}" "${BRANCH}"
fi

npm --cache "${CACHE}" whoami --registry "${REGISTRY}" >/dev/null
npm --cache "${CACHE}" pack --dry-run
npm --cache "${CACHE}" publish --access public --registry "${REGISTRY}"
