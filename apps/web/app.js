const elements = {
  apiKey: document.querySelector("#api-key"),
  cancelJob: document.querySelector("#cancel-job"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  detailId: document.querySelector("#detail-id"),
  detailInstruction: document.querySelector("#detail-instruction"),
  detailStarted: document.querySelector("#detail-started"),
  detailStatus: document.querySelector("#detail-status"),
  detailUrl: document.querySelector("#detail-url"),
  eventList: document.querySelector("#event-list"),
  eventsEmpty: document.querySelector("#events-empty"),
  inspectorContent: document.querySelector("#inspector-content"),
  inspectorEmpty: document.querySelector("#inspector-empty"),
  instruction: document.querySelector("#instruction"),
  jobError: document.querySelector("#job-error"),
  jobForm: document.querySelector("#job-form"),
  jobList: document.querySelector("#job-list"),
  jobOutput: document.querySelector("#job-output"),
  jobsEmpty: document.querySelector("#jobs-empty"),
  message: document.querySelector("#message"),
  outputEmpty: document.querySelector("#output-empty"),
  receiptList: document.querySelector("#receipt-list"),
  receiptsEmpty: document.querySelector("#receipts-empty"),
  refreshJobs: document.querySelector("#refresh-jobs"),
  submitJob: document.querySelector("#submit-job"),
  targetUrl: document.querySelector("#target-url"),
};

let selectedId = null;
let refreshTimer = null;
let activeTab = "progress";
const terminalStatuses = new Set(["completed", "failed", "cancelled", "indeterminate"]);

function setMessage(message, isError = false) {
  elements.message.textContent = message;
  elements.message.classList.toggle("error", isError);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const key = elements.apiKey.value.trim();
  if (key) headers.set("Authorization", `Bearer ${key}`);

  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      payload?.error?.message ??
      (typeof payload?.error === "string" ? payload.error : null) ??
      payload?.message ??
      response.statusText;
    throw new Error(`${response.status}: ${detail}`);
  }
  return payload;
}

function statusClass(status) {
  return `status status-${String(status ?? "unknown").replace(/[^a-z_]/g, "")}`;
}

function displayStatus(status) {
  return String(status ?? "unknown").replaceAll("_", " ");
}

function displayTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatJSON(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderJobs(jobs) {
  elements.jobList.replaceChildren();
  elements.jobsEmpty.hidden = jobs.length > 0;
  for (const job of jobs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-item";
    button.classList.toggle("selected", job.id === selectedId);
    button.setAttribute("aria-current", job.id === selectedId ? "true" : "false");

    const top = document.createElement("span");
    top.className = "job-item-top";
    const title = document.createElement("strong");
    title.textContent = job.instruction || "Untitled job";
    const badge = document.createElement("span");
    badge.className = statusClass(job.status);
    badge.textContent = displayStatus(job.status);
    top.append(title, badge);

    const meta = document.createElement("span");
    meta.className = "job-item-meta";
    meta.textContent = `${displayTime(job.createdAt)} · ${job.id}`;
    button.append(top, meta);
    button.addEventListener("click", () => selectJob(job.id));
    item.append(button);
    elements.jobList.append(item);
  }
}

function renderJob(job) {
  elements.inspectorEmpty.hidden = true;
  elements.inspectorContent.hidden = false;
  elements.detailId.textContent = job.id;
  elements.detailInstruction.textContent = job.instruction;
  elements.detailStatus.textContent = displayStatus(job.status);
  elements.detailStatus.className = statusClass(job.status);
  elements.detailStarted.textContent = displayTime(job.startedAt ?? job.createdAt);
  const url = safeHttpUrl(job.url);
  elements.detailUrl.textContent = url ?? String(job.url ?? "");
  if (url) elements.detailUrl.href = url;
  else elements.detailUrl.removeAttribute("href");
  elements.cancelJob.hidden = !["queued", "running"].includes(job.status);

  const hasResult = job.result !== null && job.result !== undefined;
  elements.jobOutput.hidden = !hasResult;
  elements.jobOutput.textContent = hasResult ? formatJSON(job.result) : "";
  elements.jobError.hidden = !job.error;
  elements.jobError.textContent = job.error ? formatJSON(job.error) : "";
  elements.outputEmpty.hidden = hasResult || Boolean(job.error);
}

function renderEvents(events) {
  elements.eventList.replaceChildren();
  elements.eventsEmpty.hidden = events.length > 0;
  for (const event of events) {
    const item = document.createElement("li");
    const heading = document.createElement("div");
    heading.className = "event-heading";
    const type = document.createElement("strong");
    type.textContent = String(event.type ?? "event").replaceAll("_", " ");
    const time = document.createElement("time");
    time.textContent = displayTime(event.at);
    if (event.at) time.dateTime = event.at;
    heading.append(type, time);
    item.append(heading);
    if (event.data !== undefined && event.data !== null) {
      const detail = document.createElement("pre");
      detail.textContent = formatJSON(event.data);
      item.append(detail);
    }
    elements.eventList.append(item);
  }
}

function renderReceipts(receipts) {
  elements.receiptList.replaceChildren();
  elements.receiptsEmpty.hidden = receipts.length > 0;
  for (const receipt of receipts) {
    const item = document.createElement("li");
    const title = document.createElement("div");
    title.className = "receipt-heading";
    const name = document.createElement("strong");
    name.textContent = receipt.actionId ?? receipt.id ?? "Action receipt";
    const badge = document.createElement("span");
    badge.className = statusClass(receipt.verificationStatus ?? receipt.status);
    badge.textContent = displayStatus(receipt.verificationStatus ?? receipt.status);
    title.append(name, badge);
    const body = document.createElement("pre");
    body.textContent = formatJSON(receipt);
    item.append(title, body);
    elements.receiptList.append(item);
  }
}

async function refreshJobs() {
  const { jobs } = await request("/api/v1/jobs");
  renderJobs(Array.isArray(jobs) ? jobs : []);
}

async function refreshSelected() {
  if (!selectedId) return;
  const id = selectedId;
  const base = `/api/v1/jobs/${encodeURIComponent(id)}`;
  const [detail, events, receipts] = await Promise.all([
    request(base),
    request(`${base}/events`),
    request(`${base}/receipts`),
  ]);
  if (selectedId !== id) return;
  renderJob(detail.job);
  renderEvents(Array.isArray(events.events) ? events.events : []);
  renderReceipts(Array.isArray(receipts.receipts) ? receipts.receipts : []);
  if (terminalStatuses.has(detail.job.status)) await refreshJobs();
}

async function refreshAll() {
  try {
    await refreshJobs();
    await refreshSelected();
    setMessage("");
  } catch (error) {
    setMessage(`Could not load jobs: ${errorText(error)}`, true);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshAll();
    scheduleRefresh();
  }, 4000);
}

async function selectJob(id) {
  selectedId = id;
  await refreshAll();
}

function selectTab(tab) {
  activeTab = tab;
  for (const name of ["progress", "receipts", "output"]) {
    const selected = name === activeTab;
    const button = document.querySelector(`#tab-${name}`);
    const panel = document.querySelector(`#panel-${name}`);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

elements.jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = safeHttpUrl(elements.targetUrl.value.trim());
  const instruction = elements.instruction.value.trim();
  if (!url || !instruction) {
    setMessage("Enter an HTTP or HTTPS URL and an instruction.", true);
    return;
  }
  elements.submitJob.disabled = true;
  setMessage("Submitting job…");
  try {
    const { job } = await request("/api/v1/jobs", {
      method: "POST",
      body: JSON.stringify({ instruction, url }),
    });
    selectedId = job.id;
    elements.instruction.value = "";
    await refreshAll();
    setMessage(`Job ${job.id} submitted.`);
    selectTab("progress");
  } catch (error) {
    setMessage(`Could not submit job: ${errorText(error)}`, true);
  } finally {
    elements.submitJob.disabled = false;
  }
});

elements.cancelJob.addEventListener("click", async () => {
  if (!selectedId) return;
  elements.cancelJob.disabled = true;
  try {
    const { job } = await request(`/api/v1/jobs/${encodeURIComponent(selectedId)}/cancel`, {
      method: "POST",
    });
    renderJob(job);
    setMessage(`Cancellation requested for job ${job.id}.`);
    await refreshAll();
  } catch (error) {
    setMessage(`Could not cancel job: ${errorText(error)}`, true);
  } finally {
    elements.cancelJob.disabled = false;
  }
});

elements.refreshJobs.addEventListener("click", refreshAll);
elements.apiKey.addEventListener("change", refreshAll);
for (const name of ["progress", "receipts", "output"]) {
  document.querySelector(`#tab-${name}`).addEventListener("click", () => selectTab(name));
}

async function checkConnection() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    elements.connectionDot.classList.add("connected");
    elements.connectionLabel.textContent = "Local API connected";
  } catch {
    elements.connectionDot.classList.remove("connected");
    elements.connectionLabel.textContent = "API unavailable";
  }
}

await checkConnection();
await refreshAll();
scheduleRefresh();
