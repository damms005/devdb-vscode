#!/usr/bin/env python3
"""Embeds sample docs with Ollama (nomic-embed-text, 768-d) and loads them into pgvector.documents.
Falls back to deterministic pseudo-random vectors when Ollama is not reachable."""
import json, random, subprocess, sys, urllib.request

OLLAMA = "http://localhost:11434/api/embeddings"
MODEL = "nomic-embed-text"
DOCS = [
    ("Resetting a password", "Users can reset a forgotten password from the login page via an emailed link.", "auth"),
    ("Two-factor authentication", "Enable TOTP-based 2FA in account settings for stronger login security.", "auth"),
    ("Single sign-on", "Enterprise plans support SAML and OIDC single sign-on with Okta and Azure AD.", "auth"),
    ("Refund policy", "Refunds are issued to the original payment method within 5 to 10 business days.", "billing"),
    ("Changing plans", "Upgrade or downgrade your subscription at any time; charges are prorated.", "billing"),
    ("Invoices", "Download PDF invoices for every billing period from the billing dashboard.", "billing"),
    ("Failed payments", "If a card payment fails we retry three times before suspending the account.", "billing"),
    ("Shipping times", "Standard shipping takes 3 to 5 days; express shipping arrives next business day.", "shipping"),
    ("International delivery", "We ship to over 40 countries; customs duties are paid by the recipient.", "shipping"),
    ("Tracking an order", "A tracking number is emailed once the parcel leaves our warehouse.", "shipping"),
    ("Database backups", "Automated backups run nightly and are retained for 30 days.", "infra"),
    ("Scaling compute", "Autoscaling adds compute when CPU usage stays above 70 percent for five minutes.", "infra"),
    ("Cold starts", "Serverless databases suspend when idle and take a moment to resume on the next query.", "infra"),
    ("Connection pooling", "Use a pooled connection string to handle many short-lived serverless connections.", "infra"),
    ("Vector search", "Store embeddings in a vector column and query with cosine distance for semantic search.", "ai"),
    ("HNSW indexes", "HNSW indexes give fast approximate nearest-neighbour search; tune ef_search for recall.", "ai"),
    ("Chunking documents", "Split long documents into overlapping chunks before embedding them.", "ai"),
    ("Banana bread recipe", "Mash three ripe bananas, mix with flour, sugar and butter, then bake for an hour.", "misc"),
    ("Watering houseplants", "Most houseplants prefer the soil to dry out slightly between waterings.", "misc"),
    ("Marathon training", "Build weekly mileage gradually and include one long slow run each week.", "misc"),
]

def embed(text):
    req = urllib.request.Request(OLLAMA, data=json.dumps({"model": MODEL, "prompt": text}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["embedding"]

def main():
    try:
        embed("ping"); use_ollama = True
    except Exception as e:
        print(f"Ollama not reachable ({e}); using pseudo-random vectors", file=sys.stderr); use_ollama = False
    rows = []
    for title, body, topic in DOCS:
        if use_ollama:
            v = embed(f"search_document: {title}. {body}")
        else:
            rnd = random.Random(title); v = [rnd.uniform(-1, 1) for _ in range(768)]
        assert len(v) == 768, len(v)
        esc = lambda s: s.replace("'", "''")
        rows.append(f"('{esc(title)}','{esc(body)}','{topic}','[{','.join(f'{x:.6f}' for x in v)}]')")
    sql = "TRUNCATE documents;\nINSERT INTO documents (title, body, topic, embedding) VALUES\n" + ",\n".join(rows) + ";\nANALYZE documents;\n"
    subprocess.run(["docker", "exec", "-i", "devdb-local-pgvector", "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "devdb", "-d", "vectors"],
                   input=sql.encode(), check=True)
    print(f"documents: {len(rows)} rows ({'ollama ' + MODEL if use_ollama else 'pseudo-random'})")

main()
