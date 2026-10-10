# Bill import from Paperless-ngx

Bills and bill payments you collect in [Paperless-ngx](https://docs.paperless-ngx.com)
(by email through the Proton Bridge, or as phone photos) show up on the Bills
page on their own. Paperless runs as its own stack; see
[OurHomeServices](https://github.com/EOSOClub/OurHomeServices/tree/main/paperless).

## One Paperless per household

Each household on the server imports from **its own** Paperless. Its Head of
House connects it in **Settings → Paperless bill import → Connect your
Paperless**: the address the server reaches it at, optionally the address
people open it at (for links), and the API token of a read-only Paperless
user. Saving tries the connection first (address allowed, token accepted, the
`bill` / `bill-payment` tags and **Amount** field present) and saves nothing
if that fails. The token is stored encrypted (key derived from
`BETTER_AUTH_SECRET`; changing that secret means entering the token again).
Connecting a different Paperless starts the import fresh from that moment.

- **Address rules.** A household's Paperless must be a public internet
  address, so no household can make the server connect to its own network.
  The server admin's household may use a local one (`http://paperless:8000`),
  and the server admin can allow it for another household on the **Server**
  page ("Paperless: allow local").
- **The `settings.yml` / `.env` connection below** still works: it serves the
  household in `PAPERLESS_HOUSEHOLD_ID`, or else the server admin's, until that
  household saves its own. Existing installs keep importing with no changes.
- One household's Paperless being down never stops the others' imports.

## How it works

Every 15 minutes (with the reminder sweep), and on **Settings → Paperless bill
import → Check now**, the server asks Paperless for documents tagged **`bill`** or
**`bill-payment`** that changed since the last check:

| Tag | Becomes |
| --- | --- |
| `bill` | An unpaid bill: name from the title, amount from **Amount**, due date from **Due date**, with a calendar event on the due date |
| `bill-payment` | A payment on the matching unpaid bill. If no bill matches, it's listed as skipped, not turned into a bill. |

**Paperless does the reading.** The amount, due date and account number come
from Paperless **custom fields**, filled by you, a workflow, or a helper like
paperless-gpt. Our Home only maps them, so a wrong value is fixed once, in
Paperless.

| Custom field | Type | Used for |
| --- | --- | --- |
| **Amount** (required) | Monetary | Amount due (bill) or paid (payment) |
| **Due date** | Date | The bill's due date |
| **Account number** | Text | Matching a payment to its bill |
| **Invoice number** | Text | Matching, and shown on the bill |

**How a payment finds its bill**, strongest match first:
1. The same invoice number.
2. The same account number.
3. The same **correspondent** (sender) with an amount equal to the bill's, or
   only a card fee more. Any surcharge is recorded as a fee.

### Safety rules

- **Starts fresh.** The first check only notes the time. Nothing that was
  already in Paperless is imported.
- **Waits until a document is finished.** A document is imported once it has
  been unchanged for 10 minutes, has an **Amount**, and isn't tagged
  `paperless-gpt` (waiting for review). Until then it's listed under *Skipped
  recently* with the reason. When you fix it, Paperless marks it changed and the
  next check picks it up.
- **Bills follow Paperless.** Editing a bill's document in Paperless updates
  the bill on the next check. Payments import once; correct them on the bill page.
- **Read-only.** The import never changes anything in Paperless. The only
  writes come from the one-time setup below, when you run it with an admin
  login.

## Setup

> [!TIP]
> **The easy way:** in `docker/`, run `./deploy.sh -s` (or `.\deploy.ps1 -Setup`),
> answer yes to Paperless and to **"Set up Paperless for you?"**, and give an
> admin login (used for that run only, never saved) and, optionally, your
> billers. Once the app is up it does all of step 1 below, plus the starters,
> puts the token in `.env`, and restarts the app. Safe to run again: it finds
> what exists by name and only adds what's missing. By hand, from the web
> container:
>
> ```bash
> docker compose exec -e PAPERLESS_ADMIN_USER=admin -e PAPERLESS_ADMIN_PASSWORD \
>   -e PAPERLESS_SETUP_BILLERS="water, electric" web npm run -s paperless:setup
> ```
>
> It prints progress, then the token (put it in `.env` as `PAPERLESS_TOKEN`).
> For the mailbox, add `PAPERLESS_SETUP_IMAP_HOST`, `_PORT`, `_SECURITY`
> (`ssl`, `starttls` or `none`), `_USER`, `_PASSWORD` and
> `PAPERLESS_SETUP_MAIL_FOLDER`. With no Paperless yet, the deploy can run one
> for you (answer no to "Already have Paperless-ngx running?").

What setup creates (all named so you can find, change or delete them):

| In Paperless | What for |
| --- | --- |
| Tags `bill`, `bill-payment` (no owner) | What the import looks for |
| Custom fields Amount, Due date, Account number, Invoice number | What the import reads |
| Group **Our Home (read-only)**, user **ourhome** + its API token | View-only access for the import; the user only signs in with its token |
| Workflow **Our Home: share new documents** | Gives the group view on every new document (needed when documents have owners) |
| Workflows **Our Home: bill fields** / **payment fields** | When a document gets the tag, its empty fields appear, ready to fill |
| Workflow **Our Home: payments are not bills** | Takes `bill` off anything tagged `bill-payment` (the mail rules tag the whole folder `bill`; the import skips documents with both) |
| Saved views **Our Home: bills & payments** / **waiting for an Amount** | On the dashboard: everything tagged, and what the import is still waiting on |
| A correspondent per biller (only if you list billers) | Files each biller's documents under it (exact-name match), which also lets Our Home match a payment to its bill |
| Content matching on both tags (only if you list billers) | The patterns below, built from your billers; skipped if a tag already uses another matching rule |
| Mail account **Our Home: bills** + rules **bill attachments** / **bill emails** (only if you give a mailbox) | Reads your bills folder every 10 minutes: PDF attachments, and HTML-only emails saved as PDF, tagged `bill`. The connection is tested first |

Documents already tagged before setup are shared with the group too.

### 1. In Paperless

1. **Tags:** create `bill` and `bill-payment`. Set *Matching* to **None** and
   *Owner* to **none**, so every user and token can see them.
2. **Custom fields:** make sure **Amount** (Monetary) exists, plus **Due date**
   (Date) and, ideally, **Account number** (Text). Different names are fine; see
   the `paperless.field` overrides in `settings.example.yml`.
3. **Tagging:** have your mail rules (or a workflow) assign `bill` to bills and
   `bill-payment` to payment confirmations, or tag them by hand. If your billers
   send both from the same address into the same folder, a workflow can't tell
   them apart (workflows filter on sender, tags and folders, not on content);
   use content matching instead, below.
4. **A read-only user for Our Home:** *Users & Groups → Add user*, e.g.
   `ourhome`, with only these **view** permissions: *Document*, *Tag*,
   *Correspondent*, *Custom field*. It also needs to see the documents
   themselves. If you use document owners, grant this user (or a group it's in)
   **view** on new documents, for example in an "Added" workflow with
   *Assign view permissions*.
5. **Token:** sign in as that user, go to *My Profile → API Auth Token*, and
   generate one.

#### Optional: tag bills automatically by content

Instead of *Matching: None*, give each tag the matching algorithm **Regular
expression** (case-insensitive) with a pattern that names your billers and
looks for payment wording. Keep the two patterns mutually exclusive: a document
tagged both is skipped ("tagged as both bill and bill payment"). For example,
with your billers in place of `biller one|biller two`:

| Tag | Pattern |
| --- | --- |
| `bill-payment` | `(?s)\A(?=.*\b(biller one\|biller two)\b).*(payment (was \|has been )?(\w+ )?(processed\|posted\|confirm\|received)\|thank you for your payment)` |
| `bill` | `(?s)\A(?=.*\b(biller one\|biller two)\b)(?!.*(payment (was \|has been )?(\w+ )?(processed\|posted\|confirm\|received)\|thank you for your payment)).*(due\|statement\|invoice\|bill)` |

(`\|` is only the Markdown table escape; the patterns use a plain `|`.)

- Paperless limits a pattern to **256 characters**, so keep the biller list short
  (`(?s)` and `.` are shorter than `[\s\S]`; the case-insensitive checkbox
  replaces `(?i)`).
- Bills often say "schedule your payment *to be* processed", which is why the
  payment wording only allows "was" / "has been" before the verb.
- Matching only runs when a document is consumed. To check a pattern first,
  test it against your existing documents in a Paperless shell
  (`documents.matching.matches()`) before saving it.
- Reminders and second notices still read as bills; remove the `bill` tag if one
  duplicates a bill you already have.

### 2. Connect it

Either in **Settings → Paperless bill import** (any household; see "One
Paperless per household" above), or — for the server admin's household — in
Our Home's `settings.yml` and `.env` as below. The address goes in `settings.yml`:

```yaml
paperless:
  url: http://paperless:8000                    # container name + internal port, over ourhome_net
  public_url: https://paperless.example.com     # optional, for "Open in Paperless" links
```

The token is a secret, so it goes in `.env`:

```env
PAPERLESS_TOKEN=<the token>
DEV_PAPERLESS_TOKEN=
```

Then restart the web app (`./deploy.sh --no-build`). The empty
`DEV_PAPERLESS_TOKEN` (and the `dev:` section) keep the import off for
`npm run dev`.

Paperless and the web container must share a Docker network (`ourhome_net` in
OurHomeServices). Redeploy.

### 3. Check it before it imports anything

The preview reads Paperless and shows what *would* happen. It writes nothing:

```bash
docker compose exec web npm run paperless:preview        # last 30 days
docker compose exec web npm run paperless:preview -- 90  # last 90 days
```

```
[preview] setup in Paperless:
  tag "bill"                           id 14
  tag "bill-payment"                   id 15
  field "Amount"                       id 2 (monetary)
  field "Due date"                     id 3
  ...
[preview] 3 tagged document(s):
  #512   City Water - October                             BILL     USD57.39  due 2026-10-20  City Water
  #518   Electric payment                                 PAID     USD91.10  paid 2026-10-05  Electric Co
  #520   Phone bill                                       WAIT  no Amount yet
```

Then open **Settings → Paperless bill import**. The first check (within 15
minutes, or *Check now*) marks the start; new and changed documents after that
are imported.

## Troubleshooting

| Settings shows | Fix |
| --- | --- |
| *Not set up* | `paperless.url` (settings.yml) or `PAPERLESS_TOKEN` (.env) is empty, or the app wasn't restarted since. The container log shows a `[settings] …` line on start. |
| *Can't reach Paperless at …* | Wrong URL, or the containers aren't on the same network. Test from the web container: `docker compose exec web node -e "fetch('http://paperless:8000/api/').then(r=>console.log(r.status))"` should print a status (401 is fine), not an error. |
| *Paperless rejected the API token* | Regenerate the token, or the user lacks the view permissions above. |
| *Neither tag … exists* / *Custom field "Amount" doesn't exist* | Create it, or it has an owner and is hidden from the import user. Set its owner to none. |
| Skipped: *no Amount yet* | Fill in Amount in Paperless. |
| Skipped: *no matching unpaid bill* | The bill isn't in Our Home (or is already paid). Add the bill, then edit the payment document in Paperless (any change) to retry it. |
