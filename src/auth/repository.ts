import type { VirtualKeyRecord } from "./types.js";

export interface VirtualKeyRepository {
  findByHash(keyHash: string): Promise<VirtualKeyRecord | undefined>;
}

export class InMemoryVirtualKeyRepository implements VirtualKeyRepository {
  private readonly recordsByHash: ReadonlyMap<string, VirtualKeyRecord>;

  constructor(records: VirtualKeyRecord[]) {
    this.recordsByHash = new Map(
      records.map((record) => [record.keyHash, Object.freeze(record)]),
    );
  }

  async findByHash(keyHash: string): Promise<VirtualKeyRecord | undefined> {
    return this.recordsByHash.get(keyHash);
  }
}
