import type { ReactNode } from "react";
import type { Chat } from "../domain/models";

export const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
});

const iconPaths = {
  plane: (
    <>
      <path d="m21 3-6.5 18-4.1-7.4L3 9.5 21 3Z" />
      <path d="m10.4 13.6 5.2-5.2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  exit: <path d="M10 5H5v14h5M13 7l5 5-5 5M8 12h10" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chat: (
    <>
      <path d="M20 11.5a8 8 0 0 1-8 8c-1.4 0-2.8-.4-4-1L3 21l1.6-5a8 8 0 1 1 15.4-4.5Z" />
      <path d="M8 11h8M8 14h5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
};

export function Icon({
  name,
  className = "",
}: {
  name: keyof typeof iconPaths;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {iconPaths[name]}
    </svg>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить действие. Попробуйте ещё раз.";
}

export function Avatar({ chat, small = false }: { chat: Chat; small?: boolean }) {
  const letter = chat.title.replace(/^\+/, "").slice(0, 1).toUpperCase() || "T";
  const color = [...chat.chatId].reduce(
    (sum, character) => sum + character.charCodeAt(0), 0,
  ) % 4;
  return (
    <span
      className={`avatar avatar-${color}${small ? " avatar-small" : ""}`}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div className="error-notice" role="alert">
      <Icon name="alert" />
      <span>{children}</span>
    </div>
  );
}

