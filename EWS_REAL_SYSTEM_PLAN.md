# Real EWS: From Rule-Engine Prototype to a True Early Warning System

## Context

The current "Early Warning System" (`/ews/builder`, `/ews/rules`, `/ews/dashboard` in console-react) is a UI prototype only. It generates **fake, deterministic synthetic data** (`syntheticSeries()` in `ewsStore.js`), evaluates thresholds against that fake data, and stores everything in browser `localStorage` (`ews-rules-v1`, `ews-alerts-v1`). There is no scheduling (the cron field is stored but never executed — "Run now" is the only way a rule ever fires), no backend persistence, no deduplication (re-running a rule duplicates alerts), and no real notification delivery (WhatsApp/email recipients are stored but nothing is ever sent).

The user confirmed this is functioning as a rule *engine*, not an *early warning system* — there's no real surveillance happening. Two requirements were added: the data is monthly, facility-level, and **refreshes daily because previously-reported values get corrected retroactively** — so an EWS must be able to detect and react to corrections to data it already alerted on, not just to new periods.

This plan turns it into a real system: real warehouse data, a 24/7 scheduled evaluator, MongoDB-backed persistence with an append-only audit trail, real WhatsApp/Email delivery, and a correction-detection mechanism — built in phases so each layer is provably working before the next is added.

## Ground truth that shapes this design

- **Warehouse (Postgres) is hard read-only.** `warehouse.py`'s `safe_select()` blocks INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT at the code level. EWS state (rules, alerts, snapshots, execution logs) **cannot** live there — it needs MongoDB. No MongoDB connection exists anywhere in `final_disease_pred/` today; this is a real external dependency the user/ops must provision (Mongo URI, WhatsApp 360Dialog credentials, SendGrid key) before later phases can run for real.
- **Real data access already exists, no new ETL needed.** `etl_warehouse_common.fetch_fact_series(disease_id, indicator_name, level)` already queries `{schema}.fact_indicator_data` joined to `dim_geo_location_master`/`dim_indicator_master`, dedups via `hashkey`, and rolls facility-level rows up to state/LGA. This is the exact function `/api/forecast` and `/api/whatif` already use — the EWS evaluator calls it directly.
- **No timestamp/audit column exists in the warehouse** to detect which rows changed. The only way to detect a correction is to re-fetch a trailing window of months and diff it ourselves against a snapshot we stored after the last evaluation.
- **`api.py` runs in dev-reload mode** (`uvicorn.run(..., reload=True)`) — a 24/7 poller must be a fully separate process, never embedded in the FastAPI request cycle.
- **Frontend blast radius is small.** Confirmed via grep: `EWSBuilder.js`, `EWSRules.js`, `EWSDashboard.js` have zero direct references to `ewsStore.js` — every call goes through `ewsApi.js`. That file is the only one needing meaningful rewrites; the three page components should need no changes.
- **Reusable patterns exist but live in different deployable services** (`odc_new_ui/report_scheduler_python` for Mongo-backed cron scheduling with atomic locking; `odc_new_ui/chatbot_web_fmoh` for WhatsApp via 360Dialog; `odc_new_ui/report_scheduler_python/src/services/email_service.py` for SendGrid email). Since `final_disease_pred` is its own standalone deployable repo, the plan **vendors** trimmed, EWS-owned copies of the connection/notification *patterns* into `final_disease_pred/` rather than creating live cross-process dependencies on those other services.

## Decisions made explicit

1. **Persistence: a new dedicated MongoDB database (`ews`)**, separate from any other ODC Mongo usage, with 4 collections: `ews_rules`, `ews_alerts`, `ews_executions`, `ews_snapshots`. New env vars: `EWS_MONGO_URI`, `EWS_MONGO_DB_NAME`.
2. **Snapshot strategy: hybrid hash + last-value per (disease, indicator, level, state, lga) series**, stored as one document per series with a `cells: {"YYYY-MM": {value, hash, last_seen_at}}` map. Cheap to diff (compare hashes), and the retained value supports the alert's audit narrative ("corrected from X to Y") without a second lookup.
3. **Alert identity = `{rule_id, period, state, lga}`** (unique index) — this IS the deduplication mechanism, replacing the "no dedup" gap in the current prototype.
4. **Correction handling: append-only, audit-first.** Per the user's confirmed direction, a fired alert is never silently overwritten. Each document has a denormalized "current state" (for fast list views) plus an immutable `events[]` array (`fired`/`reaffirmed`/`corrected`/`superseded`/`acknowledged`/`escalated`/`resolved`). A correction that changes severity appends a `corrected` event; one that removes the breach appends `superseded`; one that confirms the same breach appends `reaffirmed`. **Any human-set status (acknowledged/resolved) is never reset by an automatic correction event** — only an `open`/`superseded` automatic status can be auto-updated.
5. **Scheduler: a new standalone process**, not embedded in `api.py` and not a direct import of `report_scheduler_python`'s executor (that one is hard-wired to WhatsApp-analytics report generation). Mirrors only its proven shape: MongoDB polling, `croniter` for next-run computation, atomic `find_one_and_update` locking with stale-lock recovery, exponential-backoff retries.
6. **Notifications: vendored, not cross-process.** New `ews_notify.py` reuses the 360Dialog WhatsApp API request *shape* and the SendGrid email pattern, but reads its **own** env vars (`EWS_WHATSAPP_API_URL`, `EWS_WHATSAPP_ACCESS_TOKEN`, `EWS_WHATSAPP_BASE_URL`, `EWS_SMTP_FROM_EMAIL`, `EWS_SMTP_FROM_NAME`, reusing `SENDGRID_API_KEY` if already shared) rather than depending on the other services' fragile config-loading code (confirmed `chatbot_web_fmoh`'s "remote Mongo config" is actually dead code reading a local file, not worth mirroring).
7. **Backend API replaces `ews_nlp.py` with `ews_routes.py`** — a one-line import swap in `api.py`, keeping the existing `/api/ews/interpret` and `/api/ews/meta` routes, adding full rule CRUD, manual "run now," alert querying/lifecycle actions, and execution history — all MongoDB-backed.
8. **Frontend: `ewsApi.js` is the only file that changes meaningfully.** Its existing method surface (`listRules`, `createRule`, `listAlerts`, `acknowledgeAlert`, etc.) maps 1:1 onto the new REST endpoints. Recommend a temporary feature flag so `ewsStore.js`/localStorage remains a fallback during rollout, deleted once the new backend is trusted.

## New files (all under `c:\Users\Asim_Baig\Desktop\final_disease_pred\`)

- **`ews_db.py`** — `EwsDatabase` class: MongoClient connection (ping-on-connect, index creation), CRUD for the 4 collections, atomic rule-lock acquire/release.
- **`ews_evaluator.py`** — pure logic, no Mongo/IO: `fetch_trailing_series` (wraps `etl_warehouse_common.fetch_fact_series`), `detect_corrections` (hash-diff against a snapshot dict), `compute_metric`/`get_baseline`/`check_threshold` (direct ports of the already-correct math in `ewsStore.js`).
- **`ews_executor.py`** — orchestrates one rule's full run: fetch → diff against snapshot → re-evaluate any corrected periods (appending the appropriate event per Decision 4) → evaluate the latest period → upsert snapshot → notify → write an `ews_executions` record. Used identically by both the manual "run now" API route and the scheduler, so the two paths can never drift.
- **`ews_notify.py`** — vendored WhatsApp send (360Dialog shape) and Email send (SendGrid), each returning per-recipient status for the audit log, never raising.
- **`ews_scheduler.py`** + **`run_ews_scheduler.py`** — the 24/7 poller (separate process, started via `python run_ews_scheduler.py` alongside, never inside, `python api.py`).
- **`ews_routes.py`** — replaces `ews_nlp.py` in `api.py`'s `app.include_router(...)` line; full REST surface (rule CRUD, run-now, validate, alert list/acknowledge/escalate/resolve, execution history), all Mongo-backed.

## Files edited

- **`final_disease_pred/api.py`** — one-line router import swap (`ews_nlp` → `ews_routes`), no other change.
- **`odc_new_ui/console-react/src/pages/ews/ewsApi.js`** — rewritten to call the new REST endpoints instead of `ewsStore.js`'s localStorage functions. `EWSBuilder.js`/`EWSRules.js`/`EWSDashboard.js` expected to need zero changes.
- **`.env.example`** (both `final_disease_pred/` and its docs) — document the new `EWS_*` env vars.

## Phased rollout

1. **Phase 0 — provisioning**: stand up `ews_db.py` and empty indexed collections against a real `EWS_MONGO_URI`. No behavior change yet.
2. **Phase 1 — prove real data works**: one disease/indicator/state, manual `POST /api/ews/rules/{id}/run` only (no scheduler, no notifications). Isolates "does real evaluation against the warehouse work" from scheduling/delivery concerns.
3. **Phase 2 — correction detection**: add `ews_snapshots` and the diff logic, still manual trigger. Since the warehouse can't be made to produce a real correction on demand, validate `detect_corrections` with unit tests feeding synthetic before/after frames directly.
4. **Phase 3 — scheduler**: add `ews_scheduler.py`/`run_ews_scheduler.py`, verify cron-driven firing, dedup idempotency, and lock recovery across restarts.
5. **Phase 4 — notifications**: wire in `ews_notify.py`, test against low-stakes recipients first.
6. **Phase 5 — cutover**: full alert lifecycle endpoints in the dashboard, remove the feature flag, delete `ewsStore.js`, generalize beyond the one pilot rule to all diseases/indicators.

## Risks / gaps (flagged, not resolved by this plan)

1. No MongoDB credentials exist yet anywhere in `final_disease_pred/` — must be provisioned externally before Phase 0 can run for real.
2. No clean existing WhatsApp credential source to copy (the candidate reference in `chatbot_web_fmoh` turned out to be dead code) — real 360Dialog account credentials need to be obtained directly.
3. Correction-handling can only be confidence-tested synthetically until a real production correction occurs, since the warehouse is read-only and can't be made to emit one on demand for testing.
4. Recommended poll interval (~120s) means actual fire time can drift up to ~2 minutes from the literal cron time — acceptable for daily cadence, but worth communicating to stakeholders.
5. No cross-rule query caching in early phases (e.g. multiple rules on the same disease/indicator/level re-querying the warehouse separately) — deferred as a later optimization to keep the initial architecture simple and provably correct.

## Confirmation pass (re-verified against actual source)

Read `ewsStore.js` (315 lines) and `ewsApi.js` (61 lines) in full. Confirms every assumption in this plan:
- `ewsApi.js` is a thin wrapper exposing exactly: `getMeta/getStates/getIndicators/interpret/listRules/createRule/getRule/updateRule/deleteRule/activateRule/pauseRule/runRule/validateRule/listAlerts/acknowledgeAlert/escalateAlert/resolveAlert` — every one of these maps 1:1 onto a planned `ews_routes.py` REST endpoint, validating Decision 8 (only `ewsApi.js` needs a rewrite).
- `ewsStore.js`'s `computeMetric`/`getBaseline`/`checkThreshold` functions are exactly the math to port verbatim into `ews_evaluator.py` — no redesign needed, only a real-data swap for `syntheticSeries()`.
- `ewsStore.js` has zero dedup (every `evaluateRule()` call unconditionally appends a new alert) — confirms the alert-identity-as-dedup mechanism (Decision 3) is a real gap being fixed, not a hypothetical one.

## Verification

- **Phase 1**: call `POST /api/ews/rules/{id}/run` for the pilot rule, confirm an `ews_alerts` document is created/updated with real (non-synthetic) `observed_value`/`baseline_value` matching an independent `fetch_fact_series` query for the same disease/indicator/geography/period.
- **Phase 2**: unit tests for `detect_corrections` feeding two different snapshot dicts for the same series, asserting the correct event type (`fired`/`reaffirmed`/`corrected`/`superseded`) is produced and that a human-set `status` is never overwritten.
- **Phase 3**: run two scheduler instances concurrently against the same Mongo, confirm atomic locking prevents double-execution of one rule; kill a worker mid-execution and confirm stale-lock recovery picks it back up.
- **Phase 4**: trigger a rule manually, confirm `ews_notify.py` returns per-recipient delivery status and that status is recorded in the corresponding `ews_executions` document.
- **Phase 5**: full UI walkthrough — create a rule via `EWSBuilder.js`, see it in `EWSRules.js`, run it, see a real alert in `EWSDashboard.js`, acknowledge/resolve it, confirm state persists across a page refresh and a different browser (proving it's no longer localStorage-bound).
