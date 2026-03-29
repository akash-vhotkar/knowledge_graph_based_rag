const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const neo4j = require('neo4j-driver');

let driver;
function getDriver() {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI || 'neo4j://localhost:7687',
      neo4j.auth.basic(
        process.env.NEO4J_USER || 'neo4j',
        process.env.NEO4J_PASSWORD || 'password'
      )
    );
  }
  return driver;
}

let model;
function getModel() {
  if (!model) {
    model = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'gpt-4o-mini',
      temperature: 0,
    });
  }
  return model;
}

// ─── Step 1: Extract keywords from the question ──────────────────────────────
// Strips stop words and short tokens so we get meaningful search terms.

const STOP_WORDS = new Set([
  'who', 'what', 'where', 'when', 'how', 'why', 'which',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'the', 'a', 'an', 'in', 'of', 'for', 'to', 'and', 'or',
  'does', 'do', 'did', 'has', 'have', 'had',
  'me', 'my', 'you', 'your', 'it', 'its', 'tell', 'about',
]);

function extractKeywords(question) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── Step 2: Find relevant nodes ─────────────────────────────────────────────
// Matches nodes whose name contains any of the question keywords.
// Falls back to all nodes if no keyword matches are found.

async function findRelevantNodes(question, documentId) {
  const keywords = extractKeywords(question);
  const session = getDriver().session();

  try {
    let nodes = [];

    if (keywords.length > 0) {
      const conditions = keywords.map((_, i) => `toLower(e.name) CONTAINS $kw${i}`).join(' OR ');
      const params = { documentId };
      keywords.forEach((kw, i) => { params[`kw${i}`] = kw; });

      const query = documentId
        ? `MATCH (e) WHERE e.documentId = $documentId AND NOT e:Document AND (${conditions})
           RETURN e.id AS id, e.name AS name, labels(e) AS labels, properties(e) AS props`
        : `MATCH (e) WHERE NOT e:Document AND (${conditions})
           RETURN e.id AS id, e.name AS name, labels(e) AS labels, properties(e) AS props`;

      const result = await session.run(query, params);
      nodes = result.records.map((r) => ({
        id: r.get('id'),
        name: r.get('name'),
        label: r.get('labels')[0],
        properties: r.get('props'),
      }));
    }

    // Fallback: if keyword search finds nothing, return all nodes in scope
    if (nodes.length === 0) {
      const fallbackQuery = documentId
        ? `MATCH (e) WHERE e.documentId = $documentId AND NOT e:Document
           RETURN e.id AS id, e.name AS name, labels(e) AS labels, properties(e) AS props`
        : `MATCH (e) WHERE NOT e:Document
           RETURN e.id AS id, e.name AS name, labels(e) AS labels, properties(e) AS props`;

      const fallback = await session.run(fallbackQuery, { documentId });
      nodes = fallback.records.map((r) => ({
        id: r.get('id'),
        name: r.get('name'),
        label: r.get('labels')[0],
        properties: r.get('props'),
      }));
    }
    console.log("the nodes  ==", nodes)

    return nodes;
  } finally {
    await session.close();
  }
}

// ─── Step 3: Expand neighbors ────────────────────────────────────────────────
// For each relevant node, fetches all directly connected nodes and edges (1 hop).

async function expandNeighbors(nodeIds, documentId) {
  if (nodeIds.length === 0) return { nodes: [], relationships: [] };

  const session = getDriver().session();
  try {
    const query = documentId
      ? `MATCH (a)-[r]->(b)
         WHERE a.id IN $nodeIds AND a.documentId = $documentId
           AND NOT a:Document AND NOT b:Document
         RETURN a.id AS fromId, a.name AS fromName, labels(a) AS fromLabels, properties(a) AS fromProps,
                type(r) AS relType, properties(r) AS relProps,
                b.id AS toId, b.name AS toName, labels(b) AS toLabels, properties(b) AS toProps`
      : `MATCH (a)-[r]->(b)
         WHERE a.id IN $nodeIds AND NOT a:Document AND NOT b:Document
         RETURN a.id AS fromId, a.name AS fromName, labels(a) AS fromLabels, properties(a) AS fromProps,
                type(r) AS relType, properties(r) AS relProps,
                b.id AS toId, b.name AS toName, labels(b) AS toLabels, properties(b) AS toProps`;

    const result = await session.run(query, { nodeIds, documentId });
    const nodeMap = new Map();

    const relationships = [];

    for (const r of result.records) {
      nodeMap.set(r.get('fromId'), {
        id: r.get('fromId'),
        name: r.get('fromName'),
        label: r.get('fromLabels')[0],
        properties: r.get('fromProps'),
      });
      nodeMap.set(r.get('toId'), {
        id: r.get('toId'),
        name: r.get('toName'),
        label: r.get('toLabels')[0],
        properties: r.get('toProps'),
      });
      relationships.push({
        from: r.get('fromName'),
        type: r.get('relType'),
        to: r.get('toName'),
      });
    }

    return { nodes: Array.from(nodeMap.values()), relationships };
  } finally {
    await session.close();
  }
}

// ─── Step 4: Build subgraph ───────────────────────────────────────────────────
// Merges relevant nodes + their expanded neighbors into one deduplicated context.

function buildSubgraph(relevantNodes, expanded) {
  const nodeMap = new Map();

  for (const n of relevantNodes) nodeMap.set(n.id, n);
  for (const n of expanded.nodes) nodeMap.set(n.id, n);

  return {
    entities: Array.from(nodeMap.values()),
    relationships: expanded.relationships,
  };
}

// ─── Step 5: Generate answer via LLM ─────────────────────────────────────────
// Sends the subgraph as JSON context to GPT-4o-mini and returns a grounded answer.

async function generateAnswer(question, subgraph) {
  const context = JSON.stringify(subgraph, null, 2);

  const messages = [
    new SystemMessage(`You are a helpful assistant that answers questions based on knowledge graph data.
The graph contains entities (nodes) and relationships (edges) extracted from a document.
Use the provided graph data to answer the question accurately and concisely.
If the answer is not in the graph data, say so clearly.`),
    new HumanMessage(`Question: ${question}\n\nKnowledge graph:\n${context}`),
  ];

  const response = await getModel().invoke(messages);
  return response.content.trim();
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────
// Runs all five steps in sequence and returns the final answer + subgraph.

async function askGraph(question, documentId) {
  // Step 1 + 2: find nodes relevant to the question
  const relevantNodes = await findRelevantNodes(question, documentId);

  // Step 3: expand to their direct neighbors
  const nodeIds = relevantNodes.map((n) => n.id);
  const expanded = await expandNeighbors(nodeIds, documentId);
  console.log("the expanded neighbors nodes ==  ", expanded);

  // Step 4: merge into a focused subgraph
  const subgraph = buildSubgraph(relevantNodes, expanded);
  console.log("the subgraph  == ", subgraph);
  // Step 5: generate a grounded answer
  const answer = await generateAnswer(question, subgraph);

  return { answer, graphContext: subgraph };
}

module.exports = { askGraph };
