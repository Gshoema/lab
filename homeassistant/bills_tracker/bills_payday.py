"""
Bills & Payday Tracker (pyscript) - MULTI-USER VERSION

Place at: <config>/pyscript/bills_payday.py
Bill data lives at: <config>/bills_data.yaml

Requires in configuration.yaml:

  pyscript:
    allow_all_imports: true
    hass_is_global: true

HOW THIS AVOIDS THE open()-NOT-DEFINED ISSUE:
Pyscript's top-level scripts run through a restricted interpreter that blocks
open()/exec() for sandboxing. The @pyscript_compile / @pyscript_executor
decorators compile a specific function to genuine native Python, giving it
real open(), read(), etc. @pyscript_executor additionally runs it in a
separate thread so file I/O doesn't block Home Assistant's main event loop.

MULTI-USER DESIGN:
bills_data.yaml has a top-level "users" list. Each user has their own
name, payday, bills, and (optional) telegram_chat_id. Sensors are
per-user, suffixed with a "slug" derived from the user's name (e.g.
"Alice" -> "alice"), generated with slugify() below.

The calendar and to-do checklist are SHARED across every user - just ONE
Local Calendar integration (entity_id calendar.bills) and ONE Local To-do
list integration (entity_id todo.bills), set up once, ever. Each
event/item's title is tagged with its owner (e.g. "[alice] Rent -
$450.00") rather than using a separate HA entity per person - this means
adding or removing a user via the GUI config editor never requires
creating or deleting a Home Assistant integration.

Entities:
  sensor.next_payday_<slug>                    (one per user, auto-created)
  sensor.bills_due_before_next_payday_<slug>    (one per user, auto-created)
  sensor.bills_paid_this_month_<slug>           (one per user, auto-created)
  calendar.bills                                 (ONE, shared, set up once)
  todo.bills                                     (ONE, shared, set up once)

Most services accept an optional user_slug parameter: pass it to target
just that one user (e.g. for testing), or omit it to run for every user
(used by the nightly cron triggers automatically).

After editing bills_data.yaml, either wait for the nightly refresh (00:05)
or call the service `pyscript.update_bills_sensors` from
Developer Tools > Actions to refresh immediately.
"""

import yaml
import re
import json
import calendar as pycal
import unicodedata
from datetime import date, timedelta

BILLS_FILE = "/config/bills_data.yaml"

# Single shared calendar and to-do list for EVERY user - set up once, ever.
# Ownership is tagged directly in each event/item's title as "[slug] Rest
# of title", rather than using a separate HA entity per user - this means
# adding/removing a user never requires creating or deleting an
# integration. (An earlier design considered the "description" field
# instead, but that requires an entity feature flag that varies by backend
# and would raise a hard validation error if unsupported - tagging the
# title itself only uses mechanics already proven to work throughout this
# whole project.)
CALENDAR_ENTITY = "calendar.bills"
TODO_ENTITY = "todo.bills"

WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


# ---------------------------------------------------------------------------
# Native-compiled functions (real Python - can use open(), etc.)
# ---------------------------------------------------------------------------

@pyscript_compile
def slugify(name):
    """'María Smith' -> 'maria_smith'. Used to build per-user entity_ids
    and title tags. Normalizes accented characters to plain ASCII rather
    than dropping them. Must stay in sync with the JS slugify() in both
    card files - if you change this, change that too, or lookups will
    mismatch."""
    s = name.strip().lower()
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


@pyscript_compile
def tag_title(owner_slug, title):
    """'alice', 'Rent - $450.00' -> '[alice] Rent - $450.00'"""
    return f"[{owner_slug}] {title}"


@pyscript_compile
def parse_tagged_title(tagged):
    """'[alice] Rent - $450.00' -> ('alice', 'Rent - $450.00').
    Returns (None, original_text) if no tag is present."""
    if not tagged:
        return None, ""
    m = re.match(r"^\[([a-z0-9_]+)\]\s*(.*)$", tagged)
    if m:
        return m.group(1), m.group(2)
    return None, tagged


@pyscript_compile
def clamp_day(year, month, day):
    """Handles 'eom' (end of month) and clamps numeric days to valid range,
    e.g. 31 in February becomes 28 (or 29 in a leap year)."""
    last_day = pycal.monthrange(year, month)[1]
    if isinstance(day, str) and day.lower() == "eom":
        return last_day
    return min(int(day), last_day)


@pyscript_compile
def resolve_weekday(weekday):
    """Accepts either a weekday name ('friday') or an int 0-6 (Monday=0)."""
    if isinstance(weekday, str):
        key = weekday.strip().lower()
        if key not in WEEKDAYS:
            raise ValueError(f"Unknown weekday name: {weekday}")
        return WEEKDAYS[key]
    return int(weekday)


@pyscript_compile
def next_occurrence(today, recurrence, due_day=None, due_month=None, weekday=None, anchor_date=None, anchor_month=None):
    if recurrence == "monthly":
        day = clamp_day(today.year, today.month, due_day)
        candidate = date(today.year, today.month, day)
        if candidate >= today:
            return candidate
        month = today.month + 1
        year = today.year
        if month > 12:
            month = 1
            year += 1
        day = clamp_day(year, month, due_day)
        return date(year, month, day)

    elif recurrence == "bimonthly":
        # Charges every 2 months. anchor_month establishes which months are
        # "on" (e.g. anchor_month=1 means Jan/Mar/May/Jul/Sep/Nov charge) -
        # parity of (month - anchor_month).
        anchor_m = int(anchor_month)
        month = today.month
        year = today.year
        if (month - anchor_m) % 2 == 0:
            day = clamp_day(year, month, due_day)
            candidate = date(year, month, day)
            if candidate >= today:
                return candidate
        while True:
            month += 1
            if month > 12:
                month = 1
                year += 1
            if (month - anchor_m) % 2 == 0:
                day = clamp_day(year, month, due_day)
                return date(year, month, day)

    elif recurrence == "yearly":
        month = int(due_month)
        day = clamp_day(today.year, month, due_day)
        candidate = date(today.year, month, day)
        if candidate >= today:
            return candidate
        year = today.year + 1
        day = clamp_day(year, month, due_day)
        return date(year, month, day)

    elif recurrence == "weekly":
        wd = resolve_weekday(weekday)
        days_ahead = (wd - today.weekday()) % 7  # 0 if today IS that weekday
        return today + timedelta(days=days_ahead)

    elif recurrence == "biweekly":
        # Same weekday as "weekly", but only every other occurrence counts.
        # anchor_date is a known past/upcoming payday on this weekday - the
        # 14-day parity from that date determines which weeks are "on".
        wd = resolve_weekday(weekday)
        days_ahead = (wd - today.weekday()) % 7
        candidate = today + timedelta(days=days_ahead)
        anchor = date.fromisoformat(anchor_date)
        diff_days = (candidate - anchor).days
        if diff_days % 14 != 0:
            candidate = candidate + timedelta(days=7)
        return candidate

    else:
        raise ValueError(f"Unknown recurrence type: {recurrence}")


@pyscript_compile
def occurrences_in_month(recurrence, year, month, due_day=None, due_month=None, weekday=None, anchor_date=None, anchor_month=None):
    """Returns a list of every occurrence date within the given calendar
    month. Monthly/yearly/bimonthly bills produce 0 or 1 dates; weekly/
    biweekly produce however many fall within the month."""
    first_day = date(year, month, 1)
    last_day = date(year, month, pycal.monthrange(year, month)[1])

    if recurrence == "monthly":
        day = clamp_day(year, month, due_day)
        return [date(year, month, day)]

    elif recurrence == "bimonthly":
        anchor_m = int(anchor_month)
        if (month - anchor_m) % 2 != 0:
            return []
        day = clamp_day(year, month, due_day)
        return [date(year, month, day)]

    elif recurrence == "yearly":
        if int(due_month) != month:
            return []
        day = clamp_day(year, month, due_day)
        return [date(year, month, day)]

    elif recurrence in ("weekly", "biweekly"):
        occurrences = []
        cursor = first_day
        while cursor <= last_day:
            nxt = next_occurrence(cursor, recurrence, weekday=weekday, anchor_date=anchor_date)
            if nxt > last_day:
                break
            occurrences.append(nxt)
            cursor = nxt + timedelta(days=1)
        return occurrences

    else:
        raise ValueError(f"Unknown recurrence type: {recurrence}")


# ---------------------------------------------------------------------------
# File I/O - @pyscript_executor: native Python + runs in a thread (non-blocking)
# ---------------------------------------------------------------------------

@pyscript_executor
def read_raw():
    with open(BILLS_FILE, "r") as f:
        return f.read()


@pyscript_executor
def load_data():
    with open(BILLS_FILE, "r") as f:
        return yaml.safe_load(f)


@pyscript_executor
def write_data(data):
    """Writes the full config dict back to bills_data.yaml. NOTE: this
    replaces the file with a plain auto-generated YAML dump - any comments
    or custom formatting in the current file will be lost the first time
    this is used. A one-time backup is made alongside it as
    bills_data.yaml.bak before overwriting."""
    try:
        with open(BILLS_FILE, "r") as f:
            existing = f.read()
        with open(BILLS_FILE + ".bak", "w") as f:
            f.write(existing)
    except FileNotFoundError:
        pass

    with open(BILLS_FILE, "w") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)


# ---------------------------------------------------------------------------
# Per-user helpers (plain functions - no pyscript-only globals, safe to
# call from anywhere)
# ---------------------------------------------------------------------------

def users_matching(data, user_slug):
    """Returns the list of users to operate on: just one (if user_slug is
    given and matches) or all of them (if user_slug is None)."""
    all_users = data.get("users", [])
    if user_slug is None:
        return all_users
    return [u for u in all_users if slugify(u["name"]) == user_slug]


def entity_exists(entity_id):
    """Checks whether an entity exists before calling a service against
    it, so a missing calendar.bills/todo.bills gives one clean, specific
    error instead of an unhandled exception."""
    try:
        return state.get(entity_id) is not None
    except Exception:
        return False


def compute_payday_window(user, today):
    """Returns (next_payday, window_end) for one user. next_payday can
    equal today (needed for the alert trigger); window_end is always
    strictly in the future (needed so the bill-summing window never
    collapses to zero days on the user's actual payday)."""
    payday_cfg = user["payday"]
    next_payday = next_occurrence(
        today,
        payday_cfg["recurrence"],
        due_day=payday_cfg.get("due_day"),
        due_month=payday_cfg.get("due_month"),
        weekday=payday_cfg.get("weekday"),
        anchor_date=payday_cfg.get("anchor_date"),
        anchor_month=payday_cfg.get("anchor_month"),
    )

    if next_payday == today:
        window_end = next_occurrence(
            today + timedelta(days=1),
            payday_cfg["recurrence"],
            due_day=payday_cfg.get("due_day"),
            due_month=payday_cfg.get("due_month"),
            weekday=payday_cfg.get("weekday"),
            anchor_date=payday_cfg.get("anchor_date"),
            anchor_month=payday_cfg.get("anchor_month"),
        )
    else:
        window_end = next_payday

    return next_payday, window_end


def compute_bills_due(user, today, window_end):
    """Returns (total, breakdown) for every bill of this user due on or
    before window_end."""
    total = 0.0
    breakdown = []
    for b in user.get("bills", []):
        due = next_occurrence(
            today,
            b["recurrence"],
            due_day=b.get("due_day"),
            due_month=b.get("due_month"),
            weekday=b.get("weekday"),
            anchor_date=b.get("anchor_date"),
            anchor_month=b.get("anchor_month"),
        )
        if due <= window_end:
            total += float(b["amount"])
            breakdown.append(
                {"name": b["name"], "amount": float(b["amount"]), "due": due.isoformat()}
            )
    breakdown.sort(key=lambda x: x["due"])
    return round(total, 2), breakdown


def all_user_bills_this_month(user):
    """Every occurrence date within the current calendar month for one
    user's bills. Used by the to-do checklist sync (stays scoped to the
    current month only)."""
    today = date.today()
    year, month = today.year, today.month
    items = []
    for b in user.get("bills", []):
        dates = occurrences_in_month(
            b["recurrence"], year, month,
            due_day=b.get("due_day"), due_month=b.get("due_month"),
            weekday=b.get("weekday"), anchor_date=b.get("anchor_date"),
            anchor_month=b.get("anchor_month"),
        )
        for d in dates:
            items.append({"name": b["name"], "amount": float(b["amount"]), "due": d.isoformat()})
    items.sort(key=lambda x: x["due"])
    return items


def all_user_bills_next_n_months(user, n=6):
    """Every occurrence date across the current month plus (n-1) more
    months ahead, for one user's bills. Used by the calendar forecast."""
    today = date.today()
    items = []
    for i in range(n):
        m = today.month + i
        y = today.year + (m - 1) // 12
        mm = ((m - 1) % 12) + 1
        for b in user.get("bills", []):
            dates = occurrences_in_month(
                b["recurrence"], y, mm,
                due_day=b.get("due_day"), due_month=b.get("due_month"),
                weekday=b.get("weekday"), anchor_date=b.get("anchor_date"),
                anchor_month=b.get("anchor_month"),
            )
            for d in dates:
                items.append({"name": b["name"], "amount": float(b["amount"]), "due": d.isoformat()})
    items.sort(key=lambda x: x["due"])
    return items


# ---------------------------------------------------------------------------
# Sensors + Telegram alert (per user)
# ---------------------------------------------------------------------------

@time_trigger("cron(5 0 * * *)")
@service
def update_bills_sensors(user_slug=None):
    """Recomputes next payday + bill total/breakdown for one user (pass
    user_slug) or every user (omit it - used by the nightly cron)."""
    data = load_data()
    today = date.today()

    for user in users_matching(data, user_slug):
        slug = slugify(user["name"])
        next_payday, window_end = compute_payday_window(user, today)
        total, breakdown = compute_bills_due(user, today, window_end)

        state.set(
            f"sensor.next_payday_{slug}",
            value=next_payday.isoformat(),
            new_attributes={"user": user["name"]},
        )
        state.set(
            f"sensor.bills_due_before_next_payday_{slug}",
            value=total,
            new_attributes={
                "unit_of_measurement": "$",
                "breakdown": breakdown,
                "bill_count": len(breakdown),
                "next_payday": next_payday.isoformat(),
                "window_end": window_end.isoformat(),
                "user": user["name"],
            },
        )
        log.info(
            f"Bills updated for {user['name']}: ${total} due before {window_end.isoformat()} "
            f"(next_payday={next_payday.isoformat()}) across {len(breakdown)} bills"
        )


@time_trigger("cron(0 8 * * *)")
@service
def payday_alert_check(user_slug=None):
    """Runs every morning for one user (or every user); sends that user's
    Telegram alert only if today IS their payday."""
    update_bills_sensors(user_slug=user_slug)
    data = load_data()
    today_str = date.today().isoformat()

    for user in users_matching(data, user_slug):
        slug = slugify(user["name"])
        next_payday_val = state.get(f"sensor.next_payday_{slug}")
        if next_payday_val == today_str:
            _send_alert(user, slug)
        else:
            log.info(f"payday_alert_check: today is not payday for {user['name']} (next_payday={next_payday_val})")


@service
def send_test_alert(user_slug=None):
    """Sends the Telegram alert immediately for one user (pass user_slug)
    or every user (omit it), regardless of whether today is actually
    payday. Call from Developer Tools > Actions to test formatting/delivery."""
    update_bills_sensors(user_slug=user_slug)
    data = load_data()
    for user in users_matching(data, user_slug):
        slug = slugify(user["name"])
        _send_alert(user, slug)


def _send_alert(user, slug):
    chat_id = user.get("telegram_chat_id")
    if not chat_id:
        log.info(f"_send_alert: {user['name']} has no telegram_chat_id set, skipping Telegram alert (sensors were still updated)")
        return

    total = state.get(f"sensor.bills_due_before_next_payday_{slug}")
    attrs = state.getattr(f"sensor.bills_due_before_next_payday_{slug}") or {}
    breakdown = attrs.get("breakdown") or []

    if breakdown:
        lines = "\n".join(
            [f"• {b['name']}: ${b['amount']} (due {b['due']})" for b in breakdown]
        )
    else:
        lines = "No bills due before your next payday."

    message = f"💰 Payday, {user['name']}!\nBills due before your next payday: ${total}\n\n{lines}"

    telegram_bot.send_message(
        message=message,
        parse_mode="markdown",
        chat_id=[chat_id],
        inline_keyboard=[[["View breakdown", f"/bills_breakdown_{slug}"]]],
    )


@service
def debug_bills_file():
    """Diagnostic: shows exactly what pyscript reads from bills_data.yaml,
    including hidden/invisible characters, and lists every user found.
    Call from Developer Tools > Actions as pyscript.debug_bills_file."""
    try:
        raw = read_raw()
    except Exception as e:
        log.error(f"debug_bills_file: could not open {BILLS_FILE}: {e!r}")
        return

    log.info(f"debug_bills_file: path={BILLS_FILE}")
    log.info(f"debug_bills_file: length={len(raw)} characters")
    log.info(f"debug_bills_file: first 150 chars repr={raw[:150]!r}")

    try:
        parsed = load_data()
    except Exception as e:
        log.error(f"debug_bills_file: load_data() raised: {e!r}")
        return

    log.info(f"debug_bills_file: parsed type={type(parsed)}")
    if isinstance(parsed, dict):
        log.info(f"debug_bills_file: top-level keys={list(parsed.keys())}")
        users = parsed.get("users", [])
        log.info(f"debug_bills_file: {len(users)} users found: {[(u.get('name'), slugify(u.get('name', ''))) for u in users]}")
    else:
        log.info(f"debug_bills_file: parsed value={parsed!r}")


# ---------------------------------------------------------------------------
# Config editor GUI support (read/write bills_data.yaml as JSON, for the
# bills-config-editor-card.js dashboard card)
# ---------------------------------------------------------------------------

@service(supports_response="only")
def get_bills_config():
    """Returns the full parsed bills_data.yaml as a service response, for
    the config editor card to load into its form. Called from the
    frontend via a websocket call_service message with return_response:
    true - see bills-config-editor-card.js for the exact call shape."""
    try:
        data = load_data()
    except Exception as e:
        log.error(f"get_bills_config: failed to load {BILLS_FILE}: {e!r}")
        return {"users": [], "error": str(e)}
    return {"users": data.get("users", [])}


@service(supports_response="only")
def save_bills_config(config_json=None):
    """Accepts the full bills configuration as a JSON string (shape:
    {"users": [...]}) from the config editor card, writes it to
    bills_data.yaml (backing up the previous version to
    bills_data.yaml.bak first), then refreshes sensors, the 6-month
    calendar forecast, and the checklist for every user so the dashboard
    reflects the change immediately. Returns {"success": true/false, ...}."""
    try:
        parsed = json.loads(config_json)
    except Exception as e:
        return {"success": False, "error": f"Invalid JSON: {e!r}"}

    if not isinstance(parsed, dict) or "users" not in parsed:
        return {"success": False, "error": "Payload must be a dict with a 'users' key"}

    for i, user in enumerate(parsed["users"]):
        if not user.get("name"):
            return {"success": False, "error": f"User #{i+1} is missing a name"}
        if "payday" not in user or "recurrence" not in user.get("payday", {}):
            return {"success": False, "error": f"User '{user.get('name')}' is missing a valid payday config"}

    try:
        write_data(parsed)
    except Exception as e:
        return {"success": False, "error": f"Failed to write {BILLS_FILE}: {e!r}"}

    log.info(f"save_bills_config: wrote {len(parsed['users'])} users to {BILLS_FILE}")

    try:
        update_bills_sensors()
        cal_result = reset_bills_calendar()
        todo_result = sync_bills_todo()
    except Exception as e:
        log.error(f"save_bills_config: saved OK but refresh raised an unexpected error: {e!r}")
        return {"success": True, "warning": f"Saved, but refresh failed unexpectedly: {e!r}"}

    setup_errors = [e for e in [(cal_result or {}).get("error"), (todo_result or {}).get("error")] if e]
    if setup_errors:
        return {"success": True, "warning": "Saved. " + " ".join(setup_errors)}

    cal_skipped = (cal_result or {}).get("skipped", [])
    todo_skipped = (todo_result or {}).get("skipped", [])

    if cal_skipped or todo_skipped:
        missing = sorted({s["user"] for s in cal_skipped} | {s["user"] for s in todo_skipped})
        return {
            "success": True,
            "warning": (
                f"Saved. Everyone else is synced, but these users' calendar/checklist "
                f"entries hit an error and weren't updated: {', '.join(missing)}. "
                f"Check Settings > System > Logs for the specific reason, or share it "
                f"here."
            ),
        }

    return {"success": True}


# ---------------------------------------------------------------------------
# Calendar view (per user, 6-month forecast, full delete-and-rebuild)
# ---------------------------------------------------------------------------

@time_trigger("cron(15 0 * * *)")
@service(supports_response="optional")
def reset_bills_calendar(user_slug=None):
    """Fully clears every event in the 6-month forecast window on the
    single shared calendar.bills entity, then regenerates it fresh from
    bills_data.yaml, for one user (pass user_slug) or every user (omit it -
    the default, and what a full rebuild means).

    Requires: (1) ONE Local Calendar integration, ever, named so its
    entity_id is exactly calendar.bills - shared by every user, tagged per
    event by owner in the title; and (2) the Calendar Utils HACS
    integration (domain calendar_utils) for delete_event_by_uid, since
    core Local Calendar has no delete service.

    When user_slug is omitted (a full rebuild), EVERY event in the window
    is deleted first regardless of owner - this is what correctly removes
    a deleted user's old events too. When user_slug is given, only that
    user's tagged events are touched, leaving everyone else's alone."""
    data = load_data()
    today = date.today()
    window_start = date(today.year, today.month, 1)
    end_month_num = today.month + 6
    end_year = today.year + (end_month_num - 1) // 12
    end_month = ((end_month_num - 1) % 12) + 1
    window_end = date(end_year, end_month, 1)

    users = users_matching(data, user_slug)
    full_rebuild = user_slug is None
    target_slugs = {slugify(u["name"]) for u in users}

    if not entity_exists(CALENDAR_ENTITY):
        msg = f"{CALENDAR_ENTITY} doesn't exist yet - add a Local Calendar integration named 'Bills' (README section 6), then try again."
        log.error(f"reset_bills_calendar: {msg}")
        return {"skipped": [], "error": msg}

    existing = calendar_utils.get_events(
        entity_id=CALENDAR_ENTITY,
        start_date_time=f"{window_start.isoformat()}T00:00:00",
        end_date_time=f"{window_end.isoformat()}T00:00:00",
    )
    log.info(f"reset_bills_calendar: raw get_events response type={type(existing)} value={existing!r}")

    deleted = 0
    if existing:
        for eid, payload in existing.items():
            events = payload if isinstance(payload, list) else payload.get("events", [])
            for ev in events:
                owner, _rest = parse_tagged_title(ev.get("summary"))
                if full_rebuild or (owner in target_slugs):
                    uid = ev.get("uid")
                    if uid:
                        calendar_utils.delete_event_by_uid(entity_id=CALENDAR_ENTITY, uid=uid)
                        deleted += 1

    log.info(f"reset_bills_calendar: deleted {deleted} old events (full_rebuild={full_rebuild})")

    created = 0
    skipped = []
    for user in users:
        slug = slugify(user["name"])
        try:
            items = all_user_bills_next_n_months(user, 6)
            for it in items:
                due = date.fromisoformat(it["due"])
                title = f"{it['name']} - ${it['amount']:.2f}"
                calendar.create_event(
                    entity_id=CALENDAR_ENTITY,
                    summary=tag_title(slug, title),
                    start_date=due.isoformat(),
                    end_date=(due + timedelta(days=1)).isoformat(),
                )
                created += 1
        except Exception as e:
            log.error(f"reset_bills_calendar[{slug}]: failed to create events - {e!r}")
            skipped.append({"user": user["name"], "slug": slug, "error": str(e)})

    log.info(f"reset_bills_calendar: created {created} events across {len(users)} users ({window_start} to {window_end})")
    return {"skipped": skipped}


# ---------------------------------------------------------------------------
# Monthly checklist with tally (single shared entity, tagged per user)
# ---------------------------------------------------------------------------

@time_trigger("cron(20 0 * * *)")
@service(supports_response="optional")
def sync_bills_todo(user_slug=None):
    """Reconciles the shared todo.bills entity against bills_data.yaml for
    the current month: removes items that no longer correspond to any
    current bill (e.g. a bill was deleted, renamed, or had its amount/due
    date changed via the GUI editor - each of those changes the item's
    exact tagged title, so the old one becomes "stale"), and adds any
    missing items. Items that still match a current bill exactly are left
    completely untouched, which preserves their checked/unchecked status.

    For one user (pass user_slug) or every user (omit it). Requires ONE
    Local To-do list integration, ever, named so its entity_id is exactly
    todo.bills."""
    data = load_data()
    users = users_matching(data, user_slug)
    full_scope = user_slug is None
    target_slugs = {slugify(u["name"]) for u in users}

    if not entity_exists(TODO_ENTITY):
        msg = f"{TODO_ENTITY} doesn't exist yet - add a Local To-do list integration named 'Bills' (README section 7), then try again."
        log.error(f"sync_bills_todo: {msg}")
        return {"skipped": [], "error": msg}

    # The CORRECT set of items for this month, per the current bills_data.yaml
    correct = {}  # tagged_title -> due_date
    skipped = []
    for user in users:
        slug = slugify(user["name"])
        try:
            items = all_user_bills_this_month(user)
            for it in items:
                title = f"{it['name']} - ${it['amount']:.2f} (due {it['due']})"
                correct[tag_title(slug, title)] = it["due"]
        except Exception as e:
            log.error(f"sync_bills_todo[{slug}]: failed to compute this month's bills - {e!r}")
            skipped.append({"user": user["name"], "slug": slug, "error": str(e)})

    existing = todo.get_items(entity_id=TODO_ENTITY)
    existing_items = []
    if existing:
        for eid, payload in existing.items():
            events = payload if isinstance(payload, list) else payload.get("items", [])
            existing_items.extend(events)
    existing_titles = {it.get("summary") for it in existing_items}

    # Remove stale items: anything no longer matching a current bill, for
    # users in scope. When doing a global sync (user_slug omitted), this
    # also correctly cleans up items left behind by a DELETED user - since
    # their slug no longer appears in target_slugs, full_scope catches
    # them anyway. When user_slug is given (single-user call), scope stays
    # strictly limited to that one user's own items.
    removed = 0
    for it in existing_items:
        summary = it.get("summary")
        owner, _rest = parse_tagged_title(summary)
        if (full_scope or owner in target_slugs) and summary not in correct:
            identifier = it.get("uid") or summary
            todo.remove_item(entity_id=TODO_ENTITY, item=identifier)
            removed += 1

    # Add anything missing
    added = 0
    for tagged, due_date in correct.items():
        if tagged in existing_titles:
            continue
        todo.add_item(entity_id=TODO_ENTITY, item=tagged, due_date=due_date)
        added += 1

    log.info(f"sync_bills_todo: removed {removed} stale items, added {added} new items across {len(users)} users")
    return {"skipped": skipped}


@time_trigger("cron(10 0 1 * *)")
@service
def reset_bills_todo(user_slug=None):
    """Runs at 00:10 on the 1st of each month: clears every item on the
    shared todo.bills entity (checked or not), then regenerates fresh, for
    one user (pass user_slug) or every user (omit it - the default, and
    what a full monthly reset means). Also callable manually to force an
    early reset/rebuild."""
    data = load_data()
    users = users_matching(data, user_slug)
    full_reset = user_slug is None
    target_slugs = {slugify(u["name"]) for u in users}

    if not entity_exists(TODO_ENTITY):
        log.error(f"reset_bills_todo: {TODO_ENTITY} doesn't exist yet - add a Local To-do list integration named 'Bills' (README section 7), then try again.")
        return

    existing = todo.get_items(entity_id=TODO_ENTITY)
    removed = 0
    if existing:
        for eid, payload in existing.items():
            events = payload if isinstance(payload, list) else payload.get("items", [])
            for it in events:
                owner, _rest = parse_tagged_title(it.get("summary"))
                if full_reset or (owner in target_slugs):
                    identifier = it.get("uid") or it.get("summary")
                    todo.remove_item(entity_id=TODO_ENTITY, item=identifier)
                    removed += 1

    log.info(f"reset_bills_todo: removed {removed} old items, regenerating for new month (full_reset={full_reset})")

    sync_bills_todo(user_slug=user_slug)
    tally_paid_this_month(user_slug=user_slug)


@time_trigger("cron(0 * * * *)")
@service
def tally_paid_this_month(user_slug=None):
    """Sums the dollar amount of checked-off items on the shared
    todo.bills entity, per user, and updates
    sensor.bills_paid_this_month_<slug> for each. Runs hourly, and is also
    triggered immediately whenever a checkbox changes (see
    bills_payday_automations.yaml)."""
    data = load_data()
    users = users_matching(data, user_slug)

    totals = {slugify(u["name"]): {"total": 0.0, "count": 0} for u in users}

    if not entity_exists(TODO_ENTITY):
        log.error(f"tally_paid_this_month: {TODO_ENTITY} doesn't exist yet - add a Local To-do list integration named 'Bills' (README section 7).")
        return

    existing = todo.get_items(entity_id=TODO_ENTITY, status=["completed"])
    if existing:
        for eid, payload in existing.items():
            events = payload if isinstance(payload, list) else payload.get("items", [])
            for it in events:
                owner, rest = parse_tagged_title(it.get("summary"))
                if owner in totals:
                    match = re.search(r"\$([0-9]+(?:\.[0-9]+)?)", rest)
                    if match:
                        totals[owner]["total"] += float(match.group(1))
                        totals[owner]["count"] += 1

    for user in users:
        slug = slugify(user["name"])
        t = totals[slug]
        state.set(
            f"sensor.bills_paid_this_month_{slug}",
            value=round(t["total"], 2),
            new_attributes={"unit_of_measurement": "$", "paid_count": t["count"], "user": user["name"]},
        )
        log.info(f"tally_paid_this_month[{slug}]: ${round(t['total'],2)} across {t['count']} paid bills")

