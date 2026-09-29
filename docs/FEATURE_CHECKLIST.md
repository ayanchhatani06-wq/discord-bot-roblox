# Feature checklist

Every requested feature, with its real status. Nothing here is marked done
unless it is implemented **and** covered by tests.

Status key: ✅ done · 🟡 partial (stated exactly) · ⬜ not started

Last updated: stage 1 complete (200 tests passing).

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
| Configurable automatic messages (confirmation, production start, previews, delivery, chase) | ⬜ stage 3 |
| Digest for bulk orders instead of per-item spam | ⬜ stage 3 |
| Post-delivery check-ins and review requests | ⬜ stage 3 |
| Repeat-order reminders | ⬜ stage 3 |
| Cross-service offers (rigging after modelling, VFX with animation) | ⬜ stage 3 |
| Owner-approved templates only | ⬜ stage 3 |
| Promotional opt-in, easy stop, configured send limit | ⬜ stage 3 |
| Pause offers during complaints or delivery problems | ⬜ stage 3 |
| Client reply pauses the sequence and notifies staff | ⬜ stage 3 |
| Sent-message history, duplicate prevention, failures flagged | ⬜ stage 3 |

## 4. New enquiries and quotes

| Item | Status |
| --- | --- |
| Enquiry form (service, quantity, references, formats, deadline, budget, notes) | ⬜ stage 4 |
| Routed to relevant leader and owner | ⬜ stage 4 |
| Draft quote from configured templates | ⬜ stage 4 |
| Owner approves all prices and delivery commitments before sending | ⬜ stage 4 |
| Stages: New, Needs Information, Quote Prepared, Quote Sent, Accepted, Declined, Closed | ⬜ stage 4 |
| Accepted quote becomes a project without re-entering the brief | ⬜ stage 4 |

## 5. Client records and repeat orders

| Item | Status |
| --- | --- |
| Order history per client | ✅ |
| Project preferences and recurring requirements | ⬜ stage 5 |
| Approved communication contacts | ✅ |
| Follow-up preferences | ⬜ stage 3 |
| Duplicate a previous order as a draft | ⬜ stage 5 |
| Confirm new scope, price and deadline on duplication | ⬜ stage 5 |
| Finder attribution, agreed compensation, follow-up ownership | 🟡 finder share and per-client attribution built; follow-up ownership in stage 5 |
| Flag possible duplicate client records | ✅ |

## 6. Better task planning

| Item | Status |
| --- | --- |
| Reusable task templates and batch creation | 🟡 bulk creation built; named templates in stage 6 |
| Pre-offer completeness check (brief, references, pay, deadline, deliverables) | ⬜ stage 6 |
| Dependencies (Model → Rig → Animation) | ⬜ stage 6 |
| Notify the next group when required files are ready | ⬜ stage 6 |
| Flag affected downstream deadlines without changing them | ⬜ stage 6 |
| Artist "I'm Blocked" button with reason and attachment | ⬜ stage 6 |
| Deadline-extension requests preserving the previous date and approver | ⬜ stage 6 |
| Capacity and workload views for leaders | 🟡 counts and local times built; fuller view in stage 6 |

## 7. Shared work and compensation

| Item | Status |
| --- | --- |
| Multiple contributors per deliverable with defined responsibilities | ⬜ stage 7 |
| Owner-approved separate compensation per contribution | ⬜ stage 7 |
| Each contributor sees only their own terms | ⬜ stage 7 |
| Client revenue, artist pay, leader/finder shares, bonuses, studio allocations kept distinct | 🟡 all but bonuses built |
| Prevent allocations silently exceeding the configured budget | ⬜ stage 7 |
| Configurable bonus milestones (e.g. every 10 approved videos) | ⬜ stage 7 |
| Milestones flagged for owner approval, no double counting | ⬜ stage 7 |

## 8. Staff onboarding and trials

| Item | Status |
| --- | --- |
| Onboarding collecting profile, timezone, specialties, software, portfolio, availability | ✅ already built |
| Show procedures and record acknowledgement of the current version | ⬜ stage 8 |
| Trial briefs with explicit terms, deadlines, submissions, feedback | ⬜ stage 8 |
| Leader recommendations; promotion follows configured permissions | ⬜ stage 8 |
| Temporary backup leaders with expiry and recorded responsibilities | ⬜ stage 8 |
| Offboarding: remove access, flag unfinished tasks, missing files, outstanding pay | 🟡 soft-removal built; flagging in stage 8 |
| Historical records preserved | ✅ already built |

## 9. Personal and management dashboards

| Item | Status |
| --- | --- |
| My Desk (offers, assignments, deadlines, blockers, revisions, history, earnings, controls) | 🟡 parts exist as separate commands; single desk in stage 9 |
| Group Desk (unassigned, capacity, offers, reviews, blockers, client waits) | 🟡 as above |
| Owner Desk (projects, decisions, workload, quotes, receipts, payouts, exceptions) | 🟡 as above |

## 10. Files and delivery

| Item | Status |
| --- | --- |
| Submission versions with a marked latest approved version | 🟡 versions built; approved-version marker in stage 10 |
| Configurable delivery checklists per service | 🟡 per-department checklists built; delivery-specific in stage 10 |
| Check required files supplied, without claiming quality checks | 🟡 partial |
| Internal source links separate from client-authorized files | 🟡 release gate built in stage 1; per-file rights in stage 10 |
| Record who authorized delivery, which version, and when | ⬜ stage 10 |
| Release according to configured delivery conditions | ⬜ stage 10 |
| Searchable archive filtered by project, artist, asset type, permission | ⬜ stage 10 (candidate for the website) |
| Portfolio rights: staff/studio use, start date, client restrictions | ⬜ stage 10 |

## 11. Issues, revisions, and support

| Item | Status |
| --- | --- |
| Client reports a delivery issue against a specific item | 🟡 record and routing built; client-facing flow in stage 2 |
| Distinguish in-scope correction from additional work | 🟡 scope flagging built; issue flow in stage 11 |
| Manager decides disputes; owner approves additional charges | 🟡 partial |
| Private staff escalation route for assignment or pay concerns | ⬜ stage 11 |
| Pause promotional messages while an issue is open | 🟡 the check exists; used once messaging lands in stage 3 |
| Decisions and feedback linked to the project, not scattered | ✅ already built |

## 12. Reports and useful automation

| Item | Status |
| --- | --- |
| Scheduled summaries | ✅ already built |
| Filters: deliverables, overdue, waiting time, unassigned, revisions, payouts, repeat orders, enquiries | ⬜ stage 12 |
| Separate client-caused waiting from artist delay | ⬜ stage 12 |
| Avoid ranking staff on task counts alone | ⬜ stage 12 (design rule) |
| Owner-configurable automation rules with effect preview | ⬜ stage 12 (candidate for the website) |

## 13. Access, reliability, and ease of use

| Item | Status |
| --- | --- |
| Access checked on every command and button | ✅ already built |
| Access checked on search results, attachments and client answers | 🟡 client answers done; archive search in stage 10 |
| Clients see only their own projects and client-safe information | ✅ |
| Internal pay, staff feedback and private discussion never client-visible | ✅ |
| Persistent storage, duplicate protection, audit trail | ✅ already built |
| Scheduled-job recovery | ✅ reminder state survives restarts |
| Backups and restore instructions | 🟡 documented; owner-controlled export in stage 13 |
| Owner-controlled exports | ⬜ stage 13 |
| Configurable notifications, quiet hours, batching | ✅ already built |
| Recovery when a DM fails, a ticket closes, or a board is deleted | ✅ |
| Setup wizard, demonstration project | ✅ already built |
| Role-based help | ⬜ stage 9 |
| Buttons and short forms over long command lists | 🟡 ongoing design rule |

## Website interface

| Item | Status |
| --- | --- |
| Discord OAuth2 login mapped to the existing capability model | ⬜ final stage |
| Owner dashboard, archive search, automation rule builder with preview | ⬜ final stage |
| Client-facing project view | ⬜ final stage |

---

## Stage plan

1. **Client identity, dashboard and version-bound approvals** — §1, §2, client parts of §13
2. **Client issues and staff escalation** — §11 (needs stage 1)
3. **Client messaging automation** — §3 (needs stages 1–2)
4. **Enquiries and quotes** — §4
5. **Client records and repeat orders** — §5
6. **Task planning: templates, dependencies, blockers, extensions** — §6
7. **Multi-contributor pay, budget guards, bonus milestones** — §7
8. **Onboarding, trials, backup leaders, offboarding** — §8
9. **The three desks and role-based help** — §9
10. **Files, delivery authorization, archive, portfolio rights** — §10
11. **Reports, filters and automation rules** — §12
12. **Exports and restore tooling** — §13
13. **Website interface** — reusing `db/repos` and `domain` unchanged
