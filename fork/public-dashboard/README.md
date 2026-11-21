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

## Publish from the hub (managed)

With `MARIMOHUB_PUBLIC_RELEASE_BACKEND=gcp-cloud-run`, the project owner
signed in through the browser opens **Share app → App links → Publish**, chooses a
saved version, and checks the workspace files to include. No file is selected by
default. Personal access tokens and service accounts cannot publish. Projects and
notebooks with security labels cannot publish. Adding labels later withdraws
their releases.

The hub copies the exact version and file bytes into an immutable bundle with a
`release.json` manifest. The maintenance replica appends that bundle as one
read-only layer on the base image, deploys a private `marimo-public-<release-id>`
service, then grants `allUsers` invoker. It moves `/app/<slug>` only after anonymous
`/health` and `/` return 200. A republish keeps the old release live until the new
one takes over, then retires the old one. **Unpublish** clears the redirect at once.
The dialog reports the release stopped only after Cloud Run reports the service
deleted and an anonymous request is refused. Active viewers are disconnected when
the service is deleted. The exact disconnect time has not been measured on Cloud
Run.

When `release.json` is present the gateway refuses to start unless every listed
file matches its SHA-256 and size and no other file exists. Set
`PUBLIC_DASHBOARD_ENTRYPOINT` to serve a notebook other than `notebook.py`.
Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and
`X-Robots-Tag: noindex, nofollow`.

### Build the base image

Add the packages published notebooks may import to `pyproject.toml`, lock them,
and build the `base` stage with its package list:

```sh
docker build --target base \
	--build-arg INSTALLED_PACKAGES="$(python3 installed_packages.py)" \
	-t REGION-docker.pkg.dev/PROJECT/REPO/base .
```

Push it to the release repository and set `MARIMOHUB_PUBLIC_RELEASE_GCP_BASE_IMAGE`
to the pushed digest. The hub rejects a notebook whose `pyproject.toml` or inline
script metadata names a package missing from that list. Without the label it
skips the check, and a missing package fails when the dashboard runs.

### Deployment requirements

The hub never creates projects or changes IAM outside each release service.
Provision these first:

- A project for public dashboards, ideally separate from the hub's project.
- An Artifact Registry Docker repository for release images, holding the base image.
- A runtime service account with no roles anywhere.
- A publisher identity for the hub with `roles/artifactregistry.writer` on that
  repository only, `roles/iam.serviceAccountUser` on the runtime service account only,
  and a custom role with `run.services.create`, `get`, `list`, `delete`,
  `getIamPolicy`, `setIamPolicy` and `run.operations.get`.

Cloud Run service creation and IAM are project-scoped. In a shared project, the
publisher can delete or expose other Cloud Run services there. The adapter only
touches services named `marimo-public-*` with this hub's `marimohub-managed` and
`marimohub-instance` labels, but IAM does not enforce that. Alert on Cloud Run
`SetIamPolicy` and `DeleteService` audit logs outside `marimo-public-*`, and set a
billing budget. Give each hub that shares a project and region its own
`MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE`; the orphan sweep deletes unrecognized
services that carry its label.

Verify the deployment with a synthetic notebook and synthetic files before any
real release. Check `/app/<slug>` signed out, a widget change, an approved photo, a
refused unapproved file, a later private save not changing the release, and
Unpublish with an open socket.

### Limitations

- Notebooks can import only the base image's packages. There is no per-release
  dependency build.
- Only `public/*.{jpg,jpeg,png,webp,avif}` files are web-served. Other selected files
  are readable from Python only. marimo function-call widgets and `/@file/` virtual
  files are not supported.
- Release services can reach the Cloud Run metadata server and the internet.
- Release images stay in Artifact Registry after unpublishing. Use a cleanup policy;
  never delete an image while its service exists.
- Packaging requires the registry to accept the base image's layers in the release
  image. The Artifact Registry token exchange, blob mount and cold start have been
  exercised only against an in-memory registry and Cloud Run fake.

## Share through the hub (manual)

Set `MARIMOHUB_PUBLIC_APP_RELEASE_HOST_SUFFIX` on the Node server to
`-PROJECT_NUMBER.REGION.run.app` to enable publishing from the app link
dialog. Public release service names must start with `marimo-public-`.
Deploy the reviewed release first and verify its URL opens signed out.
Then open **Share app → App links → Publish**, enter that release URL,
and copy the existing app link. **Disconnect public release** disables the hub
redirect. Remove the release's public Invoker binding to withdraw its
direct Cloud Run link too.

### Configure links through the environment

Create an app link in the notebook’s **Share app → App links** dialog. Use the
authenticated notebook deep-links API to find that link’s `registration_id`.
After deploying the reviewed release, set `MARIMOHUB_PUBLIC_APP_RELEASES` on
the Node server to a JSON object keyed by app slug:

```json
{
	"team/overview": {
		"registration_id": "01J00000000000000000000000",
		"origin": "https://dashboard.example.com"
	}
}
```

Copy the existing `/app/team/overview` link from the dialog. A signed-out
browser opening it goes to the public release. Each entry applies only to
the listed registration. Removing or reusing an app slug ends its redirect.
To withdraw the dashboard origin as well, remove its Cloud Run Invoker
binding as described above.
