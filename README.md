# Health Sync

An offline, local-first AI assistant that reduces clinical documentation burden by auto-generating SOAP notes from doctor-patient conversations.

## What it does

- Transcribes consultations in real time (MLX Whisper)
- Uses a multi-agent LLM pipeline (MedGemma, Llama 3, Gemma 2B) to draft structured SOAP notes
- Grounds notes in clinical guidelines via RAG (ChromaDB)
- Generates Medical Certificates from validated notes
- Runs fully offline — no data ever leaves the device

## Notable design choice

If a SOAP note fails validation, doctors can't edit it directly — they submit an addendum that re-invokes the model, while the original note stays immutable. This preserves a clean audit trail instead of silent edits.

## Tech Stack

Python · FastAPI · MLX Whisper · MedGemma / Llama 3 / Gemma 2B · ChromaDB · SQLite · Vanilla JS

## Setup

```bash
git clone https://github.com/danishinno/clinical-ai-EHR.git
cd clinical-ai-EHR
pip install -r requirements.txt
uvicorn main:app --reload
```

## Author

Ahmad Danish Bin Zakaria — Final Year CS (AI), UTeM
ahmaddanish040121@gmail.com
