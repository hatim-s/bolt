# Contributing to Bolt

Notes for developing, building, and releasing `@hatimcodes/bolt`. If you just
want to *use* Bolt, see the [README](./README.md).

## Development

```sh
bun install
bun run dev        # playground; open /stresstest for the Zustand comparison
```

## Build

```sh
npm run build:lib   # writes ESM, CJS, and .d.ts to dist/
```

## Release (maintainers)

```sh
npm login
npm run publish:package
```

Update the package version on `main` first. The release script resets
`publish` from `main`, pushes that branch to `origin`, checks npm auth, verifies
the tarball, and publishes `@hatimcodes/bolt` publicly.

If you publish with an npm access token instead of an interactive login, create
a temporary npm config and pass it to the same wrapper:

```sh
printf "npm token: "
read -rs NPM_TOKEN
printf "\n"
export NPM_TOKEN

cat > /tmp/bolt-npmrc <<'EOF'
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
EOF

NPM_CONFIG_USERCONFIG=/tmp/bolt-npmrc npm run publish:package

rm /tmp/bolt-npmrc
unset NPM_TOKEN
```

Useful variants:

```sh
npm run publish:dry           # npm publish --dry-run, no branch dance
./scripts/publish.sh --help   # branch, remote, registry, and cache overrides
```
