/**
 * Subset of Discord API v10 types we use.
 * Trimmed from olivier-motium/discord-user-mcp/src/types.ts (MIT).
 */
export interface User {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  bot?: boolean;
}

export interface Guild {
  id: string;
  name: string;
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

export interface GuildDetailed extends Guild {
  description?: string | null;
  owner_id?: string;
  features?: string[];
}

export interface Channel {
  id: string;
  type: number;
  name?: string | null;
  guild_id?: string;
  parent_id?: string | null;
  topic?: string | null;
  recipients?: User[];
  position?: number;
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  content_type?: string;
  size: number;
}

export interface MessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

export interface Message {
  id: string;
  channel_id: string;
  author: User;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  attachments: Attachment[];
  mentions: User[];
  mention_roles: string[];
  pinned: boolean;
  type: number;
  referenced_message?: Message | null;
  message_reference?: MessageReference;
}

export interface MessageQuery {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
}

export interface SearchQuery {
  content?: string;
  author_id?: string;
  channel_id?: string;
  has?: string;
  min_id?: string;
  max_id?: string;
  offset?: number;
}

export interface SearchResponse {
  total_results: number;
  messages: Message[][];
}
