export enum MessageStatus {
  pending = 'pending',
  accepted = 'accepted',
  failed = 'failed',
  unknown = 'unknown',
  received = 'received',
}

export class ChatError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface TextMessageProps {
  localId: string;
  providerMessageId?: string;
  chatId: string;
  text: string;
  timestampMs: number;
  direction: 'incoming' | 'outgoing';
  status: MessageStatus;
}

export class TextMessage implements TextMessageProps {
  localId: string;
  providerMessageId?: string;
  chatId: string;
  text: string;
  timestampMs: number;
  direction: 'incoming' | 'outgoing';
  status: MessageStatus;

  constructor(props: TextMessageProps) {
    this.localId = props.localId;
    this.providerMessageId = props.providerMessageId;
    this.chatId = props.chatId;
    this.text = props.text;
    this.timestampMs = props.timestampMs;
    this.direction = props.direction;
    this.status = props.status;
  }

  validate(): void {
    if (this.direction === 'outgoing' && !this.text.trim()) {
      throw new ChatError('VALIDATION_ERROR', 'Введите текст сообщения.');
    }
    if (this.text.length > 4096) {
      throw new ChatError('VALIDATION_ERROR', 'Сообщение не должно превышать 4096 символов.');
    }
  }
}

export interface ChatProps {
  chatId: string;
  phone?: string;
  title: string;
  messages?: TextMessage[];
}

export class Chat {
  chatId: string;
  phone?: string;
  title: string;
  messages: TextMessage[];

  constructor(props: ChatProps) {
    this.chatId = props.chatId;
    this.phone = props.phone;
    this.title = props.title;
    this.messages = props.messages ?? [];
  }

  addMessageOnce(message: TextMessage): boolean {
    if (message.chatId !== this.chatId) {
      throw new ChatError('VALIDATION_ERROR', 'Сообщение относится к другому чату.');
    }
    const duplicate = this.messages.some((existing) =>
      existing.localId === message.localId ||
      (Boolean(message.providerMessageId) && existing.providerMessageId === message.providerMessageId),
    );
    if (duplicate) return false;
    this.messages.push(message);
    return true;
  }
}

export function normalizePhone(phone: string): string {
  if (!/^\+?[\d\s().-]+$/.test(phone.trim())) {
    throw new ChatError('VALIDATION_ERROR', 'Введите международный номер телефона с кодом страны.');
  }
  const digits = phone.replace(/\D/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) {
    throw new ChatError('VALIDATION_ERROR', 'Введите международный номер телефона с кодом страны.');
  }
  return digits;
}
