from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from faster_whisper import WhisperModel
import numpy as np
import ollama
import json
import chromadb
import uuid
import bcrypt
import asyncio
from database import init_db, query_db
from datetime import datetime

# Initialize database schema mapping
init_db()

chroma_client = chromadb.PersistentClient(path="./medical_knowledge")
collection = chroma_client.get_or_create_collection(name="clinical_docs")
print("✅ ChromaDB Memory initialized and ready.")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading Whisper model into memory...")
whisper_model = WhisperModel("medium", device="cpu", compute_type="int8")
print("Whisper model loaded successfully!")

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
    ic_number: str = None

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
    doc_id: str = None
    updated_notes: dict
    patient_name: str

class GuidelineQuery(BaseModel):
    user_question: str
    transcript: str
    doctor_id: int = None
    history: list = []

class CertificateQuery(BaseModel):
    encounter_id: int
    doctor_id: int
    days_rest: int = None 

# PHASE 1: ASYNCHRONOUS LIVE DICTATION
@app.websocket("/live-transcribe")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Frontend connected: Live dictation started.")
    audio_buffer = np.array([], dtype=np.float32)

    def run_transcribe(buffer_data):
        segments_gen, info = whisper_model.transcribe(
            buffer_data,
            beam_size=3,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            initial_prompt="A medical consultation. Patient: Saya sakit dada. Doctor: How long have you had this chest pain?"
        )
        return list(segments_gen), info

    try:
        while True:
            data = await websocket.receive_bytes()
            chunk_np = np.frombuffer(data, dtype=np.float32)
            audio_buffer = np.concatenate((audio_buffer, chunk_np))

            if len(audio_buffer) >= 32000:
                loop = asyncio.get_running_loop()
                segments, info = await loop.run_in_executor(
                    None,
                    run_transcribe,
                    audio_buffer
                )
                
                transcript_chunk = ""
                for segment in segments:
                    if segment.text.strip():
                        transcript_chunk += segment.text + " "

                if transcript_chunk.strip():
                    print(f"🗣️ Live Heard: {transcript_chunk.strip()}")
                    await websocket.send_text(transcript_chunk.strip())
                
                audio_buffer = np.array([], dtype=np.float32)

    except WebSocketDisconnect:
        print("Frontend disconnected: Dictation stopped.")
    except Exception as e:
        print(f"WebSocket Error: {e}")

# PHASE 2: CLINICAL ENCOUNTER EXTRACTION
@app.post("/process-dictation")
async def process_dictation(query: ClinicalQuery):
    print("\n--- Processing Final Transcript ---")
    
    system_prompt = """
    You are an expert clinical scribe. Read the transcript between a doctor and patient.
    Extract the patient details and output ONLY a valid JSON object in the SOAP format.
    If a detail is not mentioned in the transcript, set its value to null.

    CRITICAL: You are a STRICT data extraction scribe. NEVER invent or infer a diagnosis.
    Use exactly these keys:
    {
        "name": "Patient's name",
        "age": "Patient's age as an integer",
        "ic_number": "IC or identity passport number if spoken, otherwise null",
        "subjective": "Patient's condition in their own words, complaint, and history",
        "objective": "Objective observations, vital signs, physical exam findings",
        "assessment": "Medical diagnosis or clinician's assessment",
        "plan": "Treatment plan, medications, follow-up instructions"
    }
    """

    try:
        response = ollama.chat(
            model='medllama2',
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': query.transcript}
            ],
            format='json'
        )

        extracted_notes = json.loads(response['message']['content'])
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

        doc_id = str(uuid.uuid4())
        document_text = f"Raw Transcript: {query.transcript}\n\nStructured Notes: {json.dumps(extracted_notes)}"

        collection.add(
            documents=[document_text],
            metadatas=[{"patient_name": patient_name, "type": "encounter"}],
            ids=[doc_id]
        )

        encounter_id = query_db(
            "INSERT INTO encounters (patient_id, doctor_id, transcript, structured_notes_json, doc_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (patient_id, query.doctor_id, query.transcript, json.dumps(extracted_notes), doc_id, datetime.now().isoformat()),
            commit=True
        )

        extracted_notes["_patient_id"] = patient_id
        extracted_notes["_encounter_id"] = encounter_id
        extracted_notes["_doc_id"] = doc_id
        return extracted_notes

    except Exception as e:
        print(f"Error during extraction: {e}")
        return {"error": "Failed to process data with medllama2."}

@app.put("/encounter/{encounter_id}/notes")
async def update_encounter_notes(encounter_id: int, query: UpdateNotesQuery):
    try:
        notes_to_save = {k: v for k, v in query.updated_notes.items() if not k.startswith('_')}

        query_db(
            "UPDATE encounters SET structured_notes_json = ? WHERE id = ?",
            (json.dumps(notes_to_save), encounter_id),
            commit=True
        )

        if query.doc_id:
            document_text = f"Structured Notes (Updated by Doctor): {json.dumps(notes_to_save)}"
            try:
                collection.update(
                    ids=[query.doc_id],
                    documents=[document_text],
                    metadatas=[{"patient_name": query.patient_name, "type": "encounter"}]
                )
            except Exception as chroma_err:
                print(f"ChromaDB update error: {chroma_err}")

        return {"success": True, "message": "Encounter notes updated successfully."}
    except Exception as e:
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

    encounters = []
    my_patients_data = "No patients found for this doctor."

    if query.doctor_id:
        encounters = query_db(
            """SELECT e.id, p.patient_name, e.created_at, e.structured_notes_json, e.doc_id 
               FROM encounters e JOIN patients p ON e.patient_id = p.id 
               WHERE e.doctor_id = ? ORDER BY e.created_at DESC""",
            (query.doctor_id,)
        )
        if encounters:
            my_patients_data = "\n".join([
                f"- {enc['patient_name']} (Visited: {enc['created_at'][:10]})"
                for enc in encounters
            ])

    if any(phrase in lower_q for phrase in ["list my patients", "who are my patients"]):
        return {"answer": f"**Your Registered Patients Visit Log:**\n\n{my_patients_data}"}

    intent = classify_intent(question_text)

    if intent == "ADMIN":
        gemma_system_prompt = "You are an admin assistant. Answer using ONLY the provided list context data."
        gemma_user_prompt = f"PATIENTS:\n{my_patients_data}\n\nQUESTION:\n{question_text}"
        try:
            response = ollama.chat(model='gemma:2b', messages=[
                {'role': 'system', 'content': gemma_system_prompt},
                {'role': 'user', 'content': gemma_user_prompt}
            ])
            return {"answer": response['message']['content'].strip()}
        except Exception as e:
            return {"answer": f"System Error: {str(e)}"}

    history_docs = []
    if encounters:
        for enc in encounters:
            if enc['patient_name'] and enc['patient_name'].lower() in lower_q:
                history_docs.append(f"--- RECORD FOR {enc['patient_name']} ({enc['created_at'][:10]}) ---\n{enc['structured_notes_json']}")

        if not history_docs:
            for enc in encounters[:3]:
                history_docs.append(f"--- LATEST RECORD FOR {enc['patient_name']} ---\n{enc['structured_notes_json']}")

    guideline_docs = []
    try:
        results = collection.query(query_texts=[question_text], n_results=5)
        if results['documents']:
            for doc, meta in zip(results['documents'][0], results['metadatas'][0]):
                if meta and meta.get("type") == "guideline":
                    guideline_docs.append(f"Source: {meta.get('filename')}\n{doc}")
    except Exception as ce:
        print(f"Chroma Query Error: {ce}")

    compiled_history = "\n\n".join(history_docs)
    compiled_guidelines = "\n\n---\n\n".join(guideline_docs)

    system_prompt = """You are 'Clinical Brain', an expert medical support assistant. 
    Synthesize your knowledge with past histories to answer clinical questions clearly."""

    context_block = f"""
    OFFICIAL MEDICAL GUIDELINES:
    {compiled_guidelines if compiled_guidelines else "No specific guidelines uploaded."}

    PAST CLINICAL ENCOUNTERS:
    {compiled_history if compiled_history else "No records found."}

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

    try:
        response = ollama.chat(model='llama3', messages=messages)
        return {"answer": response['message']['content'].strip()}
    except Exception:
        response = ollama.chat(model='medllama2', messages=messages)
        return {"answer": response['message']['content'].strip()}

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

    # Extract strings to verify equality (YYYY-MM-DD constraint match check)
    encounter_date = encounter['created_at'][:10]
    current_date = datetime.now().strftime('%Y-%m-%d')

    if encounter_date != current_date:
        return {
            "success": False, 
            "message": f"Security compliance constraint violation: Cannot issue medical certificates for historical records. Encounter date: {encounter_date}, current clock date: {current_date}."
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
        response = ollama.chat(model='llama3', messages=[{'role': 'user', 'content': prompt}])
        return {"success": True, "certificate": response['message']['content'].strip()}
    except Exception as e:
        return {"success": False, "message": str(e)}

# PHASE 5: ACCOUNT AUTHENTICATION & MANAGEMENT WITH OVERVIEW JOINS
@app.post("/signup")
async def signup(query: SignupQuery):
    existing = query_db("SELECT id FROM users WHERE username = ?", (query.username,), one=True)
    if existing: return {"success": False, "message": "Username already exists."}
    hashed = hash_password(query.password)
    query_db("INSERT INTO users (username, password, first_name, last_name, id_number, role, is_approved) VALUES (?, ?, ?, ?, ?, 'dr', 0)",
             (query.username, hashed, query.first_name, query.last_name, query.id_number), commit=True)
    return {"success": True, "message": "Account awaiting approval."}

@app.post("/login")
async def login(query: AuthQuery):
    user = query_db("SELECT * FROM users WHERE username = ?", (query.username,), one=True)
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
async def get_doctor_patients(doctor_id: int):
    # FIXED: Maps encounter historical references for client view panels
    encounters = query_db(
        """SELECT e.id as encounter_id, p.patient_name, e.doc_id, e.structured_notes_json, e.created_at 
           FROM encounters e JOIN patients p ON e.patient_id = p.id 
           WHERE e.doctor_id = ? ORDER BY e.created_at DESC""",
            (doctor_id,)
    )
    return {"patients": encounters}

@app.post("/admin/upload-guideline")
async def upload_guideline(file: UploadFile = File(...)):
    try:
        content_text = ""
        if file.filename.endswith(".pdf"):
            import pypdf, io
            pdf_bytes = await file.read()
            reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
            for page in reader.pages: content_text += page.extract_text() + "\n"
        else:
            return {"success": False, "message": "Format unsupported."}

        chunks = [content_text[i:i+1000] for i in range(0, len(content_text), 1000)]
        for i, chunk in enumerate(chunks):
            collection.add(documents=[chunk], metadatas=[{"type": "guideline", "filename": file.filename, "chunk": i}], ids=[str(uuid.uuid4())])
        return {"success": True, "message": f"Uploaded {file.filename}"}
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
        if profile.password:
            hashed = hash_password(profile.password)
            query_db("""
                UPDATE users
                SET username = ?, password = ?, first_name = ?, last_name = ?, id_number = ?, specialty = ?
                WHERE id = ?
            """, (profile.username, hashed, profile.first_name, profile.last_name, profile.id_number, profile.specialty, doctor_id), commit=True)
        else:
            query_db("""
                UPDATE users
                SET username = ?, first_name = ?, last_name = ?, id_number = ?, specialty = ?
                WHERE id = ?
            """, (profile.username, profile.first_name, profile.last_name, profile.id_number, profile.specialty, doctor_id), commit=True)

        return {"success": True, "message": "Profile updated successfully."}
    except sqlite3.IntegrityError:
        return {"success": False, "message": "Username is already taken. Please choose another."}
    except Exception as e:
        return {"success": False, "message": f"Error updating profile: {str(e)}"}