# GradeFlow - Automatic Grading of Short Answers

Desktop dashboard for the B.Tech Phase-I project (IILM University).
**Teacher answer-key PDF + student answer PDF (all questions in each) -> text from the PDF -> split and matched by question number -> teacher review -> rubric-weighted scoring by a local LLM, fused with concept coverage and semantic similarity -> faculty approval -> accuracy report.**

OCR is not part of this version. PDFs must contain selectable (digital) text, or you can paste the text. A scanned PDF is rejected with a clear message. No marks are ever invented: if the LLM is unavailable the job fails with an explanation.

## Requirements
- Python 3.10+
- Ollama with a model (default `qwen2.5:3b`, offline) **or** an Anthropic API key

## Setup
```bash
ollama pull qwen2.5:3b
ollama pull nomic-embed-text            # optional: enables the semantic-similarity signal
python -m venv venv && source venv/bin/activate     # Windows: venv\Scripts\activate
pip install -r backend/requirements.txt
cp .env.example .env                    # Windows: copy .env.example .env  (never commit .env)
python backend/app.py
```
Open http://127.0.0.1:5000. The sidebar shows whether the LLM is ready.

## Pages
- **Dashboard:** totals, average score, awaiting review, grading time, the 4-step pipeline (Queued, AI scoring, Pending review, Approved), 14-day activity chart, score distribution, recent evaluations. All numbers come from real submissions.
- **New submission:** student name/ID, the two documents, review table, rubric weights, send for grading.
- **Evaluations / Review queue:** every submission; click a row for per-question detail, justifications and faculty marks ("Use AI marks" then "Save & approve"). Answers are **Flagged** when the AI signals disagree strongly.
- **Accuracy:** AI vs faculty-approved marks (average error, RMSE, within-10%, Pearson r, QWK) for fusion, LLM-only and coverage-only.

## Preparing the documents
Start each question with `Q1.`, `Q2.` or `Question 3:` (the key may also use `Ans 1`). Marks like `(3 marks)` are read from the key; otherwise 5 is used and you can edit it. The student document uses the same numbers. Unanswered questions score 0 without calling the LLM.

## Scoring (model fusion, as in the report)
Final marks per question = LLM rubric score (0.6) + concept coverage with fuzzy matching (0.2) + semantic similarity (0.2). Missing signals are dropped and weights renormalised. Change `FUSION_WEIGHTS` or set `SCORING_MODE=llm` in `.env`. The report states no accuracy figure, so none is claimed; use the Accuracy page with 30+ faculty-approved questions to measure and tune.

## Notes
- Results are JSON files in `backend/api_results/`. Interrupted jobs restart at launch; Retry re-runs only unscored questions.
- Small local models on CPU can take 1-3 minutes per question. If too slow, use `OLLAMA_MODEL=qwen2.5:1.5b` or `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` in `.env` (the key stays on the server).
- Set `TEACHER_NAME` in `.env` for the dashboard greeting.
- Research prototype: AI marks are suggestions and a teacher must verify every grade.

## API
`POST /api/extract`, `POST /api/split`, `POST /api/evaluate` (202 + job_id), `GET /api/result/<id>`, `GET /api/jobs`, `POST /api/retry/<id>`, `POST /api/faculty/<id>`, `GET /api/metrics`, `GET /api/status`
