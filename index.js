require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractTextFromFile } = require('./lib/ocr');
const { extractContextGraph } = require('./lib/graphExtractor');
const { storeGraph } = require('./lib/neo4j');
const { askGraph } = require('./lib/graphQuery');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Multer: store uploads in /uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Context Graph AI API is running' });
});

// Chat endpoint — always answers from the knowledge graph
// Body: { "message": "...", "documentId": "doc_xxx" (optional, scopes to one document) }
app.post('/chat', async (req, res) => {
  try {
    const { message, documentId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await askGraph(message, documentId);

    res.json({
      response: result.answer,
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Document OCR + Context Graph endpoint
// POST /document/process  (multipart/form-data, field: "file")
app.post('/document/process', upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Use multipart field "file".' });
    }

    // Step 1: OCR - extract text from document
    const text = await extractTextFromFile(filePath, req.file.originalname, req.file.mimetype);

    if (!text) {
      return res.status(422).json({ error: 'No text could be extracted from the document.' });
    }

    // Step 2: Extract context graph using LLM
    const graph = await extractContextGraph(text);

    // Step 3: Store graph in Neo4j
    const documentId = `doc_${Date.now()}`;
    const storeResult = await storeGraph(graph, documentId);

    res.json({
      documentId,
      extractedText: text,
      graph,
      neo4j: storeResult,
    });
  } catch (error) {
    console.error('Document processing error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // Clean up uploaded file
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// Ask a question on the knowledge graph
// POST /graph/query
// Body: { "question": "Who works for Acme?", "documentId": "doc_123" (optional) }
app.post('/graph/query', async (req, res) => {
  try {
    const { question, documentId } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Field "question" is required.' });
    }

    const result = await askGraph(question, documentId);

    res.json(result);
  } catch (error) {
    console.error('Graph query error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
