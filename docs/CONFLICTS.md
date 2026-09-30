# Where the handbooks and the bot disagree

Read from:

- **Staff Payment & Work Guidelines** v2, 27 Sep 2026
- **Leader Handbook** v1, 26 Sep 2026
- **Builder Recruitment & Payment Setup — Summary for Leads**, 26 Sep 2026

against what the bot actually does. **Two of the four are now settled in code. Two still need a decision from you,
and both are wording in your own handbooks.**

None of this is a bug in the handbooks or the bot on its own. They were written
apart, and they now have to agree — because a promise in a handbook that the
system cannot keep is the promise you get held to.

---

## 1 · When somebody gets paid — DECIDED, wording still to change

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
| **Take a deposit** that covers the artist pay on the tasks you start | Nothing. This is what the milestone feature was built for — `/money-in add` |
| **Change §3** to "once the task is approved and the client's payment for it has been received" | Honest, but it moves the risk onto your artists, who will notice |
| **Pay out of studio funds** when a client is slow | `/pay mark-payable` with your reason on the record. Fine occasionally, dangerous as a habit |

**You chose:** no fixed deposit. Jobs over $100 take 10–20% upfront, and a
client who will not pay upfront is billed per milestone instead. Set the parts
per order with `/money-in add`.

**Still to do:** Staff Guidelines §3 says pay is released *"once the task is
completed and approved."* With a 10–20% deposit that is often not yet true —
$15 in against $65 of artist pay. Change it to:

> *"Payment is released once the task is completed and approved, and the
> client's payment covering it has been received. This is why we bill in
> milestones: each one funds the work in it."*

That is what the bot does, and your artists will work it out for themselves
otherwise.

---

## 2 · The recruiter's 20% — BUILT ✅

**You chose:** 20% of the recruit's **first payout**, taken from that payout.

Client pays $50, artist's pay $35 → the artist receives **$28**, the recruiter
**$7**, and finder, lead, mod and owner are untouched at $3 / $3 / $1.50 / $7.50.
Your pool does not move; it is the artist paying their recruiter, once.

Record it with `/team recruited set person:@them recruiter:@danisaads`.

What the bot now refuses to get wrong:

- **Once only.** It is a fact on the person, not on a task, so paying them on
  two jobs cannot collect it twice.
- **It does not stack** on the finder's cut, per your answer.
- **It is rounded down**, so it can never exceed the payout it comes out of, and
  a payout too small to round leaves it unclaimed rather than spent.
- **It cannot be moved once taken** — that would pay the wrong person, or twice.
- **The artist is told before they accept.** The offer says *"you will receive
  $28.00"* in money, not as a percentage, because an agreed $35 that arrives as
  $28 is a broken promise however fair the rule is.

**Still to do:** Leader Handbook §5 reads as ongoing — *"they go on to get paid
for a task, you get 20% of their pay"*. It should say **first payout only**, and
that it does not apply where they also brought in the client.

## 3 · "Three sign-offs" is not what the bot does

**The handbook says** (Staff Guidelines §4): a task is payable once it clears
*"all three sign-offs: studio owner, lead, and client."*

**The bot does:** lead reviews the work (`/review decide`) → the client's
decision is recorded (`/review client`) → the owner authorises release
(`/send release`).

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

## 4 · The channels leads were promised — NO LONGER A CONFLICT ✅

You kept your department channels and added the studio ones alongside, so
nothing danisaads was promised has been taken away. `#studio-board` is extra, not
a replacement.

The only thing worth saying to him: `/go` and the group desk now show his queue,
his team's load, what is waiting on his review and what is at risk, in one place
and always current. The channels still work; they are no longer the only way to
see it.

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

Either archive it — `/setup department key:scripting archived:true`, and it
stops appearing on the boards — or decide scripters are handled on different
terms and say what those are. Right now the bot is set up to route scripting work
to a track your own handbook says does not exist.

The `#services` copy in `CHANNEL-CONTENT.md` already leaves scripting out. Put it
back if that changes.

---

## 7 · The payout fee — DECIDED ✅

The Builder summary spends most of its Payment section on an unresolved problem:
payment goes out by Ziina link or card, **a fee of roughly 5–10% gets taken on
the way**, the rate is unconfirmed, and JOTAKA has said he will not absorb it.

That is a sent-versus-landed problem, and the bot now records exactly that:

- `/pay pay` — you sent it
- `/pay confirm-received` — they say it arrived
- `/pay mark-failed` — it was sent and never arrived
- `/pay sent` — everything nobody has confirmed either way

So when an artist receives $18 of a $20 payment, you record $20 sent, they
confirm what landed, and the gap is on the record instead of being an argument
three weeks later.

**You chose: the artist receives what lands.** That matches what you said in the
Builder chat, and the bot records sent-versus-landed so the gap is visible rather
than argued about.

**Still to do:** one line in Staff Guidelines §3. Right now it exists only in a
summary of a 4am Discord conversation, which is not where somebody looks when
they are $2 short and wondering why.

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

## What is left, all of it in your handbooks

The bot is done. These are four wording changes, and each one is a promise that
currently reads differently from what happens:

1. **Staff Guidelines §3** — pay is released once approved *and the client's
   payment covering it has arrived* (conflict 1). Add the line about who absorbs
   the payout fee: the artist receives what lands (conflict 7).
2. **Leader Handbook §5** — the recruiter's 20% is the **first payout only**, and
   does not apply where they also found the client (conflict 2).
3. **Staff Guidelines §4** — *"your lead has passed it, the client has approved
   it, and the owner has authorised delivery"* (conflict 3).
4. **Staff Guidelines §14** — *"20% of what is left from that client's payment
   after the artists on the job are paid"* (conflict 5).

Then run `/setup department key:scripting archived:true` (conflict 6).
