# Bills & Payday Tracker — Full Setup Guide (Multi-User)

Tracks recurring bills and payday **per user**, sums what's due before each
user's next payday, sends each user their own Telegram alert with an
interactive breakdown, and gives each user a 6-month calendar forecast and
a checkable monthly bill list on the dashboard — all running in parallel,
completely independent of each other.

## What you're installing

| File | Goes to | Purpose |
|---|---|---|
| `pyscript/bills_payday.py` | `<config>/pyscript/bills_payday.py` | All the logic: date math, sensors, Telegram, calendar/to-do sync, config read/write - for every user |
| `bills_data.yaml` | `<config>/bills_data.yaml` | Every user's bills and payday schedule - editable by hand or via the GUI editor below |
| `bills_payday_automations.yaml` | `<config>/packages/bills_payday_automations.yaml` | Telegram button reply + instant paid-tally update, for any user |
| `www/bills-calendar-todo-card.js` | `<config>/www/bills-calendar-todo-card.js` | Dashboard card with a user dropdown, combining calendar + checklist |
| `www/bills-calendar-card.js` | `<config>/www/bills-calendar-card.js` | Read-only calendar-only card with a user dropdown - for a dedicated Calendar dashboard |
| `www/bills-config-editor-card.js` | `<config>/www/bills-config-editor-card.js` | GUI editor: add/remove users and bills, edit everything, save + auto-sync |
| `tests/test_date_logic.py` | anywhere (run on your own machine) | Standalone tests for the date math and entity naming, no HA needed |

---

## 1. Prerequisites: install pyscript

If you don't already have it:
- Easiest: HACS → Integrations → search "pyscript" → install.
- Manually: copy the `pyscript` custom component into `<config>/custom_components/pyscript`.

Add to `configuration.yaml`:
```yaml
pyscript:
  allow_all_imports: true
  hass_is_global: true
```

**Restart Home Assistant** (not just a reload) after installing pyscript for the first time.

Also confirm you have `telegram_bot:` configured with a working bot - every user's alert reuses this same bot, just routed to each person's own chat.

---

## 2. Install the core files

1. Place `bills_payday.py` at `<config>/pyscript/bills_payday.py`.
2. Place `bills_data.yaml` at `<config>/bills_data.yaml`.
3. Place `bills_payday_automations.yaml` at `<config>/packages/bills_payday_automations.yaml`.
   Requires packages enabled in `configuration.yaml`:
   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```
4. **Restart Home Assistant.**

---

## 3. Configure your users, bills, and paydays

Open `bills_data.yaml`. The top level is a `users:` list - each user has
their own `name`, `telegram_chat_id`, `payday`, and `bills`.

```yaml
users:
  - name: "Alice"
    telegram_chat_id: 111111111

    payday:
      recurrence: weekly
      weekday: friday

    bills:
      - name: "Rent"
        amount: 1450.00
        recurrence: monthly
        due_day: 1

  - name: "Bob"
    telegram_chat_id: 222222222

    payday:
      recurrence: biweekly
      weekday: friday
      anchor_date: "2026-07-10"

    bills:
      - name: "Internet"
        amount: 75.00
        recurrence: monthly
        due_day: 12
```

**Getting a `telegram_chat_id`**: have that person message your bot once,
then visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in a
browser and look for `"chat":{"id": ...}` in the response.

**Payday** - pick exactly one recurrence type per user:
```yaml
payday: {recurrence: weekly, weekday: friday}
payday: {recurrence: biweekly, weekday: friday, anchor_date: "2026-07-10"}
payday: {recurrence: monthly, due_day: 1}   # or due_day: "eom"
```

**Bills** - each one can independently use any of five recurrence types:
```yaml
- {name: "Rent", amount: 1450.00, recurrence: monthly, due_day: 1}
- {name: "Electric", amount: 95.00, recurrence: monthly, due_day: "eom"}
- {name: "Pest Control", amount: 89.00, recurrence: bimonthly, due_day: 5, anchor_month: 1}
- {name: "Car Insurance", amount: 620.00, recurrence: yearly, due_day: 15, due_month: 3}
- {name: "Lawn Service", amount: 40.00, recurrence: weekly, weekday: wednesday}
- {name: "Storage Unit", amount: 60.00, recurrence: biweekly, weekday: monday, anchor_date: "2026-07-06"}
```

You can have as many users and as many bills per user as you want. After
editing, call `pyscript.update_bills_sensors` from Developer Tools →
Actions to refresh immediately (add `user_slug: "alice"` in the service
data to refresh just one person), or wait for the nightly 00:05 refresh.

**Entity naming**: every user gets an auto-generated "slug" from their name
(e.g. "Alice" → `alice`, "María" → `maria`) - this determines their
per-user sensor names (`sensor.next_payday_alice`,
`sensor.bills_due_before_next_payday_alice`,
`sensor.bills_paid_this_month_alice`) and is also used as an owner tag on
their calendar events/checklist items (`[alice] Rent - $450.00`) on the
single shared `calendar.bills`/`todo.bills` entities. You never set the
slug directly, it's always derived from `name`.

---

## 4. Verify the core pipeline works

1. Developer Tools → Actions → call `pyscript.debug_bills_file` - check the
   log lists every user found, with their name and derived slug.
2. Call `pyscript.update_bills_sensors` (no parameters = runs for everyone).
3. Developer Tools → States → check `sensor.next_payday_alice` and
   `sensor.bills_due_before_next_payday_alice` (substitute each user's real
   slug) - the `breakdown` attribute should list their bills due before
   their own next payday.
4. Settings → System → Logs → filter "pyscript" - one `Bills updated for
   <Name>: ...` line per user confirms each one computed correctly.

---

## 5. Telegram alerts (per user)

- Every morning at 8am, pyscript checks **each user's own payday**
  independently. Only users whose payday is actually today get a message.
- To test one person without waiting for their real payday: call
  `pyscript.send_test_alert` with `user_slug: "alice"` in the service data.
  Omit `user_slug` to test everyone at once.
- Each alert routes to that user's own `telegram_chat_id` via the `target`
  parameter - other users never see each other's bills.
- Tapping "View breakdown" replies in that same person's chat with their
  own bill list (handled by `bills_breakdown_callback` in the automations
  file, which works for any user automatically - no per-user setup needed
  for this part).

---

## 6. Calendar view (ONE shared calendar, 6-month forecast, every user)

This is a **one-time setup step**, regardless of how many users you have now
or add later - everyone shares the same calendar entity, tagged per event
by owner.

1. Settings → Devices & Services → Add Integration → **Local Calendar**.
   Name it so the entity_id becomes exactly `calendar.bills` (type "Bills"
   as the name).
2. Install **Calendar Utils** via HACS, once (Custom Repositories → add
   `https://github.com/swehog/hacs_calendar_utils` as an Integration →
   install → restart HA → add the integration). Required for delete
   capability - core Local Calendar has no delete service.
3. Call `pyscript.reset_bills_calendar` (no parameters) to populate the
   6-month forecast for every current user. This also runs automatically
   every night at 00:15, and again after every GUI config editor save.

That's it - adding or removing a user later never requires touching this
integration again. Each event's title is tagged with its owner (e.g.
`[alice] Rent - $450.00`) so the dashboard cards can filter per user.

---

## 7. Monthly checklist with tally (ONE shared list, every user)

Also a **one-time setup step**.

1. Settings → Devices & Services → Add Integration → **Local To-do list**.
   Name it so the entity_id becomes exactly `todo.bills` (type "Bills" as
   the name).
2. Call `pyscript.sync_bills_todo` (no parameters) to populate the current
   month's checklist for every user.
3. `sensor.bills_paid_this_month_<slug>` tracks each user's running paid
   total, updating instantly on checkbox toggle (via the automation in
   `bills_payday_automations.yaml`, which targets the fixed `todo.bills`
   entity - no per-user editing ever needed there either).
4. On the 1st of each month, `pyscript.reset_bills_todo` clears and
   regenerates every user's checklist automatically.

---

## 8. Dashboard: panel view + combined calendar/checklist card

1. Edit your dashboard → **Add a new view** → **View type: Panel**.
2. Copy `bills-calendar-todo-card.js` to `<config>/www/bills-calendar-todo-card.js`.
3. Settings → Dashboards → **⋮** → Resources → Add Resource:
   - URL: `/local/bills-calendar-todo-card.js`
   - Resource type: **JavaScript Module**
4. Add this card to your panel view:
   ```yaml
   type: custom:bills-calendar-todo-card
   title: Bills
   ```
   No `users` list needed - the card fetches the current user list from
   `bills_data.yaml` itself on every load, so adding/removing a user via
   the GUI editor never requires touching this card's config either.
5. **Hard-refresh your browser** (Ctrl+Shift+R). If you update the card's
   JS file later, bump the resource URL to `?v=2` (increment as needed) to
   force past the browser's aggressive caching of Lovelace resources.

A dropdown in the card's header switches between users instantly.

If chips don't appear or don't respond to clicks for a given user, open the
browser console (F12) - it logs the raw calendar/to-do API responses
(labeled with the selected user's name) on every load.

---

## 8a. A dedicated Calendar dashboard (calendar-only, no checklist)

If you'd rather have one single "Calendar" page for browsing everyone's
bills - separate from the combined card in step 8, with no checklist or
click-to-toggle - use `bills-calendar-card.js` instead. Same dropdown
mechanic and same auto-discovered user list, but purely for viewing.

1. Copy `bills-calendar-card.js` to `<config>/www/bills-calendar-card.js`.
2. Settings → Dashboards → **⋮** → Resources → Add Resource:
   - URL: `/local/bills-calendar-card.js`
   - Resource type: **JavaScript Module**
3. Create a new Dashboard (Settings → Dashboards → Add Dashboard) titled
   e.g. "Calendar" with an icon - this gives you the dedicated sidebar
   item. Set its view to **Panel**, and add:
   ```yaml
   type: custom:bills-calendar-card
   title: Bills Calendar
   ```
4. Hard-refresh your browser (bump `?v=` on the resource URL if you update
   this file later).

This and the combined card in step 8 can both exist at once - use whichever
fits a given dashboard: this one for a clean, browse-only calendar view,
the combined one wherever you also want the paid checklist alongside it.

---

## 8b. GUI config editor - add/remove users and bills without editing YAML

This gives you a form-based editor for everything in `bills_data.yaml`:
add/remove users, add/remove bills, edit every field, and a single "Save &
Sync" button that writes the file and immediately refreshes sensors, the

6-month calendar forecast, and everyone's checklist.

**Important trade-off, worth knowing before your first save**: this editor
writes `bills_data.yaml` as a plain auto-generated YAML dump. The first
time you save from the GUI, any comments or custom formatting currently in
the file will be replaced. A backup of whatever was there is automatically
saved alongside it as `bills_data.yaml.bak` before every save, so nothing
is ever lost - but going forward, treat the GUI as the primary way you edit
bills, rather than mixing hand-edits and GUI-edits.

**Setup:**

1. `bills_payday.py` already includes the two backend services this needs
   (`get_bills_config`, `save_bills_config`) - if you're updating from an
   earlier version, just replace the file as usual.
2. Copy `bills-config-editor-card.js` to `<config>/www/bills-config-editor-card.js`.
3. Settings → Dashboards → **⋮** → Resources → Add Resource:
   - URL: `/local/bills-config-editor-card.js`
   - Resource type: **JavaScript Module**
4. **For a proper sidebar menu item** (matching the original ask): Settings
   → Dashboards → **Add Dashboard** → give it a title like "Bills Config"
   and pick an icon (e.g. a wallet or receipt icon). New dashboards appear
   in the sidebar automatically. Set its single view to **Panel**, and add:
   ```yaml
   type: custom:bills-config-editor-card
   ```
5. Hard-refresh your browser (Ctrl+Shift+R).

**What it looks like**: one collapsible-feeling block per user, with their
name, Telegram chat ID, and payday settings at the top, followed by a row
per bill (name, amount, recurrence type, and whatever fields that
recurrence needs - selecting a different recurrence type swaps the visible
fields automatically). "+ Add Bill" and "+ Add User" buttons at the
relevant levels, a trash icon to remove either. Nothing is saved until you
press "Save & Sync Everyone" - up to that point you can add/remove/edit
freely and back out by just navigating away.

**A note on what "integration level" would really mean**: a true entry
under Settings → Devices & Services (with its own config flow, like Local
Calendar or pyscript itself) requires building an actual Home Assistant
custom integration - a proper Python package with async setup, a
config_flow.py, translations, and packaging for HACS - which is a
fundamentally different, much larger undertaking than anything else in
this project. The sidebar-dashboard approach above gets you the same
practical outcome (a dedicated, easy-to-reach place to manage everything)
without that scope. If you ever want to go that route for real, it's a
legitimate next project, just a separate one from this script-based setup.

---

## 9. Testing

- **Date math + entity naming, no HA needed**: `python3 test_date_logic.py`
  anywhere with Python 3. Covers eom/leap-year/weekly/biweekly/bimonthly
  date edge cases, plus `slugify()` (including accented names).
- **Inside HA**: `pyscript.debug_bills_file`, `pyscript.update_bills_sensors`,
  `pyscript.send_test_alert`, `pyscript.reset_bills_calendar`,
  `pyscript.sync_bills_todo` - all accept an optional `user_slug` to target
  one person, or omit it to run for everyone. All callable on demand from
  Developer Tools → Actions.

---

## Troubleshooting quick reference

Issues actually hit while building this, in case they recur:

- **`open()` / `name 'open' is not defined`** - pyscript blocks direct file I/O in top-level scripts. Fixed via `@pyscript_executor` on file-reading functions.
- **`NotImplementedError: not implemented ast ...`** - pyscript's interpreter doesn't support every Python construct (e.g. bare generator expressions). Swap for a more basic equivalent (list comprehension, explicit loop).
- **Telegram `inline_keyboard` `ValueError: too many values to unpack`** - buttons need `[[["text", "data"]]]` shape, not colon-strings.
- **Calendar REST 404** - the endpoint is `/api/calendars/<entity_id>` (plural), not `/api/calendar/<entity_id>`.
- **`calendar.get_events` resolves to Python's stdlib instead of the HA service** - happens if you `import calendar` without renaming it, shadowing pyscript's `calendar.*` namespace. Fixed via `import calendar as pycal`.
- **`calendar_utils.get_events` schema errors** - it uses `start_date_time`/`end_date_time` (matching the native calendar service), not `start_date`/`end_date` shown in some examples. Its response shape is `{entity_id: [events...]}` - a plain list per entity, not `{entity_id: {"events": [...]}}`.
- **`todo.item_completed`/`todo.item_removed` triggers require an explicit `target`** - fixed to the single shared `todo.bills` entity now, so this never needs per-user maintenance (it did in an earlier per-user-entity version of this design).
- **Custom card changes don't show up** - browsers cache Lovelace resource JS aggressively. Bump the `?v=` suffix on the resource URL.
- **Config editor "Save" fails or the form loads empty** - open the browser console (F12); both `get_bills_config` and `save_bills_config` log their full response. The service-response mechanism (`@service(supports_response="only")`) was verified against pyscript's documentation but the card itself wasn't tested against a live instance before shipping - if the load/save calls fail outright, check that `bills_payday.py` was actually updated to include both services (grep the file for `get_bills_config`).
- **Saved via the GUI and your hand-written comments in `bills_data.yaml` disappeared** - expected, not a bug - see section 8b. Check `bills_data.yaml.bak` for the pre-save version if you need to recover something.

---

## Notes

- This is a genuinely breaking change from the single-user version - if
  you had a flat `payday:`/`bills:` structure before, move your existing
  bills under one user entry in the new `users:` list, and add
  `telegram_chat_id` for them.
- **Adding/removing a user is now GUI-only** - use the config editor
  (section 8b) and nothing else needs to change. The Local Calendar and
  Local To-do list integrations (sections 6-7) are a **one-time setup**,
  shared by every user via owner-tagged titles - not per-user anymore.
  There's still no way to auto-provision a brand-new Home Assistant
  *integration* from a script, but with the shared-entity design, you only
  ever need to do that once, period, not per person.
- If you have an old per-user version of this setup (separate
  `calendar.bills_<slug>`/`todo.bills_<slug>` entities, or an even older
  flat `bills_payday.yaml` HA *package* with input_datetime/input_number
  helpers), delete the old integrations for those - they're superseded by
  the single shared `calendar.bills`/`todo.bills` entities described above.
