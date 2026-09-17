# Releasing

A release is nine npm packages and one Python package, all at the same version,
cut from one tag.

## Before the first one

Two things have to exist, and neither can be created from this repository:

- **The `@editorial-ir` npm scope**, and an automation token for it stored as the
  `NPM_TOKEN` repository secret. A granular token scoped to that one org is
  enough; it needs write access and nothing else.
- **A PyPI trusted publisher** for `editorial-perception`, pointing at this
  repository, the `Release` workflow and the `pypi` job. Trusted publishing means
  there is no PyPI password stored anywhere — PyPI verifies the workflow itself.

Until both exist the `Release` workflow will fail at the publish step, which is
the correct failure: nothing is half-published, because the packages are pushed
in dependency order and the first one stops the run.

## Cutting one

1. Decide the version. Everything moves together, including the Python worker
   and the four contract versions in `packages/contracts/src/version.ts`. A
   changed wire format is a minor bump at 0.x and a major one after 1.0.
2. Update `CHANGELOG.md`: move the entries under `Unreleased` into a dated
   heading.
3. Set the version in every `package.json`, in `services/perception/pyproject.toml`,
   and in the root `package.json`.
4. `pnpm verify`, and read the worked example:

   ```bash
   pnpm oea demo ./tmp/demo
   pnpm oea plan --project ./tmp/demo --skill travel-vlog --duration 180
   ```

   A test can tell you the plan is still valid. Only the output can tell you it
   is still good.

5. Commit, tag `vX.Y.Z`, push the tag.

The workflow re-runs the full check on the tagged commit, refuses to publish if
the tag and the package version disagree, and publishes with npm provenance so
that anyone installing can see which workflow run produced the tarball.

## What is published, and what is not

Published: the eight `@editorial-ir/*` libraries, the `@editorial-ir/cli`
package that provides `oea`, and `editorial-perception` on PyPI.

Not published: the examples, the tests, the schemas directory, and this
documentation. `schemas/` is generated and committed so that it can be read from
the repository and diffed in review — it is a record, not a distribution.

The CLI package carries a copy of the worked example, written into it by its
`prepack` script, because `oea demo` has to work on a fresh install. The source
of truth stays `examples/anniversary-trip`; the copy is ignored by git and
rebuilt every time the package is packed.
