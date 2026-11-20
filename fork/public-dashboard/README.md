# Public dashboard releases

Publish a reviewed interactive marimo app on its own origin. The private hub continues
to serve the original notebook and its authenticated app links. This directory is
independent of the upstream hub's auth, routes, storage and compute adapters.

## Prepare a release

Create a directory called `release` in this build context. Put the reviewed
reader in `release/notebook.py`, approved read-only inputs alongside it, and
approved photos in `release/public/`. Reference those photos by their
`/public/<name>.jpg` URLs. Paths to private photo sources must be removed from
the reader. Use `mo.notebook_dir()` to locate local inputs from Python. The gateway serves
approved photos from `/public/` and does not serve marimo virtual files.

Apply any approved data corrections before assembling the release. Do not
include the correction log, writeback callbacks, credential files, shared hub
workspace, or anything the reader does not need. Review the rendered values,
photos, exception output and files as public material. Choose dropdowns or
other widgets that use value changes for selection. This gateway does not
expose marimo's general-purpose function-call API and therefore does not
support widgets that require that API.

Build this directory as its own Docker context after reviewing the release.
For Cloud Build, run `gcloud builds submit --tag IMAGE .` from this directory.
The Cloud Build ignore file restricts the upload to the image inputs.
The Dockerfile installs the locked runtime and copies the release into the
image. Identify the resulting image by digest in deployment records. Later
changes to the source notebook cannot change an already deployed release.

## Publish and withdraw on Cloud Run

Use a distinct service name per release, such as `marimo-public-sales-20261119`.
Use a dedicated runtime service account with no IAM grants to notebook data,
the hub or Secret Manager. Supply no secrets or integration environment
variables. Set `PUBLIC_DASHBOARD_ORIGIN` to the exact HTTPS origin viewers will
use, without a trailing slash. The gateway uses it for widget and WebSocket
requests. Do not use a shared corporate custom-domain cookie on that origin.

Deploy the immutable image privately first. Use one instance, one Uvicorn
worker, a five-minute Cloud Run request timeout and enough request concurrency
for sockets and widget requests (for example, 24). The gateway uses a
combined capacity budget of 12 for open sockets and live kernels. Six fully
started sessions can run concurrently. Each socket closes after four and a half
minutes. A reconnect starts a fresh session. A disconnected kernel still uses
capacity until its current work finishes. Keep the service on one instance
because the gateway has no shared session state.

After confirming the release and endpoint, grant `allUsers` the Cloud Run
Invoker role **on this release service only**. Open the release URL with a new
browser session and check the controls and photos. The hub's sign-in and
credentials do not participate in this flow. A public link can be forwarded.

To withdraw it, remove that service's `allUsers` Invoker binding. Check that
a signed-out visitor cannot load the page, a photo or a new WebSocket. Wait
up to five minutes for existing sockets to end. The browser may retain
previously delivered photos and results. Keep the service name retired.
Publish changed data at a new release URL.

Cloud Run provides a metadata service even to a service account with zero
IAM grants. If the release needs a kernel with no network or metadata access
at all, use an isolated hosting environment that can enforce that policy.
The runner assumes the publisher controls and reviews the Python code.
It does not sandbox arbitrary notebooks.

## Verify and update from upstream

Use `uv run --locked ruff check`, `uv run --locked ruff format --check`,
`uv run --locked ty check` and `uv run --locked python -m pytest` from this
directory. Tests exercise a real server-side widget change, photo retrieval,
code visibility, origin checks, session limits and disabled routes.

The fork keeps this extension under `fork/`. To update the hub, fetch
`upstream` and merge `upstream/main` into an update branch on the fork.
Run the hub's normal checks. Validate the new hub image in a tagged,
zero-traffic Cloud Run revision with the existing Google settings before
moving traffic. Upgrade the separate marimo runtime only when its own tests
pass against the new lockfile.
