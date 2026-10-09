# Adding an NFC tag for a new inventory item

## Easiest: the "Our Home" Android app

**New (blank) tag:** scan it — Android offers Our Home (or open the app first
and scan). Then:

1. **New item** (name, unit, how many you have, "low at") or **Existing item**.
2. **When scanned with the app closed:** *Open the app* or *Quick notification*
   (and which shopping list "Add to list" uses).
3. Save, then **Write tag for Our Home** and hold the tag to the phone again.

**Existing Home Assistant tag:** open Our Home first (otherwise HA grabs it),
scan it, tap **Write tag for Our Home**, hold it again. It keeps the same id,
so the item link carries over; afterwards it always opens Our Home and HA no
longer sees it.

**Quick notification** tags don't open the app: you get a notification with
**−1**, **Amount…** (type e.g. `-2` used or `3` restocked) and **Add to list**.
Every button asks you to unlock first; the lock screen shows no item details.

- Tags written by Our Home hold `ourhome://tag/<id>` plus an Android
  Application Record, so Android never shows an app chooser for them.
- While the app is open it takes every scan.
- **Inventory → Recent scans** shows what was scanned, when, by whom, and
  whether it came from the app or HA.
- To re-point a tag, scan it → **Change item for this tag**.
- Setting up tags needs inventory permission (head, manager, member).
- HA can stay as a display: see `docs/home-assistant.md` → Display-only mode.

---

## Legacy: scanning through Home Assistant

This is the repeatable runbook for putting a new NFC tag into service: scan it
with a phone to add/remove stock of one inventory item.

It assumes the **one-time** Home Assistant setup is already done — the webhook
token, the `rest_command.inventory_scan`, the firewall rule, the **single
generic scan automation** (`HomeAssistant/automation.yml`), and (optionally)
per-phone routing. If not, do [`home-assistant.md`](./home-assistant.md) first.

There is **no automation to create per tag.** One generic automation handles
every tag: the app resolves the scanned `tag_id` to its bound item, so adding a
tag is just app config plus naming the tag in HA. Each tag still maps to exactly
**one** inventory item. The amount (a signed decimal — negative removes, positive
restocks, fractions allowed) is entered on the phone at scan time.

---

## Fast track: auto-register on first scan

You can skip the app config entirely. If the generic automation forwards the HA
tag's friendly `name` (it does — see `name: "{{ trigger.event.data.name }}"` in
`HomeAssistant/automation.yml`), then the **first scan of an unknown tag**
auto-creates the inventory item named after the tag, seeds its quantity from the
amount you type, and binds the tag — all in one scan.

So the minimal flow for a brand-new item is:

1. **Name the tag in HA** → Settings → Tags → (this tag) → set the name (e.g.
   `Coffee beans`). This becomes both the prompt title and the new item's name.
2. **Scan it** and reply with a starting amount (e.g. `3`).

That's it — the item appears in Inventory at quantity 3, already bound to the
tag. Re-scan any time to adjust the amount.

> A scan on an unknown tag with **no** friendly name still returns 404, so a
> stray/misscanned tag can't create a junk item. Use the manual steps below only
> when you want the item name to differ from the HA tag name, or to pre-create
> the item with a unit/low threshold before the first scan.

---

## Info you'll need

Gather these before you start. Most come from two HA screens and one app screen.

| What | Where to get it | Example |
| ---- | --------------- | ------- |
| **Inventory item** | App → Inventory (create it if new) | `Coffee beans` |
| **Tag id** | HA → Developer Tools → Events, listen to `tag_scanned`, scan the tag | `cb1a7141-4cac-4b26-aa1d-4262bd962b87` |
| **Scanner `device_id`** *(only for per-phone notifications)* | same `tag_scanned` event | `<PHONE_DEVICE_ID>` |
| **Phone notify service** *(per-phone notifications)* | HA → Developer Tools → Actions, search `notify.mobile_app` | `notify.mobile_app_pixel_7` |
| **Webhook token** | App → Settings → Home Assistant connection | `kq3V…` (43 characters) |
| **App webhook URL** | The app host's LAN IP + `:3000/api/webhooks/nfc` | `http://APP_HOST:3000/api/webhooks/nfc` |

> The token and webhook URL are **shared across all tags** — they come from the
> one-time setup and don't change when you add a tag. You only need them when
> wiring the `rest_command`, which is also one-time.

---

## Steps

### 1. Create the inventory item (app)

App → **Inventory** → add the item. Set:

- **Name** (and optional **unit**, e.g. `bags`, `rolls`, `oz`).
- **Low at** — the threshold below which it shows a "Low" badge. Leave `0` to
  disable the low flag.

Skip this step if the item already exists.

### 2. Get the tag id (and scanner device id) — HA

HA → **Developer Tools → Events**. Under "Listen to events" enter `tag_scanned`,
click **Start listening**, then **scan the physical tag** with the phone. You'll
see:

```yaml
event_type: tag_scanned
data:
  tag_id: cb1a7141-4cac-4b26-aa1d-4262bd962b87   # <- the tag id
  device_id: <PHONE_DEVICE_ID>    # <- the phone that scanned
  name: Test site
context:
  user_id: <HA_USER_ID>      # <- the HA user who scanned
```

Record the **`tag_id`**. If you route notifications per phone (see
[Per-phone notifications](#per-phone-notifications)), also record the
**`device_id`**.

> A friendly tag name in HA (e.g. "Test site") is **not** the `tag_id`. Always
> take the `tag_id` from the event. The friendly name *is* used as the scan
> notification's title, though — see step 4.

### 3. Map the tag to the item (app)

App → **Settings → NFC tags → Map tag**:

- **Tag id** — the `tag_id` from step 2.
- **Label** — a human name, e.g. `Coffee shelf`.
- **Inventory item** — the item from step 1.

Re-mapping the same tag id later just updates the binding (it's an upsert), so a
tag is easy to repoint at a different item.

### 4. Name the HA tag (sets the notification title)

The generic automation uses the tag's **friendly name** as the prompt title
(`title: "{{ trigger.event.data.name or 'Inventory' }}"`). So name the tag after
the item: HA → **Settings → Tags → (this tag) → Settings (gear)** → set the
name, e.g. `Paper Towels`. Unnamed tags just fall back to the generic title
`Inventory`.

> No automation step. The one generic automation
> (`HomeAssistant/automation.yml`, set up once) already handles this tag — it
> triggers on *any* `tag_scanned`, forwards `trigger.event.data.tag_id` to the
> app, and the app maps it to the item you bound in step 3.

### 5. Test

1. Scan the tag with the phone.
2. Tap the notification, type a number (e.g. `-1`), submit.
3. App → **Inventory**: the item's quantity should change by that amount
   (clamped at `0`), and the scan appears on the Activity page (Stock filter).

You can also test without NFC: HA → **Developer Tools → Actions** →
`rest_command.inventory_scan` with
`data: { tag_id: <your tag id>, amount: -1, actor: <your app username> }`. The
feed should credit that user; an empty/unknown `actor` shows as "System".

---

## Per-phone routing and crediting the scanner

These are configured **once** in the generic automation
(`HomeAssistant/automation.yml`), not per tag. Two `device_id → …` maps drive it:

- `notify_by_device` — sends the prompt only to the phone that scanned.
- `actor_by_device` — credits the scan to that person in the activity feed. The
  value is the **app username**; the webhook resolves it to a household member,
  so the feed shows their real name instead of "System". Unknown/empty → System.

```yaml
variables:
  notify_by_device:
    <PHONE_DEVICE_ID>: notify.mobile_app_your_phone
    <PARTNER_DEVICE_ID>: notify.mobile_app_partner_phone
  actor_by_device:
    <PHONE_DEVICE_ID>: your_username  # app username
    <PARTNER_DEVICE_ID>: partner
  notify_service: >-
    {{ notify_by_device.get(trigger.event.data.device_id,
       'notify.mobile_app_your_phone') }}
  actor: "{{ actor_by_device.get(trigger.event.data.device_id, '') }}"
```

Add one line to each map per phone. To get a phone's `device_id`, have that phone
scan any tag and read it from the `tag_scanned` event (step 2).

> Concurrency: the generic automation runs in `mode: parallel`, so scanning a
> second tag won't cancel a prompt already in flight. The `wait_for_trigger`
> still matches *any* `INV_REPLY`, so if two people reply to different prompts at
> the exact same moment the replies could cross — fine for a single scanner. For
> strict multi-user handling, add a `context: user_id:` filter on the
> `wait_for_trigger` so each reply maps to its own scan.

---

## Quick checklist

Fast track (auto-register on first scan):

```
[ ] HA tag given a friendly name (becomes the item name + prompt title)
[ ] Scanned + replied with a starting amount; item created & bound in the app
[ ] (no app config, no per-tag automation — the one generic automation handles it)
```

Manual mapping (only if the item name differs from the HA tag, or you want a
unit/low threshold set up front):

```
[ ] Inventory item exists in the app
[ ] tag_id captured from Developer Tools → Events (tag_scanned)
[ ] Tag mapped to the item in Settings → NFC tags
[ ] HA tag given a friendly name (becomes the prompt title)
[ ] Scanned + replied with a number; quantity updated in the app
[ ] (no per-tag automation — the one generic automation handles it)
```

---

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| Notification never arrives | Wrong `notify.mobile_app_*` name, or companion app notifications disabled. Verify in Developer Tools → Actions. |
| Reply does nothing | Automation timed out (>2 min), or the `action` id in the notification doesn't match the `wait_for_trigger` (`INV_REPLY`). Check the automation **Trace**. |
| App returns **404** | The scanned `tag_id` isn't mapped, or isn't bound to an item — re-check Settings → NFC tags. |
| App returns **401** | Wrong/expired webhook token in `rest_command`. |
| App returns **422** | `amount` was `0`, missing, or non-numeric (a bad reply text). |
| HA can't reach the app at all | Firewall rule missing, app not running, or VPN blocking LAN — see [`home-assistant.md`](./home-assistant.md). |

Diagnostics live in HA at **Settings → Automations → (this automation) → Traces**
and **Settings → System → Logs**.
