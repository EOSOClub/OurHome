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
    "members-overview.png": "The Members page: the household name, the Add a member card, everyone's role, and the Supervision card",
    "members-add-card.png": "The Add a member form: name, username, email, role and a temporary password",
    "members-permissions-grid.png": "The Permissions card: a grid of pages and what each role may add, edit, delete or approve",
    "members-supervision.png": "The Supervision card: each child and teen with a tick box for every adult who may look after them",
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
    "home-dashboard.png": "The Home screen: shortcut buttons, Needs you, This week's points, Around the house and Coming up",
    "home-account-menu.png": "The account menu: Profile, Activity, Points, Household members, Settings, Server, theme, Report a bug and Sign out",
    "home-phone.png": "OurHome on a phone, with the Home, Tasks, Shop, Stock and More bar along the bottom",
    "tasks-overview.png": "The Tasks & Chores page: search, filters and sort along the top, then the tasks soonest due first",
    "task-details-checklist.png": "A task's Details opened: its checklist steps with their points, and its History",
    "task-create-form.png": "The new task form for a recurring chore: location buttons for each floor and room, repeats, take turns, runs in cycles, time and points, checklist",
    "shopping-overview.png": "The Shopping page: list buttons, the summary, the add box, items grouped by category and the In cart section",
    "shopping-add-options.png": "The add box with More options open: priority, category, est. price, notes and a link with Fetch details",
    "location-map-places-card.png": "The Map places card in Settings: Home, a store that reminds about Groceries, and a school, each with how close counts as there",
    "location-map-place-dialog.png": "The Edit map place window: name, kind, address search, a map with the pin and its circle, how close counts as there, and the lists to remind about",
    "location-live-check-limits.png": "The Live location checks card in Settings: the longest a check may run and how often it may update",
    "location-map-page.png": "The Map page: the household's places on a map with who is at each, someone away at the spot they were last seen, and lists of who's where and the places",
    "location-live-check.png": "The Map page during a live check: the person's live dot labelled with how long ago it updated, and the running check with a Stop button",
    "location-start-check.png": "The Check location window: how long to check for and how often to update",
    "location-ring-phone.png": "The Ring phone card on the Map page: each child the viewer looks after, with a Ring button",
    "location-whos-where.png": "The Who's where card on the Home screen: each person who shares, their phone's battery, where they are and since when",
    "location-profile-card.png": "The Location card on a teen's Profile: a live check running with a Stop button, the two switches, and the list of live checks on them",
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
# Copy every shot that was taken, not only the newly placed ones, so a reshoot
# replaces the images already in the wiki.
copied = sorted(name for name in ALT if (src / name).exists())
for name in copied: shutil.copy2(src / name, wiki / "images" / name)
print(f"placed {len(done)} new image(s); copied {len(copied)} image(s)", flush=True)
missing = sorted(set(ALT) - set(copied))
if missing: print(f"not taken (left as they are): {missing}", flush=True)
