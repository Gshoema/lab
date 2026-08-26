/*
 * Bills Calendar Card (calendar + checklist, merged into one file)
 *
 * Place at: <config>/www/bills-calendar-card.js
 * Register as a Lovelace resource:
 *   Settings > Dashboards > (⋮ menu top right) > Resources > Add Resource
 *   URL: /local/bills-calendar-card.js?v=3   (bump ?v= if updating an
 *   existing resource - browsers cache these files aggressively)
 *   Resource type: JavaScript Module
 *
 * Then add a card to your dashboard with just:
 *   type: custom:bills-calendar-card
 *   title: Bills                    # optional
 *
 * NOTE: this file used to be split into two separate cards
 * (bills-calendar-card.js for read-only browsing, and
 * bills-calendar-todo-card.js for calendar+checklist combined). They've
 * been merged back into this one file - bills-calendar-todo-card.js is
 * now fully redundant and safe to delete. The custom element tag stayed
 * "bills-calendar-card" specifically so any dashboard already using
 * `type: custom:bills-calendar-card` keeps working with zero YAML changes.
 *
 * NO "users" list needed in config - the card fetches the current user
 * list from bills_data.yaml itself (via pyscript.get_bills_config) on
 * every load, so adding/removing a user via the GUI config editor never
 * requires touching this card's YAML.
 *
 * Reads from a SINGLE shared calendar.bills and todo.bills entity (not a
 * separate one per user) - each event/item's title is tagged with its
 * owner (e.g. "[alice] Rent - $450.00"), and this card filters + strips
 * that tag client-side for display. Set up once, ever, regardless of how
 * many users come and go.
 *
 * A dropdown in the header switches between users - just changes which
 * tagged events/items this card displays, no rebuild needed.
 *
 * Draws its own month grid (not the stock Calendar card) so each bill shows
 * as a clickable chip. Clicking a chip toggles it paid/unpaid by calling
 * todo.update_item on the matching to-do item, and updates the paid-total
 * progress bar at the top - keeping the calendar view and the checklist in
 * sync from one place.
 *
 * If bills don't show as paid/unpaid correctly, open the browser console
 * (F12) - this logs the raw calendar/todo API responses on every load,
 * which makes it easy to spot if a field name differs from what's expected
 * (this was built against documented HA APIs but not tested live).
 */

const CALENDAR_ENTITY = "calendar.bills";
const TODO_ENTITY = "todo.bills";

function slugify(name) {
  // Must stay in sync with slugify() in bills_payday.py
  let s = name.trim().toLowerCase();
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); // strip accents
  s = s.replace(/[^a-z0-9]+/g, "_");
  return s.replace(/^_+|_+$/g, "");
}

function parseTag(title) {
  // "[alice] Rent - $450.00" -> { owner: "alice", rest: "Rent - $450.00" }
  const m = (title || "").match(/^\[([a-z0-9_]+)\]\s*(.*)$/);
  if (m) return { owner: m[1], rest: m[2] };
  return { owner: null, rest: title || "" };
}

class BillsCalendarCard extends HTMLElement {
  setConfig(config) {
    this.config = {
      title: "Bills",
      ...config,
    };
    this._userNames = null; // null = not loaded yet
    this._selectedUser = null;
    this._viewDate = new Date();
    this._events = [];
    this._todoItems = [];
    this._render();
  }

  set hass(hass) {
    const firstLoad = !this._hass;
    this._hass = hass;
    if (firstLoad) {
      this._init();
    }
  }

  getCardSize() {
    return 8;
  }

  async _init() {
    await this._loadUsers();
    await this._loadData();
  }

  async _loadUsers() {
    try {
      const resp = await this._hass.connection.sendMessagePromise({
        type: "call_service",
        domain: "pyscript",
        service: "get_bills_config",
        service_data: {},
        return_response: true,
      });
      const users = (resp && resp.response && resp.response.users) || [];
      this._userNames = users.map((u) => u.name);
    } catch (err) {
      console.error("bills-calendar-card: failed to load user list", err);
      this._userNames = [];
    }
    if (!this._selectedUser && this._userNames.length) {
      this._selectedUser = this._userNames[0];
    }
  }

  _onUserChange(newUser) {
    this._selectedUser = newUser;
    this._loadData();
  }

  async _loadData() {
    if (!this._hass) return;

    const year = this._viewDate.getFullYear();
    const month = this._viewDate.getMonth();
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 1);
    const mySlug = this._selectedUser ? slugify(this._selectedUser) : null;

    try {
      const events = await this._hass.callApi(
        "GET",
        `calendars/${CALENDAR_ENTITY}?start=${encodeURIComponent(
          start.toISOString()
        )}&end=${encodeURIComponent(end.toISOString())}`
      );
      this._events = (events || []).filter((ev) => parseTag(ev.summary).owner === mySlug);
    } catch (err) {
      console.error("bills-calendar-card: failed to fetch calendar events", err);
      this._events = [];
    }

    try {
      const todoResp = await this._hass.connection.sendMessagePromise({
        type: "call_service",
        domain: "todo",
        service: "get_items",
        service_data: {},
        target: { entity_id: TODO_ENTITY },
        return_response: true,
      });
      const allItems =
        (todoResp &&
          todoResp.response &&
          todoResp.response[TODO_ENTITY] &&
          todoResp.response[TODO_ENTITY].items) ||
        [];
      this._todoItems = allItems.filter((it) => parseTag(it.summary).owner === mySlug);
    } catch (err) {
      console.error("bills-calendar-card: failed to fetch todo items", err);
      this._todoItems = [];
    }

    console.log(`bills-calendar-card: raw calendar events (${this._selectedUser})`, this._events);
    console.log(`bills-calendar-card: raw todo items (${this._selectedUser})`, this._todoItems);

    this._render();
  }

  _parseNameAmount(untaggedTitle) {
    // Matches "Name - $12.34" and "Name - $12.34 (due 2026-07-12)"
    const m = (untaggedTitle || "").match(/^(.*) - \$([0-9]+(?:\.[0-9]+)?)/);
    if (!m) return { name: (untaggedTitle || "").trim(), amount: null };
    return { name: m[1].trim(), amount: parseFloat(m[2]) };
  }

  _findTodoItem(name, dateStr) {
    return this._todoItems.find((it) => {
      const { rest } = parseTag(it.summary || "");
      const parsed = this._parseNameAmount(rest);
      const itemDue = it.due || it.due_date || "";
      return parsed.name === name && itemDue === dateStr;
    });
  }

  _toggleItem(todoItem) {
    if (!todoItem || !this._hass) return;
    const newStatus = todoItem.status === "completed" ? "needs_action" : "completed";
    this._hass.callService("todo", "update_item", {
      entity_id: TODO_ENTITY,
      // Use the item's full original (tagged) summary if no uid - matching
      // must use the exact title as stored, tag included.
      item: todoItem.uid || todoItem.summary,
      status: newStatus,
    });
    // Optimistic local update so the click feels instant; the next
    // _loadData() (on hass update) will reconcile with the real state.
    todoItem.status = newStatus;
    this._render();
  }

  _prevMonth() {
    this._viewDate = new Date(this._viewDate.getFullYear(), this._viewDate.getMonth() - 1, 1);
    this._loadData();
  }

  _nextMonth() {
    this._viewDate = new Date(this._viewDate.getFullYear(), this._viewDate.getMonth() + 1, 1);
    this._loadData();
  }

  _render() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }

    if (this._userNames === null) {
      this.shadowRoot.innerHTML = `<ha-card><div style="padding:16px;">Loading users...</div></ha-card>`;
      return;
    }
    if (!this._userNames.length) {
      this.shadowRoot.innerHTML = `<ha-card><div style="padding:16px;">No users found in bills_data.yaml yet - add one via the config editor.</div></ha-card>`;
      return;
    }

    const viewDate = this._viewDate;
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const monthName = viewDate.toLocaleString("default", { month: "long" });

    const today = new Date();
    const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();

    const firstOfMonth = new Date(year, month, 1);
    const startWeekday = firstOfMonth.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const dayMap = {};
    let monthTotal = 0;
    let paidTotal = 0;

    (this._events || []).forEach((ev) => {
      const dateStr =
        (ev.start && (ev.start.date || (ev.start.dateTime || "").slice(0, 10))) || "";
      if (!dateStr) return;
      const day = parseInt(dateStr.slice(8, 10), 10);
      const { rest } = parseTag(ev.summary || "");
      const parsed = this._parseNameAmount(rest);
      const todoItem = isCurrentMonth ? this._findTodoItem(parsed.name, dateStr) : null;
      const paid = todoItem ? todoItem.status === "completed" : false;

      if (!dayMap[day]) dayMap[day] = [];
      dayMap[day].push({ name: parsed.name, amount: parsed.amount, dateStr, paid });

      if (parsed.amount != null) {
        monthTotal += parsed.amount;
        if (paid) paidTotal += parsed.amount;
      }
    });

    const cells = [];
    for (let i = 0; i < startWeekday; i++) {
      cells.push(`<div class="day empty"></div>`);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const bills = dayMap[d] || [];
      const chips = bills
        .map((b) => {
          const amountStr = b.amount != null ? `$${b.amount.toFixed(2)}` : "";
          const safeName = b.name.replace(/"/g, "&quot;");
          const readonlyClass = isCurrentMonth ? "" : "readonly";
          const titleSuffix = isCurrentMonth ? "" : " (checklist not available yet for future months)";
          return `<div class="chip ${b.paid ? "paid" : ""} ${readonlyClass}" data-name="${safeName}" data-date="${b.dateStr}" data-readonly="${isCurrentMonth ? "0" : "1"}" title="${safeName} - ${amountStr}${titleSuffix}">${b.name} - ${amountStr}</div>`;
        })
        .join("");
      cells.push(`<div class="day"><div class="day-num">${d}</div>${chips}</div>`);
    }
    const totalCells = startWeekday + daysInMonth;
    const numWeeks = Math.ceil(totalCells / 7);
    while (cells.length < numWeeks * 7) {
      cells.push(`<div class="day empty"></div>`);
    }

    const pct = monthTotal > 0 ? Math.round((paidTotal / monthTotal) * 100) : 0;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        ha-card {
          display: flex; flex-direction: column; height: 100%;
          padding: 16px; box-sizing: border-box;
        }
        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex: none; }
        .header h2 { margin: 0; font-size: 1.4em; color: var(--primary-text-color); }
        .nav button {
          background: none; border: none; color: var(--primary-text-color);
          font-size: 1.3em; cursor: pointer; padding: 4px 12px; line-height: 1;
        }
        .nav button:hover { color: var(--primary-color); }
        .user-row { flex: none; margin-bottom: 10px; }
        .user-row select {
          background: var(--card-background-color, #1c1c1c);
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px; padding: 6px 10px; font-size: 0.9em;
          width: 100%; cursor: pointer;
        }
        .summary { margin-bottom: 14px; font-size: 0.95em; color: var(--secondary-text-color); flex: none; }
        .progress-bar {
          height: 6px; border-radius: 3px; background: var(--divider-color);
          overflow: hidden; margin-top: 6px;
        }
        .progress-fill { height: 100%; background: var(--success-color, #4caf50); }
        .weekday-row {
          display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px;
          flex: none; margin-bottom: 4px;
        }
        .weekday {
          text-align: center; font-size: 0.75em; font-weight: 600;
          color: var(--secondary-text-color); padding-bottom: 4px;
        }
        .day-grid {
          display: grid; grid-template-columns: repeat(7, 1fr);
          grid-template-rows: repeat(${numWeeks}, 1fr);
          gap: 4px; flex: 1; min-height: 0;
        }
        .day {
          border: 1px solid var(--divider-color); border-radius: 6px;
          padding: 4px; font-size: 0.72em; overflow-y: auto; min-height: 0;
        }
        .day.empty { border: none; }
        .day-num { font-weight: bold; margin-bottom: 4px; color: var(--primary-text-color); }
        .chip {
          background: var(--primary-color); color: var(--text-primary-color, white);
          border-radius: 4px; padding: 2px 4px; margin-bottom: 3px; cursor: pointer;
          overflow-wrap: break-word; transition: opacity 0.15s ease;
        }
        .chip:hover { opacity: 0.85; }
        .chip.paid {
          background: var(--disabled-text-color, #757575);
          text-decoration: line-through; opacity: 0.65;
        }
        .chip.readonly {
          cursor: default; opacity: 0.7;
          background: var(--secondary-background-color, #2c2c2c);
          border: 1px dashed var(--divider-color);
        }
        .chip.readonly:hover { opacity: 0.7; }
      </style>
      <ha-card>
        <div class="header">
          <div class="nav"><button id="prev">&lt;</button></div>
          <h2>${this.config.title} — ${monthName} ${year}</h2>
          <div class="nav"><button id="next">&gt;</button></div>
        </div>
        <div class="user-row">
          <select id="user-select">
            ${this._userNames
              .map(
                (u) =>
                  `<option value="${u}" ${u === this._selectedUser ? "selected" : ""}>${u}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="summary">
          ${
            isCurrentMonth
              ? `Paid $${paidTotal.toFixed(2)} of $${monthTotal.toFixed(2)} this month (${pct}%)
                 <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`
              : `$${monthTotal.toFixed(2)} in bills forecast for ${monthName} - checklist opens up once this becomes the current month`
          }
        </div>
        <div class="weekday-row">
          ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            .map((d) => `<div class="weekday">${d}</div>`)
            .join("")}
        </div>
        <div class="day-grid">
          ${cells.join("")}
        </div>
      </ha-card>
    `;

    this.shadowRoot.getElementById("prev").addEventListener("click", () => this._prevMonth());
    this.shadowRoot.getElementById("next").addEventListener("click", () => this._nextMonth());
    this.shadowRoot.getElementById("user-select").addEventListener("change", (e) => {
      this._onUserChange(e.target.value);
    });
    this.shadowRoot.querySelectorAll(".chip").forEach((el) => {
      el.addEventListener("click", () => {
        if (el.dataset.readonly === "1") return; // future month - no checklist item exists yet
        const name = el.dataset.name;
        const dateStr = el.dataset.date;
        const todoItem = this._findTodoItem(name, dateStr);
        if (!todoItem) {
          console.warn(
            `bills-calendar-card: no matching to-do item found for "${name}" on ${dateStr} - check console logs above for raw data`
          );
          return;
        }
        this._toggleItem(todoItem);
      });
    });
  }
}

customElements.define("bills-calendar-card", BillsCalendarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "bills-calendar-card",
  name: "Bills Calendar + Checklist",
  description: "Combined calendar and paid-checklist view for the Bills & Payday tracker (single shared entity, auto-discovers users)",
});
