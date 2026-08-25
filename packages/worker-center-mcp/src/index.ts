import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getFreshDb } from "./freshness.js";

const server = new McpServer({ name: "worker-center", version: "1.0.0" });

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function textResult(text: string, warning: string | null = null) {
  return { content: [{ type: "text" as const, text: warning ? `${warning}\n\n${text}` : text }] };
}

function formatRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "No results.";
  const keys = Object.keys(rows[0]!);
  const header = keys.join(" | ");
  const sep = keys.map(() => "---").join(" | ");
  const body = rows.map((r) => keys.map((k) => r[k] ?? "").join(" | ")).join("\n");
  return `${header}\n${sep}\n${body}`;
}

// ─── worker_status ───────────────────────────────────────────────────────────

server.tool(
  "worker_status",
  "Get recent run history for workers. Shows last N runs with status, duration, and errors.",
  {
    worker: z.string().optional().describe("Filter to a specific worker name. Omit for all workers."),
    limit: z.number().min(1).max(200).default(20).describe("Number of recent runs to return."),
    errorsOnly: z.boolean().default(false).describe("Only show failed runs."),
  },
  async ({ worker, limit, errorsOnly }) => {
    try {
      const { db, warning } = getFreshDb();
      let sql = `SELECT worker_name, status, message, started_at, finished_at,
        ROUND((julianday(finished_at) - julianday(started_at)) * 86400, 1) as duration_s
        FROM worker_runs WHERE 1=1`;
      const params: unknown[] = [];

      if (worker) {
        sql += " AND worker_name = ?";
        params.push(worker);
      }
      if (errorsOnly) {
        sql += " AND status = 'error'";
      }
      sql += " ORDER BY started_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return textResult(formatRows(rows), warning);
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── price_history ───────────────────────────────────────────────────────────

server.tool(
  "price_history",
  "Query delta-only price change history for tracked products. Each row represents a price change.",
  {
    worker: z.string().optional().describe("Filter by worker (price_watch, retail_monitor, apple_refurb, etc.)"),
    productKey: z.string().optional().describe("Filter by product_key for a specific item."),
    limit: z.number().min(1).max(200).default(30).describe("Max rows to return."),
  },
  async ({ worker, productKey, limit }) => {
    try {
      const { db, warning } = getFreshDb();
      let sql = `SELECT worker, product_key, product_label, retailer, price, prev_price,
        ROUND(price - COALESCE(prev_price, price), 2) as delta, currency, recorded_at
        FROM price_history WHERE 1=1`;
      const params: unknown[] = [];

      if (worker) {
        sql += " AND worker = ?";
        params.push(worker);
      }
      if (productKey) {
        sql += " AND product_key = ?";
        params.push(productKey);
      }
      sql += " ORDER BY recorded_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return textResult(formatRows(rows), warning);
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── price_alerts ────────────────────────────────────────────────────────────

server.tool(
  "price_alerts",
  "Get recent price drops — items where price decreased from previous observation.",
  {
    minDropPct: z.number().min(0).max(100).default(5).describe("Minimum drop percentage to include."),
    days: z.number().min(1).max(90).default(7).describe("Look back N days."),
    limit: z.number().min(1).max(100).default(20).describe("Max results."),
  },
  async ({ minDropPct, days, limit }) => {
    try {
      const { db, warning } = getFreshDb();
      const sql = `SELECT worker, product_key, product_label, retailer,
        price, prev_price,
        ROUND((prev_price - price) / prev_price * 100, 1) as drop_pct,
        url, recorded_at
        FROM price_history
        WHERE prev_price IS NOT NULL
          AND price < prev_price
          AND ROUND((prev_price - price) / prev_price * 100, 1) >= ?
          AND recorded_at >= datetime('now', '-' || ? || ' days')
        ORDER BY drop_pct DESC
        LIMIT ?`;

      const rows = db.prepare(sql).all(minDropPct, days, limit) as Record<string, unknown>[];
      return textResult(
        rows.length === 0 ? `No drops ≥${minDropPct}% in the last ${days} days.` : formatRows(rows),
        warning
      );
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── listings ────────────────────────────────────────────────────────────────

server.tool(
  "listings",
  "Query active marketplace listings (apple-refurb, facebook, kijiji, ebay-sold).",
  {
    source: z.string().optional().describe("Filter by source (apple-refurb, facebook, kijiji, ebay-sold)."),
    sku: z.string().optional().describe("Filter by SKU (m4-base, m4-pro-12, m4-pro-14)."),
    maxPrice: z.number().optional().describe("Maximum price filter."),
    limit: z.number().min(1).max(200).default(30).describe("Max results."),
  },
  async ({ source, sku, maxPrice, limit }) => {
    try {
      const { db, warning } = getFreshDb();
      let sql = `SELECT source, title, price, currency, sku, sku_label,
        ram_gb, storage_gb, location, url, first_seen, last_seen
        FROM listings WHERE disappeared IS NULL`;
      const params: unknown[] = [];

      if (source) {
        sql += " AND source = ?";
        params.push(source);
      }
      if (sku) {
        sql += " AND sku = ?";
        params.push(sku);
      }
      if (maxPrice) {
        sql += " AND price <= ?";
        params.push(maxPrice);
      }
      sql += " ORDER BY last_seen DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return textResult(formatRows(rows), warning);
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── job_pipeline ────────────────────────────────────────────────────────────

server.tool(
  "job_pipeline",
  "View job application verdict cache — what was applied to, skipped, and why. verdict_json contains the full decision.",
  {
    status: z.string().optional().describe("Filter by verdict inside verdict_json (apply, skip, maybe). Omit for all."),
    limit: z.number().min(1).max(100).default(30).describe("Max results."),
  },
  async ({ status, limit }) => {
    try {
      const { db, warning } = getFreshDb();
      let sql = `SELECT source, job_id, verdict_json, cached_at FROM job_verdict_cache WHERE 1=1`;
      const params: unknown[] = [];

      if (status) {
        // verdict_json is a JSON blob; extract the "verdict" field via json_extract
        sql += ` AND json_extract(verdict_json, '$.verdict') = ?`;
        params.push(status);
      }
      sql += " ORDER BY cached_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return textResult(formatRows(rows), warning);
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── worker_notifications ────────────────────────────────────────────────────

server.tool(
  "worker_notifications",
  "Recent alert delivery log — what was sent, to which channel, success/failure.",
  {
    worker: z.string().optional().describe("Filter by worker name."),
    channel: z.string().optional().describe("Filter by channel (imessage, ntfy, report)."),
    limit: z.number().min(1).max(100).default(20).describe("Max results."),
  },
  async ({ worker, channel, limit }) => {
    try {
      const { db, warning } = getFreshDb();
      let sql = `SELECT worker_name, channel, success, title, error, sent_at
        FROM worker_notifications WHERE 1=1`;
      const params: unknown[] = [];

      if (worker) {
        sql += " AND worker_name = ?";
        params.push(worker);
      }
      if (channel) {
        sql += " AND channel = ?";
        params.push(channel);
      }
      sql += " ORDER BY sent_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return textResult(formatRows(rows), warning);
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── worker_query (freeform read-only SQL) ───────────────────────────────────

const BLOCKED_KEYWORDS = /\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|ATTACH|DETACH|REPLACE|PRAGMA\s+(?!table_info|table_list))\b/i;

server.tool(
  "worker_query",
  "Execute freeform read-only SQL against market.db. Blocks mutating statements. Use for advanced queries not covered by other tools.",
  {
    sql: z.string().describe("SQL SELECT query to execute."),
    limit: z.number().min(1).max(500).default(50).describe("Max rows (appended as LIMIT if not present)."),
  },
  async ({ sql, limit }) => {
    try {
      if (BLOCKED_KEYWORDS.test(sql)) {
        return toolError("Mutating SQL blocked. This server is read-only.");
      }

      const { db, warning } = getFreshDb();
      const normalized = sql.trim().replace(/;$/, "");
      const hasLimit = /\bLIMIT\s+\d+/i.test(normalized);
      const finalSql = hasLimit ? normalized : `${normalized} LIMIT ${limit}`;

      const rows = db.prepare(finalSql).all() as Record<string, unknown>[];
      return textResult(formatRows(rows), warning);
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("unhandledRejection", (err) => { console.error("[worker-center-mcp] Unhandled rejection:", err); process.exit(1); });
process.on("uncaughtException", (err) => { console.error("[worker-center-mcp] Uncaught exception:", err); process.exit(1); });

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
