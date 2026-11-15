export class TestStoreError extends Error {
  constructor(status, code, current) { super(code); this.status = status; this.code = code; this.current = current; }
}
