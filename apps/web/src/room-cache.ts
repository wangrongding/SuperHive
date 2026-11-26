export type RoomScrollPosition = {
  scrollTop: number;
  nearBottom: boolean;
  visibleLimit: number;
};

export class RoomCache<Value> {
  private readonly entries = new Map<string, Value>();

  constructor(private readonly limit = 5) {}

  get(roomId: string): Value | undefined {
    const value = this.entries.get(roomId);
    if (value !== undefined) {
      this.entries.delete(roomId);
      this.entries.set(roomId, value);
    }
    return value;
  }

  set(roomId: string, value: Value): void {
    this.entries.delete(roomId);
    this.entries.set(roomId, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}
