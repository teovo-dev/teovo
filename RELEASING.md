# Releasing to npm

The four packages (`@teovo/server`, `@teovo/react`, `@teovo/db`, `teovo`) always share one version number and are
published together by `.github/workflows/publish.yml` when a version tag is pushed.

## Once: npm setup (an owner of the project)

1. An npm account with two-factor authentication on.
2. An npm organization named **teovo** (free for public packages), so the `@teovo/…` names are ours.
3. An npm **automation** access token for that account, saved in GitHub as the repository secret `NPM_TOKEN`
   (Settings → Secrets and variables → Actions).

## Each release

1. On a branch: set the new version in all four `packages/*/package.json`, and the `@teovo/…` dependencies between
   them (`^0.2.0`), then `npm install` so the lock file follows. Open a pull request; merge it when CI passes.
2. Check what will be published, from the repository root (nothing is sent):

   ```bash
   npm run build && npm pack --dry-run -w packages/server -w packages/db -w packages/react -w packages/cli
   ```

3. Tag the merged commit on `main` and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow checks that the tag matches every package's version, runs the type-check and all tests, and publishes
the packages in order (server, db, react, cli), with provenance.

## What each package ships

`dist/` (the built code), `src/` without tests (so source maps and "go to definition" work), its README, and the
repository's LICENSE (copied in by `scripts/prepack.mjs`).
