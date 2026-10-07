# Bill import from Paperless-ngx

Bills and bill payments you collect in [Paperless-ngx](https://docs.paperless-ngx.com)
(by email through the Proton Bridge, or as phone photos) show up on the Bills
page on their own. Paperless runs as its own stack; see
[OurHomeServices](https://github.com/EOSOClub/OurHomeServices/tree/main/paperless).

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
- **Read-only.** Our Home never changes anything in Paperless.

## Setup

### 1. In Paperless

1. **Tags:** create `bill` and `bill-payment`. Set *Matching* to **None** and
   *Owner* to **none**, so every user and token can see them.
2. **Custom fields:** make sure **Amount** (Monetary) exists, plus **Due date**
   (Date) and, ideally, **Account number** (Text). Different names are fine; see
   the overrides in `.env.example`.
3. **Tagging:** have your mail rules (or a workflow) assign `bill` to bills and
   `bill-payment` to payment confirmations, or tag them by hand.
4. **A read-only user for Our Home:** *Users & Groups → Add user*, e.g.
   `ourhome`, with only these **view** permissions: *Document*, *Tag*,
   *Correspondent*, *Custom field*. It also needs to see the documents
   themselves. If you use document owners, grant this user (or a group it's in)
   **view** on new documents, for example in an "Added" workflow with
   *Assign view permissions*.
5. **Token:** sign in as that user, go to *My Profile → API Auth Token*, and
   generate one.

### 2. In Our Home's `.env`

```env
SERVER_PAPERLESS_URL=http://paperless:8000      # container name + internal port, over ourhome_net
SERVER_PAPERLESS_TOKEN=<the token>
PAPERLESS_PUBLIC_URL=https://paperless.example.com   # optional, for "Open in Paperless" links
```

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
| *Not set up* | `SERVER_PAPERLESS_URL` or `SERVER_PAPERLESS_TOKEN` isn't reaching the container. Check `docker/docker-compose.yml` passes both. |
| *Can't reach Paperless at …* | Wrong URL, or the containers aren't on the same network. Test from the web container: `docker compose exec web node -e "fetch('http://paperless:8000/api/').then(r=>console.log(r.status))"` should print a status (401 is fine), not an error. |
| *Paperless rejected the API token* | Regenerate the token, or the user lacks the view permissions above. |
| *Neither tag … exists* / *Custom field "Amount" doesn't exist* | Create it, or it has an owner and is hidden from the import user. Set its owner to none. |
| Skipped: *no Amount yet* | Fill in Amount in Paperless. |
| Skipped: *no matching unpaid bill* | The bill isn't in Our Home (or is already paid). Add the bill, then edit the payment document in Paperless (any change) to retry it. |
