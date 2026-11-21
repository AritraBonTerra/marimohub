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
default. For a local notebook, the saved version pins the code and selected files
come from the current workspace. For a Git-synced notebook, both come from the
saved version. The preview shows up to 500 candidates and limits how many bytes
it reads. Personal access tokens and service accounts cannot publish. Projects and
notebooks with security labels cannot publish. Adding labels later withdraws
their releases. A hub administrator can withdraw a managed release through
App Links when the owner is unavailable.

The hub copies the exact version and file bytes into an immutable bundle with a
`release.json` manifest. The maintenance replica appends that bundle as one
read-only layer on the base image, deploys a private `marimo-public-<release-id>`
service, then grants `allUsers` invoker. It moves `/app/<slug>` only after anonymous
`/health` and `/` return 200. A republish keeps the old release live until the new
one takes over, then retires the old one. The registration selects the active
release in one conditional write. Cancelling before that write leaves the
previous dashboard live. **Unpublish** cuts off the redirect at once.
The dialog reports the release stopped only after Cloud Run reports the service
deleted and an anonymous request is refused. Active viewers are disconnected when
the service is deleted. The exact disconnect time has not been measured on Cloud
Run.

Managed releases require `release.json`. The gateway verifies every listed
file's SHA-256 and size and rejects extra files. Manual releases can also provide
that manifest. The container runs as a non-root user. Release paths are
root-owned and read-only. Set `PUBLIC_DASHBOARD_ENTRYPOINT` to serve a notebook
other than `notebook.py`.

The gateway caps widget requests at 64 KiB and gives the body 10 seconds to
arrive. Each instance admits six concurrent sessions and 30 session starts per
minute. A viewer holds a slot until its socket closes and its kernel stops. If
detached kernels occupy every slot for
three minutes with no open viewer, `/health` returns 503 and Cloud Run's liveness
probe can restart the dashboard. The gateway also sets a content security policy
that limits framing, plugins, and the document's base URL.

### Build the base image

Add the packages published notebooks may import to `pyproject.toml`, lock them,
and build the `base` stage with its package list:

```sh
docker build --target base \
	--build-arg INSTALLED_PACKAGES="$(python3 installed_packages.py)" \
	-t REGION-docker.pkg.dev/PROJECT/REPO/base .
```

Build the base image from the same source revision as the hub. Push it to the release repository and set `MARIMOHUB_PUBLIC_RELEASE_GCP_BASE_IMAGE`
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

Cloud Run service creation is project-scoped. The adapter checks service names
and ownership labels before granting public access or retiring a service. Each
hub in a project and region needs a unique, stable
`MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE`. Keep that identifier and its bucket
together during restoration. A different bucket under the same identifier makes
the existing services appear orphaned.

For a shared project, ask a GCP administrator to attach a Resource Manager tag
such as `hub-protection=private` to the private hub and other private Cloud Run
services. Apply a [project IAM deny rule](https://docs.cloud.google.com/iam/docs/deny-access)
for the publisher principal on the permissions below, conditioned on
`resource.matchTagId('tagKeys/KEY_ID', 'tagValues/VALUE_ID')`.

- `run.googleapis.com/services.setIamPolicy`
- `run.googleapis.com/services.delete`
- `run.googleapis.com/services.update`
- `run.googleapis.com/services.deleteTagBinding`

Use the publisher's `principal://iam.googleapis.com/projects/-/serviceAccounts/PUBLISHER_EMAIL`
identifier. Give the publisher no access to edit that policy or remove its
protection. Use IAM Policy Troubleshooter to confirm the publisher is denied on
the private hub and allowed to manage a synthetic public release. Check both
outcomes before enabling managed publishing. Alert on Cloud Run `SetIamPolicy`
and `DeleteService` by the publisher outside `marimo-public-*`, and set a billing
budget. [Cloud Run tags](https://docs.cloud.google.com/run/docs/configuring/tags)
and [deniable permissions](https://docs.cloud.google.com/iam/docs/deny-permissions-support)
describe the provider controls.

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
- Packaging requires Artifact Registry to accept the base image's layers in the
  release image. Test a synthetic publish when changing the base repository,
  publisher identity, or Cloud Run region.

### Retain release images

After verified withdrawal, the publisher marks that release image with a
`retired-<release-id>` tag. Its registry writer role can create tags. Configure
[the repository cleanup policy](artifact-cleanup.json) in dry-run mode first.

```sh
gcloud artifacts set-cleanup-policies REPOSITORY \
  --project PROJECT --location REGION \
  --policy artifact-cleanup.json --dry-run
```

The policy matches retired dashboard versions that are at least 30 days old.
Tag every base image you intend to keep with a `base-` prefix. Check the
[Artifact Registry dry-run logs](https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy#verify-dry-run)
against active release and base digests before enabling deletion. Investigate
`public_release_image_retirement_failed` logs for any images that still need
tagging. Tags alone never expose or delete a service.

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
