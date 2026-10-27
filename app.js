(() => {
  "use strict";

  const STORAGE_KEY = "vajra.automation.webState";
  const PASSWORD_KEY = "vajra.web.mqttPassword";
  const OLD_KEYS = {
    url: "vajra.web.mqttUrl",
    prefix: "vajra.web.mqttPrefix",
    username: "vajra.web.mqttUsername"
  };
  const BOARDS = ["ESP32", "0X20", "0X21", "0X22", "0X23", "0X24", "0X25", "0X26", "0X27"];
  const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
  const ICONS = {
    LIGHT: "☼", FAN: "✿", AC: "❄", PLUG: "⏻", TV: "▣",
    LAMP: "◉", ROUTER: "⌁", WALL_LIGHT: "◈", CHANDELIER: "✧",
    SWITCH: "◉", ROOM: "⌂", GROUP: "▦", MOON: "☾", SUN: "☀",
    ALL_OFF: "◯", ALL_ON: "✦"
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const dialog = $("#app-dialog");
  const dialogContent = $("#dialog-content");
  const dialogTitle = $("#dialog-title");
  const dialogActions = $("#dialog-actions");
  const toast = $("#toast");
  let socket = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let toastTimer = null;
  let packetId = 1;
  let receiveBuffer = new Uint8Array(0);
  let manualClose = false;
  let lastScheduleMinute = "";
  let dialogState = null;

  function makeId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${id.replaceAll("-", "").slice(0, 12)}`;
  }

  function createSwitches() {
    return Array.from({ length: 136 }, (_, offset) => {
      const number = offset + 1;
      const boardIndex = number <= 8 ? 0 : Math.floor((number - 9) / 16) + 1;
      const pinIndex = number <= 8 ? offset : (number - 9) % 16;
      const pinLabel = boardIndex === 0
        ? ["GPIO 4", "GPIO 13", "GPIO 14", "GPIO 32", "GPIO 33", "GPIO 34", "GPIO 35", "GPIO 36"][pinIndex]
        : `P${pinIndex < 8 ? `0${pinIndex}` : pinIndex + 2}`;
      const channel = offset % 8;
      return {
        id: `S${number}`,
        boardKey: BOARDS[boardIndex],
        pinLabel,
        relayChannel: channel,
        index: offset,
        customName: `Relay ${channel + 1} (S${number})`,
        iconName: "LIGHT",
        isOn: false
      };
    });
  }

  function initialState() {
    const url = localStorage.getItem(OLD_KEYS.url) || "wss://broker.emqx.io:8084/mqtt";
    const host = (() => {
      try { return new URL(url).hostname; } catch { return "broker.emqx.io"; }
    })();
    return {
      version: 2,
      settings: {
        deviceIp: "192.168.1.100",
        deviceName: "Vajra-Smart-Hub",
        mqttPrefix: localStorage.getItem(OLD_KEYS.prefix) || "",
        mqttHost: host,
        mqttUrl: url,
        mqttUser: localStorage.getItem(OLD_KEYS.username) || "",
        mode: "AUTO"
      },
      connectedBoards: ["ESP32"],
      enabledSwitches: Array.from({ length: 8 }, (_, i) => `S${i + 1}`),
      switches: createSwitches(),
      rooms: [{ id: "room_main", name: "Main Room", iconName: "ROOM", switchIds: Array.from({ length: 8 }, (_, i) => `S${i + 1}`) }],
      groups: [],
      schedules: [],
      dailySchedules: {},
      countdowns: {},
      hubs: [{
        id: "hub_primary",
        name: "Main Hub (192.168.1.100)",
        ip: "192.168.1.100",
        mqttPrefix: localStorage.getItem(OLD_KEYS.prefix) || "",
        isPrimary: true
      }]
    };
  }

  function loadState() {
    const defaults = initialState();
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaults;
    try {
      const parsed = JSON.parse(stored);
      return {
        ...defaults,
        ...parsed,
        settings: { ...defaults.settings, ...parsed.settings },
        switches: defaults.switches.map((sw) => ({
          ...sw,
          ...(Array.isArray(parsed.switches) ? parsed.switches.find((saved) => saved.id === sw.id) : {})
        })),
        rooms: Array.isArray(parsed.rooms) && parsed.rooms.length ? parsed.rooms : defaults.rooms,
        groups: Array.isArray(parsed.groups) ? parsed.groups : defaults.groups,
        schedules: Array.isArray(parsed.schedules) ? parsed.schedules : defaults.schedules,
        dailySchedules: parsed.dailySchedules && typeof parsed.dailySchedules === "object" ? parsed.dailySchedules : {},
        countdowns: parsed.countdowns && typeof parsed.countdowns === "object" ? parsed.countdowns : {},
        connectedBoards: Array.isArray(parsed.connectedBoards) ? [...new Set(["ESP32", ...parsed.connectedBoards])] : defaults.connectedBoards,
        enabledSwitches: Array.isArray(parsed.enabledSwitches) ? parsed.enabledSwitches : defaults.enabledSwitches,
        hubs: Array.isArray(parsed.hubs) ? parsed.hubs : defaults.hubs
      };
    } catch (error) {
      console.error("Saved browser app settings could not be read:", error);
      window.setTimeout(() => showToast("Saved settings could not be read. Default app settings were loaded."), 0);
      return defaults;
    }
  }

  const state = loadState();
  let activePageId = state.activePageId === "__groups__" || state.rooms.some((room) => room.id === state.activePageId)
    ? state.activePageId
    : state.rooms[0]?.id || "__groups__";
  let connectionState = "disconnected";
  let activeRoute = "AUTO";

  function persist() {
    state.activePageId = activePageId;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error("Could not save browser app settings:", error);
      showToast("Could not save changes in this browser. Check device storage.");
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3600);
  }

  function getActiveSwitches() {
    const boardSet = new Set(state.connectedBoards);
    const enabledSet = new Set(state.enabledSwitches);
    return state.switches.filter((sw) => boardSet.has(sw.boardKey) && enabledSet.has(sw.id));
  }

  function getSwitch(switchId) {
    return state.switches.find((sw) => sw.id === switchId);
  }

  function renderTabs() {
    const tabs = $("#room-tabs");
    tabs.replaceChildren();
    state.rooms.forEach((room) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "room-tab";
      button.setAttribute("aria-selected", String(activePageId === room.id));
      button.dataset.action = "page";
      button.dataset.pageId = room.id;
      button.innerHTML = `<span aria-hidden="true">${escapeHtml(ICONS[room.iconName] || ICONS.ROOM)}</span>${escapeHtml(room.name)}`;
      tabs.append(button);
    });
    const groupsTab = document.createElement("button");
    groupsTab.type = "button";
    groupsTab.className = "room-tab groups-tab";
    groupsTab.setAttribute("aria-selected", String(activePageId === "__groups__"));
    groupsTab.dataset.action = "page";
    groupsTab.dataset.pageId = "__groups__";
    groupsTab.innerHTML = `<span aria-hidden="true">${ICONS.GROUP}</span>GROUPS`;
    tabs.append(groupsTab);
  }

  function renderPage() {
    const content = $("#page-content");
    const isGroups = activePageId === "__groups__";
    const room = state.rooms.find((item) => item.id === activePageId);
    const addButton = $("#page-add");
    const hint = $("#page-hint");
    addButton.classList.toggle("purple", isGroups);
    addButton.textContent = isGroups ? "＋ Group" : "＋ Room";
    hint.textContent = isGroups ? "ALL MASTER GROUP SWITCHES" : "SWIPE LEFT / RIGHT FOR ROOMS";

    if (isGroups) {
      content.innerHTML = `
        <div class="section-title">
          <h2 style="color:#a78bfa">MASTER SWITCH GROUPS <span class="count">(${state.groups.length} Groups)</span></h2>
          <button class="icon-button purple" type="button" data-action="add-group" aria-label="Add group">＋</button>
        </div>
        ${state.groups.length ? `<div class="group-grid" style="--columns:${gridColumns(state.groups.length)}">${state.groups.map(renderGroupCard).join("")}</div>` : `
          <div class="empty-state"><div><strong>No Switch Groups Created</strong><span>Tap “＋ Group” to create a master group switch.</span></div></div>`}`;
      return;
    }

    if (!room) {
      activePageId = state.rooms[0]?.id || "__groups__";
      render();
      return;
    }
    const active = getActiveSwitches();
    const assigned = new Set(room.switchIds);
    const roomSwitches = active.filter((sw) => assigned.has(sw.id));
    content.innerHTML = `
      <div class="section-title">
        <h2>${escapeHtml(room.name.toUpperCase())}<span class="count">(${roomSwitches.length} Switches)</span></h2>
        <button class="icon-button cyan" type="button" data-action="edit-room" data-room-id="${escapeHtml(room.id)}" aria-label="Edit room">✎</button>
      </div>
      ${roomSwitches.length ? `<div class="switch-grid" style="--columns:${gridColumns(roomSwitches.length)}">${roomSwitches.map(renderSwitchCard).join("")}</div>` : `
        <div class="empty-state"><div><strong>No switches assigned to ${escapeHtml(room.name)}</strong><span>Tap “Edit Room” to add switches here.</span></div></div>`}`;
  }

  function gridColumns(count) {
    if (count <= 4) return 2;
    if (count <= 9) return 3;
    return 4;
  }

  function renderSwitchCard(sw) {
    const on = connectionState === "connected" && sw.isOn;
    const timer = state.dailySchedules[sw.id]?.enabled ? "Daily" : state.countdowns[sw.id] ? `${Math.ceil((state.countdowns[sw.id].at - Date.now()) / 60000)}m` : "";
    return `    <article class="switch-card${on ? " is-on" : ""}${connectionState !== "connected" ? " is-offline" : ""}" data-action="toggle-switch" data-switch-id="${escapeHtml(sw.id)}" tabindex="0" role="group" aria-label="${escapeHtml(sw.customName)}, ${connectionState !== "connected" ? "offline" : on ? "on" : "off"}. Tap to toggle.">
      <div class="switch-top">
        <span class="switch-state"><span class="switch-led" aria-hidden="true"></span>${connectionState !== "connected" ? "OFFLINE" : on ? "ON" : "OFF"} <span class="switch-icon" aria-hidden="true">${escapeHtml(ICONS[sw.iconName] || "⏻")}</span></span>
        ${timer ? `<span class="timer-pill" title="Automation active">◷ ${escapeHtml(timer)}</span>` : ""}
        <span class="switch-id">${escapeHtml(sw.id)}</span>
        <button class="card-edit" type="button" data-action="edit-switch" data-switch-id="${escapeHtml(sw.id)}" aria-label="Customize ${escapeHtml(sw.customName)}">⋮</button>
      </div>
      <div class="switch-plate"><span class="switch-name">${escapeHtml(sw.customName)}</span></div>
      <div class="switch-glow" aria-hidden="true"></div>
    </article>`;
  }

  function renderGroupCard(group) {
    const members = group.switchIds.map(getSwitch).filter(Boolean);
    const activeIds = new Set(getActiveSwitches().map((sw) => sw.id));
    const on = connectionState === "connected" && group.switchIds.length > 0
      && group.switchIds.every((id) => activeIds.has(id) && getSwitch(id)?.isOn === true);
    return `<article class="group-card${on ? " is-on" : ""}${connectionState !== "connected" ? " is-offline" : ""}" data-action="toggle-group" data-group-id="${escapeHtml(group.id)}" tabindex="0" role="group" aria-label="${escapeHtml(group.name)}, ${connectionState !== "connected" ? "offline" : on ? "on" : "off"}. Tap to toggle.">
      <div class="group-top">
        <span class="switch-state"><span class="switch-led" aria-hidden="true"></span>${connectionState !== "connected" ? "OFFLINE" : on ? "ON" : "OFF"} <span class="switch-icon" aria-hidden="true">${escapeHtml(ICONS[group.iconName] || ICONS.GROUP)}</span></span>
        <span class="group-member-count">${members.length} SWITCHES</span>
        <button class="card-edit" type="button" data-action="edit-group" data-group-id="${escapeHtml(group.id)}" aria-label="Edit ${escapeHtml(group.name)}">⋮</button>
      </div>
      <div class="group-plate"><span class="group-name">${escapeHtml(group.name)}</span></div>
      <div class="switch-glow" aria-hidden="true"></div>
    </article>`;
  }

  function render() {
    renderTabs();
    renderPage();
    const label = connectionState === "connected" ? `ONLINE (${activeRoute})` : connectionState === "connecting" ? "CONNECTING" : "OFFLINE";
    const badge = $("#connection-badge");
    badge.dataset.state = connectionState;
    $("#connection-label").textContent = label;
    $("#footer-connection").textContent = `${label} · Browser edition`;
  }

  function openDialog(kind, title, description, body, actions, meta = {}) {
    dialogState = { kind, ...meta };
    dialogTitle.innerHTML = `<h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}`;
    dialogContent.innerHTML = body;
    dialogActions.innerHTML = actions;
    dialog.showModal();
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
    dialogState = null;
  }

  function actionButton(label, action, className = "primary-button") {
    return `<button class="${className}" type="button" data-action="${action}">${label}</button>`;
  }

  function renderSwitchChoices(selected = [], name = "switchIds") {
    const selectedSet = new Set(selected);
    return `<div class="check-list">${getActiveSwitches().map((sw) => `
      <label class="check-row${selectedSet.has(sw.id) ? " selected" : ""}">
        <span class="check-detail"><strong>${escapeHtml(sw.customName)} (${escapeHtml(sw.id)})</strong><small>Board ${escapeHtml(sw.boardKey)} · ${escapeHtml(sw.pinLabel)}</small></span>
        <input type="checkbox" name="${name}" value="${escapeHtml(sw.id)}"${selectedSet.has(sw.id) ? " checked" : ""}>
      </label>`).join("") || `<p class="helper-text">No active switches. Enable a board and its switch points in Board Settings.</p>`}</div>`;
  }

  function showRoomDialog(roomId = null) {
    const room = roomId ? state.rooms.find((item) => item.id === roomId) : null;
    const body = `<div class="field"><label for="room-name">Room name</label><input id="room-name" name="name" maxlength="48" required value="${escapeHtml(room?.name || "")}" placeholder="Kitchen, Bedroom 1"></div>
      <div class="field"><span class="field-label">Select switches for this room</span>${renderSwitchChoices(room?.switchIds || [])}</div>
      <p class="error-text" id="dialog-error"></p>`;
    const actions = `${room ? actionButton("Delete Room", "delete-room", "danger-button") : ""}${actionButton("Cancel", "close-dialog", "secondary-button")}${actionButton("Save Room", "save-room")}`;
    openDialog("room", room ? "Edit Room" : "Add New Room", room ? `Editing ${room.name}` : "Choose the switches shown on this room page.", body, actions, { id: roomId });
  }

  function showGroupDialog(groupId = null) {
    const group = groupId ? state.groups.find((item) => item.id === groupId) : null;
    const body = `<div class="field"><label for="group-name">Group name</label><input id="group-name" name="name" maxlength="48" required value="${escapeHtml(group?.name || "")}" placeholder="All Lights, Night Mode"></div>
      <div class="field"><span class="field-label">Select member switches</span>${renderSwitchChoices(group?.switchIds || [])}</div>
      <p class="error-text" id="dialog-error"></p>`;
    const actions = `${group ? actionButton("Delete Group", "delete-group", "danger-button") : ""}${actionButton("Cancel", "close-dialog", "secondary-button")}${actionButton("Save Group", "save-group", "primary-button purple")}`;
    openDialog("group", group ? "Edit Switch Group" : "Create Switch Group", "One tap sends the same target state to every selected switch.", body, actions, { id: groupId });
  }

  function timeValue(hour, minute) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function dayChoices(selectedDays = [1, 2, 3, 4, 5, 6, 7]) {
    return `<div class="days-row">${DAYS.map((label, index) => `<button class="day-choice" type="button" data-action="toggle-day" data-day="${index + 1}" aria-pressed="${selectedDays.includes(index + 1)}">${label}</button>`).join("")}</div>`;
  }

  function selectedDaysFromDialog() {
    return [...dialogContent.querySelectorAll(".day-choice[aria-pressed='true']")].map((button) => Number(button.dataset.day));
  }

  function showScheduleEditor(schedule = null, presetSwitch = null) {
    const active = getActiveSwitches();
    const targetItems = [
      ...active.map((sw) => ({ id: sw.id, name: `${sw.customName} (${sw.id})`, type: "SWITCH" })),
      ...state.groups.map((group) => ({ id: group.id, name: group.name, type: "GROUP" }))
    ];
    const selected = targetItems.find((item) => item.id === (schedule?.targetId || presetSwitch)) || targetItems[0];
    const selectedTime = timeValue(schedule?.hour ?? 19, schedule?.minute ?? 0);
    const body = `<div class="field"><label for="schedule-target">Target switch or group</label>
      <select name="targetId" id="schedule-target">${targetItems.map((item) => `<option value="${escapeHtml(item.id)}" data-target-type="${item.type}"${selected?.id === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="schedule-time">Time (24-hour)</label><input id="schedule-time" name="time" type="time" required value="${selectedTime}"></div>
      <div class="field"><span class="field-label">Active days</span>${dayChoices(schedule?.daysOfWeek || [1, 2, 3, 4, 5, 6, 7])}</div>
      <div class="field"><label for="schedule-action">Schedule action</label><select name="turnOn" id="schedule-action"><option value="true"${schedule?.turnOn !== false ? " selected" : ""}>Turn ON</option><option value="false"${schedule?.turnOn === false ? " selected" : ""}>Turn OFF</option></select></div>
      <p class="info-box">Browser schedules run only while this app is open and active. For reliable background alarms, use the Android app.</p>
      <p class="error-text" id="dialog-error"></p>`;
    const actions = `${schedule ? actionButton("Delete", "delete-schedule", "danger-button") : ""}${actionButton("Cancel", "close-dialog", "secondary-button")}${actionButton(schedule ? "Save Changes" : "Save Schedule", "save-schedule")}`;
    openDialog("schedule-editor", schedule ? "Edit Timeline Schedule" : "Add Timeline Schedule", "", body, actions, { id: schedule?.id || null });
  }

  function showSchedulesDialog() {
    const rows = state.schedules.map((schedule) => {
      const days = schedule.daysOfWeek.length === 7 ? "Every day" : schedule.daysOfWeek.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day - 1]).join(", ");
      return `<div class="schedule-row"><div><strong>${escapeHtml(schedule.targetName)} · ${schedule.turnOn ? "Turn ON" : "Turn OFF"}</strong><small>${timeValue(schedule.hour, schedule.minute)} · ${escapeHtml(days)} · ${escapeHtml(schedule.targetType)}</small></div>
        <div><button class="text-button" type="button" data-action="toggle-schedule" data-schedule-id="${escapeHtml(schedule.id)}">${schedule.isEnabled === false ? "Enable" : "Pause"}</button><button class="text-button" type="button" data-action="edit-schedule" data-schedule-id="${escapeHtml(schedule.id)}">Edit</button></div></div>`;
    }).join("");
    const body = `${rows || `<div class="empty-state"><div><strong>No schedules yet</strong><span>Create a timeline schedule for a switch or group.</span></div></div>`}
      <p class="info-box">Schedules and daily timers are stored on this device. Web browsers may suspend pages in the background, so they cannot guarantee Android-style exact alarms.</p>`;
    openDialog("schedules", "Timeline Schedules", "Weekly switch and group automation.", body, `${actionButton("Close", "close-dialog", "secondary-button")}${actionButton("＋ Add Schedule", "new-schedule")}`);
  }

  function showCustomizeDialog(switchId) {
    const sw = getSwitch(switchId);
    if (!sw) return;
    const schedules = state.schedules.filter((schedule) => schedule.targetId === sw.id);
    const daily = state.dailySchedules[sw.id] || { enabled: false, onHour: 7, onMinute: 0, offHour: 22, offMinute: 0 };
    const countdown = state.countdowns[sw.id];
    const room = state.rooms.find((item) => item.switchIds.includes(sw.id));
    const body = `<div class="info-box">${escapeHtml(sw.id)} · Board ${escapeHtml(sw.boardKey)} · ${escapeHtml(sw.pinLabel)} · Relay ${sw.relayChannel + 1}</div>
      <div class="field"><label for="switch-name">Switch name</label><input id="switch-name" name="name" maxlength="48" required value="${escapeHtml(sw.customName)}"></div>
      <div class="field"><span class="field-label">Choose icon</span><div class="icon-options">${Object.entries(ICONS).slice(0, 10).map(([key, icon]) => `<button class="icon-choice" type="button" data-action="choose-icon" data-icon="${key}" aria-label="${key}" aria-pressed="${sw.iconName === key}">${icon}</button>`).join("")}</div><input type="hidden" name="iconName" value="${escapeHtml(sw.iconName)}"></div>
      <div class="field"><label for="switch-room">Room</label><select id="switch-room" name="roomId"><option value="">Not assigned</option>${state.rooms.map((item) => `<option value="${escapeHtml(item.id)}"${room?.id === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <div class="field"><span class="field-label">Daily schedule</span>
        <label class="toggle-row"><span>Enable daily ON/OFF schedule</span><input type="checkbox" name="dailyEnabled"${daily.enabled ? " checked" : ""}></label>
        <div class="form-grid"><div class="field"><label for="daily-on">Turn ON</label><input id="daily-on" name="dailyOn" type="time" value="${timeValue(daily.onHour, daily.onMinute)}"></div>
        <div class="field"><label for="daily-off">Turn OFF</label><input id="daily-off" name="dailyOff" type="time" value="${timeValue(daily.offHour, daily.offMinute)}"></div></div>
        <small class="helper-text">Runs only while this browser page is active; unlike Android alarms, it cannot run reliably after the app closes.</small>
      </div>
      <div class="field"><span class="field-label">Countdown timer</span>
        ${countdown ? `<p class="helper-text">A ${countdown.turnOn ? "turn ON" : "turn OFF"} command is due around ${new Date(countdown.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>${actionButton("Cancel countdown", "cancel-countdown", "secondary-button")}` : ""}
        <div class="form-grid"><div class="field"><label for="countdown-minutes">In how many minutes?</label><input id="countdown-minutes" name="countdownMinutes" type="number" min="1" max="10080" placeholder="Minutes"></div>
        <div class="field"><label for="countdown-action">Then</label><select id="countdown-action" name="countdownAction"><option value="true">Turn ON</option><option value="false">Turn OFF</option></select></div></div>
      </div>
      <div class="field"><span class="field-label">Timeline schedules</span>${schedules.length ? schedules.map((item) => `<div class="schedule-row"><div><strong>${timeValue(item.hour, item.minute)} · ${item.turnOn ? "Turn ON" : "Turn OFF"}</strong><small>${item.daysOfWeek.length === 7 ? "Every day" : item.daysOfWeek.join(", ")}</small></div><button class="text-button danger" type="button" data-action="delete-inline-schedule" data-schedule-id="${escapeHtml(item.id)}">Delete</button></div>`).join("") : `<p class="helper-text">No schedules for this switch.</p>`}
        <button class="text-button" type="button" data-action="new-schedule" data-switch-id="${escapeHtml(sw.id)}">＋ Add schedule</button></div>
      <p class="error-text" id="dialog-error"></p>`;
    const bodyWithSelectedIcon = body.replace(`value="${escapeHtml(sw.iconName)}"></div>`, `value="${escapeHtml(sw.iconName)}" data-icon-value></div>`);
    openDialog("customize-switch", "Customize Switch", "", bodyWithSelectedIcon, `${actionButton("Cancel", "close-dialog", "secondary-button")}${actionButton("Save Changes", "save-switch")}`, { id: switchId });
  }

  function parseTime(value, fallbackHour, fallbackMinute) {
    const [hour, minute] = String(value || "").split(":").map(Number);
    return Number.isInteger(hour) && Number.isInteger(minute) ? { hour, minute } : { hour: fallbackHour, minute: fallbackMinute };
  }

  function getPassword() {
    return sessionStorage.getItem(PASSWORD_KEY) || "";
  }

  function openSettings(tab = "Network") {
    renderSettings(tab);
  }

  function renderSettings(tab = "Network", draft = null) {
    const settings = draft || { ...state.settings, password: getPassword(), connectedBoards: [...state.connectedBoards], enabledSwitches: [...state.enabledSwitches], hubs: structuredClone(state.hubs) };
    const tabs = ["Network", "Saved Hubs", "Active Relays"];
    const tabButtons = `<nav class="settings-tabs" aria-label="Settings sections">${tabs.map((name) => `<button class="settings-tab" type="button" data-action="settings-tab" data-tab="${name}" aria-selected="${name === tab}">${name}</button>`).join("")}</nav>`;
    let body = "";
    if (tab === "Network") {
      body = `${tabButtons}<div class="field"><span class="field-label">Connection mode</span><div class="mode-options">
        ${[["AUTO", "Auto"], ["WIFI", "Wi-Fi"], ["CLOUD", "Cloud"], ["BLUETOOTH", "Bluetooth"]].map(([value, label]) => `<label class="mode-choice"><input type="radio" name="mode" value="${value}"${settings.mode === value ? " checked" : ""}> ${label}</label>`).join("")}</div></div>
        <div class="warning-box">This browser can connect to MQTT over secure WebSocket. Local HTTP and Bluetooth may be blocked or unavailable because of browser security and device support. Bluetooth mode uses Android’s native serial support and is unavailable here.</div>
        <div class="form-grid"><div class="field"><label for="device-ip">ESP32 local IP address</label><input id="device-ip" name="deviceIp" value="${escapeHtml(settings.deviceIp)}" placeholder="192.168.1.100"></div>
        <div class="field"><label for="device-name">Device name</label><input id="device-name" name="deviceName" value="${escapeHtml(settings.deviceName)}"></div>
        <div class="field full"><label for="mqtt-prefix">MQTT topic prefix</label><input id="mqtt-prefix" name="mqttPrefix" maxlength="120" required value="${escapeHtml(settings.mqttPrefix)}"></div>
        <div class="field"><label for="mqtt-host">MQTT broker host</label><input id="mqtt-host" name="mqttHost" value="${escapeHtml(settings.mqttHost)}" placeholder="broker.emqx.io"></div>
        <div class="field"><label for="mqtt-url">Secure WebSocket URL</label><input id="mqtt-url" name="mqttUrl" type="url" required value="${escapeHtml(settings.mqttUrl)}" placeholder="wss://broker.emqx.io:8084/mqtt"></div>
        <div class="field"><label for="mqtt-user">MQTT username (optional)</label><input id="mqtt-user" name="mqttUser" autocomplete="username" value="${escapeHtml(settings.mqttUser)}"></div>
        <div class="field"><label for="mqtt-pass">MQTT password (optional)</label><input id="mqtt-pass" name="mqttPass" type="password" autocomplete="current-password" value="${escapeHtml(settings.password || "")}"><small>Kept only for this browser session.</small></div></div>
        <p class="warning-box">The Android app defaults to a public MQTT broker and a publicly visible topic prefix. Use a unique prefix and a private authenticated broker for real equipment.</p>
        <button class="text-button" type="button" data-action="ota-info">Wireless firmware update…</button>`;
    } else if (tab === "Saved Hubs") {
      body = `${tabButtons}<p class="helper-text">Saved hub details stay in this browser. Automatic subnet scanning is restricted in browsers; add or select hubs manually.</p>
        ${settings.hubs.map((hub) => `<div class="hub-row"><div class="hub-detail"><strong>${escapeHtml(hub.name)}${hub.isPrimary ? " · PRIMARY" : ""}</strong><small>${escapeHtml(hub.ip)} · ${escapeHtml(hub.mqttPrefix)}</small></div><div>${hub.isPrimary ? "" : `<button class="text-button" type="button" data-action="select-hub" data-hub-id="${escapeHtml(hub.id)}">Select</button>`}<button class="text-button danger" type="button" data-action="delete-hub" data-hub-id="${escapeHtml(hub.id)}">Delete</button></div></div>`).join("")}
        <div class="form-grid"><div class="field"><label for="new-hub-name">New hub name</label><input id="new-hub-name" name="newHubName" placeholder="Ground Floor Hub"></div><div class="field"><label for="new-hub-ip">Local IP</label><input id="new-hub-ip" name="newHubIp" placeholder="192.168.1.101"></div><div class="field full"><label for="new-hub-prefix">MQTT topic prefix</label><input id="new-hub-prefix" name="newHubPrefix" placeholder="Unique hub topic prefix"></div></div>
        <button class="text-button" type="button" data-action="add-hub">＋ Add hub</button>
        <button class="text-button" type="button" data-action="discover">Try current hub IP</button>`;
    } else {
      const boards = settings.connectedBoards || ["ESP32"];
      const enabled = settings.enabledSwitches || [];
      body = `${tabButtons}<p class="helper-text">The ESP32 board is always enabled. Choose connected expansion boards, then enable the individual switch points shown below.</p>
        <div class="check-list">${BOARDS.map((board) => `<label class="check-row${boards.includes(board) ? " selected" : ""}"><span class="check-detail"><strong>${board === "ESP32" ? "ESP32 main board" : `PCF8575 ${board}`}</strong><small>${board === "ESP32" ? "8 GPIO switch points" : "16 expansion switch points"}</small></span><input type="checkbox" name="boards" value="${board}"${board === "ESP32" || boards.includes(board) ? " checked" : ""}${board === "ESP32" ? " disabled" : ""}></label>`).join("")}</div>
        <label class="field"><span class="field-label">Filter switch points</span><input class="search-input" data-action="filter-switches" placeholder="Search S1, Relay, GPIO, or board"></label>
        <div class="check-list" id="active-switch-list">                ${state.switches.map((sw) => `<label class="check-row${enabled.includes(sw.id) ? " selected" : ""}" data-switch-search="${escapeHtml(`${sw.id} ${sw.customName} ${sw.boardKey} ${sw.pinLabel}`.toLowerCase())}"><span class="check-detail"><strong>${escapeHtml(sw.customName)} (${sw.id})</strong><small>${escapeHtml(sw.boardKey)} · ${escapeHtml(sw.pinLabel)} · Relay ${sw.relayChannel + 1}</small></span><input type="checkbox" name="enabledSwitches" value="${sw.id}"${enabled.includes(sw.id) ? " checked" : ""}></label>`).join("")}</div>`;
    }
    const actions = `${actionButton("Close", "close-dialog", "secondary-button")}${actionButton("Save Settings", "save-settings")}`;
    openDialog("settings", "Vajra Smart Hub Settings", "", body, actions, { tab, draft: settings });
  }

  function collectSettingsDraft() {
    if (!dialogState || dialogState.kind !== "settings") return;
    const form = $("#dialog-form");
    const data = new FormData(form);
    const draft = dialogState.draft || {};
    for (const field of ["deviceIp", "deviceName", "mqttPrefix", "mqttHost", "mqttUrl", "mqttUser", "mqttPass", "mode"]) {
      if (data.has(field)) draft[field] = data.get(field);
    }
    if (data.has("boards")) draft.connectedBoards = data.getAll("boards");
    else if (dialogState.tab === "Active Relays") draft.connectedBoards = ["ESP32", ...new Set(draft.connectedBoards || [])];
    if (data.has("enabledSwitches")) draft.enabledSwitches = data.getAll("enabledSwitches");
    else if (dialogState.tab === "Active Relays") draft.enabledSwitches = [];
    dialogState.draft = draft;
  }

  function changeSettingsTab(tab) {
    collectSettingsDraft();
    renderSettings(tab, dialogState.draft);
  }

  function requestPin(target) {
    const body = `<div class="warning-box">Enter the six-digit app access code to continue. A code check inside a web app is only a screen lock; it is not secure authentication.</div>
      <div class="field"><label for="security-pin">Security password</label><input id="security-pin" name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div><p class="error-text" id="dialog-error"></p>`;
    openDialog("pin", target === "settings" ? "Settings Security Password" : "OTA Flasher Security Password", "", body, `${actionButton("Cancel", "close-dialog", "secondary-button")}${actionButton("Unlock Access", "unlock-pin")}`, { target });
  }

  function showOtaInfo() {
    const body = `<div class="warning-box">Firmware flashing is not available in this browser companion.</div>
      <p class="helper-text">The Android app uploads its embedded firmware to the hub over local HTTP and requires native network behavior. Mobile and desktop browsers can block this request because of mixed-content, CORS, and local-network protections. Use the Android app’s protected OTA screen to flash firmware.</p>
      <p class="helper-text">Do not power off the hub during a firmware update.</p>`;
    openDialog("ota", "Wireless Firmware Update", "", body, actionButton("Close", "close-dialog", "secondary-button"));
  }

  function renderDiagnostics(results = []) {
    const rows = results.map((result) => `<div class="result-row"><div><strong style="color:${result.ok ? "#10b981" : "#ef4444"}">${result.ok ? "✓" : "!"} ${escapeHtml(result.name)}</strong><small>${escapeHtml(result.detail)}</small>${result.fix ? `<small style="color:#fbbf24">Suggested fix: ${escapeHtml(result.fix)}</small>` : ""}</div></div>`).join("");
    openDialog("diagnostics", "ESP32 & Network Diagnostics", "Browser compatibility and configured connection checks.", `${rows || `<p class="helper-text">Checks secure browser support, hub reachability, and connection limitations.</p>`}`, `${actionButton("Close", "close-dialog", "secondary-button")}${actionButton("Run Browser Checks", "run-diagnostics")}`);
  }

  async function runDiagnostics() {
    const results = [
      { name: "Secure browser context", ok: window.isSecureContext, detail: window.isSecureContext ? "HTTPS or localhost is available for app installation and secure WebSocket." : "This page is not in a secure context.", fix: "Publish over HTTPS to enable PWA features." },
    ];
    renderDiagnostics(results);
    const mode = state.settings.mode;
    let localAvailable = connectionState === "connected" && activeRoute === "Local Wi-Fi";
    if (!localAvailable && ["AUTO", "WIFI"].includes(mode) && connectionState !== "connected") {
      localAvailable = await connectLocal();
    }
    if (!localAvailable && connectionState !== "connected") setConnectionState("disconnected");
    results.push(localAvailable
      ? { name: "Local Wi-Fi", ok: true, detail: "The configured local hub returned a Vajra status page." }
      : { name: "Local Wi-Fi", ok: false, detail: "The browser could not read the hub's HTTP status page.", fix: "Mixed-content and CORS rules can block local HTTP; use secure MQTT or the Android app." });
    if (connectionState !== "connected" && ["AUTO", "CLOUD"].includes(mode) && state.settings.mqttPrefix.trim()) {
      connectCloud();
      const deadline = Date.now() + 5000;
      while (connectionState === "connecting" && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
    }
    const cloudAvailable = connectionState === "connected" && activeRoute === "Cloud MQTT";
    results.push({
      name: "Cloud MQTT",
      ok: cloudAvailable,
      detail: cloudAvailable ? "Connected to the configured MQTT broker over secure WebSocket." : "No active secure MQTT connection was confirmed.",
      fix: "Check the WSS endpoint, topic prefix, broker availability, and credentials."
    });
    results.push({ name: "Bluetooth", ok: false, detail: "The Android app uses Bluetooth SPP. This web app cannot provide the same Bluetooth serial support across iPhone, Android, and desktop.", fix: "Use the Android app for Bluetooth mode." });
    results.push({ name: "Background schedules", ok: false, detail: "This browser runs timers only while the page is active; it cannot guarantee alarms when closed.", fix: "Use the Android app for exact background alarms." });
    renderDiagnostics(results);
  }

  function connect() {
    const mode = state.settings.mode || "AUTO";
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      disconnect();
      return;
    }
    if (connectionState === "connected") {
      setConnectionState("disconnected");
    } else if (connectionState === "connecting") {
      return;
    }
    if (mode === "BLUETOOTH") {
      showToast("Bluetooth SPP is only available in the Android app.");
      return;
    }
    if (mode === "WIFI") {
      connectLocal().then((connected) => {
        if (!connected) {
          setConnectionState("disconnected");
          showToast("Local Wi-Fi connection is restricted by this browser. Try Cloud MQTT or the Android app.");
        }
      });
      return;
    }
    if (mode === "AUTO") {
      setConnectionState("connecting", "Checking local hub, then secure MQTT…");
      connectLocal().then((connected) => {
        if (!connected) connectCloud();
      });
      return;
    }
    connectCloud();
  }

  function setConnectionState(next, detail = "") {
    connectionState = next;
    if (detail) $("#footer-connection").textContent = `${detail} · Browser edition`;
    render();
  }

  async function connectLocal() {
    const ip = state.settings.deviceIp.trim();
    if (!ip) return false;
    setConnectionState("connecting", "Checking local Wi-Fi");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch(`http://${ip}/`, { signal: controller.signal, mode: "cors", cache: "no-store" });
      if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}.`);
      const html = await response.text();
      if (!/VAJRA SMART HUB|\/toggle/i.test(html)) throw new Error("The page did not identify as a Vajra hub.");
      const localStatus = parseLocalStatus(html);
      activeRoute = "Local Wi-Fi";
      setConnectionState("connected");
      applyLocalStatus(localStatus);
      return true;
    } catch (error) {
      if (error.name !== "AbortError") console.info("Browser local Wi-Fi check unavailable:", error.message);
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function parseLocalStatus(html) {
    const result = {};
    for (let channel = 0; channel < 8; channel += 1) {
      const match = new RegExp(`value=['"]${channel}['"][\\\\s\\\\S]*?class=['"]btn\\\\s+(on|off)['"]`, "i").exec(html);
      if (match) result[channel] = match[1].toLowerCase() === "on";
    }
    return result;
  }

  function applyLocalStatus(status) {
    let changed = false;
    state.switches = state.switches.map((sw) => {
      if (Object.hasOwn(status, sw.relayChannel) && sw.isOn !== status[sw.relayChannel]) {
        changed = true;
        return { ...sw, isOn: status[sw.relayChannel] };
      }
      return sw;
    });
    if (changed) persist();
    renderPage();
  }

  function connectCloud() {
    const config = state.settings;
    let url;
    try {
      url = new URL(config.mqttUrl);
      if (url.protocol !== "wss:") throw new Error("Use a secure WebSocket URL beginning with wss://.");
      if (!config.mqttPrefix.trim()) throw new Error("Enter your MQTT topic prefix in Board Settings.");
    } catch (error) {
      setConnectionState("disconnected");
      showToast(error.message);
      return;
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) disconnect();
    window.clearTimeout(reconnectTimer);
    manualClose = false;
    receiveBuffer = new Uint8Array(0);
    activeRoute = "Cloud MQTT";
    setConnectionState("connecting");
    try {
      socket = new WebSocket(url.toString(), "mqtt");
    } catch (error) {
      setConnectionState("disconnected");
      showToast(`Could not open secure WebSocket: ${error.message}`);
      return;
    }
    const activeSocket = socket;
    activeSocket.binaryType = "arraybuffer";
    activeSocket.addEventListener("open", () => {
      if (socket !== activeSocket) return;
      try { sendConnect(config); } catch (error) {
        showToast(`Could not start MQTT: ${error.message}`);
        disconnect();
      }
    });
    activeSocket.addEventListener("message", async (event) => {
      if (socket !== activeSocket) return;
      try {
        const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(await event.data.arrayBuffer());
        processPackets(bytes);
      } catch (error) {
        console.error("Invalid MQTT response:", error);
        showToast(`Invalid MQTT response: ${error.message}`);
      }
    });
    activeSocket.addEventListener("error", () => showToast("Secure WebSocket failed. Check broker URL, network, and broker availability."));
    activeSocket.addEventListener("close", (event) => {
      window.clearInterval(pingTimer);
      if (socket !== activeSocket) return;
      socket = null;
      if (connectionState !== "disconnected") setConnectionState("disconnected");
      if (!manualClose && event.code !== 1000) {
        showToast("Broker connection closed. Check settings and try again.");
        if (["AUTO", "CLOUD"].includes(state.settings.mode) && state.settings.mqttPrefix.trim()) {
          reconnectTimer = window.setTimeout(() => {
            if (document.visibilityState === "visible" && navigator.onLine) connect();
          }, 4000);
        }
      }
    });
  }

  function disconnect() {
    manualClose = true;
    window.clearTimeout(reconnectTimer);
    window.clearInterval(pingTimer);
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "User disconnected");
    socket = null;
    setConnectionState("disconnected");
  }

  function utf8(value) {
    return new TextEncoder().encode(value);
  }

  function encodeString(value) {
    const bytes = utf8(value);
    if (bytes.length > 65535) throw new Error("MQTT text field is too long.");
    const result = new Uint8Array(bytes.length + 2);
    result[0] = bytes.length >> 8;
    result[1] = bytes.length & 0xff;
    result.set(bytes, 2);
    return result;
  }

  function encodeRemainingLength(length) {
    const bytes = [];
    do {
      let digit = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) digit |= 0x80;
      bytes.push(digit);
    } while (length > 0);
    return new Uint8Array(bytes);
  }

  function packet(header, payload) {
    const remaining = encodeRemainingLength(payload.length);
    const result = new Uint8Array(1 + remaining.length + payload.length);
    result[0] = header;
    result.set(remaining, 1);
    result.set(payload, 1 + remaining.length);
    return result;
  }

  function join(parts) {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    parts.forEach((part) => {
      result.set(part, offset);
      offset += part.length;
    });
    return result;
  }

  function sendConnect(config) {
    const clientId = `VajraWeb_${makeId("client").slice(-12)}`;
    let flags = 0x02;
    const fields = [encodeString("MQTT"), new Uint8Array([4])];
    if (config.mqttUser) flags |= 0x80;
    if (getPassword()) flags |= 0x40;
    fields.push(new Uint8Array([flags, 0, 30]), encodeString(clientId));
    if (config.mqttUser) fields.push(encodeString(config.mqttUser));
    if (getPassword()) fields.push(encodeString(getPassword()));
    socket.send(packet(0x10, join(fields)));
  }

  function sendSubscribe() {
    const id = nextPacketId();
    const filters = Array.from({ length: 8 }, (_, channel) => join([
      encodeString(`${state.settings.mqttPrefix}/relay${channel + 1}/status`),
      new Uint8Array([0])
    ]));
    socket.send(packet(0x82, join([new Uint8Array([id >> 8, id & 0xff]), ...filters])));
  }

  function sendPublish(topic, value) {
    const id = nextPacketId();
    socket.send(packet(0x32, join([encodeString(topic), new Uint8Array([id >> 8, id & 0xff]), utf8(value)])));
  }

  function nextPacketId() {
    packetId = packetId >= 65535 ? 1 : packetId + 1;
    return packetId;
  }

  function readString(bytes, offset) {
    if (offset + 2 > bytes.length) throw new Error("Invalid MQTT string.");
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const end = offset + 2 + length;
    if (end > bytes.length) throw new Error("Invalid MQTT string length.");
    return { value: new TextDecoder().decode(bytes.subarray(offset + 2, end)), end };
  }

  function processPackets(bytes) {
    receiveBuffer = join([receiveBuffer, bytes]);
    let offset = 0;
    while (offset < receiveBuffer.length) {
      const first = receiveBuffer[offset];
      let multiplier = 1;
      let remainingLength = 0;
      let cursor = offset + 1;
      let lengthComplete = false;
      for (let count = 0; count < 4; count += 1) {
        if (cursor >= receiveBuffer.length) break;
        const digit = receiveBuffer[cursor++];
        remainingLength += (digit & 0x7f) * multiplier;
        if ((digit & 0x80) === 0) {
          lengthComplete = true;
          break;
        }
        multiplier *= 128;
      }
      if (!lengthComplete) break;
      const end = cursor + remainingLength;
      if (end > receiveBuffer.length) break;
      processPacket(first, receiveBuffer.subarray(cursor, end));
      offset = end;
    }
    receiveBuffer = receiveBuffer.slice(offset);
  }

  function processPacket(header, payload) {
    const type = header >> 4;
    if (type === 2) {
      if (payload.length < 2 || payload[1] !== 0) {
        const reason = payload.length > 1 ? payload[1] : "unknown";
        showToast(`The broker rejected the connection (code ${reason}). Check credentials.`);
        disconnect();
        return;
      }
      sendSubscribe();
      setConnectionState("connected");
      window.clearInterval(pingTimer);
      pingTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(new Uint8Array([0xc0, 0x00]));
      }, 15000);
      return;
    }
    if (type === 3) {
      const topic = readString(payload, 0);
      const qualityOfService = (header >> 1) & 0x03;
      let bodyOffset = topic.end;
      if (qualityOfService > 0) {
        if (bodyOffset + 2 > payload.length) return;
        const id = (payload[bodyOffset] << 8) | payload[bodyOffset + 1];
        bodyOffset += 2;
        if (qualityOfService === 1 && socket?.readyState === WebSocket.OPEN) socket.send(packet(0x40, new Uint8Array([id >> 8, id & 0xff])));
      }
      const match = topic.value.match(new RegExp(`^${escapeRegExp(state.settings.mqttPrefix)}/relay([1-8])/status$`));
      if (match) {
        const value = new TextDecoder().decode(payload.subarray(bodyOffset)).trim().toUpperCase();
        if (value === "ON" || value === "OFF") updateRelayChannel(Number(match[1]) - 1, value === "ON");
      }
      return;
    }
    if (type === 12 && socket?.readyState === WebSocket.OPEN) socket.send(new Uint8Array([0xd0, 0x00]));
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function updateRelayChannel(channel, isOn) {
    let changed = false;
    state.switches = state.switches.map((sw) => {
      if (sw.relayChannel === channel && sw.isOn !== isOn) {
        changed = true;
        return { ...sw, isOn };
      }
      return sw;
    });
    if (changed) {
      persist();
      renderPage();
    }
  }

  function relayCommand(channel, isOn) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const prefix = state.settings.mqttPrefix.trim();
    sendPublish(`${prefix}/relay${channel + 1}/set`, isOn ? "ON" : "OFF");
    return true;
  }

  async function toggleSwitch(switchId) {
    const sw = getSwitch(switchId);
    if (!sw) return;
    if (connectionState !== "connected") {
      showToast("Connect to your hub before sending a command.");
      return;
    }
    const nextState = !sw.isOn;
    if (activeRoute === "Local Wi-Fi") {
      try {
        const response = await fetch(`http://${state.settings.deviceIp}/toggle`, {
          method: "POST",
          mode: "cors",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `ch=${sw.relayChannel}`
        });
        if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}.`);
        updateRelayChannel(sw.relayChannel, nextState);
        showToast(`${sw.customName}: command sent.`);
      } catch (error) {
        showToast(`Local command was blocked or failed: ${error.message}. Try Cloud MQTT.`);
      }
      return;
    }
    try {
      if (!relayCommand(sw.relayChannel, nextState)) throw new Error("MQTT connection is not open.");
      updateRelayChannel(sw.relayChannel, nextState);
      showToast(`${sw.customName}: ${nextState ? "ON" : "OFF"} command sent.`);
    } catch (error) {
      showToast(`Could not send relay command: ${error.message}`);
    }
  }

  async function setRelayChannel(channel, isOn) {
    if (connectionState !== "connected") {
      showToast("Connect to your hub before sending a command.");
      return;
    }
    if (activeRoute === "Local Wi-Fi") {
      const sw = state.switches.find((item) => item.relayChannel === channel);
      if (sw) return toggleSwitch(sw.id);
    }
    try {
      if (!relayCommand(channel, isOn)) throw new Error("MQTT connection is not open.");
      updateRelayChannel(channel, isOn);
    } catch (error) {
      showToast(`Could not send relay command: ${error.message}`);
    }
  }

  function toggleGroup(groupId) {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) return;
    const activeIds = new Set(getActiveSwitches().map((sw) => sw.id));
    const members = group.switchIds.map(getSwitch).filter((sw) => sw && activeIds.has(sw.id));
    if (!members.length) {
      showToast("This group has no active switch members.");
      return;
    }
    if (connectionState !== "connected") {
      showToast("Connect to your hub before sending a command.");
      return;
    }
    const turnOn = !group.switchIds.length || !group.switchIds.every((id) => {
      const sw = getSwitch(id);
      return activeIds.has(id) && sw?.isOn === true;
    });
    const channels = [...new Set(members.map((sw) => sw.relayChannel))];
    channels.forEach((channel) => {
      if (activeRoute !== "Local Wi-Fi") relayCommand(channel, turnOn);
    });
    if (activeRoute === "Local Wi-Fi") {
      members.filter((sw) => sw.isOn !== turnOn).forEach((sw) => toggleSwitch(sw.id));
      return;
    }
    channels.forEach((channel) => updateRelayChannel(channel, turnOn));
    showToast(`${group.name}: ${turnOn ? "ON" : "OFF"} commands sent.`);
  }

  function saveRoom() {
    const name = $("#dialog-form").elements.name.value.trim();
    if (!name) return setDialogError("Enter a room name.");
    const switchIds = [...dialogContent.querySelectorAll("input[name='switchIds']:checked")].map((input) => input.value);
    const existing = dialogState.id && state.rooms.find((room) => room.id === dialogState.id);
    if (existing) Object.assign(existing, { name, switchIds });
    else {
      const room = { id: makeId("room"), name, iconName: "ROOM", switchIds };
      state.rooms.push(room);
      activePageId = room.id;
    }
    persist();
    closeDialog();
    render();
  }

  function saveGroup() {
    const name = $("#dialog-form").elements.name.value.trim();
    if (!name) return setDialogError("Enter a group name.");
    const switchIds = [...dialogContent.querySelectorAll("input[name='switchIds']:checked")].map((input) => input.value);
    const existing = dialogState.id && state.groups.find((group) => group.id === dialogState.id);
    if (existing) Object.assign(existing, { name, switchIds });
    else state.groups.push({ id: makeId("group"), name, iconName: "GROUP", switchIds });
    persist();
    closeDialog();
    render();
  }

  function setDialogError(message) {
    const error = $("#dialog-error");
    if (error) error.textContent = message;
  }

  function saveSchedule() {
    const form = $("#dialog-form");
    const data = new FormData(form);
    const targetId = String(data.get("targetId") || "");
    const selected = form.elements.targetId.selectedOptions[0];
    const target = selected ? selected.textContent : targetId;
    const [hour, minute] = String(data.get("time") || "").split(":").map(Number);
    const daysOfWeek = selectedDaysFromDialog();
    if (!targetId) return setDialogError("Choose a switch or group.");
    if (!daysOfWeek.length) return setDialogError("Select at least one day.");
    const schedule = {
      id: dialogState.id || makeId("sched"),
      targetId,
      targetType: selected?.dataset.targetType || "SWITCH",
      targetName: target.replace(/\s+\(S\d+\)$/, ""),
      hour,
      minute,
      daysOfWeek,
      turnOn: data.get("turnOn") === "true",
      isEnabled: true
    };
    const index = state.schedules.findIndex((item) => item.id === schedule.id);
    if (index >= 0) state.schedules[index] = schedule;
    else state.schedules.push(schedule);
    persist();
    showSchedulesDialog();
  }

  function saveSwitch() {
    const form = $("#dialog-form");
    const data = new FormData(form);
    const sw = getSwitch(dialogState.id);
    if (!sw) return closeDialog();
    const name = String(data.get("name") || "").trim();
    if (!name) return setDialogError("Enter a switch name.");
    sw.customName = name;
    sw.iconName = String(data.get("iconName") || "LIGHT");
    const roomId = String(data.get("roomId") || "");
    if (roomId) {
      const targetRoom = state.rooms.find((room) => room.id === roomId);
      if (targetRoom) targetRoom.switchIds = [...new Set([...targetRoom.switchIds, sw.id])];
    } else if (room) {
      room.switchIds = room.switchIds.filter((id) => id !== sw.id);
    }
    const onTime = parseTime(data.get("dailyOn"), 7, 0);
    const offTime = parseTime(data.get("dailyOff"), 22, 0);
    state.dailySchedules[sw.id] = {
      enabled: data.has("dailyEnabled"),
      onHour: onTime.hour,
      onMinute: onTime.minute,
      offHour: offTime.hour,
      offMinute: offTime.minute
    };
    const minutes = Number(data.get("countdownMinutes"));
    if (Number.isFinite(minutes) && minutes > 0) {
      state.countdowns[sw.id] = { at: Date.now() + minutes * 60000, turnOn: data.get("countdownAction") === "true" };
    }
    persist();
    closeDialog();
    render();
  }

  function saveSettings() {
    collectSettingsDraft();
    const draft = dialogState.draft;
    if (dialogState.tab === "Network") {
      const form = $("#dialog-form");
      const data = new FormData(form);
      const mqttUrl = String(data.get("mqttUrl") || "").trim();
      const prefix = String(data.get("mqttPrefix") || "").trim();
      try {
        const parsed = new URL(mqttUrl);
        if (parsed.protocol !== "wss:") throw new Error("Use a secure WebSocket URL beginning with wss://.");
        if (!prefix || /[+#\s]/.test(prefix)) throw new Error("Enter a topic prefix without spaces, +, or #.");
      } catch (error) {
        return showToast(error.message || "Enter a valid secure WebSocket URL.");
      }
      state.settings = {
        ...state.settings,
        deviceIp: String(data.get("deviceIp") || "").trim(),
        deviceName: String(data.get("deviceName") || "").trim(),
        mqttPrefix: prefix,
        mqttHost: String(data.get("mqttHost") || "").trim(),
        mqttUrl,
        mqttUser: String(data.get("mqttUser") || "").trim(),
        mode: String(data.get("mode") || "AUTO")
      };
      const pass = String(data.get("mqttPass") || "");
      if (pass) sessionStorage.setItem(PASSWORD_KEY, pass);
      else sessionStorage.removeItem(PASSWORD_KEY);
      const primary = state.hubs.find((hub) => hub.isPrimary);
      if (primary) Object.assign(primary, { ip: state.settings.deviceIp, name: state.settings.deviceName, mqttPrefix: prefix });
    } else if (dialogState.tab === "Active Relays") {
      const form = $("#dialog-form");
      const selectedBoards = new FormData(form).getAll("boards").map(String);
      state.connectedBoards = [...new Set(["ESP32", ...selectedBoards])];
      state.enabledSwitches = new FormData(form).getAll("enabledSwitches").map(String);
    } else if (dialogState.tab !== "Saved Hubs") {
      state.settings = { ...state.settings, ...draft };
    }
    persist();
    closeDialog();
    render();
    if (socket && socket.readyState < WebSocket.CLOSING) disconnect();
    window.setTimeout(connect, 0);
  }

  function addHub() {
    const form = $("#dialog-form");
    const name = form.elements.newHubName.value.trim();
    const ip = form.elements.newHubIp.value.trim();
    const prefix = form.elements.newHubPrefix.value.trim();
    if (!name || !ip || !prefix) return showToast("Enter a hub name, local IP, and MQTT topic prefix.");
    state.hubs.push({ id: makeId("hub"), name, ip, mqttPrefix: prefix, isPrimary: false });
    persist();
    renderSettings("Saved Hubs");
  }

  function selectHub(hubId) {
    const hub = state.hubs.find((item) => item.id === hubId);
    if (!hub) return;
    state.hubs.forEach((item) => { item.isPrimary = item.id === hub.id; });
    state.settings.deviceIp = hub.ip;
    state.settings.deviceName = hub.name;
    state.settings.mqttPrefix = hub.mqttPrefix;
    persist();
    if (socket && socket.readyState < WebSocket.CLOSING) disconnect();
    renderSettings("Saved Hubs");
    showToast(`${hub.name} selected as primary hub.`);
    window.setTimeout(connect, 0);
  }

  async function discoverHub() {
    try {
      const ip = state.settings.deviceIp.trim();
      if (!ip) throw new Error("Enter the ESP32 IP address in Board Settings first.");
      const response = await fetch(`http://${ip}/`, { mode: "cors", cache: "no-store", signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}.`);
      const html = await response.text();
      if (!/VAJRA SMART HUB/i.test(html)) throw new Error("The address did not identify as a Vajra hub.");
      const prefix = /Topic Prefix:\s*([\w_]+)/i.exec(html)?.[1] || state.settings.mqttPrefix;
      state.hubs.push({ id: makeId("hub"), name: `Vajra Hub (${ip})`, ip, mqttPrefix: prefix, isPrimary: false });
      persist();
      showToast("Hub found and saved.");
    } catch (error) {
      showToast(`Automatic local discovery is restricted here: ${error.message}. Add the hub manually or use Android.`);
    }
  }

  function handleDialogAction(action, target) {
    if (action === "close-dialog") closeDialog();
    else if (action === "save-room") saveRoom();
    else if (action === "save-group") saveGroup();
    else if (action === "delete-room") {
      state.rooms = state.rooms.filter((room) => room.id !== dialogState.id);
      if (!state.rooms.length) state.rooms.push({ id: "room_main", name: "Main Room", iconName: "ROOM", switchIds: [] });
      activePageId = state.rooms[0].id;
      persist();
      closeDialog();
      render();
    } else if (action === "delete-group") {
      state.groups = state.groups.filter((group) => group.id !== dialogState.id);
      persist();
      closeDialog();
      render();
    } else if (action === "save-schedule") saveSchedule();
    else if (action === "new-schedule") showScheduleEditor(null, target?.dataset.switchId || null);
    else if (action === "edit-schedule") {
      const schedule = state.schedules.find((item) => item.id === target.dataset.scheduleId);
      if (schedule) showScheduleEditor(schedule);
    } else if (action === "delete-schedule") {
      state.schedules = state.schedules.filter((item) => item.id !== dialogState.id);
      persist();
      showSchedulesDialog();
    } else if (action === "toggle-schedule") {
      const schedule = state.schedules.find((item) => item.id === target.dataset.scheduleId);
      if (schedule) schedule.isEnabled = schedule.isEnabled === false;
      persist();
      showSchedulesDialog();
    } else if (action === "delete-inline-schedule") {
      state.schedules = state.schedules.filter((item) => item.id !== target.dataset.scheduleId);
      persist();
      showCustomizeDialog(dialogState.id);
    } else if (action === "save-switch") saveSwitch();
    else if (action === "cancel-countdown") {
      delete state.countdowns[dialogState.id];
      persist();
      showCustomizeDialog(dialogState.id);
    } else if (action === "save-settings") saveSettings();
    else if (action === "add-hub") addHub();
    else if (action === "select-hub") selectHub(target.dataset.hubId);
    else if (action === "delete-hub") {
      state.hubs = state.hubs.filter((hub) => hub.id !== target.dataset.hubId);
      if (!state.hubs.some((hub) => hub.isPrimary) && state.hubs[0]) state.hubs[0].isPrimary = true;
      persist();
      renderSettings("Saved Hubs");
    } else if (action === "discover") discoverHub();
    else if (action === "ota-info") showOtaInfo();
    else if (action === "unlock-pin") {
      if ($("#dialog-form").elements.pin.value !== "290771") return setDialogError("Incorrect password. Access denied.");
      const targetName = dialogState.target;
      closeDialog();
      if (targetName === "settings") openSettings();
      else showOtaInfo();
    } else if (action === "run-diagnostics") runDiagnostics();
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (dialog.contains(target)) {
      if (action === "settings-tab") {
        event.preventDefault();
        changeSettingsTab(target.dataset.tab);
      } else if (action === "toggle-day") {
        event.preventDefault();
        const selected = target.getAttribute("aria-pressed") === "true";
        target.setAttribute("aria-pressed", String(!selected));
      } else if (action === "choose-icon") {
        event.preventDefault();
        dialogContent.querySelector("[data-icon-value]").value = target.dataset.icon;
        dialogContent.querySelectorAll(".icon-choice").forEach((button) => button.setAttribute("aria-pressed", String(button === target)));
      } else if (action === "filter-switches") {
        event.preventDefault();
      } else {
        event.preventDefault();
        handleDialogAction(action, target);
      }
      return;
    }
    if (action === "page") {
      activePageId = target.dataset.pageId;
      persist();
      render();
    } else if (action === "edit-room") showRoomDialog(target.dataset.roomId);
    else if (action === "add-group") showGroupDialog();
    else if (action === "edit-group") showGroupDialog(target.dataset.groupId);
    else if (action === "edit-switch") showCustomizeDialog(target.dataset.switchId);
    else if (action === "toggle-switch") toggleSwitch(target.dataset.switchId);
    else if (action === "toggle-group") toggleGroup(target.dataset.groupId);
    else if (action === "schedules") showSchedulesDialog();
    else if (action === "settings") requestPin("settings");
    else if (action === "diagnostics") runDiagnostics();
    else if (action === "discover") discoverHub();
    else if (action === "connect") connect();
    else if (action === "add-room") showRoomDialog();
    else if (action === "ota-info") showOtaInfo();
  });

  $("#page-add").addEventListener("click", () => {
    if (activePageId === "__groups__") showGroupDialog();
    else showRoomDialog();
  });

  let swipeStart = null;
  $("#page-content").addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  $("#page-content").addEventListener("touchend", (event) => {
    if (!swipeStart) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - swipeStart.x;
    const deltaY = touch.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(deltaX) < 65 || Math.abs(deltaY) > 75) return;
    const pages = [...state.rooms.map((room) => room.id), "__groups__"];
    const currentIndex = pages.indexOf(activePageId);
    const nextIndex = Math.max(0, Math.min(pages.length - 1, currentIndex + (deltaX < 0 ? 1 : -1)));
    if (nextIndex !== currentIndex) {
      activePageId = pages[nextIndex];
      persist();
      render();
    }
  }, { passive: true });

  $("#connection-badge").addEventListener("click", connect);
  $("#app-dialog").addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  $("#dialog-form").addEventListener("submit", (event) => event.preventDefault());
  $("#dialog-content").addEventListener("input", (event) => {
    if (event.target.matches("[data-action='filter-switches']")) {
      const query = event.target.value.trim().toLowerCase();
      dialogContent.querySelectorAll("[data-switch-search]").forEach((row) => {
        row.hidden = !row.dataset.switchSearch.includes(query);
      });
    }
  });

  $("#dialog-content").addEventListener("change", (event) => {
    if (event.target.name === "boards") {
      event.target.closest(".check-row")?.classList.toggle("selected", event.target.checked);
    } else if (event.target.name === "enabledSwitches" || event.target.name === "switchIds") {
      event.target.closest(".check-row")?.classList.toggle("selected", event.target.checked);
    }
  });

  $("#dialog-form").addEventListener("click", (event) => {
    if (event.target.closest("[data-action='cancel-countdown']")) event.preventDefault();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.closest(".switch-card, .group-card")) return;
    event.preventDefault();
    const card = event.target.closest("[data-action]");
    if (card.dataset.action === "toggle-switch") toggleSwitch(card.dataset.switchId);
    if (card.dataset.action === "toggle-group") toggleGroup(card.dataset.groupId);
  });

  let lastUiMinute = "";
  function runAutomationTick() {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    let shouldRender = false;
    if (minuteKey !== lastScheduleMinute) {
      lastScheduleMinute = minuteKey;
      shouldRender = true;
      const day = now.getDay() + 1;
      state.schedules.filter((item) => item.isEnabled !== false && item.daysOfWeek.includes(day) && item.hour === now.getHours() && item.minute === now.getMinutes()).forEach((item) => {
        if (item.targetType === "GROUP") {
          const group = state.groups.find((candidate) => candidate.id === item.targetId);
          if (group) {
            [...new Set(group.switchIds.map(getSwitch).filter(Boolean).map((sw) => sw.relayChannel))]
              .forEach((channel) => setRelayChannel(channel, item.turnOn));
          }
        } else {
          const sw = getSwitch(item.targetId);
          if (sw && sw.isOn !== item.turnOn) setRelayChannel(sw.relayChannel, item.turnOn);
        }
      });
      Object.entries(state.dailySchedules).forEach(([switchId, schedule]) => {
        if (!schedule.enabled) return;
        const sw = getSwitch(switchId);
        if (!sw) return;
        const onNow = schedule.onHour === now.getHours() && schedule.onMinute === now.getMinutes();
        const offNow = schedule.offHour === now.getHours() && schedule.offMinute === now.getMinutes();
        if (onNow && !sw.isOn) setRelayChannel(sw.relayChannel, true);
        if (offNow && sw.isOn) setRelayChannel(sw.relayChannel, false);
      });
    }
    const expired = Object.entries(state.countdowns).filter(([, timer]) => timer.at <= Date.now());
    expired.forEach(([switchId, timer]) => {
      const sw = getSwitch(switchId);
      if (sw) setRelayChannel(sw.relayChannel, timer.turnOn);
      delete state.countdowns[switchId];
    });
    if (expired.length) {
      shouldRender = true;
      persist();
    }
    const uiMinute = Math.floor(Date.now() / 60000);
    if (uiMinute !== lastUiMinute) {
      lastUiMinute = uiMinute;
      shouldRender = true;
    }
    if (shouldRender) renderPage();
  }

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((error) => {
        console.error("Offline app setup failed:", error);
      });
    });
  }

  render();
  window.setInterval(runAutomationTick, 1000);
  window.addEventListener("online", () => {
    if (connectionState === "disconnected" && ["AUTO", "CLOUD"].includes(state.settings.mode) && state.settings.mqttPrefix.trim()) connect();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && connectionState === "disconnected" && ["AUTO", "CLOUD"].includes(state.settings.mode) && state.settings.mqttPrefix.trim()) connect();
  });
  window.setTimeout(() => {
    if (state.settings.mode === "BLUETOOTH") showToast("Bluetooth SPP requires the Android app.");
    else connect();
  }, 0);
})();
