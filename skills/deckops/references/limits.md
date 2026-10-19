# Credentials, quota, retention, and recovery

## Credentials

DeckOps resolves each credential independently: command flags (`--api-key`, `--token`,
`--space`, `--api-base`), then environment (`DECKOPS_API_KEY`, `DECKOPS_TOKEN`,
`DECKOPS_SPACE_ID`, `DECKOPS_API_BASE`, or their `DECKFLOW_*` forms), then the shared file
`~/.deckflow/credentials` written by `deckops auth login`. `deckops config list` shows every
value and where it came from, with secrets masked.

A rejected credential fails with `auth_error` (exit 4); DeckOps never continues as a guest
with it. Ask the user to run `deckops auth login` and rerun. Without any credential the cloud
may accept the call as a guest with a small daily quota.

## Quota

`quota_error` (exit 8) means the identity's quota is exhausted. Report it and the login route.
Do not create another identity or space to get around it.

## Retention

The cloud keeps a parse result for 7 days. `parse --json` returns `expiresAt`, also recorded in
the artifact manifest. After it:

- `convert` of the artifact fails with `ir_expired` before any request; parse the source again.
- A `parse` of the same source parses again (and is billed) with a warning, like `--force`.
- Markdown views and images already written stay on disk.

Signed image URLs in a cloud response expire within hours. `convert` downloads every image
and rewrites the links; a failed download fails the convert unless `--keep-remote-images`.

## Timeouts and resume

`--timeout <seconds>` (default 120) bounds each stage: a parse, or a convert with its image
downloads. A one-shot `convert SOURCE` shares one budget; the default `read` entry gives its
parse and its convert one budget each. Sources over 256 MiB are refused.

A timeout or lost connection after the cloud task was created leaves `submission.json` in the
artifact directory with the task id. Rerun the same command into the same output: DeckOps waits for that task and
downloads its result, with no new upload and no new charge. If the cloud reports the task
failed or gone, DeckOps forgets it and says so; the next run submits anew.

A submission that was sent but returned no task id cannot be resumed. DeckOps refuses to
resubmit it on its own; `--force` resubmits and the earlier task, if it was created, may be
billed separately. Use it only when the user accepts that cost. Do not delete
`submission.json` to get the same effect silently.

The default `read` entry resumes the same way through its cache artifact, except for URL and
password-protected sources. One-shot `convert SOURCE` keeps no artifact to resume; parse into
an explicit directory when a large document may need a retry.

## Cancellation

Interrupting the process stops local waiting and downloads only. A task already submitted
keeps running in the cloud and may be billed. A second parse into an artifact that another
parse is using fails with `input_error` while its lock is held; wait for the other run instead
of removing the `.lock` file.

## When to stop retrying

Stop when the same command repeats the same input, auth, quota, or backend failure without a
changed condition. Report the specific blocker, its `error.code`, the `hint`, and any
recoverable `taskId`.
