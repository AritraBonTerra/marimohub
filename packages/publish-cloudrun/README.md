# @marimo-hub/publish-cloudrun

`PublicReleaseHost` adapter that publishes managed public dashboards to Google Cloud Run.

Part of [marimohub](../../README.md). See [fork/public-dashboard/README.md](../../fork/public-dashboard/README.md)
for the runtime and [docs/configuration.md](../../docs/configuration.md) for the
`MARIMOHUB_PUBLIC_RELEASE_*` variables.

## Packaging

A release image is the digest-pinned public dashboard base image with one appended
layer. The layer is a reproducible tar of `/release` (mode `0444`, directories `0555`,
root ownership, zero mtimes). The adapter pushes the layer, the updated config and the
manifest to Artifact Registry with the OCI distribution API. No build runs and no packages
are installed, so notebook code never executes while packaging.

Push the base image into the release repository, or into a repository in the same
registry location that supports blob mounting. The adapter refuses to copy base layers
through the hub.

## Cloud Run

Services are created private with the configured zero-grant runtime service account,
`maxInstanceCount: 1`, a 300 s request timeout, a `/health` startup and liveness probe,
and only the gateway environment variables, including `PUBLIC_DASHBOARD_REQUIRE_MANIFEST=1`.
Before creating or exposing a service the adapter compares the publisher identity (the
key's `client_email`, or the metadata server's account email) with the runtime account
and refuses to continue when they match. A ready service must run as the runtime account.

IAM policies are read and written at version 3, so conditional bindings are preserved.
`expose` treats only an unconditional `allUsers` invoker binding as already public and
otherwise adds `allUsers` to an unconditional `roles/run.invoker` binding, with etag
retries, then requires anonymous `GET /health` and `GET /` to return 200. `revoke` touches
only services named `marimo-public-*` that carry this hub's `marimohub-managed` and
`marimohub-instance` labels. It removes `allUsers` and `allAuthenticatedUsers` from every
invoker binding, conditional or not, and deletes the service. The instance label is
required configuration because revoke and the orphan sweep delete what carries it.

## Credentials

Every token, metadata, Cloud Run and registry request is bounded by the caller's
`AbortSignal` and a timeout. A service-account key may only name
`https://oauth2.googleapis.com/token` as its `token_uri`; metadata responses must carry
`Metadata-Flavor: Google`; token requests never follow redirects. Registry token realms and
upload locations must be on the registry origin. Blob redirects to storage are followed
without the Authorization header. Base image reads request `pull` scope only; the release
repository gets `pull,push`, and a cross-repository mount asks for both in one token.

The live Artifact Registry token exchange, blob mount and Cloud Run cold start are
covered here by an in-memory registry and API fake only. Verify them against the target
project with a synthetic release before enabling the backend.
