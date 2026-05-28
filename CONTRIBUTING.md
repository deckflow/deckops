# Contributing to DeckOps

Thanks for helping improve `DeckOps`.

This repository is the cloud-first CLI in the DeckFlow ecosystem, so good contributions are not just about code quality. They also preserve clear authentication boundaries, automation safety, and developer trust.

## Before You Start

- read [README.md](README.md) for product positioning
- read [docs/CLOUD_VS_LOCAL.md](docs/CLOUD_VS_LOCAL.md) for the boundary between CLI work, hosted execution, and `DeckUse`
- read [docs/CLOUD_AUTH_MODEL.md](docs/CLOUD_AUTH_MODEL.md) if your change touches keys, tokens, login, or authorization
- open an issue first for large changes, new task families, or auth model changes

## Local Setup

Prerequisites:

- Node.js `>=18`
- npm
- Git

Setup:

```bash
git clone <repository-url>
cd deckops
npm install
npm run build
npm test
```

## Contribution Priorities

High-value areas for this project:

- better developer experience for CLI workflows
- clearer task lifecycle behavior and error handling
- stronger docs for cloud setup and automation usage
- safer key, token, and permission handling
- better examples for CI and scripting

## Workflow

1. Create a branch for your change.
2. Make the smallest coherent change that solves the problem.
3. Update docs when behavior, command shape, or auth expectations change.
4. Run the relevant validation commands.
5. Open a pull request with a clear summary and validation notes.

## Validation

Run the checks that fit your change:

```bash
npm run build
npm test
npm run typecheck
npm run lint
```

Useful targeted commands:

```bash
npm run test:unit
npm run test:e2e
npm run test:coverage
```

## Auth And Security Changes

Be extra careful when a change touches:

- `login`
- token storage
- callback handling
- task authorization
- tenant or space boundaries
- upload or download permissions

For these changes:

- explain the threat model in the PR
- document any new required scopes or permissions
- verify that error semantics remain clear between `401`, `403`, and `402`
- never include real tokens in code, tests, screenshots, or fixtures

## Documentation Expectations

Update documentation when you change:

- CLI commands or flags
- installation or setup flow
- credential setup
- required task permissions
- project positioning versus `DeckUse`

Common places to update:

- [README.md](README.md)
- [docs/README.md](docs/README.md)
- [docs/CLOUD_AUTH_MODEL.md](docs/CLOUD_AUTH_MODEL.md)
- [docs/CLOUD_VS_LOCAL.md](docs/CLOUD_VS_LOCAL.md)

## Pull Request Quality Bar

A strong PR usually includes:

- one clear purpose
- updated docs if user-facing behavior changed
- tests for non-trivial behavior changes
- explicit notes on auth or permission impact when relevant

## Community Guidelines

- be respectful and specific
- prefer reproducible bug reports
- separate product requests from implementation details when possible
- assume contributors may be using either interactive login or automation tokens
