/** A host network failure the Settings page shows as it is (status, code, a sentence). */
export class NetError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'NetError'
  }
}
