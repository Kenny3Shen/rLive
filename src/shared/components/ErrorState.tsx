import type { AppError } from "../types/error";

type ErrorStateProps = {
  error: unknown;
  onRetry?: () => void;
  title?: string;
};

function messageFromError(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as AppError).message);
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function codeFromError(error: unknown): string | null {
  if (typeof error === "object" && error && "code" in error) {
    return String((error as AppError).code);
  }
  return null;
}

export function ErrorState({ error, onRetry, title = "Something went wrong" }: ErrorStateProps) {
  const message = messageFromError(error);
  const code = codeFromError(error);

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-5 dark:border-red-900/50 dark:bg-red-950/40"
    >
      <div>
        <h2 className="text-sm font-semibold text-red-800 dark:text-red-200">{title}</h2>
        <p className="mt-1 text-sm text-red-700 dark:text-red-300">{message}</p>
        {code && (
          <p className="mt-1 font-mono text-xs text-red-600/80 dark:text-red-400/80">{code}</p>
        )}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500"
        >
          Retry
        </button>
      )}
    </div>
  );
}
