# Bill import from OurHomeInbox

[OurHomeInbox](https://github.com/EOSOClub/OurHomeInbox) reads the bills and
payment confirmations that arrive by email, picks out the amount, dates and
numbers, and lets someone in the house check them. Our Home asks it for the
ones that are ready and turns them into bills and payments on the Bills page.
It replaces the email part of the [Paperless import](paperless-import.md);
Paperless stays available for households that also photograph paper bills.

## One OurHomeInbox per household

The Head of House connects it in **Settings → OurHomeInbox bill import →
Connect your OurHomeInbox**:

- **OurHomeInbox address**: how the server reaches it, for example
  `http://ourhome_inbox:8080` when both run on the `ourhome_net` Docker network.
- **Address you open it at** (optional): for "Open the email" links on bills
  and skipped emails, for example `https://inbox.example.com`.
- **Token**: made in OurHomeInbox under *Settings → OurHome connection → Create
  a token*. It starts with `ohi_`, is shown there only once, and works only for
  the hand-off (reading documents, and reporting the changes below).

Saving tries the connection first and saves nothing if that fails. The token is
stored encrypted (key derived from `BETTER_AUTH_SECRET`; changing that secret
means entering the token again).

- **Address rules**: the same as Paperless. A household's OurHomeInbox must be a
  public internet address, except for the server admin's household, or a
  household the server admin allowed on the **Server** page ("Imports: allow
  local"). That one switch covers both bill imports.
- **Changing the connection**: a new token for the same OurHomeInbox household
  carries on where it was. A different address, or a token for a different
  OurHomeInbox household, starts from the beginning of that household's feed.
- **Disconnecting** stops the import. Bills it brought in stay.

## How it works

Every 15 minutes (with the reminder sweep, right after the Paperless import),
and on **Check now**, the server first reports any changes people made here
(below), then asks OurHomeInbox for the documents after the last number it
handled:

| From OurHomeInbox                     | Becomes                                                                                                                                   |
|---------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| A ready bill                          | An unpaid bill (source "Email (auto)") with its due date, account and invoice numbers, and an "Open the email" link. Skipped if someone deleted that bill here before |
| A ready payment that pays a bill      | A payment on the bill with the reference it sends, with the card fee as sent, marked "Paid late" when OurHomeInbox says so                |
| A ready payment marked Paid on its own | A bill recorded as already paid, with its payment                                                                                        |
| A withdrawn email                     | Its bill is removed, unless a payment is recorded on it or someone made it recurring: then it's kept and listed for a person              |

**OurHomeInbox decides what is ready.** An email goes once someone marks it
Checked there, or by itself when its biller is set to send automatically (it
offers that after three clean checks in a row). Our Home imports what it is
given; a wrong value is fixed once, in OurHomeInbox, and the bill updates on the
next check.

**OurHomeInbox decides which bill a payment pays** (contract version 2). It
pairs each payment email with its bill email, works out the card fee, and
judges whether it was paid late, and sends that along: the payment carries its
bill's `reference`. Our Home links it only by that reference. It never guesses
from the account number or the biller, and never works out a fee itself. A
payment whose bill isn't in Our Home, or whose bill is already paid here, is
listed as skipped with that reason. A bill email is paid by at most one
payment email: if the bill was made recurring and has already moved on past
that email's due date (someone paid it by hand), the payment counts as already
paid too. A payment someone marked "Paid on its own" in OurHomeInbox comes
with no reference and becomes a paid bill, with Our Home's own generated
reference (never its invoice or confirmation number, so it can't be mixed up
with a real bill). (Paperless keeps Our Home's own matching:
`src/server/billIngest/matching.ts`.)

**Deleted bills stay deleted.** If someone deletes a bill from OurHomeInbox
here and OurHomeInbox offers that email again (a value fixed there, or the
import starting over after reconnecting), it's listed as skipped with
"Someone deleted this bill here" instead of coming back.

**A recurring bill keeps its place.** When a bill someone made recurring has
already rolled on to a later due date (it has a payment for an earlier one)
and its email is offered again, its due date and amount are left alone
(they've moved on with the bill); the other details still update. A
recurring bill that hasn't rolled yet still takes a corrected amount and due
date. This applies to the Paperless import too.

**Known limit: a biller that reuses one invoice number.** Bills are kept by
their reference (the invoice number when there is one). If a biller puts the
same invoice number on every month's bill, the new month's bill email updates
last month's bill in place instead of adding a new one. This isn't new in
version 2; the Paperless import has always worked the same way.

**"Paid late"** shows next to a payment on the bill's page when OurHomeInbox
judged it late: another bill from the same biller came in before it was paid,
or it was paid after the due date.

### Changes reported back

Two things people do here are reported to OurHomeInbox, so it never pairs a
later payment email with a bill that's already settled or gone:

- **Paid**: someone records a payment by hand that leaves a bill from
  OurHomeInbox fully paid. On a recurring bill any payment by hand counts,
  even one less than the amount, because it closes that cycle.
- **Removed**: someone deletes a bill from OurHomeInbox. (A bill removed
  because OurHomeInbox withdrew its email isn't reported: it already knows.)

A bill made from a "Paid on its own" payment carries that payment email's
Message-ID, so its reports name a payment email; OurHomeInbox ignores those.

They're queued only while an OurHomeInbox is connected, and sent at the start
of every check until OurHomeInbox accepts them. If sending fails, the import
still runs, the card says so, and the changes go on the next check. If
OurHomeInbox refuses a single change outright, it's set aside (kept with
OurHomeInbox's reason) so it never holds up the others. The reports stay after
Disconnect, so a reconnect sends any left over and deleted bills stay deleted.

### Safety rules

- **Starts fresh.** OurHomeInbox leaves out every email captured before the
  start date set with the token (by default the day the token was made), so
  nothing Paperless already imported comes again.
- **Nothing is lost.** The number of the last handled document is kept only
  after every document in a reply is handled. If something fails half way, the
  next check asks for the same ones again, and handling one twice changes
  nothing.
- **A broken reply stops the import, loudly.** A reply that breaks the contract
  (numbers going backwards, an entry without a number) is shown as the last
  error and nothing after it is imported. One email whose fields Our Home can't
  read is listed as skipped instead, and the rest still come in.
- **Reads, plus two reports.** Our Home never changes anything in
  OurHomeInbox; the only thing it sends is the paid and removed reports above.
- **Payments are never undone automatically.** A withdrawn email that recorded
  a payment is listed for a person to check on the bill.

> [!WARNING]
> **Don't let Paperless and OurHomeInbox read the same bills email.** Paperless
> documents are kept as `paperless:<id>`, OurHomeInbox's by the email's own
> Message-ID, so a bill without an invoice number would come in twice. The
> Settings card says so when both are connected. Turn off the Paperless mail
> rules for that mailbox (keep Paperless for photos if you use it), or
> disconnect Paperless.

## Check it before it imports anything

The preview asks OurHomeInbox once and shows what *would* happen. It writes
nothing in Our Home, sends no reports, and needs no database. Asking still
counts in OurHomeInbox: it numbers the documents and locks the payment
pairings it offers, and asking after a number (`npm run inbox:preview -- 40`)
tells it Our Home has handled everything up to that number, so only give a
number Our Home really has handled:

```bash
docker compose exec -e INBOX_URL=http://ourhome_inbox:8080 -e INBOX_TOKEN=ohi_... \
  -e INBOX_PUBLIC_URL=https://inbox.example.com web npm run inbox:preview
```

```
[preview] OurHomeInbox household "The Smiths", newest document 44, start date 2026-11-01
[preview] 2 document(s):
  #43    PAID  Midco Payment Posted                                 114.93  paid 2026-10-26  Midco  acct XXXX-1234  on its own
         https://inbox.example.com/mail/proton-bill-label/118112344/1
  #44    WITHDRAWN  <def456@emails.midco.com>  Marked Not a bill in OurHomeInbox.
```

## The contract

This is the only thing the two projects share. A change is agreed first, then
made on both sides (OurHomeInbox keeps the same text in its notes). This is
**version 2** (2026-11-01): it adds `reference` on bills and paired payments,
`fee` and `baseAmount` on paired payments, `paidLate`, the ordering rule,
`POST /api/handoff/changes`, and how Our Home imports email payments.

**Connection.** Every request sends `Authorization: Bearer <token>`. No
cookies. The token is `ohi_` followed by 43 characters `A-Z a-z 0-9 - _`,
belongs to one household, and works only on the three routes below (two reads,
and the change reports). Every reply is JSON. Errors are
`{ "error": "<plain-language reason>" }` with 400 (bad query or body), 401
(token missing, unknown or revoked) or 500; Our Home shows the `error` text as
it is.

**`GET /api/handoff/hello`**, to test the connection:

```json
{ "household": "The Smiths", "newest": 42, "startDate": "2026-11-01" }
```

**`GET /api/handoff/documents?after=<n>&limit=<m>`**: what is new or changed
since document number `n` (`after` 0 the first time; `limit` 1 to 200, default 100).

```json
{
  "documents": [
    {
      "number": 43,
      "captureId": "proton-bill-label/118112344/1",
      "link": "/mail/proton-bill-label/118112344/1",
      "status": "ready",
      "document": {
        "kind": "receipt",
        "messageId": "<abc123@emails.midco.com>",
        "biller": "Midco",
        "billerKey": "ourhomeinbox-biller:3",
        "billerEmail": "midco@emails.midco.com",
        "subject": "Midco Payment Posted",
        "amount": 114.93,
        "paidDate": "2026-10-26",
        "emailDate": "2026-10-28T14:03:11.000Z",
        "accountNo": "XXXX-1234"
      }
    },
    {
      "number": 44,
      "captureId": "proton-bill-label/118112344/7",
      "link": "/mail/proton-bill-label/118112344/7",
      "status": "withdrawn",
      "messageId": "<def456@emails.midco.com>",
      "reason": "Marked Not a bill in OurHomeInbox."
    }
  ],
  "next": 44,
  "more": false
}
```

- `documents` come in rising `number` order; one email at most once per reply,
  in its latest state. An email offered again gets a new, higher number.
- `ready`: `document` fits `billIngestSchema` (`src/lib/validation/billIngest.ts`):
  `kind` is `bill` or `receipt`, money is a JSON number, `dueDate` and
  `paidDate` are days (`YYYY-MM-DD`, read as noon local time), `emailDate` is a
  full ISO time. Unknown fields are left out, never `null`. It never carries
  `totalDue`, `currency`, `sourceUrl` or `confidence`. Our Home adds
  `sourceUrl` itself: the public address followed by `link` (a path on
  OurHomeInbox; anything else is refused).
- `reference` (v2): every `bill` carries one: its invoice number when it has
  one, otherwise `ohi:` followed by the first 24 hex characters of the SHA-256
  of its `messageId`. Every **paired** `receipt` carries its bill's
  `reference`, plus `fee` (the payment less the bill amount, 0 when not more)
  and `baseAmount` (the payment less `fee`), and `paidLate: true` when
  OurHomeInbox judged it late (left out otherwise). A `receipt` **without**
  `reference` is one a person marked "Paid on its own"; OurHomeInbox sends no
  other unpaired receipt. Once a bill has been offered as ready, its
  reference never changes (a corrected invoice number still arrives in
  invoiceNo).
- Order (v2): a paired receipt appears only after its bill has appeared as
  `ready` with a lower number. Once a receipt has appeared as `ready`,
  OurHomeInbox never changes which bill it pays.
- `withdrawn`: an email offered as ready before no longer qualifies.
  `messageId` finds what it made (`sourceMessageId`); `reason` is for the household.
- `next` is the number to send as `after` next time (equal to `after` when
  nothing is new). Keep it only after every document in the reply is handled.
  When `more` is true, ask again straight away with `after=next`.
- Asking with `after=n` also tells OurHomeInbox that Our Home has handled
  everything up to `n`. Re-asking with the same `after` gives the same documents.

**`POST /api/handoff/changes`** (v2): what a person did here to a bill from
OurHomeInbox.

```json
{ "changes": [ { "messageId": "<abc123@emails.midco.com>", "change": "paid", "at": "2026-11-03T15:20:00.000Z" } ] }
```

- `change` is `paid` (a person recorded a payment by hand that left the bill
  fully paid) or `removed` (a person deleted the bill; not sent when a
  withdrawal deleted it). `messageId` is the bill's `sourceMessageId`. `at` is
  a full ISO time. 1 to 100 changes per request.
- Reply: `{ "accepted": 1, "unknown": 0 }`. `unknown` counts messageIds this
  household never offered; they are dropped, not an error. Sending the same
  change again is harmless. 400 for a body that breaks these rules (nothing
  from it is kept), 401 as above.
- Our Home queues each change (`InboxChange`) and sends the queue at the start
  of every import run, 100 at a time, keeping a change until a 200 reply
  (`src/server/inbox/changes.ts`). Changes are queued only while a connection
  exists (nothing could send them otherwise). On a 400 for a batch, Our Home
  sends that batch again one change at a time; a change still refused on its
  own is marked done with the reason (`rejected`), so it never blocks the queue.
- On a **recurring** bill any hand payment closes the cycle here, so it
  reports `paid` even when it is less than the amount. A bill made from a
  "Paid on its own" receipt carries that receipt's messageId, so its reports
  name a payment email; OurHomeInbox ignores reports that do not name a bill
  email.
- A bill a person **removed** here stays removed: when OurHomeInbox offers
  that email again as `ready` (a value fixed, or the feed starting again from 0
  after a reconnect), Our Home skips it with "Someone deleted this bill here".
  OurHomeInbox keeps offering as usual; the skip is Our Home's. The reports
  survive Disconnect for this reason.

**How Our Home imports each one.** Each `ready` document goes to
`ingestFinancialDoc(householdId, { ...document, sourceUrl }, { source: 'email', receiptPairing: 'reference' })`
(`src/server/billIngest/ingest.ts`); each `withdrawn` one to
`withdrawEmailDoc(householdId, messageId)` (`src/server/inbox/withdraw.ts`).
For email documents (v2) a receipt is linked **only** by `reference`: no
account-number or biller fallback, and no fee arithmetic of Our Home's own
(`fee` and `baseAmount` are used as sent). A reference that finds no bill is
skipped with "Its bill isn't in OurHome"; a bill already fully paid is skipped
with "This bill is already paid in OurHome"; a receipt with no `reference`
becomes a paid bill on its own, with Our Home's generated reference
(`GEN-` and a hash of its messageId, never its invoice or confirmation number,
so it cannot collide with a real bill). A bill email is paid by at most one
email payment: a paired receipt for a recurring bill that has already rolled
past the cycle of that email (it has a payment for another due date) is
skipped as already paid. `paidLate` is kept on the payment. Paperless
documents keep Our Home's own matching. A receipt offered again is a duplicate
payment here (deduped on `messageId`), so a value fixed in OurHomeInbox after
the payment came in doesn't change the recorded payment: fix it on the bill.
The exception is an email payment whose bill was deleted (the payment stays as
spending history, with no bill): when its bill comes back, that same payment is
attached to it again, refreshed from the email, instead of being a duplicate.

## Troubleshooting

| Settings shows                                          | Fix                                                                                                                                                                                                     |
|---------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| *Can't reach OurHomeInbox at …*                         | Wrong address, or the containers aren't on the same network. From the web container: `docker compose exec web node -e "fetch('http://ourhome_inbox:8080/api/handoff/hello').then(r=>console.log(r.status))"` should print 401, not an error. |
| *That address answered, but not like OurHomeInbox does* | The address points at something else. Check the port.                                                                                                                                                   |
| *… rejected the token* / *token was revoked*            | Make a new token in OurHomeInbox and enter it here.                                                                                                                                                     |
| *… isn't a public internet address*                     | Ask the server admin to allow this household's imports on the server's network (Server page).                                                                                                          |
| Skipped: *Its bill isn't in OurHome*                    | OurHomeInbox paired the payment with a bill that never came in here (or was deleted). Add the bill and record the payment by hand. OurHomeInbox offers an email again only when a value or mark on it changes there. |
| Skipped: *This bill is already paid in OurHome*         | Someone already recorded the payment here by hand. Nothing to do; check the bill if the amounts differ.                                                                                                |
| Skipped: *Someone deleted this bill here*               | Someone deleted this email's bill here, and OurHomeInbox offered the email again. It stays deleted. If it was deleted by mistake, add the bill by hand.                                                |
| *OurHomeInbox wasn't told about bills paid or deleted here …* | The paid and removed reports didn't go (the reason is in brackets). They wait and go on the next check; nothing is lost. *Couldn't read the list of changes to send* means the problem is on this server (its database), not OurHomeInbox. |
| Skipped: *Kept here: a payment is recorded…*            | OurHomeInbox no longer counts that email as a bill. Open the bill and delete it, or its payment, if it's wrong.                                                                                         |
