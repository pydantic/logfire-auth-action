# Releasing

This Action is consumed by tag: users write `uses: pydantic/logfire-auth-action@v1`. Releases are git tags plus moving **major** (`v1`) and **minor** (`v1.1`) tags that track the latest matching release, as [GitHub recommends](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/release-and-maintain-actions).

## Dist model

The runner executes the committed bundle in `dist/` — there is no install step at runtime. This repo **commits `dist/` to `main`** and the `check-dist` workflow fails if it drifts from `src/` (the model used by `aws-actions/configure-aws-credentials`). So a release is just a set of tags pointing at a `main` commit whose `dist/` is current.

> GitHub's newer guidance instead keeps `dist/` **out** of `main` and builds it during release (e.g. [`actions/publish-action`](https://github.com/actions/publish-action) or [`JasonEtco/build-and-tag-action`](https://github.com/JasonEtco/build-and-tag-action), which force-push the build onto the version tags). If you'd rather not track `dist/`, switch to that model and drop `check-dist`. We deliberately use the commit-`dist` model for auditability and zero release-time build surprises.

## Versioning

Semantic versioning, `vMAJOR.MINOR.PATCH`:

- **patch** (`v1.0.1`) — bug fix, no interface change.
- **minor** (`v1.1.0`) — new input/output or behavior, backward compatible.
- **major** (`v2.0.0`) — breaking change to inputs/outputs/behavior; cut a new `v2` line and bump the docs' `@vN` references.

The `vN` and `vN.M` tags are aliases that move to the newest matching release, so `@v1` consumers get patches and features automatically without opting into breaking changes. Keep `package.json`'s `version` in lockstep with the tag.

## Pre-flight

From a clean checkout of `main`:

```bash
pnpm install --frozen-lockfile
pnpm run all                       # lint, typecheck, test (100% coverage gate), bundle
git status --porcelain dist        # must be empty — dist is committed and current
```

Bump `package.json` `version` to the release version if it isn't already, commit it, and make sure CI (which includes the `dist/` drift check) is green on the commit you'll tag.

## Cut a release

Bump `version` in `package.json` to the new `X.Y.Z` and commit it (with a current `dist/`). Then run the release script — it derives the tags from `package.json`, creates the immutable `vX.Y.Z` tag, force-moves the `vX` and `vX.Y` aliases, and pushes them:

```bash
pnpm run release             # tag + push
pnpm run release --dry-run   # preview the git commands without running them
```

It pushes to `origin`; override with `RELEASE_REMOTE=<remote>`. The script refuses to run on a dirty tree or if the version tag already exists. Then publish notes:

```bash
gh release create v1.2.3 --generate-notes --title v1.2.3
```

To list it on the GitHub Marketplace, edit the release in the GitHub UI and tick **"Publish this Action to the GitHub Marketplace"** (requires `action.yml` with a unique `name` and a `branding` block — both present).

## First release (`v1.0.0`)

The new repository has no tags yet, so the `@v1` references in the README don't resolve until the first release. `package.json` is already at `1.0.0`, so:

```bash
pnpm run all && [ -z "$(git status --porcelain)" ] || { echo "tree not clean / dist not current"; exit 1; }
pnpm run release
gh release create v1.0.0 --generate-notes --title v1.0.0
```

After this, `uses: pydantic/logfire-auth-action@v1` works.

## Cutting a new major (`v2`)

For a breaking change, bump `version` to `2.0.0`, then `pnpm run release` (it creates `v2.0.0` and moves `v2`/`v2.0`). Preserve the previous major so it can still receive fixes, and update the docs:

```bash
git branch releases/v1 v1        # keep the old major maintainable
git push -u origin releases/v1
# then bump @v1 -> @v2 references in README.md
```

## Checklist

- [ ] `package.json` `version` bumped to match the tag
- [ ] `pnpm run all` green; `dist/` committed and current
- [ ] CI green on the target commit
- [ ] Version tag `vX.Y.Z` pushed
- [ ] Major (`vN`) and minor (`vN.M`) aliases force-moved and pushed
- [ ] GitHub Release published (notes generated)
- [ ] Docs reference the right `@vN`
