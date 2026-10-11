# Copies screenshots into the wiki's images/ folder and replaces their placeholder blocks.
import re, shutil, sys, pathlib
wiki, src = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
ALT = {
    "bills-overview.png": "The Bills page: totals at the top, an overdue bill, and upcoming bills with Mark paid buttons",
    "bill-create-modal.png": "The New bill form: name, amount, due date, category, who's responsible, repeats, auto-pay and notes",
    "bill-payment-modal.png": "The Record payment form: amount paid, card fee, date and note",
    "bill-detail-page.png": "A bill's own page: amount, progress, details such as account and invoice number, and its payments",
    "calendar-month-view.png": "The Calendar in month view, with events on their days",
    "calendar-week-agenda-views.png": "The Calendar's Week view (left) and Agenda view (right)",
    "calendar-event-modal.png": "The New event form: title, all day, start and end, location, repeats, attendees and notes",
    "settings-overview.png": "The top of the Settings page, with the Task points and Rooms & floors cards",
    "settings-points-timezone.png": "The Task points card: minutes per point, time zone and the day weeks start on",
    "settings-categories-card.png": "The Categories card, with categories for tasks, shopping and inventory",
    "settings-integrations-nfc.png": "The Home Assistant connection card with one token, and the NFC tags card with three mapped tags",
    "rooms-settings-card.png": "The Rooms & floors card: two floors with their rooms, and buttons to reorder, edit or remove them",
    "room-edit-modal.png": "The Edit room window: the room's name and its floor",
    "nfc-web-admin-tag-registry.png": "The NFC tags card in Settings: the form to map a tag, and the tags already mapped",
    "inventory-overview.png": "The Inventory page: the add bar, filters, and items grouped by category with their stock",
    "inventory-adjusters.png": "Inventory rows with − and + buttons, an amount box, and a Low badge on an item running low",
    "inventory-add-item.png": "The add-item bar with More options open: unit, low at, restock every, category and where it's kept",
    "inventory-shopping-handoff.png": "Choosing which shopping list a low item goes on",
    "members-overview.png": "The Members page: the household name, everyone's role, and the Add a member and Permissions cards",
    "members-add-card.png": "The Add a member form: name, username, email, role and a temporary password",
    "members-permissions-grid.png": "The Permissions card: a grid of pages and what each role may add, edit, delete or approve",
    "notifications-page-view.png": "The Notifications page with Unread, Read and All filters and a Mark all read button",
    "profile-overview.png": "The top of the Profile page: stats and the About me card",
    "profile-about-me-card.png": "The About me card: avatar emoji, colour, birthday and a short bio",
    "profile-edit-security.png": "The Account, Edit profile and Change password cards on the Profile page",
    "requests-overview.png": "The Requests page: the New request card, then maintenance requests by status",
    "request-create-form.png": "The New request form, filled in for a TV show request with an optional season",
    "request-media-list.png": "Media requests: movies and TV shows, with Mark as added buttons",
    "request-maintenance-accept.png": "The Accept request window, asking when you'll have it done",
    "rooms-grouped-view.png": "Tasks sorted By room, grouped under floor and room headings",
    "install-setup-wizard-admin.png": "The first-run setup page: household name, admin username, email and password",
    "install-setup-wizard-security.png": "The Secure your home window: Home network and HTTPS, or HTTPS only",
}
(wiki / "images").mkdir(exist_ok=True)
done = set()
for f in sorted(wiki.glob("*.md")):
    lines = f.read_text(encoding="utf-8").split("\n"); out = []; i = 0; n = 0
    while i < len(lines):
        m = re.match(r'<!-- IMAGE PLACEHOLDER: (\S+) -->', lines[i])
        if m and m.group(1) in ALT:
            name = m.group(1); i += 1
            while i < len(lines) and lines[i].startswith(">"): i += 1
            out.append(f"![{ALT[name]}](images/{name})"); done.add(name); n += 1
            continue
        out.append(lines[i]); i += 1
    if n:
        f.write_text("\n".join(out), encoding="utf-8"); print(f"{f.name}: {n} image(s)", flush=True)
for name in sorted(done): shutil.copy2(src / name, wiki / "images" / name)
print(f"copied {len(done)} images; not placed: {sorted(set(ALT) - done) or 'none'}", flush=True)
