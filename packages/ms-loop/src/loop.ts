import { graphDelete, graphGet, graphGetText, graphPatch, graphPost, graphPut } from "./graph.js";

// --- Helpers ---

function encodeShareUrl(url: string): string {
  const b64 = Buffer.from(url, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return "u!" + b64;
}

function isSpeUrl(shareUrl: string): boolean {
  return shareUrl.includes("contentstorage/CSP_");
}

/**
 * Loop share links wrap the real SharePoint URL in a base64 JSON payload at
 * `loop.cloud.microsoft/p/{base64}`. The payload is either `{"u":"<url>"}` or the
 * newer `{"w":…,"p":{"u":"<url>"},"i":…}`. Passing the wrapper straight to Graph's
 * /shares/ endpoint yields a misleading 403 "sharing link no longer exists".
 */
function unwrapLoopShareUrl(shareUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(shareUrl);
  } catch {
    return shareUrl;
  }
  if (!parsed.hostname.endsWith("loop.cloud.microsoft")) return shareUrl;

  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  if (!segment) return shareUrl;

  try {
    const normalized = decodeURIComponent(segment)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    const inner = payload?.p?.u ?? payload?.u;
    return typeof inner === "string" && inner.length > 0 ? inner : shareUrl;
  } catch {
    return shareUrl;
  }
}

function parseSpeNavParam(navParam: string): {
  driveId: string | null;
  itemId: string | null;
} {
  try {
    const decoded = Buffer.from(navParam, "base64").toString("utf-8");
    const params = new URLSearchParams(decoded);
    return {
      driveId: params.get("d") || null,
      itemId: params.get("f") || null,
    };
  } catch {
    return { driveId: null, itemId: null };
  }
}

function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Loop workspace pages live in SharePoint Embedded containers this app registration has
 * no write access to. Graph's bare "accessDenied" leaves the caller with nothing to act
 * on, so redirect them to the browser path the loop-manager skill uses.
 */
function rethrowWriteError(err: unknown, operation: string): never {
  const msg = String(err);
  if (msg.includes("403") || msg.toLowerCase().includes("accessdenied")) {
    throw new Error(
      `Loop ${operation} failed (403 accessDenied). This drive is a Loop workspace ` +
        `(SharePoint Embedded container) and this MCP server has no write permission ` +
        `there — API writes are not possible. Use the browser instead: open the ` +
        `loop.cloud.microsoft page and edit the Canvas element (see the loop-manager ` +
        `skill). Original error: ${msg}`
    );
  }
  throw err;
}

// --- READ ---

export interface LoopFileInfo {
  id: string;
  name: string;
  driveId: string;
  size: number;
  webUrl: string;
  lastModified: string;
  mimeType?: string;
  summary?: string;
}

export interface LoopContent {
  name: string;
  driveId: string;
  itemId: string;
  webUrl: string;
  lastModified: string;
  size: number;
  mimeType?: string;
  html: string;
  text?: string;
  contentSource?: "direct" | "search-summary" | "unavailable";
}

async function fetchLoopHtml(
  driveId: string,
  itemId: string,
  knownSummary?: string
): Promise<{ html: string; source: "direct" | "search-summary" | "unavailable" }> {
  try {
    const html = await graphGetText(
      `/drives/${driveId}/items/${itemId}/content`,
      { format: "html" }
    );
    // Loop files return a nearly-empty HTML shell from format=html
    const text = htmlToText(html);
    if (text.length > 10) {
      return { html, source: "direct" };
    }
    // Empty content — fall through to search fallback
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("403") && !msg.includes("400") && !msg.includes("415")) {
      throw err;
    }
    // 403 (SPE container) or unsupported format — fall through
  }

  // Use known summary if we already have it from a prior search call
  if (knownSummary) {
    return { html: `<!-- Search-indexed content -->\n<p>${knownSummary}</p>`, source: "search-summary" };
  }

  // Last resort: search for this specific item to get indexed text
  const searchResult = await searchForItem(driveId, itemId);
  if (searchResult?.summary) {
    return { html: `<!-- Search-indexed content -->\n<p>${searchResult.summary}</p>`, source: "search-summary" };
  }
  return { html: "", source: "unavailable" };
}

function cleanSearchSummary(summary: string): string {
  // Search API wraps matched terms in <c0>...</c0> tags and uses <ddd/> for truncation
  return summary
    .replace(/<c\d+>/g, "")
    .replace(/<\/c\d+>/g, "")
    .replace(/<ddd\s*\/?>/g, "…")
    .trim();
}

async function searchForItem(
  driveId: string,
  itemId: string
): Promise<{ metadata: any; summary: string } | null> {
  try {
    const response = await graphPost("/search/query", {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString: "filetype:loop OR filetype:fluid" },
          from: 0,
          size: 200,
        },
      ],
    });
    const hits = response?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
    for (const hit of hits) {
      const hitDriveId = hit.resource?.parentReference?.driveId;
      if (hitDriveId === driveId && (hit.hitId === itemId || hit.resource?.id === itemId)) {
        return {
          metadata: {
            name: hit.resource.name,
            size: hit.resource.size ?? 0,
            webUrl: hit.resource.webUrl ?? "",
            lastModifiedDateTime: hit.resource.lastModifiedDateTime ?? "",
            file: { mimeType: hit.resource.file?.mimeType },
          },
          summary: cleanSearchSummary(hit.summary ?? ""),
        };
      }
    }
  } catch {
    // Search fallback failed
  }
  return null;
}

export async function getLoopByShareUrl(
  shareUrl: string,
  includeText = true
): Promise<LoopContent> {
  let driveId: string;
  let itemId: string;
  let metadata: any;
  let knownSummary: string | undefined;

  const resolvedUrl = unwrapLoopShareUrl(shareUrl);

  if (isSpeUrl(resolvedUrl)) {
    const urlObj = new URL(resolvedUrl);
    const navParam = urlObj.searchParams.get("nav");
    if (!navParam) {
      throw new Error(
        'SharePoint Embedded URL but "nav" parameter is missing. Use listLoopContainers + listLoopFilesInDrive instead.'
      );
    }
    const parsed = parseSpeNavParam(navParam);
    if (!parsed.driveId || !parsed.itemId) {
      throw new Error("Unable to extract driveId/itemId from nav parameter.");
    }
    driveId = parsed.driveId;
    itemId = parsed.itemId;
    try {
      metadata = await graphGet(
        `/drives/${driveId}/items/${itemId}`,
        { $select: "id,name,size,webUrl,lastModifiedDateTime,file,parentReference" }
      );
    } catch (err) {
      // SPE container 403 — get metadata from search instead
      const searchResult = await searchForItem(driveId, itemId);
      if (searchResult) {
        metadata = searchResult.metadata;
        knownSummary = searchResult.summary;
      } else {
        throw err;
      }
    }
  } else {
    const encoded = encodeShareUrl(resolvedUrl);
    metadata = await graphGet(
      `/shares/${encoded}/driveItem`,
      { $select: "id,name,size,webUrl,lastModifiedDateTime,file,parentReference" }
    );
    driveId = metadata.parentReference?.driveId;
    itemId = metadata.id;
    if (!driveId || !itemId) {
      throw new Error("Unable to resolve driveId/itemId from the share URL");
    }
  }

  const { html, source } = await fetchLoopHtml(driveId, itemId, knownSummary);

  const result: LoopContent = {
    name: metadata.name,
    driveId,
    itemId,
    webUrl: metadata.webUrl ?? shareUrl,
    lastModified: metadata.lastModifiedDateTime ?? "",
    size: metadata.size ?? 0,
    mimeType: metadata.file?.mimeType,
    html,
    contentSource: source,
  };

  if (includeText) {
    result.text = htmlToText(html);
  }

  return result;
}

export async function getLoopByItemId(
  driveId: string,
  itemId: string,
  includeText = true
): Promise<LoopContent> {
  let metadata: any;
  let knownSummary: string | undefined;
  try {
    metadata = await graphGet(`/drives/${driveId}/items/${itemId}`, {
      $select: "id,name,size,webUrl,lastModifiedDateTime,file,parentReference",
    });
  } catch (err) {
    // SPE container 403 — try search fallback for metadata
    const searchResult = await searchForItem(driveId, itemId);
    if (searchResult) {
      metadata = searchResult.metadata;
      knownSummary = searchResult.summary;
    } else {
      throw err;
    }
  }

  const { html, source } = await fetchLoopHtml(driveId, itemId, knownSummary);

  const result: LoopContent = {
    name: metadata.name ?? "Unknown",
    driveId,
    itemId,
    webUrl: metadata.webUrl ?? "",
    lastModified: metadata.lastModifiedDateTime ?? "",
    size: metadata.size ?? 0,
    mimeType: metadata.file?.mimeType,
    html,
    contentSource: source,
  };

  if (includeText) {
    result.text = htmlToText(html);
  }

  return result;
}

export async function listLoopContainers(): Promise<
  Array<{ driveId: string; name: string; webUrl: string | null; loopFileCount: number }>
> {
  // Use Search API with delegated auth to find Loop files, group by drive
  const response = await graphPost("/search/query", {
    requests: [
      {
        entityTypes: ["driveItem"],
        query: { queryString: "filetype:loop OR filetype:fluid" },
        from: 0,
        size: 500,
      },
    ],
  });

  const hits = response?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];

  const driveMap = new Map<
    string,
    { driveId: string; name: string; webUrl: string | null; loopFileCount: number }
  >();

  for (const hit of hits) {
    const driveId = hit.resource?.parentReference?.driveId;
    if (!driveId) continue;
    if (!driveMap.has(driveId)) {
      driveMap.set(driveId, { driveId, name: driveId, webUrl: null, loopFileCount: 0 });
    }
    driveMap.get(driveId)!.loopFileCount++;
  }

  // Enrich with drive names
  await Promise.all(
    Array.from(driveMap.values()).map(async (ws) => {
      try {
        const driveInfo = await graphGet(`/drives/${ws.driveId}`);
        ws.name = driveInfo.name ?? ws.driveId;
        ws.webUrl = driveInfo.webUrl ?? null;
      } catch {
        // Keep driveId as name fallback
      }
    })
  );

  return Array.from(driveMap.values());
}

export async function listLoopFilesInDrive(
  driveId: string,
  path?: string
): Promise<LoopFileInfo[]> {
  const loopFiles: LoopFileInfo[] = [];

  async function scanFolder(folderUrl: string): Promise<void> {
    let nextLink: string | null = folderUrl;
    while (nextLink) {
      const response = await graphGet(
        nextLink.replace("https://graph.microsoft.com/v1.0", "")
      );
      const items = response.value || [];

      for (const item of items) {
        if (item.folder) {
          await scanFolder(
            `/drives/${driveId}/items/${item.id}/children`
          );
        } else if (item.file) {
          const name = (item.name || "").toLowerCase();
          if (name.endsWith(".loop") || name.endsWith(".fluid")) {
            loopFiles.push({
              id: item.id,
              name: item.name,
              driveId,
              size: item.size,
              webUrl: item.webUrl,
              lastModified: item.lastModifiedDateTime,
              mimeType: item.file?.mimeType,
            });
          }
        }
      }

      nextLink = response["@odata.nextLink"]
        ? response["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "")
        : null;
    }
  }

  let rootPath: string;
  if (!path || path === "/" || path.toLowerCase() === "root") {
    rootPath = `/drives/${driveId}/root/children`;
  } else {
    const cleanPath = path.replace(/^\/|\/$/g, "");
    rootPath = `/drives/${driveId}/root:/${cleanPath}:/children`;
  }

  await scanFolder(rootPath);
  return loopFiles;
}

export async function searchLoopFiles(query: string): Promise<LoopFileInfo[]> {
  const response = await graphPost("/search/query", {
    requests: [
      {
        entityTypes: ["driveItem"],
        query: { queryString: `${query} (filetype:loop OR filetype:fluid)` },
        from: 0,
        size: 25,
      },
    ],
  });

  const hits = response?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];

  return hits
    .filter((hit: any) => {
      const name = (hit.resource?.name || "").toLowerCase();
      return name.endsWith(".loop") || name.endsWith(".fluid");
    })
    .map((hit: any) => ({
      id: hit.resource.id ?? hit.hitId ?? "",
      name: hit.resource.name,
      driveId: hit.resource.parentReference?.driveId ?? "",
      size: hit.resource.size ?? 0,
      webUrl: hit.resource.webUrl ?? "",
      lastModified: hit.resource.lastModifiedDateTime ?? "",
      mimeType: hit.resource.file?.mimeType,
      summary: cleanSearchSummary(hit.summary ?? ""),
    }));
}

// --- CREATE ---

export interface CreateLoopResult {
  id: string;
  name: string;
  driveId: string;
  webUrl: string;
}

export async function createLoopFile(
  driveId: string,
  fileName: string,
  htmlContent: string,
  parentPath?: string
): Promise<CreateLoopResult> {
  // Ensure .loop extension
  const name = fileName.endsWith(".loop") ? fileName : `${fileName}.loop`;

  // Upload as a new file with HTML content
  // Loop files are Fluid-based but can be created by uploading HTML
  const uploadPath = parentPath
    ? `/drives/${driveId}/root:/${parentPath.replace(/^\/|\/$/g, "")}/${name}:/content`
    : `/drives/${driveId}/root:/${name}:/content`;

  const result = await graphPut(uploadPath, htmlContent, "text/html").catch((err) =>
    rethrowWriteError(err, "create")
  );

  return {
    id: result?.id ?? "",
    name: result?.name ?? name,
    driveId,
    webUrl: result?.webUrl ?? "",
  };
}

// --- UPDATE ---

export async function updateLoopFile(
  driveId: string,
  itemId: string,
  htmlContent: string
): Promise<{ id: string; name: string; webUrl: string; lastModified: string }> {
  const result = await graphPut(
    `/drives/${driveId}/items/${itemId}/content`,
    htmlContent,
    "text/html"
  ).catch((err) => rethrowWriteError(err, "update"));

  return {
    id: result?.id ?? itemId,
    name: result?.name ?? "",
    webUrl: result?.webUrl ?? "",
    lastModified: result?.lastModifiedDateTime ?? new Date().toISOString(),
  };
}

export async function renameLoopFile(
  driveId: string,
  itemId: string,
  newName: string
): Promise<{ id: string; name: string; webUrl: string }> {
  const name = newName.endsWith(".loop") ? newName : `${newName}.loop`;
  const result = await graphPatch(`/drives/${driveId}/items/${itemId}`, { name }).catch(
    (err) => rethrowWriteError(err, "rename")
  );

  return {
    id: result?.id ?? itemId,
    name: result?.name ?? name,
    webUrl: result?.webUrl ?? "",
  };
}

// --- DELETE ---

export async function deleteLoopFile(
  driveId: string,
  itemId: string
): Promise<void> {
  await graphDelete(`/drives/${driveId}/items/${itemId}`).catch((err) =>
    rethrowWriteError(err, "delete")
  );
}
