export type AppError = {
  code: string;
  message: string;
  site: string | null;
  retryable: boolean;
};
