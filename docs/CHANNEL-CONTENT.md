# Channel sheet

The final layout, who can see what, and the words to post in each one.

Written against the studio's own documents, not invented:

- **Staff Payment & Work Guidelines** (v2, 27 Sep 2026)
- **Leader Handbook** (v1, 26 Sep 2026)
- **Builder Recruitment & Payment Setup — Summary for Leads** (26 Sep 2026)

Where those state a policy, it is used as written. Where they leave something
open, it is left as a `[bracket]` rather than filled in — an invented number
becomes a promise the moment somebody reads it.

**Read `CONFLICTS.md` before posting any of this.** Four things in the handbooks
and the bot currently disagree, and two of them are about money.

Pin every one of these. A rule nobody can find is a rule nobody follows.

**Every block below is inside a code fence.** Copy what is between the fences and
nothing else — it is already written in Discord's own formatting, so `#` makes a
heading, `**` makes bold and `-#` makes small print once posted.

**Two things to do by hand after pasting:**

1. **Channel links.** Paste the text, then delete each `#channel-name` and retype
   it — Discord only turns it into a real link when you pick it from the
   autocomplete list. Plain pasted text stays plain text.
2. **Discord caps a message at 2000 characters.** Anything longer is split below
   into numbered messages. Post them in order in the same channel.

---

## The layout

27 channels in four categories, plus one per active client. Departments are
**roles**, not channels — the staff board covers all of them in one place.

```
👋 GREETINGS                     everyone, including clients
   👋・welcome
   🚪・goodbye
   ✅・verify
   📥・apply
   📢・announcements             one only — you currently have two
   🧾・transcripts

💬 MAIN HUB                      everyone, including clients
   📜・rules
   💬・general
   🎲・off-topic
   🛠️・services                   no prices — quote on request
   📄・terms
   🖼️・showcase                   only what /archive portfolio permits
   ⭐・vouches                    clients write, everyone reads
   🎫・request-a-quote            read-only front door
   🤖・bot-commands

🏢 CYLOPS · STAFF                staff only — clients must never see this
   📊・studio-board        🤖    every department, auto-refreshing
   📈・studio-summary      🤖    weekly digest
   🔔・studio-alerts       🤖    DMs that could not be delivered
   🔐・studio-audit        🤖    owner only
   📣・staff-announcements
   💼・staff-chat
   🙋・introductions
   ❓・help-desk
   📁・resources
   🧭・how-we-work
   💵・price-guide               leads + owner only
   📕・staff-rules

🤝 CLIENTS
   🤝・client-«name»             one per active client, private to them
```

🤖 = the bot posts here. Those four, plus each client channel, are the only
places it posts. Everything else it does is a private reply or a DM.

## Permissions

Deny `View Channel` for `@everyone` **on the CYLOPS · STAFF category** and allow
`@Staff`. Everything inside inherits, except the two overrides marked below.

| Channel | Who can see it | Who can post |
| --- | --- | --- |
| 👋 welcome | everyone | nobody |
| 🚪 goodbye | everyone | nobody |
| ✅ verify | everyone | everyone |
| 📥 apply | @Member | @Member |
| 📢 announcements | everyone | @Founder |
| 🧾 transcripts | @Staff | ticket bot |
| 📜 rules | everyone | nobody |
| 💬 general | @Member | @Member |
| 🎲 off-topic | @Member | @Member |
| 🛠️ services | everyone | nobody |
| 📄 terms | everyone | nobody |
| 🖼️ showcase | everyone | @Founder + leads |
| ⭐ vouches | everyone | **@Client only** |
| 🎫 request-a-quote | everyone | nobody |
| 🤖 bot-commands | @Member | @Member |
| 📊 studio-board | @Staff | **bot only** |
| 📈 studio-summary | @Staff | **bot only** |
| 🔔 studio-alerts | @Staff | **bot only** |
| 🔐 studio-audit | **@Founder only** ⚠️ | **bot only** |
| 📣 staff-announcements | @Staff | @Founder + leads |
| 💼 staff-chat | @Staff | @Staff |
| 🙋 introductions | @Staff | @Staff |
| ❓ help-desk | @Staff | @Staff |
| 📁 resources | @Staff | @Staff |
| 🧭 how-we-work | @Staff | @Founder |
| 💵 price-guide | **leads + @Founder** ⚠️ | leads + @Founder |
| 📕 staff-rules | @Staff | @Founder |
| 🤝 client-«name» | that client + @Staff | that client + @Staff |

⚠️ The two that break category inheritance, and both matter:

- **🔐 studio-audit** names pay figures and client decisions.
- **💵 price-guide** is artist pay. The Staff Guidelines put the split system
  under the NDA, so this channel is covered by it. A client seeing it next to
  what they are charged is a conversation you do not want.

**Deny Send Messages in the three bot channels even for @Staff.** Buttons still
work — Accept and Decline on a task offer are interactive components and are not
affected by send permission — so 🔔 studio-alerts stays clean and people can
still act on what lands there.

## The bot's own permissions

`@Cylops-bot` needs **View Channel + Send Messages + Embed Links** in:

- 📊 studio-board · 📈 studio-summary · 🔔 studio-alerts · 🔐 studio-audit
- every 🤝 client channel

Nothing anywhere else. Put its role **above** the craft and lead roles, then run
`/studio doctor` — it checks it can actually post where you pointed it and names
the missing permission rather than failing silently.

## Setting the channels up

```
/studio channel purpose:Staff info board              channel:#studio-board
/studio channel purpose:Weekly management summary     channel:#studio-summary
/studio channel purpose:DM fallback (private staff)   channel:#studio-alerts
/studio channel purpose:Audit log                     channel:#studio-audit
/studio reminders board_refresh_minutes:10
/studio refresh
/studio doctor
```

Then map each craft role to its department so the queues and leader permissions
work:

```
/studio department key:building name:Building leader_role:@Lead Builder member_role:@Builder
```

…and archive the crafts you do not run: `/studio department key:sfx archived:true`.

---


## 👋・welcome

````
# Welcome to Cylops Studio

We build for Roblox — **models, maps, animation, VFX, UI, GFX and sound.**

**Want work done?** Read #services, then post in #request-a-quote.
**Want to work with us?** Read #apply.

Get verified in #verify first, then read #rules.

Every job is quoted individually, because no two are the same size. Ask and you
get a real number for your actual job.

-# We never DM you first asking for payment. If someone does, it isn't us.
````

---

## 📜・rules

**Post as four messages.** Each is under 2000 characters.

### Message 1 — everyone

````
# Rules

These apply to everyone here — clients, staff and visitors.

**1. Be decent to people.**
No harassment, no slurs, no going after someone's work to make a point.
Disagree with the thing, not the person.

**2. English in public channels.**
So staff can moderate what they can read. Any language you like in DMs.

**3. Nothing NSFW, ever.**
Not in chat, not in a portfolio link, not as a profile picture.

**4. No spam and no mass pings.**
Don't ping @everyone, don't ping the owner repeatedly, don't repost the same
message across channels. We read everything — pinging twice doesn't move you up.

**5. Don't share anyone's personal information.**
Real names, ages, locations, socials, screenshots of private DMs. Not yours to
share, not even as a joke.

**6. No advertising other studios or services.**
No exceptions, including in DMs to our members.

**7. One account each.**
No alts. If you were removed, you were removed — coming back on a second account
makes it permanent.

**8. Right channel, right thing.**
Chat in #general, off-topic in #off-topic, your job in your own order channel.
````

### Message 2 — ordering

````
## If you're ordering from us

**9. Every job starts in #request-a-quote.**
Don't DM staff to arrange work privately. A private deal is one nobody can back
you up on when it goes wrong — including us, and including you.

**10. Don't haggle in public.**
If a price doesn't work, say so in your order channel and we'll talk about
scope instead. Scope is negotiable. Public pressure isn't.

**11. No middlemen we didn't agree to.**
If someone offers to "hold" the payment between us, stop and tell us before you
send anything. That is the single most common scam in this space.

**12. Be reachable.**
Approvals are what unblock the next stage. If you go quiet for a long time we
will pause your order rather than guess what you wanted.

**13. Read #terms before you order.**
Revisions, ownership, cancelling — all of it is written down, so neither of us
has to argue about it later.
````

### Message 3 — working here

````
## If you work here

**14. Clients belong to the studio, not to you.**
Bring one in and you're paid a **20% finder's cut** for it — that's the reward,
and it's a good one. Taking a studio client private ends a working relationship
here immediately.

**15. What you learn here stays here.**
Client names and contacts, what a client pays, other people's pay, unreleased
projects, how our splits work. Not a screenshot, not a casual mention, not
confirming it when someone else brings it up.

**16. Never pretend to be someone you're not.**
Not another staff member, not a client, not the studio. Confirmed impersonation
means immediate removal and any pending payment is forfeited.

**17. Finished work is the studio's and the client's.**
Your own portfolio is fine — that's normal. Reselling it, reuploading it, or
handing it to another client is not.

**18. Say something early.**
Stuck, late, or something came up — tell your lead. That's allowed and it isn't
held against you. Going quiet is the thing that causes problems.

**19. Don't ask for roles.**
Everyone goes through #apply and a paid trial. Asking repeatedly doesn't speed
it up.
````

### Message 4 — consequences

````
## If you break these

**Most things:** a warning first. We'd rather fix it than lose you.

**Repeatedly, or seriously:** removal from the server, and no further work.

**Scamming, impersonation, or claiming someone else's work as yours:** removed
immediately, no warning, pending payment forfeited, and permanently blacklisted.

For proven scamming or stolen work we may also report the account to Roblox and
to developer communities. Whether they act is their decision, not ours.

**Think a decision was wrong?** Say so — in your order channel if you're a
client, or `/escalate raise` if you're staff. That goes straight to the owner
and nobody else sees it.

-# Arguing it out in #general is the one route that won't get it changed.
````

---

## 🛠️・services

````
# What we do

**Modelling** — props, weapons, characters, hard-surface and stylised
**Building** — maps, lobbies, interiors, full environments
**Animation** — rigs, combat, idles, emotes, cutscenes
**VFX** — abilities, hit effects, weather, particles
**UI / GUI** — interfaces, HUDs, shop and inventory screens
**GFX** — thumbnails, icons, banners, logos
**SFX** — sound design and audio passes

## Pricing

**Every job is quoted individually.** We don't publish a price list, because
"a weapon model" can mean an afternoon or a fortnight, and any number we posted
would be wrong for most jobs.

Tell us what you want in #request-a-quote and you'll get a real number.

## Paying us

**PayPal · Robux · crypto · card payment link**

Robux is paid directly as in-game currency. We don't convert through DevEx — a
Robux price is a Robux price, not a dollar figure in disguise.

## What you get

Source files and exports, previews, and whatever else the job needs — all agreed
in writing before anybody starts.

-# Read #terms before ordering.
````

---

## 📄・terms

**Post as three messages.** The deposit line is the one thing still to decide —
see `CONFLICTS.md`, because it decides whether your artists can be paid on time.

### Message 1

````
# Working with us

## Quotes

A quote covers exactly what's written in it. Anything added afterwards is new
work, priced separately. We tell you **before** we do it, never after.

Quotes hold for **[7] days**.

## Payment

**[deposit % — decide this] before work starts, the rest on delivery.**

Every payment is recorded against your order.

**We will never ask for a password, a card number, or a wallet phrase.**
If anyone claiming to be us does, it isn't us — tell us immediately.

## Turnaround

Quoted per job. You get a date when we quote, and we tell you as soon as we know
if it's going to move.
````

### Message 2

````
## Revisions

**Three rounds of changes are included free.**

The first two are yours by right — ask and we do them, as long as they bring the
work in line with what was agreed. A request doesn't have to be spelled out
word-for-word in the brief to count; it just has to be a fair reading of it.

A genuine change of direction is **new work**, with its own scope and price.
We'll say which one we think it is up front, and we won't surprise you with a
bill.

Requests also have to be reasonable in effort — normal changes, not repeated
nitpicking. After two in-scope, reasonable rounds we may decline further ones.

## What you receive

Everything listed in the quote — source files, exports, previews. Formats agreed
up front.

## Ownership

The finished work is yours and the studio's once it's paid for.

Our artists may show it in their own portfolios, which is normal for creative
work — that means showing what they made, never handing over source files or
your details.

**We may show it in our portfolio unless you tell us not to.** Say so at any
point and it comes down. If your project is unannounced, tell us and we show
nothing until you say it's fine.
````

### Message 3

````
## Cancelling

**Before work starts** — anything paid is returned.

**Part-way through** — you pay for what's been done, and you receive it.

**After delivery** — the job is finished. If something's wrong with it, that's a
revision. Tell us and we fix it.

## If something goes wrong

Tell us in your order channel first.

We keep a dated record of every approval, every file sent and every payment, and
we'll go through it with you.

We'd rather fix it than argue about it.

-# Last updated [date]. We'll tell you here if these change.
````

---

## 🎫・request-a-quote

````
# Getting a quote

Post here and you'll get a price and a date back.

**Include all five of these, or it just takes longer:**

**1. What you want**
As specific as you can. "A sword" and "12 stylised low-poly swords, textured,
matching a set I'll send" are very different jobs.

**2. References**
Images, videos, a style you like. One picture saves a hundred messages.

**3. Your deadline**
A real one. "Whenever" gets scheduled like "whenever".

**4. Your budget range**
So we can tell you straight away whether it's realistic, instead of quoting
something you were never going to pay.

**5. Your game**
A link if there is one, so we can match the style.

## What happens next

You get a written quote. Accept it and we open a **private channel** for your
order, where everything happens from then on.

You can also request a quote on our site: **[your website URL]**

-# Read #terms first. We won't ask for a password or a card number — ever.
````

---

## 📥・apply

**Post as two messages.**

### Message 1

````
# Working for Cylops

We take on **builders, modellers, animators, VFX artists, UI/GUI and GFX
designers, and sound designers.**

## Post here with

**1. What you do**
Pick your craft. If you do two, say which is stronger.

**2. Your portfolio**
Work you made, not work you like.

**3. Proof it's yours**
Project files, working screenshots, the account it was uploaded from.
We ask everybody. It isn't personal — it's how we avoid hiring someone who took
it from somebody else.

**4. Your timezone**
The actual zone, e.g. `Asia/Dubai`.

**5. Your availability**
Hours a week, realistically.

**6. Your software.**

**7. What you expect to be paid.**
````

### Message 2

````
## What happens next

Your portfolio is reviewed by the lead for your craft.

If it fits, you start on a **trial** — a real, small, **paid** job with the terms
and the pay written down before you start. **You're paid for it whether or not
we take you on.**

Pass, and you get your full craft role. Work starts being offered to you
directly, by DM, with the brief, the deadline and the pay already agreed.

## Two things we will never do

**We never ask anyone to work for free** — including "to prove yourself".
Every trial is paid.

**We never ask for your account password.** Ever. For any reason.

Anyone doing either of those in our name is not us. Report it to the owner.

-# Applying repeatedly doesn't speed anything up. We read every one.
````

---

## ⭐・vouches

````
# Vouches

**Only clients who have actually ordered can post here.**

## Please include

- What you ordered
- Whether it came out how you wanted
- Whether it arrived when we said it would

Honest ones are worth more than glowing ones. If something wasn't right, say
that too — we'd rather fix it than have it go around quietly.

-# Staff: screenshot the good ones and file them with `/proof add kind:approval`.
-# Discord messages get deleted, and that's your marketing gone.
````

---

## 🖼️・showcase

````
# Showcase

Our work, posted by staff.

**Run `/archive portfolio` before posting.**

That's the list of work clients have actually given permission to show, and it's
the only list you may post from.

Some projects are under wraps until the client launches, and posting one early
costs us the client.

**If it isn't on that list, it doesn't go here** — however good it is.
````

---

## 🙋・introductions

````
# Introductions

Say hello. Short is fine:

**Name** —
**Craft** —
**Timezone** —
**Software** —
**Something you're proud of** —

Then run `/profile me` and fill it in properly.

That's what puts you on the staff board with your local time, so people stop
messaging you at 3am.
````

---

## 🧭・how-we-work

**Post as two messages.** Pin `COMMANDS-staff.pdf` here too.

### Message 1

````
# How a job moves through the studio

**1. It comes in** — a client posts in #request-a-quote or uses the website.

**2. It gets quoted** — priced and approved before it's sent. Nobody quotes off
the cuff.

**3. It becomes an order** — with a client channel, a deadline, and tasks routed
to each craft.

**4. Pay is agreed** — your lead proposes what a task pays, the owner approves
it. **Work is never offered before the pay is agreed**, so you always know what
you're accepting.

**5. It's offered to you** — by DM, with the brief, the deadline and the pay.
Accept or decline. Declining is fine. Leaving it sitting is not.

**6. You do the work** — post updates with `/work progress`.
Stuck? `/work blocked`. That isn't admitting failure, it's how we see an order
has stopped.

**7. You submit** — `/work submit`, with the checklist for your craft.

**8. Your lead reviews it** — passes it on, or asks for changes. This happens
privately. Nobody is corrected in front of the server.

**9. The client decides** — their approval is recorded against the exact version
they saw, so "I approved a different one" can't happen.

**10. It's delivered and you're paid.** Check yours with `/work earnings`.
````

### Message 2

````
## Revisions

**Three rounds are included free per task.**

The first two you do — they're part of the job, as long as they bring the work in
line with the agreed scope.

Something genuinely new is a **separate task with its own pay**. Say so rather
than absorbing it. You're not being difficult; you're keeping the record honest.

## If you need to step away

Tell your lead, hand over what you've finished, and you're paid fairly for the
usable part.

**That's allowed and it isn't held against you.** Disappearing is a different
thing entirely.

## Your commands

`/go` — first thing, every day. What's waiting on you.
`/desk me` — everything of yours in one place.
`/find` — when you can't remember a code or a name.
`/help` — only shows what you can actually use.

-# Full command list pinned below.
````

---

## 📕・staff-rules

````
# Staff rules

**Two handbooks apply to you:**

**Staff Payment & Work Guidelines** — everyone. Pay, revisions, approvals,
confidentiality, portfolio rights, and what happens if things go wrong.

**Leader Handbook** — additional, if you lead a team.

[link both here]

## The short version

- **Pay is per task**, agreed before you start
- **Three revisions free per task** — the first two are compulsory and in-scope
- **What you learn here stays here** — client names, what a client pays, other
  people's pay, unreleased projects, how our splits work
- **Finished work belongs to the studio and the client** — your own portfolio is
  fine, reselling or reuploading is not
- **Clients are the studio's.** Bring one in and you're paid **20%** for it
- **Bring in a recruit** who gets paid work and you're paid **20% of their pay**

## Acknowledging them

Run **`/procedure list`** — it shows every procedure and which you still owe an
acknowledgement on. Read each with `/procedure read`.

That's how we know who has actually read what, which a pinned message can't tell
us. If a handbook changes you'll be asked to acknowledge it again.

-# Questions about any of it go here. Nothing in them is a trick.
````

---

## 📁・resources

````
# Resources

Plugins, rigs, templates, reference packs — anything that saves someone else an
afternoon.

## Posting something

Say **what it is, what it's for, and which craft**, in one line.
A bare link helps nobody in three months.

## What not to post

**No paid assets. No leaked files. No client source from another job.**

Unsure? Ask in #help-desk first. Nobody has ever been told off for asking.
````

---

## 💵・price-guide

Leads and owner only. The Staff Guidelines put the split system under the NDA,
so this channel is covered by it.

````
# Internal pay guide

**This is what we pay artists. It is not what clients pay.**
Both figures are under the NDA. Neither leaves this channel.

Pay is per task and varies by complexity and by who's doing it — there's no rate
card. These are starting points for `/task pay`, not rules.

| Work | Typical pay |
| --- | --- |
| Simple prop, untextured | [ ] |
| Simple prop, textured | [ ] |
| Weapon, textured | [ ] |
| Character model | [ ] |
| Terrain / environment build | [ ] |
| Lowpoly map | [ ] |
| Stud build | [ ] |
| Realistic build | [ ] |
| Interior / exterior | [ ] |
| Full lobby | [ ] |
| Animation, single | [ ] |
| Animation set | [ ] |
| VFX, single ability | [ ] |
| UI / GUI screen | [ ] |
| Full UI set | [ ] |
| Thumbnail / icon | [ ] |
| SFX pass | [ ] |

**Rush work** — add [ ]% when the deadline is inside [ ] days.

## The splits

**Finder** — 20% for bringing the client in
**Recruiter** — 20% of a recruit's pay, if you brought them in
**Lead** — 20%
**Mod** — 10%
**Owner** — the rest

The finder and recruiter cuts are different things.

## The budget guard

The bot refuses pay that would commit more than the client is paying.

**If you hit it, the answer is a bigger quote — not a smaller artist.**
````

---

## 🤖・bot-commands

````
# Bot commands

Run slash commands here to keep #general readable.

Nearly every reply is **private to you**, so this channel stays quiet either way.

**`/help`** shows only the commands you can actually use — if it isn't listed,
it isn't yours to run, and you're not missing anything.

-# Start with `/go`.
````

---

## 🤝・client-«name» — opening post

Post this when you open a client's channel, then run `/clients dashboard`.

````
# Welcome, [client name]

**This channel is yours.** Everything about your order happens here — questions,
previews, approvals, delivery.

**Your dashboard is pinned above.** It updates itself and shows where your order
actually is, so you never have to ask for a status update.

## What we need from you

- **Reply when we ask for a decision** — approvals are what unblock the next stage
- **Tell us early if something changes**, not after we've built it
- **Keep it in this channel**, not in DMs, so it's all on the record

## What you get from us

- A preview before anything is final
- Notice as soon as we know a date is moving
- A dated record of every approval, file and payment

Terms are in #terms. Anything unclear, just ask here.

-# We will never ask you for a password, a card number, or a wallet phrase.
````

---

## Before you post any of this

1. **Read `CONFLICTS.md`.** Four things in your handbooks and the bot disagree.
   Two are about money and one is a promise already made to a named person.
2. **Decide the deposit.** It's the only blank left in `#terms`, and it decides
   whether your artists can actually be paid when your handbook says they will be.
3. **Fill the pay guide.** The numbers are yours; the shape is there.
4. **Retype every `#channel-name`** after pasting, so Discord links them.
5. **Link both handbooks in `#staff-rules`**, and put them in `/procedure set` so
   acknowledgements are tracked.
6. **Run `/studio doctor`** afterwards to catch anything pointed at but unfinished.
