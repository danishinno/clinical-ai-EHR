import requests

mock_transcript = "Patient is Sarah. She is 34 years old. She complains of chronic headaches and fatigue. Blood pressure is 120/80. Heart rate is 70. Temperature is 98.6. Further diagnosis might be slight anemia. I am prescribing her 200mg ibuprofen. Plan is to follow up in 2 weeks. Comments: she seemed very stressed."

response = requests.post("http://127.0.0.1:8000/process-dictation", json={"doctor_id": 4, "transcript": mock_transcript})
if response.status_code == 200:
    print("Process Result:")
    print(response.json())
else:
    print("Error:", response.status_code, response.text)

