# Feature checklist

Every requested feature, with its real status. Nothing here is marked done
unless it is implemented **and** covered by tests.

Status key: ✅ done · 🟡 partial (stated exactly) · ⬜ not started

Last updated: stages 1, 2, 4, 6, 9 and 10 complete (287 tests passing). Website scope
revised: it is the studio's public site (services, portfolio, quote request),
not only an internal dashboard.

---

## Already delivered (original build)

| # | Feature | Status |
| --- | --- | --- |
| — | Staff profiles, specialties, software, portfolio, Roblox name | ✅ |
| — | IANA timezones, DST-correct, `/time` member and department views | ✅ |
| — | Auto-refreshing per-department staff boards with "updated" stamp | ✅ |
| — | Availability separate from Discord presence | ✅ |
| — | Projects, bulk orders expanding into per-department tasks | ✅ |
| — | Leader-chosen assignment with candidate shortlists, no auto-assign | ✅ |
| — | Owner-set pay; leaders propose only; offers blocked until approved | ✅ |
| — | DM offers with accept/decline, private-channel fallback | ✅ |
| — | Submissions with enforced deliverables checklist | ✅ |
| — | Internal review distinct from client approval | ✅ |
| — | Staff-recorded client decisions with evidence and audit | ✅ |
| — | Payment tracking, per-currency ledger, finder/leader/mod/owner splits | ✅ |
| — | Reminders with escalation, quiet hours, batching | ✅ |
| — | Weekly management summary | ✅ |
| — | Reassignment, absence alerts, holds, cancellation, compensation | ✅ |
| — | Guided setup wizard, sample project, audit log | ✅ |

---

## 1. Client dashboard and project questions

| Item | Status |
| --- | --- |
| Link projects to authorized client Discord accounts | ✅ |
| Link project to private ticket/channel | ✅ |
| Dashboard buttons: View Progress | ✅ |
| Dashboard buttons: View Previews | ✅ |
| Dashboard buttons: Request Changes | ✅ |
| Dashboard buttons: Ask a Question | ✅ |
| Dashboard buttons: View Deliverables | ✅ |
| Dashboard buttons: Request Another Service | ✅ |
| Dashboard buttons: Contact Manager | ✅ |
| Answer the 8 listed questions from real records | ✅ |
| Distinguish in-progress / internally reviewed / awaiting client / approved / delivered | ✅ |
| "Last updated" shown on every answer | ✅ |
| Say so when a deadline or update is missing, and offer to notify the manager | ✅ |
| Never invent percentages, delay reasons or delivery promises | ✅ |
| Questions never change project records | ✅ |
| Optional natural-language layer, access-scoped, with working fallback | ⬜ deferred by design — deterministic answers first |

## 2. Client feedback and approvals

| Item | Status |
| --- | --- |
| Approve / request-changes buttons on reviewed submissions | ✅ |
| Only authorized client accounts can approve | ✅ |
| Approval bound to exact task **and** submission version | ✅ |
| Outdated approval controls disabled | ✅ |
| Written feedback plus reference attachments | ✅ |
| Routed to the correct group leader and artist | ✅ |
| Partial approval of bulk orders (one item ≠ whole project) | ✅ |
| Staff-recorded approvals retained with evidence and audit | ✅ already built |

## 3. Client updates and follow-ups

| Item | Status |
| --- | --- |
| Configurable automatic messages (confirmation, production start, previews, delivery, chase) | ✅ (`/outreach template-set`, attached to events) |
| Digest for bulk orders instead of per-item spam | ✅ (previews and deliveries are held briefly and folded into one message) |
| Post-delivery check-ins and review requests | ✅ (daily sweep, 7 and 14 days after the last delivery) |
| Repeat-order reminders | ✅ (opted-in past clients with nothing live, at most once a quarter) |
| Cross-service offers (rigging after modelling, VFX with animation) | ✅ (`/outreach offer`, owner-triggered per order) |
| Owner-approved templates only | ✅ (a draft never sends; rewriting withdraws the approval) |
| Promotional opt-in, easy stop, configured send limit | ✅ (`/outreach prefs`; a recorded stop beats a stale opt-in) |
| Pause offers during complaints or delivery problems | ✅ (an unresolved problem blocks every automated message, not just offers) |
| Client reply pauses the sequence and notifies staff | ✅ (queued promotional messages are cancelled; the follow-up owner is told) |
| Sent-message history, duplicate prevention, failures flagged | ✅ (`/outreach history` and `queue`; the dedupe key is a database constraint) |

## 4. New enquiries and quotes

| Item | Status |
| --- | --- |
| Enquiry form (service, quantity, references, formats, deadline, budget, notes) | ✅ |
| Routed to relevant leader and owner | ✅ |
| Draft quote from configured templates | ✅ |
| Owner approves all prices and delivery commitments before sending | ✅ |
| Stages: New, Needs Information, Quote Prepared, Quote Sent, Accepted, Declined, Closed | ✅ |
| Accepted quote becomes a project without re-entering the brief | ✅ |

## 5. Client records and repeat orders

| Item | Status |
| --- | --- |
| Order history per client | ✅ |
| Project preferences and recurring requirements | ✅ (`/clients add-requirement`; shown on the task and on the offer, not buried in the client record) |
| Approved communication contacts | ✅ |
| Follow-up preferences | ✅ (`/outreach prefs`: opt-in, weekly limit, pause, follow-up owner) |
| Duplicate a previous order as a draft | ✅ (`/repeat from`; a draft is its own thing, invisible to queues, boards and the ledger) |
| Confirm new scope, price and deadline on duplication | ✅ (each confirmed separately and stamped with who confirmed it; last time's price and deadline are never carried over) |
| Finder attribution, agreed compensation, follow-up ownership | ✅ (finder carries across repeat orders; follow-up owner set with `/outreach prefs`) |
| Flag possible duplicate client records | ✅ |

## 6. Better task planning

| Item | Status |
| --- | --- |
| Reusable task templates and batch creation | ✅ |
| Pre-offer completeness check (brief, references, pay, deadline, deliverables) | ✅ |
| Dependencies (Model → Rig → Animation) | ✅ |
| Notify the next group when required files are ready | ✅ |
| Flag affected downstream deadlines without changing them | ✅ |
| Artist "I'm Blocked" button with reason and attachment | ✅ (`/work blocked`, surfaced on every desk) |
| Deadline-extension requests preserving the previous date and approver | ⬜ stage 6 |
| Capacity and workload views for leaders | ✅ (Group Desk) |

## 7. Shared work and compensation

| Item | Status |
| --- | --- |
| Multiple contributors per deliverable with defined responsibilities | ✅ (`/contrib add`) |
| Owner-approved separate compensation per contribution | ✅ (leader proposes with `/contrib pay`, owner approves) |
| Each contributor sees only their own terms | ✅ (`/contrib list` hides colleagues' figures from non-finance staff) |
| Client revenue, artist pay, leader/finder shares, bonuses, studio allocations kept distinct | ✅ |
| Prevent allocations silently exceeding the configured budget | ✅ (refused outright; `/finance budget-override` is the only way past, and it is recorded) |
| Configurable bonus milestones (e.g. every 10 approved videos) | ✅ (`/bonus rule-set`) |
| Milestones flagged for owner approval, no double counting | ✅ (milestone index is unique per rule and person) |

## 8. Staff onboarding and trials

| Item | Status |
| --- | --- |
| Onboarding collecting profile, timezone, specialties, software, portfolio, availability | ✅ already built |
| Show procedures and record acknowledgement of the current version | ✅ (`/procedure`; an edit raises the version and makes earlier acknowledgements stale) |
| Trial briefs with explicit terms, deadlines, submissions, feedback | ✅ (`/trial`; accepted terms are snapshotted) |
| Leader recommendations; promotion follows configured permissions | ✅ (`/recommend`; the bot never grants a Discord role) |
| Temporary backup leaders with expiry and recorded responsibilities | ✅ (`/people stand-in`; expiry is checked on every permission lookup) |
| Offboarding: remove access, flag unfinished tasks, missing files, outstanding pay | ✅ (`/people offboard preview` and `start`; nothing is deleted) |
| Historical records preserved | ✅ already built |

## 9. Personal and management dashboards

| Item | Status |
| --- | --- |
| My Desk (offers, assignments, deadlines, blockers, revisions, history, earnings, controls) | ✅ |
| Group Desk (unassigned, capacity, offers, reviews, blockers, client waits) | ✅ |
| Owner Desk (projects, decisions, workload, quotes, receipts, payouts, exceptions) | ✅ |

## 10. Files and delivery

| Item | Status |
| --- | --- |
| Submission versions with a marked latest approved version | ✅ |
| Configurable delivery checklists per service | ✅ |
| Check required files supplied, without claiming quality checks | ✅ |
| Internal source links separate from client-authorized files | ✅ |
| Record who authorized delivery, which version, and when | ✅ |
| Release according to configured delivery conditions | ✅ |
| Searchable archive filtered by project, artist, asset type, permission | ✅ (also feeds the website) |
| Portfolio rights: staff/studio use, start date, client restrictions | ✅ |

## 11. Issues, revisions, and support

| Item | Status |
| --- | --- |
| Client reports a delivery issue against a specific item | ✅ |
| Distinguish in-scope correction from additional work | ✅ |
| Manager decides disputes; owner approves additional charges | ✅ |
| Private staff escalation route for assignment or pay concerns | ✅ |
| Pause promotional messages while an issue is open | 🟡 enforced in data; applied once messaging lands |
| Decisions and feedback linked to the project, not scattered | ✅ already built |

## 12. Reports and useful automation

| Item | Status |
| --- | --- |
| Scheduled summaries | ✅ already built |
| Filters: deliverables, overdue, waiting time, unassigned, revisions, payouts, repeat orders, enquiries | ✅ (`/report filter`, nine filters phrased as plain questions) |
| Separate client-caused waiting from artist delay | ✅ (`/report waiting`, reconstructed from the audit trail) |
| Avoid ranking staff on task counts alone | ✅ (no score exists to sort by; the team list is in name order and says so) |
| Owner-configurable automation rules with effect preview | ✅ (`/automation`; rules start off, a preview costs one command, and each task is acted on once per rule) |

## 13. Access, reliability, and ease of use

| Item | Status |
| --- | --- |
| Access checked on every command and button | ✅ already built |
| Access checked on search results, attachments and client answers | ✅ |
| Clients see only their own projects and client-safe information | ✅ |
| Internal pay, staff feedback and private discussion never client-visible | ✅ |
| Persistent storage, duplicate protection, audit trail | ✅ already built |
| Scheduled-job recovery | ✅ reminder state survives restarts |
| Backups and restore instructions | ✅ (`/backup now`, `verify`, `restore`; uses SQLite's online backup, not a file copy) |
| Owner-controlled exports | ✅ (`/backup export`; CSV, with payment references deliberately left out) |
| Configurable notifications, quiet hours, batching | ✅ already built |
| Recovery when a DM fails, a ticket closes, or a board is deleted | ✅ |
| Setup wizard, demonstration project | ✅ already built |
| Role-based help | ✅ |
| Buttons and short forms over long command lists | 🟡 ongoing design rule |

## Website — the studio's public site

Confirmed scope: public marketing site, hosted on the same box as the bot but
as a **separate process**, quote-request only with no public prices, and a
client login that must also work for clients who are not in the Discord server.

| Item | Status |
| --- | --- |
| Public pages: services, portfolio, about, contact | ⬜ final stage |
| Quote request form feeding the same enquiry pipeline | 🟡 pipeline ready; web form pending |
| Portfolio populated only from assets the client permitted | 🟡 source of truth built (publishablePortfolio); web page pending |
| Separate web process, read-only on a curated subset | ⬜ final stage |
| Reverse proxy and TLS for a real domain | ⬜ needs a domain from the owner |
| Client login via Discord OAuth2 | ⬜ final stage |
| Client login via email magic link, for clients not in Discord | ⬜ final stage — needs an email provider and DNS records |
| Staff/owner dashboards, archive search, automation rule builder | ⬜ final stage |

---

## Stage plan

1. **Client identity, dashboard and version-bound approvals** — §1, §2, client parts of §13
2. **Client issues and staff escalation** — §11 (needs stage 1)
3. **Client messaging automation** — §3 (needs stages 1–2) ✅ done
4. **Enquiries and quotes** — §4
5. **Client records and repeat orders** — §5 ✅ done
6. **Task planning: templates, dependencies, blockers, extensions** — §6
7. **Multi-contributor pay, budget guards, bonus milestones** — §7 ✅ done
8. **Onboarding, trials, backup leaders, offboarding** — §8 ✅ done
9. **The three desks and role-based help** — §9
10. **Files, delivery authorization, archive, portfolio rights** — §10
11. **Reports, filters and automation rules** — §12 ✅ done
12. **Exports and restore tooling** — §13 ✅ done
13. **Website interface** — reusing `db/repos` and `domain` unchanged
