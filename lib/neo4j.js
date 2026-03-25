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

async function storeGraph(graph, documentId) {
  const session = getDriver().session();
  const results = { nodesCreated: 0, relationshipsCreated: 0 };

  try {
    await session.executeWrite(async (tx) => {
      // Create document node
      await tx.run(
        `MERGE (d:Document {id: $docId}) SET d.createdAt = datetime() RETURN d`,
        { docId: documentId }
      );

      // Create entity nodes
      for (const entity of graph.entities) {
        await tx.run(
          `MERGE (n:\`${entity.label}\` {id: $id, documentId: $docId})
           SET n.name = $name, n += $properties
           RETURN n`,
          {
            id: entity.id,
            docId: documentId,
            name: entity.name,
            properties: entity.properties || {},
          }
        );
        results.nodesCreated++;

        // Link entity to document
        await tx.run(
          `MATCH (d:Document {id: $docId})
           MATCH (n {id: $entityId, documentId: $docId})
           MERGE (d)-[:CONTAINS]->(n)`,
          { docId: documentId, entityId: entity.id }
        );
      }

      // Create relationships
      for (const rel of graph.relationships) {
        await tx.run(
          `MATCH (a {id: $from, documentId: $docId})
           MATCH (b {id: $to, documentId: $docId})
           MERGE (a)-[r:\`${rel.type}\`]->(b)
           SET r += $properties
           RETURN r`,
          {
            from: rel.from,
            to: rel.to,
            docId: documentId,
            properties: rel.properties || {},
          }
        );
        results.relationshipsCreated++;
      }
    });
  } finally {
    await session.close();
  }

  return results;
}

async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

module.exports = { storeGraph, closeDriver };
