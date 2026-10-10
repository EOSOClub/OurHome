# TODO

Planned work that isn't built yet. Both items need the website and the
Android app (OurHomeApp) changed together.

## Rooms & floors: next steps

Floors, rooms, task locations and hand-set task order are done (2026-10-10,
`src/lib/places.ts`, `placeService`, Settings → Rooms & floors). Still to do:

- [ ] **Inventory items get a storage room** ("Garage freezer", "Pantry").
  - `InventoryItem.roomId` (+ floor?), the same Location picker as tasks,
    and a "By room" grouping on the Stock page (web + app).
  - Rooms then serve two features: decide whether Settings → Rooms & floors
    stays tied to the Tasks feature (today it's hidden when Tasks is off)
    or shows whenever Tasks *or* Inventory is on.
  - Cover the new field in export/restore (they copy every Task/Item field,
    so it should come along; check `householdRestore.test.ts`).
- [ ] **NFC location tags open a room.** Tags already have
  `represents: "location"`; add `NfcTag.roomId`, set it in the tag's
  settings (web Settings → NFC tags, app scan sheet), and on scan open that
  room's tasks (app: Tasks tab in "By room" view, scrolled to the room; the
  closed-app quick scan opens the app there). Keep the lock-screen rules:
  nothing shown over the keyguard.
