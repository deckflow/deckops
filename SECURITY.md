# Security Policy

DeckOps is a cloud-first CLI. Security reports for this repository may involve:

- authentication and session handling
- API key or token exposure
- tenant or space isolation
- task authorization and permission validation
- unsafe handling of uploaded or downloaded files

## Supported Scope

Please report security issues that affect:

- the CLI itself
- local credential storage
- login flow behavior
- token or key handling
- task execution authorization boundaries

## How To Report

Please do not open public issues for suspected vulnerabilities.

Instead, share:

- a clear description of the issue
- impact and possible abuse scenario
- reproduction steps
- affected command or workflow
- redacted logs or screenshots when helpful

If the issue involves credentials:

- rotate exposed keys before sending details
- redact tokens, callback URLs, and account identifiers
- avoid posting active secrets in screenshots or terminal captures

## Response Expectations

The goal for security reports is:

- acknowledge receipt
- reproduce and assess severity
- prepare a fix or mitigation
- document any user action required after remediation

## Key Handling Expectations

For this project, developers should assume:

- personal login sessions are for interactive use
- service tokens are for CI or automation
- tokens should be minimally scoped
- leaked or over-scoped credentials are security issues

See [docs/CLOUD_AUTH_MODEL.md](docs/CLOUD_AUTH_MODEL.md) for the intended permission model direction.
