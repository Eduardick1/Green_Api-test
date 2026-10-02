import type { Chat, TextMessage } from '../domain/models';

export interface Credentials {
  apiUrl: string;
  idInstance: string;
  apiTokenInstance: string;
}

export interface Notification {
  receiptId: string;
  message?: TextMessage;
  senderName?: string;
  senderPhone?: string;
}

export interface ChatState {
  readonly chats: readonly Chat[];
  readonly connected: boolean;
  readonly errorMessage?: string;
}

export type ChatList = Chat[];
export type NotificationOrNull = Notification | null;
export type Unsubscribe = () => void;

export interface MessagingGateway {
  connect(credentials: Credentials): Promise<void>;
  resolveRecipient(phone: string): Promise<Chat>;
  sendText(chatId: string, text: string): Promise<string>;
  receive(): Promise<NotificationOrNull>;
  acknowledge(receiptId: string): Promise<void>;
  disconnect(): void;
}

export interface ChatStore {
  load(accountId: string): Promise<ChatList>;
  save(accountId: string, chats: readonly Chat[]): Promise<void>;
}
