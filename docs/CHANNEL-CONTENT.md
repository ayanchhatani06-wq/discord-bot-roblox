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

> # Welcome to Cylops Studio
>
> We build for Roblox — models, maps, animation, VFX, UI, GFX and sound.
>
> **Here for work done?** Read <#services>, then post in <#request-a-quote>.
> **Here to work with us?** Read <#apply>.
>
> Get verified in <#verify> first, then have a look at <#rules>.
>
> Everything is quoted individually, because no two jobs are the same size. Ask
> and you get a real number for your actual job.

---

## 📜・rules

> # Rules
>
> **1 · Be decent to people.** No harassment, no slurs, no going after someone's
> work to make a point. Disagree with the thing, not the person.
>
> **2 · English in public channels**, so staff can moderate what they can read.
> Any language you like in DMs.
>
> **3 · Every job starts in <#request-a-quote>.** Do not DM staff to arrange work
> privately. A private deal is one nobody can back you up on if it goes wrong —
> including us, and including you.
>
> **4 · Clients are the studio's, not an individual's.** If you are staff and you
> bring a client in, tell the studio — you are paid a finder's cut for it. Taking
> a studio client private is the one thing that ends a working relationship here
> immediately.
>
> **5 · Do not pretend to be someone you are not.** Not another staff member, not
> a client, not the studio. This is treated as serious and is dealt with under the
> staff handbook.
>
> **6 · No advertising other studios or services.** No exceptions.
>
> **7 · Do not haggle in public.** If a price does not work, say so in your order
> channel and we will talk about scope instead.
>
> **8 · No middlemen we did not agree to.** If somebody offers to "hold" payment
> between us, tell us before you send anything.
>
> **9 · Right channel, right thing.** Chat in <#general>, off-topic in
> <#off-topic>, your job in your own order channel.
>
> **10 · We keep records.** Approvals, changes, files and payments are all dated
> and kept. That protects you as much as it protects us.
>
> Breaking these gets a warning, then removal. Scamming or impersonation gets
> removal with no warning.

---

## 🛠️・services

> # What we do
>
> **Modelling** — props, weapons, characters, hard-surface and stylised
> **Building** — maps, lobbies, interiors, full environments
> **Animation** — rigs, combat, idles, emotes, cutscenes
> **VFX** — abilities, hit effects, weather, particles
> **UI / GUI** — interfaces, HUDs, shop and inventory screens
> **GFX** — thumbnails, icons, banners, logos
> **SFX** — sound design and audio passes
>
> ## Pricing
>
> **Every job is quoted individually.** We do not publish a price list, because
> "a weapon model" can mean an afternoon or a fortnight, and any number we posted
> would be wrong for most jobs.
>
> Tell us what you want in <#request-a-quote> and you get a real number.
>
> ## Paying us
>
> **PayPal · Robux · crypto · card payment link**
>
> Robux is paid directly as in-game currency. We do not convert through DevEx, so
> a Robux price is a Robux price — it is not a dollar figure in disguise.
>
> ## What you get
>
> Source files and exports, previews, and whatever else the job needs — all agreed
> in writing before anybody starts. Read <#terms>.

---

## 📄・terms

Revisions, ownership and portfolio use below are taken from the Staff Payment &
Work Guidelines. **The deposit line is the one thing still to decide** — see
`CONFLICTS.md`, because it decides whether your artists can be paid on time.

> # Working with us
>
> ## Quotes
> A quote covers exactly what is written in it. Anything added afterwards is new
> work, priced separately. We tell you before we do it, never after.
>
> Quotes hold for **[7] days**.
>
> ## Payment
> **[deposit % — decide this] before work starts, the rest on delivery.**
>
> We record every payment against your order. **We will never ask for a password,
> a card number, or a wallet phrase.** If anyone claiming to be us does, it is not
> us — tell us.
>
> ## Revisions
> **Three rounds of changes are included free.**
>
> The first two are yours by right — ask and we do them, as long as they bring the
> work in line with what was agreed. A request does not have to be spelled out
> word-for-word in the brief to count; it just has to be a fair reading of it.
>
> A genuine change of direction is new work, with its own scope and price. We will
> say which one we think it is up front, and we will not surprise you with a bill.
>
> Requests also have to be reasonable in effort. Normal changes, not repeated
> nitpicking. After two in-scope, reasonable rounds, we may decline further ones.
>
> ## Turnaround
> Quoted per job. We give you a date when we quote, and we tell you as soon as we
> know if it is going to move.
>
> ## What you receive
> Everything listed in the quote — source files, exports, previews. Formats agreed
> up front.
>
> ## Ownership
> The finished work belongs to you and the studio once it is paid for. Our artists
> may show it in their own portfolios, which is normal for creative work — that
> means showing what they made, never handing over source files or your details.
>
> **We may show it in our portfolio unless you tell us not to.** Say so at any
> point and it comes down. If your project is unannounced, tell us and we show
> nothing until you say it is fine.
>
> ## Cancelling
> Cancel before work starts and anything paid is returned.
>
> Cancel part-way and you pay for what has been done, and you receive it.
>
> After delivery the job is finished. If something is wrong with it, that is a
> revision — tell us and we fix it.
>
> ## If something goes wrong
> Tell us in your order channel first. We keep a dated record of every approval,
> every file and every payment, and we will go through it with you.
>
> We would rather fix it than argue about it.

---

## 🎫・request-a-quote

> # Getting a quote
>
> Post here and you get a price and a date back. **Include all of this or it just
> takes longer:**
>
> **1 · What you want** — as specific as you can. "A sword" and "12 stylised
> low-poly swords, textured, matching a set I'll send" are very different jobs.
>
> **2 · References** — images, videos, a style you like. One picture saves a
> hundred messages.
>
> **3 · Your deadline** — a real one. "Whenever" gets scheduled like "whenever".
>
> **4 · Your budget range** — so we can tell you straight away whether it is
> realistic, instead of quoting something you were never going to pay.
>
> **5 · Your game** — a link if there is one, so we can match the style.
>
> You get a written quote. Accept it and we open a private channel for your order,
> where everything happens from then on.
>
> You can also request a quote on our site: **[your website URL]**

---

## 📥・apply

> # Working for Cylops
>
> We take on **builders, modellers, animators, VFX artists, UI/GUI and GFX
> designers, and sound designers.**
>
> **Post here with:**
>
> **1 · What you do** — pick your craft. If you do two, say which is stronger.
> **2 · Your portfolio** — work you made, not work you like.
> **3 · Proof it is yours** — we ask everybody for this. Project files, working
> screenshots, the account it was uploaded from. It is not personal; it is how we
> avoid hiring someone who took it from somebody else.
> **4 · Your timezone** — the actual zone, e.g. Asia/Dubai.
> **5 · Your availability** — hours a week, realistically.
> **6 · Your software.**
> **7 · What you expect to be paid.**
>
> ## What happens next
>
> Your portfolio is reviewed by the lead for your craft. If it fits, you start on
> a **trial** — a real, small, **paid** job with the terms and pay written down
> before you start. You are paid for it whether or not we take you on.
>
> Pass, and you get your full craft role and work starts being offered to you
> directly.
>
> ## Two things we will never do
>
> **We do not ask anyone to work free**, including "to prove yourself". Every
> trial is paid.
>
> **We do not ask for your account password**, ever, for any reason.
>
> Anyone doing either of those in our name is not us.

---

## ⭐・vouches

> # Vouches
>
> Only clients who have actually ordered can post here.
>
> **Please include:**
> - what you ordered
> - whether it came out how you wanted
> - whether it arrived when we said it would
>
> Honest ones are worth more than glowing ones. If something was not right, say
> that too — we would rather fix it than have it go around quietly.

---

## 🖼️・showcase

> # Showcase
>
> Our work, posted by staff.
>
> **Run `/archive portfolio` before posting.** That is the list of work clients
> have actually given permission to show, and it is the only list you may post
> from. Some projects are under wraps until the client launches, and posting one
> early costs us the client.
>
> If it is not on that list, it does not go here — however good it is.

---

## 🙋・introductions

> Say hello. Short is fine:
>
> **Name** —
> **Craft** —
> **Timezone** —
> **Software** —
> **Something you're proud of** —
>
> Then run `/profile me` and fill it in properly. That is what puts you on the
> staff board with your local time, so people stop messaging you at 3am.

---

## 🧭・how-we-work

Pin `COMMANDS-staff.pdf` here too.

> # How a job moves through the studio
>
> **1 · It comes in** — a client posts in <#request-a-quote> or uses the website.
>
> **2 · It gets quoted** — priced and approved before it is sent. Nobody quotes
> off the cuff.
>
> **3 · It becomes an order** — with a client channel, a deadline, and tasks
> routed to each craft.
>
> **4 · Pay is agreed** — your lead proposes what a task pays, the owner approves
> it. **Work is never offered before the pay is agreed**, so you always know what
> you are accepting.
>
> **5 · It is offered to you** — by DM, with the brief, the deadline and the pay.
> Accept or decline. Declining is fine. Leaving it sitting is not.
>
> **6 · You do the work** — post updates with `/work progress`. Stuck? `/work
> blocked`. That is not admitting failure, it is how we see an order has stopped.
>
> **7 · You submit** — `/work submit`, with the checklist for your craft.
>
> **8 · Your lead reviews it** — passes it on, or asks for changes. This happens
> privately. Nobody is corrected in front of the server.
>
> **9 · The client decides** — their approval is recorded against the exact
> version they saw, so "I approved a different one" cannot happen.
>
> **10 · It is delivered and you are paid.** Check yours any time with
> `/work earnings`.
>
> ## Revisions
>
> Three rounds are included free per task. The first two you do — they are part of
> the job, as long as they bring the work in line with the agreed scope. Something
> genuinely new is a separate task with its own pay; say so rather than absorbing
> it.
>
> ## If you need to step away
>
> Tell your lead, hand over what you have finished, and you are paid fairly for
> the usable part. That is allowed and it is not held against you. Disappearing
> is a different thing.
>
> ---
>
> `/go` first thing. `/desk me` for everything of yours. `/find` when you cannot
> remember a code. Full list pinned below.

---

## 📕・staff-rules

> # Staff rules
>
> Two handbooks apply to you:
>
> **Staff Payment & Work Guidelines** — everyone. Pay, revisions, approvals,
> confidentiality, portfolio rights, what happens if things go wrong.
> **Leader Handbook** — additional, if you lead a team.
>
> [link both here]
>
> ## The short version
>
> - **Pay is per task**, agreed before you start
> - **Three revisions free per task**, first two compulsory and in-scope
> - **What you learn here stays here** — client names, what a client pays, other
>   people's pay, unreleased projects, how our splits work
> - **Finished work belongs to the studio and the client** — your own portfolio is
>   fine, reselling or reuploading is not
> - **Clients are the studio's.** Bring one in and you are paid 20% for it
> - **Bring in a recruit** who gets paid work and you are paid 20% of their pay
>
> ## Acknowledging them
>
> Run **`/procedure list`** — it shows every procedure and which you still owe an
> acknowledgement on. Read each with `/procedure read`.
>
> That is how we know who has actually read what, which a pinned message cannot
> tell us. If a handbook changes you will be asked to acknowledge it again.
>
> Questions about any of it go here.

---

## 📁・resources

> # Resources
>
> Plugins, rigs, templates, reference packs — anything that saves someone else an
> afternoon.
>
> **Posting something:** say what it is, what it is for, and which craft, in one
> line. A bare link helps nobody in three months.
>
> **Only post what we are allowed to share.** No paid assets, no leaked files, no
> client source from another job. Unsure? Ask in <#help-desk>.

---

## 💵・price-guide

Leads and owner only. The Staff Guidelines put "how the studio's payment and
revenue-split system works" under the NDA, so this channel is covered by it.

> # Internal pay guide
>
> **This is what we pay artists. It is not what clients pay.** Both figures are
> under the NDA — neither goes outside this channel.
>
> Pay is per task and varies by complexity and by who is doing it — there is no
> rate card. These are starting points for `/task pay`, not rules.
>
> | Work | Typical pay |
> |---|---|
> | Simple prop, untextured | [ ] |
> | Simple prop, textured | [ ] |
> | Weapon, textured | [ ] |
> | Character model | [ ] |
> | Terrain / environment build | [ ] |
> | Lowpoly map | [ ] |
> | Stud build | [ ] |
> | Realistic build | [ ] |
> | Interior / exterior | [ ] |
> | Full lobby | [ ] |
> | Animation, single | [ ] |
> | Animation set | [ ] |
> | VFX, single ability | [ ] |
> | UI / GUI screen | [ ] |
> | Full UI set | [ ] |
> | Thumbnail / icon | [ ] |
> | SFX pass | [ ] |
>
> **Rush work** — add [ ]% when the deadline is inside [ ] days.
>
> ## The splits
>
> - **Finder** — 20% for bringing the client in
> - **Recruiter** — 20% of a recruit's pay, if you brought them in
> - **Lead** — 20%
> - **Mod** — 10%
> - **Owner** — the rest
>
> The finder and recruiter cuts are different things and both can apply.
>
> ## The budget guard
>
> The bot refuses pay that would commit more than the client is paying. If you hit
> it, the answer is a bigger quote — not a smaller artist.

---

## 🤖・bot-commands

> Run slash commands here to keep <#general> readable.
>
> Nearly every reply is private to you, so this channel stays quiet either way.
>
> `/help` shows only the commands you can actually use.

---

## 🤝・client-«name» — opening post

Post this when you open a client's channel, then run `/clients dashboard`.

> # Welcome, [client name]
>
> This channel is yours. Everything about your order happens here — questions,
> previews, approvals, delivery.
>
> **Your dashboard is pinned above.** It updates itself and shows where your order
> actually is, so you never have to ask for a status update.
>
> **What we need from you:**
> - Reply when we ask for a decision — approvals are what unblock the next stage
> - Tell us early if something changes, not after we have built it
> - Keep it in this channel, not in DMs, so it is all on the record
>
> **What you get from us:**
> - A preview before anything is final
> - Notice as soon as we know a date is moving
> - A dated record of every approval, file and payment
>
> Terms are in <#terms>. Anything unclear, just ask here.

---

## Before you post any of this

1. **Read `CONFLICTS.md`.** Four things in your handbooks and the bot disagree.
   Two are about money and one is a promise already made to a named person.
2. **Decide the deposit.** It is the only blank left in `#terms`, and it decides
   whether your artists can actually be paid when your handbook says they will be.
3. **Fill the pay guide.** The numbers are yours; the shape is there.
4. **Link both handbooks in `#staff-rules`**, and put them in `/procedure set` so
   acknowledgements are tracked.
5. **Run `/studio doctor`** afterwards to catch anything pointed at but unfinished.
