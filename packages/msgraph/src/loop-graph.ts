import { getAccessToken } from "./auth.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export async function graphGet(
  path: string,
  params?: Record<string, string>
): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph GET ${response.status}: ${body}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function graphGetText(
  path: string,
  params?: Record<string, string>
): Promise<string> {
  const token = await getAccessToken();
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph GET ${response.status}: ${body}`);
  }

  return response.text();
}

export async function graphPost(
  path: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<any> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph POST ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return null;
}

export async function graphPut(
  path: string,
  content: string,
  contentType = "application/octet-stream"
): Promise<any> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    },
    body: content,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph PUT ${response.status}: ${text}`);
  }

  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return response.json();
  }
  return null;
}

export async function graphPatch(
  path: string,
  body: Record<string, unknown>
): Promise<any> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph PATCH ${response.status}: ${text}`);
  }

  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return response.json();
  }
  return null;
}

export async function graphDelete(path: string): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph DELETE ${response.status}: ${text}`);
  }
}
