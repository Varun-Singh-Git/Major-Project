# Automatic Grading of Short Handwritten Answers

Web app for the B.Tech Phase-I project (IILM University). Pipeline, following the reference diagram:
**teacher answer-key PDF + student handwritten-answer PDF (each with all questions) -> text (PDF text layer or Tesseract OCR) -> split by question number and matched -> editable review table -> rubric-weighted local LLM scoring per question (async job) -> three result sheets (AI Evaluation, AI Score Justification, Faculty Evaluation).**

Scores come only from the LLM you configure. If OCR or the LLM is unavailable, the app shows an error; it never fabricates marks.

## Requirements
- Python 3.10+
- Tesseract OCR (system install)
- Ollama with a model (default `qwen2.5:3b`, offline) **or** an Anthropic API key

## Setup
```bash
# 1. Tesseract
#   Windows: install from https://github.com/UB-Mannheim/tesseract/wiki, then set TESSERACT_CMD in .env
#   macOS:   brew install tesseract
#   Ubuntu:  sudo apt install tesseract-ocr

# 2. Local LLM (offline)
ollama pull qwen2.5:3b

# 3. Python deps
python -m venv venv && source venv/bin/activate     # Windows: venv\Scripts\activate
pip install -r backend/requirements.txt

# 4. Config
cp .env.example .env        # edit if needed; never commit .env
```

## Run
```bash
python backend/app.py
```
Open http://127.0.0.1:5000 (the backend serves the frontend; no Node build step). Status chips at the top show whether OCR and the LLM are ready.

## Using a cloud LLM instead
In `.env` set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...`. The key stays on the server and is never sent to the browser.

## How to prepare the PDFs
- **Teacher PDF:** one PDF with every question and its model answer. Start each question with `Q1.`, `Q2.`, `Question 3:` (or `Ans 1`). Optionally write marks like `(3 marks)` or `[2 marks]`; otherwise a default of 5 is used and you can edit it in the table.
- **Student PDF:** the student's answers, each starting with the same question number (`Q1.`, `Q2.` ...). Unanswered questions score 0 without calling the LLM.
- Digital PDFs are read directly. Scanned or photographed PDFs are read with Tesseract OCR (limit: 20 pages, 10 MB).
- After upload, check the review table: if the splitter got a boundary wrong, edit the text or marks before grading. Rubric weights (default 40/30/20/10) must add up to 100; each question's marks are shared by those weights.

## Scoring method (model fusion, as the report proposes)
The report's literature review argues for combining several techniques rather than relying on one. Each question's final marks fuse:
1. **LLM rubric score** (default weight 0.6): the local LLM scores your weighted rubrics and explains why.
2. **Concept coverage** (0.2): share of the model answer's content words found in the student answer, with fuzzy matching so OCR slips do not cost marks.
3. **Semantic similarity** (0.2): embedding cosine similarity between model and student answers. Needs `ollama pull nomic-embed-text`; if unavailable it is skipped and the other weights are renormalised.

Set `SCORING_MODE=llm` for LLM-only. Weights live in `FUSION_WEIGHTS`. The Justification tab shows each component per question.

## Measuring accuracy
The report states no accuracy figures, so this app does not claim any. Instead, enter faculty marks in the **Faculty Evaluation** tab, then open the **Accuracy** tab. It compares Fusion, LLM-only and Concept-coverage-only against the faculty marks (average error in marks and %, RMSE, within-10% agreement, Pearson r, quadratic weighted kappa). Use 30+ reviewed questions, tune `FUSION_WEIGHTS`, and report whichever configuration agrees best with your teachers. Compare against any baseline figure from your own literature on the same kind of data.

## Notes
- Results are JSON files in `backend/api_results/`, one per student, with every question's scores. Jobs left "Processing" after a shutdown restart on next launch; Retry re-runs only the unscored questions.
- Tesseract reads printed text well but struggles with cursive handwriting. Always review the extracted text; swapping in an HTR model (e.g. TrOCR) is a natural extension in `/api/ocr`.
- Small local models (3B) can be inconsistent graders. AI marks are suggestions; the Faculty Evaluation sheet (per-question marks) is for the teacher's final marks.
- Works immediately: UI, validation, digital-PDF reading, splitting, job tracking, faculty review. Needs configuration: Tesseract (scans) and an LLM (scoring).

## API
`POST /api/ocr`, `POST /api/split`, `POST /api/evaluate` (202 + job_id), `GET /api/result/<id>`, `GET /api/jobs`, `POST /api/retry/<id>`, `POST /api/faculty/<id>`, `GET /api/status`
