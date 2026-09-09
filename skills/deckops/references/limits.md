# Engines, preflight, limits, and recovery

## Engine routing

- `--engine local` keeps supported file parsing on the local machine. URL source mode still
  fetches the supplied URL.
- `--engine cloud` explicitly selects cloud parsing and can upload a local document.
- `--engine auto` stays local unless `--allow-upload` is also present and the router reaches
  a supported fallback condition.
- Keynote and URL runtime mode require cloud parsing.

Do not infer upload permission from stored credentials, a cloud recommendation, a previous
unrelated task, or local failure. If the user already authorized this document and workflow,
continue without asking again.

Product configuration and environment can affect defaults. Specify the engine in agent-run
commands. Explicit local mode restricts the invocation even if upload authorization is inherited.
Use `--no-allow-upload` to override persistent authorization and `--no-fail-on-degraded` for best effort.

## Preflight

DeckOps uses a bounded DeckProbe inspection for local files and stdin before parsing:

- `validate` is the ordinary default. It rejects malformed/container-mismatched input and an
  encrypted document without the applicable password. Probe runtime/budget trouble can become
  a warning while parsing continues.
- `strict` makes preflight failures stop the task.
- `off` skips preflight for a concrete latency, CSP, compatibility, or user requirement.

URLs skip local preflight. Existing artifacts have no source bytes to preflight and should not
receive source preflight options.

A partial probe report is evaluated target by target and is not itself proof of damage.
Macros, external relationships, and embedded objects are signals, not default blockers. DeckProbe
does not render, execute content, perform OCR, or replace malware scanning.

## Quality controls

`--fail-on-degraded` turns a degraded parse or artifact into an error. It is useful when the
requested answer depends on complete structure. Without it, valid portions can still be used
if the limitation is reported.

`--preflight strict`, `--fail-on-degraded`, and `convert --strict` cover different layers:
pre-parse container inspection, parse/IR quality, and cloud Markdown rendering respectively.
Local Markdown conversion rejects `--strict` in 2.1.1.

## Local resource limits

The local parsers bound source bytes, ZIP entries and expansion, individual parts and assets,
total assets, XML depth/events/text, URL bytes and redirects, time, and worker heap. The main
CLI overrides are:

```text
--max-source-bytes
--max-expanded-bytes
--max-part-bytes
--max-asset-bytes
--max-total-asset-bytes
--max-zip-entries
--max-url-bytes
--worker-heap-mb
--timeout
```

Raise only the limit identified by the failure and only enough for a known input. Overrides
participate in artifact cache identity. A larger limit does not improve semantic fidelity.

## Known 2.1.1 behavior

- Content and envelopes have one stdout owner, including `convert -o - --json`.
- An explicitly requested portable output is materialized even if an artifact view exists.
- `capabilities --json` exposes supported versus unverified remedies. Unverified OCR/table/SmartArt repair does not authorize or trigger automatic uploads.
- Node preflight has a 2500 ms host deadline and a 16 MiB input cap; timeouts retain unknown evidence.
- `upgrade.json` preserves submitted/uncertain task state. Do not remove it to silently repeat a potentially paid request.
- Local one-shot `--split-pages` does not materialize separate portable page files. Parse first,
  then use artifact conversion with `--split-pages`.
- Unknown Commander options can fail with exit 2 and stderr only.
- `formats --json` is a display-oriented matrix, not a complete capability-negotiation schema.
- `extract`, `modify`, and `export` return `not_implemented`.

## Cloud recovery

Cloud task creation is not generally safe to repeat after an ambiguous network failure. Keep the
task ID as soon as it is reported. When the SDK or surrounding application exposes task lookup,
inspect that task and convert its completed parse reference rather than uploading and parsing the
source again.

Remote IR references currently expire, while local v2 IR remains usable for local conversion.
Signed image URLs are previews, not permanent assets. Preserve or localize required assets before
declaring an artifact durable offline.

Stop retrying when the same command repeats the same input/auth/quota/backend failure without a
changed condition. Report the specific blocker and any recoverable task ID.
