/*
 * Bills Config Editor Card
 *
 * Place at: <config>/www/bills-config-editor-card.js
 * Register as a Lovelace resource:
 *   Settings > Dashboards > (⋮ menu top right) > Resources > Add Resource
 *   URL: /local/bills-config-editor-card.js
 *   Resource type: JavaScript Module
 *
 * Requires bills_payday.py to include get_bills_config and
 * save_bills_config (@service(supports_response="only")) - see
 * bills_payday.py and the README for setup.
 *
 * Add a card to your dashboard with:
 *   type: custom:bills-config-editor-card
 *
 * For a sidebar menu item (per the original request): create a NEW
 * Home Assistant Dashboard (Settings > Dashboards > Add Dashboard), give
 * it a title like "Bills Config" and an icon, and it'll automatically
 * appear in the sidebar. Add a single Panel view with just this card.
 *
 * IMPORTANT: saving from this card REPLACES bills_data.yaml with a plain
 * auto-generated YAML dump - any comments or custom formatting in the
 * current file will be lost the first time you save. A backup is made
 * automatically as bills_data.yaml.bak before every save.
 *
 * Text-field edits (name, amount, chat ID, etc.) update in place without
 * a full re-render, so typing doesn't lose cursor focus. Structural
 * changes (add/remove user or bill, changing a recurrence type) trigger a
 * re-render since the visible fields change.
 */

const PAYDAY_RECURRENCE_FIELDS = {
  weekly: { weekday: "friday" },
  biweekly: { weekday: "friday", anchor_date: "" },
  monthly: { due_day: 1 },
};

const BILL_RECURRENCE_FIELDS = {
  monthly: { due_day: 1 },
  bimonthly: { due_day: 1, anchor_month: 1 },
  yearly: { due_day: 1, due_month: 1 },
  weekly: { weekday: "friday" },
  biweekly: { weekday: "friday", anchor_date: "" },
};

const ALL_RECURRENCE_FIELD_KEYS = ["due_day", "due_month", "weekday", "anchor_date", "anchor_month"];
const NUMERIC_FIELDS = new Set(["amount", "telegram_chat_id", "due_month", "anchor_month"]);

function esc(s) {
  return (s ?? "").toString().replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function slugify(name) {
  // Must stay in sync with slugify() in bills_payday.py
  let s = (name || "").trim().toLowerCase();
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); // strip accents
  s = s.replace(/[^a-z0-9]+/g, "_");
  return s.replace(/^_+|_+$/g, "");
}

const TEST_ALERT_COOLDOWN_MS = 20000;

class BillsConfigEditorCard extends HTMLElement {
  setConfig(config) {
    this.config = { ...config };
    this._users = null; // null = not loaded yet
    this._statusMsg = "";
    this._statusIsError = false;
    this._confirmingUserIdx = null;
    this._confirmTimeout = null;
    this._testCooldowns = {}; // uidx -> timestamp when cooldown ends
    if (!this._cooldownTicker) {
      this._cooldownTicker = setInterval(() => this._tickCooldowns(), 1000);
    }
    this._render();
  }

  disconnectedCallback() {
    if (this._cooldownTicker) {
      clearInterval(this._cooldownTicker);
      this._cooldownTicker = null;
    }
  }

  _tickCooldowns() {
    if (!this.shadowRoot) return;
    const now = Date.now();
    Object.keys(this._testCooldowns).forEach((key) => {
      const uidx = parseInt(key, 10);
      const deadline = this._testCooldowns[uidx];
      const btn = this.shadowRoot.querySelector(`button[data-action="send-test"][data-uidx="${uidx}"]`);
      if (now >= deadline) {
        delete this._testCooldowns[uidx];
        if (btn) {
          btn.disabled = false;
          btn.textContent = "📨 Send Test Alert";
        }
      } else if (btn) {
        const remaining = Math.ceil((deadline - now) / 1000);
        btn.disabled = true;
        btn.textContent = `📨 Sent (${remaining}s)`;
      }
    });
  }

  _sendTestAlert(uidx) {
    const now = Date.now();
    if (this._testCooldowns[uidx] && this._testCooldowns[uidx] > now) return; // still cooling down, ignore

    const user = this._users[uidx];
    const slug = slugify(user.name);
    if (!slug) {
      this._statusMsg = "Give this user a name before sending a test alert.";
      this._statusIsError = true;
      this._render();
      return;
    }

    this._hass.callService("pyscript", "send_test_alert", { user_slug: slug });
    this._testCooldowns[uidx] = now + TEST_ALERT_COOLDOWN_MS;
    this._tickCooldowns();
  }

  set hass(hass) {
    const firstLoad = !this._hass;
    this._hass = hass;
    if (firstLoad) {
      this._loadConfig();
    }
  }

  getCardSize() {
    return 10;
  }

  async _loadConfig() {
    try {
      const resp = await this._hass.connection.sendMessagePromise({
        type: "call_service",
        domain: "pyscript",
        service: "get_bills_config",
        service_data: {},
        return_response: true,
      });
      console.log("bills-config-editor-card: get_bills_config response", resp);
      this._users = (resp && resp.response && resp.response.users) || [];
    } catch (err) {
      console.error("bills-config-editor-card: failed to load config", err);
      this._users = [];
      this._statusMsg = `Failed to load config: ${err}`;
      this._statusIsError = true;
    }
    this._render();
  }

  async _save() {
    const problems = this._validate();
    if (problems.length) {
      this._statusMsg = "Fix before saving: " + problems.join("; ");
      this._statusIsError = true;
      this._render();
      return;
    }

    this._statusMsg = "Saving...";
    this._statusIsError = false;
    this._render();

    try {
      const payload = { users: this._users };
      const resp = await this._hass.connection.sendMessagePromise({
        type: "call_service",
        domain: "pyscript",
        service: "save_bills_config",
        service_data: { config_json: JSON.stringify(payload) },
        return_response: true,
      });
      const result = resp && resp.response;
      console.log("bills-config-editor-card: save_bills_config response", result);

      if (result && result.success) {
        this._statusMsg = result.warning
          ? `Saved, but: ${result.warning}`
          : "Saved and synced calendar/checklist for everyone ✅";
        this._statusIsError = !!result.warning;
      } else {
        this._statusMsg = `Save failed: ${result ? result.error : "unknown error"}`;
        this._statusIsError = true;
      }
    } catch (err) {
      console.error("bills-config-editor-card: save failed", err);
      this._statusMsg = `Save failed: ${err}`;
      this._statusIsError = true;
    }
    this._render();
  }

  _validate() {
    const problems = [];
    (this._users || []).forEach((u, i) => {
      if (!u.name || !u.name.trim()) problems.push(`User #${i + 1} needs a name`);
      (u.bills || []).forEach((b, j) => {
        if (!b.name || !b.name.trim())
          problems.push(`Bill #${j + 1} for "${u.name}" needs a name`);
        if (b.amount === "" || b.amount === undefined || isNaN(Number(b.amount)))
          problems.push(`"${b.name || "Bill #" + (j + 1)}" needs a valid amount`);
      });
    });
    return problems;
  }

  _addUser() {
    this._users.push({
      name: "",
      telegram_chat_id: "",
      payday: { recurrence: "weekly", weekday: "friday" },
      bills: [],
    });
    this._render();
  }

  _onRemoveUserClick(uidx) {
    if (this._confirmingUserIdx === uidx) {
      // Second click within the window - actually remove.
      if (this._confirmTimeout) clearTimeout(this._confirmTimeout);
      this._confirmingUserIdx = null;
      this._users.splice(uidx, 1);
      this._render();
      return;
    }
    // First click - arm the confirmation, auto-revert after 4 seconds.
    this._confirmingUserIdx = uidx;
    if (this._confirmTimeout) clearTimeout(this._confirmTimeout);
    this._confirmTimeout = setTimeout(() => {
      this._confirmingUserIdx = null;
      this._render();
    }, 4000);
    this._render();
  }

  _addBill(uidx) {
    this._users[uidx].bills.push({ name: "", amount: 0, recurrence: "monthly", due_day: 1 });
    this._render();
  }

  _removeBill(uidx, bidx) {
    this._users[uidx].bills.splice(bidx, 1);
    this._render();
  }

  _target(scope, uidx, bidx) {
    const user = this._users[uidx];
    if (scope === "user") return user;
    if (scope === "payday") return user.payday;
    if (scope === "bill") return user.bills[bidx];
  }

  _onFieldInput(e) {
    const { scope, field } = e.target.dataset;
    const uidx = parseInt(e.target.dataset.uidx, 10);
    const bidx = e.target.dataset.bidx !== undefined ? parseInt(e.target.dataset.bidx, 10) : undefined;
    const obj = this._target(scope, uidx, bidx);
    let val = e.target.value;
    if (NUMERIC_FIELDS.has(field)) {
      val = val === "" ? "" : Number(val);
    } else if (field === "due_day" && val !== "" && val.toLowerCase() !== "eom" && !isNaN(Number(val))) {
      val = Number(val);
    }
    obj[field] = val;
    // Deliberately no re-render here - keeps text input focus while typing.
  }

  _onRecurrenceChange(e) {
    const { scope } = e.target.dataset;
    const uidx = parseInt(e.target.dataset.uidx, 10);
    const bidx = e.target.dataset.bidx !== undefined ? parseInt(e.target.dataset.bidx, 10) : undefined;
    const obj = this._target(scope, uidx, bidx);
    const newRecurrence = e.target.value;

    ALL_RECURRENCE_FIELD_KEYS.forEach((k) => delete obj[k]);
    const table = scope === "payday" ? PAYDAY_RECURRENCE_FIELDS : BILL_RECURRENCE_FIELDS;
    Object.assign(obj, table[newRecurrence] || {});
    obj.recurrence = newRecurrence;

    this._render();
  }

  _renderPaydayFields(payday, uidx) {
    const r = payday.recurrence;
    let fields = "";
    if (r === "monthly") {
      fields = `<input data-scope="payday" data-uidx="${uidx}" data-field="due_day" value="${esc(payday.due_day)}" placeholder="Day of month (1-31 or eom)">`;
    } else if (r === "weekly" || r === "biweekly") {
      fields = `
        <select data-scope="payday" data-uidx="${uidx}" data-field="weekday" class="rc-field">
          ${["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
            .map((d) => `<option value="${d}" ${payday.weekday === d ? "selected" : ""}>${d}</option>`)
            .join("")}
        </select>`;
      if (r === "biweekly") {
        fields += `<input type="date" data-scope="payday" data-uidx="${uidx}" data-field="anchor_date" value="${esc(payday.anchor_date)}" title="Any date you know was/will be an actual payday">`;
      }
    }
    return fields;
  }

  _renderBillFields(bill, uidx, bidx) {
    const r = bill.recurrence;
    let fields = "";
    if (r === "monthly") {
      fields = `<input data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="due_day" value="${esc(bill.due_day)}" placeholder="Day (1-31 or eom)">`;
    } else if (r === "bimonthly") {
      fields = `
        <input data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="due_day" value="${esc(bill.due_day)}" placeholder="Day (1-31 or eom)">
        <input type="number" min="1" max="12" data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="anchor_month" value="${esc(bill.anchor_month)}" title="Any one month it's known to charge (1-12)">`;
    } else if (r === "yearly") {
      fields = `
        <input data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="due_day" value="${esc(bill.due_day)}" placeholder="Day (1-31 or eom)">
        <input type="number" min="1" max="12" data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="due_month" value="${esc(bill.due_month)}" placeholder="Month (1-12)">`;
    } else if (r === "weekly" || r === "biweekly") {
      fields = `
        <select data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="weekday" class="rc-field">
          ${["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
            .map((d) => `<option value="${d}" ${bill.weekday === d ? "selected" : ""}>${d}</option>`)
            .join("")}
        </select>`;
      if (r === "biweekly") {
        fields += `<input type="date" data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="anchor_date" value="${esc(bill.anchor_date)}" title="Any date it's known to have charged on this weekday">`;
      }
    }
    return fields;
  }

  _renderUserBlock(user, uidx) {
    const cooldownDeadline = this._testCooldowns[uidx];
    const now = Date.now();
    const onCooldown = cooldownDeadline && cooldownDeadline > now;
    const remaining = onCooldown ? Math.ceil((cooldownDeadline - now) / 1000) : 0;

    return `
      <div class="user-block">
        <div class="user-header">
          <input class="user-name" data-scope="user" data-uidx="${uidx}" data-field="name" value="${esc(user.name)}" placeholder="User name">
          <input data-scope="user" data-uidx="${uidx}" data-field="telegram_chat_id" value="${esc(user.telegram_chat_id)}" placeholder="Telegram chat ID (optional)">
          <button data-action="send-test" data-uidx="${uidx}" ${onCooldown ? "disabled" : ""}>${onCooldown ? `📨 Sent (${remaining}s)` : "📨 Send Test Alert"}</button>
          <button class="danger ${this._confirmingUserIdx === uidx ? "armed" : ""}" data-action="remove-user" data-uidx="${uidx}">${this._confirmingUserIdx === uidx ? "⚠️ Click again to confirm" : "🗑 Remove User"}</button>
        </div>
        <div class="payday-row">
          <span class="field-label">Payday:</span>
          <select data-scope="payday" data-uidx="${uidx}" class="rc-field">
            ${["weekly", "biweekly", "monthly"]
              .map((r) => `<option value="${r}" ${user.payday.recurrence === r ? "selected" : ""}>${r}</option>`)
              .join("")}
          </select>
          ${this._renderPaydayFields(user.payday, uidx)}
        </div>
        <div class="bills-list">
          <div class="bill-legend">Name — Amount ($) — Recurrence — Schedule details (day of month / month / weekday / anchor, depending on recurrence)</div>
          ${(user.bills || [])
            .map(
              (bill, bidx) => `
            <div class="bill-row">
              <input data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="name" value="${esc(bill.name)}" placeholder="Bill name">
              <input type="number" step="0.01" data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" data-field="amount" value="${esc(bill.amount)}" placeholder="Amount">
              <select data-scope="bill" data-uidx="${uidx}" data-bidx="${bidx}" class="rc-field">
                ${["monthly", "bimonthly", "yearly", "weekly", "biweekly"]
                  .map((r) => `<option value="${r}" ${bill.recurrence === r ? "selected" : ""}>${r}</option>`)
                  .join("")}
              </select>
              ${this._renderBillFields(bill, uidx, bidx)}
              <button class="danger small" data-action="remove-bill" data-uidx="${uidx}" data-bidx="${bidx}">🗑</button>
            </div>`
            )
            .join("")}
        </div>
        <button data-action="add-bill" data-uidx="${uidx}">+ Add Bill</button>
      </div>`;
  }

  _render() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }

    if (this._users === null) {
      this.shadowRoot.innerHTML = `<ha-card><div style="padding:16px;">Loading bills config...</div></ha-card>`;
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 16px; }
        .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
        .toolbar h2 { margin: 0; font-size: 1.3em; color: var(--primary-text-color); }
        .status { font-size: 0.85em; margin-top: 6px; }
        .status.error { color: var(--error-color, #db4437); }
        .status.ok { color: var(--success-color, #4caf50); }
        button {
          background: var(--primary-color); color: var(--text-primary-color, white);
          border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 0.9em;
        }
        button.danger { background: var(--error-color, #db4437); }
        button.danger.armed { background: #a02c22; animation: pulse 0.8s ease-in-out infinite alternate; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        @keyframes pulse { from { opacity: 1; } to { opacity: 0.6; } }
        button.small { padding: 6px 10px; }
        input, select {
          background: var(--card-background-color, #1c1c1c); color: var(--primary-text-color);
          border: 1px solid var(--divider-color); border-radius: 6px; padding: 6px 8px;
          font-size: 0.9em; margin: 2px;
        }
        .user-block {
          border: 1px solid var(--divider-color); border-radius: 8px;
          padding: 12px; margin-bottom: 16px;
        }
        .user-header { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }
        .user-name { font-weight: bold; flex: 1; min-width: 120px; }
        .payday-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--divider-color); }
        .field-label { font-size: 0.85em; color: var(--secondary-text-color); margin-right: 4px; }
        .bill-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
        .bill-legend { font-size: 0.75em; color: var(--secondary-text-color); margin-bottom: 6px; }
        .bills-list { margin-bottom: 8px; }
      </style>
      <ha-card>
        <div class="toolbar">
          <h2>Bills Config Editor</h2>
          <button id="save-btn">💾 Save &amp; Sync Everyone</button>
        </div>
        ${this._statusMsg ? `<div class="status ${this._statusIsError ? "error" : "ok"}">${esc(this._statusMsg)}</div>` : ""}

        ${this._users.map((u, i) => this._renderUserBlock(u, i)).join("")}

        <button id="add-user-btn">+ Add User</button>
      </ha-card>
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const root = this.shadowRoot;
    const saveBtn = root.getElementById("save-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => this._save());

    const addUserBtn = root.getElementById("add-user-btn");
    if (addUserBtn) addUserBtn.addEventListener("click", () => this._addUser());

    root.querySelectorAll("input[data-scope]").forEach((el) => {
      el.addEventListener("input", (e) => this._onFieldInput(e));
    });
    root.querySelectorAll("select.rc-field").forEach((el) => {
      // The payday recurrence <select> has no data-field (it always sets
      // "recurrence"); bill/payday sub-fields like weekday DO have a
      // data-field and should behave like a plain field, not trigger a
      // full recurrence-type re-render.
      if (el.dataset.field) {
        el.addEventListener("input", (e) => this._onFieldInput(e));
      } else {
        el.addEventListener("change", (e) => this._onRecurrenceChange(e));
      }
    });
    root.querySelectorAll('button[data-action="send-test"]').forEach((el) => {
      el.addEventListener("click", (e) => this._sendTestAlert(parseInt(e.currentTarget.dataset.uidx, 10)));
    });
    root.querySelectorAll('button[data-action="remove-user"]').forEach((el) => {
      el.addEventListener("click", (e) => this._onRemoveUserClick(parseInt(e.currentTarget.dataset.uidx, 10)));
    });
    root.querySelectorAll('button[data-action="add-bill"]').forEach((el) => {
      el.addEventListener("click", (e) => this._addBill(parseInt(e.currentTarget.dataset.uidx, 10)));
    });
    root.querySelectorAll('button[data-action="remove-bill"]').forEach((el) => {
      el.addEventListener("click", (e) =>
        this._removeBill(parseInt(e.currentTarget.dataset.uidx, 10), parseInt(e.currentTarget.dataset.bidx, 10))
      );
    });
  }
}

customElements.define("bills-config-editor-card", BillsConfigEditorCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "bills-config-editor-card",
  name: "Bills Config Editor",
  description: "Add/remove users and bills, edit schedules, and save + sync everything from one GUI",
});
