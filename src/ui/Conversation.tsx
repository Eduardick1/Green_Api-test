import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import type { Chat, TextMessage } from "../domain/models";
import { Avatar, ErrorNotice, Icon, errorText, timeFormat } from "./shared";

const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
});

const statusLabels: Record<string, string> = {
  pending: "Отправляется",
  accepted: "Принято",
  failed: "Ошибка",
  unknown: "Результат неизвестен",
};

function MessageBubble({ message }: { message: TextMessage }) {
  const outgoing = message.direction === "outgoing";
  const warning = message.status === "failed" || message.status === "unknown";
  return (
    <div
      className={`message-row ${outgoing ? "message-outgoing" : "message-incoming"}`}
    >
      <div
        className={`message-bubble${warning ? " message-warning" : ""}`}
      >
        <p className="message-text">{message.text}</p>
        <div className="message-meta">
          <time dateTime={new Date(message.timestampMs).toISOString()}>
            {timeFormat.format(message.timestampMs)}
          </time>
          {outgoing && (
            <span
              className={`message-status status-${message.status}`}
              title={
                message.status === "accepted"
                  ? "GREEN-API принял сообщение в очередь. Это не подтверждение доставки."
                  : undefined
              }
            >
              {message.status === "accepted" && <Icon name="check" />}
              {statusLabels[message.status] ?? message.status}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Conversation({
  chat,
  onSend,
  onBack,
  drafts,
  setDrafts,
  sending,
  setSending,
}: {
  chat: Chat;
  onSend: (text: string) => Promise<void>;
  onBack: () => void;
  drafts: Record<string, string>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  sending: boolean;
  setSending: Dispatch<SetStateAction<boolean>>;
}) {
  const [error, setError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef(chat.chatId);
  const draft = drafts[chat.chatId] ?? "";

  useEffect(() => {
    chatRef.current = chat.chatId;
    setError(undefined);
  }, [chat.chatId]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [chat.chatId, chat.messages]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    }
  }, [draft, chat.chatId]);

  async function submit() {
    if (sending || !draft.trim() || draft.length > 4096) return;
    const sentChatId = chat.chatId;
    const sentText = draft;
    setSending(true);
    setError(undefined);
    try {
      await onSend(sentText);
      setDrafts((previous) => ({
        ...previous,
        [sentChatId]:
          previous[sentChatId] === sentText ? "" : (previous[sentChatId] ?? ""),
      }));
    } catch (cause) {
      if (chatRef.current === sentChatId) setError(errorText(cause));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <>
      <header className="conversation-heading">
        <button
          type="button"
          className="icon-button mobile-back"
          aria-label="Назад к чатам"
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <Avatar chat={chat} small />
        <div className="conversation-person">
          <h2>{chat.title}</h2>
          <p>
            {chat.phone ? `+${chat.phone}` : "Личный чат"}
            <span className="header-dot" />
            Telegram
          </p>
        </div>
      </header>
      <div
        ref={scrollRef}
        className="message-list"
        role="log"
        aria-label={`Сообщения: ${chat.title}`}
        aria-live="polite"
        aria-relevant="additions text"
      >
        {chat.messages.length === 0 ? (
          <div className="conversation-start">
            <span>
              <Icon name="chat" />
            </span>
            <h3>Начните разговор</h3>
            <p>
              Напишите первое сообщение.
              <br />
              Ответ появится здесь.
            </p>
          </div>
        ) : (
          <div className="message-content">
            {chat.messages.map((message, index) => {
              const day = dateFormat.format(message.timestampMs);
              const previousMessage = chat.messages[index - 1];
              const showDay =
                !previousMessage ||
                day !== dateFormat.format(previousMessage.timestampMs);
              return (
                <div key={message.localId}>
                  {showDay && (
                    <div className="date-divider">
                      <span>{day}</span>
                    </div>
                  )}
                  <MessageBubble message={message} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="composer-area">
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="sr-only" htmlFor="message-text">
            Сообщение
          </label>
          <textarea
            ref={textareaRef}
            id="message-text"
            placeholder="Написать сообщение…"
            rows={1}
            value={draft}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDrafts((previous) => ({ ...previous, [chat.chatId]: value }));
            }}
            onKeyDown={handleKeyDown}
            aria-describedby="composer-hint"
          />
          <button
            type="submit"
            className="send-button"
            aria-label="Отправить сообщение"
            disabled={sending || !draft.trim() || draft.length > 4096}
          >
            {sending ? <span className="spinner" /> : <Icon name="plane" />}
          </button>
        </form>
        <div id="composer-hint" className="composer-hint">
          <span>Enter — отправить · Shift + Enter — новая строка</span>
          <span className={draft.length > 4096 ? "text-danger" : ""}>
            {draft.length > 0 && `${draft.length} / 4096`}
          </span>
        </div>
      </div>
    </>
  );
}

