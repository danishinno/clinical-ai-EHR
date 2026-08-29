import multiprocessing
import os
from dotenv import load_dotenv
load_dotenv()

from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List

try:
    import mlx_whisper
    HAS_MLX_WHISPER = True
except Exception:
    mlx_whisper = None
    HAS_MLX_WHISPER = False

import numpy as np

try:
    import ollama
    HAS_OLLAMA = True
except Exception:
    ollama = None
    HAS_OLLAMA = False

import json
import chromadb
import uuid
import bcrypt
import asyncio
from database import init_db, query_db
from datetime import datetime

#database schema mapping
init_db()

import collections
import sys

log_history = collections.deque(maxlen=300)
log_websockets = set()
main_loop = None

class TerminalLogRedirector:
    def __init__(self, original):
        self.original = original

    def write(self, data):
        self.original.write(data)
        if data.strip():
            msg = data.strip()
            log_history.append(msg)
            if log_websockets and main_loop:
                try:
                    main_loop.call_soon_threadsafe(
                        lambda: asyncio.create_task(broadcast_log(msg))
                    )
                except Exception:
                    pass

    def flush(self):
        self.original.flush()

    def isatty(self):
        return getattr(self.original, "isatty", lambda: False)()

    def __getattr__(self, attr):
        return getattr(self.original, attr)

async def broadcast_log(msg: str):
    for ws in list(log_websockets):
        try:
            await ws.send_text(msg)
        except Exception:
            pass

sys.stdout = TerminalLogRedirector(sys.stdout)
sys.stderr = TerminalLogRedirector(sys.stderr)

chroma_client = chromadb.PersistentClient(path="./medical_knowledge")
collection = chroma_client.get_or_create_collection(name="clinical_docs")
@asynccontextmanager
async def lifespan(app: FastAPI):
    global main_loop
    main_loop = asyncio.get_running_loop()
    print("🚀 Live backend log monitor engine started and streaming...")
    ingest_specialized_protocols()
    yield

app = FastAPI(lifespan=lifespan)

def call_llm_api(messages, preferred_model="llama3", json_format=False) -> str:
    # 1. Check Cloud API Key (for Render Cloud deployment)
    groq_api_key = os.getenv("GROQ_API_KEY") or os.getenv("OPENAI_API_KEY")
    if groq_api_key:
        try:
            # pyrefly: ignore [missing-import]
            from openai import OpenAI
            base_url = "https://api.groq.com/openai/v1" if os.getenv("GROQ_API_KEY") else None
            client = OpenAI(api_key=groq_api_key, base_url=base_url)
            model_name = "llama-3.3-70b-versatile" if os.getenv("GROQ_API_KEY") else "gpt-4o-mini"
            kwargs = {"model": model_name, "messages": messages}
            if json_format:
                kwargs["response_format"] = {"type": "json_object"}
            res = client.chat.completions.create(**kwargs)
            if res.choices and res.choices[0].message.content:
                return res.choices[0].message.content
        except Exception as cloud_err:
            print(f" [Clinical Brain] Cloud API Error: {cloud_err}")

    # 2. Check Local Ollama Installed Tags
    if HAS_OLLAMA and ollama is not None:
        installed_models = []
        try:
            import requests
            r = requests.get("http://127.0.0.1:11434/api/tags", timeout=1.5)
            if r.status_code == 200:
                installed_models = [m["name"] for m in r.json().get("models", [])]
        except Exception:
            pass

        if installed_models:
            # Match preferred model against installed tags
            matched_model = None
            pref_clean = preferred_model.split(":")[0].lower()
            
            for im in installed_models:
                if im == preferred_model or im.startswith(preferred_model + ":"):
                    matched_model = im
                    break
                if pref_clean in im.lower():
                    matched_model = im
                    break

            if not matched_model:
                gemma_models = [m for m in installed_models if "gemma" in m]
                matched_model = gemma_models[0] if gemma_models else installed_models[0]

            try:
                kwargs = {"model": matched_model, "messages": messages}
                if json_format:
                    kwargs["format"] = "json"
                res = ollama.chat(**kwargs)
                if res and "message" in res and "content" in res["message"]:
                    return res["message"]["content"]
            except Exception as oe:
                print(f" [Clinical Brain] Ollama execution error on {matched_model}: {oe}")

    # 3. Safe Fallback Response if AI is offline
    if json_format:
        return json.dumps({
            "name": None, "age": None, "ic_number": None,
            "subjective": "AI service offline. Please start local Ollama or set GROQ_API_KEY.",
            "objective": None, "assessment": None, "plan": None
        })
    
    return (
        "Clinical Brain is currently offline or unreachable. "
        "Please ensure Ollama is running locally on your Mac (`ollama serve`) "
        "or set `GROQ_API_KEY` in environment variables for cloud deployment."
    )


def ingest_specialized_protocols():
    protocols_dir = "./medical_knowledge/protocols"
    if not os.path.exists(protocols_dir):
        return
    for fname in os.listdir(protocols_dir):
        if fname.endswith(".json"):
            filepath = os.path.join(protocols_dir, fname)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    protocols_data = json.load(f)
                new_count = 0
                skip_count = 0
                for item in protocols_data:
                    doc_id = f"protocol_{uuid.uuid5(uuid.NAMESPACE_DNS, json.dumps(item))}"
                    doc_str = json.dumps(item, indent=2)
                    # Deduplication: skip if already in ChromaDB (avoids silent exception on every restart)
                    try:
                        existing = collection.get(ids=[doc_id])
                        if existing and existing.get("ids"):
                            skip_count += 1
                            continue
                    except Exception:
                        pass
                    try:
                        collection.add(
                            documents=[doc_str],
                            metadatas=[{"type": "specialized_protocol", "filename": fname, "condition": item.get("condition", "General Protocol")}],
                            ids=[doc_id]
                        )
                        new_count += 1
                    except Exception:
                        pass
                if new_count > 0:
                    print(f"✅ Ingested {new_count} new protocol(s) from: {fname} ({skip_count} already indexed, skipped)")
                else:
                    print(f"ℹ️  Protocol file already fully indexed: {fname} ({skip_count} entries)")
            except Exception as e:
                print(f"⚠️ Protocol ingestion note for {fname}: {e}")




app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "online", "message": "Clinical AI EHR API is running successfully!"}


# Remove global Whisper model initialization since mlx-whisper handles model loading dynamically

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return plain == hashed

# PYDANTIC MODEL SCHEMAS
class ClinicalQuery(BaseModel):
    doctor_id: int
    transcript: str
    ic_number: Optional[str] = None
    patient_id: Optional[int] = None
    language: Optional[str] = "en"

class PatientRegisterQuery(BaseModel):
    patient_name: str
    age: int
    gender: str
    ic_number: str
    doctor_id: Optional[int] = None

class PatientReassignQuery(BaseModel):
    patient_id: int
    doctor_id: int

class AuthQuery(BaseModel):
    username: str
    password: str

class SignupQuery(BaseModel):
    username: str
    password: str
    first_name: str
    last_name: str
    id_number: str

class ApproveQuery(BaseModel):
    doctor_id: int

class ProfileUpdateQuery(BaseModel):
    username: str
    password: str
    first_name: str
    last_name: str
    id_number: str
    specialty: str

class UpdateNotesQuery(BaseModel):
    encounter_id: int
    doc_id: Optional[str] = None
    updated_notes: Optional[dict] = None
    patient_name: str
    additional_notes: Optional[str] = None

class SaveEncounterQuery(BaseModel):
    doctor_id: int
    patient_id: Optional[int] = None
    transcript: str = ""
    structured_notes: dict

class RefineNotesQuery(BaseModel):
    current_notes: dict
    additional_text: str


class GuidelineQuery(BaseModel):
    user_question: str
    transcript: str
    doctor_id: Optional[int] = None
    patient_id: Optional[int] = None
    history: List[dict] = []
    language: Optional[str] = "en"

class CertificateQuery(BaseModel):
    encounter_id: int
    doctor_id: int
    days_rest: Optional[int] = None

class SaveCertificateQuery(BaseModel):
    serial_number: str
    encounter_id: int
    patient_id: int
    doctor_id: int
    patient_name: str
    ic_number: Optional[str] = ""
    diagnosis: str
    rest_start: str
    rest_end: str
    days_issued: int
    html_content: str

# PHASE 1: ASYNCHRONOUS LIVE DICTATION
@app.websocket("/live-transcribe")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    lang = websocket.query_params.get("lang", "en")
    print(f"Frontend connected: Live dictation started (Language mode: {lang}).")
    audio_buffer = np.array([], dtype=np.float32)

    def run_transcribe(buffer_data):
        if not HAS_MLX_WHISPER or mlx_whisper is None:
            print("⚠️ [Live Transcribe] mlx_whisper is not loaded/installed in the current environment.")
            return {"text": "", "segments": []}

        # 1. Volume Noise Gate (RMS Energy threshold)
        rms = np.sqrt(np.mean(buffer_data**2))
        print(f" Audio Chunk RMS Energy: {rms:.6f}")
        if rms < 0.003:
            return {"text": "", "segments": []}

        transcribe_lang = "ms" if lang == "ms" else "en"
        initial_prompt = (
            "Perbualan klinikal doktor dan pesakit dalam Bahasa Melayu atau Bahasa Inggeris. "
            "Pesakit: Saya rasa sakit dada, pening kepala, demam, kencing manis, darah tinggi. Ubat..."
            if lang == "ms" else
            "A clinical medical consultation in English. Patient: I have chest pain. Doctor: How long have you had this chest pain? Keywords: stable angina, chest discomfort, tightness, squeezing, physical exertion, shortness of breath, high cholesterol, heart attack."
        )

        try:
            result = mlx_whisper.transcribe(
                buffer_data,
                path_or_hf_repo="mlx-community/whisper-small-mlx-8bit",
                temperature=0.0,
                language=transcribe_lang,
                initial_prompt=initial_prompt
            )
            return result
        except Exception as e:
            print(f" [Live Transcribe] Transcription error: {e}")
            return {"text": "", "segments": []}

    try:
        while True:
            data = await websocket.receive_bytes()
            chunk_np = np.frombuffer(data, dtype=np.float32)
            audio_buffer = np.concatenate((audio_buffer, chunk_np))

            if len(audio_buffer) >= 32000:
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(
                    None,
                    run_transcribe,
                    audio_buffer
                )
                
                # 2. No-Speech Probability Segment Filtering
                valid_texts = []
                if isinstance(result, dict):
                    segments = result.get("segments", [])
                    if isinstance(segments, list):
                        for seg in segments:
                            if isinstance(seg, dict):
                                no_speech_prob = seg.get("no_speech_prob", 0.0)
                                # Ignore segments with high no-speech probability to prevent silent hallucinations
                                if no_speech_prob < 0.65:
                                    text = seg.get("text", "")
                                    if text:
                                        valid_texts.append(text.strip())
                            elif isinstance(seg, str):
                                valid_texts.append(seg.strip())
                    elif isinstance(segments, str):
                        valid_texts.append(segments.strip())

                    # Fallback to result["text"] if valid_texts is empty but text exists
                    if not valid_texts and result.get("text"):
                        valid_texts.append(str(result["text"]).strip())
                elif isinstance(result, str):
                    valid_texts.append(result.strip())
                
                transcript_chunk = " ".join(filter(None, valid_texts)).strip()

                if transcript_chunk:
                    print(f"🗣️ Live Heard: {transcript_chunk}")
                    await websocket.send_text(transcript_chunk)
                
                audio_buffer = np.array([], dtype=np.float32)

    except WebSocketDisconnect:
        print("Frontend disconnected: Dictation stopped.")
    except Exception as e:
        print(f"WebSocket Error: {e}")

# PHASE 2: CLINICAL ENCOUNTER EXTRACTION
@app.post("/process-dictation")
async def process_dictation(query: ClinicalQuery):
    print(f"\n -------------------------------------------------------------")
    print(f" [Dictation Scribe] Processing transcript (Lang: {query.language}) for Doctor ID: {query.doctor_id} | Active Patient ID: {query.patient_id}")
    print(f" -------------------------------------------------------------")
    
    # Check if a pre-assigned patient is active
    active_patient = None
    if query.patient_id:
        active_patient = query_db("SELECT * FROM patients WHERE id = ?", (query.patient_id,), one=True)
    
    system_prompt = """
    You are an expert clinical scribe. Read the transcript between a doctor and patient.
    Extract the patient details and output ONLY a valid JSON object in the SOAP format.
    If a detail is not mentioned in the transcript, set its value to null.

    CRITICAL INSTRUCTION FOR MULTI-LANGUAGE CONSULTATION:
    The input transcript may be spoken in Bahasa Melayu, English, or a mix of both (Manglish).
    You MUST translate all symptoms, patient complaints, clinical examinations, diagnoses, and treatment plans into standard English medical terminology.
    The output JSON SOAP note MUST BE WRITTEN ENTIRELY IN ENGLISH.

    CRITICAL: You are a STRICT data extraction scribe. NEVER invent or infer a diagnosis.
    Use exactly these keys:
    {
        "name": "Patient's name",
        "age": "Patient's age as an integer",
        "ic_number": "IC or identity passport number if spoken, otherwise null",
        "subjective": "Patient's condition in their own words, complaint, and history (in English)",
        "objective": "Objective observations, vital signs, physical exam findings (in English)",
        "assessment": "Medical diagnosis or clinician's assessment (in English)",
        "plan": "Treatment plan, medications, follow-up instructions (in English)"
    }
    """

    try:
        print("[Dictation Scribe] Calling LLM for JSON SOAP note extraction...")
        raw_llm_content = call_llm_api([
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': query.transcript}
        ], preferred_model='medgemma', json_format=True)

        extracted_notes = json.loads(raw_llm_content)
        
        if active_patient:
            patient_name = active_patient["patient_name"]
            patient_age = active_patient["age"]
            ic_num = active_patient["ic_number"]
            patient_id = active_patient["id"]
            # Override LLM extracted demographics with exact database values
            extracted_notes["name"] = patient_name
            extracted_notes["age"] = patient_age
            extracted_notes["ic_number"] = ic_num
        else:
            patient_name = extracted_notes.get("name") or "Unknown Patient"
            patient_age = extracted_notes.get("age") or None
            ic_num = query.ic_number or extracted_notes.get("ic_number") or f"TEMP-{uuid.uuid4().hex[:6].upper()}"

            patient = query_db("SELECT id FROM patients WHERE ic_number = ?", (ic_num,), one=True)
            if not patient:
                patient_id = query_db(
                    "INSERT INTO patients (doctor_id, patient_name, age, ic_number, created_at) VALUES (?, ?, ?, ?, ?)",
                    (query.doctor_id, patient_name, patient_age, ic_num, datetime.now().isoformat()),
                    commit=True
                )
            else:
                patient_id = patient['id']

        # Clear the queue status of the patient to complete the consultation
        query_db("UPDATE patients SET queue_status = 'completed' WHERE id = ?", (patient_id,), commit=True)

        doc_id = str(uuid.uuid4())
        document_text = f"Raw Transcript: {query.transcript}\n\nStructured Notes: {json.dumps(extracted_notes)}"

        print(" [Dictation Scribe] Indexing encounter documents in ChromaDB collection...")
        collection.add(
            documents=[document_text],
            metadatas=[{"patient_name": patient_name, "type": "encounter"}],
            ids=[doc_id]
        )

        print(" [Dictation Scribe] Inserting new consultation row in encounters table...")
        encounter_id = query_db(
            "INSERT INTO encounters (patient_id, doctor_id, transcript, structured_notes_json, doc_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (patient_id, query.doctor_id, query.transcript, json.dumps(extracted_notes), doc_id, datetime.now().isoformat()),
            commit=True
        )

        extracted_notes["_patient_id"] = patient_id
        extracted_notes["_encounter_id"] = encounter_id
        extracted_notes["_doc_id"] = doc_id
        print(f" [Dictation Scribe] Done! Extracted SOAP notes for: {patient_name} (ID: {patient_id}) in encounter {encounter_id}")
        return extracted_notes

    except Exception as e:
        print(f" [Dictation Scribe] Error during extraction: {e}")
        return {"error": "Failed to process data with medgemma."}

@app.put("/encounter/{encounter_id}/notes")
async def update_encounter_notes(encounter_id: int, query: UpdateNotesQuery):
    print(f"\n -------------------------------------------------------------")
    print(f" [Encounter Update] Edit request for Encounter ID: {encounter_id} | Patient Name: {query.patient_name}")
    print(f" -------------------------------------------------------------")
    try:
        existing = query_db("SELECT structured_notes_json, is_finalized, additional_notes FROM encounters WHERE id = ?", (encounter_id,), one=True)
        if not existing:
            return {"success": False, "message": "Encounter not found."}

        # Case 1: Saving additional notes (addendum)
        if query.additional_notes is not None:
            print(f" [Encounter Update] Appending addendum to Encounter ID {encounter_id}...")
            query_db(
                "UPDATE encounters SET additional_notes = ? WHERE id = ?",
                (query.additional_notes, encounter_id),
                commit=True
            )
            if query.doc_id:
                document_text = f"Structured Notes: {existing['structured_notes_json']}\n\nAddendum: {query.additional_notes}"
                try:
                    collection.update(
                        ids=[query.doc_id],
                        documents=[document_text],
                        metadatas=[{"patient_name": query.patient_name, "type": "encounter"}]
                    )
                except Exception as chroma_err:
                    print(f"⚠️ [Encounter Update] ChromaDB update error: {chroma_err}")
            return {"success": True, "message": "Addendum notes saved successfully."}

        # Case 2: Editing SOAP notes
        if query.updated_notes is not None:
            if existing['is_finalized'] == 1:
                print(f" [Encounter Update] Blocked modification attempt on finalized SOAP notes for Encounter ID {encounter_id}.")
                return {"success": False, "message": "Security compliance block: Finalized consultation notes cannot be altered. You may only append addendums."}

            notes_to_save = {k: v for k, v in query.updated_notes.items() if not k.startswith('_')}

            query_db(
                "UPDATE encounters SET structured_notes_json = ?, is_finalized = 1 WHERE id = ?",
                (json.dumps(notes_to_save), encounter_id),
                commit=True
            )

            if query.doc_id:
                document_text = f"Structured Notes (Finalized): {json.dumps(notes_to_save)}"
                try:
                    collection.update(
                        ids=[query.doc_id],
                        documents=[document_text],
                        metadatas=[{"patient_name": query.patient_name, "type": "encounter"}]
                    )
                except Exception as chroma_err:
                    print(f"⚠️ [Encounter Update] ChromaDB update error: {chroma_err}")

            print(f" [Encounter Update] Notes updated and finalized successfully. ORIGINAL consultation timeframe preserved.")
            return {"success": True, "message": "Encounter notes updated and finalized successfully."}

        return {"success": False, "message": "No updates requested."}
    except Exception as e:
        print(f" [Encounter Update] Edit failed: {e}")
        return {"success": False, "message": str(e)}

@app.post("/encounter/refine")
async def refine_encounter_notes(query: RefineNotesQuery):
    print(f"\n -------------------------------------------------------------")
    print(f" [Clinical Refiner] Refining SOAP notes with additional text...")
    print(f" -------------------------------------------------------------")
    
    system_prompt = """
    You are a clinical AI assistant. You are given the current structured SOAP note in JSON format, and some additional details or corrections provided by the physician.
    Your task is to merge the additional details into the correct categories (Subjective, Objective, Assessment, or Plan) of the existing SOAP note.
    
    Guidelines:
    1. Do not lose or erase any existing clinical details unless the additional text explicitly contradicts or corrects them (e.g. changing blood pressure value or dosage).
    2. Place new symptoms under 'subjective', physical signs/vitals under 'objective', diagnoses under 'assessment', and therapies/drugs/follow-up instructions under 'plan'.
    3. Keep the output formatted strictly as a JSON object with these keys: "name", "age", "gender", "subjective", "objective", "assessment", "plan".
    4. Do not include any explanation or meta-text. Return ONLY the JSON object.
    """
    
    user_content = f"""
    Current SOAP Note:
    {json.dumps(query.current_notes, indent=2)}
    
    Additional Details / Corrections:
    "{query.additional_text}"
    """
    
    try:
        raw_llm_content = call_llm_api([
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_content}
        ], preferred_model='medgemma', json_format=True)
        updated_notes = json.loads(raw_llm_content)
        print(" [Clinical Refiner] Refinement complete.")
        return {"success": True, "updated_notes": updated_notes}
    except Exception as e:
        print(f" [Clinical Refiner] Error during refinement: {e}")
        return {"success": False, "message": str(e)}

@app.post("/encounter/save")
async def save_encounter(query: SaveEncounterQuery):
    print(f"\n -------------------------------------------------------------")
    print(f" [Manual Save] Doctor ID {query.doctor_id} requested manual consultation save for Patient ID: {query.patient_id}")
    print(f" -------------------------------------------------------------")
    try:
        patient_id = query.patient_id
        active_patient = None
        if patient_id:
            active_patient = query_db("SELECT * FROM patients WHERE id = ?", (patient_id,), one=True)

        notes_to_save = {k: v for k, v in query.structured_notes.items() if not k.startswith('_')}

        if active_patient:
            patient_name = active_patient["patient_name"]
            patient_age = active_patient["age"]
            ic_num = active_patient["ic_number"]
            notes_to_save["name"] = patient_name
            notes_to_save["age"] = patient_age
            notes_to_save["ic_number"] = ic_num
        else:
            patient_name = notes_to_save.get("name") or "Unknown Patient"
            patient_age = notes_to_save.get("age") or None
            ic_num = notes_to_save.get("ic_number") or f"TEMP-{uuid.uuid4().hex[:6].upper()}"

            patient = query_db("SELECT id FROM patients WHERE ic_number = ?", (ic_num,), one=True)
            if not patient:
                patient_id = query_db(
                    "INSERT INTO patients (doctor_id, patient_name, age, ic_number, created_at) VALUES (?, ?, ?, ?, ?)",
                    (query.doctor_id, patient_name, patient_age, ic_num, datetime.now().isoformat()),
                    commit=True
                )
            else:
                patient_id = patient['id']

        query_db("UPDATE patients SET queue_status = 'completed' WHERE id = ?", (patient_id,), commit=True)

        doc_id = str(uuid.uuid4())
        document_text = f"Raw Transcript: {query.transcript or 'Manually entered clinical note.'}\n\nStructured Notes: {json.dumps(notes_to_save)}"

        try:
            print(" [Manual Save] Adding record to ChromaDB guideline pipeline collection...")
            collection.add(
                documents=[document_text],
                metadatas=[{"patient_name": patient_name, "type": "encounter"}],
                ids=[doc_id]
            )
        except Exception as chroma_err:
            print(f" [Manual Save] ChromaDB write error: {chroma_err}")

        print(" [Manual Save] Inserting new consultation row in encounters database table...")
        encounter_id = query_db(
            "INSERT INTO encounters (patient_id, doctor_id, transcript, structured_notes_json, doc_id, created_at, is_finalized) VALUES (?, ?, ?, ?, ?, ?, 1)",
            (patient_id, query.doctor_id, query.transcript or "Manually entered clinical note.", json.dumps(notes_to_save), doc_id, datetime.now().isoformat()),
            commit=True
        )

        print(f" [Manual Save] Done! Encounter {encounter_id} saved successfully for Patient: {patient_name} (ID: {patient_id})")
        return {
            "success": True,
            "message": "Encounter saved successfully.",
            "encounter_id": encounter_id,
            "doc_id": doc_id,
            "patient_id": patient_id
        }

    except Exception as e:
        print(f" [Manual Save] Failed to save encounter manually: {e}")
        return {"success": False, "message": str(e)}


# PHASE 3: CONTEXT-AWARE CLINICAL DECISION SUPPORT
ADMIN_KEYWORDS = ["list", "who are", "how many", "my patients", "my patient list", "total patients"]

def classify_intent(question: str) -> str:
    q = question.lower()
    if any(kw in q for kw in ADMIN_KEYWORDS):
        return "ADMIN"
    return "CLINICAL"

@app.post("/ask-guidelines")
async def ask_guidelines(query: GuidelineQuery):
    question_text = query.user_question
    lower_q = question_text.lower()

    if not question_text:
        return {"answer": "Error: Empty question provided."}

    print(f"\n -------------------------------------------------------------")
    print(f" [Clinical Brain] Received query: '{question_text}'")
    print(f" [Clinical Brain] Doctor ID: {query.doctor_id} | Active Patient ID: {query.patient_id}")
    print(f" -------------------------------------------------------------")

    doctor_profile = None
    if query.doctor_id:
        doc_rows = query_db(
            "SELECT first_name, last_name, specialty FROM users WHERE id = ?",
            (query.doctor_id,)
        )
        if doc_rows:
            doctor_profile = doc_rows[0]
            print(f" [Clinical Brain] Active Clinician: Dr. {doctor_profile['first_name']} {doctor_profile['last_name']} ({doctor_profile['specialty']})")

    patient_profile = None
    if query.patient_id:
        pat_rows = query_db(
            "SELECT patient_name, age, gender, ic_number FROM patients WHERE id = ?",
            (query.patient_id,)
        )
        if pat_rows:
            patient_profile = pat_rows[0]
            print(f" [Clinical Brain] Active Patient: {patient_profile['patient_name']} (Age: {patient_profile['age']}, Gender: {patient_profile['gender']})")

    encounters = []
    my_patients_data = "No patients found for this doctor."

    if query.doctor_id:
        print(" [Clinical Brain] Loading authorized encounters and active queue patients...")
        # Fetch encounters for all patients assigned to this doctor or treated by them in the past
        # Includes the treating doctor's names
        encounters = query_db(
            """SELECT e.id, e.patient_id, p.patient_name, e.created_at, e.structured_notes_json, e.doc_id,
                      u.first_name as doc_first, u.last_name as doc_last
               FROM encounters e 
               JOIN patients p ON e.patient_id = p.id 
               JOIN users u ON e.doctor_id = u.id
               WHERE p.id IN (
                   SELECT id FROM patients WHERE doctor_id = ? AND queue_status = 'on_hold'
                   UNION
                   SELECT patient_id FROM encounters WHERE doctor_id = ?
               )
               ORDER BY e.created_at DESC""",
            (query.doctor_id, query.doctor_id)
        )
        
        # Get active patients in queue
        current_patients = query_db(
            "SELECT id, patient_name, age, gender, ic_number FROM patients WHERE doctor_id = ? AND queue_status = 'on_hold'",
            (query.doctor_id,)
        )
        
        # Format my_patients_data for ADMIN queries and listing
        lines = []
        if current_patients:
            lines.append("**Current Active Patients (in Queue):**")
            for p in current_patients:
                # Find if they have been treated by other doctors in the past
                past_drs = query_db(
                    """SELECT DISTINCT u.first_name, u.last_name 
                       FROM encounters e JOIN users u ON e.doctor_id = u.id 
                       WHERE e.patient_id = ?""",
                    (p['id'],)
                )
                dr_names = [f"Dr. {dr['first_name']} {dr['last_name']}" for dr in past_drs]
                dr_str = f" | Treated previously by: {', '.join(dr_names)}" if dr_names else ""
                lines.append(f"- {p['patient_name']} (Age: {p['age']}, IC: {p['ic_number']}){dr_str} [ACTIVE]")
        
        # Get distinct past patients treated by this doctor
        past_patients_summary = query_db(
            """SELECT DISTINCT p.id, p.patient_name, p.ic_number 
               FROM encounters e JOIN patients p ON e.patient_id = p.id 
               WHERE e.doctor_id = ?""",
            (query.doctor_id,)
        )
        
        if past_patients_summary:
            if lines:
                lines.append("")
            lines.append("**Past Patients (Treated previously by you or others):**")
            for p in past_patients_summary:
                # Find all doctors who have ever treated this patient
                all_drs = query_db(
                    """SELECT DISTINCT u.first_name, u.last_name 
                       FROM encounters e JOIN users u ON e.doctor_id = u.id 
                       WHERE e.patient_id = ?""",
                    (p['id'],)
                )
                dr_names = [f"Dr. {dr['first_name']} {dr['last_name']}" for dr in all_drs]
                dr_str = f" (Treated by: {', '.join(dr_names)})" if dr_names else ""
                lines.append(f"- {p['patient_name']} (IC: {p['ic_number']}){dr_str} [PAST]")
                
        my_patients_data = "\n".join(lines) if lines else "No patients found for this doctor."

    if any(phrase in lower_q for phrase in ["list my patients", "who are my patients"]):
        print(" [Clinical Brain] Classified intent: ADMIN (listing patients)")
        print(" [Clinical Brain] Returning patient lists directly.")
        return {"answer": f"**Your Registered Patients Visit Log:**\n\n{my_patients_data}"}

    intent = classify_intent(question_text)
    print(f" [Clinical Brain] Classified intent: {intent}")

    if intent == "ADMIN":
    # -----------------------------------------------------------------
        lang_rule = (
            "Answer in professional Bahasa Melayu using the provided PATIENTS context."
            if getattr(query, 'language', 'en') == 'ms' else
            "Answer in English using the provided PATIENTS context."
        )
        gemma_system_prompt = f"""You are an admin assistant. Answer the question using ONLY the provided PATIENTS list context.
        Note: Patients marked with '[ACTIVE]' are active patients in the queue. Patients marked with '[PAST]' are past patients.
        {lang_rule}"""
        gemma_user_prompt = f"PATIENTS:\n{my_patients_data}\n\nQUESTION:\n{question_text}"
        print(" [Clinical Brain] Dispatching ADMIN query to LLM...")
        content = call_llm_api([
            {'role': 'system', 'content': gemma_system_prompt},
            {'role': 'user', 'content': gemma_user_prompt}
        ], preferred_model='gemma:2b').strip()
        print(" [Clinical Brain] ADMIN response generated successfully.")
        return {"answer": content}

    current_patient_history = []
    if query.patient_id:
        print(f" [Clinical Brain] Loading dedicated past history for active patient ID {query.patient_id}...")
        current_patient_history = query_db(
            """SELECT e.id, e.patient_id, p.patient_name, e.created_at, e.structured_notes_json, e.doc_id,
                      u.first_name as doc_first, u.last_name as doc_last
               FROM encounters e 
               JOIN patients p ON e.patient_id = p.id 
               JOIN users u ON e.doctor_id = u.id
               WHERE e.patient_id = ? ORDER BY e.created_at DESC""",
            (query.patient_id,)
        )

    active_patient_history_docs = []
    if current_patient_history:
        for enc in current_patient_history:
            doc_name = f"Dr. {enc['doc_first']} {enc['doc_last']}" if enc['doc_first'] else "Unknown Practitioner"
            active_patient_history_docs.append(
                f"--- RECORD FOR ACTIVE PATIENT {enc['patient_name']} "
                f"(Treated by {doc_name} on {enc['created_at'][:10]}) ---\n"
                f"{enc['structured_notes_json']}"
            )

    other_patients_history_docs = []
    other_encounters = [enc for enc in encounters if not (query.patient_id and enc['patient_id'] == query.patient_id)]
    
    prioritized_other_encounters = []
    regular_other_encounters = []
    for enc in other_encounters:
        if enc['patient_name'] and enc['patient_name'].lower() in lower_q:
            prioritized_other_encounters.append(enc)
        else:
            regular_other_encounters.append(enc)
            
    selected_other_encounters = (prioritized_other_encounters + regular_other_encounters)[:6]
    
    if selected_other_encounters:
        for enc in selected_other_encounters:
            doc_name = f"Dr. {enc['doc_first']} {enc['doc_last']}" if enc['doc_first'] else "Unknown Practitioner"
            other_patients_history_docs.append(
                f"--- RECORD FOR PAST PATIENT {enc['patient_name']} "
                f"(Treated by {doc_name} on {enc['created_at'][:10]}) ---\n"
                f"{enc['structured_notes_json']}"
            )

    guideline_docs = []
    try:
        print(" [Clinical Brain] Querying ChromaDB guidelines & protocols Vector Store...")
        results = collection.query(query_texts=[question_text], n_results=6)
        docs = (results.get('documents') or [[]])[0] if results else []
        metas = (results.get('metadatas') or [[]])[0] if results else []
        if docs:
            if not metas or len(metas) < len(docs):
                metas = (metas or []) + [{}] * (len(docs) - len(metas or []))
            for doc, meta in zip(docs, metas):
                if meta and meta.get("type") in ["guideline", "specialized_protocol"]:
                    source_label = meta.get("filename") or meta.get("condition") or "Medical Practice Guideline"
                    guideline_docs.append(f"Source Protocol/Guideline ({source_label}):\n{doc}")
    except Exception as ce:
        print(f" [Clinical Brain] Chroma Query Error: {ce}")

    compiled_active_history = "\n\n".join(active_patient_history_docs) if active_patient_history_docs else "No past records found for this active patient."
    compiled_other_history = "\n\n".join(other_patients_history_docs) if other_patients_history_docs else "No historical records for other patients."
    compiled_guidelines = "\n\n---\n\n".join(guideline_docs)

    doc_info_str = "Unknown Clinician"
    if doctor_profile:
        doc_info_str = f"Dr. {doctor_profile['first_name']} {doctor_profile['last_name']} (Specialty: {doctor_profile['specialty']})"

    if patient_profile:
        pat_info_str = f"{patient_profile['patient_name']} (Age: {patient_profile['age']}, Gender: {patient_profile['gender']}, IC: {patient_profile['ic_number'] or 'N/A'})"
    else:
        pat_info_str = "No active patient currently selected in this session."

    lang_instruction = (
        "LANGUAGE INSTRUCTION: The clinician has set the consultation language to Bahasa Melayu. "
        "Provide your medical explanation and advice in clear, professional Bahasa Melayu, "
        "while keeping standard international medication and anatomical names."
        if getattr(query, 'language', 'en') == 'ms' else
        "LANGUAGE INSTRUCTION: Provide your clinical responses in clear, professional English medical terminology."
    )

    system_prompt = f"""You are 'Clinical Brain', an expert medical support assistant. 
    You are assisting the logged-in clinician with the active patient in the consultation room.
    Use the CURRENT SESSION INFO to identify the doctor and patient, and synthesize your knowledge with the active patient's history, other patients' records, and official medical guidelines to answer clinical or administrative questions clearly.
    {lang_instruction}"""

    context_block = f"""
    CURRENT SESSION INFO:
    - Logged-in Clinician: {doc_info_str}
    - Active Patient in Consultation: {pat_info_str}

    ACTIVE PATIENT'S CLINICAL ENCOUNTERS HISTORY:
    {compiled_active_history}

    OTHER PATIENTS' RECENT CLINICAL ENCOUNTERS (HISTORICAL):
    {compiled_other_history}

    OFFICIAL MEDICAL GUIDELINES:
    {compiled_guidelines if compiled_guidelines else "No specific guidelines uploaded."}

    LIVE CONSULTATION TRANSCRIPT:
    {query.transcript if query.transcript else "No active transcript."}
    """

    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': context_block},
        {'role': 'assistant', 'content': 'Context Loaded. Ready for multi-turn clinical questions.'}
    ]

    for msg in query.history[-6:]:
        messages.append({'role': msg['role'], 'content': msg['content']})

    messages.append({'role': 'user', 'content': question_text})

    print(f" [Clinical Brain] Dispatching CLINICAL query to LLM (Lang: {getattr(query, 'language', 'en')})...")
    answer_text = call_llm_api(messages, preferred_model='llama3')
    print(" [Clinical Brain] Generation complete.")
    return {"answer": answer_text.strip()}

# PHASE 4: DATE-LOCKED MEDICAL CERTIFICATES (FIXED FOR STRICT COMPLIANCE)
@app.post("/generate-certificate")
async def generate_certificate(query: CertificateQuery):
    encounter = query_db(
        """SELECT e.created_at, e.structured_notes_json, p.patient_name 
           FROM encounters e JOIN patients p ON e.patient_id = p.id 
           WHERE e.id = ? AND e.doctor_id = ?""",
        (query.encounter_id, query.doctor_id), one=True
    )
    if not encounter:
        return {"success": False, "message": "Encounter visit log file not found."}

    # Reject if the consultation is from a previous day (past consultations check)
    encounter_date = encounter['created_at'][:10]
    current_date = datetime.now().strftime('%Y-%m-%d')

    if encounter_date != current_date:
        return {
            "success": False, 
            "message": "Security compliance constraint violation: Cannot issue medical certificates for past consultations."
        }

    # Reject if more than 2 hours have passed since the consultation ended (created_at)
    try:
        encounter_time = datetime.fromisoformat(encounter['created_at'])
    except ValueError:
        try:
            encounter_time = datetime.strptime(encounter['created_at'], "%Y-%m-%dT%H:%M:%S.%f")
        except Exception:
            encounter_time = datetime.now()

    time_diff = datetime.now() - encounter_time
    if time_diff.total_seconds() > 2 * 3600:
        return {
            "success": False,
            "message": "Security compliance constraint violation: Medical Certificate cannot be generated more than 2 hours after the consultation ends."
        }

    notes = json.loads(encounter['structured_notes_json'])
    doctor = query_db("SELECT first_name, last_name, id_number, specialty FROM users WHERE id = ?", (query.doctor_id,), one=True)

    prompt = f"""
    You are generating a formal Malaysian medical certificate (MC).
    Output ONLY the certificate layout cleanly. No chat meta responses.

    Structure layout parameters:
    - Patient Name: {encounter['patient_name']}
    - Date of Examination: {datetime.now().strftime('%d %B %Y')}
    - Diagnosis / Reason for Rest: {notes.get('assessment')}
    - Number of rest days issued: {str(query.days_rest) + " days" if query.days_rest else "1 day"}
    - Medical Practitioner: Dr. {doctor.get('first_name')} {doctor.get('last_name')} (ID: {doctor.get('id_number')})
    - Facility: Health Sync Clinic
    """

    try:
        cert_content = call_llm_api([{'role': 'user', 'content': prompt}], preferred_model='llama3')
        return {"success": True, "certificate": cert_content.strip()}
    except Exception as e:
        return {"success": False, "message": str(e)}

# Save issued MC to database for admin audit trail
@app.post("/save-certificate")
async def save_certificate(query: SaveCertificateQuery):
    try:
        query_db(
            """INSERT OR IGNORE INTO medical_certificates
               (serial_number, encounter_id, patient_id, doctor_id, patient_name, ic_number,
                diagnosis, rest_start, rest_end, days_issued, issued_at, html_content)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                query.serial_number, query.encounter_id, query.patient_id, query.doctor_id,
                query.patient_name, query.ic_number, query.diagnosis,
                query.rest_start, query.rest_end, query.days_issued,
                datetime.now().isoformat(), query.html_content
            ),
            commit=True
        )
        return {"success": True}
    except Exception as e:
        print(f" [MC Save] Error: {e}")
        return {"success": False, "message": str(e)}

# Admin: fetch all issued medical certificates
@app.get("/admin/medical-certificates")
async def get_all_certificates():
    certs = query_db("""
        SELECT mc.*, 
               u.first_name as doc_first, u.last_name as doc_last, u.username as doc_username,
               u.id_number as doc_id_number, u.specialty as doc_specialty
        FROM medical_certificates mc
        LEFT JOIN users u ON mc.doctor_id = u.id
        ORDER BY mc.issued_at DESC
    """)
    return {"certificates": certs}


@app.post("/signup")
async def signup(query: SignupQuery):
    username_clean = query.username.strip()
    existing = query_db("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", (username_clean,), one=True)
    if existing: return {"success": False, "message": "Username already exists."}
    hashed = hash_password(query.password)
    query_db("INSERT INTO users (username, password, first_name, last_name, id_number, role, is_approved) VALUES (?, ?, ?, ?, ?, 'dr', 0)",
             (username_clean, hashed, query.first_name, query.last_name, query.id_number), commit=True)
    return {"success": True, "message": "Account awaiting approval."}

@app.post("/login")
async def login(query: AuthQuery):
    username_clean = query.username.strip()
    user = query_db("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", (username_clean,), one=True)
    if not user or not verify_password(query.password, user['password']):
        return {"success": False, "message": "Invalid username or password."}
    if not user['is_approved']:
        return {"success": False, "message": "Account awaiting admin approval."}
    return {"success": True, "user_id": user['id'], "username": user['username'], "first_name": user.get('first_name', ''), "role": user['role']}

@app.get("/admin/overview")
async def admin_overview():
    doctors = query_db("SELECT id, username, first_name, last_name FROM users WHERE role = 'dr'")
    
    # FIXED: Joined relational mapping layer query logic execution
    all_encounters = query_db("""
        SELECT e.id AS encounter_id, e.doctor_id, p.patient_name, e.structured_notes_json, e.created_at 
        FROM encounters e
        JOIN patients p ON e.patient_id = p.id
        ORDER BY e.created_at DESC
    """)

    overview = []
    for dr in doctors:
        dr_encounters = [enc for enc in all_encounters if enc['doctor_id'] == dr['id']]
        overview.append({
            "doctor_id": dr['id'],
            "username": dr['username'],
            "first_name": dr.get('first_name', ''),
            "last_name": dr.get('last_name', ''),
            "patients": dr_encounters
        })
    return {"overview": overview}

@app.get("/doctor/{doctor_id}/patients")
async def get_doctor_patients(doctor_id: str):
    print(f"\n -------------------------------------------------------------")
    print(f" [Doctor Patients API] Fetching secure multi-doctor histories for Doctor ID: {doctor_id}")
    print(f" -------------------------------------------------------------")
    try:
        dr_id = int(doctor_id)
    except (ValueError, TypeError):
        print(f" [Doctor Patients API] Bad Doctor ID format requested: '{doctor_id}'")
        raise HTTPException(status_code=400, detail="Invalid Doctor ID format.")

    # Fetch all encounters across all doctors for patients assigned to this doctor or treated by them in the past
    encounters = query_db(
        """SELECT e.id as encounter_id, p.patient_name, e.doc_id, e.structured_notes_json, e.created_at,
                  e.additional_notes, e.is_finalized,
                  u.first_name as doc_first, u.last_name as doc_last
           FROM encounters e 
           JOIN patients p ON e.patient_id = p.id 
           JOIN users u ON e.doctor_id = u.id
           WHERE p.id IN (
               SELECT id FROM patients WHERE doctor_id = ? AND queue_status = 'on_hold'
               UNION
               SELECT patient_id FROM encounters WHERE doctor_id = ?
           )
           ORDER BY e.created_at DESC""",
        (dr_id, dr_id)
    )
    print(f" [Doctor Patients API] Returned {len(encounters)} encounters successfully.")
    return {"patients": encounters}

@app.post("/admin/upload-guideline")
async def upload_guideline(file: UploadFile = File(...)):
    try:
        if not file or not file.filename:
            return {"success": False, "message": "No file uploaded or invalid filename."}

        content_text = ""
        if file.filename.lower().endswith(".pdf"):
            import pypdf, io
            pdf_bytes = await file.read()
            reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    content_text += text + "\n"
        else:
            return {"success": False, "message": "Format unsupported. Only PDF files are supported."}

        if not content_text.strip():
            return {"success": False, "message": "File is empty or no readable text could be extracted."}

        chunks = [content_text[i:i+1000] for i in range(0, len(content_text), 1000)]
        for i, chunk in enumerate(chunks):
            collection.add(documents=[chunk], metadatas=[{"type": "guideline", "filename": file.filename, "chunk": i}], ids=[str(uuid.uuid4())])
            
        # Record uploaded guideline in SQLite guidelines table
        query_db("INSERT OR IGNORE INTO guidelines (filename, uploaded_at) VALUES (?, ?)", 
                 (file.filename, datetime.now().isoformat()), commit=True)
                 
        return {"success": True, "message": f"Uploaded {file.filename}"}
    except Exception as e:
        return {"success": False, "message": str(e)}

@app.get("/admin/guidelines")
async def get_guidelines():
    try:
        # Check SQLite guidelines table
        sql_guidelines = query_db("SELECT * FROM guidelines ORDER BY uploaded_at DESC")
        if not sql_guidelines:
            # Fallback guidelines synchronization from ChromaDB metadata
            try:
                chroma_data = collection.get(where={"type": "guideline"})
                unique_filenames = set()
                if chroma_data and chroma_data.get("metadatas"):
                    for meta in chroma_data["metadatas"]:
                        if meta and meta.get("filename"):
                            unique_filenames.add(meta["filename"])
                
                # Sync into SQLite guidelines list
                for fname in unique_filenames:
                    query_db("INSERT OR IGNORE INTO guidelines (filename, uploaded_at) VALUES (?, ?)", 
                             (fname, datetime.now().isoformat()), commit=True)
                sql_guidelines = query_db("SELECT * FROM guidelines ORDER BY uploaded_at DESC")
            except Exception as chroma_err:
                print(f"⚠️ Error syncing guidelines from Chroma: {chroma_err}")
                
        return {"success": True, "guidelines": sql_guidelines}
    except Exception as e:
        return {"success": False, "message": str(e)}

@app.get("/report/monthly")
async def get_monthly_report(month: Optional[str] = None, doctor_id: Optional[str] = None):
    # Expected format: "YYYY-MM"
    if not month:
        month = datetime.now().strftime("%Y-%m")
        
    try:
        # Fetch encounters in selected month
        if doctor_id:
            try:
                doc_id_int = int(doctor_id)
            except (ValueError, TypeError):
                return {"success": False, "message": "Invalid doctor ID format."}
            encounters = query_db(
                """SELECT e.id, e.patient_id, e.doctor_id, e.created_at, e.structured_notes_json,
                          p.patient_name, p.age, p.gender,
                          u.first_name as doc_first, u.last_name as doc_last
                   FROM encounters e
                   JOIN patients p ON e.patient_id = p.id
                   JOIN users u ON e.doctor_id = u.id
                   WHERE e.created_at LIKE ? AND e.doctor_id = ?""",
                (f"{month}%", doc_id_int)
            )
        else:
            encounters = query_db(
                """SELECT e.id, e.patient_id, e.doctor_id, e.created_at, e.structured_notes_json,
                          p.patient_name, p.age, p.gender,
                          u.first_name as doc_first, u.last_name as doc_last
                   FROM encounters e
                   JOIN patients p ON e.patient_id = p.id
                   JOIN users u ON e.doctor_id = u.id
                   WHERE e.created_at LIKE ?""",
                (f"{month}%",)
            )
        
        total_visits = len(encounters)
        prescriptions_list = []
        most_prescribed = {}
        
        for enc in encounters:
            if enc["structured_notes_json"]:
                try:
                    notes = json.loads(enc["structured_notes_json"])
                    prescs = notes.get("prescriptions", [])
                    for pr in prescs:
                        drug = pr.get("drug", "").strip()
                        if drug:
                            prescriptions_list.append({
                                "patient_name": enc["patient_name"],
                                "doctor_name": f"Dr. {enc['doc_first']} {enc['doc_last']}",
                                "drug": drug,
                                "dosage": pr.get("dosage", ""),
                                "frequency": pr.get("frequency", ""),
                                "duration": pr.get("duration", "")
                            })
                            most_prescribed[drug] = most_prescribed.get(drug, 0) + 1
                except Exception:
                    pass
                    
        # Sort top 5 most prescribed medications (kept for doctor-scoped reports)
        sorted_drugs = sorted(most_prescribed.items(), key=lambda x: x[1], reverse=True)
        top_drugs = [{"drug": k, "count": v} for k, v in sorted_drugs[:5]]
        
        # Aggregate stats by doctor
        doctor_stats = {}
        for enc in encounters:
            doc_name = f"Dr. {enc['doc_first']} {enc['doc_last']}"
            doctor_stats[doc_name] = doctor_stats.get(doc_name, 0) + 1
        doc_summary = [{"doctor_name": k, "visit_count": v} for k, v in doctor_stats.items()]
        
        # Aggregate stats by date
        date_stats = {}
        for enc in encounters:
            date_str = enc["created_at"][:10]
            date_stats[date_str] = date_stats.get(date_str, 0) + 1
        date_summary = sorted([{"date": k, "visit_count": v} for k, v in date_stats.items()], key=lambda x: x["date"])
        
        # Unique patients seen this month
        unique_patients = len(set(enc["patient_id"] for enc in encounters))
        
        # New patient registrations this month (admin-only metric)
        new_reg_rows = query_db(
            "SELECT COUNT(*) as cnt FROM patients WHERE created_at LIKE ?",
            (f"{month}%",)
        )
        new_registrations = new_reg_rows[0]["cnt"] if new_reg_rows else 0
        
        return {
            "success": True,
            "month": month,
            "summary": {
                "total_visits": total_visits,
                "unique_patients": unique_patients,
                "new_registrations": new_registrations,
                "total_prescriptions": len(prescriptions_list),
                "top_drugs": top_drugs,
                "doctor_summary": doc_summary,
                "date_summary": date_summary
            },
            "visits_details": [
                {
                    "encounter_id": enc["id"],
                    "patient_name": enc["patient_name"],
                    "doctor_name": f"Dr. {enc['doc_first']} {enc['doc_last']}",
                    "date": enc["created_at"][:16].replace("T", " ")
                } for enc in encounters
            ]
        }
    except Exception as e:
        return {"success": False, "message": str(e)}

# PHASE 6: MISSING SYSTEM ENDPOINTS RESTORATION
@app.post("/reset-password")
async def reset_password(query: AuthQuery):
    user = query_db("SELECT * FROM users WHERE username = ?", (query.username,), one=True)
    if not user:
        return {"success": False, "message": "User not found."}

    hashed = hash_password(query.password)
    query_db("UPDATE users SET password = ? WHERE username = ?", (hashed, query.username), commit=True)
    return {"success": True, "message": "Password reset successfully!"}

@app.get("/admin/pending")
async def get_pending_doctors():
    doctors = query_db("SELECT id, username, first_name, last_name, id_number FROM users WHERE role = 'dr' AND is_approved = 0")
    return {"doctors": doctors}

@app.post("/admin/approve")
async def approve_doctor(query: ApproveQuery):
    query_db("UPDATE users SET is_approved = 1 WHERE id = ?", (query.doctor_id,), commit=True)
    return {"success": True, "message": "Doctor approved successfully."}

@app.delete("/admin/patient/{encounter_id}")
async def delete_encounter(encounter_id: int):
    try:
        encounter = query_db("SELECT doc_id FROM encounters WHERE id = ?", (encounter_id,), one=True)
        if encounter and encounter.get('doc_id'):
            try:
                collection.delete(ids=[encounter['doc_id']])
            except Exception as e:
                print(f"ChromaDB delete error: {e}")
        query_db("DELETE FROM encounters WHERE id = ?", (encounter_id,), commit=True)
        return {"success": True, "message": "Encounter deleted successfully."}
    except Exception as e:
        return {"success": False, "message": str(e)}

@app.get("/doctor/{doctor_id}/profile")
async def get_doctor_profile(doctor_id: int):
    user = query_db(
        "SELECT username, first_name, last_name, id_number, specialty FROM users WHERE id = ?",
        (doctor_id,), one=True
    )
    if not user:
        return {"success": False, "message": "User not found."}
    return {"success": True, "profile": user}

import sqlite3
@app.put("/doctor/{doctor_id}/profile")
async def update_doctor_profile(doctor_id: int, profile: ProfileUpdateQuery):
    try:
        username_clean = profile.username.strip()
        # Verify case-insensitive uniqueness excluding the current user
        existing = query_db("SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?", (username_clean, doctor_id), one=True)
        if existing:
            return {"success": False, "message": "Username is already taken. Please choose another."}

        if profile.password:
            hashed = hash_password(profile.password)
            query_db("""
                UPDATE users
                SET username = ?, password = ?, first_name = ?, last_name = ?, id_number = ?, specialty = ?
                WHERE id = ?
            """, (username_clean, hashed, profile.first_name, profile.last_name, profile.id_number, profile.specialty, doctor_id), commit=True)
        else:
            query_db("""
                UPDATE users
                SET username = ?, first_name = ?, last_name = ?, id_number = ?, specialty = ?
                WHERE id = ?
            """, (username_clean, profile.first_name, profile.last_name, profile.id_number, profile.specialty, doctor_id), commit=True)

        return {"success": True, "message": "Profile updated successfully."}
    except Exception as e:
        return {"success": False, "message": f"Error updating profile: {str(e)}"}

# CLINICAL IDENTITY AND ASSIGNMENT ENDPOINTS
@app.get("/admin/doctors")
async def get_all_doctors():
    doctors = query_db("SELECT id, username, first_name, last_name, specialty FROM users WHERE role = 'dr' AND is_approved = 1")
    return {"doctors": doctors}

import re
from fastapi import HTTPException

@app.post("/admin/register-patient")
async def register_patient(query: PatientRegisterQuery):
    # Regex check for Patient Name (letters and spaces only)
    if not re.match(r"^[a-zA-Z\s]+$", query.patient_name.strip()):
        return {"success": False, "message": "Invalid Patient Name: Only letters and spaces are allowed (no numbers or special characters)."}

    # Regex numeric check for IC Number (digits only)
    if not re.match(r"^[0-9]+$", query.ic_number.strip()):
        return {"success": False, "message": "Access Denied: Patient IC Number must contain numbers only (digits 0-9)."}

    # Check if patient already exists
    existing = query_db("SELECT id FROM patients WHERE ic_number = ?", (query.ic_number,), one=True)
    
    if existing:
        patient_id = existing["id"]
        # Patient already exists, update queue if doctor pre-assigned
        if query.doctor_id:
            query_db(
                "UPDATE patients SET doctor_id = ?, queue_status = 'on_hold' WHERE id = ?",
                (query.doctor_id, patient_id),
                commit=True
            )
            return {"success": True, "message": "Returning patient successfully queued.", "patient_id": patient_id}
        else:
            return {"success": False, "message": "Patient is already registered. Please use the Returning Patient list to assign them to a doctor."}

    # Register new patient
    patient_id = query_db(
        "INSERT INTO patients (doctor_id, patient_name, age, gender, ic_number, queue_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (query.doctor_id, query.patient_name, query.age, query.gender, query.ic_number, 'on_hold' if query.doctor_id else None, datetime.now().isoformat()),
        commit=True
    )
    return {"success": True, "message": "Patient registered successfully.", "patient_id": patient_id}

@app.get("/admin/active-queue")
async def get_active_queue():
    queue = query_db("""
        SELECT p.id as patient_id, p.patient_name, p.age, p.gender, p.ic_number, p.doctor_id,
               u.first_name as doc_first, u.last_name as doc_last
        FROM patients p
        LEFT JOIN users u ON p.doctor_id = u.id
        WHERE p.queue_status = 'on_hold'
    """)
    return {"queue": queue}

@app.post("/admin/reassign-patient")
async def reassign_patient(query: PatientReassignQuery):
    query_db(
        "UPDATE patients SET doctor_id = ?, queue_status = 'on_hold' WHERE id = ?",
        (query.doctor_id, query.patient_id),
        commit=True
    )
    return {"success": True, "message": "Patient reassigned successfully."}

@app.get("/doctor/{doctor_id}/on-hold")
async def get_doctor_on_hold(doctor_id: int):
    patients = query_db(
        "SELECT id, patient_name, age, gender, ic_number FROM patients WHERE doctor_id = ? AND queue_status = 'on_hold'",
        (doctor_id,)
    )
    return {"patients": patients}

@app.get("/patient/{patient_id}/history")
async def get_patient_history(patient_id: str, doctor_id: Optional[str] = None):
    print(f"\n -------------------------------------------------------------")
    print(f" [Patient History API] Fetching full encounter history for Patient ID: {patient_id} requested by Doctor ID: {doctor_id}")
    print(f" -------------------------------------------------------------")
    
    try:
        pat_id = int(patient_id)
    except (ValueError, TypeError):
        print(f" [Patient History API] Bad Patient ID format: '{patient_id}'")
        raise HTTPException(status_code=400, detail="Invalid Patient ID format.")

    try:
        dr_id = int(doctor_id) if doctor_id else None
    except (ValueError, TypeError):
        dr_id = None

    if dr_id is None:
        print(f" [Patient History API] Missing or invalid Doctor ID: '{doctor_id}'")
        raise HTTPException(status_code=400, detail="Doctor ID is required and must be an integer.")

    # Enforce strict safety check:
    # 1. Is this patient currently assigned to the requesting doctor?
    assigned = query_db("SELECT id FROM patients WHERE id = ? AND doctor_id = ? AND queue_status = 'on_hold'", (pat_id, dr_id), one=True)
    
    # 2. Or has the requesting doctor treated this patient in the past?
    treated = query_db("SELECT id FROM encounters WHERE patient_id = ? AND doctor_id = ?", (pat_id, dr_id), one=True)
    
    if not assigned and not treated:
        print(f" [Patient History API] Access Denied: Doctor ID {dr_id} has no queue or history link to Patient ID {pat_id}.")
        raise HTTPException(
            status_code=403,
            detail="Access Denied: You do not have active consultation assignment or historical relationship for this patient's records."
        )
    
    # Retrieve all historic encounters across all doctors
    encounters = query_db("""
        SELECT e.id as encounter_id, e.structured_notes_json, e.created_at, e.transcript, e.doc_id,
               e.additional_notes, e.is_finalized,
               u.first_name as doc_first, u.last_name as doc_last
        FROM encounters e
        JOIN users u ON e.doctor_id = u.id
        WHERE e.patient_id = ?
        ORDER BY e.created_at DESC
    """, (pat_id,))
    
    print(f" [Patient History API] Returned {len(encounters)} encounters successfully.")
    return {"encounters": encounters}

@app.get("/admin/patients-list")
async def get_all_patients():
    patients = query_db("SELECT id, patient_name, age, gender, ic_number FROM patients ORDER BY patient_name ASC")
    return {"patients": patients}

@app.websocket("/backend-logs")
async def backend_logs_endpoint(websocket: WebSocket):
    await websocket.accept()
    log_websockets.add(websocket)
    try:
        # First send the existing history
        for msg in list(log_history):
            await websocket.send_text(msg)
        # Keep connection open
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if websocket in log_websockets:
            log_websockets.remove(websocket)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)