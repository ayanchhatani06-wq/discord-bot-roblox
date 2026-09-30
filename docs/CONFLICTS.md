# Where the handbooks and the bot disagree

Read from:

- **Staff Payment & Work Guidelines** v2, 27 Sep 2026
- **Leader Handbook** v1, 26 Sep 2026
- **Builder Recruitment & Payment Setup — Summary for Leads**, 26 Sep 2026

against what the bot actually does. Four real conflicts, two smaller ones, and
one thing the bot already solves that the handbooks flag as unresolved.

None of this is a bug in the handbooks or the bot on its own. They were written
apart, and they now have to agree — because a promise in a handbook that the
system cannot keep is the promise you get held to.

---

## 1 · When somebody gets paid — the big one

**The handbook says** (Staff Guidelines §3): *"payment is released once the task
is completed and approved."*

**The bot says:** a task becomes payable when it is client-approved **and the
client money already received covers what that task owes.** That is the rule you
chose deliberately — nothing is paid out of money that has not arrived.

These are different triggers. Approval is not payment.

**What actually happens today:** an artist finishes, all three sign off, and the
bot still shows *pending client payment* because the client has not paid yet.
The artist reads the handbook, sees "completed and approved", and asks where
their money is. They are right to.

**The fix is a deposit.** If you take a deposit before work starts, that money is
in, and the bot marks the work payable the moment it is approved — which makes
the handbook true. Without a deposit you are promising a payment date you do not
control, because it depends on when the client pays you.

Three options, in the order I would take them:

| Option | What it costs |
|---|---|
| **Take a deposit** that covers the artist pay on the tasks you start | Nothing. This is what the milestone feature was built for — `/deposit add` |
| **Change §3** to "once the task is approved and the client's payment for it has been received" | Honest, but it moves the risk onto your artists, who will notice |
| **Pay out of studio funds** when a client is slow | `/finance mark-payable` with your reason on the record. Fine occasionally, dangerous as a habit |

Whichever you pick, §3 and the bot should say the same thing.

---

## 2 · The recruiter's 20% cannot be recorded

**The Leader Handbook says** (§5): *"If you recruit someone and they go on to get
paid for a task, you get 20% of their pay."* The Builder summary confirms it was
agreed with danisaads specifically, for VFX, GFX, SFX, GUI and animation
recruits.

**The bot has four split recipients:** `finder`, `leader`, `mod`, `owner`. There
is no recruiter.

It is not just a missing name. The bases are different:

- Finder, leader, mod and owner are percentages of the **leftover pool** — what
  is left after the artist is paid — and they must add up to 100%.
- The recruiter's cut is 20% **of the artist's pay**, a different number
  entirely.

So it cannot be bolted on as a fifth share without either taking from the other
four or changing what the percentages are a percentage of.

**Right now that cut has to be paid and tracked by hand**, outside the bot, which
means it is the one payment with no record — on the arrangement with the person
you have already promised it to.

**Options:**

| Option | Notes |
|---|---|
| **Add a recruiter payout kind** to the bot, paid off the artist's pay rather than the pool | The honest fix. It is real work but not large, and it is the only one that leaves a record |
| **Fold it into the finder share** when they are the same person | Only works when they are, which for danisaads they may not be |
| **Pay it by hand and record it as a note** | Works today, leaves the least evidence, and this is exactly the kind of arrangement that gets disputed |

Say the word and I will build the first one.

---

## 3 · "Three sign-offs" is not what the bot does

**The handbook says** (Staff Guidelines §4): a task is payable once it clears
*"all three sign-offs: studio owner, lead, and client."*

**The bot does:** lead reviews the work (`/review decide`) → the client's
decision is recorded (`/review client`) → the owner authorises release
(`/deliver release`).

The owner's involvement is real, but it is at a different point. The owner
approves the **pay** before work is offered, and authorises the **delivery** at
the end. There is no separate owner review of the work itself between the lead
and the client.

That is arguably better — the owner reviewing every piece is what makes a studio
slow — but it is not what the handbook describes, and an artist could reasonably
claim a task was paid without a sign-off the handbook promised.

**Suggested wording for §4:** *"A task is payable once your lead has passed it,
the client has approved it, and the owner has authorised delivery."* That is
three sign-offs, it is true, and it matches what happens.

---

## 4 · Leads were promised channels the new layout does not have

**The Leader Handbook says** (§7) leads get *"their team's chat, applications,
task-progress, review, payment, and completed-work channels"*, and lists the
Builder set:

`[team]-chat` · `[team]-applications` · `task-progress` · `[team]-reviews` ·
`completed-work` · `task-payments` · `payment-logs` · `projects-done` ·
`client-feedback`

**The agreed layout has none of them**, because the bot does those jobs:

| Promised channel | What replaced it |
|---|---|
| `task-progress` | `/work progress` — private, DMs the lead |
| `[team]-reviews` | `/review queue` |
| `completed-work`, `projects-done` | `/archive`, `/archive portfolio` |
| `task-payments`, `payment-logs` | `/finance ledger`, `/finance outstanding`, `#studio-audit` |
| `client-feedback` | Recorded against the version approved; `/work history` |
| `[team]-applications` | `#apply` + `/recommend new` |
| `[team]-chat` | `#staff-chat`, or one channel per craft if you want them |

The Builder summary already flags that this structure was *"verbally agreed but
not yet built"* — so nothing has been taken away yet. But danisaads was told he
would get it.

**This needs a conversation with him, not a quiet change.** The honest version
is: you are getting better than that, because `/desk group` shows you your queue,
your team's load, what is waiting on your review and what is at risk — in one
place, always current, instead of seven channels you have to read. But he should
hear it from you before he goes looking for channels that do not exist.

The Leader Handbook §7 also says *"you tell the studio what your team needs — the
studio doesn't hand you a fixed list."* Worth keeping that spirit: show him the
desk first and ask what is still missing.

---

## 5 · "20% of the profit" is undefined

**The handbook says** (Staff Guidelines §14): the finder gets *"20% of the profit
from that client's work."*

**The bot computes:** the client payment minus the artist's pay = the pool.
Finder 20%, lead 20%, mod 10%, owner 50% of that.

"Profit" could mean that, or it could mean after other costs too. It has not
bitten yet because nobody has asked. It will.

**Suggested wording:** *"20% of what is left from that client's payment after the
artists on the job are paid."* That is what the bot calculates, and it is
unambiguous.

---

## 6 · Scripting

The Staff Guidelines exclude scripters from the hiring track (§2). The bot ships
a **Scripting** department by default, and `#services` would advertise it.

Either archive it — `/studio department key:scripting archived:true`, and it
stops appearing on the boards — or decide scripters are handled on different
terms and say what those are. Right now the bot is set up to route scripting work
to a track your own handbook says does not exist.

The `#services` copy in `CHANNEL-CONTENT.md` already leaves scripting out. Put it
back if that changes.

---

## 7 · One thing the bot already solves

The Builder summary spends most of its Payment section on an unresolved problem:
payment goes out by Ziina link or card, **a fee of roughly 5–10% gets taken on
the way**, the rate is unconfirmed, and JOTAKA has said he will not absorb it.

That is a sent-versus-landed problem, and the bot now records exactly that:

- `/finance pay` — you sent it
- `/finance confirm-received` — they say it arrived
- `/finance mark-failed` — it was sent and never arrived
- `/finance sent` — everything nobody has confirmed either way

So when an artist receives $18 of a $20 payment, you record $20 sent, they
confirm what landed, and the gap is on the record instead of being an argument
three weeks later.

**What it does not do is decide who absorbs the fee.** That is still yours to
settle, and it should be one line in the Staff Guidelines §3 — because right now
it is only written down in a summary of a Discord conversation at 4am.

---

## Also still open, from your own documents

The Leader Handbook §12 flags these itself. They are still open:

- **The fee rate.** Roughly 5–10% came from an example, not from Ziina's actual
  schedule. Worth ten minutes to check and write down.
- **Stacking cuts.** If a lead brings in a client *and* recruits the artist who
  does that client's work — is that 20% + 20%? Nothing says.
- **Non-builder teams.** The roles, specialisations and structure are the Builder
  team's. VFX, animation, GFX, GUI and SFX need their own, not an assumption that
  they match.

---

## What I would do, in order

1. **Decide the deposit** — it unblocks conflict 1, which is the one your artists
   will notice first.
2. **Talk to danisaads** about the channels before he looks for them.
3. **Tell me whether to build the recruiter split.** Until it exists, that cut is
   the only money moving through the studio with no record.
4. Fix §3, §4 and §14 wording to match what actually happens.
5. Archive scripting, or write its terms.
