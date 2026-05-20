import chromadb
import json

client = chromadb.PersistentClient(path="./medical_knowledge")
collections = client.list_collections()
print(f"Found {len(collections)} collection(s)\n")

for col in collections:
    print(f"Collection: {col.name}")
    count = col.count()
    print(f"Document count: {count}")
    if count > 0:
        print("Sample data (first item):")
        peek_data = col.peek(1)
        try:
            print(json.dumps(peek_data, indent=2, default=str))
        except Exception as e:
            print(peek_data)
    print("-" * 40)
