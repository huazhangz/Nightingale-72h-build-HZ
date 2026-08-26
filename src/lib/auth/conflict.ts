export class ConflictError extends Error {
  readonly code = "CONFLICT" as const;

  constructor(
    message: string,
    readonly currentVersion: number,
    readonly currentBody: string,
    readonly currentTitle: string,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}
