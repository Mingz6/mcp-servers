export interface AccountInfo {
  uuid: string;
  email: string;
  description: string;
  protocol: "ews" | "imap";
}

export interface MailSummary {
  id: number;
  subject: string;
  senderEmail: string;
  senderName: string;
  receivedAt: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  account: string;
  folder: string;
}

export interface MailDetail extends MailSummary {
  body: string;
  to: string[];
  cc: string[];
  isPartial: boolean;
}

export interface AttachmentInfo {
  id: number;
  messageId: number;
  name: string;
  path: string | null;
}

export interface FolderInfo {
  account: string;
  folder: string;
  totalCount: number;
  unreadCount: number;
}
