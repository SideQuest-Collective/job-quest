# Phase 4: Product Integration Hardening - Context

**Gathered:** 2026-04-22
**Status:** Complete

<domain>
## Phase Boundary

Harden the dashboard-backed product behavior so the server and UI use the runtime descriptor and fail clearly when a required runtime CLI is unavailable.

</domain>

<decisions>
## Implementation Decisions

- Server reads runtime metadata from the shared descriptor.
- Dashboard surfaces runtime-aware schedule hints.
- User-visible server errors stop hard-coding Claude-only text.

</decisions>
