import { Chat, ChatError, MessageStatus, TextMessage } from '../domain/models';
import type { Credentials, MessagingGateway, Notification } from '../application/contracts';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

export class GreenApiTelegramAdapter implements MessagingGateway {
  private credentials?: Credentials;
  private generation = 0;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly requestTimeoutMs = 45_000,
  ) {}

  async connect(credentials: Credentials): Promise<void> {
    this.disconnect();
    let apiUrl: URL;
    try {
      apiUrl = new URL(credentials.apiUrl.trim());
    } catch {
      throw new ChatError('VALIDATION_ERROR', 'Введите корректный адрес API GREEN-API.');
    }

    const isGreenApiHost = apiUrl.hostname === 'api.green-api.com' ||
      apiUrl.hostname.endsWith('.api.green-api.com');
    if (
      apiUrl.protocol !== 'https:' ||
      !isGreenApiHost ||
      apiUrl.username ||
      apiUrl.password ||
      apiUrl.search ||
      apiUrl.hash ||
      apiUrl.pathname !== '/'
    ) {
      throw new ChatError('VALIDATION_ERROR', 'Используйте HTTPS-адрес API из личного кабинета GREEN-API.');
    }

    const idInstance = credentials.idInstance.trim();
    const apiTokenInstance = credentials.apiTokenInstance.trim();
    if (!/^\d+$/.test(idInstance) || !apiTokenInstance || /\s/.test(apiTokenInstance)) {
      throw new ChatError('VALIDATION_ERROR', 'Проверьте idInstance и apiTokenInstance.');
    }

    this.credentials = { apiUrl: apiUrl.origin, idInstance, apiTokenInstance };
    const generation = this.generation;
    try {
      const response = object(await this.request('GET', 'getStateInstance'));
      if (response.stateInstance !== 'authorized') {
        throw new ChatError('INSTANCE_NOT_AUTHORIZED', 'Авторизуйте Telegram-инстанс в личном кабинете GREEN-API.');
      }
    } catch (error) {
      if (generation === this.generation) this.disconnect();
      throw error;
    }
  }

  async resolveRecipient(phone: string): Promise<Chat> {
    if (!/^[1-9]\d{6,14}$/.test(phone)) {
      throw new ChatError('VALIDATION_ERROR', 'Введите номер в международном формате с кодом страны.');
    }
    const response = object(await this.request('POST', 'checkAccount', { phoneNumber: Number(phone) }));
    if (response.exist === false) {
      throw new ChatError('RECIPIENT_NOT_FOUND', 'Номер не найден или скрыт настройками приватности.');
    }
    if (response.exist !== true || typeof response.chatId !== 'string' || !/^\d+$/.test(response.chatId)) {
      throw new ChatError('PROVIDER_ERROR', 'GREEN-API не вернул идентификатор личного чата.');
    }
    return new Chat({ chatId: response.chatId, phone, title: `+${phone}` });
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const response = object(await this.request('POST', 'sendMessage', { chatId, message: text }));
    if (typeof response.idMessage !== 'string' || !response.idMessage) {
      throw new ChatError('SEND_UNKNOWN', 'Результат отправки неизвестен: GREEN-API не вернул id сообщения.');
    }
    return response.idMessage;
  }

  async receive(): Promise<Notification | null> {
    const response = await this.request('GET', 'receiveNotification', undefined, '?receiveTimeout=30');
    return response === null ? null : this.mapNotification(response);
  }

  async acknowledge(receiptId: string): Promise<void> {
    if (!/^\d+$/.test(receiptId)) {
      throw new ChatError('PROVIDER_ERROR', 'Некорректный идентификатор уведомления.');
    }
    const response = object(await this.request('DELETE', 'deleteNotification', undefined, `/${receiptId}`));
    // false also means already removed; repeating an acknowledgement is idempotent.
    if (typeof response.result !== 'boolean') {
      throw new ChatError('PROVIDER_ERROR', 'GREEN-API не подтвердил обработку уведомления.');
    }
  }

  disconnect(): void {
    this.generation++;
    this.credentials = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private mapNotification(payload: unknown): Notification {
    const envelope = object(payload);
    const receiptId = String(envelope.receiptId ?? '');
    if (!/^\d+$/.test(receiptId)) {
      throw new ChatError('PROVIDER_ERROR', 'Некорректный формат уведомления GREEN-API.');
    }
    const body = object(envelope.body);
    if (typeof body.typeWebhook !== 'string') {
      throw new ChatError('PROVIDER_ERROR', 'В уведомлении отсутствует тип события.');
    }
    const instance = object(body.instanceData);
    if (instance.typeInstance && instance.typeInstance !== 'telegram') {
      throw new ChatError('INSTANCE_NOT_AUTHORIZED', 'Укажите параметры Telegram-инстанса GREEN-API.');
    }
    if (instance.idInstance !== undefined && String(instance.idInstance) !== this.credentials?.idInstance) {
      throw new ChatError('PROVIDER_ERROR', 'Получено уведомление другого инстанса.');
    }

    const notification: Notification = { receiptId };
    if (body.typeWebhook !== 'incomingMessageReceived') return notification;

    const data = object(body.messageData);
    const supportedText = data.typeMessage === 'textMessage' || data.typeMessage === 'extendedTextMessage';
    if (!supportedText) return notification;

    const sender = object(body.senderData);
    const chatId = optionalString(sender.chatId);
    if (sender.chatType && sender.chatType !== 'user') return notification;
    if (!sender.chatType && chatId?.startsWith('-')) return notification;
    if (!chatId || !/^\d+$/.test(chatId)) {
      throw new ChatError('PROVIDER_ERROR', 'В текстовом уведомлении отсутствует идентификатор личного чата.');
    }

    let text: unknown;
    if (data.typeMessage === 'textMessage') {
      text = object(data.textMessageData).textMessage;
    } else {
      text = object(data.extendedTextMessageData).text;
    }
    if (typeof text !== 'string') {
      throw new ChatError('PROVIDER_ERROR', 'В текстовом уведомлении отсутствует текст сообщения.');
    }
    const providerMessageId = optionalString(body.idMessage);
    const timestampMs = typeof body.timestamp === 'number' ? body.timestamp * 1000 : NaN;
    if (!providerMessageId || !Number.isFinite(timestampMs) || Math.abs(timestampMs) > 8.64e15) {
      throw new ChatError('PROVIDER_ERROR', 'В уведомлении отсутствуют данные текстового сообщения.');
    }

    notification.message = new TextMessage({
      localId: `incoming:${chatId}:${providerMessageId}`,
      providerMessageId,
      chatId,
      text,
      timestampMs,
      direction: 'incoming',
      status: MessageStatus.received,
    });
    notification.senderName = optionalString(sender.senderContactName) ??
      optionalString(sender.chatName) ?? optionalString(sender.senderName);
    const senderPhone = String(sender.senderPhoneNumber ?? '');
    if (/^[1-9]\d{6,14}$/.test(senderPhone)) notification.senderPhone = senderPhone;
    return notification;
  }

  private mapError(status: number, sending: boolean): ChatError {
    const rateLimited = status === 429 || status === 469;
    if (sending) {
      if (status >= 500) {
        return new ChatError('SEND_UNKNOWN', 'Сервис временно недоступен. Результат отправки неизвестен.');
      }
      if (rateLimited) {
        return new ChatError('SEND_REJECTED', 'Превышен лимит запросов. Повторите отправку позже.');
      }
      return new ChatError('SEND_REJECTED', 'GREEN-API отклонил отправку. Проверьте доступ к инстансу и получателя.');
    }
    if (status === 401 || status === 403 || status === 404) {
      return new ChatError('AUTH_ERROR', 'Не удалось получить доступ к инстансу. Проверьте параметры подключения.');
    }
    if (rateLimited) {
      return new ChatError('RATE_LIMITED', 'Превышен лимит запросов GREEN-API. Повторите позже.');
    }
    if (status === 400) {
      return new ChatError('PROVIDER_ERROR', 'Проверьте параметры и настройки входящих уведомлений: поле webhookUrl должно быть пустым.');
    }
    return new ChatError('PROVIDER_ERROR', 'GREEN-API временно недоступен. Повторите позже.');
  }

  private async request(method: string, operation: string, body?: JsonObject, suffix = ''): Promise<unknown> {
    const credentials = this.credentials;
    if (!credentials) throw new ChatError('REQUEST_ABORTED', 'Подключение закрыто.');

    const generation = this.generation;
    const sending = operation === 'sendMessage';
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      const url = `${credentials.apiUrl}/waInstance${credentials.idInstance}/${operation}/${encodeURIComponent(credentials.apiTokenInstance)}${suffix}`;
      const options: RequestInit = {
        method,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      };
      if (body) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
      }
      const response = await this.fetchImpl(url, options);
      if (generation !== this.generation) throw new ChatError('REQUEST_ABORTED', 'Подключение закрыто.');
      if (!response.ok) throw this.mapError(response.status, sending);

      const raw = await response.text();
      if (generation !== this.generation) throw new ChatError('REQUEST_ABORTED', 'Подключение закрыто.');
      if (!raw.trim() && operation === 'receiveNotification') return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ChatError(sending ? 'SEND_UNKNOWN' : 'PROVIDER_ERROR', 'GREEN-API вернул некорректный ответ.');
      }

      const record = object(parsed);
      if (record.status === false || record.error) {
        const data = object(record.data);
        const rateLimited = data.status === 'fail' && data.reason === 'rate_limit_exceeded';
        let code = sending ? 'SEND_REJECTED' : 'PROVIDER_ERROR';
        if (!sending && rateLimited) code = 'RATE_LIMITED';
        const message = rateLimited
          ? 'Поиск номера временно ограничен. Повторите позже.'
          : 'GREEN-API отклонил запрос. Проверьте параметры инстанса.';
        throw new ChatError(code, message);
      }
      return parsed;
    } catch (error) {
      if (error instanceof ChatError) throw error;
      if (generation !== this.generation) throw new ChatError('REQUEST_ABORTED', 'Подключение закрыто.');
      if (timedOut) {
        if (sending) {
          throw new ChatError('SEND_UNKNOWN', 'Истекло время ожидания. Результат отправки неизвестен.');
        }
        throw new ChatError('REQUEST_TIMEOUT', 'Истекло время ожидания GREEN-API.');
      }
      if (sending) {
        throw new ChatError('SEND_UNKNOWN', 'Соединение прервано. Результат отправки неизвестен.');
      }
      throw new ChatError('NETWORK_ERROR', 'Нет соединения с GREEN-API. Проверьте сеть.');
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
}
