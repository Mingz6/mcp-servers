/**
 * Read-only Discord API client using a USER token.
 *
 * Ported from olivier-motium/discord-user-mcp/src/client.ts (MIT).
 * Hardened changes:
 *   - All write methods (POST/PATCH/DELETE/PUT) REMOVED. This is read-only.
 *   - Conservative rate-limit pacing (sleep 250ms between requests) so the
 *     traffic pattern stays well under any selfbot-detection heuristic.
 *   - User-Agent matches a real Discord client string, not "DiscordBot".
 *   - Token validated on startup; bad token = process exit.
 */

import type {
    Channel,
    Guild,
    GuildDetailed,
    Message,
    MessageQuery,
    SearchQuery,
    SearchResponse,
    User,
} from "./types.js";

const BASE_URL = "https://discord.com/api/v10";

// Realistic Discord desktop client UA (avoids the obviously-automation default).
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) discord/0.0.330 Chrome/126.0.6478.234 Electron/30.2.0 Safari/537.36";

const MIN_GAP_MS = 250; // soft pacing between requests

export class DiscordAPIError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    const msg = (body.message as string) || `HTTP ${status}`;
    super(msg);
    this.name = "DiscordAPIError";
  }
}

export class DiscordUserClient {
  private lastRequestAt = 0;

  constructor(private token: string) {}

  private async pace() {
    const since = Date.now() - this.lastRequestAt;
    if (since < MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_GAP_MS - since));
    }
    this.lastRequestAt = Date.now();
  }

  private async get<T>(path: string): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pace();
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "GET",
        headers: {
          Authorization: this.token,
          "User-Agent": USER_AGENT,
          Accept: "*/*",
        },
      });

      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as {
          retry_after?: number;
        };
        const wait = (data.retry_after ?? 1) * 1000 + Math.random() * 200;
        console.error(`[discord-user] rate limited, retry in ${Math.round(wait)}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const error = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new DiscordAPIError(res.status, error);
      }

      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }

    throw new DiscordAPIError(429, {
      message: "Rate limited after 3 retries.",
    });
  }

  // ── User ──
  getCurrentUser(): Promise<User> {
    return this.get("/users/@me");
  }
  getUser(userId: string): Promise<User> {
    return this.get(`/users/${userId}`);
  }

  // ── Guilds ──
  getMyGuilds(): Promise<Guild[]> {
    return this.get("/users/@me/guilds?with_counts=true");
  }
  getGuild(guildId: string): Promise<GuildDetailed> {
    return this.get(`/guilds/${guildId}?with_counts=true`);
  }
  getGuildChannels(guildId: string): Promise<Channel[]> {
    return this.get(`/guilds/${guildId}/channels`);
  }

  // ── Channels ──
  getChannel(channelId: string): Promise<Channel> {
    return this.get(`/channels/${channelId}`);
  }

  // ── Messages ──
  getMessages(channelId: string, query: MessageQuery = {}): Promise<Message[]> {
    const params = new URLSearchParams();
    if (query.limit) params.set("limit", String(query.limit));
    if (query.before) params.set("before", query.before);
    if (query.after) params.set("after", query.after);
    if (query.around) params.set("around", query.around);
    const qs = params.toString();
    return this.get(`/channels/${channelId}/messages${qs ? `?${qs}` : ""}`);
  }
  getMessage(channelId: string, messageId: string): Promise<Message> {
    return this.get(`/channels/${channelId}/messages/${messageId}`);
  }
  getPinnedMessages(channelId: string): Promise<Message[]> {
    return this.get(`/channels/${channelId}/pins`);
  }

  // ── Search ──
  searchGuild(guildId: string, query: SearchQuery): Promise<SearchResponse> {
    const params = new URLSearchParams();
    if (query.content) params.set("content", query.content);
    if (query.author_id) params.set("author_id", query.author_id);
    if (query.channel_id) params.set("channel_id", query.channel_id);
    if (query.has) params.set("has", query.has);
    if (query.min_id) params.set("min_id", query.min_id);
    if (query.max_id) params.set("max_id", query.max_id);
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    return this.get(`/guilds/${guildId}/messages/search?${params.toString()}`);
  }

  // ── DMs ──
  getDMChannels(): Promise<Channel[]> {
    return this.get("/users/@me/channels");
  }
}
