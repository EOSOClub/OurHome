# Home Assistant: NFC inventory scans

> **Recommended now: scan in the "Our Home" Android app, and use HA only as a
> display.** The app reads the same tags (it uses the tag id HA wrote, so
> existing mappings keep working), applies the amount, and sets up new tags on
> the spot — no per-tag HA or site config. See
> [`adding-nfc-tags.md`](./adding-nfc-tags.md).
>
> **Display-only mode:** HA polls a read-only feed,
> `GET /api/integrations/inventory` (same token as below, `Authorization:
> Bearer <token>`), and shows quantities / low items. Ready-to-paste config:
> [`HomeAssistant/display.yaml`](../HomeAssistant/display.yaml). Once that's in,
> the scan automation and `rest_command` below can be disabled.
>
> The webhook flow below still works unchanged if you keep using HA for scans.

Home Assistant (HA) and this app run on the same LAN, so HA can call the app
directly — nothing needs to be exposed to the public internet.

When an NFC tag is scanned, HA prompts you for a **number** and POSTs it to the
app. The number is a **signed delta**: negative removes stock, positive
restocks, and fractions are allowed (e.g. `-1`, `2`, `0.5`). The result is
clamped at `0`. Each tag is bound to exactly one inventory item in the app
(Settings → NFC tags); the amount is supplied per scan.

> This page covers the **one-time** setup. To put a **new tag** into service
> afterwards, follow [`adding-nfc-tags.md`](./adding-nfc-tags.md).

## 1. Create a token

In the app: **Settings → Home Assistant connection → Create token**. Copy the
token immediately — it is shown only once. Only the hash is stored.

## 2. Map your tags

In the app: **Settings → NFC tags**. For each physical tag, enter:

- **Tag id** — the stable id HA reports for the tag (e.g. `pantry_coffee`).
- **Label** — a human name (e.g. "Coffee shelf").
- **Inventory item** — the item this tag adjusts.

## 3. Configure Home Assistant

Replace `APP_HOST` with the app's LAN address and `YOUR_TOKEN` with the token
from step 1.

`configuration.yaml` — a reusable REST command:

```yaml
rest_command:
  inventory_scan:
    url: "http://APP_HOST:3000/api/webhooks/nfc"
    method: POST
    headers:
      Authorization: "Bearer YOUR_TOKEN"
      Content-Type: "application/json"
    payload: '{"tagId": "{{ tag_id }}", "amount": {{ amount }}, "actor": "{{ actor }}", "name": "{{ name }}"}'
```

`name` is the HA tag's friendly name. It is optional and only used the **first**
time an unknown tag is scanned: the app auto-creates an inventory item with that
name, seeds its quantity from the scanned amount, and binds the tag — no app
config needed. Once a tag is bound, `name` is ignored. A scan with no friendly
name on an unknown tag still returns 404 (so a stray/misscanned tag can't create
a junk item).

`actor` is the app **username** of the person who scanned. It is optional — an
empty or unknown value just logs the change as "System" — and is supplied by the
automation via a per-phone map (see [Per-phone notifications](#per-phone-notifications)
and `actor_by_device` in `HomeAssistant/automation.yml`).

Then an automation that fires on a tag scan, asks for the number, and calls the
command. The companion app's actionable notifications support a free-text
`reply`, which is the simplest way to capture an arbitrary (possibly negative or
fractional) value:

```yaml
automation:
  - alias: "Inventory tag scanned"
    trigger:
      - platform: event
        event_type: tag_scanned
    action:
      - alias: "Ask for the amount"
        event: mobile_app_notification_action  # see notify action below
      - service: notify.mobile_app_your_phone
        data:
          message: "How many? (use a negative number to remove)"
          data:
            actions:
              - action: "REPLY"
                title: "Enter amount"
                behavior: "textInput"
      # When the reply arrives, call the REST command with the typed value:
      - wait_for_trigger:
          - platform: event
            event_type: mobile_app_notification_action
            event_data:
              action: "REPLY"
        timeout: "00:01:00"
      - service: rest_command.inventory_scan
        data:
          tag_id: "{{ trigger.event.data.tag_id }}"
          amount: "{{ wait.trigger.event.data.reply_text | float }}"
          actor: "{{ actor }}"   # app username; see actor_by_device
          name: "{{ trigger.event.data.name }}"   # auto-registers an unknown tag
```

> **One automation for every tag.** Because the app resolves the scanned
> `tag_id` to its bound item, this single automation handles all tags — there's
> no need to clone it per item. Trigger on `tag_scanned` with **no** `tag_id`
> filter, set the notification title from `trigger.event.data.name` (the HA
> tag's friendly name), and run it in `mode: parallel` so concurrent scans don't
> cancel each other. See `HomeAssistant/automation.yml` for the complete file.

> Prefer a dashboard instead of a notification? Use an `input_number` helper and
> a button that calls `rest_command.inventory_scan` with `amount:
> "{{ states('input_number.scan_amount') | float }}"`.

## 4. Test from the LAN

```bash
curl -X POST http://APP_HOST:3000/api/webhooks/nfc \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tagId":"pantry_coffee","amount":-1.5}'
```

A success returns `{ "ok": true, "data": { ... } }` with the updated item. The
scan also appears in the household activity feed and is recorded in `EventLog`.

### Responses

| Status | Meaning |
| ------ | ------- |
| 200    | Applied; body has the updated item |
| 401    | Missing or invalid token |
| 404    | Tag id isn't registered (and no friendly `name` was sent to auto-register it), or it exists but isn't bound to an item |
| 422    | Body failed validation (e.g. `amount` is `0` or missing) |
