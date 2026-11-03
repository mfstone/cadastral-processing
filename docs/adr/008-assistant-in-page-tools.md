# ADR 008: Assistant: tools run in the page, the Worker is a pinned proxy; no MCP

**Status:** accepted (2026-11)

## Context
Non-technical readers cannot drive a ten-view dashboard. An agent should set the dashboard from a question and answer from its tables, without a server that could be used as a free language model and without ever stating a figure it did not read.

## Decision
Six strict tools (state read and configure, place lookup, series and table reads that reuse the views' own arithmetic, report composition) execute in the browser against the live state. A Cloudflare Worker holds the key and pins the model, the generated system prompt and the tool list; the page sends only the conversation; the Worker validates every block, rate-limits, caps the day, checks Turnstile and relays the stream. The assistant never writes an owner's name, enforced in the prompt, the executor and the Worker.

## Alternatives weighed
An MCP server (the tools must touch the page; a server-side MCP would need a back-channel for no gain; kept as a later, optional surface for external agents over the same tool definitions); the agent loop on the server with a WebSocket to the page (more moving parts); any design that sends the data to the model (the model sees tool results only).

## Consequences
The first server component and the first secret; a cost per question (about 10 to 30 cents at medium effort); the static deploy still works without it (the button appears only where the health endpoint answers). Preserved thinking requires an append-only history, which the loop guarantees.
