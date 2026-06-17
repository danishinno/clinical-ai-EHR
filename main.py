from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import mlx_whisper
import numpy as np
import ollama
import json
import chromadb
import uuid
import bcrypt
import asyncio
from database import init_db, query_db
from datetime import datetime

#database schema mapping
init_db()

chroma_client = chromadb.PersistentClient(path="./medical_knowledge")
collection = chroma_client.get_or_create_collection(name="clinical_docs")
print("ChromaDB Memory initialized and ready.")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    updated_notes: dict
    patient_name: str

class SaveEncounterQuery(BaseModel):
    doctor_id: int
    patient_id: Optional[int] = None
    transcript: str = ""
    structured_notes: dict


class GuidelineQuery(BaseModel):
    user_question: str
    transcript: str
    doctor_id: Optional[int] = None
    patient_id: Optional[int] = None
    history: List[dict] = []

class CertificateQuery(BaseModel):
    encounter_id: int
    doctor_id: int
    days_rest: Optional[int] = None 

# PHASE 1: ASYNCHRONOUS LIVE DICTATION
@app.websocket("/live-transcribe")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Frontend connected: Live dictation started.")
    audio_buffer = np.array([], dtype=np.float32)

    def run_transcribe(buffer_data):
        # 1. Volume Noise Gate (RMS Energy threshold)
        rms = np.sqrt(np.mean(buffer_data**2))
        print(f" Audio Chunk RMS Energy: {rms:.6f}")
        if rms < 0.003:
            return {"text": "", "segments": []}

        result = mlx_whisper.transcribe(
            buffer_data,
            path_or_hf_repo="mlx-community/whisper-small-mlx-8bit",
            temperature=0.0,
            initial_prompt="A clinical medical consultation. Patient: Saya sakit dada. Doctor: How long have you had this chest pain? Keywords: stable angina, chest discomfort, tightness, squeezing, physical exertion, shortness of breath, high cholesterol, heart attack."
        )
        return result

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
                segments = result.get("segments", [])
                valid_texts = []
                for seg in segments:
                    no_speech_prob = seg.get("no_speech_prob", 0.0)
                    # Ignore segments with high no-speech probability to prevent silent hallucinations
                    if no_speech_prob < 0.65:
                        valid_texts.append(seg.get("text", "").strip())
                
                transcript_chunk = " ".join(valid_texts).strip()

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
    print(f" [Dictation Scribe] Processing transcript for Doctor ID: {query.doctor_id} | Active Patient ID: {query.patient_id}")
    print(f" -------------------------------------------------------------")
    
    # Check if a pre-assigned patient is active
    active_patient = None
    if query.patient_id:
        active_patient = query_db("SELECT * FROM patients WHERE id = ?", (query.patient_id,), one=True)
    
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
        print("[Dictation Scribe] Calling medllama2 for JSON SOAP note extraction...")
        response = ollama.chat(
            model='medllama2',
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': query.transcript}
            ],
            format='json'
        )

        extracted_notes = json.loads(response['message']['content'])
        
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
        return {"error": "Failed to process data with medllama2."}

@app.put("/encounter/{encounter_id}/notes")
async def update_encounter_notes(encounter_id: int, query: UpdateNotesQuery):
    print(f"\n -------------------------------------------------------------")
    print(f" [Encounter Update] Edit request for Encounter ID: {encounter_id} | Patient Name: {query.patient_name}")
    print(f" -------------------------------------------------------------")
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
                print(f"⚠️ [Encounter Update] ChromaDB update error: {chroma_err}")

        print(f" [Encounter Update] Notes updated successfully. ORIGINAL consultation timeframe preserved.")
        return {"success": True, "message": "Encounter notes updated successfully."}
    except Exception as e:
        print(f" [Encounter Update] Edit failed: {e}")
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
            "INSERT INTO encounters (patient_id, doctor_id, transcript, structured_notes_json, doc_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
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
        gemma_system_prompt = """You are an admin assistant. Answer the question using ONLY the provided PATIENTS list context.
        Note: Patients marked with '[ACTIVE]' are active patients in the queue. Patients marked with '[PAST]' are past patients."""
        gemma_user_prompt = f"PATIENTS:\n{my_patients_data}\n\nQUESTION:\n{question_text}"
        try:
            print(" [Clinical Brain] Dispatching ADMIN query to gemma:2b model...")
            response = ollama.chat(model='gemma:2b', messages=[
                {'role': 'system', 'content': gemma_system_prompt},
                {'role': 'user', 'content': gemma_user_prompt}
            ])
            content = response['message']['content'].strip()
            
            # Check for generic refusals or model confusion in the response
            refusal_keywords = ["cannot", "not provide", "no information", "don't have info", "unable to", "does not contain"]
            if any(ref in content.lower() for ref in refusal_keywords):
                print(" [Clinical Brain] gemma:2b returned a refusal, falling back to llama3 model...")
                response = ollama.chat(model='llama3', messages=[
                    {'role': 'system', 'content': gemma_system_prompt},
                    {'role': 'user', 'content': gemma_user_prompt}
                ])
                content = response['message']['content'].strip()
                
            print(" [Clinical Brain] ADMIN response generated successfully.")
            return {"answer": content}
        except Exception as e:
            print(f" [Clinical Brain] Gemma ADMIN error: {e}, falling back to llama3...")
            try:
                response = ollama.chat(model='llama3', messages=[
                    {'role': 'system', 'content': gemma_system_prompt},
                    {'role': 'user', 'content': gemma_user_prompt}
                ])
                print(" [Clinical Brain] llama3 fallback ADMIN response generated successfully.")
                return {"answer": response['message']['content'].strip()}
            except Exception as le:
                print(f" [Clinical Brain] llama3 fallback ADMIN failed: {le}")
                return {"answer": f"System Error: {str(le)}"}

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
        print(" [Clinical Brain] Querying ChromaDB guidelines Vector Store...")
        results = collection.query(query_texts=[question_text], n_results=5)
        if results['documents']:
            for doc, meta in zip(results['documents'][0], results['metadatas'][0]):
                if meta and meta.get("type") == "guideline":
                    guideline_docs.append(f"Source: {meta.get('filename')}\n{doc}")
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

    system_prompt = """You are 'Clinical Brain', an expert medical support assistant. 
    You are assisting the logged-in clinician with the active patient in the consultation room.
    Use the CURRENT SESSION INFO to identify the doctor and patient, and synthesize your knowledge with the active patient's history, other patients' records, and official medical guidelines to answer clinical or administrative questions clearly."""

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

    try:
        print(" [Clinical Brain] Dispatching CLINICAL query to llama3 model...")
        response = ollama.chat(model='llama3', messages=messages)
        print(" [Clinical Brain] llama3 generation complete.")
        return {"answer": response['message']['content'].strip()}
    except Exception as e:
        print(f" [Clinical Brain] llama3 connection failed, falling back to medllama2: {e}")
        response = ollama.chat(model='medllama2', messages=messages)
        print(" [Clinical Brain] medllama2 fallback generation complete.")
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

# CLINICAL IDENTITY AND ASSIGNMENT ENDPOINTS
@app.get("/admin/doctors")
async def get_all_doctors():
    doctors = query_db("SELECT id, username, first_name, last_name, specialty FROM users WHERE role = 'dr' AND is_approved = 1")
    return {"doctors": doctors}

import re
from fastapi import HTTPException

@app.post("/admin/register-patient")
async def register_patient(query: PatientRegisterQuery):
    # Regex alphanumeric check for IC Number
    if not re.match("^[a-zA-Z0-9]+$", query.ic_number):
        return {"success": False, "message": "Access Denied: Patient ID / IC Number cannot contain special characters or spaces."}

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