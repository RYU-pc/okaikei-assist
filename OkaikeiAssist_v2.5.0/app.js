"use strict";

const $ = (id) => document.getElementById(id);

const STORAGE_KEYS = {
  settings: "okaikeiAssistSettingsV2",
  history: "okaikeiAssistHistoryV2"
};

const DEFAULT_SETTINGS = {
  unit: 100,
  method: "nearest",
  darkMode: false,
  sound: true,
  vibration: true
};

let settings = loadSettings();
let historyItems = loadHistory();
let currentMode = "adjust";
let lastAdjustResult = null;
let lastReverseResult = null;
let toastTimer = null;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.history));
    return Array.isArray(saved) ? saved.slice(0, 30) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  historyItems = historyItems.slice(0, 30);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(historyItems));
  renderHistory();
}

function yen(value) {
  return "￥" + Math.max(0, Math.floor(Number(value) || 0)).toLocaleString("ja-JP");
}

// 入力欄のカンマを除去して数値にする。
function parseAmount(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return digits === "" ? NaN : Number(digits);
}

// 入力中も3桁ごとにカンマを表示する。
function formatAmountInput(input) {
  const raw = String(input.value).replace(/[^0-9]/g, "");
  const normalized = raw.replace(/^0+(?=\d)/, "");
  input.value = normalized ? Number(normalized).toLocaleString("ja-JP") : "";
}

function getPositiveInteger(input, label, allowZero = false) {
  if (input.value.trim() === "") {
    showToast(`${label}を入力してください。`);
    input.focus();
    return null;
  }

  const value = parseAmount(input.value);

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    showToast(`${label}は整数で入力してください。`);
    input.focus();
    return null;
  }

  if (allowZero ? value < 0 : value <= 0) {
    showToast(`${label}を正しく入力してください。`);
    input.focus();
    return null;
  }

  return value;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}

function playFeedback() {
  if (settings.vibration && "vibrate" in navigator) {
    navigator.vibrate(70);
  }

  if (!settings.sound) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();

    // やわらかく上昇する2音のチャイム。音の立ち上がりと余韻を滑らかにする。
    const playNote = (frequency, startAt, duration = 0.48) => {
      const noteGain = context.createGain();
      noteGain.gain.setValueAtTime(0.0001, startAt);
      noteGain.gain.exponentialRampToValueAtTime(0.075, startAt + 0.025);
      noteGain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      noteGain.connect(context.destination);

      const fundamental = context.createOscillator();
      fundamental.type = "sine";
      fundamental.frequency.setValueAtTime(frequency, startAt);
      fundamental.connect(noteGain);
      fundamental.start(startAt);
      fundamental.stop(startAt + duration + 0.02);

      // ごく控えめな倍音を重ね、単純な電子音になりすぎない響きにする。
      const overtoneGain = context.createGain();
      overtoneGain.gain.setValueAtTime(0.0001, startAt);
      overtoneGain.gain.exponentialRampToValueAtTime(0.012, startAt + 0.025);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration * 0.72);
      overtoneGain.connect(context.destination);

      const overtone = context.createOscillator();
      overtone.type = "sine";
      overtone.frequency.setValueAtTime(frequency * 2.01, startAt);
      overtone.connect(overtoneGain);
      overtone.start(startAt);
      overtone.stop(startAt + duration);
    };

    // ほんの少し間を空けた、C5 → E5 のやさしい2音。
    const startAt = context.currentTime + 0.03;
    playNote(523.25, startAt, 0.52);
    playNote(659.25, startAt + 0.16, 0.62);

    // iPhoneなどでAudioContextが一時停止状態の場合も、操作直後に再生できるようにする。
    if (context.state === "suspended") {
      context.resume().catch(() => {});
    }

    window.setTimeout(() => {
      if (context.state !== "closed") context.close().catch(() => {});
    }, 1100);
  } catch {
    // 音声に対応していない環境では何もしません。
  }
}

function addHistory(item) {
  historyItems.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...item
  });

  saveHistory();
}

function calculateRoundedAmount(amount, unit, method) {
  let rounded;

  if (method === "up") {
    rounded = Math.ceil(amount / unit) * unit;
  } else if (method === "down") {
    rounded = Math.floor(amount / unit) * unit;
  } else {
    rounded = Math.round(amount / unit) * unit;
  }

  return rounded;
}

function methodName(method) {
  return {
    up: "切り上げ",
    nearest: "四捨五入",
    down: "切り下げ"
  }[method] || "四捨五入";
}

function calculateAdjust() {
  const amount = getPositiveInteger($("invoiceAmount"), "お会計金額");
  if (amount === null) return;

  const unit = Number(settings.unit);
  const rounded = calculateRoundedAmount(amount, unit, settings.method);

  // お会計金額を下回る金額では支払えないため、元の金額を下限にする。
  const payAmount = Math.max(amount, rounded);
  const change = payAmount - amount;
  const wasLimited = rounded < amount;

  lastAdjustResult = {
    type: "adjust",
    invoice: amount,
    unit,
    method: settings.method,
    rounded,
    payAmount,
    change,
    wasLimited
  };

  $("adjustedAmount").textContent = yen(payAmount);
  $("originalAmount").textContent = yen(amount);
  $("adjustChange").textContent = yen(change);

  const note = $("adjustNote");
  note.classList.toggle("warning", wasLimited);

  if (wasLimited) {
    note.textContent =
      `${unit.toLocaleString("ja-JP")}円単位の${methodName(settings.method)}では` +
      `${yen(rounded)}になりますが、お会計金額を下回るため、` +
      `${yen(amount)}を支払い金額として表示しています。`;
  } else {
    note.textContent =
      `${unit.toLocaleString("ja-JP")}円単位で${methodName(settings.method)}しました。`;
  }

  $("adjustResult").hidden = false;

  addHistory({
    ...lastAdjustResult
  });

  playFeedback();
}

function calculateReverse() {
  const invoice = getPositiveInteger($("reverseInvoice"), "お会計金額");
  if (invoice === null) return;

  const tender = getPositiveInteger($("tenderAmount"), "渡す金額", true);
  if (tender === null) return;

  const change = Math.max(0, tender - invoice);
  const shortage = Math.max(0, invoice - tender);

  lastReverseResult = {
    type: "reverse",
    invoice,
    tender,
    change,
    shortage
  };

  $("reverseInvoiceText").textContent = yen(invoice);
  $("reverseTenderText").textContent = yen(tender);

  const label = $("reverseResultLabel");
  const amount = $("reverseResultAmount");
  const note = $("reverseNote");

  if (shortage > 0) {
    label.textContent = "不足している金額";
    amount.textContent = yen(shortage);
    amount.style.color = "var(--warning)";
    note.textContent = "渡す金額がお会計金額に足りません。";
    note.classList.add("warning");
  } else {
    label.textContent = "お釣り";
    amount.textContent = yen(change);
    amount.style.color = "var(--success)";
    note.textContent = change === 0
      ? "ちょうどの金額です。"
      : "お釣りの金額です。";
    note.classList.remove("warning");
  }

  $("reverseResult").hidden = false;

  addHistory({
    ...lastReverseResult
  });

  playFeedback();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const succeeded = document.execCommand("copy");
      textarea.remove();

      if (!succeeded) throw new Error("copy failed");
    }

    showToast("結果をコピーしました。");
  } catch {
    showToast("コピーできませんでした。");
  }
}

function copyAdjustResult() {
  if (!lastAdjustResult) return;

  const r = lastAdjustResult;
  const text = [
    "お会計アシスト",
    `元のお会計金額：${yen(r.invoice)}`,
    `おすすめのお支払い金額：${yen(r.payAmount)}`,
    `お釣り：${yen(r.change)}`,
    `調整方法：${r.unit}円単位・${methodName(r.method)}`
  ].join("\n");

  copyText(text);
}

function copyReverseResult() {
  if (!lastReverseResult) return;

  const r = lastReverseResult;
  const text = [
    "お会計アシスト",
    `お会計金額：${yen(r.invoice)}`,
    `渡す金額：${yen(r.tender)}`,
    r.shortage > 0
      ? `不足金額：${yen(r.shortage)}`
      : `お釣り：${yen(r.change)}`
  ].join("\n");

  copyText(text);
}

function setMode(mode) {
  currentMode = mode;

  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  $("adjustSection").hidden = mode !== "adjust";
  $("reverseSection").hidden = mode !== "reverse";
}

function renderHistory() {
  const list = $("historyList");
  list.replaceChildren();

  if (historyItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "まだ履歴はありません。";
    list.appendChild(empty);
    return;
  }

  historyItems.forEach((item) => {
    const article = document.createElement("article");
    article.className = "history-item";

    const top = document.createElement("div");
    top.className = "history-item-top";

    const type = document.createElement("span");
    type.className = "history-type";
    type.textContent = item.type === "adjust" ? "端数調整" : "お釣り逆算";

    const date = document.createElement("span");
    date.className = "history-date";
    const parsedDate = new Date(item.createdAt);
    date.textContent = Number.isNaN(parsedDate.getTime())
      ? ""
      : parsedDate.toLocaleString("ja-JP");

    top.append(type, date);

    const main = document.createElement("div");
    main.className = "history-main";

    const sub = document.createElement("div");
    sub.className = "history-sub";

    if (item.type === "adjust") {
      main.textContent = `支払い ${yen(item.payAmount)}`;
      sub.textContent =
        `会計 ${yen(item.invoice)} ／ お釣り ${yen(item.change)} ／ ` +
        `${item.unit}円・${methodName(item.method)}`;
    } else {
      main.textContent = item.shortage > 0
        ? `不足 ${yen(item.shortage)}`
        : `お釣り ${yen(item.change)}`;
      sub.textContent =
        `会計 ${yen(item.invoice)} ／ 渡す金額 ${yen(item.tender)}`;
    }

    const actions = document.createElement("div");
    actions.className = "history-actions";

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.textContent = "この内容で再計算";
    restoreButton.addEventListener("click", () => restoreHistory(item.id));

    actions.appendChild(restoreButton);
    article.append(top, main, sub, actions);
    list.appendChild(article);
  });
}

function restoreHistory(id) {
  const item = historyItems.find((entry) => entry.id === id);
  if (!item) return;

  if (item.type === "adjust") {
    setMode("adjust");
    $("invoiceAmount").value = item.invoice;

    settings.unit = item.unit;
    settings.method = item.method;
    syncSettingsUI();
    saveSettings();

    calculateAdjust();
  } else {
    setMode("reverse");
    $("reverseInvoice").value = item.invoice;
    $("tenderAmount").value = item.tender;
    calculateReverse();
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateMethodExample() {
  const unit = Number(settings.unit);
  const sample = unit * 2 - Math.max(1, Math.floor(unit * 0.17));
  const lower = Math.floor(sample / unit) * unit;
  const upper = Math.ceil(sample / unit) * unit;

  $("methodExampleInline").textContent =
    `選択中：${unit.toLocaleString("ja-JP")}円単位・${methodName(settings.method)}。` +
    `例：${yen(sample)}の場合、切り上げは${yen(upper)}、切り下げは${yen(lower)}です。`;
}

function syncSettingsUI() {
  $("unitSelect").value = String(settings.unit);
  $("methodSelect").value = settings.method;
  $("darkModeToggle").checked = settings.darkMode;
  $("soundToggle").checked = settings.sound;
  $("vibrationToggle").checked = settings.vibration;

  document.documentElement.dataset.theme = settings.darkMode ? "dark" : "light";
  updateMethodExample();
}

function openSettings() {
  syncSettingsUI();
  $("settingsDialog").showModal();
}

function setupKeypad() {
  document.querySelectorAll("[data-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $("invoiceAmount");
      const key = button.dataset.key;

      const current = String(input.value).replace(/[^0-9]/g, "");
      if (key === "clear") {
        input.value = "";
      } else if (key === "backspace") {
        input.value = current.slice(0, -1);
      } else {
        input.value = `${current}${key}`;
      }
      formatAmountInput(input);
      input.focus();
    });
  });
}

function setupQuickButtons() {
  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $("invoiceAmount");
      const current = parseAmount(input.value);
      input.value = String((Number.isFinite(current) ? current : 0) + Number(button.dataset.add));
      formatAmountInput(input);
      input.focus();
    });
  });
}

function setupEvents() {
  [$("invoiceAmount"), $("reverseInvoice"), $("tenderAmount")].forEach((input) => {
    input.addEventListener("input", () => formatAmountInput(input));
  });

  $("calculateAdjust").addEventListener("click", calculateAdjust);
  $("calculateReverse").addEventListener("click", calculateReverse);

  $("copyAdjust").addEventListener("click", copyAdjustResult);
  $("copyReverse").addEventListener("click", copyReverseResult);

  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  $("settingsButton").addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", () => $("settingsDialog").close());

  $("helpButton").addEventListener("click", () => $("helpDialog").showModal());
  $("closeHelp").addEventListener("click", () => $("helpDialog").close());

  $("unitSelect").addEventListener("change", (event) => {
    settings.unit = Number(event.target.value);
    updateMethodExample();
    saveSettings();
  });

  $("methodSelect").addEventListener("change", (event) => {
    settings.method = event.target.value;
    saveSettings();
  });

  $("darkModeToggle").addEventListener("change", (event) => {
    settings.darkMode = event.target.checked;
    syncSettingsUI();
    saveSettings();
  });

  $("soundToggle").addEventListener("change", (event) => {
    settings.sound = event.target.checked;
    saveSettings();
  });

  $("vibrationToggle").addEventListener("change", (event) => {
    settings.vibration = event.target.checked;
    saveSettings();
  });

  $("clearHistory").addEventListener("click", () => {
    if (historyItems.length === 0) {
      showToast("削除する履歴はありません。");
      return;
    }

    if (!window.confirm("計算履歴をすべて削除しますか？")) return;

    historyItems = [];
    saveHistory();
    showToast("履歴を削除しました。");
  });

  $("invoiceAmount").addEventListener("keydown", (event) => {
    if (event.key === "Enter") calculateAdjust();
  });

  $("reverseInvoice").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("tenderAmount").focus();
  });

  $("tenderAmount").addEventListener("keydown", (event) => {
    if (event.key === "Enter") calculateReverse();
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch (error) {
    console.error("Service Worker registration failed:", error);
  }
}

function init() {
  syncSettingsUI();
  renderHistory();
  setupEvents();
  setupKeypad();
  setupQuickButtons();
  registerServiceWorker();
}

init();