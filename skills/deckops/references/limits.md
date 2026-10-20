# Credentials, quota, reuse, and recovery

## Credentials

Probe needs none. For the cloud verbs, DeckOps resolves each credential independently: command
flags (`--api-key`, `--token`, `--space`, `--api-base`), then environment (`DECKOPS_API_KEY`,
`DECKOPS_TOKEN`, `DECKOPS_SPACE_ID`, `DECKOPS_API_BASE`, or their `DECKFLOW_*` forms), then the
shared file `~/.deckflow/credentials` written by `deckops auth login`. `deckops config list`
shows every value and where it came from, with secrets masked.

A rejected credential fails with `auth_error` (exit 4); DeckOps never continues as a guest with
it. Ask the user to run `deckops auth login` and rerun. Without any credential the cloud may
accept the call as a guest with a small daily quota.

## Quota

`quota_error` (exit 8) means the identity's quota or package balance is exhausted. Report it and
the login or top-up route. Do not create another identity or space to get around it.

## Reuse

The cloud keeps a parse for 7 days. Extract and convert of the same file with the same parse
options in the same space reuse it — `reusedParse: true` and no new parse charge — from any
machine. Render is billed per run. A URL and a password-protected source are never reused.

Result links are signed and stay valid for the retention window; written Markdown and JSON point
at downloaded copies and do not depend on them. `--keep-remote-images` keeps the signed links
instead.

`~/.cache/deckops/index.json` remembers `sha256 → upload` for three days so the same bytes are
not uploaded again, and nothing else of the document.

## Timeouts and continuing

`--timeout <seconds>` (default 300) bounds the whole run: upload, every task and every download.
Sources over 256 MiB are refused before they are read.

A timeout, lost connection or failed download after the cloud task was created is recorded in the
cache index. Rerun the same command with the same options: DeckOps waits for that task and writes
its result, with no new upload and no new charge. If the cloud reports the task failed or gone,
DeckOps forgets it and says so; the next run submits anew. Password-protected runs and chained
renders (DOCX, WebP) are not recorded and start over.

A request that was sent but returned no task id cannot be continued. DeckOps refuses to resubmit
it on its own; `--force` resubmits and the earlier task, if it was created, may be billed
separately. Use it only when the user accepts that cost.

## Cancellation

Interrupting the process stops local work only. A task already submitted keeps running in the
cloud and may be billed; rerunning the same command continues it.

## When to stop retrying

Stop when the same command repeats the same input, auth, quota or backend failure without a
changed condition. Report the specific blocker, its `error.code`, the `hint`, and any `taskId`.
