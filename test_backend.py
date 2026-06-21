import requests
import sqlite3
from datetime import datetime, timedelta
import os

DB_NAME = "clinical_data.db"
BASE_URL = "http://127.0.0.1:8000"

def run_tests():
    print("--- Starting Backend Enhancements Test Suite ---")
    
    # 1. Test /admin/guidelines
    print("\nTesting GET /admin/guidelines...")
    res_guidelines = requests.get(f"{BASE_URL}/admin/guidelines")
    assert res_guidelines.status_code == 200, f"Expected 200, got {res_guidelines.status_code}"
    data_guidelines = res_guidelines.json()
    assert data_guidelines.get("success") is True, "Expected success to be True"
    assert "guidelines" in data_guidelines, "Expected 'guidelines' key in response"
    print("✅ GET /admin/guidelines works successfully. Guidelines count:", len(data_guidelines["guidelines"]))
    
    # 2. Test /report/monthly
    print("\nTesting GET /report/monthly...")
    res_report = requests.get(f"{BASE_URL}/report/monthly")
    assert res_report.status_code == 200, f"Expected 200, got {res_report.status_code}"
    data_report = res_report.json()
    assert data_report.get("success") is True, "Expected success to be True"
    assert "summary" in data_report, "Expected 'summary' key in report"
    assert "total_visits" in data_report["summary"], "Expected 'total_visits' in report summary"
    print("✅ GET /report/monthly works successfully. Total visits for current month:", data_report["summary"]["total_visits"])
    
    # 2b. Test /report/monthly?doctor_id=...
    print("\nTesting GET /report/monthly with doctor_id filtering...")
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("INSERT OR IGNORE INTO users (id, username, role, is_approved, first_name, last_name) VALUES (999, 'TestDr999', 'dr', 1, 'Test999', 'Dr')")
    cursor.execute("INSERT OR IGNORE INTO patients (id, doctor_id, patient_name, ic_number, age, gender) VALUES (999, 999, 'Test Patient 999', '999999999999', 30, 'Male')")
    now_str = datetime.now().strftime("%Y-%m-%dT%H:%M:%S.%f")
    cursor.execute("INSERT INTO encounters (patient_id, doctor_id, structured_notes_json, created_at) VALUES (999, 999, '{\"assessment\":\"Cold\",\"prescriptions\":[]}', ?)", (now_str,))
    enc_id = cursor.lastrowid
    conn.commit()

    try:
        res_dr_report = requests.get(f"{BASE_URL}/report/monthly?doctor_id=999")
        assert res_dr_report.status_code == 200, f"Expected 200, got {res_dr_report.status_code}"
        data_dr_report = res_dr_report.json()
        assert data_dr_report.get("success") is True
        assert data_dr_report["summary"]["total_visits"] == 1, f"Expected 1 visit, got {data_dr_report['summary']['total_visits']}"
        assert data_dr_report["summary"]["doctor_summary"][0]["doctor_name"] == "Dr. Test999 Dr"

        res_empty_report = requests.get(f"{BASE_URL}/report/monthly?doctor_id=9999")
        data_empty_report = res_empty_report.json()
        assert data_empty_report.get("success") is True
        assert data_empty_report["summary"]["total_visits"] == 0, f"Expected 0 visits, got {data_empty_report['summary']['total_visits']}"
        print("✅ GET /report/monthly?doctor_id=... filtering works successfully.")
    finally:
        cursor.execute("DELETE FROM encounters WHERE id = ?", (enc_id,))
        cursor.execute("DELETE FROM patients WHERE id = 999")
        cursor.execute("DELETE FROM users WHERE id = 999")
        conn.commit()
        conn.close()
    
    # 3. Test MC generation compliance rules
    print("\nSetting up database records for MC compliance tests...")
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    
    # Create or retrieve a test doctor user
    cursor.execute("SELECT id FROM users WHERE username = 'TestDoctor'")
    doctor = cursor.fetchone()
    if doctor:
        doc_id = doctor[0]
    else:
        cursor.execute("INSERT INTO users (username, password, role, is_approved, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)", 
                       ('TestDoctor', 'Abc123', 'dr', True, 'Test', 'Doctor'))
        doc_id = cursor.lastrowid
        
    # Create a test patient
    cursor.execute("INSERT INTO patients (doctor_id, patient_name, ic_number, age, gender) VALUES (?, ?, ?, ?, ?)",
                   (doc_id, "Test Patient", "TESTIC12345", 30, "Male"))
    patient_id = cursor.lastrowid
    
    # Set up timestamps
    now = datetime.now()
    past_date_str = (now - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.%f")
    old_today_str = (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S.%f")
    recent_today_str = (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S.%f")
    
    mock_notes_json = '{"assessment": "Common Cold", "prescriptions": []}'
    
    # Insert encounters
    # A: Past consultation (1 day ago)
    cursor.execute("INSERT INTO encounters (patient_id, doctor_id, structured_notes_json, created_at) VALUES (?, ?, ?, ?)",
                   (patient_id, doc_id, mock_notes_json, past_date_str))
    encounter_past_id = cursor.lastrowid
    
    # B: Today's consultation but old (>2 hours ago)
    cursor.execute("INSERT INTO encounters (patient_id, doctor_id, structured_notes_json, created_at) VALUES (?, ?, ?, ?)",
                   (patient_id, doc_id, mock_notes_json, old_today_str))
    encounter_old_id = cursor.lastrowid
    
    # C: Today's consultation and recent (<2 hours ago)
    cursor.execute("INSERT INTO encounters (patient_id, doctor_id, structured_notes_json, created_at) VALUES (?, ?, ?, ?)",
                   (patient_id, doc_id, mock_notes_json, recent_today_str))
    encounter_recent_id = cursor.lastrowid
    
    conn.commit()
    print(f"Created encounters: Past ID={encounter_past_id}, Old Today ID={encounter_old_id}, Recent ID={encounter_recent_id}")
    
    try:
        # Test Case A: MC for past consultation
        print("\nTesting MC generation compliance: Rejects past consultation...")
        res = requests.post(f"{BASE_URL}/generate-certificate", json={
            "encounter_id": encounter_past_id,
            "doctor_id": doc_id,
            "days_rest": 2
        })
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        data = res.json()
        assert data.get("success") is False, "Expected success to be False for past date"
        assert "past consultations" in data.get("message", ""), f"Unexpected error message: {data.get('message')}"
        print("✅ Past consultation rejection verified successfully.")
        
        # Test Case B: MC for consultation > 2 hours ago
        print("\nTesting MC generation compliance: Rejects > 2 hours consultation...")
        res = requests.post(f"{BASE_URL}/generate-certificate", json={
            "encounter_id": encounter_old_id,
            "doctor_id": doc_id,
            "days_rest": 2
        })
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        data = res.json()
        assert data.get("success") is False, "Expected success to be False for >2 hours"
        assert "2 hours" in data.get("message", ""), f"Unexpected error message: {data.get('message')}"
        print("✅ Over 2 hours lockout verified successfully.")
        
        # Test Case C: MC for recent consultation (< 2 hours)
        print("\nTesting MC generation compliance: Allows recent consultation (< 2 hours)...")
        res = requests.post(f"{BASE_URL}/generate-certificate", json={
            "encounter_id": encounter_recent_id,
            "doctor_id": doc_id,
            "days_rest": 2
        })
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        data = res.json()
        # Note: If ollama is down, this might fail, but it should NOT fail with compliance checks.
        # So we verify that the message is not the compliance error.
        if data.get("success"):
            print("✅ Recent consultation MC generated successfully (Ollama is online).")
        else:
            msg = data.get("message", "")
            assert "past consultations" not in msg and "2 hours" not in msg, f"Unexpected compliance failure: {msg}"
            print(f"✅ Recent consultation bypassed compliance checks successfully (Ollama failure caught: '{msg}').")
            
    finally:
        # Clean up database changes
        print("\nCleaning up test records from database...")
        cursor.execute("DELETE FROM encounters WHERE id IN (?, ?, ?)", (encounter_past_id, encounter_old_id, encounter_recent_id))
        cursor.execute("DELETE FROM patients WHERE id = ?", (patient_id,))
        cursor.execute("DELETE FROM users WHERE id = ?", (doc_id,))
        conn.commit()
        conn.close()
        print("✅ Cleanup completed.")

if __name__ == "__main__":
    run_tests()
