import { useState } from "react";
import type { ChatApplication } from "../application/ChatApplication";
import { useChatController } from "../adapters/useChatController";
import { ConnectionForm } from "./ConnectionForm";
import { Conversation } from "./Conversation";
import { NewChatDialog } from "./NewChatDialog";
import { Avatar, ErrorNotice, Icon, timeFormat } from "./shared";

function ChatWorkspace({
  controller,
}: {
  controller: ReturnType<typeof useChatController>;
}) {
  const [creatingChat, setCreatingChat] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const { state, selectedChatId, selectedChat } = controller;

  return (
    <main className={`chat-shell${selectedChat ? " has-selected-chat" : ""}`}>
      <aside className="chat-sidebar" aria-label="Список чатов">
        <header className="sidebar-heading">
          <span className="brand-mark">
            <Icon name="plane" />
          </span>
          <div>
            <h1>Telegram</h1>
            <p>через GREEN-API</p>
          </div>
          <button
            type="button"
            className="icon-button new-chat-button"
            title="Новый чат"
            aria-label="Новый чат"
            onClick={() => setCreatingChat(true)}
          >
            <Icon name="plus" />
          </button>
        </header>
        <div className="sidebar-section">
          <span>СООБЩЕНИЯ</span>
          <span className="chat-count">{state.chats.length}</span>
        </div>
        {state.errorMessage && (
          <div className="sidebar-application-error">
            <ErrorNotice>{state.errorMessage}</ErrorNotice>
          </div>
        )}
        <nav className="chat-list" aria-label="Чаты">
          {state.chats.length ? (
            state.chats.map((chat) => {
              const lastMessage = chat.messages[chat.messages.length - 1];
              return (
                <button
                  type="button"
                  key={chat.chatId}
                  className={`chat-item${chat.chatId === selectedChatId ? " chat-item-active" : ""}`}
                  aria-current={
                    chat.chatId === selectedChatId ? "true" : undefined
                  }
                  onClick={() => controller.selectChat(chat.chatId)}
                >
                  <Avatar chat={chat} />
                  <span className="chat-item-body">
                    <span className="chat-item-top">
                      <span className="chat-title">{chat.title}</span>
                      {lastMessage && (
                        <time>
                          {timeFormat.format(lastMessage.timestampMs)}
                        </time>
                      )}
                    </span>
                    <span className="chat-preview">
                      {lastMessage
                        ? `${lastMessage.direction === "outgoing" ? "Вы: " : ""}${lastMessage.text}`
                        : "Напишите первое сообщение"}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="sidebar-empty">
              <Icon name="chat" />
              <h2>Здесь будут ваши чаты</h2>
              <p>
                Добавьте собеседника по номеру
                <br />
                телефона и начните общение.
              </p>
              <button
                type="button"
                className="text-button"
                onClick={() => setCreatingChat(true)}
              >
                <Icon name="plus" />
                Создать чат
              </button>
            </div>
          )}
        </nav>
        <footer className="sidebar-footer">
          <div className="connection-state">
            <span className="online-dot" />
            <span>Подключено</span>
            <button
              type="button"
              className="icon-button"
              title="Отключиться"
              aria-label="Отключиться"
              onClick={() => {
                setCreatingChat(false);
                controller.disconnect();
              }}
            >
              <Icon name="exit" />
            </button>
          </div>
          <div className="history-note">
            <Icon name="lock" />
            <span>История сохранена в этом браузере</span>
          </div>
        </footer>
      </aside>
      <section className="conversation" aria-label="Переписка">
        {state.errorMessage && (
          <div className="application-error">
            <ErrorNotice>{state.errorMessage}</ErrorNotice>
          </div>
        )}
        {selectedChat ? (
          <Conversation
            chat={selectedChat}
            onSend={controller.sendText}
            onBack={() => controller.selectChat(undefined)}
            drafts={drafts}
            setDrafts={setDrafts}
            sending={sending}
            setSending={setSending}
          />
        ) : (
          <div className="welcome-panel">
            <div className="welcome-illustration">
              <span className="welcome-glow" />
              <Icon name="plane" />
            </div>
            <span className="eyebrow">НА СВЯЗИ С TELEGRAM</span>
            <h2>
          
              Выберите чат слева или добавьте собеседника.
            </h2>
            <p>
              Отправляйте сообщения и получайте ответы здесь.
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={() => setCreatingChat(true)}
            >
              <Icon name="plus" />
              Новый чат
            </button>
            <div className="welcome-footnote">
              <Icon name="lock" />
              Ваша история остаётся в этом браузере
            </div>
          </div>
        )}
      </section>
      {creatingChat && (
        <NewChatDialog
          onCreate={controller.createChat}
          onClose={() => setCreatingChat(false)}
        />
      )}
    </main>
  );
}

export function ReactChatUI({ application }: { application: ChatApplication }) {
  const controller = useChatController(application);
  return controller.state.connected ? (
    <ChatWorkspace controller={controller} />
  ) : (
    <ConnectionForm
      onConnect={controller.connect}
      applicationError={controller.state.errorMessage}
    />
  );
}
