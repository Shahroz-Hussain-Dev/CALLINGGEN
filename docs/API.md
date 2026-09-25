# API reference

Base path `/api`. JSON in and out. Authentication: httpOnly session cookie set by `POST /auth/login`.
Every non-GET request must include the header `X-Requested-With: XMLHttpRequest` (CSRF marker).
Errors have the shape `{ "error": { "code": "...", "message": "...", "details": {...} } }`.

## Authentication
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{username, password}` → `{user}` + session cookie. Usernames are case-insensitive. Throttled. |
| POST | `/auth/logout` | Revokes the session. |
| GET | `/me` | Current user, cycle status, app info. |
| POST | `/me/password` | `{current_password, new_password}`. |

## AI (also available under the legacy `/claude/*` paths)
| Method | Path | Notes |
|---|---|---|
| GET | `/ai/status` | Key source (user/server/none), masked last-4, model, web search + provider status. |
| POST | `/ai/test` | Sends a tiny request with the active key → `{ok, model, latency_ms}` or `{ok:false, error}`. |
| POST | `/ai/key` | `{api_key, provider?}` – stored encrypted; returns status. |
| DELETE | `/ai/key` | Removes the personal key. |

## Leads (contacts)
| Method | Path | Notes |
|---|---|---|
| GET | `/leads` | Filters: `contact_type, list_id, status, interest_level, meeting_status, data_status, city, niche, company_size, website_available, follow_up, cycle, generated_from, generated_to, search, sort, limit, offset, employee_id (owner)`. Employees only see contacts they currently own. |
| GET | `/leads/filters` | Distinct cities/niches/cycles for filter UIs. |
| POST | `/leads/generate` | `{contact_type, niche_ids[], count, run_first_batch}` – creates/continues this cycle's list and runs one batch. |
| GET | `/leads/:id` | Full record: contact, call history, follow-ups, meetings, rotation history, research. |
| GET | `/leads/:id/calls` | Chronological call records. |
| POST | `/leads/:id/call` | Call record (see fields below). |
| POST | `/leads/:id/follow-up` | `{follow_up_date, follow_up_time?, reason, notes?, contact_person?}`. |
| POST | `/leads/:id/skip` | `{reason}` (required) – marks processed for this cycle without a call. |
| PATCH | `/leads/:id/notes` | `{notes}`. |
| POST | `/leads/:id/research` | `{kind: meeting_prep|booking_analysis, web_search?}` – Claude analysis stored in `lead_research`. |

Call record fields: `call_status*` (`no_answer, call_back_later, interested, not_interested, meeting_booked, wrong_number, business_closed, follow_up_required`), `person_contacted, person_designation, conversation_summary` (required for real conversations), `customer_response, interest_level` (`interested, not_interested, maybe_follow_up, meeting_requested, meeting_booked, no_clear_interest`), `services_discussed, problems_identified, objections, follow_up_required, next_follow_up_date, meeting_required, additional_notes, call_datetime, panel_fields`.

Strategy `panel_fields`: `asked_about_online_booking, has_website, current_booking_method, offers_online_appointments, latechs_introduced, website_development_discussed, interested_in_website, interested_in_booking_system`.
Service `panel_fields`: `business_contacted, decision_maker_reached, decision_maker_name, decision_maker_designation, meeting_requested, meeting_booked, automation_opportunities_discussed, services_interested, meeting_outcome`.

## Lists & generation
| Method | Path | Notes |
|---|---|---|
| GET | `/lists` | Active lists visible to the user with per-cycle stats. `contact_type, status, owner_id (owner), include_completed`. |
| GET | `/lists/:id` | One list with stats. |
| GET | `/lists/:id/next` | Next unprocessed, non-terminal contact + progress. |
| POST | `/lists/generate` | Same as `/leads/generate`. |
| POST | `/lists/:id/generate` | Runs the next batch (`{force}` unlocks a stale batch). Poll until status is `completed`/`exhausted`. |
| GET | `/generation/:jobId` | Job counters + recent rejections. |
| POST | `/generation/:jobId/cancel` | Cancels a job. |

## Rotation
| Method | Path | Notes |
|---|---|---|
| GET | `/rotation/status` | Cycle info, lists, recent runs. |
| GET | `/rotation/overview` | Owner: chain, active/completed lists, history, runs, settings. |
| POST | `/rotation/run` | Owner: `{force}` – idempotent. |
| POST | `/rotation/transfer` | Owner: `{list_id, new_owner_id}` manual transfer. |
| ALL | `/rotation/cron` | `Authorization: Bearer <CRON_SECRET>` – rotate if due, continue generation, clean sessions. |

## Meetings
| Method | Path | Notes |
|---|---|---|
| GET | `/meetings` | `from, to, owner_id, status, contact_id`. Visible to everyone; `can_manage` per item. |
| POST | `/meetings/check` | `{meeting_date, start_time, end_time?, exclude_id?}` → `{available, conflicts}`. |
| POST | `/meetings` | `{business_name, business_contact_id?, meeting_type*, meeting_date*, start_time*, end_time?, contact_person, phone_number, location, online_link, notes, idempotency_key?, meeting_owner_id (owner)}`. `409` on overlap. |
| PATCH | `/meetings/:id` | Owner of the meeting or admin. Any field above + `meeting_status` + `outcome{...}`. |
| DELETE | `/meetings/:id` | Cancels (record kept). |

## Follow-ups
| Method | Path | Notes |
|---|---|---|
| GET | `/follow-ups` | `status, due (today|overdue|upcoming|due), from, to, contact_id, owner_id (owner)`. |
| GET | `/follow-ups/summary` | Counts. |
| PATCH | `/follow-ups/:id` | `{status, notes, follow_up_date, follow_up_time}`; rescheduling creates a linked new record. |

## Settings, niches, admin, dashboard
| Method | Path | Notes |
|---|---|---|
| GET | `/settings` | User settings + Claude status (+ system settings for owner). |
| PATCH | `/settings/user` | `{selected_strategy_niches, selected_service_niches, lead_generation_preferences, notification_preferences}`. |
| PATCH | `/settings/system` | Owner: `rotation_interval_days, list_size, list_max_rotations, rotation_enabled, auto_generate_after_rotation, generation_batch_size, timezone, target_cities, default_meeting_duration_minutes`. |
| GET | `/settings/system/status` | Owner: DB health, counts, generation jobs, environment flags. |
| GET/POST/PATCH | `/niches`, `/niches/:id` | List (all users); create/update (owner). |
| GET | `/admin/activity` | Audit log with `action, user_id, from, to, limit, offset`. |
| GET | `/admin/analytics` | Team analytics. |
| GET | `/admin/contacts` | All contacts with the same filters as `/leads`. |
| GET | `/admin/search?q=` | Global business search. |
| GET | `/admin/employees` | Per-employee stats. |
| GET/PATCH | `/admin/users`, `/admin/users/:id` | User management (`display_name, account_status, participates_in_rotation, new_password`). |
| GET | `/overview` | Dashboard data for the current user (team section for owner). |
| GET | `/activity` | The user's own relevant activity. |
| GET | `/users` | Names/roles for pickers. |
| GET | `/health` | Public liveness + DB check. |
