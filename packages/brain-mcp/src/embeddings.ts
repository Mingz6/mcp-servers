import { AzureOpenAI } from "openai";
import { createLogger } from "./logger.js";

const EMBEDDING_DIMENSION = 1536;
const MAX_BATCH_SIZE = 16;

const log = createLogger("embeddings");

let client: AzureOpenAI | undefined;
let dimensionVerified = false;

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
    timeout: 30_000,
    // Disable SDK-level retry; we own retry below with explicit backoff.
    // Without this, a single 429 cascades to ~12 attempts (4 outer x 3 SDK).
    maxRetries: 0,
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

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyDimension(vector: Float32Array): void {
  if (dimensionVerified) return;
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding dimension mismatch: AOAI returned ${vector.length}-dim vectors but index expects ${EMBEDDING_DIMENSION}. ` +
        `Check AZURE_OPENAI_EMBEDDING_DEPLOYMENT (must point to a 1536-dim model like text-embedding-ada-002 or text-embedding-3-small).`
    );
  }
  dimensionVerified = true;
}

export async function embed(texts: readonly string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const aoai = getClient();
  const deployment = getDeployment();
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await aoai.embeddings.create({
          model: deployment,
          input: batch,
        });
        for (const item of response.data) {
          const vec = new Float32Array(item.embedding);
          verifyDimension(vec);
          results.push(vec);
        }
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        const is429 =
          err instanceof Error &&
          (err.message.includes("429") || err.message.toLowerCase().includes("rate limit"));
        if (!is429 || attempt === MAX_RETRIES) {
          log.error("Embedding request failed", err, { attempt, batchSize: batch.length });
          throw err;
        }
        const waitMs = RETRY_BASE_MS * 2 ** attempt; // 2s, 4s, 8s, 16s
        log.warn(`Rate limited; backing off ${waitMs}ms`, { attempt, batchSize: batch.length });
        await sleep(waitMs);
      }
    }
    if (lastError) throw lastError;
  }

  return results;
}

export async function embedSingle(text: string): Promise<Float32Array> {
  const [vector] = await embed([text]);
  return vector;
}

export async function checkAoaiHealth(): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const started = performance.now();
  try {
    const [vec] = await embed(["health check"]);
    if (vec.length !== EMBEDDING_DIMENSION) {
      return { ok: false, error: `Dimension mismatch: ${vec.length} vs ${EMBEDDING_DIMENSION}` };
    }
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

export { EMBEDDING_DIMENSION };
