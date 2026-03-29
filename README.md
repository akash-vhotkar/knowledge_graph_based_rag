# Context Graph AI

A Node.js REST API that turns raw documents (PDFs, images) into a queryable knowledge graph. It uses OCR to extract text, an LLM to identify entities and relationships, stores them in a Neo4j graph database, and then answers natural-language questions by querying that graph.

---

## Architecture & Data Flow

```
Document Upload
     │
     ▼
[lib/ocr.js]  ──── Mistral OCR API ──── Extract raw text
     │
     ▼
[lib/graphExtractor.js]  ──── GPT-4o-mini ──── Extract entities + relationships (JSON)
     │
     ▼
[lib/neo4j.js]  ──── Neo4j ──── Store nodes and edges
     │
     ▼
[lib/graphQuery.js]  ──── Neo4j + GPT-4o-mini ──── Answer questions from the graph
```

---

## Files & Responsibilities

### `index.js` — HTTP Server & API Router

The entry point. Sets up the Express server and defines all three endpoints.

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Health check |
| `/document/process` | POST | Upload a file → OCR → extract graph → store in Neo4j |
| `/graph/query` | POST | Ask a question against the stored knowledge graph |
| `/chat` | POST | Alias for `/graph/query` (simpler interface) |

**Key behaviors:**
- Uses `multer` to accept multipart file uploads, saving them temporarily to `/uploads/`
- Deletes the uploaded file after processing (cleanup in `finally` block)
- Accepts an optional `documentId` to scope queries to a single document

---

### `lib/ocr.js` — Document Text Extraction

Sends the uploaded file to the **Mistral OCR API** (`mistral-ocr-latest`) and returns plain text.

- Converts the file to base64 and sends as a data URL
- Supports: PDF, JPG, JPEG, PNG, BMP, TIFF, WEBP
- PDFs use `document_url` type; images use `image_url` type
- Returns the concatenated markdown text from all pages

**Env required:** `MISTRAL_API_KEY`

---

### `lib/graphExtractor.js` — Knowledge Graph Extraction

Uses **GPT-4o-mini** via LangChain to parse text and return a structured knowledge graph as JSON.

**Output shape:**
```json
{
  "entities": [
    { "id": "snake_case_id", "label": "EntityType", "name": "Display Name", "properties": {} }
  ],
  "relationships": [
    { "from": "entity_id", "to": "entity_id", "type": "RELATIONSHIP_TYPE", "properties": {} }
  ]
}
```

**Entity label examples:** `Person`, `Organization`, `Location`, `Concept`, `Event`, `Product`, `Date`, `Technology`

**Relationship type examples:** `WORKS_FOR`, `LOCATED_IN`, `CREATED_BY`, `RELATED_TO`, `PART_OF`

**Env required:** `OPENAI_API_KEY`

---

### `lib/neo4j.js` — Graph Storage

Persists the extracted graph to **Neo4j** using the official `neo4j-driver`.

**What it stores:**
- A `Document` node with a unique `documentId` and `createdAt` timestamp
- One node per entity, tagged with its label (e.g. `:Person`, `:Organization`) and linked to its document via a `CONTAINS` relationship
- One directed relationship per entry in the `relationships` array (e.g. `WORKS_FOR`, `LOCATED_IN`)
- Uses `MERGE` to avoid duplicate nodes/relationships on re-processing

**Exports:**
- `storeGraph(graph, documentId)` — writes everything, returns `{ nodesCreated, relationshipsCreated }`
- `closeDriver()` — gracefully closes the Neo4j connection

**Env required:** `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`

---

### `lib/graphQuery.js` — Graph-Based Question Answering (Knowledge Graph RAG)

Implements the RAG (Retrieval-Augmented Generation) loop over the Neo4j graph.

**Two-step process:**
1. **Fetch context** — queries Neo4j for all entities and relationships (optionally scoped by `documentId`)
2. **Generate answer** — sends the full graph as JSON context to **GPT-4o-mini** along with the question

**Exports:**
- `askGraph(question, documentId?)` — returns `{ answer, graphContext }`

**Env required:** `OPENAI_API_KEY`, `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`

---

### `lib/langchain.js` — Generic LangChain Chat Wrapper

A simple utility wrapper around **GPT-3.5-turbo** for general-purpose chat. Not used by the main pipeline but available as a helper.

**Exports:**
- `sendMessage(message, systemPrompt?)` — returns `{ content, usage }`
- `chat` — the raw LangChain `ChatOpenAI` instance

---

## Query Flow — What Happens Internally

```
User Query
    │
    ▼
1. Receive query (index.js)
    │
    ▼
2. Find relevant nodes (Neo4j — match by documentId or full graph)
    │
    ▼
3. Expand neighbors (fetch all connected relationships)
    │
    ▼
4. Build subgraph (assemble entities + relationships into context object)
    │
    ▼
5. LLM generates answer (GPT-4o-mini — graph context + question → answer)
```

---

### Step 1 — Receive Query (`index.js`)

The user calls one of:

```
POST /chat        → body: { "message": "...", "documentId": "doc_123" }
POST /graph/query → body: { "question": "...", "documentId": "doc_123" }
```

Both routes validate the input and call:

```js
askGraph(question, documentId)  // lib/graphQuery.js
```

`documentId` is optional. If provided, the query is scoped to that single document only.

---

### Step 2 — Find Relevant Nodes (`fetchGraphContext` → node query)

A Neo4j session opens and queries all entity nodes matching the scope:

```cypher
-- Scoped to one document:
MATCH (e)
WHERE e.documentId = $documentId AND NOT e:Document
RETURN labels(e) AS labels, e.name AS name, e.id AS id, properties(e) AS props

-- Across all documents:
MATCH (e)
WHERE NOT e:Document
RETURN labels(e) AS labels, e.name AS name, e.id AS id, properties(e) AS props
```

Returns every node (Person, Organization, Location, etc.) that belongs to the target scope.

---

### Step 3 — Expand Neighbors (`fetchGraphContext` → relationship query)

For every node found above, all outgoing and incoming relationships are fetched:

```cypher
-- Scoped to one document:
MATCH (a)-[r]->(b)
WHERE a.documentId = $documentId AND b.documentId = $documentId
  AND NOT a:Document AND NOT b:Document
RETURN a.name AS from, type(r) AS type, b.name AS to

-- Across all documents:
MATCH (a)-[r]->(b)
WHERE NOT a:Document AND NOT b:Document
RETURN a.name AS from, type(r) AS type, b.name AS to
```

This captures all edges — `WORKS_FOR`, `LOCATED_IN`, `CREATED_BY`, etc. — connecting the nodes.

---

### Step 4 — Build Subgraph

The nodes and edges are assembled into a single `graphContext` object in memory:

```json
{
  "entities": [
    { "id": "john_smith", "name": "John Smith", "label": "Person", "properties": {} },
    { "id": "acme_corp",  "name": "Acme Corp",  "label": "Organization", "properties": {} }
  ],
  "relationships": [
    { "from": "John Smith", "type": "WORKS_FOR", "to": "Acme Corp" }
  ]
}
```

This subgraph is the complete, structured context that will be handed to the LLM.

---

### Step 5 — LLM Generates Answer (`generateAnswer`)

The subgraph is serialized to JSON and sent to **GPT-4o-mini** as grounding context:

```
System: You are a helpful assistant that answers questions based on
        knowledge graph data. Use the provided graph to answer
        accurately and concisely. If the answer is not in the graph,
        say so clearly.
Human: Question: {question}

Knowledge graph:
{graphContext as JSON}
```

The LLM reads the full subgraph and returns a grounded, natural-language answer.

If the graph contains the answer, it is stated directly.
If not, the LLM says so — it does not hallucinate.

**Final return value:**

```json
{
  "answer": "John Smith works for Acme Corp.",
  "graphContext": { "entities": [...], "relationships": [...] }
}
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Used by `graphExtractor.js` and `graphQuery.js` |
| `MISTRAL_API_KEY` | Yes | Used by `ocr.js` for document text extraction |
| `NEO4J_URI` | Yes | Neo4j connection URI (default: `neo4j://localhost:7687`) |
| `NEO4J_USER` | Yes | Neo4j username (default: `neo4j`) |
| `NEO4J_PASSWORD` | Yes | Neo4j password |
| `PORT` | No | HTTP server port (default: `3000`) |

---

## API Reference

### `GET /`

Health check.

**Response:**
```json
{ "status": "ok", "message": "Context Graph AI API is running" }
```

---

### `POST /document/process`

Upload a document to extract and store its knowledge graph.

**Request:** `multipart/form-data`, field name `file`

**Response:**
```json
{
  "documentId": "doc_1234567890",
  "extractedText": "...",
  "graph": { "entities": [], "relationships": [] },
  "neo4j": { "nodesCreated": 5, "relationshipsCreated": 4 }
}
```

---

### `POST /graph/query`

Ask a question against the stored knowledge graph.

**Request:**
```json
{ "question": "Who works for Acme Corp?", "documentId": "doc_123" }
```

> `documentId` is optional. Omit it to query across all documents.

**Response:**
```json
{
  "answer": "John Smith works for Acme Corp.",
  "graphContext": { "entities": [], "relationships": [] }
}
```

---

### `POST /chat`

Simplified chat interface (same behavior as `/graph/query`).

**Request:**
```json
{ "message": "What products does Acme make?", "documentId": "doc_123" }
```

**Response:**
```json
{ "response": "Acme makes widgets and gadgets." }
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| HTTP Framework | Express 5 |
| File Upload | Multer |
| OCR | Mistral AI (`mistral-ocr-latest`) |
| LLM | OpenAI GPT-4o-mini (via LangChain) |
| Graph Database | Neo4j 6 |
| LLM Framework | LangChain (`@langchain/openai`, `@langchain/core`) |
| Dev Server | Nodemon |

---

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env
# Fill in OPENAI_API_KEY, MISTRAL_API_KEY, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD

# 3. Start Neo4j (locally or via Docker)
# Make sure it is reachable at the URI set in .env

# 4. Run the server
npm start          # production
npm run dev        # development with auto-reload
```

The API will be available at `http://localhost:3000`.
