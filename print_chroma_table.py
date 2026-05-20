import chromadb
import json

client = chromadb.PersistentClient(path="./medical_knowledge")
collections = client.list_collections()

for col in collections:
    print(f"### Collection: {col.name} ({col.count()} documents)\n")
    if col.count() == 0:
        continue
        
    data = col.get()
    
    print("| ID | Patient Name | Document Snippet |")
    print("|---|---|---|")
    
    for i in range(len(data['ids'])):
        doc_id = data['ids'][i]
        # Truncate ID for readability
        short_id = doc_id[:8] + "..."
        
        meta = data['metadatas'][i] if data['metadatas'] and data['metadatas'][i] else {}
        patient_name = meta.get('patient_name', 'Unknown')
        
        doc_text = data['documents'][i] if data['documents'] and data['documents'][i] else ""
        # Clean up whitespace and truncate
        clean_text = " ".join(doc_text.split())
        if len(clean_text) > 80:
            clean_text = clean_text[:77] + "..."
            
        print(f"| {short_id} | {patient_name} | {clean_text} |")
