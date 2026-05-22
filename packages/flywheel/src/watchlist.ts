import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";

const WATCHLIST_PATH =
  process.env.FLYWHEEL_WATCHLIST_PATH ??
  join(process.env.HOME ?? "", "code/brain/copilot/flywheel-watchlist.yml");

interface Strategy {
  type: "topics" | "trending" | "keywords" | "users";
  queries?: string[];
  handles?: string[];
  frequency?: string;
}

interface Platform {
  host: string;
  strategies: Strategy[];
}

interface WatchlistData {
  platforms?: Platform[];
}

export interface WatchlistQueries {
  searchQueries: string[];
  userHandles: string[];
}

/**
 * Load section C from flywheel-watchlist.yml and extract search queries + user handles.
 * Returns empty arrays if the file can't be read (non-fatal).
 */
export async function loadWatchlistStrategies(): Promise<WatchlistQueries> {
  const searchQueries: string[] = [];
  const userHandles: string[] = [];

  let raw: string;
  try {
    raw = await readFile(WATCHLIST_PATH, "utf-8");
  } catch {
    return { searchQueries, userHandles };
  }

  const data = parseYaml(raw) as WatchlistData;
  const platforms = data.platforms ?? [];

  for (const platform of platforms) {
    if (platform.host !== "github.com") continue;

    for (const strategy of platform.strategies) {
      switch (strategy.type) {
        case "topics":
          if (strategy.queries) {
            for (const q of strategy.queries) {
              searchQueries.push(`topic:${q}`);
            }
          }
          break;
        case "keywords":
          if (strategy.queries) {
            searchQueries.push(...strategy.queries);
          }
          break;
        case "users":
          if (strategy.handles) {
            userHandles.push(...strategy.handles);
          }
          break;
      }
    }
  }

  return { searchQueries, userHandles };
}
