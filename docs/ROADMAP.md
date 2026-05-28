# DeckOps Roadmap

This roadmap keeps the cloud-first direction of `DeckOps` explicit for contributors.

## Current Direction

`DeckOps` is the hosted execution layer of the DeckFlow toolchain. The project should keep improving:

- cloud task execution UX
- non-interactive automation support
- key and token management clarity
- permission validation and tenant safety
- operator-friendly debugging and supportability

## Near-Term Priorities

### 1. Key And Scope Validation

- document minimum scopes per command family
- distinguish user sessions from service credentials
- define server-side validation rules for task creation, file access, and task reads
- make `401`, `403`, and `402` behavior easy to understand from CLI output

### 2. Automation Readiness

- improve CI examples for token-based usage
- document headless setup and rotation workflows
- expand `--json` examples for scripting and operational tooling

### 3. Developer Documentation

- keep README examples aligned with the actual CLI
- reduce historical naming drift in legacy docs
- maintain a clear boundary versus `DeckUse`

## Medium-Term Priorities

- richer task lifecycle docs
- stronger auditability guidance for cloud operations
- clearer multi-tenant or multi-space usage patterns
- more examples for long-running jobs and output retrieval

## Out Of Scope For DeckOps

- mandatory local structural editing workflows
- positioning the project as an offline-first PPTX editor
- hiding permission boundaries behind vague auth behavior
