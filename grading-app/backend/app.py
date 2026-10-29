"""Automatic Grading of Short Handwritten Answers - Flask backend.

Pipeline: teacher answer-key PDF + student answer PDF -> text (PDF text layer, no OCR)
-> split by question number -> teacher review -> async LLM evaluation per question
(job_id, HTTP 202) -> JSON in api_results/ -> polled by the UI -> faculty review.
No scores are ever invented: if OCR/LLM is unavailable the job fails with a clear message.
"""
import difflib, io, json, math, os, re, shutil, threading, time, uuid
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

BASE = Path(__file__).resolve().parent
load_dotenv(BASE.parent / ".env")
RESULTS = BASE / "api_results"
RESULTS.mkdir(exist_ok=True)

PROVIDER = os.getenv("LLM_PROVIDER", "ollama").lower()
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:3b")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")
SCORING_MODE = os.getenv("SCORING_MODE", "fusion").lower()  # fusion | llm
W_LLM, W_COV, W_SEM = [float(x) for x in os.getenv("FUSION_WEIGHTS", "0.6,0.2,0.2").split(",")]
OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "300"))
ALLOWED = {"pdf", "txt"}
MAX_PAGES = 20

app = Flask(__name__, static_folder=str(BASE.parent / "frontend"), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024
lock = threading.Lock()


# ---------- helpers ----------
def llm_ready():
    try:
        if PROVIDER == "anthropic":
            return bool(ANTHROPIC_KEY)
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=2)
        names = [m["name"] for m in r.json().get("models", [])]
        return any(n == OLLAMA_MODEL or n.split(":")[0] == OLLAMA_MODEL for n in names)
    except Exception:
        return False


def path_for(job_id):
    if not re.fullmatch(r"[0-9a-f]{12}", job_id):
        raise ValueError("bad job id")
    return RESULTS / f"{job_id}.json"


def save(job):
    with lock:
        path_for(job["job_id"]).write_text(json.dumps(job, indent=2), encoding="utf-8")


def load(job_id):
    try:
        return json.loads(path_for(job_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def call_llm(prompt):
    if PROVIDER == "anthropic":
        if not ANTHROPIC_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY is not set in .env")
        r = requests.post("https://api.anthropic.com/v1/messages", timeout=120,
                          headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"},
                          json={"model": ANTHROPIC_MODEL, "max_tokens": 1500,
                                "messages": [{"role": "user", "content": prompt}]})
        r.raise_for_status()
        return r.json()["content"][0]["text"]
    try:
        r = requests.post(f"{OLLAMA_URL}/api/generate", timeout=OLLAMA_TIMEOUT,
                          json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False, "format": "json",
                                "keep_alive": "30m",
                                "options": {"temperature": 0, "num_predict": 700, "num_ctx": 4096}})
        r.raise_for_status()
    except requests.ConnectionError:
        raise RuntimeError(f"Cannot reach Ollama at {OLLAMA_URL}. Start it and run: ollama pull {OLLAMA_MODEL}")
    except requests.ReadTimeout:
        raise RuntimeError(f"The model did not answer within {OLLAMA_TIMEOUT}s. Your computer may be too slow for {OLLAMA_MODEL}; "
                           "try a smaller model (OLLAMA_MODEL=qwen2.5:1.5b) or raise OLLAMA_TIMEOUT in .env.")
    return r.json()["response"]


def build_prompt(it):
    rubrics = "\n".join(f'- "{r["name"]}" (max {r["max"]} marks)' for r in it["rubrics"])
    return f"""You are a strict, fair examiner grading one short student answer. Judge meaning, not exact wording.
Teacher's question and model answer (from the answer key):
{it['key_text']}

Student answer (extracted by OCR, may contain recognition errors - do not penalise obvious OCR typos):
{it['student_answer']}

Score each rubric criterion between 0 and its max (decimals allowed):
{rubrics}

Reply with JSON only, in this shape:
{{"scores": {{"<criterion name>": <number>}}, "justifications": {{"<criterion name>": "<one or two sentences>"}}, "summary": "<overall feedback>"}}"""


def parse_result(raw, rubrics):
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        raise ValueError("LLM did not return JSON")
    data = json.loads(m.group(0))
    scores, just = {}, {}
    for r in rubrics:
        try:
            v = float(data["scores"][r["name"]])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f'LLM response missing a score for "{r["name"]}"')
        scores[r["name"]] = round(min(max(v, 0), r["max"]), 2)
        just[r["name"]] = str(data.get("justifications", {}).get(r["name"], "")).strip()
    return scores, just, str(data.get("summary", "")).strip()


# ---------- splitting a PDF's text into numbered questions ----------
PREFIXED = re.compile(r"^\s*(?:q(?:uestion)?|ans(?:wer)?)\s*\.?\s*(?:no\.?)?\s*(\d{1,3})\b\s*[.):\-]?\s*(.*)$", re.I)
PLAIN = re.compile(r"^\s*(\d{1,3})\s*[.)]\s+(.*)$")
MARKS = re.compile(r"[(\[]?\s*(\d+(?:\.\d+)?)\s*(?:marks?|mks)\s*[)\]]?", re.I)


def split_questions(text):
    """Q1 / Question 1 / Ans 1 always start a block; a bare '2.' only counts when the text has no
    Q/Ans markers at all and it is the next number in sequence. Blocks with the
    same number (e.g. 'Q1 ...' then 'Ans 1 ...') are merged."""
    blocks, order, cur, last = {}, [], None, 0
    use_plain = not any(PREFIXED.match(l) for l in text.splitlines())  # bare "1." only if no Q1/Ans1 markers
    for line in text.splitlines():
        m = PREFIXED.match(line)
        if m:
            cur = int(m.group(1))
        else:
            m = PLAIN.match(line)
            if use_plain and m and int(m.group(1)) == last + 1:
                cur = int(m.group(1))
            else:
                m = None
        if m:
            last = max(last, cur)
            if cur not in blocks:
                blocks[cur] = []
                order.append(cur)
            if m.group(2).strip():
                blocks[cur].append(m.group(2).strip())
        elif cur is not None and line.strip() and not re.match(r"^\s*---\s*Page \d+\s*---\s*$", line):
            blocks[cur].append(line.strip())
    if not blocks and text.strip():
        blocks, order = {1: [text.strip()]}, [1]
    items = []
    for n in sorted(order):
        body = "\n".join(blocks[n]).strip()
        mk = MARKS.search(body[:200])
        items.append({"no": n, "text": body, "marks": float(mk.group(1)) if mk else None})
    return items


# ---------- model fusion (report: combine text analysis + semantics, not one technique) ----------
STOP = set("the a an of to in on and or is are was were be been it its this that these those for with as by at from which what who whom "
           "into using use used can may also their there than then so such not no has have had will would should does do how why when".split())


def _stem(w):
    for suf in ("ing", "ed", "es", "s", "ly"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[:-len(suf)]
    return w


def _toks(t):
    return {_stem(w) for w in re.findall(r"[a-z][a-z\-']+", t.lower()) if len(w) > 2 and w not in STOP}


def model_answer_of(key_text):
    m = re.search(r"\bans(?:wer)?\b\s*[:.\-]?\s*", key_text, re.I)
    return key_text[m.end():] if m else key_text


def concept_coverage(model, student):
    """Share of the model answer's content words present in the student answer.
    Fuzzy matching (>=0.84) tolerates OCR slips such as 'photosyntesis'."""
    m, s = _toks(model), _toks(student)
    if not m:
        return None
    hit = sum(1 for w in m if w in s or any(difflib.SequenceMatcher(None, w, x).ratio() >= 0.84 for x in s))
    return hit / len(m)


_embed_off_until = 0


def semantic_similarity(model, student):
    """Cosine similarity of Ollama embeddings, rescaled to 0..1. None if unavailable."""
    global _embed_off_until
    if PROVIDER != "ollama" or time.time() < _embed_off_until:
        return None
    try:
        v = []
        for t in (model, student):
            r = requests.post(f"{OLLAMA_URL}/api/embeddings", json={"model": EMBED_MODEL, "prompt": t}, timeout=60)
            r.raise_for_status()
            v.append(r.json()["embedding"])
        dot = sum(a * b for a, b in zip(*v))
        cos = dot / (math.sqrt(sum(a * a for a in v[0])) * math.sqrt(sum(b * b for b in v[1])))
        return min(max((cos - 0.3) / 0.6, 0), 1)
    except Exception:
        _embed_off_until = time.time() + 120  # model not pulled / not reachable: skip for a while
        return None


def fuse(llm_frac, cov, sem):
    parts = [("llm", W_LLM, llm_frac)]
    if SCORING_MODE != "llm":
        parts += [("coverage", W_COV, cov), ("semantic", W_SEM, sem)]
    used = [(n, w, v) for n, w, v in parts if v is not None and w > 0]
    tot = sum(w for _, w, _ in used)
    frac = sum(w * v for _, w, v in used) / tot
    return frac, {"llm": llm_frac, "coverage": cov, "semantic": sem, "weights": {n: round(w / tot, 3) for n, w, _ in used}}


# ---------- accuracy metrics against faculty marks ----------
def _qwk(a, b, n=11):
    O = [[0] * n for _ in range(n)]
    for x, y in zip(a, b):
        O[x][y] += 1
    ha, hb, N = [sum(r) for r in O], [sum(O[i][j] for i in range(n)) for j in range(n)], len(a)
    num = sum(((i - j) ** 2) * O[i][j] for i in range(n) for j in range(n))
    den = sum(((i - j) ** 2) * ha[i] * hb[j] / N for i in range(n) for j in range(n))
    return None if den == 0 else round(1 - num / den, 3)


def _pearson(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    sa, sb = math.sqrt(sum((x - ma) ** 2 for x in a)), math.sqrt(sum((y - mb) ** 2 for y in b))
    return None if n < 3 or sa == 0 or sb == 0 else round(sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb), 3)


def score_metrics(rows, key):
    """rows: dicts with faculty, marks and prediction fields. Everything is compared as a fraction of the question's marks."""
    pts = [(r["faculty"], r[key], r["marks"]) for r in rows if r.get(key) is not None]
    if not pts:
        return None
    f = [a / m for a, _, m in pts]
    p = [min(max(b / m, 0), 1) for _, b, m in pts]
    n = len(pts)
    return {"n": n, "mae_marks": round(sum(abs(a - b) for a, b, _ in pts) / n, 3),
            "mae_pct": round(100 * sum(abs(x - y) for x, y in zip(f, p)) / n, 1),
            "rmse_pct": round(100 * math.sqrt(sum((x - y) ** 2 for x, y in zip(f, p)) / n), 1),
            "within10_pct": round(100 * sum(abs(x - y) <= 0.1 for x, y in zip(f, p)) / n, 1),
            "pearson": _pearson(f, p), "qwk": _qwk([round(x * 10) for x in f], [round(y * 10) for y in p])}


def run_job(job_id):
    job = load(job_id)
    job["status"], job["error"] = "Processing", None
    save(job)
    try:
        for it in job["items"]:
            if it.get("ai_scores") is not None:
                continue
            if not it["student_answer"].strip():
                it.update(ai_scores={r["name"]: 0 for r in it["rubrics"]}, ai_total=0, llm_total=0,
                          justifications={}, summary="No answer found for this question.")
            else:
                t0 = time.time()
                job["current"] = {"no": it["no"], "started": t0}
                save(job)
                print(f"[{job_id}] scoring Q{it['no']} ...", flush=True)
                sc, ju, su = parse_result(call_llm(build_prompt(it)), it["rubrics"])
                print(f"[{job_id}] Q{it['no']} done in {time.time() - t0:.0f}s", flush=True)
                llm_total = round(sum(sc.values()), 2)
                frac, comp = fuse(llm_total / it["marks"],
                                  concept_coverage(model_answer_of(it["key_text"]), it["student_answer"]),
                                  semantic_similarity(model_answer_of(it["key_text"]), it["student_answer"]))
                it.update(ai_scores=sc, justifications=ju, summary=su, llm_total=llm_total,
                          components=comp, ai_total=round(frac * it["marks"], 2),
                          flag=any(comp[k] is not None and abs(comp["llm"] - comp[k]) > 0.4 for k in ("coverage", "semantic")))
            save(job)
        job.update(status="Completed", flagged=any(i.get("flag") for i in job["items"]), ai_total=round(sum(i["ai_total"] for i in job["items"]), 2))
    except Exception as e:
        print(f"[{job_id}] FAILED: {e}", flush=True)
        job.update(status="Failed", error=str(e))
    job.pop("current", None)
    job["updated_at"] = time.time()
    save(job)


def start(job_id):
    threading.Thread(target=run_job, args=(job_id,), daemon=True).start()


# ---------- routes ----------
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/status")
def status():
    return jsonify(llm=llm_ready(), provider=PROVIDER, teacher=os.getenv("TEACHER_NAME", "Faculty"),
                   model=ANTHROPIC_MODEL if PROVIDER == "anthropic" else OLLAMA_MODEL)


@app.post("/api/extract")
def extract():
    """PDF (text layer) or .txt -> text. OCR is not part of this project; scanned PDFs are rejected."""
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file uploaded."), 400
    ext = f.filename.rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED:
        return jsonify(error="Unsupported file type. Upload a PDF or a .txt file."), 400
    data = f.read()
    try:
        if ext == "txt":
            return jsonify(text=data.decode("utf-8", errors="replace").strip(), pages=1, method="text file")
        import fitz  # PyMuPDF
        doc = fitz.open(stream=data, filetype="pdf")
        if doc.page_count > MAX_PAGES:
            return jsonify(error=f"PDF has {doc.page_count} pages; the limit is {MAX_PAGES}."), 400
        texts = [p.get_text().strip() for p in doc]
    except Exception as e:
        return jsonify(error=f"Could not read file: {e}"), 400
    if sum(len(t) for t in texts) < 20:
        return jsonify(error="This PDF has no selectable text (it looks scanned). Upload a digital PDF or paste the text instead."), 422
    text = "\n\n".join(f"--- Page {i} ---\n{t}" for i, t in enumerate(texts, 1)) if len(texts) > 1 else texts[0]
    return jsonify(text=text, pages=len(texts), method="PDF text layer")


@app.post("/api/split")
def split():
    text = str((request.get_json(silent=True) or {}).get("text", ""))
    if not text.strip():
        return jsonify(error="There is no text to split."), 400
    return jsonify(items=split_questions(text))


@app.post("/api/evaluate")
def evaluate():
    d = request.get_json(silent=True) or {}
    if not str(d.get("student_id", "")).strip():
        return jsonify(error="Please enter the Student / Roll ID."), 400
    try:
        weights = [{"name": str(r["name"]).strip(), "w": float(r["weight"])} for r in d.get("rubrics", [])]
        assert weights and all(r["name"] and r["w"] > 0 for r in weights)
        assert len({r["name"] for r in weights}) == len(weights)
        assert abs(sum(r["w"] for r in weights) - 100) < 0.5
    except Exception:
        return jsonify(error="Rubrics need unique names, weights above 0, and weights that add up to 100."), 400
    stu = {int(i["no"]): str(i.get("text", "")) for i in d.get("student_items", [])}
    items = []
    for k in d.get("key_items", []):
        try:
            marks = float(k["marks"])
            assert marks > 0
        except Exception:
            return jsonify(error=f'Question {k.get("no")}: enter marks above 0.'), 400
        if not str(k.get("text", "")).strip():
            continue
        items.append({"no": int(k["no"]), "key_text": str(k["text"]).strip(), "marks": marks,
                      "student_answer": stu.get(int(k["no"]), "").strip(),
                      "rubrics": [{"name": r["name"], "max": round(marks * r["w"] / 100, 2)} for r in weights]})
    if not items:
        return jsonify(error="Upload the teacher answer-key PDF and split it into questions first."), 400
    job_id = uuid.uuid4().hex[:12]
    job = {"job_id": job_id, "status": "Processing", "created_at": time.time(), "student_id": d["student_id"].strip(), "student_name": str(d.get("student_name", "")).strip(),
           "items": items, "max_total": round(sum(i["marks"] for i in items), 2), "faculty_marks": None}
    save(job)
    start(job_id)
    return jsonify(job_id=job_id, status="Processing"), 202


@app.get("/api/result/<job_id>")
def result(job_id):
    try:
        job = load(job_id)
    except ValueError:
        job = None
    return (jsonify(job), 200) if job else (jsonify(error="Job not found"), 404)


@app.get("/api/jobs")
def jobs():
    out = [load(p.stem) for p in RESULTS.glob("*.json")]
    return jsonify(sorted([j for j in out if j], key=lambda j: j["created_at"], reverse=True))


@app.post("/api/retry/<job_id>")
def retry(job_id):
    if not load(job_id):
        return jsonify(error="Job not found"), 404
    start(job_id)  # questions already scored are kept; only the rest are re-run
    return jsonify(job_id=job_id, status="Processing"), 202


@app.post("/api/faculty/<job_id>")
def faculty(job_id):
    job = load(job_id)
    if not job:
        return jsonify(error="Job not found"), 404
    marks = (request.get_json(silent=True) or {}).get("marks", {})
    clean = {}
    for it in job["items"]:
        try:
            v = float(marks[str(it["no"])])
        except (KeyError, TypeError, ValueError):
            return jsonify(error=f'Enter marks for Q{it["no"]}.'), 400
        if not 0 <= v <= it["marks"]:
            return jsonify(error=f'Q{it["no"]} must be between 0 and {it["marks"]}.'), 400
        clean[str(it["no"])] = v
    job["faculty_marks"], job["faculty_total"], job["reviewed_at"] = clean, round(sum(clean.values()), 2), time.time()
    save(job)
    return jsonify(job)


@app.get("/api/metrics")
def metrics():
    rows = []
    for j in jobs_all():
        for it in j["items"]:
            if j.get("faculty_marks") and it.get("ai_scores") is not None and str(it["no"]) in j["faculty_marks"]:
                cov = (it.get("components") or {}).get("coverage")
                rows.append({"faculty": float(j["faculty_marks"][str(it["no"])]), "marks": it["marks"], "fusion": it["ai_total"],
                             "llm_only": it.get("llm_total", it["ai_total"]), "coverage_only": None if cov is None else cov * it["marks"]})
    return jsonify(n=len(rows), methods={"Fusion (final marks)": score_metrics(rows, "fusion"),
                                         "LLM only": score_metrics(rows, "llm_only"),
                                         "Concept coverage only": score_metrics(rows, "coverage_only")})


def jobs_all():
    return [j for j in (load(p.stem) for p in RESULTS.glob("*.json")) if j]


def recover():
    """Restart jobs interrupted by a shutdown (the 'recovery function')."""
    for p in RESULTS.glob("*.json"):
        j = load(p.stem)
        if j and j["status"] == "Processing":
            start(j["job_id"])


if __name__ == "__main__":
    if PROVIDER == "ollama":  # load the model into memory now so the first grading is not slow
        def warm():
            try:
                requests.post(f"{OLLAMA_URL}/api/generate", timeout=OLLAMA_TIMEOUT,
                              json={"model": OLLAMA_MODEL, "prompt": "", "keep_alive": "30m"})
            except Exception:
                pass  # Ollama not running yet; the status pill will say so
        threading.Thread(target=warm, daemon=True).start()
    print(".env file:", BASE.parent / ".env", "(found)" if (BASE.parent / ".env").exists() else "(MISSING)")
    recover()
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", 5000)), debug=False)
