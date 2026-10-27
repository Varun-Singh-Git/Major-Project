const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ICONS = {
  check:'<path d="M20 6L9 17l-5-5"/>', home:'<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', plus:'<path d="M12 5v14M5 12h14"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', user:'<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/><path d="M17 11l2 2 4-4"/>',
  chart:'<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>', moon:'<path d="M21 13A9 9 0 1111 3a7 7 0 0010 10z"/>', panel:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/>',
  upload:'<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file:'<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>', copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
  gauge:'<path d="M4 18a9 9 0 1116 0"/><path d="M12 14l4-5"/>', sparkle:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  alert:'<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>', checkc:'<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>', x:'<path d="M6 6l12 12M18 6L6 18"/>'
};
const I = n => `<span data-i="${n}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ""}</svg></span>`;
const hydrate = (r = document) => $$("[data-i]:empty", r).forEach(e => e.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[e.dataset.i] || ""}</svg>`);
hydrate();

const DEFAULT_RUBRICS = [["Concept coverage", 40], ["Semantic accuracy", 30], ["Completeness", 20], ["Clarity", 10]];
const COLORS = ["#7c4dde", "#142a66", "#15803d", "#d97706", "#b91c1c", "#0891b2", "#8a6d3b", "#c2559c"];
const DEFAULT_MARKS = 5;
let jobs = [], status = {}, files = {}, keyArr = [], stuArr = [], openId = null, route = "dashboard", filter = "all", sig = "", drawerSig = "";

/* ---------- helpers ---------- */
function toast(t, k = "") { const e = document.createElement("div"); e.className = "toast " + k; e.textContent = t; $("#toasts").append(e); setTimeout(() => e.remove(), k === "err" ? 7000 : 4000); }
async function api(u, o) {
  let r; try { r = await fetch(u, o); } catch { throw new Error("Cannot reach the backend. Is python backend/app.py running?"); }
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Request failed (" + r.status + ")"); return d;
}
const post = (u, b) => api(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const fsize = b => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const fmtDur = s => s == null ? "-" : s < 60 ? Math.round(s) + "s" : Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";

/* theme + sidebar */
const root = document.documentElement;
try { root.dataset.theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"); } catch { }
$("#theme").onclick = () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("theme", root.dataset.theme); } catch { } };
$("#toggle").onclick = () => $("#app").classList.toggle("collapsed");

/* ---------- derived job info ---------- */
const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
const name = j => j.student_name || j.student_id, evid = j => "EV-" + j.job_id.slice(0, 4).toUpperCase();
const r1 = v => +(+v).toFixed(1);
const finalScore = j => j.status === "Completed" ? r1(j.faculty_total ?? j.ai_total) : null;
const pct = j => finalScore(j) == null ? null : finalScore(j) / j.max_total * 100;
function ST(j) {
  if (j.status === "Failed") return ["Failed", "bad", "alert"];
  if (j.status === "Processing") return j.current || j.items.some(i => i.ai_scores) ? ["AI scoring", "vio", "sparkle"] : ["Queued", "gray", "clock"];
  if (j.faculty_marks) return ["Approved", "ok", "checkc"];
  return j.flagged ? ["Flagged", "bad", "alert"] : ["Pending review", "warn", "user"];
}
const badge = j => { const [l, t, i] = ST(j); return `<span class="badge tone-${t}">${I(i)}${l}</span>`; };
const awaiting = j => ["Pending review", "Flagged"].includes(ST(j)[0]);

/* ---------- tables ---------- */
function table(list, full) {
  if (!list.length) return `<div class="empty">${I("file")}<p>Nothing here yet.</p></div>`;
  return `<table><tr><th>Student</th><th>Status</th>${full ? "<th>Submitted</th>" : ""}<th>Score</th><th></th></tr>` + list.map(j =>
    `<tr class="row" data-id="${j.job_id}" tabindex="0"><td><div class="who"><span class="av">${esc(initials(name(j)))}</span><div><b>${esc(name(j))}</b><small>${j.student_name ? esc(j.student_id) + " &middot; " : ""}${evid(j)}</small></div></div></td>` +
    `<td>${badge(j)}</td>${full ? `<td class="dash">${new Date(j.created_at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</td>` : ""}` +
    `<td class="score">${finalScore(j) != null ? finalScore(j) + "/" + j.max_total : '<span class="dash">&mdash;</span>'}</td><td>&rsaquo;</td></tr>`).join("") + "</table>";
}
function bindRows(el) { $$("tr.row", el).forEach(r => { r.onclick = () => openDrawer(r.dataset.id); r.onkeydown = e => { if (e.key === "Enter") openDrawer(r.dataset.id); }; }); }

/* ---------- charts (plain SVG) ---------- */
function smooth(p) {
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const [p0, p1, p2, p3] = [p[i - 1] || p[i], p[i], p[i + 1], p[i + 2] || p[i + 1]];
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  } return d;
}
function tipper(box) { const t = document.createElement("div"); t.className = "tip"; t.hidden = true; box.append(t); return t; }
function activityChart() {
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 13 + i); return d; });
  const key = ts => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const sub = days.map(d => jobs.filter(j => key(j.created_at) === d.getTime()).length), rev = days.map(d => jobs.filter(j => j.reviewed_at && key(j.reviewed_at) === d.getTime()).length);
  const W = 900, H = 300, L = 40, R = 10, T = 14, B = 34, ym = Math.max(5, Math.ceil(Math.max(...sub, ...rev) / 5) * 5);
  const x = i => L + i * (W - L - R) / 13, y = v => T + (H - T - B) * (1 - v / ym);
  const ps = sub.map((v, i) => [x(i), y(v)]), pr = rev.map((v, i) => [x(i), y(v)]), base = y(0);
  const area = p => smooth(p) + ` L${p[13][0]},${base} L${p[0][0]},${base} Z`;
  const grid = [0, 1, 2, 3, 4].map(k => { const v = ym / 4 * k; return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`; }).join("");
  const lab = [0, 3, 6, 9, 13].map(i => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${days[i].toLocaleDateString([], { month: "short", day: "numeric" })}</text>`).join("");
  const box = $("#activity");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Submissions and faculty reviews over 14 days">${grid}${lab}
    <path d="${area(ps)}" fill="#7c4dde" opacity=".14"/><path d="${area(pr)}" fill="#142a66" opacity=".12"/>
    <path d="${smooth(ps)}" fill="none" stroke="#8b5cf6" stroke-width="2.5"/><path d="${smooth(pr)}" fill="none" stroke="#142a66" stroke-width="2.5"/>
    <g id="dots" hidden><circle r="5" fill="#8b5cf6"/><circle r="5" fill="#142a66"/></g><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>
    <div class="legend"><span><i style="background:#142a66"></i>Faculty reviewed</span><span><i style="background:#8b5cf6"></i>Submissions</span></div>`;
  const tip = tipper(box), svg = $("svg", box), dots = $("#dots", box);
  $("rect", box).onmousemove = e => {
    const r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width * W, i = Math.max(0, Math.min(13, Math.round((mx - L) / ((W - L - R) / 13))));
    dots.hidden = false; dots.children[0].setAttribute("cx", x(i)); dots.children[0].setAttribute("cy", y(sub[i])); dots.children[1].setAttribute("cx", x(i)); dots.children[1].setAttribute("cy", y(rev[i]));
    tip.hidden = false; tip.style.left = Math.min(Math.max(x(i) / W * r.width, 80), r.width - 80) + "px"; tip.style.top = y(Math.max(sub[i], rev[i])) / H * r.height + "px";
    tip.innerHTML = `<b>${days[i].toLocaleDateString([], { month: "short", day: "numeric" })}</b><div><span><i style="background:#8b5cf6"></i>Submissions</span><b>${sub[i]}</b></div><div><span><i style="background:#142a66"></i>Faculty reviewed</span><b>${rev[i]}</b></div>`;
  };
  $("rect", box).onmouseleave = () => { tip.hidden = true; dots.hidden = true; };
}
function distChart() {
  const lab = ["0\u201340", "41\u201355", "56\u201370", "71\u201385", "86\u2013100"], cut = [40, 55, 70, 85, 100], cnt = [0, 0, 0, 0, 0];
  jobs.map(pct).filter(p => p != null).forEach(p => cnt[cut.findIndex(c => Math.round(p) <= c)]++);
  const W = 420, H = 300, L = 34, T = 14, B = 34, ym = Math.max(4, Math.ceil(Math.max(...cnt) / 4) * 4), bw = (W - L) / 5;
  const y = v => T + (H - T - B) * (1 - v / ym);
  const grid = [0, 1, 2, 3, 4].map(k => `<line x1="${L}" x2="${W}" y1="${y(ym / 4 * k)}" y2="${y(ym / 4 * k)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(ym / 4 * k) + 4}" text-anchor="end">${Math.round(ym / 4 * k)}</text>`).join("");
  const box = $("#dist");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score distribution">${grid}` + cnt.map((c, i) => `<rect class="bar" data-i="${i}" x="${L + i * bw + 10}" y="${y(c)}" width="${bw - 20}" height="${Math.max(y(0) - y(c), 0)}" rx="8" fill="var(--navy)"/><text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${lab[i]}</text>`).join("") + "</svg>";
  const tip = tipper(box), svg = $("svg", box);
  $$(".bar", box).forEach(b => { b.onmousemove = () => { const i = +b.dataset.i, r = svg.getBoundingClientRect(); tip.hidden = false; tip.style.left = (L + i * bw + bw / 2) / W * r.width + "px"; tip.style.top = (y(cnt[i]) - 4) / H * r.height + "px"; tip.innerHTML = `<b>${lab[i]}</b><div><span>Students</span><b>${cnt[i]}</b></div>`; }; b.onmouseleave = () => tip.hidden = true; });
}

/* ---------- dashboard ---------- */
function delta(fn, unit) {
  const now = Date.now() / 1000, wk = 604800, cur = fn(jobs.filter(j => now - j.created_at < wk)), prev = fn(jobs.filter(j => now - j.created_at >= wk && now - j.created_at < 2 * wk));
  if (cur == null || prev == null || (unit === "%" && prev === 0)) return '<small>No data from last week to compare</small>';
  const d = unit === "%" ? (cur - prev) / prev * 100 : cur - prev;
  return `<small class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "\u2197 +" : "\u2198 "}${d.toFixed(1)}${unit === "%" ? "%" : " pts"} vs last week</small>`;
}
function renderDashboard() {
  const h = new Date().getHours();
  $("#greet").textContent = `Good ${h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}, ${status.teacher || "Faculty"}`;
  const done = jobs.filter(j => j.status === "Completed"), ps = jobs.map(pct).filter(p => p != null), fl = jobs.filter(j => ST(j)[0] === "Flagged").length;
  const t = avg(done.filter(j => j.updated_at).map(j => j.updated_at - j.created_at));
  const k = [["Total submissions", jobs.length, delta(a => a.length, "%"), "copy"], ["Average score", ps.length ? avg(ps).toFixed(1) + "%" : "\u2014", delta(a => { const p = a.map(pct).filter(x => x != null); return p.length ? avg(p) : null; }, "pts"), "gauge"],
    ["Awaiting faculty review", jobs.filter(awaiting).length, `<small>Includes AI-flagged answers${fl ? " (" + fl + ")" : ""}</small>`, "user"], ["Avg. grading time", fmtDur(t), "<small>Per answer sheet</small>", "clock"]];
  $("#kpis").innerHTML = k.map(([l, v, s, i]) => `<div class="kpi"><span class="l">${l}</span><span class="ic">${I(i)}</span><b>${v}</b>${s}</div>`).join("");
  const c = l => jobs.filter(j => ST(j)[0] === l || (l === "Pending review" && ST(j)[0] === "Flagged")).length;
  $("#steps").innerHTML = [["Queued", "gray", "clock", 1], ["AI scoring", "vio", "sparkle", 2], ["Pending review", "warn", "user", 3], ["Approved", "ok", "checkc", 4]].map(([l, t, i, n]) =>
    `<div class="step"><div class="top"><span class="ic tone-${t}">${I(i)}</span>Step ${n}</div><b>${c(l)}</b><span class="l">${l}</span></div>`).join("");
  const f = jobs.filter(j => j.status === "Failed").length;
  $("#failnote").innerHTML = f ? `<b>${f} failed</b>. Open the submission under Evaluations to retry.` : "No failed submissions.";
  activityChart(); distChart();
  const rec = [...jobs].sort((a, b) => b.created_at - a.created_at).slice(0, 6);
  $("#recent").innerHTML = table(rec, false); bindRows($("#recent")); hydrate($("#view-dashboard"));
}

/* ---------- lists ---------- */
const FILTERS = [["all", "All", () => true], ["active", "Queued / scoring", j => ["Queued", "AI scoring"].includes(ST(j)[0])], ["review", "Pending review", awaiting], ["approved", "Approved", j => ST(j)[0] === "Approved"], ["failed", "Failed", j => j.status === "Failed"]];
function renderEvals() {
  $("#filters").innerHTML = FILTERS.map(([k, l, f]) => `<button class="${filter === k ? "on" : ""}" data-f="${k}">${l} (${jobs.filter(f).length})</button>`).join("");
  $$("#filters button").forEach(b => b.onclick = () => { filter = b.dataset.f; renderEvals(); });
  const f = FILTERS.find(x => x[0] === filter)[2];
  $("#evalTable").innerHTML = table([...jobs].filter(f).sort((a, b) => b.created_at - a.created_at), true); bindRows($("#evalTable"));
}
function renderReview() {
  $("#reviewTable").innerHTML = table(jobs.filter(awaiting).sort((a, b) => (ST(b)[0] === "Flagged") - (ST(a)[0] === "Flagged")), true); bindRows($("#reviewTable"));
  const n = jobs.filter(awaiting).length; $("#rqCount").hidden = !n; $("#rqCount").textContent = n;
}
async function renderAccuracy() {
  const el = $("#accBody");
  try {
    const d = await api("/api/metrics"), f = v => v == null ? "-" : v;
    el.innerHTML = d.n ? `<p class="hint">Based on ${d.n} faculty-approved question(s). Aim for 30+ before drawing conclusions.</p><div style="overflow-x:auto"><table class="mt"><tr><th>Method</th><th>Questions</th><th>Avg error (marks)</th><th>Avg error (%)</th><th>RMSE (%)</th><th>Within 10%</th><th>Pearson r</th><th>QWK</th></tr>` +
      Object.entries(d.methods).filter(([, m]) => m).map(([k, m]) => `<tr><td><b>${k}</b></td><td>${m.n}</td><td>${m.mae_marks}</td><td>${m.mae_pct}%</td><td>${m.rmse_pct}%</td><td>${m.within10_pct}%</td><td>${f(m.pearson)}</td><td>${f(m.qwk)}</td></tr>`).join("") +
      '</table></div><p class="hint">Lower error is better. Pearson r and QWK (quadratic weighted kappa) closer to 1 mean closer agreement with the teacher.</p>' : `<div class="empty">${I("chart")}<p>No faculty-approved marks yet. Approve some evaluations first.</p></div>`;
    hydrate(el);
  } catch (e) { el.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; }
}

/* ---------- drawer ---------- */
function openDrawer(id) { openId = id; $("#scrim").hidden = false; $("#drawer").hidden = false; drawerSig = ""; renderDrawer(true); }
function closeDrawer() { openId = null; $("#scrim").hidden = true; $("#drawer").hidden = true; }
$("#scrim").onclick = closeDrawer; document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
const jsig = j => [j.status, j.items.filter(i => i.ai_scores).length, j.faculty_total, j.error, j.current && j.current.no].join("|");
function renderDrawer(force) {
  const j = jobs.find(x => x.job_id === openId); if (!j) return;
  if (!force && (jsig(j) === drawerSig || $("#drawer").contains(document.activeElement) && document.activeElement.tagName === "INPUT")) return;
  drawerSig = jsig(j); const d = $("#drawer"), done = j.items.filter(i => i.ai_scores).length;
  d.innerHTML = `<div class="dhead"><span class="av">${esc(initials(name(j)))}</span><div><b style="font-size:20px">${esc(name(j))}</b><small style="display:block;color:var(--mute)">${esc(j.student_id)} &middot; ${evid(j)}</small></div><button class="iconbtn x" id="dx" aria-label="Close">${I("x")}</button></div>
    <div>${badge(j)}</div>` +
    (j.status === "Processing" ? `<div class="pbar" role="progressbar" aria-valuenow="${done}" aria-valuemax="${j.items.length}"><i style="width:${done / j.items.length * 100}%"></i></div><p class="hint">${done}/${j.items.length} questions scored${j.current ? ` &middot; scoring Q${j.current.no}... <span id="el" data-s="${j.current.started}"></span>` : ""}. Local models can take 1-3 minutes per question.</p>` : "") +
    (j.error ? `<div class="flagbox">${esc(j.error)}</div><button class="btn primary" id="retry" style="margin-top:10px">Retry remaining questions</button>` : "") +
    (j.status === "Completed" ? `<p><span class="big-score">${finalScore(j)}</span> / ${j.max_total} <span class="hint">${j.faculty_marks ? "faculty-approved" : "AI score, awaiting approval"}</span></p>` : "") +
    j.items.map(i => `<div class="dq"><h4><span>Question ${i.no}</span><span>${i.ai_scores ? r1(i.ai_total) : "-"} / ${i.marks}</span></h4>
      <div class="hint">Student answer</div><div class="ans">${esc(i.student_answer) || "<i>No answer found</i>"}</div>
      ${i.ai_scores ? i.rubrics.map(r => `<div class="cr"><b>${esc(r.name)}<span class="s">${i.ai_scores[r.name]} / ${r.max}</span></b><div>${esc((i.justifications || {})[r.name]) || "-"}</div></div>`).join("") : ""}
      ${i.summary ? `<p class="hint"><i>${esc(i.summary)}</i></p>` : ""}
      ${i.components ? `<p class="hint">Signals: ${[["LLM rubric", "llm"], ["Concept coverage", "coverage"], ["Semantic similarity", "semantic"]].map(([l, k]) => `${l} ${i.components[k] == null ? "n/a" : Math.round(i.components[k] * 100) + "%"}`).join(" &middot; ")}</p>` : ""}
      ${i.flag ? '<div class="flagbox">Flagged: the AI signals disagree strongly on this answer. Please check it.</div>' : ""}
      ${j.status === "Completed" ? `<div class="fi">Faculty marks <input type="number" step="0.5" min="0" max="${i.marks}" data-n="${i.no}" value="${j.faculty_marks ? j.faculty_marks[i.no] : ""}" aria-label="Faculty marks for Q${i.no}"> / ${i.marks}</div>` : ""}</div>`).join("") +
    (j.status === "Completed" ? `<div class="btnrow" style="margin-top:18px"><button class="btn outline" id="useai">Use AI marks</button><button class="btn primary" id="approve">Save &amp; approve</button></div>` : "");
  hydrate(d); $("#dx").onclick = closeDrawer;
  if ($("#retry")) $("#retry").onclick = async () => { try { await api("/api/retry/" + j.job_id, { method: "POST" }); toast("Retrying...", "ok"); refresh(); } catch (e) { toast(e.message, "err"); } };
  if ($("#useai")) $("#useai").onclick = () => $$("input[data-n]", d).forEach(inp => { const it = j.items.find(i => i.no == inp.dataset.n); inp.value = Math.min(it.marks, Math.round(it.ai_total * 2) / 2); });
  if ($("#approve")) $("#approve").onclick = async () => {
    const marks = {}; $$("input[data-n]", d).forEach(i => marks[i.dataset.n] = i.value);
    try { await post("/api/faculty/" + j.job_id, { marks }); toast("Approved and saved", "ok"); document.activeElement.blur(); await refresh(); } catch (e) { toast(e.message, "err"); }
  };
}
setInterval(() => { const e = $("#el"); if (e) e.textContent = Math.max(0, Math.round(Date.now() / 1000 - e.dataset.s)) + "s elapsed"; }, 1000);

/* ---------- polling + router ---------- */
async function refresh() {
  try { jobs = await api("/api/jobs"); } catch { return; }
  const s = JSON.stringify(jobs.map(j => [j.job_id, j.status, j.items.filter(i => i.ai_scores).length, j.faculty_total, j.current && j.current.no]));
  if (s !== sig) { sig = s; renderRoute(false); } else if (route === "dashboard") { /* nothing changed */ }
  renderDrawer(false); const n = jobs.filter(awaiting).length; $("#rqCount").hidden = !n; $("#rqCount").textContent = n;
}
function renderRoute(enter) {
  if (route === "dashboard") renderDashboard(); else if (route === "evaluations") renderEvals(); else if (route === "review") renderReview(); else if (route === "accuracy" && enter) renderAccuracy();
}
function go() {
  route = (location.hash.replace("#/", "") || "dashboard"); if (!["dashboard", "new", "evaluations", "review", "accuracy"].includes(route)) route = "dashboard";
  $$(".view").forEach(v => v.hidden = v.id !== "view-" + route); $$("#nav a").forEach(a => a.classList.toggle("on", a.dataset.r === route));
  renderRoute(true); window.scrollTo(0, 0);
}
window.addEventListener("hashchange", go);
async function loadStatus() {
  try { status = await api("/api/status"); const p = $("#llmPill"); p.className = "llm" + (status.llm ? " ok" : ""); p.innerHTML = `<i></i><em>${esc(status.model)} ${status.llm ? "ready" : "not available"}</em>`; if (route === "dashboard") renderDashboard(); }
  catch { $("#llmPill").innerHTML = "<i></i><em>Backend offline</em>"; }
}

/* ---------- new submission: uploaders ---------- */
function setupUploader(el) {
  const p = el.dataset.p;
  el.innerHTML = `<label class="drop" tabindex="0"><input type="file" accept="application/pdf,.pdf,.txt,text/plain" hidden>${I("upload")}<b>Drag &amp; drop a PDF here</b><span>or click to browse &middot; digital PDF or .txt &middot; max 10 MB</span></label>
    <div class="fchip" hidden><div class="ic">PDF</div><div class="nm"><span></span><small></small></div><button type="button" class="outline sm">Remove</button></div>
    <div class="actions"><button class="btn primary go" disabled><span class="btxt">Read file &amp; split</span></button><button class="btn outline resplit" type="button">Split text below</button></div>
    <details class="ext" open><summary>Or paste / edit the text</summary><textarea rows="7" aria-label="Document text" placeholder="Paste the text here, e.g.&#10;Q1. What is photosynthesis? (3 marks)&#10;Ans: Plants make food using light."></textarea></details>
    <p class="note" role="status"></p>`;
  const drop = $(".drop", el), input = $("input", el), chip = $(".fchip", el), go = $(".go", el), note = $(".note", el), ta = $("textarea", el);
  const say = (t, k = "") => { note.textContent = t; note.className = "note " + k; };
  const pick = f => {
    if (!f) return;
    if (!/\.(pdf|txt)$/i.test(f.name)) return say("Please choose a PDF or .txt file.", "err");
    if (f.size > 10 * 1048576) return say("File is larger than 10 MB.", "err");
    files[p] = f; drop.hidden = true; chip.hidden = false; $(".nm span", chip).textContent = f.name; $("small", chip).textContent = fsize(f.size); go.disabled = false; say("");
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
      const d = await post("/api/split", { text: ta.value }); p === "k" ? keyArr = d.items : stuArr = d.items;
      say(`Found ${d.items.length} question(s): ${d.items.map(i => "Q" + i.no).join(", ")}`, "ok"); renderQuestions();
    } catch (e) { say(e.message, "err"); toast(e.message, "err"); }
  };
  $(".resplit", el).onclick = split;
  go.onclick = async () => {
    const fd = new FormData(); fd.append("file", files[p]); go.disabled = true; $(".btxt", go).innerHTML = '<span class="spin"></span>Reading...';
    try { const d = await api("/api/extract", { method: "POST", body: fd }); ta.value = d.text; toast(`${d.pages} page(s) read from the ${d.method}`, "ok"); await split(); }
    catch (e) { say(e.message, "err"); toast(e.message, "err"); }
    $(".btxt", go).textContent = "Read file & split"; go.disabled = false;
  };
}
$$(".uploader").forEach(setupUploader);

function syncQuestions() {
  $$("#qlist .q").forEach(c => {
    const no = +c.dataset.no, kt = $(".kt", c).value, sa = $(".sa", c).value, mk = $(".mk", c).value, k = keyArr.find(i => i.no === no), s = stuArr.find(i => i.no === no);
    if (k) { k.text = kt; k.marks = mk; } else if (kt.trim()) keyArr.push({ no, text: kt, marks: mk });
    if (s) s.text = sa; else if (sa.trim()) stuArr.push({ no, text: sa });
  });
}
function flag(c) { const k = $(".kt", c).value.trim(), s = $(".sa", c).value.trim(), b = $(".badge", c); [b.textContent, b.className] = !k ? ["Not in answer key (ignored)", "badge tone-bad"] : !s ? ["No student answer: scores 0", "badge tone-warn"] : ["Matched", "badge tone-ok"]; }
function updateSummary() {
  const cs = $$("#qlist .q"), kd = cs.filter(c => $(".kt", c).value.trim()), m = kd.filter(c => $(".sa", c).value.trim()).length, tot = kd.reduce((a, c) => a + (+$(".mk", c).value || 0), 0);
  $("#summary").innerHTML = [[kd.length, "Questions graded"], [m, "Matched with answers"], [kd.length - m, "Unanswered"], [tot, "Total marks"]].map(([v, l]) => `<div class="sbox"><b>${v}</b><span>${l}</span></div>`).join("");
}
function renderQuestions() {
  const nos = [...new Set([...keyArr, ...stuArr].map(i => i.no))].sort((a, b) => a - b); if (!nos.length) return;
  $("#summary").hidden = false;
  $("#qlist").innerHTML = nos.map(no => { const k = keyArr.find(i => i.no === no), s = stuArr.find(i => i.no === no);
    return `<article class="q" data-no="${no}"><div class="qh"><h3>Question ${no}</h3><span class="badge"></span><label class="mkl">Marks <input class="mk" type="number" min="0.5" step="0.5" value="${k ? (k.marks || DEFAULT_MARKS) : DEFAULT_MARKS}" aria-label="Marks for question ${no}"></label></div>
      <div class="pair"><label>Teacher: question + model answer<textarea class="kt" rows="4">${esc(k ? k.text : "")}</textarea></label><label>Student answer<textarea class="sa" rows="4">${esc(s ? s.text : "")}</textarea></label></div></article>`; }).join("");
  $$("#qlist .q").forEach(c => { flag(c); c.addEventListener("input", () => { flag(c); updateSummary(); }); }); updateSummary();
  if (keyArr.some(i => i.marks == null)) toast(`Questions without "(N marks)" default to ${DEFAULT_MARKS}. Adjust them in step 3.`);
}
function addRubric(n = "", w = 10) {
  const d = document.createElement("div"); d.className = "rub";
  d.innerHTML = `<span class="dot"></span><input aria-label="Rubric name" placeholder="Criterion" value="${esc(n)}"><input aria-label="Weight percent" type="number" min="1" max="100" value="${w}"><button type="button" aria-label="Remove rubric">x</button>`;
  $("button", d).onclick = () => { d.remove(); sumW(); }; d.addEventListener("input", sumW); $("#rubrics").append(d); sumW();
}
function sumW() {
  const rows = $$(".rub"); let t = 0; rows.forEach((r, i) => { $(".dot", r).style.background = COLORS[i % 8]; t += +$$("input", r)[1].value || 0; });
  $("#wbar").innerHTML = rows.map((r, i) => `<i style="width:${Math.min(+$$("input", r)[1].value || 0, 100)}%;background:${COLORS[i % 8]}"></i>`).join("");
  $("#wsum").textContent = `Total weight: ${t}${t === 100 ? " \u2713" : " (must be 100)"}`; $("#wsum").className = "hint" + (t === 100 ? "" : " bad");
}
DEFAULT_RUBRICS.forEach(r => addRubric(...r)); $("#addR").onclick = () => addRubric();
$("#evalBtn").onclick = async () => {
  syncQuestions(); const b = $("#evalBtn"), rubrics = $$(".rub").map(r => { const i = $$("input", r); return { name: i[0].value, weight: i[1].value }; });
  b.disabled = true; $(".btxt", b).innerHTML = '<span class="spin"></span>Sending...';
  try {
    const d = await post("/api/evaluate", { student_id: $("#sid").value, student_name: $("#sname").value, key_items: keyArr, student_items: stuArr, rubrics });
    toast("Submission accepted (202). Grading in the background.", "ok"); await refresh(); location.hash = "#/evaluations"; setTimeout(() => openDrawer(d.job_id), 50);
  } catch (e) { toast(e.message, "err"); }
  $(".btxt", b).textContent = "Send for AI grading"; b.disabled = false;
};

hydrate(); loadStatus(); go(); refresh(); setInterval(refresh, 3000); setInterval(loadStatus, 30000);
