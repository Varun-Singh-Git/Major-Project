const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const DEFAULT_RUBRICS = [["Concept coverage", 40], ["Semantic accuracy", 30], ["Completeness", 20], ["Clarity", 10]];
const COLORS = ["#2f7fd8", "#2f9e56", "#e08a1e", "#7a4fd0", "#d6404f", "#16a3b8", "#8a6d3b", "#c2559c"];
const DEFAULT_MARKS = 5;
let keyArr = [], stuArr = [], jobs = [], files = {}, currentId = null, poll = null, tab = "ai";

/* ---------- helpers ---------- */
function toast(text, kind = "") {
  const t = document.createElement("div"); t.className = "toast " + kind; t.textContent = text;
  $("#toasts").append(t); setTimeout(() => t.remove(), kind === "err" ? 7000 : 4000);
}
async function api(url, opts) {
  let r; try { r = await fetch(url, opts); } catch { throw new Error("Cannot reach the backend. Is python backend/app.py running?"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Request failed (" + r.status + ")");
  return d;
}
const postJSON = (u, b) => api(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const pctColor = p => p >= .7 ? "var(--ok)" : p >= .4 ? "var(--warn)" : "var(--bad)";
const size = b => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const ring = (v, m) => { const p = m ? v / m : 0, C = 163.4; return `<div class="ring" role="img" aria-label="${v} of ${m}"><svg viewBox="0 0 62 62" width="62" height="62"><circle class="bg" cx="31" cy="31" r="26"/><circle class="fg" cx="31" cy="31" r="26" stroke="${pctColor(p)}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - Math.min(p, 1))}"/></svg><span>${Math.round(p * 100)}%</span></div>`; };

/* theme */
const root = document.documentElement;
try { root.dataset.theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"); } catch { }
$("#theme").onclick = () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("theme", root.dataset.theme); } catch { } };

/* status pills */
async function loadStatus() {
  try {
    const s = await api("/api/status");
    $("#chips").innerHTML = `<span class="pill ${s.ocr ? "ok" : ""}" id="ocrPill" title="${esc(s.ocr_detail)}" ${s.ocr ? "" : 'role="button" tabindex="0" style="cursor:pointer"'}>Tesseract OCR ${s.ocr ? "ready" : "not found (click for why)"}</span><span class="pill ${s.llm ? "ok" : ""}">${esc(s.model)} ${s.llm ? "ready" : "not available"}</span>`;
  } catch (e) { $("#chips").innerHTML = `<span class="pill">Backend offline</span>`; }
  const pl = $("#ocrPill"); if (pl && !pl.classList.contains("ok")) { const d = pl.title; pl.onclick = () => toast(d, "err"); if (!window.ocrWarned) { window.ocrWarned = 1; toast("OCR: " + d, "err"); } }
}

/* ---------- stepper ---------- */
function updateStepper() {
  const cur = jobs.find(j => j.job_id === currentId);
  const done = [keyArr.length > 0, stuArr.length > 0, !!cur,
    cur && cur.status === "Completed", jobs.some(j => j.faculty_marks)];
  let active = done.findIndex(d => !d);
  $$("#stepper li").forEach((li, i) => { li.classList.toggle("done", done[i]); li.classList.toggle("active", i === active); });
}

/* ---------- uploaders ---------- */
function setupUploader(el) {
  const p = el.dataset.p;
  el.innerHTML = `<label class="drop" tabindex="0"><input type="file" accept="application/pdf,image/*" hidden>
    <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><path d="M24 32V10m0 0l-8 8m8-8l8 8M10 34v4h28v-4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <b>Drag &amp; drop PDF here</b><em>or click to browse &middot; up to 20 pages &middot; max 10 MB</em></label>
    <div class="fchip" hidden><div class="ic">PDF</div><div class="nm"><div></div><small></small></div><button type="button" aria-label="Remove file">Remove</button></div>
    <div class="actions"><button class="go" disabled><span class="btxt">Extract &amp; split</span></button><button class="ghost resplit" type="button">Re-split text</button></div>
    <details class="ext"><summary>View / edit extracted text</summary><textarea rows="7" aria-label="Extracted text" placeholder="Extracted text appears here. You can also paste text and press Re-split."></textarea></details>
    <p class="note" role="status"></p>`;
  const drop = $(".drop", el), input = $("input", el), chip = $(".fchip", el), go = $(".go", el), note = $(".note", el), ta = $("textarea", el);
  const say = (t, k = "") => { note.textContent = t; note.className = "note " + k; };
  const pick = f => {
    if (!f) return;
    if (!(f.type === "application/pdf" || /\.pdf$/i.test(f.name) || f.type.startsWith("image/"))) return say("Please choose a PDF file.", "err");
    if (f.size > 10 * 1048576) return say("File is larger than 10 MB.", "err");
    files[p] = f; drop.hidden = true; chip.hidden = false; $(".nm div", chip).textContent = f.name; $("small", chip).textContent = size(f.size);
    go.disabled = false; say("");
  };
  input.onchange = e => pick(e.target.files[0]);
  drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
  ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => pick(e.dataTransfer.files[0]));
  $("button", chip).onclick = () => { delete files[p]; input.value = ""; drop.hidden = false; chip.hidden = true; go.disabled = true; say(""); };

  const split = async () => {
    syncQuestions();
    try {
      const d = await postJSON("/api/split", { text: ta.value });
      p === "k" ? keyArr = d.items : stuArr = d.items;
      say(`Found ${d.items.length} question(s): ${d.items.map(i => "Q" + i.no).join(", ")}`, "ok");
      renderQuestions(); updateStepper();
    } catch (e) { say(e.message, "err"); toast(e.message, "err"); }
  };
  $(".resplit", el).onclick = split;
  go.onclick = async () => {
    const fd = new FormData(); fd.append("file", files[p]);
    go.disabled = true; $(".btxt", go).innerHTML = '<span class="spin"></span>Reading...'; say("Reading the file. Scanned pages can take a minute.");
    try {
      const d = await api("/api/ocr", { method: "POST", body: fd });
      ta.value = d.text; $("details", el).open = true;
      if (!d.text.trim()) { say("No text found. Try a sharper scan.", "err"); toast("No text found in the file.", "err"); }
      else { toast(`${d.pages} page(s) read via ${d.method}`, "ok"); await split(); }
    } catch (e) { say(e.message, "err"); toast(e.message, "err"); }
    $(".btxt", go).textContent = "Extract & split"; go.disabled = false;
  };
}
$$(".uploader").forEach(setupUploader);

/* ---------- review cards ---------- */
function syncQuestions() {
  $$("#qlist .q").forEach(c => {
    const no = +c.dataset.no, kt = $(".kt", c).value, sa = $(".sa", c).value, mk = $(".mk", c).value;
    const k = keyArr.find(i => i.no === no), s = stuArr.find(i => i.no === no);
    if (k) { k.text = kt; k.marks = mk; } else if (kt.trim()) keyArr.push({ no, text: kt, marks: mk });
    if (s) s.text = sa; else if (sa.trim()) stuArr.push({ no, text: sa });
  });
}
function matchedCount() { return keyArr.filter(k => k.text.trim() && stuArr.some(s => s.no === k.no && s.text.trim())).length; }
function flag(c) {
  const k = $(".kt", c).value.trim(), s = $(".sa", c).value.trim(), b = $(".badge", c);
  [b.textContent, b.className] = !k ? ["Not in answer key (ignored)", "badge bad"] : !s ? ["No student answer: scores 0", "badge warn"] : ["Matched", "badge ok"];
}
function updateSummary() {
  const cards = $$("#qlist .q"), keyed = cards.filter(c => $(".kt", c).value.trim());
  const matched = keyed.filter(c => $(".sa", c).value.trim()).length;
  const total = keyed.reduce((a, c) => a + (+$(".mk", c).value || 0), 0);
  $("#summary").innerHTML = [[keyed.length, "Questions graded"], [matched, "Matched with answers"], [keyed.length - matched, "Unanswered"], [total, "Total marks"]]
    .map(([v, l]) => `<div class="sbox"><b>${v}</b><span>${l}</span></div>`).join("");
}
function renderQuestions() {
  const nos = [...new Set([...keyArr, ...stuArr].map(i => i.no))].sort((a, b) => a - b);
  if (!nos.length) return;
  $("#summary").hidden = false;
  $("#qlist").innerHTML = nos.map((no, n) => {
    const k = keyArr.find(i => i.no === no), s = stuArr.find(i => i.no === no);
    return `<article class="q" data-no="${no}" style="animation-delay:${n * 50}ms"><div class="qh"><h3>Question ${no}</h3><span class="badge"></span>
      <label class="mkl">Marks <input class="mk" type="number" min="0.5" step="0.5" value="${k ? (k.marks || DEFAULT_MARKS) : DEFAULT_MARKS}" aria-label="Marks for question ${no}"></label></div>
      <div class="pair"><label>Teacher: question + model answer<textarea class="kt" rows="4">${esc(k ? k.text : "")}</textarea></label>
      <label>Student answer<textarea class="sa" rows="4">${esc(s ? s.text : "")}</textarea></label></div></article>`;
  }).join("");
  $$("#qlist .q").forEach(c => { flag(c); c.addEventListener("input", () => { flag(c); updateSummary(); }); });
  updateSummary();
  if (keyArr.some(i => i.marks == null)) toast(`Some questions had no "(N marks)" label, so they default to ${DEFAULT_MARKS}. Adjust below.`);
}

/* ---------- rubrics ---------- */
function addRubric(name = "", w = 10) {
  const d = document.createElement("div"); d.className = "rub";
  d.innerHTML = `<span class="dot"></span><input aria-label="Rubric name" placeholder="Criterion" value="${esc(name)}"><input aria-label="Weight percent" type="number" min="1" max="100" value="${w}"><button type="button" aria-label="Remove rubric">x</button>`;
  d.querySelector("button").onclick = () => { d.remove(); sumW(); };
  d.addEventListener("input", sumW); $("#rubrics").append(d); sumW();
}
function sumW() {
  const rows = $$(".rub"); let t = 0;
  rows.forEach((r, i) => { r.querySelector(".dot").style.background = COLORS[i % COLORS.length]; t += +r.querySelectorAll("input")[1].value || 0; });
  $("#wbar").innerHTML = rows.map((r, i) => `<i style="width:${Math.min(+r.querySelectorAll("input")[1].value || 0, 100)}%;background:${COLORS[i % COLORS.length]}"></i>`).join("");
  $("#wsum").textContent = `Total weight: ${t}${t === 100 ? " \u2713" : " (must be 100)"}`; $("#wsum").className = "hint" + (t === 100 ? "" : " bad");
}
DEFAULT_RUBRICS.forEach(r => addRubric(...r)); $("#addR").onclick = () => addRubric();

/* ---------- evaluate ---------- */
$("#evalBtn").onclick = async () => {
  syncQuestions();
  const btn = $("#evalBtn"), rubrics = $$(".rub").map(r => { const i = r.querySelectorAll("input"); return { name: i[0].value, weight: i[1].value }; });
  btn.disabled = true; $(".btxt", btn).innerHTML = '<span class="spin"></span>Sending...';
  try {
    const d = await postJSON("/api/evaluate", { student_id: $("#sid").value, key_items: keyArr, student_items: stuArr, rubrics });
    toast("Job accepted (202): " + d.job_id, "ok"); currentId = d.job_id; startPolling();
  } catch (e) { toast(e.message, "err"); }
  $(".btxt", btn).textContent = "Send to local LLM"; btn.disabled = false;
};

/* ---------- polling, tracker, results ---------- */
function startPolling() { clearInterval(poll); refresh(); poll = setInterval(refresh, 3000); }
async function refresh() {
  try { jobs = await api("/api/jobs"); } catch { return; }
  const was = $("#tracker").dataset.status, cur = jobs.find(j => j.job_id === currentId);
  renderTracker(cur);
  if (cur && was === "Processing" && cur.status !== "Processing") toast(cur.status === "Completed" ? `Grading finished: ${cur.ai_total}/${cur.max_total}` : "Grading failed: " + cur.error, cur.status === "Completed" ? "ok" : "err");
  if (!jobs.some(j => j.status === "Processing")) clearInterval(poll);
  if (!(tab === "fac" && document.activeElement && document.activeElement.closest("#sheet"))) renderResults();
  updateStepper();
}
function renderTracker(j) {
  const t = $("#tracker"); if (!j) return;
  t.dataset.status = j.status;
  const done = j.items.filter(i => i.ai_scores).length, pct = Math.round(done / j.items.length * 100);
  t.innerHTML = `<h4>Student ${esc(j.student_id)} <span class="badge ${j.status}">${j.status === "Processing" ? '<span class="spin"></span> ' : ""}${j.status}</span></h4>
    <div class="hint">Job <code>${j.job_id}</code></div><div class="pbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <div class="dots">${j.items.map(i => `<span class="${i.ai_scores ? "d" : ""}">Q${i.no}</span>`).join("")}</div>
    ${j.status === "Processing" && j.current ? `<p class="note" id="elapsed" data-s="${j.current.started}">Scoring Q${j.current.no}... <span></span></p>` : ""}
    <div>${done}/${j.items.length} questions scored${j.status === "Completed" ? ` &middot; <b>${j.ai_total}/${j.max_total}</b>` : ""}</div>` +
    (j.error ? `<p class="note err">${esc(j.error)}</p><button onclick="retry('${j.job_id}')">Retry remaining</button>` : "");
}
setInterval(() => { const e = $("#elapsed"); if (e) $("span", e).textContent = Math.max(0, Math.round(Date.now() / 1000 - e.dataset.s)) + "s elapsed (CPU-only laptops can take 1-3 min per question)"; }, 1000);
async function retry(id) { try { await api("/api/retry/" + id, { method: "POST" }); currentId = id; startPolling(); } catch (e) { toast(e.message, "err"); } }

function renderResults() {
  const ok = jobs.filter(j => j.status === "Completed");
  const avg = ok.length ? Math.round(ok.reduce((a, j) => a + j.ai_total / j.max_total, 0) / ok.length * 100) : null;
  $("#stats").innerHTML = [[jobs.length, "Submissions"], [ok.length, "Graded by AI"], [avg == null ? "-" : avg + "%", "Average AI score"], [jobs.filter(j => j.faculty_marks).length, "Faculty reviewed"]]
    .map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  const el = $("#sheet");
  if (tab === "acc") return renderAccuracy(el);
  if (!jobs.length) return el.innerHTML = '<div class="empty"><p>No results yet. Complete steps 1 to 4 to grade a student.</p></div>';
  if (tab === "ai") el.innerHTML = jobs.map(j => `<div class="rc"><div class="rch">${ring(j.ai_total || 0, j.max_total)}<div class="who"><b>${esc(j.student_id)}</b><br><code>${j.job_id}</code></div><span class="badge ${j.status}">${j.status}</span><b>${j.status === "Completed" ? j.ai_total + " / " + j.max_total : ""}</b></div>` +
    j.items.map(i => { const p = i.ai_scores ? i.ai_total / i.marks : 0; return `<div class="qb"><span>Q${i.no}</span><div class="bar"><i style="width:${p * 100}%;background:${pctColor(p)}"></i></div><em>${i.ai_scores ? i.ai_total : "-"} / ${i.marks}</em></div>`; }).join("") + "</div>").join("");
  else if (tab === "just") el.innerHTML = jobs.filter(j => j.items.some(i => i.ai_scores)).map(j => `<div class="rc"><div class="rch"><div class="who"><b>${esc(j.student_id)}</b><br><code>${j.job_id}</code></div></div>` +
    j.items.filter(i => i.ai_scores).map(i => `<details><summary><b>Q${i.no}</b><span>${i.ai_total} / ${i.marks}</span></summary>` +
      i.rubrics.map(r => `<div class="cr"><b>${esc(r.name)}<span class="s">${i.ai_scores[r.name]} / ${r.max}</span></b><div>${esc((i.justifications || {})[r.name]) || "-"}</div></div>`).join("") +
      (i.components ? `<p class="sumtxt">Fusion: ${[["LLM rubric", "llm"], ["Concept coverage", "coverage"], ["Semantic similarity", "semantic"]].map(([l, k]) => i.components[k] == null ? `${l}: n/a` : `${l}: ${Math.round(i.components[k] * 100)}%`).join(" &middot; ")} (LLM-only marks: ${i.llm_total})</p>` : "") +
      (i.summary ? `<p class="sumtxt">${esc(i.summary)}</p>` : "") + "</details>").join("") + "</div>").join("") || '<div class="empty"><p>Justifications appear as questions are scored.</p></div>';
  else el.innerHTML = ok.map(j => { const ft = j.faculty_total, d = ft != null ? +(ft - j.ai_total).toFixed(2) : null;
    return `<div class="rc"><div class="rch"><div class="who"><b>${esc(j.student_id)}</b><br><code>${j.job_id}</code></div><span>AI <b>${j.ai_total}/${j.max_total}</b></span>` +
      (ft != null ? `<span>Faculty <b>${ft}/${j.max_total}</b></span><span class="delta ${d >= 0 ? "pos" : "neg"}">${d >= 0 ? "+" : ""}${d} vs AI</span>` : '<span class="badge warn">Awaiting faculty marks</span>') + "</div>" +
      `<div class="fgrid">${j.items.map(i => `<div class="fq"><b>Q${i.no}</b> <small>AI gave ${i.ai_total} of ${i.marks}</small><input type="number" step="0.5" min="0" max="${i.marks}" data-j="${j.job_id}" data-n="${i.no}" aria-label="Faculty marks for Q${i.no}" value="${j.faculty_marks ? j.faculty_marks[i.no] : ""}"></div>`).join("")}</div>` +
      `<button onclick="saveFaculty('${j.job_id}')">Save faculty marks</button></div>`; }).join("") || '<div class="empty"><p>Faculty review opens once a job is completed.</p></div>';
}
async function renderAccuracy(el) {
  try {
    const d = await api("/api/metrics"), M = d.methods, f = (v, u = "") => v == null ? "-" : v + u;
    el.innerHTML = `<div class="rc"><p class="hint">Compares AI marks with <b>faculty marks</b> on ${d.n} reviewed question(s). Enter faculty marks in the previous tab to add data. Aim for 30+ questions before drawing conclusions.</p>` +
      (d.n ? `<div style="overflow-x:auto"><table class="mt"><tr><th>Method</th><th>Questions</th><th>Avg error (marks)</th><th>Avg error (%)</th><th>RMSE (%)</th><th>Within 10%</th><th>Pearson r</th><th>QWK</th></tr>` +
        Object.entries(M).filter(([, m]) => m).map(([k, m]) => `<tr><td><b>${k}</b></td><td>${m.n}</td><td>${m.mae_marks}</td><td>${m.mae_pct}%</td><td>${m.rmse_pct}%</td><td>${m.within10_pct}%</td><td>${f(m.pearson)}</td><td>${f(m.qwk)}</td></tr>`).join("") + "</table></div>" +
        '<p class="hint">Lower error is better. Pearson and QWK (quadratic weighted kappa) closer to 1 mean better agreement with the teacher.</p>' : '<div class="empty"><p>No faculty-reviewed questions yet.</p></div>') + "</div>";
  } catch (e) { el.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; }
}
async function saveFaculty(id) {
  const marks = {}; $$(`input[data-j="${id}"]`).forEach(i => marks[i.dataset.n] = i.value);
  try { await postJSON("/api/faculty/" + id, { marks }); toast("Faculty marks saved", "ok"); document.activeElement.blur(); await refresh(); }
  catch (e) { toast(e.message, "err"); }
}
$$("[role=tab]").forEach(b => b.onclick = () => { tab = b.dataset.t; $$("[role=tab]").forEach(x => x.setAttribute("aria-selected", x === b)); renderResults(); });
loadStatus(); refresh(); setInterval(loadStatus, 30000);
