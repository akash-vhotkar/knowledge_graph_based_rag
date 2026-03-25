const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

const chat = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-3.5-turbo',
  temperature: 0.7,
});

async function sendMessage(message, systemPrompt = null) {
  const messages = [];

  if (systemPrompt) {
    messages.push(new SystemMessage(systemPrompt));
  }

  messages.push(new HumanMessage(message));

  const response = await chat.invoke(messages);

  return {
    content: response.content,
    usage: response.usage_metadata,
  };
}

module.exports = {
  chat,
  sendMessage,
  HumanMessage,
  SystemMessage,
};
