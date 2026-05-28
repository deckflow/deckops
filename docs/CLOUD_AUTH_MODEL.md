# DeckOps Cloud Auth Model

This document defines the recommended credential and permission direction for `DeckOps`.

## Why This Exists

`DeckOps` is a cloud-first project. Developers should be able to run jobs from laptops, CI pipelines, or internal tools without blurring the line between:

- personal interactive login
- automation credentials
- tenant or workspace boundaries
- task permissions for potentially sensitive file operations

## Credential Types

### 1. User Login Session

Use for:

- local development
- manual CLI usage
- exploratory testing

Characteristics:

- created through `deckops login`
- tied to an end-user account
- suitable for interactive workflows
- should not be shared with CI or teammates

### 2. Service Key or API Token

Use for:

- CI pipelines
- automation scripts
- backend-to-backend integrations
- shared operational workflows

Characteristics:

- provisioned by the cloud backend
- revocable without affecting user accounts
- scope-limited
- auditable

## Recommended Permission Scopes

The backend should validate a key against explicit scopes instead of treating all tokens as equivalent.

Suggested scope families:

- `tasks:create` for creating cloud tasks
- `tasks:read` for polling status and reading task metadata
- `tasks:delete` for deleting task records
- `files:upload` for uploading source files
- `files:read` for downloading task outputs
- `spaces:read` for reading workspace or tenant metadata
- `admin:keys` for issuing or rotating service keys

Optional product-specific scopes can be layered on top:

- `task:compress`
- `task:convert`
- `task:translate`
- `task:create`
- `task:ocr`
- `task:extract`

## Validation Rules

Recommended validation checks on every request:

1. Verify the key exists and is active.
2. Verify the key belongs to the target tenant or space.
3. Verify the key has the required action scope.
4. Verify optional product scope for the requested task type.
5. Verify the key is not expired or rotated out.
6. Record an audit event for sensitive operations.

## CLI Guidance

The CLI should make credential behavior obvious to developers:

- prefer `deckops login` for humans
- prefer `deckops config set-token <token>` for automation
- surface clear errors when a token is valid but under-scoped
- document which commands require which scopes

## Recommended Error Semantics

- `401 Unauthorized`: missing, invalid, expired, or revoked credential
- `403 Forbidden`: credential is valid but lacks required scope
- `402 Payment Required`: account plan or quota does not permit the operation

This keeps auth failures, permission failures, and billing limitations distinct.

## Documentation Standard

When new cloud task types are added, document:

- required credential type
- minimum scopes
- whether output download requires extra permission
- whether the command is safe for CI use

## Open Questions

- Should task-type scopes be mandatory or derived from broader task scopes?
- Should spaces map one-to-one with tenants, projects, or billing units?
- Should short-lived tokens be supported for temporary automation sessions?
