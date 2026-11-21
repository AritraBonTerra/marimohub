# @marimo-hub/publish-cloudrun

`PublicReleaseHost` adapter that publishes managed public dashboards to Google Cloud Run.

Part of [marimohub](../../README.md). See [fork/public-dashboard/README.md](../../fork/public-dashboard/README.md)
for the runtime and [docs/configuration.md](../../docs/configuration.md) for the
`MARIMOHUB_PUBLIC_RELEASE_*` variables.

## Packaging

A release image is the digest-pinned public dashboard base image with one appended
layer. The layer is a reproducible tar of `/release` (mode `0444`, directories `0555`,
uid/gid `10001`, zero mtimes). The adapter pushes the layer, the updated config and the
manifest to Artifact Registry with the OCI distribution API. No build runs and no packages
are installed, so notebook code never executes while packaging.

Push the base image into the release repository, or into a repository in the same
registry location that supports blob mounting. The adapter refuses to copy base layers
through the hub.

## Cloud Run

Services are created private with the configured zero-grant runtime service account,
`maxInstanceCount: 1`, a 300 s request timeout and only the six gateway environment
variables. `expose` adds `allUsers` to `roles/run.invoker` with etag retries, then requires
anonymous `GET /health` and `GET /` to return 200. `revoke` touches only services named
`marimo-public-*` that carry this hub's `marimohub-managed` and `marimohub-instance`
labels. It removes public invokers and deletes the service.

The live Artifact Registry token exchange, blob mount and Cloud Run cold start are
covered here by an in-memory registry and API fake only. Verify them against the target
project with a synthetic release before enabling the backend.
