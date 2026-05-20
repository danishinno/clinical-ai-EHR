import sqlite3
import os

DB_NAME = "clinical_data.db"

def init_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    
    # 1. Create Users table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT,
            is_approved BOOLEAN,
            first_name TEXT,
            last_name TEXT,
            id_number TEXT,
            specialty TEXT
        )''')
    
    # 2. Create Master Patients table (Static Identity Profiles)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS patients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doctor_id INTEGER,
            patient_name TEXT,
            age INTEGER,
            ic_number TEXT UNIQUE,
            created_at TEXT,
            FOREIGN KEY(doctor_id) REFERENCES users(id)
        )''')

    # 3. Create Encounters table (Dynamic Visit Log - Multi-visit resolution tracking)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS encounters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id INTEGER,
            doctor_id INTEGER,
            transcript TEXT,
            structured_notes_json TEXT,
            doc_id TEXT,
            created_at TEXT,
            FOREIGN KEY(patient_id) REFERENCES patients(id),
            FOREIGN KEY(doctor_id) REFERENCES users(id)
        )''')
    
    # Run structural database column migrations
    for col in ["first_name TEXT", "last_name TEXT", "id_number TEXT", "specialty TEXT"]:
        try:
            cursor.execute(f"ALTER TABLE users ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass
            
    try:
        cursor.execute("ALTER TABLE patients ADD COLUMN ic_number TEXT")
    except sqlite3.OperationalError:
        pass

    try:
        cursor.execute("ALTER TABLE patients ADD COLUMN age INTEGER")
    except sqlite3.OperationalError:
        pass

    # Migrate patient ages from structured notes JSON to the 'age' column
    import json
    try:
        cursor.execute("SELECT id, structured_notes_json FROM patients WHERE structured_notes_json IS NOT NULL")
        rows = cursor.fetchall()
        for p_id, notes_json in rows:
            if notes_json:
                try:
                    notes_obj = json.loads(notes_json)
                    age_val = notes_obj.get("age")
                    if age_val is not None:
                        try:
                            age_int = int(age_val)
                            cursor.execute("UPDATE patients SET age = ? WHERE id = ?", (age_int, p_id))
                        except Exception:
                            pass
                except Exception:
                    pass
    except Exception as e:
        print(f"⚠️ Error migrating patient ages: {e}")

    # Transfer historical records from patients to encounters table if structured notes exist
    try:
        cursor.execute("SELECT id, doctor_id, structured_notes_json, created_at, doc_id FROM patients WHERE structured_notes_json IS NOT NULL")
        old_records = cursor.fetchall()
        for p_id, dr_id, notes_json, created_at, doc_id in old_records:
            if doc_id:
                cursor.execute("SELECT id FROM encounters WHERE doc_id = ?", (doc_id,))
                if not cursor.fetchone():
                    cursor.execute('''
                        INSERT INTO encounters (patient_id, doctor_id, transcript, structured_notes_json, doc_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    ''', (p_id, dr_id, "Migrated historical consultation record.", notes_json, doc_id, created_at))
            else:
                cursor.execute("SELECT id FROM encounters WHERE patient_id = ? AND created_at = ?", (p_id, created_at))
                if not cursor.fetchone():
                    import uuid
                    new_doc_id = str(uuid.uuid4())
                    cursor.execute('''
                        INSERT INTO encounters (patient_id, doctor_id, transcript, structured_notes_json, doc_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    ''', (p_id, dr_id, "Migrated historical consultation record.", notes_json, new_doc_id, created_at))
        print("✅ Database migration and encounter sync complete.")
    except Exception as e:
        print(f"⚠️ Error migrating encounters: {e}")
            
    # Create default Master Admin credentials if none exist
    cursor.execute("SELECT id FROM users WHERE username = 'Admin'")
    admin_exists = cursor.fetchone()
    
    if not admin_exists:
        cursor.execute('''
            INSERT INTO users (username, password, role, is_approved)
            VALUES (?, ?, ?, ?)
        ''', ('Admin', 'Abc123', 'admin', True))
        print("✅ Super Admin initialized successfully: Admin / Abc123")
        
    conn.commit()
    conn.close()

def query_db(query, args=(), one=False, commit=False):
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(query, args)
    
    rv = []
    if not commit:
        rv = cur.fetchall()
        rv = [dict(row) for row in rv]
    else:
        conn.commit()
        rv = cur.lastrowid
        
    cur.close()
    conn.close()
    
    if commit:
        return rv
    return (rv[0] if rv else None) if one else rv