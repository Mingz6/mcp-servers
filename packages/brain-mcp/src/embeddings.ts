import { AzureOpenAI } from "openai";

const EMBEDDING_DIMENSION = 1536;
const MAX_BATCH_SIZE = 16;

let client: AzureOpenAI | undefined;

function getClient(): AzureOpenAI {
  if (client) return client;

  const endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
  const apiKey = process.env["AZURE_OPENAI_API_KEY"];
  if (!endpoint || !apiKey) {
    throw new Error(
      "Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY env vars"
    );
  }

  client = new AzureOpenAI({
    endpoint,
    apiKey,
    apiVersion: "2024-06-01",
  });
  return client;
}

function getDeployment(): string {
  const deployment = process.env["AZURE_OPENAI_EMBEDDING_DEPLOYMENT"];
  if (!deployment) {
    throw new Error("Missing AZURE_OPENAI_EMBEDDING_DEPLOYMENT env var");
  }
  return deployment;
}

export async function embed(texts: readonly string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const aoai = getClient();
  const deployment = getDeployment();
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const response = await aoai.embeddings.create({
      model: deployment,
      input: batch,
    });

    for (const item of response.data) {
      results.push(new Float32Array(item.embedding));
    }
  }

  return results;
}

export async function embedSingle(text: string): Promise<Float32Array> {
  const [vector] = await embed([text]);
  return vector;
}

export { EMBEDDING_DIMENSION };
