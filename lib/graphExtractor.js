const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

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

const SYSTEM_PROMPT = `You are a knowledge graph extraction engine.
Given a text, extract all entities and relationships to form a context graph.

Respond ONLY with valid JSON in this exact format:
{
  "entities": [
    { "id": "unique_snake_case_id", "label": "EntityType", "name": "Display Name", "properties": {} }
  ],
  "relationships": [
    { "from": "entity_id", "to": "entity_id", "type": "RELATIONSHIP_TYPE", "properties": {} }
  ]
}

Rules:
- Entity labels: Person, Organization, Location, Concept, Event, Product, Date, Technology, etc.
- Relationship types: uppercase with underscores (e.g. WORKS_FOR, LOCATED_IN, CREATED_BY, RELATED_TO, PART_OF, etc.)
- Entity id must be unique snake_case strings
- Include only entities and relationships clearly stated or strongly implied in the text
- Do not include markdown, explanations, or any text outside the JSON`;

async function extractContextGraph(text) {
  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(`Extract the context graph from this text:\n\n${text}`),
  ];

  const response = await getModel().invoke(messages);

  let raw = response.content.trim();
  // Strip markdown code fences if present
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const graph = JSON.parse(raw);

  if (!Array.isArray(graph.entities) || !Array.isArray(graph.relationships)) {
    throw new Error('Invalid graph format returned by LLM');
  }

  return graph;
}

module.exports = { extractContextGraph };
