# ADR 007: Astro, vanilla modules, MapLibre, in-house SVG charts; no framework

**Status:** accepted (2026-10); state management formalised 2026-11 (`state.js`)

## Context
The interface is one map, one time control, one filter row, ten views of coordinated charts and six printable reports. 367 KB of JavaScript on first load; a strict CSP with no external scripts.

## Decision
No React or Angular. One state object and one `applyState()` (validation, map and control sync, a single render, the URL hash) are the application's spine; views are functions of state; charts are small pure builders over SVG; MapLibre draws the map.

## Alternatives weighed
A component framework (worth it with extensive reusable component hierarchies, collaborative workflows or client-side editing, none of which exist); Experience Builder (for an Esri client, see the paper's Part 14).

## Consequences
Small bundle, fast repaint, every control addressable (deep links, the assistant). The in-house chart library is a maintenance obligation justified only while its size advantage holds.
