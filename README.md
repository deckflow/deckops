# DeckOps

Cloud execution engine for processing presentation files at scale.

DeckOps provides APIs and CLI for rendering, conversion, extraction, and transformation of deck files such as PPTX, PDF and etc.

---

## What is DeckOps?

DeckOps is the cloud layer of the Deck platform.

It handles heavy, non-local workloads such as:

- PPTX → PDF / Image / HTML / Video
- PDF → Image
- Text and asset extraction
- Splitting and merging documents
- Batch processing and pipeline execution

DeckOps is designed for:
- backend systems
- automation pipelines
- AI agents
- large-scale processing

---

## Why DeckOps?

Processing presentation files is hard:

- Requires OS-level rendering (PowerPoint / Keynote / headless engines)
- Large files are expensive to process locally
- Output formats vary across environments
- Scaling batch jobs is complex

DeckOps solves this by providing:

- Cloud-based execution
- Consistent rendering results
- Scalable processing
- Simple API interface

---

## Quick Example

### Install SDK (Node.js)

```bash
npm install @deckflow/deckops
