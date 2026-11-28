# Releasing to npm

The four packages (`@teovo/server`, `@teovo/react`, `@teovo/db`, `teovo`) always share one version number. They are
published from GitHub Actions (`.github/workflows/publish.yml`) through npm **trusted publishing**: npm trusts that
workflow directly, so there is no npm token anywhere. Each release is **staged**: it reaches npm but stays hidden until
a maintainer approves it with two-factor authentication.

## Once

1. The npm organization **teovo** (exists; owner: the project's npm account, with 2FA on).
2. **The first version, by hand** (npm sets up trusted publishing on a package that already exists). From the
   repository root, signed in with `npm login`:

   ```bash
   npm run build && npm publish -w packages/server -w packages/db -w packages/react -w packages/cli --otp=<code from your authenticator>
   ```

3. **Trusted publishing, for each of the four packages** on npmjs.com → the package → Settings → Trusted publishing →
   GitHub Actions: organization `teovo-dev`, repository `teovo`, workflow `publish.yml`, no environment, allowed
   action: stage publish. Then Settings → Publishing access → "Require two-factor authentication and disallow tokens".
   A new trusted publisher must be used for a publish within 2 days, or it expires and has to be made again.

## Each release

1. On a branch: set the new version in all four `packages/*/package.json`, and the `@teovo/…` dependencies between
   them (`^0.2.0`), then `npm install` so the lock file follows. Open a pull request; merge it when CI passes.
2. Check what will be published (nothing is sent):

   ```bash
   npm run build && npm pack --dry-run -w packages/server -w packages/db -w packages/react -w packages/cli
   ```

3. Tag the merged commit on `main` and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

   The workflow checks the tag matches every package's version, runs the type-check and all tests, and stages the
   packages in order (server, db, react, cli), with provenance.
4. Approve each staged package on npmjs.com (Staged Packages) or with `npm stage approve`, using your 2FA code.

## What each package ships

`dist/` (the built code), `src/` without tests (so source maps and "go to definition" work), its README, and the
repository's LICENSE (copied in by `scripts/prepack.mjs`).
