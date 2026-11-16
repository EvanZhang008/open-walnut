/** An answer the server gave with a non-2xx status (api/client.ts throws it). */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Parsed error-response JSON, when the server sent one (e.g. { error, hint }). */
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
