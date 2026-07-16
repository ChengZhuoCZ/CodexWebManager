# Architecture Decision

Status: ACCEPTED_FOR_DEVELOPMENT_WITH_DEFERRED_E2E

Mode: LIMITED_MODE

Decision ID: M0.4-LIMITED-2026-07-16

Input workspace revision: `7714dff0ff0eeb3ce35c094fb1e29198f60dd9bd`

Implementation mode: `clean-room`

## Decision scope

Development may proceed with an explicitly non-seamless account transition model. The real A→B
continuity matrix remains blocked because the current device has one user-authorized Codex account.
The user's 2026-07-16 instruction defers that experiment until after implementation; it does not
convert missing evidence into a passing result and does not waive the release E2E gate.

## Observed facts

1. Codex CLI 0.144.2 uses a persistent Responses WebSocket and sends
   `previous_response_id` on continuation calls.
2. A→A continuity with `previous_response_id` passed.
3. Removing `previous_response_id` produced a completed response that did not recall the fixture.
   The observed request therefore did not independently carry enough state for transparent replay.
4. Reopening a Responses WebSocket and forwarding an old `previous_response_id` failed with an
   upstream error even for the same authorized identity.
5. App-server restart plus `thread/resume` passed only after fresh upstream bootstrap. This proves
   restart/resume behavior, not in-place recovery of an interrupted computation.
6. An initial request with no prior response state was replayable before semantic output.
7. After the first semantic event, the relay blocked transparent replay.
8. No real A→B result exists, so response/account binding remains unproven.

## Supported LIMITED_MODE behavior

- Keep the browser and codex-web page stable when possible, but represent an account transition as
  a new backend model session.
- Never forward an old account's `previous_response_id` to a replacement account.
- Rehydrate only from locally recorded, bounded, sanitized transcript state at a turn boundary.
- Include completed model outputs and confirmed tool results only. Never replay an interrupted turn,
  pending function call, shell command, file mutation, or other uncommitted side effect.
- Permit automatic fallback only before any semantic event and only when the request has no
  account-bound prior response state, or when the upper layer explicitly starts a new rehydrated
  backend session.
- After semantic output, return `unsafe_to_replay`, keep the partial result visible, and require an
  explicit new turn/session continuation.
- Surface a visible `limited_mode_new_session` switch event. Do not label it seamless continuation.
- Stop with `all_accounts_unavailable` after bounded attempts; never loop indefinitely.
- Bind proxy and admin listeners to loopback or Unix sockets only.

## Implementation constraints

- Cross-account routing is disabled by default until account configuration is explicit.
- Any switch implementation must be feature-gated and expose whether real cross-account E2E has
  been verified.
- M3.5/M4.1 account-switch acceptance and the final release gate cannot pass without a second,
  distinct, user-authorized account.
- UI work may display sanitized state and transitions, but must not claim that an original upstream
  response chain or in-flight computation was preserved.

## Rejected alternatives

- `GO_PATH_A`: rejected for now because old response state failed on a replacement WebSocket and
  cross-account portability is untested.
- `GO_PATH_A_REHYDRATE`: rejected as a claim of proven behavior because removing
  `previous_response_id` lost fixture continuity; rehydration must be an explicit new session.
- `GO_PATH_B`: deferred because per-account app-server pooling adds thread/workspace mapping and still
  lacks a proven migration mechanism. It may be reconsidered after real A→B evidence.
- `STOP_UNSAFE`: not selected because safe, non-transparent development is possible under the
  restrictions above. Release remains gated by missing E2E evidence.

## Residual risks

- A replacement account may reject inputs, models, tools, or quota calls differently.
- Transcript rehydration can lose hidden upstream state and may increase token usage.
- Tool side effects require strict completed/pending boundaries to prevent duplication.
- Account-specific auxiliary endpoints remain unverified across identities.
- Product wording could overstate continuity unless LIMITED_MODE is visible in APIs, logs, and UI.

## Upgrade criteria

Change this decision only after a redacted, real A→B matrix covers calls with and without
`previous_response_id`, restart/resume, and failures before and after the first semantic event.
