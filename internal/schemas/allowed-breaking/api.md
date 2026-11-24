# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

Merge of upstream 0.7.2 (#734): the authorization action enums gain `job.trigger`. oasdiff reports the
two `cases` subschemas as replaced because the fork's `deep-link.publish` sits in the same enums; with
references resolved, no value was removed. Remove after merge.

```text
POST /api/v1/admin/policy-analyzer/evaluate removed `subschema #1, subschema #2` from the `cases/items/` request property `anyOf` list
```
