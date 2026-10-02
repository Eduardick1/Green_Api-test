import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatApplication } from '../application/ChatApplication';
import type { Credentials } from '../application/contracts';

export function useChatController(application: ChatApplication) {
  const state = useSyncExternalStore(
    application.subscribe,
    application.getSnapshot,
    application.getSnapshot,
  );
  const [selectedChatId, setSelectedChatId] = useState<string>();
  const showingChatList = useRef(false);

  useEffect(() => {
    if (!state.connected) {
      setSelectedChatId(undefined);
      showingChatList.current = false;
      return;
    }
    if (!selectedChatId && state.chats.length && !showingChatList.current) {
      setSelectedChatId(state.chats[0].chatId);
    }
  }, [state.connected, state.chats, selectedChatId]);

  function connect(credentials: Credentials) {
    return application.connect(credentials);
  }

  async function createChat(phone: string) {
    const chat = await application.createChat(phone);
    showingChatList.current = false;
    setSelectedChatId(chat.chatId);
  }

  function selectChat(chatId?: string) {
    showingChatList.current = chatId === undefined;
    setSelectedChatId(chatId);
  }

  async function sendText(text: string) {
    if (!selectedChatId) throw new Error('Выберите чат перед отправкой сообщения.');
    const message = await application.sendText(selectedChatId, text);
    if (message.status !== 'accepted') {
      throw new Error(
        application.getSnapshot().errorMessage ??
        'Результат отправки неизвестен. Текст сохранён; проверьте Telegram перед повторной отправкой.',
      );
    }
  }

  function disconnect() {
    application.disconnect();
    showingChatList.current = false;
    setSelectedChatId(undefined);
  }

  return {
    state,
    getSnapshot: application.getSnapshot,
    subscribe: application.subscribe,
    selectedChatId,
    selectedChat: state.chats.find((chat) => chat.chatId === selectedChatId),
    connect,
    createChat,
    selectChat,
    sendText,
    disconnect,
  };
}
