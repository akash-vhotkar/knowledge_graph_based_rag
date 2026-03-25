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

// Fetch all entities and relationships for a document (or the whole graph)
async function fetchGraphContext(documentId) {
  const session = getDriver().session();
  try {
    // Fetch all nodes
    const nodeQuery = documentId
      ? `MATCH (e) WHERE e.documentId = $documentId AND NOT e:Document RETURN labels(e) AS labels, e.name AS name, e.id AS id, properties(e) AS props`
      : `MATCH (e) WHERE NOT e:Document RETURN labels(e) AS labels, e.name AS name, e.id AS id, properties(e) AS props`;

    const nodeResult = await session.run(nodeQuery, { documentId });
    const entities = nodeResult.records.map((r) => ({
      id: r.get('id'),
      name: r.get('name'),
      label: r.get('labels')[0],
      properties: r.get('props'),
    }));

    // Fetch all relationships
    const relQuery = documentId
      ? `MATCH (a)-[r]->(b) WHERE a.documentId = $documentId AND b.documentId = $documentId AND NOT a:Document AND NOT b:Document RETURN a.name AS from, type(r) AS type, b.name AS to`
      : `MATCH (a)-[r]->(b) WHERE NOT a:Document AND NOT b:Document RETURN a.name AS from, type(r) AS type, b.name AS to`;

    const relResult = await session.run(relQuery, { documentId });
    const relationships = relResult.records.map((r) => ({
      from: r.get('from'),
      type: r.get('type'),
      to: r.get('to'),
    }));

    return { entities, relationships };
  } finally {
    await session.close();
  }
}

// Answer the question using the full graph context
async function generateAnswer(question, graphContext) {
  const context = JSON.stringify(graphContext, null, 2);

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

async function askGraph(question, documentId) {
  const graphContext = await fetchGraphContext(documentId);
  const answer = await generateAnswer(question, graphContext);

  return { answer, graphContext };
}

module.exports = { askGraph };
